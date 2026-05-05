# Reading Memory

AI agents can read a link, summarize a paper, or answer a question from the current page. What they usually do not get is a durable reading layer: a place to store what was read, why it mattered, how it connects to prior material, and when it should resurface.

Reading Memory is that layer. It is a local service that gives an AI agent durable, queryable memory for articles, newsletters, papers, posts, PDFs, and excerpts.

It is not a chat app, browser plugin, vector database starter kit, or replacement for OpenClaw, Claude Code, Codex, or any other agent runtime. It is a backend harness those agents can call when they need to preserve reading judgment beyond the current conversation.

## What It Is

Reading Memory is a loopback-only Node + SQLite service for agent-owned reading memory. It accepts text, URLs, and PDF URLs; extracts and normalizes the content; stores a durable corpus; and uses a Flue skill to produce structured judgment about each item.

The core unit is not just "a document." It is a stored reading item plus metadata an agent can reuse later:

- summary
- claims
- relevance score
- themes and tags
- recommended action
- relationships to prior items
- source and provenance data

The goal is to let an agent remember what mattered, not merely that a link once appeared in chat.

## Why Use It

General agent runtimes are good at handling the current task. They are weaker at maintaining a durable, domain-specific reading corpus with stable contracts, provenance, dedupe, operational checks, and explicit query surfaces.

Without a service like this, reading memory usually ends up in one of four places:

- conversation history that gets compacted or lost
- ad hoc markdown notes
- bookmarks without judgment
- vector stores without enough workflow around ingestion, provenance, and reuse

Reading Memory gives the agent a dedicated place to put reading material that should survive the session. It is useful when you want a local assistant to build up taste, context, and recall instead of repeatedly rediscovering the same sources.

## How It Works

The service runs locally on `127.0.0.1` behind bearer-token auth.

```text
User shares reading material
        ↓
Local agent decides it is worth preserving
        ↓
Agent calls Reading Memory over localhost HTTP
        ↓
Reading Memory extracts, normalizes, dedupes, and stores the item
        ↓
Flue analyzes the item with a structured skill
        ↓
SQLite stores the corpus facts and Flue session state
        ↓
Later, agents query the corpus for recall, brief prep, or synthesis
```

The TypeScript service owns the reliability work: HTTP contracts, auth, URL/PDF extraction, SSRF protections, content hashes, idempotency, SQLite persistence, query, backups, and systemd deployment.

Flue owns the judgment boundary: invoking the reading skill, producing structured output, and persisting session state.

## What This Adds Beyond Agent Tools

OpenClaw, Claude Code, Codex, and similar tools can read, browse, summarize, and edit. Reading Memory adds a persistent subsystem for the parts you do not want trapped inside an individual session.

| Native agent runtime | Reading Memory |
| --- | --- |
| Handles the current conversation or task | Maintains a durable reading corpus |
| May summarize a link once | Stores judgment, tags, provenance, and relationships |
| Context can compact or disappear | SQLite persists across sessions and model changes |
| Tool behavior depends on the current agent | HTTP API gives stable contracts any local agent can call |
| Memory is usually broad and generic | Reading memory is domain-specific and inspectable |
| Retrieval may be implicit | Query and brief-guide endpoints are explicit |

Use this when the question is not "can my agent read this?" but "can my agent remember why this mattered, connect it to future material, and retrieve it later with enough structure to act on?"

## What It Is Not

- It is not a public web service. Keep it loopback-only unless you revisit the threat model.
- It is not a human-facing reading app.
- It is not a replacement for the agent that talks to the user.
- It is not a generic knowledge graph or full research platform.
- It is not trying to store everything. The calling agent should still apply taste and only ingest material worth remembering.

## Run Locally

```bash
cd reading-memory
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
