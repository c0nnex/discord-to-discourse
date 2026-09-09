import {expect,test} from "bun:test";
import type {APIMessage, RESTGetAPIChannelMessagesQuery} from "@discordjs/core";
import {exportTopic} from "../incremental-export";

function fixture(count: number, nearestAfter = false) {
    const base = 90071992547409930n;
    const messages = Array.from({length:count},(_,i)=>({id:String(base+BigInt(i))} as APIMessage));
    const stored = new Set<string>();
    let state = {lastMessageId:"0",scanBeforeId:null as string|null,scanHighId:null as string|null};
    const calls: RESTGetAPIChannelMessagesQuery[] = [];
    const prisma = {topicExportState:{
        upsert:async()=>({...state}),
        update:async(q:any)=>{state={...state,...q.data};return {...state};},
    }} as any;
    const get = async(_:string,q:RESTGetAPIChannelMessagesQuery)=>{
        calls.push(q);
        const selected=messages.filter(m=>(q.after===undefined || BigInt(m.id)>BigInt(q.after)) &&
            (q.before===undefined || BigInt(m.id)<BigInt(q.before)))
            .sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
        return (nearestAfter && q.after!==undefined?selected.slice(0,100):selected.slice(-100)).reverse();
    };
    const save = async(_:any,m:APIMessage)=>{
        if(stored.has(m.id)){return false;}stored.add(m.id);return true;
    };
    return {messages,stored,calls,prisma,get,save,state:()=>state};
}

test("legacy gaps filled once; unchanged rerun requests no old messages",async()=>{
    const f=fixture(250);f.stored.add(f.messages[249].id);
    const result=await exportTopic(f.prisma,"topic",f.get,()=>"",f.save);
    expect(result.added).toBe(249);expect(f.stored.size).toBe(250);
    f.calls.length=0;
    expect(await exportTopic(f.prisma,"topic",f.get,()=>"",f.save)).toEqual({added:0,skipped:0,requests:1});
    expect(f.calls[0].after).toBe(f.messages[249].id);
    f.messages.push({id:String(BigInt(f.messages[249].id)+1n)} as APIMessage);
    expect((await exportTopic(f.prisma,"topic",f.get,()=>"",f.save)).added).toBe(1);
});

test("failed page replays safely without advancing past holes",async()=>{
    const f=fixture(250);let attempts=0;
    await expect(exportTopic(f.prisma,"topic",f.get,()=>"",async(p,m)=>{
        if(++attempts===120){throw new Error("write failed");}
        return f.save(p,m);
    })).rejects.toThrow("write failed");
    expect(f.state().lastMessageId).toBe("0");
    expect(f.state().scanBeforeId).toBe(f.messages[150].id);
    await exportTopic(f.prisma,"topic",f.get,()=>"",f.save);
    expect(f.stored.size).toBe(250);
    expect(f.state().scanBeforeId).toBe(null);
});

test("empty threads, exact page boundaries and nearest-after windows",async()=>{
    for(const count of [0,100,200,251]){
        const f=fixture(count,true);
        await exportTopic(f.prisma,"topic",f.get,()=>"",f.save);
        expect(f.stored.size).toBe(count);
        expect((await exportTopic(f.prisma,"topic",f.get,()=>"",f.save)).requests).toBe(1);
    }
});

test("network failure leaves page cursor unchanged",async()=>{
    const f=fixture(201);let calls=0;
    await expect(exportTopic(f.prisma,"topic",async(id,q)=>{
        if(++calls===2){throw new Error("HTTP unavailable");}
        return f.get(id,q);
    },()=>"",f.save)).rejects.toThrow("HTTP unavailable");
    expect(f.stored.size).toBe(100);
    await exportTopic(f.prisma,"topic",f.get,()=>"",f.save);
    expect(f.stored.size).toBe(201);
});
