import {expect,test} from "bun:test";
import {downloadAttachments,downloadFile} from "../download-attachments";
import {getAttachmentSize} from "../attachment-sizes";
import {AttachmentHttpError} from "../attachment-http";
const file={data:Buffer.from("abc"),sha256:"0".repeat(64)};
function fixture(sizes:(bigint|null)[]=[3n]) {
    const rows=sizes.map((size,i)=>({id:String(i),url:`https://cdn.discordapp.com/old/${i}`,size,blob:null as any}));
    const pending=()=>rows.filter(r=>r.size===null || (!r.blob&&r.size<10485760n));
    const writes:any[]=[];
    const db:any={post:{findMany:async(q:any)=>q.where.id?[]:[{id:"p",topicId:"t",attachments:pending()}]},
        attachment:{count:async()=>pending().length,update:async(q:any)=>{writes.push(q);Object.assign(rows.find(r=>r.id===q.where.id)!,q.data);}},
        attachmentBlob:{create:async(q:any)=>{rows.find(r=>r.id===q.data.attachmentId)!.blob={attachmentId:q.data.attachmentId};}}};
    let sources=0;
    const source=async()=>{sources++;return {attachments:rows.map(r=>({id:r.id,url:`https://cdn.discordapp.com/fresh/${r.id}`,size:3}))};};
    return {db,rows,writes,source,sources:()=>sources};
}
test("valid stored URLs avoid all source requests, including on resume",async()=>{
    const f=fixture();
    const result=await downloadAttachments(f.db,f.source,100,async url=>{expect(url).toContain("/old/");return file;});
    expect(result).toMatchObject({downloaded:1,cachedDownloads:1,sourceRequests:0,downloadRequests:1,headRequests:0});
    await downloadAttachments(f.db,f.source,100,async()=>{throw Error("already stored");});
    expect(f.sources()).toBe(0);
});
test("404 GET refreshes once, shares source lookup and persists known-size URL",async()=>{
    const f=fixture([3n,3n]);
    const result=await downloadAttachments(f.db,f.source,100,async url=>{
        if(url.includes("/old/"))throw new AttachmentHttpError(404,"missing");return file;
    });
    expect(result).toMatchObject({downloaded:2,cachedDownloads:0,sourceRequests:1,refreshedAttachments:2,downloadRequests:4});
    expect(f.sources()).toBe(1);expect(f.writes.length).toBe(2);
    expect(f.rows.every(r=>r.url.includes("/fresh/"))).toBe(true);
});
test("unknown size refreshes on HEAD 404 and does not refresh twice after GET 404",async()=>{
    const f=fixture([null]);
    const result=await downloadAttachments(f.db,f.source,100,async()=>{throw new AttachmentHttpError(404,"still missing");},async url=>{
        if(url.includes("/old/"))throw new AttachmentHttpError(404,"expired");return 3n;
    });
    expect(result).toMatchObject({failed:1,remaining:1,sourceRequests:1,headRequests:2,downloadRequests:1});
    expect(f.rows[0].size).toBe(3n);expect(f.rows[0].url).toContain("/fresh/");
});
test("only typed HTTP 404 refreshes; repeated failure and missing attachment stay pending",async()=>{
    for(const error of [new AttachmentHttpError(403,"forbidden"),new AttachmentHttpError(429,"limited"),new AttachmentHttpError(500,"server"),new Error("timeout"),new Error("size mismatch"),new Error("untrusted text HTTP 404")]) {
        const f=fixture();const result=await downloadAttachments(f.db,f.source,100,async()=>{throw error;});
        expect(result.failed).toBe(1);expect(f.sources()).toBe(0);
    }
    const f=fixture();const result=await downloadAttachments(f.db,f.source,100,async()=>{throw new AttachmentHttpError(404,"missing");});
    expect(result).toMatchObject({failed:1,sourceRequests:1,downloadRequests:2,remaining:1});
    const g=fixture();const absent=await downloadAttachments(g.db,async()=>({attachments:[]}),100,async()=>{throw new AttachmentHttpError(404,"missing");});
    expect(absent).toMatchObject({failed:1,sourceRequests:1,downloadRequests:1});expect(g.writes.length).toBe(0);
});
test("unknown size over policy limit never GETs; database failures abort",async()=>{
    const f=fixture([null]);const result=await downloadAttachments(f.db,f.source,100,async()=>{throw Error("must not GET");},async()=>10485760n);
    expect(result).toMatchObject({skipped:1,failed:0,remaining:0,sourceRequests:0});
    const g=fixture();g.db.attachment.update=async()=>{throw Error("database unavailable");};
    await expect(downloadAttachments(g.db,g.source,100,async url=>{if(url.includes("old"))throw new AttachmentHttpError(404,"missing");return file;})).rejects.toThrow("database");
    expect(g.rows[0].blob).toBeNull();
});

test("HEAD and GET expose structured status after diagnostic wrapping",async()=>{
    const original=globalThis.fetch;
    try {
        globalThis.fetch=(async()=>new Response(null,{status:404})) as typeof fetch;
        for(const action of [()=>getAttachmentSize("https://cdn.discordapp.com/synthetic"),()=>downloadFile("https://cdn.discordapp.com/synthetic",3,100)]) {
            let failure:unknown;
            try {await action();}catch(error){failure=error;}
            expect(failure).toBeInstanceOf(AttachmentHttpError);
            expect((failure as AttachmentHttpError).status).toBe(404);
        }
    }finally{globalThis.fetch=original;}
});
