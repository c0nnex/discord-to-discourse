import type {PrismaClient} from "@prisma/client";

export interface ExportChannel { id: string; name: string; type: number; }
export interface SourceChannel {
    id: string; name?: string | null; type: number; parent_id?: string | null;
    permission_overwrites?: readonly {id: string; type: number; allow?: string; deny?: string}[];
}

export function selectExportChannels(channels: readonly SourceChannel[]): ExportChannel[] {
    return channels.filter(channel => [0, 5, 15].includes(channel.type)).map(channel => {
        if (!channel.name || !/^[1-9][0-9]*$/.test(channel.id)) {
            throw new Error("Exportable channel has no valid name or Snowflake ID");
        }
        return {id: channel.id, name: channel.name, type: channel.type};
    });
}

export async function persistChannels(prisma: PrismaClient, channels: readonly SourceChannel[]) {
    const selected = selectExportChannels(channels);
    for (const channel of selected) {
        await prisma.$transaction(async database => {
            await database.category.upsert({where: {id: channel.id},
                create: {id: channel.id, name: channel.name}, update: {name: channel.name}});
            if (channel.type !== 15) {
                const existing = await database.topic.findUnique({where: {id: channel.id}});
                if (existing && existing.categoryId !== channel.id) {
                    throw new Error(`Pseudo-topic ${channel.id} belongs to a different category`);
                }
                // A channel ID is globally unique and remains the real message-fetch endpoint.
                const created = channelCreatedAt(channel.id);
                await database.topic.upsert({where: {id: channel.id},
                    create: {id: channel.id, categoryId: channel.id, title: channel.name, created},
                    update: {title: channel.name}});
            }
        });
    }
    return selected;
}

// Older threads omit create_timestamp. Their Snowflake still carries a stable date.
export function channelCreatedAt(id: string, timestamp?: string | null): Date {
    if (timestamp) {
        const created = new Date(timestamp);
        if (!Number.isNaN(created.getTime())) return created;
    }
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`Invalid channel Snowflake: ${id}`);
    const created = new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
    if (Number.isNaN(created.getTime())) throw new Error(`Invalid channel date: ${id}`);
    return created;
}
