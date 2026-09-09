import {expect, test} from "bun:test";
import {embedData, backfillEmbeds} from "../embed-export";
import {storeMessage} from "../store-message";
import type {APIMessage} from "@discordjs/core";

const embeds = [{type: "rich", author: {name: "Example widget"},
    fields: [{name: "Identifier", value: "#42", inline: true}, {name: "Scope", value: "BUTTON_1", inline: false}],
    future_field: {nested: [true, "text"]}}, {description: "second", color: 123, footer: {text: "footer"}}];
function message(id = "90071992547409920"): APIMessage {
    return {id, channel_id: "synthetic-topic", timestamp: "2024-01-01T00:00:00Z", content: "",
        embeds, attachments: [], author: {id: "synthetic-author", username: "example"}} as unknown as APIMessage;
}
test("preserve complete ordered embeds for mixed, empty-text and non-bot messages", async () => {
    let created: any;
    const db: any = {post: {findUnique: async () => null, create: async (q: any) => {created=q.data;}},
        user: {findUnique: async () => null}};
    for (const body of ["", "New entry"]) {
        await storeMessage(db, {...message(), content: body}, "synthetic-topic", () => "generated");
        expect(created.body).toBe(body); expect(created.embeds).toEqual(embeds);
        expect(created.embedsCheckedAt).toBeInstanceOf(Date);
    }
    expect(embedData({...message(), embeds: []}).embeds).toEqual([]);
    expect(() => embedData({embeds: undefined} as any)).toThrow("embeds array");
});
test("replayed legacy post fills only embeds; captured posts are immutable", async () => {
    let checked: Date | null = null;
    const writes: any[] = [];
    const db: any = {post: {findUnique: async () => ({id: message().id, embedsCheckedAt: checked}),
        updateMany: async (q: any) => {writes.push(q); checked=q.data.embedsCheckedAt;}}};
    expect(await storeMessage(db, message(), "synthetic-topic", () => "")).toBe(false);
    expect(await storeMessage(db, {...message(), content: "edited"}, "synthetic-topic", () => "")).toBe(false);
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].data).sort()).toEqual(["embeds", "embedsCheckedAt"]);
});
test("backfill selects all uncaptured bodies, respects scope/date, and retries lookup failures", async () => {
    const pending = new Set(["a", "b"]);
    const queries: any[]=[];
    const db: any={post:{
        findMany: async(q:any)=>{queries.push(q);return [...pending].filter(id=>!q.where.id || id>q.where.id.gt).map(id=>({id,topicId:"synthetic-topic"}));},
        updateMany: async(q:any)=>{pending.delete(q.where.id);}, count: async()=>pending.size}};
    const since=new Date("2024-01-01T00:00:00Z");
    const result=await backfillEmbeds(db,["selected"],async(_,id)=>{if(id==="a")throw Error("not found");return message(id);},since);
    expect(result).toEqual({updated:1,failed:1,remaining:1});
    expect(queries[0].where.topic.categoryId.in).toEqual(["selected"]);
    expect(queries[0].where.created.gte).toEqual(since);
    expect(queries[0].where.body).toBeUndefined();
    expect(await backfillEmbeds(db,["selected"],async(_,id)=>message(id),since)).toEqual({updated:1,failed:0,remaining:0});
    expect((await backfillEmbeds(db,["selected"],async()=>{throw Error("should not fetch");},since)).updated).toBe(0);
});
test("mismatched response remains pending; database failure aborts",async()=>{
    const db:any={post:{findMany:async()=>[{id:"a",topicId:"synthetic-topic"}],updateMany:async()=>{throw Error("database");},count:async()=>1}};
    await expect(backfillEmbeds(db,["selected"],async()=>message("a"))).rejects.toThrow("database");
    let page=0;db.post.findMany=async()=>page++===0?[{id:"a",topicId:"synthetic-topic"}]:[];
    expect(await backfillEmbeds(db,["selected"],async()=>message("wrong"))).toEqual({updated:0,failed:1,remaining:1});
});
