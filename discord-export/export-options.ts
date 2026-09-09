const commands = ["export", "backfillEmbeds", "backfillMessageReferences", "getattachmentSizes", "refreshAttachments", "downloadAttachments"] as const;
export type ExportCommand = typeof commands[number];

export function parseStartDate(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error("--since must be a date in yyyy-mm-dd format (00:00 UTC)");
    }
    const date = new Date(value + "T00:00:00.000Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error("--since is not a valid calendar date");
    }
    return date;
}

export function parseExportOptions(args: readonly string[]) {
    let command: ExportCommand = "export";
    let offset = 0;
    if (args[0] && !args[0].startsWith("--")) {
        if (!(commands as readonly string[]).includes(args[0])) throw new Error("Unknown command");
        command = args[0] as ExportCommand;
        offset = 1;
    }
    let since: Date | undefined;
    if (args.length > offset) {
        if (args.length !== offset + 2 || args[offset] !== "--since" || !["export", "backfillEmbeds"].includes(command)) {
            throw new Error("Only export and backfillEmbeds accept --since yyyy-mm-dd");
        }
        since = parseStartDate(args[offset + 1]);
    }
    return {command, since};
}

// Discord's after boundary is exclusive; include every Snowflake at midnight.
export function startBoundary(since?: Date): string {
    if (!since) return "0";
    const elapsed = since.getTime() - 1420070400000;
    if (!Number.isSafeInteger(elapsed)) throw new Error("Invalid start date");
    return elapsed <= 0 ? "0" : ((BigInt(elapsed) << 22n) - 1n).toString();
}
