import type {PrismaClient} from "@prisma/client";

export interface DeletedCounts {
    blobs: number;
    attachments: number;
    posts: number;
    topics: number;
    categories: number;
}

const UNKNOWN_CHANNEL = 10003;

export function isUnknownChannelError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as {code?: unknown}).code === UNKNOWN_CHANNEL;
}

export function emptyCounts(): DeletedCounts {
    return {blobs: 0, attachments: 0, posts: 0, topics: 0, categories: 0};
}

export function addCounts(total: DeletedCounts, add: DeletedCounts): DeletedCounts {
    return {
        blobs: total.blobs + add.blobs,
        attachments: total.attachments + add.attachments,
        posts: total.posts + add.posts,
        topics: total.topics + add.topics,
        categories: total.categories + add.categories,
    };
}

export function formatCounts(counts: DeletedCounts): string {
    return `${counts.categories} channels, ${counts.topics} topics, ${counts.posts} posts, ` +
        `${counts.attachments} attachments, ${counts.blobs} blobs`;
}

/** Removes exported threads that no longer exist on Discord. Users are kept. */
export async function deleteTopics(prisma: PrismaClient, topicIds: readonly string[]): Promise<DeletedCounts> {
    if (topicIds.length === 0) { return emptyCounts(); }
    const ids = {in: [...topicIds]};
    const [blobs, attachments, posts, , topics] = await prisma.$transaction([
        prisma.attachmentBlob.deleteMany({where: {attachment: {post: {topicId: ids}}}}),
        prisma.attachment.deleteMany({where: {post: {topicId: ids}}}),
        prisma.post.deleteMany({where: {topicId: ids}}),
        prisma.topicExportState.deleteMany({where: {topicId: ids}}),
        prisma.topic.deleteMany({where: {id: ids}}),
    ]);
    return {blobs: blobs.count, attachments: attachments.count, posts: posts.count, topics: topics.count, categories: 0};
}

/** Removes an exported channel with all its topics, posts and its pinned start date. */
export async function deleteChannel(prisma: PrismaClient, channelId: string): Promise<DeletedCounts> {
    const inChannel = {categoryId: channelId};
    const [blobs, attachments, posts, , topics, , categories] = await prisma.$transaction([
        prisma.attachmentBlob.deleteMany({where: {attachment: {post: {topic: inChannel}}}}),
        prisma.attachment.deleteMany({where: {post: {topic: inChannel}}}),
        prisma.post.deleteMany({where: {topic: inChannel}}),
        prisma.topicExportState.deleteMany({where: {topic: inChannel}}),
        prisma.topic.deleteMany({where: inChannel}),
        prisma.exportControl.deleteMany({where: {key: `ChannelStartDate:${channelId}`}}),
        prisma.category.deleteMany({where: {id: channelId}}),
    ]);
    return {blobs: blobs.count, attachments: attachments.count, posts: posts.count, topics: topics.count,
        categories: categories.count};
}

/**
 * Deletes exported channels that are absent from the live guild channel list.
 * Excluded channels are still present in that list and are never touched here.
 */
export async function pruneVanishedChannels(prisma: PrismaClient, liveChannelIds: readonly string[],
    log: (line: string) => void = console.log): Promise<DeletedCounts> {
    if (liveChannelIds.length === 0) {
        throw new Error("Refusing to delete exported channels: Discord returned an empty channel list");
    }
    const live = new Set(liveChannelIds);
    const known = await prisma.category.findMany({select: {id: true, name: true}});
    const vanished = known.filter(channel => !live.has(channel.id));
    if (vanished.length * 2 > known.length) {
        throw new Error(`Refusing to delete ${vanished.length} of ${known.length} exported channels ` +
            "absent from the Discord channel list; verify the guild and bot access first");
    }
    let total = emptyCounts();
    for (const channel of vanished) {
        const removed = await deleteChannel(prisma, channel.id);
        log(`Channel ${channel.id} (${channel.name}) no longer exists on Discord; deleted ${formatCounts(removed)}.`);
        total = addCounts(total, removed);
    }
    return total;
}
