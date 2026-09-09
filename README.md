# Reading Memory

Reading Memory gives local AI agents a durable reading corpus.

It stores articles, newsletters, papers, posts, PDFs, excerpts, and the judgment about why they mattered.

## Why It Exists

Agents can read the page in front of them. They usually cannot build durable taste from what they read.

Reading Memory preserves what was worth saving, how it connected to prior sources, and when it should resurface.

Reading Memory is the local service for that job. It gives agents explicit endpoints for ingestion, recall, and brief preparation, backed by SQLite and direct provider SDKs.

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
npx github:aboutaaron/reading-memory setup --target mcp
```

Use `--dry-run` to inspect the files it would create.

Re-running `setup` is safe. The command preserves the existing bearer token and any extra keys you have added to the env file — provider base-URL overrides, custom model pinning, anything you tuned by hand. Only the keys `setup` owns (URL, token, host, port, paths) are rewritten.

### Model and provider configuration

The default provider model ID is `gpt-5.6-luna`. Set `OPENAI_API_KEY` in the service environment. Use `READING_API_MODEL=anthropic/claude-sonnet-4-5` with `ANTHROPIC_API_KEY` to select Anthropic. `READING_API_FLUE_MODEL` remains a fallback alias for existing installations; `READING_API_MODEL` takes precedence. An `openai/` prefix is accepted but removed before the SDK request.

Only OpenAI and Anthropic are supported. Other former Flue provider names must be changed to one of these providers or an API-compatible gateway. Configure the SDK's complete API base URL, including `/v1` for OpenAI:

```bash
OPENAI_BASE_URL=https://your-openai-proxy.example.com/v1
ANTHROPIC_BASE_URL=https://your-anthropic-proxy.example.com
```

Missing credentials, unsupported providers, and invalid base URLs make analyzer health unavailable. Health checks validate local configuration without sending a model request; a configured key does not prove provider access. See `.env.example` and [the analyzer decision](ARCHITECTURE.md#analyzer-decision-issue-21).

## Workflow

| Agent need | Reading Memory path |
| --- | --- |
| Preserve a useful article, paper, post, PDF, newsletter, or excerpt | `POST /ingest` |
| Answer from previously saved reading material | `POST /query` |
| Choose sources for a digest or reading roundup | `POST /brief-guide` |
| Record what a digest or brief used or skipped | `POST /brief-events` |
| Preserve a reader's comment, question, or correction about a source | `POST /items/:id/annotations` |
| Resume a multi-step reading workflow after interruption | run ledger files + `npm run run-ledger` |
| Inspect recent operational events while debugging | authenticated `GET /activity` |
| Inspect model judgment and failures | local SQLite + redacted analysis traces |

The calling agent owns the user interaction. Reading Memory is the durable subsystem it calls when current context is not enough.

## Reading Judgment And Recall

Every new analysis retains its original rationale. Reader annotations preserve exact attributed notes, optional project/question context, and an immutable correction history. A saved source or brief inclusion does not establish that the reader agrees with it. Agents must label their own interpretations as agent annotations; user annotations represent statements the user actually made.

Analysis can inspect up to five lexically related prior sources, selected verbatim passages, and bounded active annotations. Retrieval allocates separate term budgets to the title, caller context, annotations, and source text; source terms are ranked by frequency across the whole article. Model relationships include exact quotations from both supplied sources and are labeled `origin: model`; unsupported IDs or quotations are rejected. Theme-overlap suggestions are labeled `origin: heuristic`. Quotation validation proves where the cited text came from, not that a model's interpretation is correct.

`POST /query` searches meaningful terms across the question and active reader notes. It tries all terms first and labels a fallback to partial matches explicitly. `results`, `citations`, `matched_terms`, and `match_strategy` describe retrieval; `answer` is an empty compatibility field. `confidence` is `null` for matches because lexical scores are not calibrated probabilities, and zero for empty results. The calling agent must inspect the returned evidence before making claims. This remains lexical retrieval, so paraphrases with no meaningful word overlap may require a differently phrased query.

Set `mode: "fts+usage"` on `/query` to prefer previously useful lexical matches; the default remains `fts`. Included and cited events add a recency-weighted boost, deliberate skips lower it, and adjustments remain bounded. Old, unused reading with low relevance sinks modestly instead of disappearing. Each adjusted result explains its lexical score, use count, and multiplier. Item details expose `usage_count` and `last_used_at`; these describe recorded use, not endorsement.

After using a stored source in an answer, record a `cited` event through `/brief-events` with `included_bool: true`, a meaningful rationale, and the required nonblank `source_context` containing a stable answer identifier. Use a different identifier for each distinct answer and reuse it for retries. Retrieval alone is not a citation. A citation neither consumes a brief appearance nor changes a pending resurfacing schedule.

`POST /brief-guide` prioritizes due resurfacing, then brief recommendations and relevance. Three consecutive skipped brief dates demote an item and halve its effective confidence; an explicit due schedule overrides this feedback. Original analysis confidence remains visible. An explicit resurfacing schedule can override an analysis's skip recommendation. Included and resurfaced items remain suppressed until a new schedule makes them eligible; a later skipped event does not erase earlier use. Dates cover complete UTC days, with an exclusive cutoff at the next midnight. Due reading can reappear regardless of its original ingestion age. Brief selection and delivery history are not measures of reader agreement.

URL/PDF captures extract available title, author, publisher, and publication date. An explicit `source.title` takes precedence. Full normalized text determines content identity before the stored analysis text is truncated; `truncated` is returned on ingest and item reads. `GET /items/:id` returns metadata, annotation history, analysis rationale, and relationship evidence. Add `?include=text` only when the retained source text is needed; it is omitted by default.

Schema version 6 adds cited-event support while preserving brief history. Version 3 added durable judgment fields and rebuilds the derived search index. Legacy truncated hashes are prefixed with `legacy-prefix:` so incomplete old captures cannot collide with new full-source identities; recapture creates a new item and links the source when possible. Legacy rationales and source endings that were never stored cannot be recovered automatically. Existing idempotency snapshots remain historical replay records. Back up the database before upgrading; see [DEVELOPMENT.md](DEVELOPMENT.md).

## Add It To An Agent

### MCP Clients

MCP-capable agents can discover typed tools without installing the prose skill:

```bash
npx github:aboutaaron/reading-memory setup --target mcp
```

Setup writes the same private `~/.reading-api/env` file and prints a JSON `mcpServers` registration using the current installation's Node executable and CLI path. Copy that registration into your client's MCP configuration. For clients using another format, use the printed `command` and `args` values; no bearer token belongs in the client configuration. Keep that installation available while the client uses it. The existing Codex, OpenClaw, and Claude Code skill targets remain available.

From an installed checkout, the server entry point is:

```bash
npm install
npx reading-memory mcp
```

The MCP process communicates over stdio and calls the existing HTTP service. Start that service separately using the same env file. `READING_MEMORY_URL` and `READING_API_TOKEN` environment values override the file; use `mcp --env-file /path/to/env` or `READING_MEMORY_ENV_FILE` to select another file. Only loopback HTTP/HTTPS origins are accepted, and redirects are refused. The bearer token is never returned in tool results or diagnostic logs.

MCP requires `READING_API_TOKEN` to contain at least 32 non-whitespace ASCII characters; setup-generated UUIDs already meet this requirement. This prevents short credentials from colliding with ordinary response fields during redaction. If MCP startup fails with a preserved shorter custom token, generate a new UUID and update `READING_API_TOKEN` in the shared env file and any overriding environments, then restart the HTTP service and MCP client with that same token. Setup preserves existing tokens and never rotates them automatically; the HTTP API's existing token compatibility is unchanged.

Tools mirror the HTTP contracts: `ingest`, `query`, `brief_guide`, `brief_events`, `get_item`, `annotations`, `health`, `forget`, and `reanalyze`. Tool descriptions explain when to use them. Supply UUID request IDs where required and reuse a write's ID only when retrying its identical payload. `get_item` omits source text unless `include_text: true`; `forget` requires an explicit user deletion request. Successful results preserve the API envelope under `structuredContent` and as JSON text, while failures also set MCP `isError`.

The adapter derives tool JSON Schemas from the shared Valibot HTTP contracts and validates calls with those same schemas. Calendar-date and non-whitespace checks are enforced at runtime. It uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) and [Valibot JSON Schema converter](https://valibot.dev/guides/json-schema/).

### Skill-Based Clients

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

The skill gives the calling agent the operating rule: ingest durable reading material, query before answering recall-heavy questions, use `/brief-guide` when preparing digests or reading roundups, and record final digest outcomes with `/brief-events`.

For multi-step workflows such as newsletter triage, agents should also create a local run ledger. Run ledgers store operational state — considered sources, read/skim/done decisions, archive/restore actions, captures, and verification — without turning rejected source content into corpus memory. `npm run run-ledger -- schema` exposes the machine-readable event contract for calling agents. See [docs/run-ledgers.md](docs/run-ledgers.md).

### Claude Code Slash Commands

For the `claude-code` target, setup also installs any markdown files under `.agents/commands/` to `~/.claude/commands/`. Currently bundled:

- `/reading:status` — read-only health check. Verifies env vars, hits `GET /health`, and reports a one-line status. Use when ingest or query is failing, or any time you need to confirm the service is reachable before relying on it.

Codex and OpenClaw use different surfaces for user-invocable commands; the `--target codex` and `--target openclaw` installs skip the commands directory by design.

## What It Is

Reading Memory is a loopback-only Node + SQLite service for agent-owned reading memory.

It accepts text, URLs, and PDF URLs; extracts and normalizes the content; stores a durable corpus; and uses direct OpenAI or Anthropic SDK calls for structured reading judgment. [PDF parsing](docs/PDF-PARSING.md) runs in an isolated, abortable worker with a 15-second deadline and bounded heap, input, page count, and output.

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

Good callers use it like a capture substrate:

1. Search the corpus before assuming a source is new.
2. Ingest only when the material has durable value or adds a materially new angle.
3. Use `dedupe_status`, `related_items`, tags, and relationships to merge, cite, or link the item in the caller's own workflow.
4. After a digest or brief is finalized, record included/skipped outcomes so future source selection can avoid stale repeats.
5. For workflows with many sources or external actions, keep a run ledger so another agent can resume from explicit state instead of chat history.

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
A provider SDK returns structured reading judgment
        ↓
SQLite stores the canonical corpus facts and structured analysis
        ↓
Later, agents query the corpus for recall, brief prep, or synthesis
```

The TypeScript service owns the reliability work: HTTP contracts, auth, URL/PDF extraction, SSRF protections, content hashes, idempotency, SQLite persistence, query, backups, and `systemd` (Linux) / `launchd` (macOS) deployment.

The analyzer owns the judgment boundary: one structured provider call using a packaged prompt. Reading Memory validates the result and source evidence before persistence. It stores redacted trace metadata, with no conversation or tool execution loop.

## Architecture

For the service boundary, storage model, bearer-token rationale, and analyzer decision, see [ARCHITECTURE.md](ARCHITECTURE.md).

## What This Adds Beyond Agent Tools

OpenClaw, Claude Code, Codex, and similar tools can read, browse, summarize, and edit. Reading Memory adds a persistent subsystem for the parts you do not want trapped inside an individual session.

| Native agent runtime | Reading Memory |
| --- | --- |
| Handles the current conversation or task | Maintains a durable reading corpus |
| May summarize a link once | Stores judgment, tags, provenance, and relationships |
| Context can compact or disappear | SQLite persists across sessions and model changes |
| Tool behavior depends on the current agent | HTTP API gives stable contracts any local agent can call |
| Memory is usually broad and generic | Reading memory is domain-specific and inspectable |
| Retrieval may be implicit | Query, brief-guide, and brief-events endpoints are explicit |
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

Track planned work in [GitHub issues](https://github.com/aboutaaron/reading-memory/issues). The [historical backlog audit](docs/backlog-migration.md) records what shipped and where remaining work moved.

### Optional hybrid retrieval

Lexical search remains the default. Set `READING_API_EMBEDDING_MODEL=openai/text-embedding-3-small` to enable optional embeddings, then request `mode: "hybrid"` on `/query`. Health reports missing embeddings; existing reading can be indexed with the dry-run-first `npm run backfill:embeddings` command. See [Hybrid retrieval](docs/HYBRID-RETRIEVAL.md) for configuration, provider data, backfill, and the limits of the synthetic evaluation.
