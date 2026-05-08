# Reading Memory

Reading Memory gives local AI agents a durable reading corpus.

It stores articles, newsletters, papers, posts, PDFs, excerpts, and the judgment about why they mattered.

## Why It Exists

Agents can read the page in front of them. They usually cannot build durable taste from what they read.

Reading Memory preserves what was worth saving, how it connected to prior sources, and when it should resurface.

Reading Memory is the local service for that job. It gives agents explicit endpoints for ingestion, recall, and brief preparation, backed by SQLite and [Flue](https://github.com/withastro/flue).

## Install

```bash
npx github:aboutaaron/reading-memory setup --target codex
```

The setup command generates a local bearer token, writes `~/.reading-api/env`, and installs the bundled `use-reading-memory` skill for the target agent.

Targets:

```bash
npx github:aboutaaron/reading-memory setup --target codex
npx github:aboutaaron/reading-memory setup --target openclaw
npx github:aboutaaron/reading-memory setup --target claude-code
npx github:aboutaaron/reading-memory setup --target env
```

Use `--target claude-code` to install the bundled skill into Claude Code's global skill directory.

Use `--dry-run` to inspect the files it would create.

## Data And Backups

Reading Memory keeps runtime state outside the git checkout by default:

- environment file: `~/.reading-api/env`
- SQLite database: `~/.reading-api/reading.sqlite`
- Flue trace file: `~/.reading-api/flue-events.jsonl`
- backup directory: `~/backups/reading-memory`

Back up the SQLite database and backup directory separately from this repo. Do not commit local databases, traces, backups, or real tokens.

## Workflow

| Agent need | Reading Memory path |
| --- | --- |
| Preserve a useful article, paper, post, PDF, newsletter, or excerpt | `POST /ingest` |
| Answer from previously saved reading material | `POST /query` |
| Choose sources for a digest or reading roundup | `POST /brief-guide` |
| Inspect model judgment and failures | local SQLite + Flue traces |

The calling agent owns the user interaction. Reading Memory is the durable subsystem it calls when current context is not enough.

## Add It To An Agent

Reading Memory includes a bundled agent skill at:

```text
.agents/skills/use-reading-memory/SKILL.md
```

The setup command copies this skill for Codex, OpenClaw, or Claude Code. For other agents, copy the same file into that runtime's equivalent skill or instruction directory, then expose:

```bash
source ~/.reading-api/env
```

The important environment values are:

```bash
READING_MEMORY_URL=http://127.0.0.1:4727
READING_API_TOKEN=<same token used by the service>
```

The skill gives the calling agent the operating rule: ingest durable reading material, query before answering recall-heavy questions, and use `/brief-guide` when preparing digests or reading roundups.

## What It Is

Reading Memory is a loopback-only Node + SQLite service for agent-owned reading memory.

It accepts text, URLs, and PDF URLs; extracts and normalizes the content; stores a durable corpus; and uses [Flue](https://github.com/withastro/flue) for structured reading judgment.

It is not a chat app, browser plugin, vector database starter kit, or replacement for OpenClaw, Claude Code, Codex, or any other agent runtime. It is a backend harness those agents can call when they need to preserve reading judgment beyond the current conversation.

The core unit is not just "a document." It is a stored reading item plus metadata an agent can reuse later:

- summary
- claims
- relevance score
- themes and tags
- recommended action
- relationships to prior items
- related item hints
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

Good callers use it as a disciplined capture path:

1. Search the corpus before assuming a source is new.
2. Ingest only when the material has durable value or adds a materially new angle.
3. Use `dedupe_status`, `related_items`, tags, and relationships to merge, cite, or link the item in the caller's own workflow.

Reading Memory does not edit your notes, project files, or brief output directly. It preserves the corpus evidence and exposes enough structure for the calling agent to decide what to do next.

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

## Architecture

For the service boundary, storage model, bearer-token rationale, and Flue integration details, see [ARCHITECTURE.md](ARCHITECTURE.md).

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
| Duplicate handling is usually conversational | Content hashes, idempotency, and related-item hints are explicit |

Use this when the question is not "can my agent read this?" but "can my agent remember why this mattered, connect it to future material, and retrieve it later with enough structure to act on?"

## What It Is Not

- It is not a public web service. Keep it loopback-only unless you revisit the threat model.
- It is not a human-facing reading app.
- It is not a replacement for the agent that talks to the user.
- It is not a generic knowledge graph or full research platform.
- It is not trying to store everything. The calling agent should still apply taste and only ingest material worth remembering.

## Development

For manual wiring, API examples, local development, deployment, backups, validation, and trace inspection, see [DEVELOPMENT.md](DEVELOPMENT.md).
