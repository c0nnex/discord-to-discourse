import {expect, test} from "bun:test";
import type {APIMessage} from "@discordjs/core";
import {channelCreatedAt, persistChannels, selectExportChannels} from "../channel-export";
import {exportTopic} from "../incremental-export";

const general = {id: "90071992547409920", name: "general", type: 0};
const help = {id: "90071992547409921", name: "technical-help", type: 0};
const news = {id: "90071992547409922", name: "announcements", type: 5};
const forum = {id: "90071992547409923", name: "forum", type: 15};
function fixture() {
    const categories = new Map<string, any>(), topics = new Map<string, any>();
    const states = new Map<string, any>(), posts = new Map<string, string>();
    const database: any = {
        category: {upsert: async (q: any) => {categories.set(q.where.id, {...categories.get(q.where.id), ...(categories.has(q.where.id) ? q.update : q.create)});}},
        topic: {
            findUnique: async (q: any) => topics.get(q.where.id) ?? null,
            upsert: async (q: any) => {topics.set(q.where.id, {...topics.get(q.where.id), ...(topics.has(q.where.id) ? q.update : q.create)});}
        },
        topicExportState: {
            upsert: async (q: any) => {if (!states.has(q.where.topicId)) states.set(q.where.topicId, {lastMessageId: "0", scanBeforeId: null, scanHighId: null}); return {...states.get(q.where.topicId)};},
            update: async (q: any) => {const state = {...states.get(q.where.topicId), ...q.data}; states.set(q.where.topicId, state); return {...state};}
        }
    };
    database.$transaction = async (run: any) => run(database);
    return {database, categories, topics, states, posts};
}

test("text and announcements export even with no threads; voice/category/media excluded", () => {
    const selected = selectExportChannels([general, help, news, forum,
        {id: "99", name: "voice", type: 2}, {id: "98", name: "container", type: 4},
        {id: "97", name: "media", type: 16}]);
    expect(selected).toEqual([general, help, news, forum]);
});

test("pseudo-topics use channel IDs and stable dates; reruns rename without resetting state", async () => {
    const f = fixture();
    await persistChannels(f.database, [general, help, news, forum]);
    expect(f.categories.size).toBe(4); expect(f.topics.size).toBe(3);
    expect(f.topics.has(forum.id)).toBe(false);
    const created = f.topics.get(general.id).created;
    expect(created.getTime()).toBe(Number((BigInt(general.id) >> 22n) + 1420070400000n));
    f.states.set(general.id, {lastMessageId: "123"});
    await persistChannels(f.database, [{...general, name: "renamed"}, help, news, forum]);
    expect(f.topics.size).toBe(3); expect(f.categories.get(general.id).name).toBe("renamed");
    expect(f.topics.get(general.id)).toEqual({id: general.id, categoryId: general.id, title: "renamed", created});
    expect(f.states.get(general.id).lastMessageId).toBe("123");
});

test("a conflicting existing topic is not moved into a channel", async () => {
    const f = fixture(); f.topics.set(general.id, {id: general.id, categoryId: "other"});
    await expect(persistChannels(f.database, [general])).rejects.toThrow("different category");
    expect(f.topics.get(general.id).categoryId).toBe("other");
});

test("channel history reuses incremental cursors independently and preserves the real channel ID", async () => {
    const f = fixture(); await persistChannels(f.database, [general, help]);
    const messages = new Map<string, APIMessage[]>([
        [general.id, [{id: "90071992547409931"}, {id: "90071992547409932"}] as APIMessage[]],
        [help.id, []]
    ]);
    const calls: {id: string, after?: string}[] = [];
    const get = async (id: string, query: any) => {
        calls.push({id, after: query.after});
        return messages.get(id)!.filter(m => BigInt(m.id) > BigInt(query.after ?? "0")).reverse();
    };
    const save = async (_: any, message: APIMessage, topicId: string) => {
        if (f.posts.has(message.id)) return false;
        f.posts.set(message.id, topicId); return true;
    };
    expect((await exportTopic(f.database, general.id, get, () => "", save)).added).toBe(2);
    expect([...f.posts.values()]).toEqual([general.id, general.id]);
    expect((await exportTopic(f.database, help.id, get, () => "", save)).added).toBe(0);
    expect((await exportTopic(f.database, general.id, get, () => "", save)).requests).toBe(1);
    expect(calls.at(-1)).toEqual({id: general.id, after: "90071992547409932"});
    messages.get(general.id)!.push({id: "90071992547409933"} as APIMessage);
    expect((await exportTopic(f.database, general.id, get, () => "", save)).added).toBe(1);
    expect(f.states.get(help.id).lastMessageId).toBe("0");
});

test("old threads fall back to Snowflake dates without using archive timestamps", () => {
    const expected = Number((BigInt(general.id) >> 22n) + 1420070400000n);
    for (const timestamp of [undefined, null, "", "invalid"]) {
        expect(channelCreatedAt(general.id, timestamp).getTime()).toBe(expected);
    }
    expect(channelCreatedAt(general.id, "2023-01-01T12:34:56Z").toISOString()).toBe("2023-01-01T12:34:56.000Z");
    expect(() => channelCreatedAt("invalid")).toThrow("Invalid channel Snowflake");
});
