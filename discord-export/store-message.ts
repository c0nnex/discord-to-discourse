import {embedData} from "./embed-export";
import {referenceData} from "./message-references";
import type {APIMessage} from "@discordjs/core";
import type {PrismaClient} from "@prisma/client";

/** Preserve existing source data; only fill previously uncaptured embeds on replay. */
export async function storeMessage(
    prisma: PrismaClient, message: APIMessage, topicId: string, allocateName: () => string,
): Promise<boolean> {
    const existing = await prisma.post.findUnique({where: {id: message.id}, select: {id: true, embedsCheckedAt: true}});
    if (existing) {
        if (!existing.embedsCheckedAt) {
            await prisma.post.updateMany({where: {id: message.id, embedsCheckedAt: null}, data: embedData(message)});
        }
        return false;
    }
    const author = await prisma.user.findUnique({where: {id: message.author.id}, select: {displayName: true}});
    await prisma.post.create({
        data: {
            ...referenceData(message),
            ...embedData(message),
            id: message.id, topic: {connect: {id: topicId}},
            author: {connectOrCreate: {
                where: {id: message.author.id},
                create: {
                    id: message.author.id, username: message.author.username,
                    displayName: author?.displayName ?? allocateName(),
                },
            }},
            created: new Date(message.timestamp), body: message.content,
            attachments: {createMany: {
                data: message.attachments.map(attachment => ({
                    id: attachment.id, name: attachment.filename, url: attachment.url,
                })),
                skipDuplicates: true,
            }},
        },
    });
    return true;
}
