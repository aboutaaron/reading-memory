# Reading API

Loopback-only Node + SQLite service for local-agent reading memory. It accepts text, URL, and PDF URL inputs; stores a durable corpus in SQLite; and routes item judgment through a Flue skill with structured output.

## Run Locally

```bash
cd reading-api
npm install
READING_API_TOKEN=dev-secret READING_API_DB=/tmp/reading.sqlite npm run dev
```

The service binds to `127.0.0.1:4727` by default. Do not expose it publicly.

## Environment

- `READING_API_TOKEN`: required bearer token.
- `READING_API_HOST`: defaults to `127.0.0.1`.
- `READING_API_PORT`: defaults to `4727`.
- `READING_API_DATA_DIR`: defaults to `~/.reading-api`.
- `READING_API_DB`: defaults to `~/.reading-api/reading.sqlite`.
- `READING_API_BACKUP_DIR`: defaults to `~/backups/reading-api`.
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
cd ~/reading-api
npm ci
npm run build
mkdir -p ~/.config/systemd/user
cp systemd/reading-api.service ~/.config/systemd/user/
cp systemd/reading-api-backup.service systemd/reading-api-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now reading-api.service
systemctl --user enable --now reading-api-backup.timer
systemctl --user status reading-api.service
```

The unit binds to loopback and stores data outside the git checkout at `~/.reading-api/reading.sqlite`.

## Backup And Restore

Daily backup command:

```bash
READING_API_DB=~/.reading-api/reading.sqlite READING_API_BACKUP_DIR=~/backups/reading-api ./scripts/backup-sqlite.sh
```

The deployed user timer runs the same script daily:

```bash
systemctl --user list-timers reading-api-backup.timer
systemctl --user start reading-api-backup.service
```

Restore drill:

```bash
systemctl --user stop reading-api.service
cp ~/backups/reading-api/reading-YYYYMMDDTHHMMSSZ.sqlite ~/.reading-api/reading.sqlite
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA integrity_check').get()); db.close();" ~/.reading-api/reading.sqlite
systemctl --user start reading-api.service
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
- `journalctl --user -u reading-api.service` contains metadata events only, not request bodies or extracted text.

Rollback:

```bash
systemctl --user stop reading-api.service
git -C ~/reading-api checkout <previous-release>
cd ~/reading-api && npm ci && npm run build
systemctl --user start reading-api.service
```

Migration failure behavior: migrations run inside a transaction and use `PRAGMA user_version`. If migration fails, startup fails before serving traffic and leaves the prior DB state intact.

## Inspect Flue Activity

Flue analysis traces are local JSONL files. They record item/session ids, timing, Flue event types, title/text lengths and hashes, tool metadata, and final structured reading judgment metadata. They do not store bearer tokens, raw titles, or raw article/newsletter text by default.

```bash
cd reading-api
npm run traces -- --latest 10
npm run traces -- --latest 3 --json
```

The deployed default path is:

```text
~/.reading-api/flue-events.jsonl
```

For full transcripts, inspect the SQLite `sessions` table directly. That table contains the Flue skill prompt and assistant response for each persisted analysis session, including the source text sent to the model.
