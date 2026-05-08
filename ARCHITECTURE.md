# Architecture

Reading Memory is a loopback-only backend service that gives local agents a durable reading corpus.

It is intentionally small: agents own user interaction, and Reading Memory owns ingestion, persistence, recall, and structured reading judgment.

## System Boundary

```text
User shares reading material
        |
Calling agent decides whether it is worth preserving
        |
Agent calls Reading Memory over localhost HTTP
        |
Reading Memory extracts, normalizes, dedupes, and stores the item
        |
Flue analyzes the item with a structured skill
        |
SQLite stores corpus facts and Flue session state
        |
Later, agents query the corpus for recall, brief prep, or synthesis
```

The calling agent decides when to use the service and how to present results. Reading Memory never replies to the user directly.

## Components

The TypeScript service owns the reliability boundary:

- HTTP API contracts
- bearer-token auth
- rate limiting and error envelopes
- URL and PDF extraction
- SSRF protections
- normalization and content hashing
- idempotent storage
- SQLite migrations and persistence
- query and brief-guide endpoints
- backups, smoke tests, and `systemd` (Linux) / `launchd` (macOS) deployment

Flue owns the model-judgment boundary:

- invoking the reading-analysis agent
- applying the `analyze-item` skill
- producing structured reading output
- persisting analysis session state
- emitting redacted trace events for local debugging

SQLite is the durable store for both corpus records and Flue session state. The service stores operational data outside the git checkout, under `~/.reading-api` by default.

## Security Model

The service binds to `127.0.0.1` by default and is designed for local agent use, not public internet exposure.

All non-health endpoints require:

```text
Authorization: Bearer <READING_API_TOKEN>
```

The bearer token is still useful for a local server because localhost is not a complete trust boundary. It limits blast radius if the service is accidentally exposed through a tunnel, reverse proxy, container port mapping, browser-triggered localhost request, or another local process.

This protects against accidental or opportunistic access to private reading data and durable write endpoints. It does not protect against a fully compromised host, a process that can read `~/.reading-api/env`, or deliberate exposure of the service without revisiting the threat model.

Keep the service loopback-only unless you redesign authentication, transport security, logging, abuse controls, and operational monitoring for remote access.

## Flue Integration

Reading Memory uses [Flue](https://github.com/withastro/flue) as the framework for the model-judgment step.

The Flue agent lives in `.flue/agents/reading.ts`. It calls the `analyze-item` skill and returns structured JSON that the TypeScript service validates and stores.

The split is deliberate:

- TypeScript handles service guarantees: contracts, auth, extraction, dedupe, persistence, validation, backups, and deployment.
- Flue handles reading judgment: summary, claims, relevance, tags, recommended action, and relationships.

Flue sessions are stored in SQLite. Reading Memory also writes redacted Flue activity to local JSONL traces for debugging. Those traces are operational metadata by default, not raw article text or bearer tokens.

For commands to inspect traces, see [DEVELOPMENT.md](DEVELOPMENT.md#inspect-flue-activity).
