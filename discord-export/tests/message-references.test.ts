import {expect, test} from "bun:test";
import type {PrismaClient} from "@prisma/client";
import {backfillMessageReferences, referenceData, type ReferenceSource} from "../message-references";

function source(id = "1"): ReferenceSource {
    return {id, channel_id: "thread", type: 19};
}

test("preserves large string IDs, default type, and deleted/unknown target distinction", () => {
    const reference = {message_id: "18446744073709551615", channel_id: "90071992547409999", guild_id: "123"};
    const data = referenceData({...source(), message_reference: reference, referenced_message: null});
    expect(data.referenceMessageId).toBe(reference.message_id);
    expect(data.referenceChannelId).toBe(reference.channel_id);
    expect(data.referenceType).toBe(0);
    expect(data.referencedMessageDeleted).toBe(true);
    expect(data.referenceCheckedAt).toBeInstanceOf(Date);
    expect(referenceData(source()).referenceType).toBeNull();
    expect(referenceData(source()).referencedMessageDeleted).toBeNull();
    expect(referenceData({...source(), message_reference: {type: 1}, referenced_message: {}}).referenceType).toBe(1);
    expect(referenceData({...source(), referenced_message: {}}).referencedMessageDeleted).toBe(false);
});

function fixture(count = 103) {
    const rows = Array.from({length: count}, (_, i) => ({
        id: String(i).padStart(4, "0"), topicId: "thread", referenceCheckedAt: null as Date | null,
        body: "preserved", authorId: "author", referenceMessageId: null as string | null,
    }));
    const prisma = {post: {
        findMany: async ({where, take}: any) => rows.filter(row => row.referenceCheckedAt === null &&
            (!where.id || row.id > where.id.gt)).slice(0, take),
        updateMany: async ({where, data}: any) => {
            const row = rows.find(row => row.id === where.id && row.referenceCheckedAt === null);
            if (!row) { return {count: 0}; }
            Object.assign(row, data);
            return {count: 1};
        },
        count: async () => rows.filter(row => row.referenceCheckedAt === null).length,
    }} as unknown as PrismaClient;
    return {rows, prisma};
}

test("backfill paginates, continues after source failure and resumes without refetching completed posts", async () => {
    const {rows, prisma} = fixture();
    const get = async (_: string, id: string) => {
        if (id === "0002") { throw new Error("unavailable"); }
        return {...source(id), message_reference: {message_id: "external-target"}};
    };
    expect(await backfillMessageReferences(prisma, get)).toEqual({updated: 102, failed: 1, remaining: 1});
    expect(rows[2].referenceCheckedAt).toBeNull();
    let requests = 0;
    expect(await backfillMessageReferences(prisma, async (_, id) => { requests++; return source(id); }))
        .toEqual({updated: 1, failed: 0, remaining: 0});
    expect(requests).toBe(1);
    expect(rows.every(row => row.body === "preserved" && row.authorId === "author")).toBe(true);
    expect(await backfillMessageReferences(prisma, async () => { throw new Error("must not fetch"); }))
        .toEqual({updated: 0, failed: 0, remaining: 0});
});

test("wrong source identity remains pending; database failures abort and can resume", async () => {
    const {prisma} = fixture(1);
    expect((await backfillMessageReferences(prisma, async () => source("wrong"))).remaining).toBe(1);
    const update = prisma.post.updateMany;
    prisma.post.updateMany = (async () => { throw new Error("database unavailable"); }) as any;
    await expect(backfillMessageReferences(prisma, async (_, id) => source(id))).rejects.toThrow("database unavailable");
    prisma.post.updateMany = update;
    expect((await backfillMessageReferences(prisma, async (_, id) => source(id))).updated).toBe(1);
});
