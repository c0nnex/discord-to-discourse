import {afterEach, expect, test} from "bun:test";
import {getAttachmentSize, getattachmentSizes, formatAttachmentError} from "./attachment-sizes";
import type {PrismaClient} from "@prisma/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("HEAD only, identity encoding, no redirects; supports zero and large sizes", async () => {
    for (const size of ["0", "5000000000"]) {
        globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
            expect(options.method).toBe("HEAD");
            expect(options.redirect).toBe("error");
            expect(options.headers).toEqual({"Accept-Encoding": "identity"});
            expect(options.signal).toBeDefined();
            return new Response(null, {headers: {"content-length": size}});
        }) as typeof fetch;
        expect(await getAttachmentSize("https://cdn.discordapp.com/attachments/example")).toBe(BigInt(size));
    }
});

test("unknown, invalid and overflow lengths are rejected, never stored as zero", async () => {
    for (const length of [null, "-1", "12.5", "no", "9223372036854775808"]) {
        globalThis.fetch = (async () => new Response(null, {
            headers: length === null ? {} : {"content-length": length},
        })) as typeof fetch;
        await expect(getAttachmentSize("https://cdn.discordapp.com/attachments/example")).rejects.toThrow();
    }
});

test("HTTP errors including expired links do not measure the error body", async () => {
    for (const status of [403, 404, 405, 429, 500]) {
        globalThis.fetch = (async () => new Response(null, {
            status, headers: {"content-length": "123"},
        })) as typeof fetch;
        await expect(getAttachmentSize("https://cdn.discordapp.com/attachments/example")).rejects.toThrow();
    }
});

test("network timeout propagates; unexpected hosts rejected before any request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        throw new DOMException("timeout", "TimeoutError");
    }) as typeof fetch;
    await expect(getAttachmentSize("https://cdn.discordapp.com/attachments/example")).rejects.toThrow();
    for (const url of ["http://cdn.discordapp.com/file", "https://example.com/file", "https://user:pass@cdn.discordapp.com/file"]) {
        await expect(getAttachmentSize(url)).rejects.toThrow();
    }
    expect(calls).toBe(1);
});

test("paged backfill preserves known sizes and retries unknown rows on rerun", async () => {
    const rows = Array.from({length: 205}, (_, i) => ({
        id: String(i).padStart(4, "0"), url: String(i), size: i === 0 ? 0n : null as bigint | null,
    }));
    const queries: any[] = [];
    const prisma = {attachment: {
        count: async () => rows.filter(r => r.size === null).length,
        findMany: async (q: any) => {
            queries.push(q);
            return rows.filter(r => r.size === null && (!q.where.id || r.id > q.where.id.gt)).slice(0, q.take);
        },
        update: async (q: any) => { rows.find(r => r.id === q.where.id)!.size = q.data.size; },
        aggregate: async () => ({
            _sum: {size: rows.reduce((sum, r) => sum + (r.size ?? 0n), 0n)},
            _count: {size: rows.filter(r => r.size !== null).length},
        }),
    }} as unknown as PrismaClient;
    const result = await getattachmentSizes(prisma, async url => {
        if (url === "2") { throw new Error("expired signed URL"); }
        return 5000000000n;
    });
    expect(result).toEqual({updated: 203, failed: 1, unknown: 1, bytes: 1015000000000n});
    expect(rows[0].size).toBe(0n);
    expect(queries.every(q => q.take === 100 && q.where.size === null)).toBe(true);
    let requests = 0;
    const resumed = await getattachmentSizes(prisma, async () => { requests++; return 7n; });
    expect(requests).toBe(1);
    expect(resumed.unknown).toBe(0);
    expect(resumed.bytes).toBe(1015000000007n);
});

test("database write errors stop the backfill", async () => {
    const prisma = {attachment: {
        count: async () => 1,
        findMany: async () => [{id: "synthetic", url: "synthetic"}],
        update: async () => { throw new Error("database unavailable"); },
    }} as unknown as PrismaClient;
    await expect(getattachmentSizes(prisma, async () => 123n)).rejects.toThrow("database unavailable");
});

test("backfill prints exact failure details, causes and codes without signed URLs", async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    const url = "https://cdn.discordapp.com/attachments/example?ex=secret&hm=signature";
    const failure = new TypeError(`fetch failed for ${url}\nnext line`, {
        cause: Object.assign(new Error("connection reset"), {code: "ECONNRESET"}),
    });
    let pages = 0;
    const prisma = {attachment: {
        count: async () => 1,
        findMany: async () => pages++ === 0 ? [{id: "example", url}] : [],
        aggregate: async () => ({_sum: {size: null}, _count: {size: 0}}),
    }} as unknown as PrismaClient;
    try {
        const result = await getattachmentSizes(prisma, async () => { throw failure; });
        expect(result.failed).toBe(1);
        expect(warnings[0]).toContain("TypeError: fetch failed");
        expect(warnings[0]).toContain("connection reset (code=ECONNRESET)");
        expect(warnings[0]).not.toContain("secret");
        expect(warnings[0]).not.toContain("signature");
        expect(warnings[0]).not.toContain("\n");
    } finally {
        console.warn = originalWarn;
    }
});

test("formatter retains HEAD status and rejects cyclic causes safely", () => {
    const error = new Error("HEAD returned HTTP 404 Not Found");
    error.cause = error;
    expect(formatAttachmentError(error, "https://cdn.discordapp.com/example"))
        .toBe("Error: HEAD returned HTTP 404 Not Found");
    expect(formatAttachmentError(new DOMException("operation timed out", "TimeoutError"), "unused"))
        .toContain("TimeoutError: operation timed out");
});

test("missing and malformed Content-Length have distinct diagnostics", async () => {
    globalThis.fetch = (async () => new Response(null)) as typeof fetch;
    await expect(getAttachmentSize("https://cdn.discordapp.com/example")).rejects.toThrow("missing Content-Length");
    globalThis.fetch = (async () => new Response(null, {headers: {"content-length": "invalid"}})) as typeof fetch;
    await expect(getAttachmentSize("https://cdn.discordapp.com/example")).rejects.toThrow('invalid Content-Length: "invalid"');
});
