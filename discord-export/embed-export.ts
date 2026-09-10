import type {APIMessage} from "@discordjs/core";
import type {Prisma, PrismaClient} from "@prisma/client";

// Keep the API array, ordering and unknown nested fields; rendering is a separate concern.
export function embedData(message: Pick<APIMessage, "embeds">) {
    if (!Array.isArray(message.embeds)) throw new Error("Source message has no embeds array");
    return {embeds: JSON.parse(JSON.stringify(message.embeds)) as Prisma.InputJsonValue,
        embedsCheckedAt: new Date()};
}

export async function backfillEmbeds(prisma: PrismaClient, channelIds: readonly string[],
    getMessage: (channelId: string, messageId: string) => Promise<APIMessage>, since?: Date,
    progress?: (counts: {updated: number; failed: number}) => void) {
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
                progress?.({updated, failed});
                console.warn(`Embed lookup failed for message ${post.id}; retained pending state.`);
                continue;
            }
            // Database failures stop; never misreport them as absent Discord content.
            const saved = await prisma.post.updateMany({where: {id: post.id, embedsCheckedAt: null}, data});
            updated += saved.count;
            progress?.({updated, failed});
        }
        lastId = posts[posts.length - 1].id;
        if (!progress) console.log(`Embed backfill: updated=${updated}; failed=${failed}.`);
    }
    const remaining = await prisma.post.count({where: pending});
    if (!progress) console.log(`Embed backfill finished: updated=${updated}; failed=${failed}; remaining=${remaining}.`);
    return {updated, failed, remaining};
}

/** One run-wide report; low-level backfill remains independently resumable. */
export async function runEmbedBackfill(prisma: PrismaClient,
    channels: readonly {id: string; name: string}[], dates: ReadonlyMap<string, Date | undefined>,
    getMessage: (channelId: string, messageId: string) => Promise<APIMessage>,
    reportEveryMs = 10000) {
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let updated = 0, failed = 0, total = 0;
    const duration = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    try {
        console.log(`Embed backfill preparing: selectedChannels=${channels.length}; counting pending posts.`);
        const work = [];
        let alreadyCaptured = 0;
        for (const channel of channels) {
            const since = dates.get(channel.id);
            const scope = {topic: {categoryId: {in: [channel.id]}}, ...(since ? {created: {gte: since}} : {})};
            const all = await prisma.post.count({where: scope});
            const pending = await prisma.post.count({where: {...scope, embedsCheckedAt: null}});
            alreadyCaptured += all - pending;
            total += pending;
            if (pending) work.push({...channel, since, pending});
        }
        console.log(`Embed backfill started: pending=${total}; alreadyCaptured=${alreadyCaptured}; channelsWithWork=${work.length}/${channels.length}. Counters cover pending posts at this run's start.`);
        let remaining = 0;
        let current: {id: string; name: string; pending: number} | undefined;
        let position = 0, channelUpdated = 0, channelFailed = 0;
        const report = () => {
            if (!current) return;
            const attempted = updated + failed + channelUpdated + channelFailed;
            const percent = total ? Math.min(100, attempted * 100 / total).toFixed(1) : "100.0";
            console.log(`Embed backfill progress: channel=${JSON.stringify(current.name)} (${current.id}) [${position}/${work.length}]; channelChecked=${channelUpdated}/${current.pending}; channelFailed=${channelFailed}; channelRemaining=${Math.max(0,current.pending-channelUpdated)}; overallAttempted=${attempted}/${total} (${percent}%); overallChecked=${updated+channelUpdated}; overallFailed=${failed+channelFailed}; overallRemaining=${Math.max(0,total-updated-channelUpdated)}; elapsed=${duration()}.`);
        };
        timer = setInterval(report, reportEveryMs);
        timer.unref();
        for (const channel of work) {
            current = channel; position++; channelUpdated = 0; channelFailed = 0;
            console.log(`Embed backfill channel start: ${JSON.stringify(channel.name)} (${channel.id}); since=${channel.since?.toISOString() ?? "all"}; pending=${channel.pending}.`);
            report();
            const result = await backfillEmbeds(prisma, [channel.id], getMessage, channel.since, counts => {
                channelUpdated = counts.updated; channelFailed = counts.failed;
                if ((channelUpdated + channelFailed) % 100 === 0) report();
            });
            report();
            updated += result.updated; failed += result.failed; remaining += result.remaining;
            console.log(`Embed backfill channel done: ${JSON.stringify(channel.name)} (${channel.id}); checked=${result.updated}; failed=${result.failed}; remaining=${result.remaining}.`);
            current = undefined;
        }
        const state = failed || remaining ? "COMPLETED WITH PENDING WORK" : "COMPLETED SUCCESSFULLY";
        console.log(`EMBED BACKFILL ${state}: checked=${updated}/${total}; alreadyCaptured=${alreadyCaptured}; failed=${failed}; remaining=${remaining}; elapsed=${duration()}.`);
        return {updated, failed, remaining};
    } catch (error) {
        console.error(`EMBED BACKFILL ABORTED: elapsed=${duration()}; pending work was not completed. Rerun to resume.`);
        throw error;
    } finally {
        if (timer) clearInterval(timer);
    }
}
