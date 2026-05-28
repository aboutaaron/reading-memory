---
title: "feat: Reading Memory trust and resurfacing"
status: completed
created: 2026-05-28
origin: "Aaron asked whether Reading Memory is working as expected, whether there is anything to improve, and whether it is too early to build on it."
---

# Reading Memory Trust and Resurfacing

## Problem Frame

Reading Memory is now past the pure prototype stage. The service is live, loopback-only, backed by SQLite, and holding a real corpus. The 2026-05-28 recovery proved an important property: failed analysis attempts were recoverable from preserved `items.extracted_text`, and the corpus returned to a fully indexed state.

The next step should not be a migration or a large new product surface. The useful next build is a trust layer around the existing corpus: prove recall quality, prevent stale resurfacing, tighten source identity, and make operational failure modes visible before using Reading Memory as the base for heavier workflows.

## Current Read

Reading Memory is working well enough to keep as the active reading corpus.

Evidence from live checks:

- `reading-memory.service` is active on `127.0.0.1:4727`.
- `/health` returns ready with DB status `ok` and disk not in warning.
- Production SQLite has 77 indexed items, 77 analyses, 539 tags, 11 relationships, and 0 failed items.
- `/query` returns cited corpus results for Aaron-relevant topics like semantic layers, analytics agents, and agent memory.
- `/brief-guide` returns plausible candidates, themes, and skip items.

The weak spots are concentrated, not existential:

- `/brief-guide` has no durable usage ledger, so it cannot know what was already included or skipped in prior briefs.
- Query and brief ranking are still simple FTS/confidence paths; there is no repeatable recall eval to catch regressions.
- Text/newsletter captures can still duplicate the same underlying source when wrappers differ.
- Some operational hardening items remain open even though the service is usable locally.
- The service now uses Flue analysis in runtime, which is good, but model-switch safety needs canaries because the recent Qwen route produced failed analyses.

## Requirements

- R1. Keep Reading Memory as the active durable reading/link/receipt corpus; do not migrate to GBrain as the next step.
- R2. Add a repeatable recall/brief eval so model or query changes can be judged against stable fixtures before live use.
- R3. Add a brief usage ledger so `/brief-guide` can avoid repeating already-used items unless there is a material new angle.
- R4. Tighten canonical source dedupe for text and newsletter captures so repeated wrappers do not become independent memories.
- R5. Preserve current loopback-only, bearer-auth, SQLite-first architecture.
- R6. Keep OpenClaw as the orchestration/user-response layer; Reading Memory should not send messages, write briefs, or mutate external project files directly.
- R7. Make operational confidence inspectable through health, backups, smoke checks, traces, and docs.

## Scope Boundaries

In scope:

- Evaluation fixtures and scorecard for query/brief quality.
- Brief usage ledger and API endpoint for recording delivered/skipped brief outcomes.
- Canonical-source dedupe for text captures and newsletter excerpts.
- Focused ops hardening for systemd, backups, smoke tests, and failure visibility.
- Skill/docs updates so agents know when to query, ingest, and record outcomes.

Out of scope:

- GBrain migration or hard uninstall.
- Human-facing web UI.
- Vector database or embeddings.
- Automatic newsletter ingestion without taste filtering.
- Morning brief delivery rewrite.
- Blog, LinkedIn, or note drafting from Reading Memory without explicit review.

## Context and Existing Patterns

- `src/api/server.ts` is the thin HTTP boundary. Keep orchestration there minimal.
- `src/api/contracts.ts` owns Valibot request contracts.
- `src/reading/item-store.ts` owns ingest, idempotency, dedupe, analysis persistence, FTS rebuild, and activity logging.
- `src/reading/corpus-query.ts` owns `/query` and item detail lookup.
- `src/reading/brief-guide.ts` owns `/brief-guide` candidate selection.
- `src/reading/flue-agent.ts` owns Flue analysis and trace logging.
- `src/db/schema.sql` and `src/db/connection.ts` own SQLite schema and startup validation.
- Current schema migration code only initializes empty `user_version = 0` databases. Any production schema change must add an explicit versioned migration for existing `user_version = 1` databases.
- `.agents/skills/use-reading-memory/SKILL.md` is the bundled agent-facing operating guide.
- `todos/012-pending-p1-brief-usage-ledger.md` already frames the brief-ledger problem.
- `todos/013-pending-p2-reading-memory-canonical-source-dedupe.md` already frames canonical-source dedupe.

## Key Technical Decisions

### Keep Reading Memory, Do Not Migrate

GBrain is parked. Reading Memory has the right shape for this job: a narrow local service with explicit ingest/query/brief contracts, provenance, analysis traces, and SQLite persistence. The recovery event argues for hardening Reading Memory, not replacing it.

### Build An Eval Harness Before Expanding Product Surface

The most valuable next artifact is a small eval runner over saved fixtures. It should answer: did this model/query/brief change preserve the system's ability to recall useful reading, avoid bad repeats, and cite the right items?

This follows the existing model-eval lesson: longitudinal quality needs guarded scoring and stable JSONL/history, not vibe checks after failures.

### Treat Brief Usage As Corpus State

Delivered and skipped brief outcomes are reading-corpus facts. Store them in Reading Memory so `/brief-guide` can make a better resurfacing decision. OpenClaw still owns the final brief and calls the record endpoint after delivery.

Brief outcome recording must be idempotent. Delivery systems retry, and repeated writes must not over-suppress an item or distort resurfacing history.

### Prefer Source Identity Before Content Hash

Exact content hash dedupe is not enough for newsletters. Canonical URL should be the first source identity when present; full content hash remains a fallback; title/publisher hints are only duplicate candidates, not automatic merges.

### Keep Retrieval Boring Until Evals Prove Need

Use FTS, tags, source identity, usage ledger, and deterministic ranking first. Do not introduce embeddings or a vector database until the eval harness shows a clear retrieval failure that SQLite cannot address.

## Implementation Units

### U1. Add Reading Memory Quality Evals

**Goal:** Create a repeatable canary for query and brief-guide behavior before model, prompt, ranking, or dedupe changes reach the live corpus.

**Requirements:** R2, R7

**Dependencies:** None

**Files:**

- Add: `src/evals/reading-memory-eval.ts`
- Add: `src/evals/reading-memory-fixtures.ts`
- Add: `docs/evals/reading-memory-trust.md`
- Modify: `package.json`
- Test: `src/evals/reading-memory-eval.test.ts`

**Approach:**

- Use two fixture classes:
  - stable synthetic fixtures checked into `src/evals/reading-memory-fixtures.ts` for deterministic unit/eval behavior
  - optional sanitized snapshot fixtures exported from production for local regression runs, never required for CI and never containing raw private article/email text
- Build fixture coverage from representative topics: semantic layers/analytics agents, AI agents, AI economics, writing/culture, and morning-brief receipt material.
- Evaluate `/query`-equivalent logic for expected top items, citation presence, and empty-query behavior.
- Evaluate `/brief-guide`-equivalent logic for candidate relevance, stale-repeat avoidance once U2 exists, and skip rationale.
- Store JSONL run records with model, git SHA when available, fixture version, scores, and failures.
- Add one npm script such as `eval:reading` that runs locally without mutating production DB.

**Test scenarios:**

- Query fixture returns an expected item in the top results and includes it in citations.
- Weak/noisy query returns low confidence or empty result instead of hallucinated certainty.
- Brief fixture produces candidates with theme clusters and bounded skip reasons.
- Eval output is valid JSONL and rejects duplicate fixture IDs.
- Snapshot fixture export redacts raw text and records only bounded summaries, tags, source identity, and expected item IDs.

**Verification:**

- `npm test`
- `npm run build`
- `npm run eval:reading`

### U2. Add Brief Usage Ledger

**Goal:** Let OpenClaw record what was delivered or skipped so `/brief-guide` can avoid stale repeats and explain resurfacing.

**Requirements:** R3, R5, R6

**Dependencies:** U1 can run before or after, but U1 should add ledger-aware cases once this lands. U3 migration support must land before the ledger schema is used in production, either as a separate unit or in the same PR.

**Files:**

- Modify: `src/db/schema.sql`
- Modify: `src/db/connection.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/server.ts`
- Modify: `src/reading/brief-guide.ts`
- Add: `src/reading/brief-events.ts`
- Test: `src/api/server.test.ts`
- Test: `src/reading/brief-guide.test.ts`

**Approach:**

- Add a `brief_events` table with `item_id`, `brief_date`, `included_bool`, `rationale`, `source_context`, `resurface_after`, and `created_at`.
- Add an explicit `event_kind` field, e.g. `included`, `skipped`, or `resurfaced`, instead of deriving semantics only from `included_bool`.
- Add `request_id` and `payload_hash` handling for `POST /brief-events`, mirroring ingest idempotency at the endpoint level.
- Enforce a duplicate guard such as `UNIQUE (item_id, brief_date, event_kind, source_context)` so repeated caller writes cannot create multiple equivalent outcome facts.
- Add `POST /brief-events` for the caller to record included and skipped outcomes after a brief is delivered or finalized. Accept a bounded batch array in one request so the morning brief caller can record all outcomes atomically.
- Update `/brief-guide` to downrank or exclude recently included items by default.
- Allow resurfacing when `resurface_after` has passed or when caller-supplied focus terms indicate a materially new angle.
- Include ledger-aware skip/resurface rationale in response.

**Test scenarios:**

- Item included yesterday is excluded or downranked today by default.
- Skipped item with future `resurface_after` is not recommended before that date.
- Skipped item without a hard resurface date can remain eligible with rationale.
- Ledger write rejects unknown `item_id`.
- Replaying the same `request_id` and payload returns the same response without duplicating rows.
- Reusing the same `request_id` with a different payload returns an idempotency conflict.
- Re-sending the same event without the same `request_id` hits the duplicate guard and returns the existing event or a typed duplicate response.
- Batch writes are atomic: if one event is invalid, no partial brief outcome set is written.
- Brief guide remains usable when the ledger is empty.

**Verification:**

- `npm test`
- `npm run build`

### U3. Add Versioned SQLite Migrations

**Goal:** Make the plan safe for the existing production DB instead of only fresh databases.

**Requirements:** R3, R4, R5

**Dependencies:** Must land before U2 or U4 schema changes are used in production.

**Files:**

- Modify: `src/db/connection.ts`
- Modify: `src/db/schema.sql`
- Add: `src/db/migrations.ts`
- Test: `src/db/connection.test.ts`

**Approach:**

- Bump `CURRENT_USER_VERSION` from `1` to `2` when adding the new tables/indexes.
- Keep `schema.sql` as the fresh-database schema.
- Add a versioned migration path for existing `user_version = 1` databases that creates `brief_events`, canonical URL indexes, and any supporting columns/indexes needed by U2 and U4.
- Run migrations in a transaction with `PRAGMA foreign_keys = ON`.
- Leave existing rows intact; do not rewrite existing `items` unless a later implementation unit explicitly performs a bounded backfill.
- Add a migration smoke check that opens a copied v1-style DB and verifies new tables/indexes exist.

**Test scenarios:**

- Empty DB initializes directly to the latest schema.
- Existing v1 DB migrates to v2 without dropping `items`, `analyses`, `tags`, relationships, sessions, idempotency rows, or FTS content.
- A DB with `user_version > CURRENT_USER_VERSION` still fails loudly.
- Migration rollback leaves the DB unmodified when a migration step fails.

**Verification:**

- `npm test`
- `npm run build`

### U4. Tighten Canonical Source Dedupe For Text Captures

**Goal:** Prevent the same source from becoming multiple memories when captured as newsletter text, excerpt text, or URL content.

**Requirements:** R4, R5

**Dependencies:** U3 for schema/index changes.

**Files:**

- Modify: `src/reading/extract-source.ts`
- Modify: `src/reading/item-store.ts`
- Modify: `src/ingest/normalize-content.ts`
- Modify: `src/db/schema.sql`
- Modify: `src/db/migrations.ts`
- Test: `src/reading/item-store.test.ts`
- Test: `src/ingest/normalize-content.test.ts`
- Test: `src/db/connection.test.ts`

**Approach:**

- Infer canonical URLs from common newsletter lines such as "view this post on the web" and structured link text when present.
- Preserve canonical URL in `canonical_url` for text captures.
- Add an index on `items.canonical_url` for fast source-identity lookup.
- Preserve exact content-hash dedupe as the first lookup for byte/content-identical material, then use canonical URL identity to detect same-source changed-content captures.
- When canonical URL matches and content hash differs, return `content_changed`, set `supersedes_item_id`, and keep both items linked rather than overwriting history.
- Keep full-content hash semantics for exact duplicates.
- Return high-confidence duplicate candidates when canonical URL is absent but title/publisher/source evidence strongly matches.

**Test scenarios:**

- Two text captures containing the same article URL return `existing` or `content_changed`, not two unrelated items.
- Same canonical URL with materially changed content sets `supersedes_item_id`.
- Existing exact content-hash dedupe still works.
- Canonical URL lookup uses the new index and does not require scanning all items.
- Unrelated items with similar generic titles do not merge automatically.

**Verification:**

- `npm test`
- `npm run build`

### U5. Harden Brief And Query Ranking Edges

**Goal:** Make the existing FTS paths predictable enough for agent use and eval scoring.

**Requirements:** R2, R3, R5

**Dependencies:** U1 preferred first so ranking changes are measured. U2 should land before ledger-aware ranking changes.

**Files:**

- Modify: `src/reading/corpus-query.ts`
- Modify: `src/reading/brief-guide.ts`
- Test: `src/reading/corpus-query.test.ts`
- Test: `src/reading/brief-guide.test.ts`
- Test: `src/api/server.test.ts`

**Approach:**

- Push tag/focus filters into SQL before limiting candidate rows.
- Anchor brief lookback to `brief_date` instead of `Date.now()`.
- Keep punctuation-only query behavior as a typed empty result.
- Add score/rationale fields that make weak matches visibly weak to calling agents.

**Test scenarios:**

- Tag filters are applied before `LIMIT`.
- Focus filters do not hide valid candidates because an earlier unfiltered limit consumed the result set.
- `brief_date` controls the lookback window.
- Punctuation-only query stays a successful empty response.

**Verification:**

- `npm test`
- `npm run build`
- `npm run eval:reading`

### U6. Add Operational Confidence Checks

**Goal:** Make service health and recovery state visible enough that future agents can tell whether Reading Memory is trustworthy before relying on it.

**Requirements:** R5, R7

**Dependencies:** None

**Files:**

- Modify: `scripts/smoke-test.ts`
- Modify: `scripts/backup-sqlite.mjs`
- Modify: `systemd/reading-memory.service`
- Modify: `systemd/reading-memory-backup.service`
- Modify: `systemd/reading-memory-backup.timer`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`
- Test: `src/api/server.test.ts`

**Approach:**

- Extend smoke test to verify health, authenticated capabilities, query, brief guide, and a non-mutating DB count summary.
- Ensure backup script creates private directories/files and emits a machine-readable report.
- Document the active systemd override path separately from the portable repo unit.
- Add a restore-drill checklist and last-known-good backup evidence to docs.
- Keep health metadata-only; do not expose corpus text or secrets.

**Test scenarios:**

- Smoke test fails clearly when bearer env is missing.
- Backup report includes source DB, destination path, size, and status.
- Health remains safe for loopback-only use and rejects non-loopback host headers.

**Verification:**

- `npm test`
- `npm run build`
- `npm run smoke`
- Manual backup dry run or real backup against a temp DB.

### U7. Update Agent Skill And Workspace Routing

**Goal:** Make future sessions use the improved contract correctly without re-learning the current state.

**Requirements:** R1, R3, R6, R7

**Dependencies:** U1-U6 as relevant.

**Files:**

- Modify: `.agents/skills/use-reading-memory/SKILL.md`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/evals/reading-memory-trust.md`

**Workspace follow-up files outside this repo:**

- `MEMORY.md`
- `docs/project-status.json`
- `self-improving/domains/link-sharing.md`
- `self-improving/domains/morning-brief.md`

**Approach:**

- Update the bundled skill to say: query first, ingest only durable material, record brief outcomes after delivery, and treat eval failures as blockers for model/ranking changes.
- Keep instructions clear that Reading Memory is active and GBrain is parked.
- Update workspace memory/status only after implementation changes land, not during planning.
- Treat workspace files as a separate follow-up commit/PR in the workspace repo unless the active execution context intentionally spans both repositories.

**Test scenarios:**

- Documentation grep shows active routing points to Reading Memory, not GBrain.
- Skill examples include `/query`, `/ingest`, `/brief-guide`, and `/brief-events`.
- No instruction says Reading Memory sends user-visible messages.
- Execution notes identify whether the deliverable is `reading-memory` only or includes a separate workspace routing update.

**Verification:**

- `npm run build`
- Grep check over docs/skill files for stale GBrain migration or read-only Reading Memory language.

## Sequencing

1. U1 first if the goal is highest confidence: establish evals before changing ranking or ledger behavior.
2. U2 next because brief repeats are the most visible product failure.
3. U3 must happen before schema-dependent implementation reaches production.
4. U4 after migration support because source identity improves both brief and query behavior and needs an indexed canonical URL path.
5. U5 once evals can show whether ranking changes helped.
6. U6 can run in parallel with U2-U5 if implementation is split carefully.
7. U7 last so durable instructions reflect shipped behavior, not intended behavior.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Eval fixtures become too tailored to one model | Store expected behaviors, not exact prose; score citations, item IDs, and structured fields first |
| Ledger suppresses useful ongoing stories | Add `resurface_after` and material-new-angle rationale instead of permanent suppression |
| Retried brief-event writes distort resurfacing | Add request idempotency and a uniqueness guard for equivalent events |
| Schema changes work only on fresh DBs | Add a versioned v1-to-v2 migration and tests against an existing DB shape |
| Canonical URL extraction merges unrelated text | Only auto-merge when URL identity is strong; otherwise return duplicate candidates |
| Brief guide becomes overfit to morning brief | Keep `/brief-guide` as one consumer path; do not let it redefine corpus storage |
| Ops hardening becomes a deployment rewrite | Keep systemd/backups incremental and document host-specific overrides separately |

## Open Questions

- What minimum eval score should block a model switch? Default recommendation: require all critical fixtures to pass and allow only non-critical ranking drift.
- What should the exact `/brief-events` duplicate response be: idempotent success with the existing event or a typed duplicate? Default recommendation: idempotent success for equivalent events, conflict for divergent event payloads.
- Should duplicate candidates appear in `/query`, `/ingest`, or both? Default recommendation: both, but `/ingest` should be more explicit because that is when merge/create decisions happen.

## Ready To Build When

- Aaron confirms this is the desired next rung rather than a user-facing app built on top of Reading Memory.
- The implementation branch starts from the `reading-memory` repo.
- The untracked todo `todos/013-pending-p2-reading-memory-canonical-source-dedupe.md` is either intentionally included or committed separately by whoever created it.

## Execution Addendum

Implemented on branch `feat/reading-memory-trust-resurfacing`.

Shipped in the branch:

- U1 eval canary: `npm run eval:reading`, deterministic fixtures, JSONL output, and docs.
- U2 brief usage ledger: `POST /brief-events`, idempotency, duplicate guards, atomic batch writes, and brief-guide suppression/resurfacing.
- U3 versioned SQLite migration: current schema is `user_version = 2`; existing v1 DBs migrate to v2.
- U4 canonical source dedupe: newsletter/text canonical URL inference and same-source changed-content coverage.
- U5 ranking edges: query tag filters and brief focus filters are applied before limiting; brief lookback is anchored to `brief_date`.
- U6 ops confidence: smoke test now covers `/brief-guide` and `/activity`; backup script writes private backups and emits a JSON report.
- U7 routing/docs: README, development docs, bundled skill, workspace memory, project status, and morning-brief domain notes now point at Reading Memory as the active corpus and `/brief-events` as post-delivery ledger after deployment.

Review findings folded into implementation:

- Added explicit migrations before using the ledger schema so the existing live DB is not treated like a fresh database.
- Made `/brief-events` idempotency hash exclude `request_id`, so retries are stable while divergent payloads conflict.
- Kept Reading Memory as corpus state only; OpenClaw remains responsible for user-visible brief writing and delivery.
- Marked `/brief-events` as branch-only until deployment; morning brief should not rely on it against the currently running service yet.

Verification completed:

- `npm test`
- `npm run build`
- `npm run eval:reading`
- `git diff --check`
- Live smoke and temp-backup dry run were also performed during execution; the smoke path ingests a normal smoke-test item into the live local corpus.

Remaining follow-ups:

- Commit, push, open PR, and deploy the branch before callers rely on `/brief-events`.
- Decide whether to add a non-mutating smoke mode; the current smoke test intentionally exercises ingest.
- The portable systemd unit files were not changed in this branch; host-specific override details were documented in workspace project status.
