import {parseExportOptions} from "./export-options";
import {readNoExportRoleId, selectControlledChannels, saveChannelSelection} from "./export-control";
import {backfillEmbeds} from "./embed-export";
import {backfillMessageReferences} from "./message-references";
import {REST} from "@discordjs/rest";
import {API, APIThreadChannel} from "@discordjs/core";
import {PrismaClient, Topic} from "@prisma/client";
import {downloadAttachments} from "./download-attachments.ts";
import {exportTopic} from "./incremental-export.ts";
import {channelCreatedAt, persistChannels, type ExportChannel} from "./channel-export.ts";
import {refreshAttachments} from "./refresh-attachments.ts";
import {getattachmentSizes} from "./attachment-sizes.ts";
import {generateRandomName} from "./awesome-animals.ts";

const prisma = new PrismaClient();
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

let api: API;

function initializeDiscordApi(requireGuild = false) {
    if (!token) {
        throw new Error("DISCORD_BOT_TOKEN not provided in .env file");
    }
    if (requireGuild && !guildId) {
        throw new Error("DISCORD_GUILD_ID not provided in .env file");
    }
    api = new API(new REST({version: "10"}).setToken(token));
}

/**
 * This script exports Discord forum, text and announcement channel data to a database
 * for importing into Discourse.
 *
 * Discord data hierarchy and corresponding database tables:
 * Guild (=Discord server)
 * - Channel -> Category
 * -- Thread -> Topic
 * --- Message -> Post
 * ---- Attachment -> Attachment
 *
 * Users are saved in a separate table and their display names are anonymized.
 */
async function exportDiscordData(since?: Date) {
    initializeDiscordApi(true);
    const startTime = Date.now();
    console.log("Exporting Discord data...");
    const channels = await exportChannels(since);
    await exportThreads(channels);
    await exportMessages(channels, since);
    console.log(`Finished exporting Discord data in ${(Date.now() - startTime) / 1000}s.`);
}

async function selectChannels(since?: Date, persistSelection = true) {
    const roleId = await readNoExportRoleId(prisma);
    if (roleId) {
        const roles = await api.guilds.getRoles(guildId!);
        if (!roles.some(role => role.id === roleId)) throw new Error("Configured NoExportRoleId is not present in this guild");
    }
    const source = await api.guilds.getChannels(guildId!);
    const {selected, excluded} = selectControlledChannels(source, roleId);
    for (const channel of excluded) console.log(`Excluded channel ${channel.id}: NoExport role marker on channel or parent.`);
    console.log(`Channel selection: selected=${selected.length}; excluded=${excluded.length}; roleFilter=${roleId ? "enabled" : "disabled"}; since=${since?.toISOString() ?? "all"}.`);
    if (persistSelection) await saveChannelSelection(prisma, source, selected.map(channel => channel.id), since);
    return selected;
}

async function exportChannels(since?: Date) {
    console.log("Exporting forum, text and announcement channels...");
    const channels = await persistChannels(prisma, await selectChannels(since));
    console.log(`Exported ${channels.length} channels; ${channels.filter(channel => channel.type !== 15).length} pseudo-topics for direct channel messages.`);
    return channels;
}

async function exportThreads(categories: readonly ExportChannel[]) {
    console.log("Exporting threads...");
    let totalThreads = 0;

    // The Discord API does not have a way of getting all threads in a channel.
    // Instead, we need to first get all active threads on the entire server,
    // then filter out the ones that are in the channels we want.
    const categoryIds = categories.map((category) => category.id);
    const {threads} = await api.guilds.getActiveThreads(
        process.env.DISCORD_GUILD_ID!
    );

    const topics: Topic[] = (threads as APIThreadChannel[])
        .filter(
            (thread) => thread.parent_id && categoryIds.includes(thread.parent_id)
        )
        .map((thread) => ({
            id: thread.id,
            title: thread.name,
            created: channelCreatedAt(thread.id, thread.thread_metadata?.create_timestamp),
            categoryId: thread.parent_id!,
        }));
    await prisma.topic.createMany({
        data: topics,
        skipDuplicates: true,
    });
    totalThreads += topics.length;
    console.log(`Exported ${topics.length} active threads.`);

    // Then, we can get all the archived threads for each channel
    for (const category of categories) {
        console.log(`Exporting archived threads for ${category.name}`);
        let hasMore = true;
        let before = new Date().toISOString();

        while (hasMore) {
            console.log(
                `- Fetching next page, getting archived threads before ${before}`
            );
            const threadQuery = await api.channels.getArchivedThreads(
                category.id,
                "public",
                {limit: 100, before}
            );
            const threads = threadQuery.threads as APIThreadChannel[];
            const topics: Topic[] = threads.map((thread) => ({
                id: thread.id,
                title: thread.name,
                created: channelCreatedAt(thread.id, thread.thread_metadata?.create_timestamp),
                categoryId: thread.parent_id!,
            }));

            await prisma.topic.createMany({
                data: topics,
                skipDuplicates: true,
            });
            if (topics.length == 0)
                break;
            totalThreads += topics.length;
            hasMore = threadQuery.has_more;
            before = threads[threads.length - 1].thread_metadata!.archive_timestamp;
        }
    }

    console.log(`Exported ${totalThreads} threads.`);
}

async function exportMessages(selected: readonly ExportChannel[], since?: Date) {
    console.log("Exporting messages...");
    let totalMessages = 0;
    let skippedMessages = 0;
    const usedNames = new Set((await prisma.user.findMany({select: {displayName: true}})).map(user => user.displayName));
    function allocateName() {
        let name = generateRandomName();
        while (usedNames.has(name)) { name = generateRandomName(); }
        usedNames.add(name);
        return name;
    }

    const channels = await prisma.category.findMany({
        where: {id: {in: selected.map(channel => channel.id)}},
        include: {
            topics: true,
        },
    });

    for (const category of channels) {
        console.log(`Exporting messages for ${category.name}`);

        for (const topic of category.topics) {
            console.log(`- Exporting ${topic.id === category.id ? "channel messages" : "thread messages"} for ${topic.title}`);

            const result = await exportTopic(prisma, topic.id,
                (id, query) => api.channels.getMessages(id, query), allocateName, undefined, since);
            totalMessages += result.added;
            skippedMessages += result.skipped;
        }
    }

    console.log(`Exported ${totalMessages} new messages; skipped ${skippedMessages} existing messages.`);
}


try {
    const {command, since} = parseExportOptions(process.argv.slice(2));
    if (command === "backfillEmbeds") {
        initializeDiscordApi(true);
        const channels = await selectChannels(since, false);
        const result = await backfillEmbeds(prisma, channels.map(channel => channel.id),
            (channelId, messageId) => api.channels.getMessage(channelId, messageId), since);
        if (result.failed > 0 || result.remaining > 0) process.exitCode = 2;
    } else if (command === "backfillMessageReferences") {
        initializeDiscordApi();
        const result = await backfillMessageReferences(prisma, (channelId, messageId) => api.channels.getMessage(channelId, messageId));
        if (result.failed > 0 || result.remaining > 0) { process.exitCode = 2; }
    } else if (command === "getattachmentSizes") {
        const result = await getattachmentSizes(prisma);
        if (result.unknown > 0) {
            process.exitCode = 2;
        }
    } else if (command === "refreshAttachments") {
        initializeDiscordApi();
        const result = await refreshAttachments(prisma, (channelId, messageId) => api.channels.getMessage(channelId, messageId));
        if (result.failed > 0 || result.unknown > 0) {
            process.exitCode = 2;
        }
    } else if (command === "downloadAttachments") {
        initializeDiscordApi();
        const result = await downloadAttachments(prisma, (channelId, messageId) => api.channels.getMessage(channelId, messageId));
        if (result.failed > 0 || result.remaining > 0) { process.exitCode = 2; }
    } else {
        await exportDiscordData(since);
    }
    await prisma.$disconnect();
} catch (e) {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
}
