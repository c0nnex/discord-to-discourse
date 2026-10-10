import {expect, test} from "bun:test";
import {PrismaClient} from "@prisma/client";
import {randomUUID} from "node:crypto";
import {deleteChannel, deleteTopics, isUnknownChannelError, pruneVanishedChannels} from "../deleted-sources";

function recordingDatabase(categories: {id: string; name: string}[] = []) {
    const calls: string[] = [];
    const where: Record<string, unknown> = {};
    const deleter = (name: string, count = 1) => ({deleteMany: (query: {where: unknown}) => {
        calls.push(name);
        where[name] = query.where;
        return Promise.resolve({count});
    }});
    const db: any = {
        attachmentBlob: deleter("blob", 4), attachment: deleter("attachment", 3), post: deleter("post", 2),
        topicExportState: deleter("state"), topic: deleter("topic", 5), exportControl: deleter("control"),
        category: {...deleter("category"), findMany: async () => categories},
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    };
    return {db, calls, where};
}

test("only Discord Unknown Channel errors are recognized", () => {
    expect(isUnknownChannelError({code: 10003, status: 404})).toBe(true);
    expect(isUnknownChannelError({code: 50001, status: 403})).toBe(false);
    expect(isUnknownChannelError(new Error("Unknown Channel"))).toBe(false);
    expect(isUnknownChannelError(null)).toBe(false);
});

test("deleting threads removes dependent rows first and returns counts", async () => {
    const {db, calls, where} = recordingDatabase();
    const counts = await deleteTopics(db, ["t1", "t2"]);
    expect(calls).toEqual(["blob", "attachment", "post", "state", "topic"]);
    expect(where.topic).toEqual({id: {in: ["t1", "t2"]}});
    expect(counts).toEqual({blobs: 4, attachments: 3, posts: 2, topics: 5, categories: 0});
    calls.length = 0;
    await deleteTopics(db, []);
    expect(calls).toEqual([]);
});

test("deleting a channel also removes its pinned start date and the category", async () => {
    const {db, calls, where} = recordingDatabase();
    const counts = await deleteChannel(db, "c1");
    expect(calls).toEqual(["blob", "attachment", "post", "state", "topic", "control", "category"]);
    expect(where.topic).toEqual({categoryId: "c1"});
    expect(where.control).toEqual({key: "ChannelStartDate:c1"});
    expect(where.category).toEqual({id: "c1"});
    expect(counts.categories).toBe(1);
});

test("pruning deletes only channels absent from Discord and logs each one", async () => {
    const known = [{id: "a", name: "kept"}, {id: "b", name: "gone"}, {id: "c", name: "excluded-but-present"},
        {id: "d", name: "kept-too"}];
    const {db, where} = recordingDatabase(known);
    const log: string[] = [];
    const counts = await pruneVanishedChannels(db, ["a", "c", "d", "unrelated"], line => log.push(line));
    expect(where.category).toEqual({id: "b"});
    expect(counts.categories).toBe(1);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("gone");
});

test("pruning refuses an empty or implausibly short live channel list", async () => {
    const known = [{id: "a", name: "a"}, {id: "b", name: "b"}, {id: "c", name: "c"}];
    const {db, calls} = recordingDatabase(known);
    await expect(pruneVanishedChannels(db, [])).rejects.toThrow("empty channel list");
    await expect(pruneVanishedChannels(db, ["a"])).rejects.toThrow("Refusing to delete 2 of 3");
    expect(calls).toEqual([]);
});

// Explicit opt-in; only point this at a disposable, migrated test database.
const databaseUrl = process.env.ATTACHMENT_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)("real database: deleting a vanished channel and thread keeps others and users", async () => {
    const prisma = new PrismaClient({datasources: {db: {url: databaseUrl}}});
    const id = randomUUID();
    const ids = {gone: `${id}-gone`, kept: `${id}-kept`, thread: `${id}-thread`, sibling: `${id}-sibling`,
        author: `${id}-author`};
    async function topic(topicId: string, categoryId: string) {
        await prisma.topic.create({data: {id: topicId, title: topicId, categoryId}});
        await prisma.topicExportState.create({data: {topicId}});
        const post = await prisma.post.create({data: {id: `${topicId}-post`, authorId: ids.author, body: "x", topicId}});
        const attachment = await prisma.attachment.create({data: {id: `${topicId}-file`, name: "f", url: "u", postId: post.id}});
        await prisma.attachmentBlob.create({data: {attachmentId: attachment.id, content: Buffer.from("x"), sha256: "0".repeat(64)}});
    }
    try {
        await prisma.user.create({data: {id: ids.author, username: "u", displayName: "d"}});
        for (const category of [ids.gone, ids.kept]) await prisma.category.create({data: {id: category, name: category}});
        await prisma.exportControl.create({data: {key: `ChannelStartDate:${ids.gone}`, value: "2024-01-01"}});
        await topic(ids.gone, ids.gone);
        await topic(ids.thread, ids.kept);
        await topic(ids.sibling, ids.kept);

        const threadCounts = await deleteTopics(prisma, [ids.thread]);
        expect(threadCounts).toEqual({blobs: 1, attachments: 1, posts: 1, topics: 1, categories: 0});
        expect(await prisma.topic.count({where: {id: ids.sibling}})).toBe(1);
        expect(await prisma.attachmentBlob.count({where: {attachmentId: `${ids.sibling}-file`}})).toBe(1);

        const keep = (await prisma.category.findMany({select: {id: true}})).map(c => c.id).filter(c => c !== ids.gone);
        const counts = await pruneVanishedChannels(prisma, keep, () => {});
        expect(counts.categories).toBe(1);
        expect(await prisma.category.count({where: {id: ids.gone}})).toBe(0);
        expect(await prisma.exportControl.count({where: {key: `ChannelStartDate:${ids.gone}`}})).toBe(0);
        expect(await prisma.post.count({where: {topicId: ids.gone}})).toBe(0);
        expect(await prisma.category.count({where: {id: ids.kept}})).toBe(1);
        expect(await prisma.post.count({where: {topicId: ids.sibling}})).toBe(1);
        expect(await prisma.user.count({where: {id: ids.author}})).toBe(1);
    } finally {
        await prisma.attachmentBlob.deleteMany({where: {attachmentId: {startsWith: id}}});
        await prisma.attachment.deleteMany({where: {id: {startsWith: id}}});
        await prisma.post.deleteMany({where: {id: {startsWith: id}}});
        await prisma.topicExportState.deleteMany({where: {topicId: {startsWith: id}}});
        await prisma.topic.deleteMany({where: {id: {startsWith: id}}});
        await prisma.category.deleteMany({where: {id: {startsWith: id}}});
        await prisma.exportControl.deleteMany({where: {key: {contains: id}}});
        await prisma.user.deleteMany({where: {id: ids.author}});
        await prisma.$disconnect();
    }
});
