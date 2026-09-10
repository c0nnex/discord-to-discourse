import {expect, test} from "bun:test";
import {parseExportOptions} from "../export-options";
import {channelStartDates, saveChannelSelection, selectRequestedChannel} from "../export-control";

test("channel CLI is strict and cannot bypass role exclusion", () => {
    expect(parseExportOptions(["export", "--channel-id", "123", "--since", "2024-01-01"]).channelId).toBe("123");
    expect(parseExportOptions(["backfillEmbeds", "--since", "2024-01-01", "--channel-id", "123"]).channelId).toBe("123");
    for (const args of [["--channel-id"], ["--channel-id", "0"], ["--channel-id", "1", "--channel-id", "2"], ["downloadAttachments", "--channel-id", "1"]]) {
        expect(() => parseExportOptions(args)).toThrow();
    }
    expect(selectRequestedChannel([{id:"1"},{id:"2"}], "2")).toEqual([{id:"2"}]);
    expect(() => selectRequestedChannel([{id:"1"}], "2")).toThrow();
});

test("pinned date survives normal exports and backfills; global date only narrows", async () => {
    const values = new Map<string,string>();
    const db:any = {exportControl:{upsert:async(q:any)=>values.set(q.where.key,q.update.value),
        findUnique:async(q:any)=>values.has(q.where.key)?{value:values.get(q.where.key)}:null}};
    const date = new Date("2024-06-01T00:00:00Z");
    await channelStartDates(db,["1"],date,"1",true);
    expect(values.get("ChannelStartDate:1")).toBe("2024-06-01");
    expect((await channelStartDates(db,["1","2"])).get("1")).toEqual(date);
    expect((await channelStartDates(db,["1","2"])).get("2")).toBeUndefined();
    expect((await channelStartDates(db,["1"],new Date("2024-01-01Z"))).get("1")).toEqual(date);
    const later=new Date("2024-07-01Z");
    expect((await channelStartDates(db,["1"],later)).get("1")).toEqual(later);
    expect(values.get("ChannelStartDate:1")).toBe("2024-06-01");
    await channelStartDates(db,["1"],later,"1",false);
    expect(values.get("ChannelStartDate:1")).toBe("2024-06-01");
    await channelStartDates(db,["1"],new Date("2024-01-01Z"),"1",true);
    expect(values.get("ChannelStartDate:1")).toBe("2024-01-01");
    await expect(channelStartDates(db,["2"],date,"1",true)).rejects.toThrow();
    values.set("ChannelStartDate:1","invalid");
    await expect(channelStartDates(db,["1"])).rejects.toThrow();
});

test("single channel snapshot does not disable or overwrite other channels", async () => {
    const changes:any[]=[];
    const tx:any={category:{updateMany:async()=>{throw Error("Global update forbidden");},upsert:async(q:any)=>changes.push(q)}};
    const db:any={$transaction:async(fn:any)=>fn(tx)};
    const date=new Date("2024-06-01Z");
    await saveChannelSelection(db,[{id:"1",name:"one",type:0},{id:"2",name:"two",type:0}],["1"],undefined,"1",new Map([["1",date]]));
    expect(changes.length).toBe(1);
    expect(changes[0].where.id).toBe("1");
    expect(changes[0].update.exportSince).toEqual(date);
});
