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
    selectedIds: readonly string[], since?: Date) {
    const selected = new Set(selectedIds);
    const checkedAt = new Date();
    await prisma.$transaction(async database => {
        await database.category.updateMany({data: {exportEnabled: false, exportCheckedAt: checkedAt}});
        for (const channel of selectExportChannels(channels)) {
            const data = {name: channel.name, exportEnabled: selected.has(channel.id),
                exportSince: since ?? null, exportCheckedAt: checkedAt};
            await database.category.upsert({where: {id: channel.id}, create: {id: channel.id, ...data}, update: data});
        }
    });
}
