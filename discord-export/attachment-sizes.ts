import {AttachmentHttpError} from "./attachment-http";
import type {PrismaClient} from "@prisma/client";

const MAX_SIZE = 9223372036854775807n;

export async function getAttachmentSize(url: string): Promise<bigint> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" ||
        !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
        parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
        throw new Error("Unsupported attachment URL");
    }

    const response = await fetch(url, {
        method: "HEAD",
        redirect: "error",
        headers: {"Accept-Encoding": "identity"},
        signal: AbortSignal.timeout(15000),
    });
    try {
        if (response.status !== 200) {
            throw new AttachmentHttpError(response.status, `HEAD returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
        }
        const length = response.headers.get("content-length");
        if (length === null) {
            throw new Error("HEAD response is missing Content-Length");
        }
        if (!/^\d+$/.test(length)) {
            throw new Error(`HEAD returned invalid Content-Length: ${JSON.stringify(length.slice(0, 64))}`);
        }
        const size = BigInt(length);
        if (size > MAX_SIZE) {
            throw new Error("Content-Length exceeds the database size range");
        }
        return size;
    } finally {
        await response.body?.cancel();
    }
}


/** Keep actionable error details while excluding signed URLs and multiline output. */
export function formatAttachmentError(error: unknown, attachmentUrl: string): string {
    const details: string[] = [];
    const seen = new Set<unknown>();
    let current = error;
    while (current !== undefined && current !== null && !seen.has(current) && details.length < 4) {
        seen.add(current);
        if (current instanceof Error) {
            const code = (current as Error & {code?: unknown}).code;
            details.push(`${current.name}: ${current.message}${typeof code === "string" ? ` (code=${code})` : ""}`);
            current = current.cause;
        } else {
            details.push(String(current));
            break;
        }
    }
    const message = details.join("; caused by: ") || "Unknown error";
    const redacted = attachmentUrl ? message.split(attachmentUrl).join("[redacted URL]") : message;
    return redacted
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
        .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
        .slice(0, 1000);
}

/** Fill unknown sizes only; successful rows are durable and skipped on restart. */
export async function getattachmentSizes(
    prisma: PrismaClient,
    readSize: (url: string) => Promise<bigint> = getAttachmentSize,
) {
    const total = await prisma.attachment.count({where: {size: null}});
    let processed = 0;
    let updated = 0;
    let failed = 0;
    let lastId: string | undefined;
    console.log(`Attachment sizes: ${total} unknown records to check.`);
    while (true) {
        const attachments = await prisma.attachment.findMany({
            where: {size: null, ...(lastId === undefined ? {} : {id: {gt: lastId}})},
            select: {id: true, url: true},
            orderBy: {id: "asc"},
            take: 100,
        });
        if (attachments.length === 0) {
            break;
        }
        for (const attachment of attachments) {
            let size: bigint;
            try {
                size = await readSize(attachment.url);
            } catch (error) {
                console.warn(`Attachment ${attachment.id}: ${formatAttachmentError(error, attachment.url)}. Retained as unknown.`);
                failed++;
                processed++;
                continue;
            }
            // Database failures abort rather than being misreported as unavailable files.
            await prisma.attachment.update({where: {id: attachment.id}, data: {size}});
            updated++;
            processed++;
            if (processed % 100 === 0) {
                console.log(`Attachment sizes [${processed}/${total}]: updated=${updated}; failed=${failed}.`);
            }
        }
        lastId = attachments[attachments.length - 1].id;
    }
    const summary = await prisma.attachment.aggregate({
        _sum: {size: true},
        _count: {size: true},
    });
    const unknown = await prisma.attachment.count({where: {size: null}});
    const bytes = summary._sum.size ?? 0n;
    console.log(`Attachment sizes finished: updated=${updated}; failed=${failed}; known=${summary._count.size}; unknown=${unknown}; knownBytes=${bytes}.`);
    return {updated, failed, unknown, bytes};
}
