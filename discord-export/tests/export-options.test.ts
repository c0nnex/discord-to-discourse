import {expect, test} from "bun:test";
import {parseExportOptions, parseStartDate, startBoundary} from "../export-options";
import {exportTopic} from "../incremental-export";
import type {APIMessage} from "@discordjs/core";

test("CLI accepts strict UTC dates, defaults to all history and rejects ignored options", () => {
    expect(parseExportOptions([])).toEqual({command: "export", since: undefined});
    expect(parseExportOptions(["--since", "2024-02-29"]).since?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseExportOptions(["backfillEmbeds", "--since", "2024-02-29"]).command).toBe("backfillEmbeds");
    for (const date of ["2023-02-29", "2024-04-31", "2024-1-01", "2024-01-01T12:00:00Z", "garbage"]) {
        expect(() => parseStartDate(date)).toThrow();
    }
    for (const args of [["downloadAttachments", "--since", "2024-01-01"], ["export", "--since"],
        ["export", "--other", "x"], ["unknown"], ["--since", "2024-01-01", "extra"]]) {
        expect(() => parseExportOptions(args)).toThrow();
    }
});

test("inclusive midnight survives range changes, interrupted scans and exact page boundaries", async () => {
    const since = parseStartDate("2024-01-01");
    const floor = BigInt(startBoundary(since));
    const messages = Array.from({length: 203}, (_, i) => ({id: String(floor - 1n + BigInt(i)),
        timestamp: new Date(since.getTime() + (i < 2 ? -1 : 0)).toISOString()} as APIMessage));
    let state: any = {lastMessageId: "0", exportFromId: "0", scanBeforeId: null, scanHighId: null};
    const stored = new Set<string>();
    const db: any = {topicExportState: {
        upsert: async () => ({...state}), update: async (q: any) => (state = {...state, ...q.data})}};
    const get = async (_: string, q: any) => messages.filter(m => (!q.after || BigInt(m.id) > BigInt(q.after)) &&
        (!q.before || BigInt(m.id) < BigInt(q.before))).slice(-100).reverse();
    let count = 0;
    const save = async (_: any, m: APIMessage) => {if (stored.has(m.id)) return false; stored.add(m.id); return true;};
    await expect(exportTopic(db, "synthetic-topic", get, () => "", async (p, m) => {
        if (++count === 120) throw new Error("interrupted"); return save(p, m);
    }, since)).rejects.toThrow("interrupted");
    await exportTopic(db, "synthetic-topic", get, () => "", save, since);
    expect(stored.size).toBe(201);
    expect(stored.has(String(floor + 1n))).toBe(true);
    expect((await exportTopic(db, "synthetic-topic", get, () => "", save, since)).requests).toBe(1);
    await exportTopic(db, "synthetic-topic", get, () => "", save);
    expect(stored.size).toBe(203);
    expect(state.exportFromId).toBe("0");
    const future = parseStartDate("2025-01-01");
    expect((await exportTopic(db, "synthetic-topic", get, () => "", save, future)).added).toBe(0);
    expect(stored.size).toBe(203);
});
