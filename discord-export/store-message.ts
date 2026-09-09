import {referenceData} from "./message-references";
import type {APIMessage} from "@discordjs/core";
import type {PrismaClient} from "@prisma/client";

/** Existing messages and all their nested data are immutable during export reruns. */
export async function storeMessage(
    prisma: PrismaClient, message: APIMessage, topicId: string, allocateName: () => string,
): Promise<boolean> {
    if (await prisma.post.findUnique({where: {id: message.id}, select: {id: true}})) {
        return false;
    }
    const author = await prisma.user.findUnique({where: {id: message.author.id}, select: {displayName: true}});
    await prisma.post.create({
        data: {
            ...referenceData(message),
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
