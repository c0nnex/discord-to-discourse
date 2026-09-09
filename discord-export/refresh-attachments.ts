import type {PrismaClient} from "@prisma/client";
import {formatAttachmentError, getAttachmentSize} from "./attachment-sizes";

type SourceMessage = {attachments: {id: string; url: string; size: number}[]};

/** Repair unknown sizes only; preserve known attachments and skip them on rerun. */
export async function refreshAttachments(
    prisma: PrismaClient,
    getMessage: (channelId: string, messageId: string) => Promise<SourceMessage>,
    readSize: typeof getAttachmentSize = getAttachmentSize,
) {
    const total = await prisma.attachment.count({where: {size: null}});
    let processed = 0;
    let updated = 0;
    let failed = 0;
    let lastId: string | undefined;
    while (true) {
        const posts = await prisma.post.findMany({
            where: {attachments: {some: {size: null}}, ...(lastId === undefined ? {} : {id: {gt: lastId}})},
            select: {id: true, topicId: true, attachments: {where: {size: null}, select: {id: true}}},
            orderBy: {id: "asc"},
            take: 100,
        });
        if (posts.length === 0) { break; }
        for (const post of posts) {
            let source: SourceMessage;
            try {
                source = await getMessage(post.topicId, post.id);
            } catch (error) {
                console.warn(`Message ${post.id}: ${formatAttachmentError(error, "")}. Retained existing attachment values.`);
                failed += post.attachments.length;
                processed += post.attachments.length;
                continue;
            }
            const byId = new Map(source.attachments.map(attachment => [attachment.id, attachment]));
            for (const stored of post.attachments) {
                const attachment = byId.get(stored.id);
                let size: bigint;
                try {
                    if (!attachment) { throw new Error("Attachment missing from source message"); }
                    size = await readSize(attachment.url);
                } catch (error) {
                    console.warn(`Attachment ${stored.id}: ${formatAttachmentError(error, attachment?.url ?? "")}. Retained existing values.`);
                    failed++;
                    processed++;
                    continue;
                }
                {
                    await prisma.attachment.update({
                        where: {id: stored.id},
                        data: {url: attachment!.url, size},
                    });
                    updated++;
                }
                processed++;
            }
            console.log(`Refresh attachments [${processed}/${total}]: updated=${updated}; failed=${failed}.`);
        }
        lastId = posts[posts.length - 1].id;
    }
    const summary = await prisma.attachment.aggregate({_sum: {size: true}, _count: {size: true}});
    const unknown = await prisma.attachment.count({where: {size: null}});
    console.log(`Refresh finished: updated=${updated}; failed=${failed}; known=${summary._count.size}; unknown=${unknown}; knownBytes=${summary._sum.size ?? 0n}.`);
    return {updated, failed, unknown};
}
