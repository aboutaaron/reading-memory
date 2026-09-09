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
mkdir -p ~/.config/systemd/user
cp systemd/reading-memory.service ~/.config/systemd/user/
cp systemd/reading-memory-backup.service systemd/reading-memory-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now reading-memory.service
systemctl --user enable --now reading-memory-backup.timer
systemctl --user status reading-memory.service
```

The unit binds to loopback and stores data outside the git checkout at `~/.reading-api/reading.sqlite`.

Before storing real reading material on each deployment, verify the host itself: confirm deny-by-default firewall rules with required SSH access retained, at least 15 GB of free disk space, an authenticated localhost smoke request, and a listener restricted to `127.0.0.1`. Run a backup and restore drill on disposable data and check file ownership and permissions. Repository tests do not certify a host's firewall, storage or service installation.

Choose operational retention explicitly: backups retain 30 days by default; configure journald limits for service logs and rotate local JSONL traces according to the host's retention policy. Keep logs and traces private. Probe `/health` from a local monitor and alert when `ready` is false or disk/backup warnings appear. To rotate the bearer token, update the private environment file, restart the service, and update the local caller's secret; never put the token in logs or issue reports.

## Backup And Restore

Daily backup command:

```bash
READING_API_DB=~/.reading-api/reading.sqlite READING_API_BACKUP_DIR=~/backups/reading-memory ./scripts/backup-sqlite.sh
```

Backups are written with private permissions and emit a JSON report containing source, destination, size, and integrity status.

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

The script sources `~/.reading-api/env`, detects the runner (systemd user unit or macOS LaunchAgent), stops the service, takes a timestamped safety copy of the current db (`reading.sqlite.before-restore-<UTC>`), clears stale WAL/SHM sidecars, copies the chosen backup over `READING_API_DB`, runs `PRAGMA integrity_check`, and restarts the service. If integrity fails it rolls back to the safety copy automatically. Delete the safety copy by hand once you're confident the restored db is good.

If you'd rather run the restore by hand:

```bash
# stop the service the same way your deployment does
systemctl --user stop reading-memory.service     # systemd
launchctl bootout gui/$(id -u)/com.aboutaaron.reading-memory   # launchd

# clear stale sidecars before swapping the .sqlite, otherwise SQLite
# will see a mismatched WAL/SHM and report "malformed".
rm -f ~/.reading-api/reading.sqlite-wal ~/.reading-api/reading.sqlite-shm
cp ~/backups/reading-memory/reading-YYYYMMDDTHHMMSSZ.sqlite ~/.reading-api/reading.sqlite

# verify and restart
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA integrity_check').get()); db.close();" ~/.reading-api/reading.sqlite
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

Rollback:

```bash
systemctl --user stop reading-memory.service
git -C ~/reading-memory checkout <previous-release>
cd ~/reading-memory && npm ci && npm run build
systemctl --user start reading-memory.service
```

Migration failure behavior: migrations run inside a transaction and use `PRAGMA user_version`. If migration fails, startup fails before serving traffic and leaves the prior DB state intact.

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
