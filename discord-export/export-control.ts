import {parseStartDate} from "./export-options";
import type {PrismaClient} from "@prisma/client";
import {selectExportChannels, type SourceChannel} from "./channel-export";

export async function readNoExportRoleId(prisma: PrismaClient): Promise<string | undefined> {
    const setting = await prisma.exportControl.findUnique({where: {key: "NoExportRoleId"}});
    const id = setting?.value.trim();
    if (!id) return undefined;
    if (!/^[1-9][0-9]*$/.test(id) || BigInt(id) > 18446744073709551615n) {
        throw new Error("ExportControl.NoExportRoleId is not a valid Snowflake");
    }
    return id;
}

export function selectControlledChannels(channels: readonly SourceChannel[], roleId?: string) {
    const marked = new Set(channels.filter(channel => roleId && channel.permission_overwrites?.some(
        overwrite => overwrite.type === 0 && overwrite.id === roleId)).map(channel => channel.id));
    const blocked = new Set(channels.filter(channel => marked.has(channel.id) ||
        (channel.parent_id && marked.has(channel.parent_id))).map(channel => channel.id));
    const exportable = selectExportChannels(channels);
    return {selected: exportable.filter(channel => !blocked.has(channel.id)),
        excluded: exportable.filter(channel => blocked.has(channel.id))};
}

// This is selection metadata, not permission grants or deletion of historical rows.
export async function saveChannelSelection(prisma: PrismaClient, channels: readonly SourceChannel[],
    selectedIds: readonly string[], since?: Date, channelId?: string, dates?: ReadonlyMap<string, Date | undefined>) {
    const selected = new Set(selectedIds);
    const checkedAt = new Date();
    await prisma.$transaction(async database => {
        if (!channelId) await database.category.updateMany({data: {exportEnabled: false, exportCheckedAt: checkedAt}});
        for (const channel of selectExportChannels(channels).filter(c => !channelId || c.id === channelId)) {
            const data = {name: channel.name, exportEnabled: selected.has(channel.id),
                exportSince: (dates ? dates.get(channel.id) : since) ?? null, exportCheckedAt: checkedAt};
            await database.category.upsert({where: {id: channel.id}, create: {id: channel.id, ...data}, update: data});
        }
    });
}

export function selectRequestedChannel<T extends {id: string}>(channels: readonly T[], channelId?: string): T[] {
    if (!channelId) return [...channels];
    const channel = channels.find(c => c.id === channelId);
    if (!channel) throw new Error("Requested channel is excluded, inaccessible or unsupported");
    return [channel];
}

// A channel-specific export pins its date. General run limits can only narrow it.
export async function channelStartDates(prisma: PrismaClient, ids: readonly string[],
    since?: Date, channelId?: string, save = false): Promise<Map<string, Date | undefined>> {
    if (save && channelId && since) {
        if (!ids.includes(channelId)) throw new Error("Cannot configure an unselected channel");
        const key = `ChannelStartDate:${channelId}`;
        const value = since.toISOString().slice(0, 10);
        await prisma.exportControl.upsert({where: {key}, create: {key, value}, update: {value}});
    }
    const result = new Map<string, Date | undefined>();
    for (const id of ids) {
        const setting = await prisma.exportControl.findUnique({where: {key: `ChannelStartDate:${id}`}});
        const pinned = setting?.value ? parseStartDate(setting.value) : undefined;
        result.set(id, pinned && (!since || pinned > since) ? pinned : since);
    }
    return result;
}
