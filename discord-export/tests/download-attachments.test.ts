import {afterEach, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {downloadFile, downloadLimit, downloadAttachments, MAX_DOWNLOAD_SIZE} from "../download-attachments";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const url = "https://cdn.discordapp.com/attachments/synthetic/file";

test("complete files and empty files have verified bytes and hashes", async () => {
    for (const data of [Buffer.from("example"), Buffer.alloc(0)]) {
        globalThis.fetch = (async (_, options) => {
            expect(options?.redirect).toBe("error");
            return new Response(data, {headers: {"content-length": String(data.length)}});
        }) as typeof fetch;
        const result = await downloadFile(url, data.length, 100);
        expect(result.data).toEqual(data);
        expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    }
});

test("HTTP errors, truncated bodies, excess bodies and wrong headers fail", async () => {
    const cases: [Response, number, string][] = [
        [new Response("missing", {status: 404, statusText: "Not Found"}), 7, "HTTP 404"],
        [new Response("abc"), 4, "headSize=4; contentLength=absent; receivedBytes=3."],
        [new Response("abc"), 2, "headSize=2; contentLength=absent; receivedBytes=3; maxBytes=100."],
        [new Response("abc", {headers: {"content-length": "4"}}), 3, "headSize=3; contentLength=4."],
        [new Response("abc", {headers: {"content-length": "invalid"}}), 3, "headSize=3; contentLength=invalid."],
        [new Response(new ReadableStream({start(controller) {controller.error(new Error("stream interrupted"));}})), 3, "stream interrupted"],
    ];
    for (const [response, size, error] of cases) {
        globalThis.fetch = (async () => response) as typeof fetch;
        await expect(downloadFile(url, size, 100)).rejects.toThrow(error);
    }
});

test("host and size constraints reject before network; transport errors propagate", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("connection timeout"); }) as typeof fetch;
    for (const invalid of ["http://cdn.discordapp.com/file", "https://other.example/file", "https://user@cdn.discordapp.com/file"]) {
        await expect(downloadFile(invalid, 1, 100)).rejects.toThrow("Unsupported");
    }
    await expect(downloadFile(url, 101, 100)).rejects.toThrow("limit");
    await expect(downloadFile(url, -1, 100)).rejects.toThrow("invalid");
    expect(calls).toBe(0);
    await expect(downloadFile(url, 1, 100)).rejects.toThrow("timeout");
    expect(downloadLimit("1024")).toBe(1024);
    for (const invalid of ["0", "-1", "1.5", "4294967296", "abc"]) {
        expect(() => downloadLimit(invalid)).toThrow("MAX_ATTACHMENT_BYTES");
    }
});

test("failure includes diagnostic headers but excludes cookies and signed locations", async () => {
    globalThis.fetch = (async () => new Response("abc", {headers: {
        "content-length": "4", "content-type": "image/jpeg", "content-encoding": "identity",
        "etag": "example", "vary": "Accept-Encoding", "content-range": "bytes 0-3/4",
        "last-modified": "Tue, 01 Jan 2019 00:00:00 GMT",
        "set-cookie": "private-cookie", "location": "https://example.invalid/?secret=hidden",
    }})) as typeof fetch;
    let diagnostic = "";
    try {
        await downloadFile(url, 3, 100);
    } catch (error) {
        diagnostic = String(error);
    }
    expect(diagnostic).toContain("status=200");
    expect(diagnostic).toContain('"content-type":"image/jpeg"');
    expect(diagnostic).toContain('"content-length":"4"');
    expect(diagnostic).toContain("headSize=3; contentLength=4.");
    expect(diagnostic).not.toContain("private-cookie");
    expect(diagnostic).not.toContain("hidden");
});


test("five workers overlap HEAD/GET and share source lookup for a message", async () => {
    let active=0,peak=0,requests=0,completed=0,pages=0;
    const prisma={
        attachment:{count:async()=>12-completed,update:async()=>{}},
        post:{findMany:async()=>pages++?[]:[{id:"post",topicId:"topic",attachments:Array.from({length:12},(_,i)=>({id:String(i),size:null,blob:null}))}]},
        attachmentBlob:{create:async()=>{completed++;}},
    } as any;
    const result=await downloadAttachments(prisma,async()=>{
        requests++;
        return {attachments:Array.from({length:12},(_,i)=>({id:String(i),url:String(i),size:99999999}))};
    },100,async()=>{
        await new Promise(resolve=>setTimeout(resolve,5));
        active--;return {data:Buffer.from("abc"),sha256:"0".repeat(64)};
    },async()=>{
        active++;peak=Math.max(peak,active);
        await new Promise(resolve=>setTimeout(resolve,5));return 3n;
    });
    expect(peak).toBe(5);expect(active).toBe(0);expect(requests).toBe(1);
    expect(result).toEqual({downloaded:12,skipped:0,failed:0,remaining:0});
});

test("known sizes skip HEAD; missing sizes on existing blobs do not redownload", async () => {
    const rows = [
        {id:"known",size:3n,blob:null as any},
        {id:"existing",size:null as bigint|null,blob:{attachmentId:"existing"}},
        {id:"large",size:BigInt(MAX_DOWNLOAD_SIZE),blob:null},
    ];
    const pending=()=>rows.filter(r=>r.size===null || (!r.blob && r.size<BigInt(MAX_DOWNLOAD_SIZE)));
    const prisma={
        attachment:{count:async()=>pending().length,update:async(q:any)=>{Object.assign(rows.find(r=>r.id===q.where.id)!,q.data);}},
        post:{findMany:async(q:any)=>q.where.id || !pending().length?[]:[{id:"post",topicId:"topic",attachments:pending()}]},
        attachmentBlob:{create:async(q:any)=>{rows.find(r=>r.id===q.data.attachmentId)!.blob={attachmentId:q.data.attachmentId};}},
    } as any;
    let heads=0,downloads=0,sources=0;
    const source=async()=>{sources++;return {attachments:rows.map(r=>({id:r.id,url:r.id,size:999}))};};
    const head=async(url:string)=>{heads++;expect(url).toBe("existing");return 4n;};
    const read=async(url:string,size:number)=>{downloads++;expect(url).toBe("known");expect(size).toBe(3);return {data:Buffer.from("abc"),sha256:"0".repeat(64)};};
    await downloadAttachments(prisma,source,100,read,head);
    await downloadAttachments(prisma,source,100,read,head);
    expect(heads).toBe(1);expect(downloads).toBe(1);expect(sources).toBe(1);
    expect(rows[1].size).toBe(4n);
});
