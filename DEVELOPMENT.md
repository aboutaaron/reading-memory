# Development

This file covers manual wiring, local development, API examples, deployment, backups, validation, and trace inspection.

For the service boundary, security model, storage shape, and analyzer integration rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Manual Agent Wiring

Reading Memory is useful only when another local agent knows when to call it. The provided `use-reading-memory` skill is the recommended path, but the integration contract is intentionally small: give the agent the base URL, bearer token, and a rule for when to persist reading material.

For an agent running on the same machine, expose:

```bash
READING_MEMORY_URL=http://127.0.0.1:4727
READING_API_TOKEN=<same token used by the service>
```

If you are not using the provided skill, add an instruction like this to the agent's system prompt, project instructions, or local skill:

```text
Use Reading Memory for durable reading recall.

When the user shares an article, paper, newsletter, post, PDF URL, or substantial excerpt that is likely to matter later, call POST /ingest on READING_MEMORY_URL with bearer auth from READING_API_TOKEN.

Do not ingest every link. Ingest only material with durable value: useful evidence, strong relevance to configured themes, research value, or likely future synthesis value.

Use POST /query when answering questions that may depend on previously stored reading.

Search before ingesting when the source title, URL topic, or core claim is available. If `/query` finds a clear existing item, use it as evidence instead of creating a redundant memory. If the new source adds a materially new angle, ingest it and use `dedupe_status` plus `related_items` as merge/link hints in the calling workflow.

Use POST /brief-guide when preparing a digest, morning brief, or reading roundup.

After finalizing a digest or brief, use POST /brief-events to record which stored items were included or skipped. This records corpus state only; it does not send or write the brief.

Reading Memory never replies to the user directly. The calling agent owns final presentation.
```

Authenticated POST error responses echo a valid UUID `request_id` from the parsed JSON body, including when other fields fail validation. Invalid or missing body IDs, malformed JSON, and errors before body parsing use `X-Request-ID` when supplied, otherwise `null`. Authentication runs before body parsing.

Minimal `POST /ingest` body:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "source_type": "url",
  "source": {
    "url": "https://example.com/article"
  },
  "source_context": "user_shared_link",
  "ingest_reason": "future_reference"
}
```

Minimal `POST /query` body:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000002",
  "query": "what has been saved about agent memory?",
  "top_k": 5
}
```

Minimal `POST /brief-guide` body:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000003",
  "brief_date": "2026-05-05",
  "lookback_hours": 168,
  "focus": ["agent infrastructure", "evaluation", "semantic layers"]
}
```

Minimal `POST /brief-events` body:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000004",
  "events": [
    {
      "item_id": "item_...",
      "brief_date": "2026-05-05",
      "event_kind": "included",
      "included_bool": true,
      "rationale": "Used as a receipt in the morning brief",
      "source_context": "morning_brief"
    }
  ]
}
```

## Local Development

```bash
cd reading-memory
npm install
READING_API_TOKEN=dev-secret READING_API_DB=/tmp/reading.sqlite npm run dev
```

## Environment

- `READING_API_TOKEN`: required bearer token.
- `READING_API_HOST`: defaults to `127.0.0.1`.
- `READING_API_PORT`: defaults to `4727`.
- `READING_API_DATA_DIR`: defaults to `~/.reading-api`.
- `READING_API_DB`: defaults to `~/.reading-api/reading.sqlite`.
- `READING_API_BACKUP_DIR`: defaults to `~/backups/reading-memory`.
- `READING_API_MODEL`: concrete OpenAI ID or `openai/<id>` / `anthropic/<id>`; defaults to `gpt-5.6-luna`. `READING_API_FLUE_MODEL` remains a lower-priority compatibility alias.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`: required for the selected provider. `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` override the SDK base URL. Only OpenAI and Anthropic are supported.
- `READING_API_FLUE_TRACE_PATH`: defaults to `<READING_API_DATA_DIR>/flue-events.jsonl`; set to `off` to disable local analysis tracing.

Production secret file:

```bash
install -d -m 700 ~/.reading-api
printf 'READING_API_TOKEN=%s\n' '<token>' > ~/.reading-api/env
chmod 600 ~/.reading-api/env
```

For local development, copy `.env.example` and override only the values you need. Do not commit real tokens.

## API

`POST /ingest` uses `source_type` as its sole discriminator: `text` requires `source.text`, while `url` and `pdf_url` require `source.url`. All accept optional `source.title`. A legacy nested `source.type` is accepted only when it agrees with `source_type`, then discarded during validation. Existing idempotency hashes remain compatible, so an equivalent request replays across this contract update. Callers should omit the nested type. This document and `src/api/contracts.ts` define request shapes; `/capabilities` advertises supported operations and limits.

All non-health endpoints require:

```text
Authorization: Bearer <READING_API_TOKEN>
```

Examples:

```bash
curl -s http://127.0.0.1:4727/health | jq
curl -s -H "Authorization: Bearer $READING_API_TOKEN" http://127.0.0.1:4727/capabilities | jq
curl -s -X POST http://127.0.0.1:4727/ingest \
  -H "Authorization: Bearer $READING_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"request_id":"00000000-0000-4000-8000-000000000001","source_type":"text","source":{"text":"Agent memory needs durable recall.","title":"Note"}}' | jq
```

Supported source types: `url`, `text`, `pdf_url`. URL and PDF ingestion require HTTPS. Every request and redirect resolves its host once, rejects non-public results, and pins its socket to a validated address while preserving the original TLS identity and HTTP Host. Loopback names, private/mapped addresses, credentials in URLs, unsupported MIME types, and oversized bodies are blocked. See [URL fetching](docs/URL-FETCHING.md) for the network contract and regression tests.

`POST /brief-events` is idempotent by `request_id` and guarded against equivalent duplicate events for the same item/date/kind/source context.

### Usage feedback

`POST /brief-events` also accepts `event_kind: "cited"` with `included_bool: true`. Record this only after a source contributed to a finalized answer. Use `brief_date` for the UTC date of use. Every `cited` event requires a nonblank `source_context` containing a stable answer ID: use a different ID for each distinct answer and reuse it for retries. Other brief event kinds keep `source_context` optional. Include a rationale identifying the supported claim. A `cited` event cannot set `resurface_after`; it neither consumes a brief appearance nor clears or creates a schedule. Use a regular brief event for scheduling. Do not double-record a brief inclusion as a citation for the same use.

`POST /query` accepts optional `mode: "fts"` (default) or `"fts+usage"`; `/capabilities.query_modes` advertises both. Both modes retain lexical matching, AND/OR fallback, filters, and empty-result abstention. Queries never write usage events. Usage adjustment applies before the result limit, so a frequently useful match can rank ahead of an otherwise equal match anywhere in the filtered corpus.

In usage mode, `results[].usage` exposes `lexical_score`, `usage_count`, `last_used_at`, `skipped_count`, `boost`, `unused_decay`, and `multiplier`. The final `score` is `lexical_score * multiplier`. Each `included` or `cited` event contributes +1 and each `skipped` event contributes -1, weighted by `1 / (1 + age_in_days / 30)` from its event date. Resurfaced events remain brief lifecycle records and do not contribute to this score. The bounded boost is `0.2 * balance / (1 + abs(balance))`. With no positive use, a latest relevance score below 0.35 adds a decay of zero through day 30 after ingestion, rising linearly to 0.1 by day 90. Missing relevance does not justify decay. Multipliers remain between 0.7 and 1.2. No amount of use can produce a result without a lexical match.

`GET /items/:id` includes `usage_count` (number of distinct stored included/cited events) and `last_used_at` (the latest positive event's recorded `created_at`, or null). Neither field estimates unrecorded use. Future event dates and records created after the as-of clock are excluded. Event counts, timestamps, and adjusted scores describe reported use, not reader agreement or calibrated answer confidence.

After three consecutive distinct skipped brief dates, `/brief-guide` demotes an otherwise eligible item and exposes `effective_confidence` at half its original `confidence`, with `consecutive_skips` and an explanation. Multiple skipped contexts on the same day count once; an included/resurfaced date interrupts the streak. Cited events do not affect the streak. An explicit due schedule overrides the demotion. Original analysis data remains unchanged.

### Operational activity

Use authenticated `GET /activity` to inspect recent operational history, such as ingestion outcomes and annotation creation, while debugging. Reading recall and evidence retrieval belong to `POST /query`; activity events are operational metadata, not semantic search results.

```bash
curl -s -H "Authorization: Bearer $READING_API_TOKEN" http://127.0.0.1:4727/activity | jq
```

The standard response envelope contains a `data` array of up to 50 events ordered by `created_at` descending. Each event exposes `id`, `type`, `principal`, `request_id`, `item_id`, `metadata_json`, and `created_at`. `principal` identifies the authenticated token by its fingerprint, and `metadata_json` is a JSON-encoded string of event-specific metadata. The endpoint has no pagination or filtering controls and is not a complete HTTP request log.

### Reader annotations

`POST /items/:id/annotations` uses bearer authentication and a separate allowance of 30 annotation writes per minute. These writes do not consume the 10-per-minute ingestion allowance, and ingestion does not consume annotation capacity. `/capabilities.rate_limits.annotation_per_minute` exposes this limit. Use a fresh UUID for each operation and reuse it only for the same retry:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000031",
  "actor_type": "user",
  "actor": "Aaron",
  "note": "This assumes clean data contracts. I am not convinced it covers our exception cases.",
  "project": "Analytics verification",
  "question": "When should conflicting evidence require human review?"
}
```

The response contains `annotation` and `dedupe_status`. Notes preserve original whitespace and words. `actor_type` is `user` or `agent`; do not attribute an agent inference to a user. Limits are actor 120, note 4,000, project 200, and question 1,000 characters. Optional fields must contain meaningful text when supplied.

To correct a note, create a new annotation with `supersedes_annotation_id` pointing to its active predecessor on the same item. History remains available through `GET /items/:id` as `reader_annotations`, with an `active` flag. Only active notes, projects, and questions contribute to the search index. A second competing correction returns a conflict rather than silently overwriting history. An annotation write does not reanalyze the source; subsequent ingests can use it as prior reading context.

`source_context` and `ingest_reason` on ingest are preserved as provenance and supplied in bounded form to analysis. An exact duplicate capture retains its existing analysis/provenance; use an explicit annotation to record a new reason or reaction to that existing item.

### Title maintenance

`npm run backfill:titles -- --db /path/to/reading.sqlite` previews titles inferred only from explicit stored Markdown/setext headings. It opens the database read-only and never refetches sources. After reviewing proposals and backing up an upgraded database, add `--apply` to persist inferred titles and rebuild the affected search entries. Plain first sentences remain untitled; they are not reliable title evidence. Provenance records that a backfilled title was inferred from stored text.

### Retrieval and brief compatibility

`GET /items/:id` omits `extracted_text` by default. Metadata, `truncated`, `analysis.reason`, annotation history, and relationship quotations remain available in the default response. Use `GET /items/:id?include=text` to opt into the retained source text (up to 100,000 characters); `truncated` still describes truncation at ingestion, not response pagination. The only supported include value is a single `include=text` parameter.

Query results retain `answer: ''` and return `confidence: null` for nonempty results (`0` for empty results). These are compatibility fields, not generated answers or calibrated retrieval confidence. Read `retrieval_hint`, `search_terms`, `match_strategy`, `results[].matched_terms`, snippets, and citations. A partial-term fallback requires inspection before synthesis.

Brief `brief_date` is a valid calendar date in UTC. The lookback ends at the next midnight, and future items/analyses are excluded. Events use their recorded business `brief_date`; this supports recording the outcome of an earlier brief. Due schedules are considered outside the normal lookback. The service selects up to eight eligible items before returning up to ten skip explanations. This does not send a brief or schedule delivery.

Both `included` and `resurfaced` now count as consumption. Recording `resurfaced` without a new future `resurface_after` suppresses the item indefinitely from subsequent briefs until a later event schedules another appearance. To allow another appearance, supply a future `resurface_after` on the consumption event or record a later scheduling event. A later `skipped` event without a schedule does not undo consumption. This changes the previous behavior in which resurfaced items could repeat immediately.

## Deploy On A VPS

```bash
cd ~/reading-memory
npm ci
npm run build
install -d -m 700 ~/.reading-api ~/backups/reading-memory
mkdir -p ~/.config/systemd/user
cp systemd/reading-memory.service ~/.config/systemd/user/
cp systemd/reading-memory-backup.service systemd/reading-memory-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now reading-memory.service
systemctl --user enable --now reading-memory-backup.timer
systemctl --user status reading-memory.service
```

The unit binds to loopback and stores data outside the git checkout at `~/.reading-api/reading.sqlite`. Both service and backup units use `UMask=0077`; the checkout remains read-only to the service. The only writable sandbox exceptions are the dedicated data and backup directories. Create those directories before starting systemd, and run setup and maintenance as the same ordinary user that runs the service. Custom data/backup paths require matching unit overrides.

Direct API startup also sets a private umask. Database opens and maintenance enforce mode 0700 on the configured app-owned leaf directories and mode 0600 on the database, SQLite sidecars, backups, and safety snapshots. Choose dedicated directories: shared roots such as the home directory, temporary root, and checkout itself are rejected. Existing ancestors are never recursively chmodded. Final directory symlinks, file symlinks, hard-linked files, and paths owned by another user are rejected instead of modifying their targets.

Repository tests verify these file modes, committed WAL capture, backup integrity, atomic restore and rollback, and service-unit settings using temporary directories and mocked service commands. They do not establish that a particular host is ready. On the deployment host, separately verify loopback binding and firewall rules, available disk space, effective systemd sandbox settings and paths, the backup timer's last successful run, and a restore drill into a disposable database. Keep production stopped if restore and rollback both fail; inspect the retained safety snapshot before restarting.

Before storing real reading material on each deployment, verify the host itself: confirm deny-by-default firewall rules with required SSH access retained, at least 15 GB of free disk space, an authenticated localhost smoke request, and a listener restricted to `127.0.0.1`. Run a backup and restore drill on disposable data and check file ownership and permissions. Repository tests do not certify a host's firewall, storage or service installation.

Choose operational retention explicitly: backups retain 30 days by default; configure journald limits for service logs and rotate local JSONL traces according to the host's retention policy. Keep logs and traces private. Probe `/health` from a local monitor and alert when `ready` is false or disk/backup warnings appear. To rotate the bearer token, update the private environment file, restart the service, and update the local caller's secret; never put the token in logs or issue reports.

## Backup And Restore

Daily backup command:

```bash
READING_API_DB=~/.reading-api/reading.sqlite READING_API_BACKUP_DIR=~/backups/reading-memory ./scripts/backup-sqlite.sh
```

Backups are created privately, checked with `PRAGMA integrity_check`, and published atomically without overwriting an existing destination. They include committed WAL state and emit a JSON report containing source, destination, size, and integrity status. Thirty-day retention applies only to matching files directly inside the configured backup directory.

The deployed user timer runs the same script daily:

```bash
systemctl --user list-timers reading-memory-backup.timer
systemctl --user start reading-memory-backup.service
```

Restore drill:

```bash
# Restore from the newest backup. Pass an explicit path to restore from
# a specific timestamp.
./scripts/restore-from-backup.sh
./scripts/restore-from-backup.sh ~/backups/reading-memory/reading-20260601T032000Z.sqlite
```

The script sources `~/.reading-api/env`, detects the runner (systemd user unit or macOS LaunchAgent), stops the service, takes a private timestamped safety snapshot of the current db (`reading.sqlite.before-restore-<UTC>-<id>`), clears stale sidecars, atomically replaces `READING_API_DB` with a private copy of the backup, runs `PRAGMA integrity_check`, and restarts the service. If integrity fails it restores and verifies the safety snapshot automatically. If rollback also fails, it leaves the service stopped and reports the safety path. Delete the safety copy by hand once you're confident the restored db is good.

If you'd rather run the restore by hand:

```bash
# stop the service the same way your deployment does
systemctl --user stop reading-memory.service     # systemd
launchctl bootout gui/$(id -u)/com.aboutaaron.reading-memory   # launchd

# use the same private snapshot/atomic replacement/integrity/rollback helper
node scripts/restore-sqlite.mjs ~/backups/reading-memory/reading-YYYYMMDDTHHMMSSZ.sqlite ~/.reading-api/reading.sqlite

# restart only after a successful restore or verified rollback
systemctl --user start reading-memory.service     # systemd
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aboutaaron.reading-memory.plist   # launchd
```

## Validation

```bash
npm test
npm run build
npm run eval:reading
READING_API_TOKEN=<token> npm run smoke
curl -s http://127.0.0.1:4727/health | jq
ss -ltnp | grep 4727
```

Expected healthy signals:

- `/health` returns `ready: true`, `db: "ok"`, and disk warning is false before production use.
- `ss` shows `127.0.0.1:4727`, not `0.0.0.0`.
- `journalctl --user -u reading-memory.service` contains metadata events only, not request bodies or extracted text.
- `npm run eval:reading` passes before ranking, dedupe, or brief-guide changes are accepted. Its analyses are canned; model changes additionally require reviewed live-model evaluation.

Before a release first starts, stop the service and run `./scripts/backup-sqlite.sh` with the service's database environment. Record the previous release commit, the explicit backup path, and its `PRAGMA user_version`; verify the snapshot with `PRAGMA integrity_check`. Retain this pre-upgrade snapshot outside the daily backup's 30-day rotation for as long as rollback is needed. The SQLite backup captures committed WAL state; a plain copy of a live database does not.

Rollback across a schema upgrade requires restoring that pre-upgrade snapshot. Schema v5 and later cannot be opened by the v4 service: checking out old code alone leaves startup failing. Stop the service and preserve a separate verified snapshot of the upgraded database before changing code. Then build the previous release and restore the explicit compatible backup before restarting:

```bash
systemctl --user stop reading-memory.service
git -C ~/reading-memory checkout <previous-release>
cd ~/reading-memory && npm ci && npm run build
./scripts/restore-from-backup.sh /absolute/path/to/pre-upgrade.sqlite
```

The restore script restarts the installed runner only after restoration. Use the corresponding LaunchAgent stop command on macOS. Do not restart newer code after restoring the old snapshot, because it would migrate the database again. Verify `/health` and an authenticated smoke request after rollback. Restoring a pre-upgrade snapshot discards subsequent writes from the active corpus; retain the separate upgraded snapshot for recovery. If no compatible pre-upgrade snapshot exists, keep the newer service version and repair forward rather than lowering `user_version` by hand. A checkout-only rollback is appropriate only when both releases support the existing schema.

Migration failure behavior: migrations run inside a transaction and use `PRAGMA user_version`. If migration fails, startup fails before serving traffic and leaves the prior DB state intact. Successful migrations are not automatically downgraded by a later checkout.

## Request outcome logging

Every completed HTTP response emits one `reading-api.request` JSON event to stdout. Events contain only the normalized HTTP method, a route template (for example `/items/:itemId`), status, allowlisted error code, and elapsed milliseconds measured with a monotonic clock. Unknown paths and methods become `unmatched` and `OTHER`. The event contains no URL query, item ID, request ID, headers, credentials, body, source text, reader note, email address, or error message.

Embedded callers can pass `requestLogger` to `createReadingApi` to collect these typed events, or `null` to disable them. Logger failures do not change responses. These events describe completed responses; they are not a durable audit ledger or client-disconnect telemetry.

`GET /health` intentionally requires no bearer token, including when no token is configured, so local service readiness can be diagnosed. All other routes require bearer authentication. This assumes a loopback-only listener and the existing Host-header check; do not expose the service publicly. Token checks hash both values to fixed-size SHA-256 digests before `timingSafeEqual`, without a token-length comparison shortcut.

## Inspect Analysis Activity


Analysis traces are local JSONL files. They record item/session ids, timing, provider name, token counts, title/text lengths and hashes, and numeric judgment metadata. They do not store credentials, raw titles, source text, model output, or model-generated theme strings. The legacy trace filename is retained so existing installations and inspection commands keep working.

```bash
cd reading-memory
npm run traces -- --latest 10
npm run traces -- --latest 3 --json
```

The deployed default path is:

```text
~/.reading-api/flue-events.jsonl
```

Reading Memory sends one bounded structured request through an official provider SDK. SDK retries are disabled, cancellation reaches the provider, incomplete/refused/invalid outputs fail analysis, and no conversation state is stored. Schema v4 omits the unused `sessions` table in new databases and removes it on upgrade only when empty. Nonempty legacy tables and their rows are preserved; the current analyzer does not read or write them. Analyzer health checks local credentials and provider configuration without network calls; valid configuration is not proof of live provider access.

### Forget an item

`DELETE /items/:id` requires bearer authentication and shares the ingest rate limit. It accepts no body or query parameters. It deletes canonical item content, analysis history, tags, relationships, reader notes, brief events, and FTS in one transaction; newer items' `supersedes_item_id` references become null. Active analysis returns 409 `ANALYSIS_IN_PROGRESS`; a missing item returns 404. Success returns `{item_id, deleted: true}`. The activity log retains only the content hash and operational identifiers, never a free-form reason.

Idempotency snapshots containing the item (including other items' connection evidence and multi-item brief batches) become content-free tombstones. Request IDs from failed or interrupted ingest attempts are also recovered from their durable start events and retired. These tombstones do not expire with ordinary successful-response caching. Their original request IDs return 410 `ITEM_FORGOTTEN`, preventing accidental replay or recapture. A fresh intentional capture uses a new request ID and logs `ingest.previously_forgotten`. Forgetting does not rewrite separate backup files.


### Refresh stored analysis

`POST /items/:id/reanalyze` accepts exactly `{request_id: UUID}` behind bearer authentication, shares the ingest rate limit, and has the same 60-second response budget. It analyzes stored text with the original caller context and current reader notes; it never fetches the source URL again. Success uses the ingest response shape with `dedupe_status: "reanalyzed"`. Retrying a completed request ID replays that response; request IDs remain shared across ingestion, reanalysis, annotations, and brief events.

Reanalysis preserves the item ID, capture time, source, provenance, reader notes, and brief history. It retains all earlier analysis rows and atomically replaces current tags, outgoing model relationships, heuristic relationships, and FTS. Incoming model relationships remain valid because the cited source text has not changed. Existing query and brief results remain available while the new judgment is running. A failed attempt leaves the previous judgment intact. Concurrent reanalysis, duplicate ingestion, or forgetting the item returns `ANALYSIS_IN_PROGRESS`; schema v5 leases permit recovery after a process crash and prevent a late attempt from overwriting its successor.

`/health` includes `analysis.current_version`, `analysis.current_model`, and `analysis.stale_items`. Authenticated `GET /items?stale=true&limit=25` returns metadata for up to 100 indexed items whose latest analysis version or model differs from the service. Prompt or relationship-rule changes must bump `READING_ANALYSIS_VERSION`; changing the configured model also marks earlier results stale.

Run `npm run reanalyze -- --stale --limit 25` with the service's `READING_API_TOKEN`, host, and port configuration after an upgrade. The maintenance command processes one bounded batch through the loopback API, waits six seconds between items, and retries transient failures up to three times with the same request ID and exponential backoff (honoring retry delays up to 60 seconds). It prints item IDs and completion counts only and exits unsuccessfully if any item fails. Re-run for another batch after inspecting failures.

### Hybrid index maintenance

Schema v7 adds canonical embedding projections linked to the current analysis. `item_vec` is a derived sqlite-vec index and is rebuilt at startup. `GET /items/:id` exposes `embedding_status` and `embedding_model`, without vectors. Hybrid requests and ingestion fall back safely when embedding work is unavailable; inspect the response's `retrieval_mode` and `fallback_reason`. Full configuration and dry-run/apply commands are in [Hybrid retrieval](docs/HYBRID-RETRIEVAL.md).
