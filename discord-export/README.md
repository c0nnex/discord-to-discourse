# Discord forum and text channel data export script

## Create a Discord application

- Go to the Discord Developer portal and [create a new application](https://discord.com/developers/applications?new_application=true).
- On the Application's Bot tab, enable the Message Content Intent toggle.
- On the Application's OAuth2 tab, add the `bot` scope and the following permissions:
  - Manage Messages
  - Manage Threads
  - Read Message History
- Copy the generated URL and paste it into your browser to add the bot to your server.
- Copy the bot token and add it to your `.env` file.

## How to run the Discord export

- Define environment variables by copying `.env.template` to `.env` and filling in the values.
- Update the system and ensure bun is installed with `sudo apt update;sudo apt upgrade -y; sudo apt install npm -y`
- Ensure you have mysql installed with `sudo apt install mysql-server -y`
- Run `sudo mysql_secure_installation`
- login to mysql with `sudo mysql`
- Create the databes with: `CREATE database discord;`
- Create a new DB user with `CREATE USER 'username'@'%' IDENTIFIED BY 'Tricky-Password';
- Grand privileges: `GRANT ALL PRIVILEGES ON discord.* TO 'username'@'%';`
- Add those credentials to the .env file
- Then `sudo npm install -g bun`
- Install dependencies with `bun install`
- Run `npx prisma migrate dev` to create the database.
- Run `npx prisma generate` to generate the Prisma client for typed database access.
- Run the export with `bun run index.ts`


## Attachment sizes for an existing export

From `discord-export`, use the installed Prisma 5 CLI to apply the additive
migration and regenerate the client:

```sh
bun install --frozen-lockfile
bun run node_modules/prisma/build/index.js migrate deploy
bun run node_modules/prisma/build/index.js generate
bun run index.ts getattachmentSizes
```

Use the existing `DATABASE_URL`. This command does not export messages or anonymize
users, and it does not require Discord credentials. Do not reset the database or
edit the existing initial migration. The new migration adds nullable `size BIGINT`
to `Attachment`, preserving all existing rows; NULL means unknown and 0 means a
confirmed empty file. New message exports leave size NULL; CDN HEAD provides byte sizes.

`getattachmentSizes()` visits unknown sizes in batches of 100, makes sequential
HEAD requests (15-second timeout), and persists each successful Content-Length.
It accepts HTTPS Discord CDN/media URLs only and refuses redirects. It never
downloads file bodies as a fallback. Progress and a final `knownBytes` total are
printed; if any sizes remain unknown the command exits with code 2. Database or
other fatal errors exit with code 1.

A rerun skips known sizes and retries unknown ones. HTTP failures (including rate
limits), missing Content-Length and expired signed URLs remain unknown, not zero.
Do not interpret `knownBytes` as the complete total while `unknown` is nonzero.
The command does not refresh expired URLs: those require fetching the original
Discord message with an authorized bot. Signed URLs and their query parameters
are not logged. Do not run against a concurrently changing export when collecting
a final inventory total.

References: [Discord attachment size in bytes](https://docs.discord.com/developers/resources/message#attachment-object),
[expiring attachment URLs](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls).

Tests: `bun test`; type check: `bun run node_modules/typescript/bin/tsc --noEmit --incremental false --composite false`.

Size failures log the actual error name/message, nested cause and network error code
when available. HTTP failures include status and reason; missing and invalid
Content-Length are reported separately. URLs are redacted and messages kept to one
line. HEAD responses contain no body, so a browser GET message such as
"This content is no longer available." cannot be recovered from HEAD alone.
No extra GET or file download is performed for diagnostics.

## Repair truncated or expired attachment URLs

The original URL column was VARCHAR(191), too short for many signed Discord URLs.
The new additive migration widens it to TEXT without deleting records. Widening
alone cannot reconstruct truncated values. After applying migrations and generating
Prisma, run:

```sh
bun run index.ts refreshAttachments
```

This requires DATABASE_URL and DISCORD_BOT_TOKEN with access to the original
messages. It fetches each stored message with attachments once per run, matches
attachments by ID, and updates the URL and its CDN HEAD size together.
No file download, message export, anonymization or deletion occurs.
Discord REST rate-limit handling is provided by the existing discord.js REST client.

Only attachments with size = NULL are repaired. Messages without unknown sizes
are not fetched; known attachments in mixed messages remain unchanged. A rerun
retries only unresolved rows and performs no Discord calls once all sizes are known. Missing
source messages/files remain unchanged and are reported; exit code 2 means failures
or unknown sizes remain. Database failures stop the run. A refreshed signed URL
still expires later; this is not permanent attachment storage.

Keep existing rows. The full export skips existing messages, including their
attachments, so deleting attachment rows is not a repair workflow. Use the refresh
command to repair unknown metadata without re-exporting messages.



## Download attachment files into the database

Apply migrations and generate the client, then run from discord-export:

```sh
bun run node_modules/prisma/build/index.js migrate deploy
bun run node_modules/prisma/build/index.js generate
bun run index.ts downloadAttachments
```

Export stores attachment metadata with size NULL, never downloads bodies and never
copies the Discord API size. downloadAttachments obtains fresh URLs via the Discord
API, uses CDN HEAD only where size is NULL, and persists URL/size before GET.
Known sizes are reused. Missing sizes on existing blobs are measured without
downloading their bodies again. Known oversized rows require no source/CDN calls. refreshAttachments also uses CDN HEAD rather than API sizes
when repairing unknown sizes.

MAX_DOWNLOAD_SIZE is 10 * 1024 * 1024 bytes (10 MiB). Only files strictly below
this limit are downloaded. At or above it, files are counted as skipped and are
intended as links in the later Discourse import. Known sizes are retained on a rerun;
skips alone do not cause a failure exit code. Existing blobs are never removed.
Signed CDN URLs expire; durable link handling remains an importer task.

Five workers process HEAD, metadata update, GET and blob insertion concurrently.
Attachments in the same message share one source-message request per page.
Discord REST rate handling remains with the existing REST client. Individual
source/CDN failures remain pending. Database errors stop new work, drain in-flight
workers, then terminate the command. Only run one exporter/downloader per database.

GET bytes must match the HEAD size and GET Content-Length when present. Errors
include size values, HTTP status and selected response headers; signed URLs and
cookies are excluded. HEAD timeout is 15 seconds; GET timeout is 120 seconds.
Only HTTPS Discord CDN/media hosts are allowed; redirects are refused.

Files are buffered per worker; allow RAM for five simultaneous files plus driver
copies. MAX_ATTACHMENT_BYTES may impose a lower memory limit, but cannot raise the
10 MiB import policy. Database max_allowed_packet must accommodate each blob.

AttachmentBlob stores complete bytes, SHA-256 and a download timestamp, keyed by
attachment ID. A failed GET leaves its HEAD metadata but no blob. Blob insertion
is atomic. Back up this table together with export metadata. The Discourse importer
does not yet consume blobs or implement the oversized-link policy.

Exit codes: 0 completed (including policy skips), 2 unresolved source/download
failures, 1 fatal errors.

## Repeatable export

```sh
bun run index.ts export
```

The default command without arguments is the same export. Categories, topics,
messages, authors and attachment metadata use their Discord IDs. Existing messages
are skipped before any author or attachment changes. Existing author display names
remain unchanged; the existing anonymous-name behavior applies only to new authors.
New messages in existing threads are added. No edit/delete synchronization occurs.

The exporter uses persistent per-thread progress; see incremental export below.
Run one export/download/repair process per database.

Tests run with `bun test`. To additionally run the real persistence test, set
`ATTACHMENT_TEST_DATABASE_URL` to an isolated, migrated test database; it creates
synthetic fixtures and removes only those fixtures afterward.

## Incremental message export

Apply the additive TopicExportState migration and regenerate the client before
the next export:

```sh
bun run node_modules/prisma/build/index.js migrate deploy
bun run node_modules/prisma/build/index.js generate
bun run index.ts export
```

Each thread retains a completed message boundary plus the cursor/highest ID of an
unfinished backwards scan. Messages are saved before a page cursor advances.
Interrupted pages can replay safely because existing message IDs are ignored.
Snowflakes are compared numerically with BigInt, not floating point or text order.

An existing export has no trustworthy completed boundary: the first run after
this upgrade scans its history once and fills gaps without overwriting records.
Do not initialize the boundary from MAX(Post.id); a previously interrupted export
may have older holes. New threads likewise receive a full initial scan.

Subsequent runs query after the completed boundary. An unchanged thread requires
one empty message request. Larger batches paginate before the oldest message in
the current page until the previous boundary is reached, then probe for new
arrivals. No whole-history message scan is performed once a boundary exists.

Forum channel and active/public-archived thread discovery still runs each time;
archived thread listing remains paginated. This detects new/reopened threads.
The first message query per thread and discovery requests still cost time.
No production timing is claimed. Run one export process per database.

This is an append-only historical collection, not a complete current-state mirror:
edits, deletions, renamed entities and revoked access are not reconciled.
Existing content, names and blobs remain unchanged. Attachment downloads stay a
separate command. Any later AI use must preserve source access restrictions.

Source: [Discord Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)
documents newest-to-oldest results and mutually exclusive before/after cursors.

## Message references

See [reference export and historical backfill](../docs/message-reference-export.md) for the additive migration and the new backfillMessageReferences command.

## Text and announcement channels

The normal export includes Discord forum (15), text (0) and announcement (5)
channels. Each selected channel has a Category row. Text/announcement channels
also have one pseudo-Topic with `id = categoryId = Discord channel ID`, the
channel name as title and a stable creation date decoded from the Snowflake.
Direct channel messages are Posts in this topic; existing active and public
archived threads remain separate Topics. Channels need not contain any threads.
Voice, stage, category containers and media channels are not newly included.
Private archived thread discovery remains outside the existing exporter scope.

No schema migration is needed for this change. Run the usual `bun run index.ts`
after updating the exporter. New channels receive an initial complete history
scan; already exported topics retain their per-topic incremental state. Channel
and pseudo-topic names refresh on rerun without resetting timestamps or cursors.
The existing incremental export collects new messages, not edits or deletions
to older messages. Empty channels keep an empty pseudo-topic and a resumable cursor.

Attachments and message references use the same pipeline as forum posts. A
pseudo-topic ID is the actual channel ID, so later reference/attachment fetches
continue to address Discord correctly. Existing size/download commands still
need to run for newly exported attachments. View Channel, Read Message History
and appropriate Message Content access are required; request failures are not
reported as a successful complete export. Existing all-or-fail behavior remains.

This changes the export only. DiscourseBot currently selects forum channels for
provisioning/import and needs a separate scope/mapping extension before these
chat topics are migrated. A large chat channel may produce a very large target
topic; importer/platform limits must be evaluated before that separate change.

References: [Discord channel types](https://docs.discord.com/developers/resources/channel),
[Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages).

Older threads can omit `create_timestamp` (Discord only populates it for threads created after 2022-01-09). Active and archived thread export falls back to the Snowflake date when the creation timestamp is missing or invalid; archive time is not used as creation time.

## Tests

Exporter tests live in `tests/`. From `discord-export/`, run:

```bash
bun --no-env-file run test
bun --no-env-file run typecheck
```

These commands do not load local `.env` files. Unit tests use synthetic fixtures
and mocked requests. The two database tests
are skipped unless `ATTACHMENT_TEST_DATABASE_URL` points to an explicitly
prepared, disposable test database. Never use a live export database for tests.

## Embeds, exclusion role and UTC start date

Apply additive migrations and regenerate the Prisma client before using this
version. Stop processes using the same database during the schema upgrade:

```sh
bun run node_modules/prisma/build/index.js migrate deploy
bun run node_modules/prisma/build/index.js generate
bun run index.ts export --since 2024-01-01
```

`--since yyyy-mm-dd` includes messages from 00:00:00 UTC on that date. Omit it
for all history. Invalid dates and unsupported options fail before export.
The cutoff applies to message timestamps in all selected channel types and their
threads; old threads are still discovered because they may contain recent posts.
Changing or removing the cutoff starts a new resumable scan without deleting
previous posts or attachments. Replaying known IDs remains idempotent.

`ExportControl` stores key/value settings. Set `NoExportRoleId` to the decimal
ID of your exclusion role using your database client; the migration creates an
empty value, which disables filtering. Role names are irrelevant. A configured
invalid or missing guild role stops the export. No environment edit is required.

Presence of that role in a channel's permission overwrites excludes the channel,
even with both allow and deny equal to zero. Member-specific overwrites do not
count. A marker on a category also excludes its child channels. Excluded forum
channels include their threads. No Discord permissions are changed by the script.
Role/channel settings are fetched once at the beginning of each run; edits during
a run take effect on the next run.

`Category.exportEnabled`, `exportSince` and `exportCheckedAt` record the latest
selection. Existing content in excluded channels or before the cutoff is retained.
Selection is not proof of a completed export. Importers must explicitly honor this
metadata and the message cutoff; the existing Discourse importer is not adapted
by this change. Download/size/reference repair commands keep their existing scope.

`Post.embeds` preserves the full API embed array as JSON, including ordered fields,
inline flags, links and unknown nested properties. This applies to all authors and
to both mixed-text and embed-only messages. SQL NULL with a null
`embedsCheckedAt` means not captured; a captured empty array means the API returned
no embeds. Existing message bodies, authors and attachments remain unchanged.
Embed media URLs are stored as received, not downloaded into AttachmentBlob.
Rendering these embeds is a separate importer task.

Completed incremental cursors do not revisit historical messages. To capture
embeds for previously stored posts, run separately:

```sh
bun run index.ts backfillEmbeds --since 2024-01-01
```

The optional date has the same UTC meaning; omit it for all stored history in
currently selected channels. The command checks the exclusion role again, fetches
only posts without captured embeds, and leaves the export selection snapshot
unchanged. Source failures remain pending and yield exit code 2; database failures
abort. A rerun skips captured posts. Normal export also fills missing embeds if a
legacy post is encountered during a replay. Neither path refreshes already
captured embeds after subsequent Discord edits.

Discord Message Content access is required. The API can return empty content,
embeds and attachments without it; an empty array alone cannot establish that the
original visible message had no embeds. This stores the API embed representation,
not every possible Discord message property or a complete current-state mirror.
See [Discord Message Object](https://docs.discord.com/developers/resources/message#message-object).

## Single-channel export and persistent channel start dates

```sh
bun run index.ts export --channel-id CHANNEL_ID --since 2024-06-01
bun run index.ts backfillEmbeds --channel-id CHANNEL_ID
bun run index.ts export
```

Replace CHANNEL_ID with the decimal ID of an exportable text, announcement or
forum channel, not a thread. NoExport role exclusions still apply; an excluded,
inaccessible or unsupported requested channel fails before data changes.

A single-channel **export** with --since saves `ChannelStartDate:<channel ID>` in
ExportControl. Normal exports and embed backfills keep this UTC lower boundary,
including when --since is omitted. A global --since can narrow the run further
but does not replace a pinned channel date. To change a pinned date, explicitly
export that channel with its new --since; removing/emptying the database setting
restores unrestricted history on a subsequent export without --since.

Backfill options never modify the pinned setting. Single-channel exports update
only that channel's selection snapshot; other channel flags/dates remain intact.
No additional schema migration is needed. This supersedes the earlier statement
that omitting --since always selects all history: that remains true only for
channels without a pinned date. Four weeks means a concrete calendar date chosen
by the operator, not a sliding window that changes on every run.
