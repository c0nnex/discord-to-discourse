import {expect, test} from "bun:test";
import {readNoExportRoleId, selectControlledChannels, saveChannelSelection} from "../export-control";

const role = "90071992547409990";
const neutral = {id: role, type: 0, allow: "0", deny: "0"};
const channels = [
    {id: "90071992547409920", name: "plain", type: 0},
    {id: "90071992547409921", name: "marked", type: 15, permission_overwrites: [neutral]},
    {id: "90071992547409922", name: "container", type: 4, permission_overwrites: [neutral]},
    {id: "90071992547409923", name: "child", type: 0, parent_id: "90071992547409922"},
    {id: "90071992547409924", name: "member-overwrite", type: 5, permission_overwrites: [{...neutral, type: 1}]},
];
test("NoExport role accepts only valid IDs; absent/empty config disables filtering", async () => {
    const db = (value?: string): any => ({exportControl: {findUnique: async () => value === undefined ? null : {value}}});
    expect(await readNoExportRoleId(db())).toBeUndefined();
    expect(await readNoExportRoleId(db(" "))).toBeUndefined();
    expect(await readNoExportRoleId(db(role))).toBe(role);
    for (const value of ["0", "-1", "1.5", "18446744073709551616", "role-name"]) {
        await expect(readNoExportRoleId(db(value))).rejects.toThrow();
    }
});
test("neutral role presence excludes channel and category children but not member overwrites", () => {
    const result = selectControlledChannels(channels, role);
    expect(result.selected.map(c => c.name)).toEqual(["plain", "member-overwrite"]);
    expect(result.excluded.map(c => c.name)).toEqual(["marked", "child"]);
    expect(selectControlledChannels(channels).selected).toHaveLength(4);
    expect(selectControlledChannels([{...channels[0], permission_overwrites: [{...neutral, allow: "1024"}]}], role).selected).toHaveLength(0);
});
test("selection snapshot disables historical absent/excluded channels without deleting content", async () => {
    const rows = new Map<string, any>([["old", {name: "old", exportEnabled: true}]]);
    const db: any = {category: {
        updateMany: async (q: any) => {for (const [id, row] of rows) rows.set(id, {...row, ...q.data});},
        upsert: async (q: any) => rows.set(q.where.id, {...rows.get(q.where.id), ...(rows.has(q.where.id) ? q.update : q.create)})}};
    db.$transaction = async (run: any) => run(db);
    const selected = selectControlledChannels(channels, role).selected.map(c => c.id);
    await saveChannelSelection(db, channels, selected, new Date("2024-01-01T00:00:00Z"));
    expect(rows.get("old").exportEnabled).toBe(false);
    expect(rows.get(channels[1].id).exportEnabled).toBe(false);
    expect(rows.get(channels[0].id).exportEnabled).toBe(true);
    expect(rows.get(channels[0].id).exportSince.toISOString()).toBe("2024-01-01T00:00:00.000Z");
});
