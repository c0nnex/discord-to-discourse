import type {APIMessage, RESTGetAPIChannelMessagesQuery} from "@discordjs/core";
import type {PrismaClient} from "@prisma/client";
import {storeMessage} from "./store-message";
export async function exportTopic(prisma: PrismaClient, topicId: string,
    getMessages: (id: string, query: RESTGetAPIChannelMessagesQuery) => Promise<APIMessage[]>,
    allocateName: () => string, saveMessage = storeMessage) {
    let state = await prisma.topicExportState.upsert({where: {topicId}, create: {topicId}, update: {}});
    let added = 0, skipped = 0, requests = 0;
    while (true) {
        const query: RESTGetAPIChannelMessagesQuery = {limit: 100};
        if (state.scanBeforeId) { query.before = state.scanBeforeId; }
        else { query.after = state.lastMessageId; }
        const page = await getMessages(topicId, query);
        requests++;
        const ordered = [...page].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0);
        if (state.scanBeforeId && ordered.some(m => BigInt(m.id) >= BigInt(state.scanBeforeId!))) {
            throw new Error("Discord pagination did not advance");
        }
        if (!state.scanBeforeId && ordered.some(m => BigInt(m.id) <= BigInt(state.lastMessageId))) {
            throw new Error("Discord returned a message outside the after boundary");
        }
        const fresh = ordered.filter(m => BigInt(m.id) > BigInt(state.lastMessageId));
        for (const message of [...fresh].reverse()) {
            if (await saveMessage(prisma, message, topicId, allocateName)) { added++; }
            else { skipped++; }
        }
        const high = state.scanHighId ?? fresh[0]?.id ?? state.lastMessageId;
        // Persist the page first; replay on failure is idempotent.
        if (page.length < 100 || fresh.length < page.length) {
            state = await prisma.topicExportState.update({where: {topicId},
                data: {lastMessageId: high, scanBeforeId: null, scanHighId: null}});
            if (page.length === 0 && query.after !== undefined) { break; }
        } else {
            state = await prisma.topicExportState.update({where: {topicId},
                data: {scanBeforeId: ordered[ordered.length - 1].id, scanHighId: high}});
        }
        console.log(`Topic/channel ${topicId}: added=${added}; existing=${skipped}; requests=${requests}.`);
    }
    return {added, skipped, requests};
}
