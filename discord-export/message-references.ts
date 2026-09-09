import type {PrismaClient} from "@prisma/client";

// Structural typing also accepts reference types newer than the installed Discord SDK.
export type ReferenceSource = {
    id: string;
    channel_id: string;
    type: number;
    message_reference?: {type?: number; message_id?: string; channel_id?: string; guild_id?: string};
    referenced_message?: unknown | null;
};

export function referenceData(message: ReferenceSource) {
    const reference = message.message_reference;
    return {
        messageType: message.type,
        referenceType: reference ? (reference.type ?? 0) : null,
        referenceMessageId: reference?.message_id ?? null,
        referenceChannelId: reference?.channel_id ?? null,
        referenceGuildId: reference?.guild_id ?? null,
        referencedMessageDeleted: message.referenced_message === null ? true
            : message.referenced_message === undefined ? null : false,
        referenceCheckedAt: new Date(),
    };
}

/** Revisit legacy posts only. Failed source reads remain pending for the next invocation. */
export async function backfillMessageReferences(
    prisma: PrismaClient,
    getMessage: (channelId: string, messageId: string) => Promise<ReferenceSource>,
) {
    let lastId: string | undefined;
    let updated = 0;
    let failed = 0;
    while (true) {
        const posts = await prisma.post.findMany({
            where: {referenceCheckedAt: null, ...(lastId === undefined ? {} : {id: {gt: lastId}})},
            select: {id: true, topicId: true},
            orderBy: {id: "asc"},
            take: 100,
        });
        if (posts.length === 0) { break; }
        for (const post of posts) {
            let source: ReferenceSource;
            try {
                source = await getMessage(post.topicId, post.id);
                if (source.id !== post.id || source.channel_id !== post.topicId) {
                    throw new Error("Source message identity mismatch");
                }
            } catch {
                // Do not log API payloads, credentials or signed URLs.
                console.warn(`Message ${post.id}: reference lookup failed; retained pending state.`);
                failed++;
                continue;
            }
            // A database failure must stop the command, not masquerade as an API failure.
            const result = await prisma.post.updateMany({
                where: {id: post.id, referenceCheckedAt: null},
                data: referenceData(source),
            });
            updated += result.count;
        }
        lastId = posts[posts.length - 1].id;
        console.log(`Message references: updated=${updated}; failed=${failed}.`);
    }
    const remaining = await prisma.post.count({where: {referenceCheckedAt: null}});
    console.log(`Message reference backfill finished: updated=${updated}; failed=${failed}; remaining=${remaining}.`);
    return {updated, failed, remaining};
}
