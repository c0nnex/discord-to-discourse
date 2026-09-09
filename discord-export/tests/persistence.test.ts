import {expect, test} from "bun:test";
import {PrismaClient} from "@prisma/client";
import type {APIMessage} from "@discordjs/core";
import {createHash, randomUUID} from "node:crypto";
import {backfillMessageReferences} from "../message-references";
import {storeMessage} from "../store-message";
import {downloadAttachments} from "../download-attachments";

// Explicit opt-in; only point this at a disposable, migrated test database.
const databaseUrl = process.env.ATTACHMENT_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)("real database: additive export, atomic blobs and download resume", async () => {
    const prisma = new PrismaClient({datasources: {db: {url: databaseUrl}}});
    const prefix = randomUUID();
    const topicId = prefix + "-topic";
    const authorId = prefix + "-author";
    const message = {
        id: prefix + "-message", channel_id: topicId, type: 19,
        message_reference: {message_id: "90071992547409999", channel_id: "external-thread", guild_id: "external-guild"},
        author: {id: authorId, username: "original"},
        timestamp: "2020-01-01T00:00:00Z", content: "original",
        attachments: [{id: prefix + "-file", filename: "example.txt", url: "https://cdn.discordapp.com/attachments/synthetic/file", size: 3}],
    } as APIMessage;
    try {
        await prisma.category.create({data: {id: prefix, name: "synthetic"}});
        await prisma.topic.create({data: {id: topicId, title: "original", categoryId: prefix}});
        let names = 0;
        const allocate = () => { names++; return "Stable author"; };
        expect(await storeMessage(prisma, message, topicId, allocate)).toBe(true);
        expect(await storeMessage(prisma, {...message, content: "changed", attachments: []}, topicId, allocate)).toBe(false);
        expect(await storeMessage(prisma, {...message, id: prefix + "-new", attachments: []}, topicId, allocate)).toBe(true);
        expect(names).toBe(1);
        expect((await prisma.post.findUniqueOrThrow({where: {id: message.id}})).body).toBe("original");
        const exported = await prisma.post.findUniqueOrThrow({where: {id: message.id}});
        expect(exported.referenceMessageId).toBe("90071992547409999");
        expect(exported.referenceType).toBe(0);
        expect(exported.messageType).toBe(19);
        expect(exported.referenceCheckedAt).toBeInstanceOf(Date);
        await prisma.post.update({where: {id: message.id}, data: {referenceCheckedAt: null}});
        await backfillMessageReferences(prisma, async (channel, id) => {
            if (id !== message.id) { throw new Error("unrelated fixture"); }
            return {id, channel_id: channel, type: 19,
                message_reference: {type: 0, message_id: "18446744073709551615"},
                referenced_message: null};
        });
        const backfilled = await prisma.post.findUniqueOrThrow({where: {id: message.id}});
        expect(backfilled.referenceMessageId).toBe("18446744073709551615");
        expect(backfilled.referencedMessageDeleted).toBe(true);
        expect(backfilled.body).toBe(exported.body);
        expect(backfilled.authorId).toBe(exported.authorId);
        expect(backfilled.created).toEqual(exported.created);
        expect(await prisma.attachment.count({where: {postId: message.id}})).toBe(1);

        expect((await prisma.user.findUniqueOrThrow({where: {id: authorId}})).displayName).toBe("Stable author");
        expect(await prisma.attachmentBlob.count({where: {attachmentId: message.attachments[0].id}})).toBe(0);
        let attempts = 0;
        let targetFetches = 0;
        const source = async (_: string, id: string) => {
            if (id !== message.id) { throw new Error("unrelated fixture"); }
            targetFetches++;
            return {attachments: message.attachments.map(file => ({id: file.id, url: file.url + "?fresh=1", size: file.size}))};
        };
        const read = async () => {
            attempts++;
            if (attempts === 1) { throw new Error("HTTP 404 Not Found"); }
            const data = Buffer.from("abc");
            return {data, sha256: createHash("sha256").update(data).digest("hex")};
        };
        await downloadAttachments(prisma, source, 100, read, async()=>3n);
        expect(await prisma.attachmentBlob.count({where: {attachmentId: message.attachments[0].id}})).toBe(0);
        expect((await prisma.attachment.findUniqueOrThrow({where: {id: message.attachments[0].id}})).size).toBe(3n);
        await downloadAttachments(prisma, source, 100, read, async()=>3n);
        const blob = await prisma.attachmentBlob.findUniqueOrThrow({where: {attachmentId: message.attachments[0].id}});
        expect(Buffer.from(blob.content).toString()).toBe("abc");
        expect(blob.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
        expect(blob.downloadedAt).toBeInstanceOf(Date);
        const fetchesBefore = targetFetches;
        await downloadAttachments(prisma, source, 100, read, async()=>3n);
        expect(attempts).toBe(2);
        expect(targetFetches).toBe(fetchesBefore);
        const before = await prisma.attachment.findUniqueOrThrow({where: {id: blob.attachmentId}});
        await expect(prisma.$transaction([
            prisma.attachment.update({where: {id: blob.attachmentId}, data: {url: "must-rollback"}}),
            prisma.attachmentBlob.create({data: {attachmentId: blob.attachmentId, content: Buffer.from("duplicate"), sha256: "0".repeat(64)}}),
        ])).rejects.toThrow();
        expect((await prisma.attachment.findUniqueOrThrow({where: {id: blob.attachmentId}})).url).toBe(before.url);
    } finally {
        await prisma.attachmentBlob.deleteMany({where: {attachmentId: {startsWith: prefix}}});
        await prisma.attachment.deleteMany({where: {id: {startsWith: prefix}}});
        await prisma.post.deleteMany({where: {id: {startsWith: prefix}}});
        await prisma.user.deleteMany({where: {id: authorId}});
        await prisma.topic.deleteMany({where: {id: topicId}});
        await prisma.category.deleteMany({where: {id: prefix}});
        await prisma.$disconnect();
    }
});

test.skipIf(!databaseUrl)("incremental cursor persists across invocations in MariaDB", async () => {
    const prisma=new PrismaClient({datasources:{db:{url:databaseUrl}}});
    const id=randomUUID();
    try {
        await prisma.category.create({data:{id,name:"synthetic"}});
        await prisma.topic.create({data:{id,title:"synthetic",categoryId:id}});
        const {exportTopic}=await import("../incremental-export");
        const msg={id:"90071992547409999",author:{id,username:"fixture"},timestamp:"2020-01-01T00:00:00Z",content:"fixture",attachments:[]} as unknown as APIMessage;
        const get=async(_:string,q:any)=>q.after==="0"?[msg]:[];
        expect((await exportTopic(prisma,id,get,()=>"fixture")).added).toBe(1);
        expect((await prisma.topicExportState.findUniqueOrThrow({where:{topicId:id}})).lastMessageId).toBe(msg.id);
        expect((await exportTopic(prisma,id,get,()=>"unused")).requests).toBe(1);
    } finally {
        await prisma.topicExportState.deleteMany({where:{topicId:id}});
        await prisma.post.deleteMany({where:{topicId:id}});
        await prisma.user.deleteMany({where:{id}});
        await prisma.topic.deleteMany({where:{id}});
        await prisma.category.deleteMany({where:{id}});
        await prisma.$disconnect();
    }
});
