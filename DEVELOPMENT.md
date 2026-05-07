# Development

This file covers manual wiring, local development, API examples, deployment, backups, validation, and trace inspection.

For the service boundary, security model, storage shape, and Flue integration rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

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

Use POST /brief-guide when preparing a digest, morning brief, or reading roundup.

Reading Memory never replies to the user directly. The calling agent owns final presentation.
```

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
- `READING_API_FLUE_MODEL`: defaults to `openai/gpt-5.5`; production currently uses `anthropic/claude-sonnet-4-5`.
- `READING_API_FLUE_TRACE_PATH`: defaults to `<READING_API_DATA_DIR>/flue-events.jsonl`; set to `off` to disable local Flue event tracing.

Production secret file:

```bash
install -d -m 700 ~/.reading-api
printf 'READING_API_TOKEN=%s\n' '<token>' > ~/.reading-api/env
chmod 600 ~/.reading-api/env
```

For local development, copy `.env.example` and override only the values you need. Do not commit real tokens.

## API

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

Supported source types: `url`, `text`, `pdf_url`. URL and PDF ingestion require HTTPS. Private IPs, redirects to private IPs, unsupported MIME types, and oversized bodies are blocked.

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

## Backup And Restore

Daily backup command:

```bash
READING_API_DB=~/.reading-api/reading.sqlite READING_API_BACKUP_DIR=~/backups/reading-memory ./scripts/backup-sqlite.sh
```

The deployed user timer runs the same script daily:

```bash
systemctl --user list-timers reading-memory-backup.timer
systemctl --user start reading-memory-backup.service
```

Restore drill:

```bash
systemctl --user stop reading-memory.service
cp ~/backups/reading-memory/reading-YYYYMMDDTHHMMSSZ.sqlite ~/.reading-api/reading.sqlite
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA integrity_check').get()); db.close();" ~/.reading-api/reading.sqlite
systemctl --user start reading-memory.service
```

## Validation

```bash
npm test
npm run build
READING_API_TOKEN=<token> npm run smoke
curl -s http://127.0.0.1:4727/health | jq
ss -ltnp | grep 4727
```

Expected healthy signals:

- `/health` returns `ready: true`, `db: "ok"`, and disk warning is false before production use.
- `ss` shows `127.0.0.1:4727`, not `0.0.0.0`.
- `journalctl --user -u reading-memory.service` contains metadata events only, not request bodies or extracted text.

Rollback:

```bash
systemctl --user stop reading-memory.service
git -C ~/reading-memory checkout <previous-release>
cd ~/reading-memory && npm ci && npm run build
systemctl --user start reading-memory.service
```

Migration failure behavior: migrations run inside a transaction and use `PRAGMA user_version`. If migration fails, startup fails before serving traffic and leaves the prior DB state intact.

## Inspect Flue Activity

Flue analysis traces are local JSONL files. They record item/session ids, timing, Flue event types, title/text lengths and hashes, tool metadata, and final structured reading judgment metadata. They do not store bearer tokens, raw titles, or raw article/newsletter text by default.

```bash
cd reading-memory
npm run traces -- --latest 10
npm run traces -- --latest 3 --json
```

The deployed default path is:

```text
~/.reading-api/flue-events.jsonl
```

For full transcripts, inspect the SQLite `sessions` table directly. That table contains the Flue skill prompt and assistant response for each persisted analysis session, including the source text sent to the model.
