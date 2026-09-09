import {expect, test} from "bun:test";
import type {PrismaClient} from "@prisma/client";
import {refreshAttachments} from "../refresh-attachments";

test("repairs unknown attachments only and makes no requests on a completed rerun", async () => {
    const rows = [{id:"a",url:"truncated",size:null as bigint|null},{id:"b",url:"old",size:5n}];
    let page = 0;
    const queries: any[] = [];
    const prisma = {
        post: {findMany: async (q:any) => { queries.push(q); return rows.some(x=>x.size===null) && page++ % 2 === 0 ? [{id:"post",topicId:"thread",attachments:rows.filter(x=>x.size===null)}] : []; }},
        attachment: {
            count: async (q:any) => q ? rows.filter(x=>x.size===null).length : rows.length,
            update: async (q:any) => { Object.assign(rows.find(x=>x.id===q.where.id)!,q.data); },
            aggregate: async () => ({_sum:{size:rows.reduce((s,x)=>s+(x.size??0n),0n)},_count:{size:rows.filter(x=>x.size!==null).length}}),
        },
    } as unknown as PrismaClient;
    let requests=0;
    const url="https://cdn.discordapp.com/attachments/example?hm="+"a".repeat(250);
    for (let i=0;i<2;i++) {
        const result=await refreshAttachments(prisma,async(channel,id)=>{
            expect(channel).toBe("thread"); expect(id).toBe("post"); requests++;
            return {attachments:[{id:"b",url:url+"b",size:0},{id:"a",url,size:5000000000}]};
        }, async()=>5000000000n);
        expect(result).toEqual({updated:i===0?1:0,failed:0,unknown:0});
    }
    expect(requests).toBe(1);
    expect(rows[0].url).toBe(url); expect(rows[0].size).toBe(5000000000n);
    expect(rows[1].size).toBe(5n);
    expect(rows[1].url).toBe("old");
    expect(queries.every(q=>q.take===100 && q.where.attachments.some.size===null && q.select.attachments.where.size===null)).toBe(true);
});

test("missing messages and attachments are failures and existing values survive", async () => {
    let pages=0;
    let updates=0;
    const prisma={
        post:{findMany:async()=>pages++===0?[
            {id:"missing",topicId:"thread",attachments:[{id:"a"}]},
            {id:"present",topicId:"thread",attachments:[{id:"b"},{id:"c"}]},
        ]:[]},
        attachment:{
            count:async()=>3,
            update:async()=>{ updates++; },
            aggregate:async()=>({_sum:{size:null},_count:{size:0}}),
        },
    } as unknown as PrismaClient;
    const result=await refreshAttachments(prisma,async(_,id)=>{
        if(id==="missing"){throw new Error("HTTP 404");}
        return {attachments:[{id:"c",url:"unused",size:-1}]};
    }, async()=>{throw new Error("HEAD failed");});
    expect(updates).toBe(0);
    expect(result).toEqual({updated:0,failed:3,unknown:3});
});
