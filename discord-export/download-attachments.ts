import {AttachmentHttpError} from "./attachment-http";
import type {PrismaClient} from "@prisma/client";
import {createHash} from "node:crypto";
import {formatAttachmentError, getAttachmentSize} from "./attachment-sizes";

export const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10 MiB; larger files are imported as links.

type SourceMessage = {attachments: {id: string; url: string; size: number}[]};
type DownloadedFile = {data: Buffer; sha256: string};

export async function downloadFile(url: string, expectedSize: number, maxBytes: number): Promise<DownloadedFile> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
        parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
        throw new Error("Unsupported attachment URL");
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) {
        throw new Error(`Source size is invalid or exceeds download limit of ${maxBytes} bytes`);
    }
    const response = await fetch(url, {
        redirect: "error", headers: {"Accept-Encoding": "identity"}, signal: AbortSignal.timeout(120000),
    });
    const reader = response.body?.getReader();
    try {
        if (response.status !== 200) {
            throw new Error(`Download returned HTTP ${response.status} ${response.statusText}`);
        }
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || BigInt(length) !== BigInt(expectedSize))) {
            throw new Error(`Content-Length does not match CDN HEAD size: headSize=${expectedSize}; contentLength=${length}.`);
        }
        const chunks: Uint8Array[] = [];
        const hash = createHash("sha256");
        let received = 0;
        if (reader) {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) { break; }
                received += chunk.value.byteLength;
                if (received > expectedSize || received > maxBytes) {
                    throw new Error(`Download exceeds expected size or configured limit: headSize=${expectedSize}; contentLength=${length ?? "absent"}; receivedBytes=${received}; maxBytes=${maxBytes}.`);
                }
                hash.update(chunk.value);
                chunks.push(chunk.value);
            }
        }
        if (received !== expectedSize) { throw new Error(`Incomplete attachment download: headSize=${expectedSize}; contentLength=${length ?? "absent"}; receivedBytes=${received}.`); }
        return {data: Buffer.concat(chunks, received), sha256: hash.digest("hex")};
    } catch (error) {
        const headers: Record<string, string> = {};
        for (const name of ["content-length", "content-type", "content-encoding", "content-range", "etag", "last-modified", "vary"]) {
            const value = response.headers.get(name);
            if (value !== null) {
                headers[name] = value;
            }
        }
        throw new AttachmentHttpError(response.status, `Attachment response: status=${response.status}; headers=${JSON.stringify(headers)}; ${formatAttachmentError(error, url)}`);
    } finally {
        // A failed stream can reject cancel too; preserve the diagnostic above.
        await reader?.cancel().catch(() => {});

    }
}

export function downloadLimit(value = process.env.MAX_ATTACHMENT_BYTES): number {
    const limit = value === undefined ? MAX_DOWNLOAD_SIZE : Number(value);
    if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isSafeInteger(limit) || limit <= 0 || limit > 4294967295) {
        throw new Error("MAX_ATTACHMENT_BYTES must be a positive integer no larger than 4294967295");
    }
    return limit;
}

/** Try stored URLs first; refresh once after HTTP 404, with five workers. */
export async function downloadAttachments(
    prisma: PrismaClient,
    getMessage: (channelId: string, messageId: string) => Promise<SourceMessage>,
    maxBytes = downloadLimit(),
    readFile: typeof downloadFile = downloadFile,
    readSize: typeof getAttachmentSize = getAttachmentSize,
) {
    const started = Date.now();
    const pending = {OR: [{size: null}, {blob: null, size: {lt: BigInt(MAX_DOWNLOAD_SIZE)}}]};
    const total = await prisma.attachment.count({where: pending});
    let processed = 0, downloaded = 0, skipped = 0, failed = 0;
    let sourceRequests = 0, refreshedAttachments = 0, cachedDownloads = 0, headRequests = 0, downloadRequests = 0;
    const metrics = () => `cachedDownloads=${cachedDownloads}; sourceRequests=${sourceRequests}; refreshedAttachments=${refreshedAttachments}; headRequests=${headRequests}; downloadRequests=${downloadRequests}; elapsedSeconds=${((Date.now() - started) / 1000).toFixed(1)}`;
    let lastId: string | undefined;
    console.log(`Download policy: maxDownloadSize=${MAX_DOWNLOAD_SIZE}; pending=${total}; concurrency=5; stored URL first; refresh on HTTP 404 only.`);
    while (true) {
        const posts = await prisma.post.findMany({
            where: {attachments: {some: pending}, ...(lastId === undefined ? {} : {id: {gt: lastId}})},
            select: {id: true, topicId: true, attachments: {where: pending, select: {id: true, url: true, size: true, blob: {select: {attachmentId: true}}}}},
            orderBy: {id: "asc"}, take: 100,
        });
        if (posts.length === 0) { break; }
        const sources = new Map<string, Promise<SourceMessage>>();
        const jobs = posts.flatMap(post => post.attachments.map(stored => ({post, stored})));
        let next = 0;
        let fatal: unknown;
        let stopped = false;
        async function worker() {
            while (!stopped && next < jobs.length) {
                const {post, stored} = jobs[next++];
                let url = stored.url;
                let refreshed = false;
                async function withRefresh<T>(action: () => Promise<T>): Promise<T> {
                    try {
                        return await action();
                    } catch (error) {
                        if (!(error instanceof AttachmentHttpError) || error.status !== 404 || refreshed) throw error;
                    }
                    // Only source/CDN work here; database errors must remain fatal.
                    let source = sources.get(post.id);
                    if (!source) {
                        sourceRequests++;
                        source = getMessage(post.topicId, post.id);
                        sources.set(post.id, source);
                    }
                    const attachment = (await source).attachments.find(item => item.id === stored.id);
                    if (!attachment) throw new Error("Attachment no longer exists in source message");
                    url = attachment.url;
                    refreshed = true;
                    refreshedAttachments++;
                    return action();
                }
                try {
                    let size = stored.size;
                    let file: DownloadedFile | undefined;
                    let networkFailed = false;
                    try {
                        if (size === null) {
                            size = await withRefresh(async () => {headRequests++; return readSize(url);});
                        }
                        if (!stored.blob && size < BigInt(MAX_DOWNLOAD_SIZE)) {
                            const expectedSize = Number(size);
                            file = await withRefresh(async () => {
                                downloadRequests++;
                                return readFile(url, expectedSize, Math.min(maxBytes, MAX_DOWNLOAD_SIZE - 1));
                            });
                        }
                    } catch (error) {
                        networkFailed = true;
                        failed++;
                        console.warn(`Attachment ${stored.id}: ${formatAttachmentError(error, url)}. Download remains pending.`);
                    }
                    // Keep recovered metadata even when a subsequent GET fails.
                    if (refreshed || (stored.size === null && size !== null)) {
                        await prisma.attachment.update({where: {id: stored.id}, data: {url, ...(size !== null ? {size} : {})}});
                    }
                    if (networkFailed || stored.blob) continue;
                    if (size !== null && size >= BigInt(MAX_DOWNLOAD_SIZE)) {
                        skipped++;
                        continue;
                    }
                    if (!file) throw new Error("Missing completed download");
                    await prisma.attachmentBlob.create({data: {
                        attachmentId: stored.id, content: file.data, sha256: file.sha256,
                    }});
                    downloaded++;
                    if (!refreshed) cachedDownloads++;
                } catch (error) {
                    if (!stopped) {
                        fatal = new Error(`Attachment ${stored.id}: database operation failed: ${formatAttachmentError(error, url)}`);
                        stopped = true;
                    }
                } finally {
                    processed++;
                    console.log(`Download attachments [${processed}/${total}]: downloaded=${downloaded}; skipped=${skipped}; failed=${failed}; ${metrics()}.`);
                }
            }
        }
        await Promise.all(Array.from({length: Math.min(5, jobs.length)}, () => worker()));
        if (stopped) { throw fatal; }
        lastId = posts[posts.length - 1].id;
    }
    const remaining = await prisma.attachment.count({where: pending});
    console.log(`Download finished: downloaded=${downloaded}; skipped=${skipped}; failed=${failed}; remaining=${remaining}; ${metrics()}.`);
    return {downloaded, skipped, failed, remaining, cachedDownloads, sourceRequests, refreshedAttachments, headRequests, downloadRequests};
}
