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
A provider SDK returns structured reading judgment
        |
SQLite stores canonical corpus facts and structured analysis
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

The analyzer owns the model-judgment boundary:

- assembling bounded prior-source and attributed reader context
- applying the packaged analysis prompt
- making one structured SDK request
- validating output and exact source evidence
- emitting redacted trace metadata for local debugging

SQLite is the durable store for canonical corpus records and validated structured analysis. The analyzer does not persist provider conversations. The service stores operational data outside the git checkout, under `~/.reading-api` by default.

Reader annotations are append-only, attributed statements associated with an item. A correction points at its predecessor; only the active correction is indexed and supplied as current reader context, while item detail retains the history. User statements and agent interpretations have separate actor types. This is attribution supplied by the authenticated local caller, not independent identity verification.

Before analysis, deterministic lexical retrieval supplies bounded prior-source passages and active annotations. Accepted model relationships refer only to those supplied IDs and contain exact quotes from the current source and a supplied prior passage. This checks provenance; semantic entailment remains model judgment. Heuristic theme relationships are labeled separately.

The HTTP ingest delegates extraction lazily to the store after request replay/conflict checks. In-flight identical requests share extraction and analysis. Content-hash dedupe follows extraction and uses the complete normalized content, even when the stored analysis projection is truncated.

## Security Model

The service binds to `127.0.0.1` by default and is designed for local agent use, not public internet exposure.

All non-health endpoints require:

```text
Authorization: Bearer <READING_API_TOKEN>
```

The bearer token is still useful for a local server because localhost is not a complete trust boundary. It limits blast radius if the service is accidentally exposed through a tunnel, reverse proxy, container port mapping, browser-triggered localhost request, or another local process.

This protects against accidental or opportunistic access to private reading data and durable write endpoints. It does not protect against a fully compromised host, a process that can read `~/.reading-api/env`, or deliberate exposure of the service without revisiting the threat model.

Keep the service loopback-only unless you redesign authentication, transport security, logging, abuse controls, and operational monitoring for remote access.

## Analyzer Decision (Issue #21)

Decision: remove Flue and use the official OpenAI and Anthropic SDKs directly. The service needs a single structured completion, with no file access, command execution, tool loop, compaction, or conversation persistence. The direct implementation keeps the existing `ReadingAnalyzer` contract, normalization, evidence checks, bounded context, abort propagation, and best-effort redacted traces.

The spike replaced `createFlueContext`, the disabled `SandboxApi` implementation, and a framework model resolver with a small provider adapter. OpenAI uses Responses with a strict JSON schema and `store: false`; Anthropic uses a forced output tool whose arguments are validated but never executed. A single Valibot schema supplies validation and the provider schema. Refusals, incomplete responses, missing output, malformed JSON, and invalid schemas fail analysis; SDK retries are disabled so the service owns the deadline and caller retry contract.

| Comparison | Flue baseline | Direct SDK decision |
| --- | --- | --- |
| Production packages in lockfile, including root | 298 | 34 |
| All packages in lockfile, including root | 330 | 68 |
| Analyzer, prompt, schema, provider, and trace source lines | 563 across 3 files | 455 across 6 files |
| Runtime coupling | Beta runtime, internal resolver/context, agent/skill/harness lifecycle, sandbox | Public SDK request APIs and one schema converter |
| Provider tests | Framework faux-provider registration and finish-tool emulation | Official SDK serialization with injected HTTP responses; no global registration |
| Deterministic evaluation | 26/26 checks | 26/26 checks |

The SDK route wins on dependency surface and test isolation. Line count includes the unchanged normalization and redacted error handling, plus explicit provider refusal checks and configuration validation. These tests use canned outputs and synthetic fixtures; they establish contract parity, not comparative live model quality, latency, or cost. No private corpus or live provider requests were used for this decision. Revisit an agent runtime only if a concrete workflow requires capabilities beyond a single bounded analysis request.

The default is the concrete OpenAI provider ID `gpt-5.6-luna`, verified in the [official model reference](https://developers.openai.com/api/docs/models/gpt-5.6-luna). This is the same default model family as before; `openai/gpt-5.6-luna` remains accepted and resolves locally without a framework alias table. OpenAI's [structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) defines the strict schema contract. Anthropic's [tool definition documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) defines the forced structured output call.

Compatibility: `READING_API_MODEL` takes precedence over legacy `READING_API_FLUE_MODEL`. The `flueModel` config property, `createFlueReadingAnalyzer` import, and `flue-events.jsonl` filename remain to avoid unnecessary consumer changes. Only OpenAI and Anthropic providers are supported; other former Flue providers require an API-compatible gateway or an explicit future adapter. Base URL overrides remain provider-specific. Analyzer health fails closed on missing credentials or invalid provider configuration, but does not make live network probes or claim a key has provider access.

Legacy `sessions` tables may remain after upgrade. The current analyzer never reads or writes them. The build copies `.agents/` for installation artifacts, while `src/reading/analysis-prompt.ts` is the canonical analysis prompt. Trace events include numeric metadata and hashes only; model-generated themes are counted rather than logged. For inspection commands, see [DEVELOPMENT.md](DEVELOPMENT.md#inspect-analysis-activity).
