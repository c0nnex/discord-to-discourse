import type {APIMessage} from "@discordjs/core";
import type {Prisma, PrismaClient} from "@prisma/client";

// Keep the API array, ordering and unknown nested fields; rendering is a separate concern.
export function embedData(message: Pick<APIMessage, "embeds">) {
    if (!Array.isArray(message.embeds)) throw new Error("Source message has no embeds array");
    return {embeds: JSON.parse(JSON.stringify(message.embeds)) as Prisma.InputJsonValue,
        embedsCheckedAt: new Date()};
}

export async function backfillEmbeds(prisma: PrismaClient, channelIds: readonly string[],
    getMessage: (channelId: string, messageId: string) => Promise<APIMessage>, since?: Date) {
    const pending = {embedsCheckedAt: null, topic: {categoryId: {in: [...channelIds]}},
        ...(since ? {created: {gte: since}} : {})};
    let lastId: string | undefined;
    let updated = 0, failed = 0;
    while (true) {
        const posts = await prisma.post.findMany({where: {...pending, ...(lastId ? {id: {gt: lastId}} : {})},
            select: {id: true, topicId: true}, orderBy: {id: "asc"}, take: 100});
        if (posts.length === 0) break;
        for (const post of posts) {
            let data: ReturnType<typeof embedData>;
            try {
                const source = await getMessage(post.topicId, post.id);
                if (source.id !== post.id || source.channel_id !== post.topicId) throw new Error("Source identity mismatch");
                data = embedData(source);
            } catch {
                failed++;
                console.warn(`Embed lookup failed for message ${post.id}; retained pending state.`);
                continue;
            }
            // Database failures stop; never misreport them as absent Discord content.
            await prisma.post.updateMany({where: {id: post.id, embedsCheckedAt: null}, data});
            updated++;
        }
        lastId = posts[posts.length - 1].id;
        console.log(`Embed backfill: updated=${updated}; failed=${failed}.`);
    }
    const remaining = await prisma.post.count({where: pending});
    console.log(`Embed backfill finished: updated=${updated}; failed=${failed}; remaining=${remaining}.`);
    return {updated, failed, remaining};
}
