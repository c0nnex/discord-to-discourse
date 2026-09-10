import {expect,test} from "bun:test";
import {runEmbedBackfill} from "../embed-export";
function fixture() {
    const rows=[{id:"1",topicId:"a",channel:"a",checked:false},{id:"2",topicId:"b",channel:"b",checked:false}];
    const select=(q:any)=>rows.filter(r=>q.where.topic.categoryId.in.includes(r.channel)&&(!("embedsCheckedAt" in q.where)||!r.checked)&&(!q.where.id||r.id>q.where.id.gt));
    const db:any={post:{count:async(q:any)=>select(q).length,findMany:async(q:any)=>select(q),updateMany:async(q:any)=>{rows.find(r=>r.id===q.where.id)!.checked=true;return {count:1};}}};
    return {db,rows};
}
const channels=[{id:"a",name:"Alpha"},{id:"b",name:"Beta"},{id:"c",name:"Empty"}];
const message=async(channel_id:string,id:string)=>({id,channel_id,embeds:[]} as any);
async function capture(fn:(lines:string[])=>Promise<void>){
    const original=console.log,originalError=console.error;const lines:string[]=[];
    console.log=(...args:any[])=>lines.push(args.join(" "));console.error=console.log;
    try{await fn(lines);}finally{console.log=original;console.error=originalError;}
}
test("overall completion across channels, empty scopes and resumed runs",async()=>capture(async lines=>{
    const f=fixture();
    expect(await runEmbedBackfill(f.db,channels,new Map(),message)).toEqual({updated:2,failed:0,remaining:0});
    expect(lines.some(l=>l.includes('channel="Beta" (b) [2/2]'))).toBe(true);
    expect(lines.at(-1)).toContain("COMPLETED SUCCESSFULLY: checked=2/2");
    expect(lines.at(-1)).toContain("remaining=0");
    await runEmbedBackfill(f.db,channels,new Map(),async()=>{throw Error("no source requests on resume");});
    expect(lines.at(-1)).toContain("checked=0/0; alreadyCaptured=2");
}));
test("heartbeat reports pending request before a page completes",async()=>capture(async lines=>{
    const f=fixture();
    await runEmbedBackfill(f.db,channels,new Map(),async(c,id)=>{await new Promise(r=>setTimeout(r,30));return message(c,id);},5);
    expect(lines.filter(l=>l.includes('channel="Alpha"')&&l.includes('overallAttempted=0/2')).length).toBeGreaterThan(1);
}));
test("failures are completed with pending work; fatal DB errors never report success",async()=>capture(async lines=>{
    const f=fixture();
    const result=await runEmbedBackfill(f.db,channels,new Map(),async(c,id)=>{if(c==="a")throw Error("missing");return message(c,id);});
    expect(result).toEqual({updated:1,failed:1,remaining:1});
    expect(lines.at(-1)).toContain("COMPLETED WITH PENDING WORK");
    lines.length=0;f.db.post.updateMany=async()=>{throw Error("database");};
    await expect(runEmbedBackfill(f.db,channels,new Map(),message)).rejects.toThrow("database");
    expect(lines.at(-1)).toContain("ABORTED");expect(lines.some(l=>l.includes("COMPLETED SUCCESSFULLY"))).toBe(false);
}));
