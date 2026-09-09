# Message references for historical migration

Newly exported posts now store the source message type, reference type and optional
target message/channel/guild IDs. IDs remain strings and target IDs have no foreign
keys: referenced content may be deleted or outside the export.

The nullable referenceCheckedAt timestamp distinguishes legacy unchecked posts from
successfully inspected posts with no reference. referencedMessageDeleted is true
only when Discord explicitly returns referenced_message: null; omitted means
unknown, and an included object means present at inspection. No referenced body
is copied or recursively fetched. Reference type defaults to 0 when a reference
object omits it; forwarding type 1 is retained separately. A reference is not
automatically a reply: importers must also inspect messageType (19 for replies).

## Operator rollout

These commands change the schema and export metadata; execute only after
deployment approval, from the discord-export directory on the updated spad
checkout:

    bunx prisma migrate deploy
    bunx prisma generate
    bun run index.ts backfillMessageReferences

The additive migration preserves existing posts and attachments. New exports
populate metadata atomically with the post. Existing posts remain immutable under
normal export; run the explicit backfill for historical content.

Backfill uses one Discord source-message request per unchecked stored post, in
batches of 100 database rows. Discord REST handles rate limits. Successful rows are
persisted immediately and skipped on restart, including messages without references.
404/access/network failures remain unchecked and retry on the next invocation.
They are not interpreted as no reference. Independent messages continue; database
write failures stop the command. Exit code 2 indicates failed or remaining rows.
Run one exporter/backfill per database.

The backfill only updates reference metadata and message type. It does not change
text, authors, timestamps, attachments, blobs or incremental export cursors.
It captures reference metadata available now; deleted source messages cannot be
recovered by this operation.

Discourse reply restoration is a later import step using persistent source/target
post mappings. Missing targets must remain explicit unresolved links/attribution;
forwarded messages, crossposts and thread starters must not be treated as replies.

Source: https://docs.discord.com/developers/resources/message#message-reference-structure

## Validation

Prisma Client generation and TypeScript check passed. All 26 tests passed with
164 assertions, including MariaDB persistence tests. Applying the additive SQL
migration to a synthetic legacy post preserved its body and left reference metadata
unchecked. Pagination, retry/resume, source identity mismatch, database failure,
large Snowflakes and preservation of existing post/attachment data were covered.
No migration, backfill or real Discord fetch was executed against the live export
database.
