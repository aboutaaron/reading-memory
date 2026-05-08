---
status: completed
created: 2026-05-08
---

# Capture-Style Reading Memory Improvements

## Problem Frame

Reading Memory is a general durable corpus for reading material, not just a morning brief helper. Compared with Chris Parsons' `capture` skill, it has stronger service architecture but weaker workflow discipline around search-first reuse, merge/update decisions, and explicit relationship surfacing.

This plan upgrades the general Reading Memory skill/API so local agents can ingest with better capture hygiene while keeping the service boundary intact.

## Requirements

- R1. Ingestion responses should surface likely related existing items so the calling agent can avoid creating isolated memories.
- R2. Exact duplicate/content-hash handling must continue to return existing items without rerunning analysis.
- R3. Query should handle punctuation-only or empty-normalized searches without invalid FTS syntax.
- R4. Agent-facing docs and skills should instruct callers to search/merge/link before treating a source as new.
- R5. Morning brief-specific behavior remains a consumer concern through `/brief-guide`, not the identity of Reading Memory.

## Scope Boundaries

- No Obsidian vault, daily-note, or wikilink implementation.
- No human-facing UI.
- No full semantic embeddings/vector store in this PR.
- No automatic project file editing from Reading Memory.
- No replacement of `/brief-guide`; it remains one consumer-facing selection endpoint.

## Context & Research

### Relevant Code and Patterns

- `src/reading/item-store.ts` owns ingest, dedupe, analysis persistence, FTS rebuild, idempotency, and activity logging.
- `src/reading/corpus-query.ts` owns FTS query and item detail retrieval.
- `src/api/server.ts` is the narrow HTTP routing layer and should stay thin.
- `src/db/schema.sql` and `src/db/connection.ts` own SQLite schema and migrations.
- `.agents/skills/use-reading-memory/SKILL.md` is the general agent-facing skill.

### Institutional Learnings

- Reading Memory must be treated as the general durable corpus; morning brief is only one consumer.
- Links are evidence, not vibes: source material should be preserved and queried explicitly when future recall matters.

### External References

- `https://airskills.ai/chrismdp/capture`: useful comparison point for search-before-create, merge-vs-create, and linking captures into live work.

## Key Technical Decisions

- Add lightweight related-item discovery using the existing FTS table rather than introducing embeddings. This fits the current SQLite-first V1 and keeps deployment simple.
- Include related items in ingest responses after analysis succeeds. Exact duplicates still short-circuit as existing; non-duplicates get relationship hints for the caller.
- Return an empty query result for empty-normalized query text instead of falling back to `*`.
- Document project/linking as caller-owned behavior. Reading Memory can expose related corpus evidence, but it should not mutate external project systems.

## Open Questions

### Resolved During Planning

- Should this become morning brief work? No. Brief usage tracking is separate follow-up work; this PR targets the generalized Reading Memory skill/API.

### Deferred to Implementation

- Exact related-item ranking threshold: choose conservatively based on FTS score and existing tests.

## Implementation Units

### U1. Add Related Item Discovery

**Goal:** Surface likely existing related readings from the corpus during ingest.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/reading/item-store.ts`
- Modify: `src/reading/types.ts`
- Test: `src/reading/item-store.test.ts`

**Approach:**
- Add a small related-item response type.
- After an item is indexed and FTS is rebuilt, query `item_fts` with title/summary/claim/tag terms from the new analysis and exclude the current item.
- Return bounded related items with `item_id`, title, source URI, score, and match reason.
- Preserve exact duplicate/idempotency behavior.

**Patterns to follow:**
- Existing `toIngestResponse`, `latestAnalysis`, and `rebuildFts` patterns in `src/reading/item-store.ts`.

**Test scenarios:**
- Happy path: ingesting a second related-but-not-duplicate item returns the first item in `related_items`.
- Edge case: exact duplicate still returns `dedupe_status: existing` and does not rerun analysis.
- Edge case: unrelated corpus items do not flood the response.

**Verification:**
- `npm test` covers new related-item behavior.

### U2. Harden Query Normalization

**Goal:** Make `/query` safe and explicit when user query text normalizes to no searchable terms.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/reading/corpus-query.ts`
- Test: `src/api/server.test.ts` or `src/reading/*query*.test.ts`

**Approach:**
- Replace wildcard fallback with a structured empty result.
- Keep existing successful query behavior unchanged.

**Patterns to follow:**
- Existing empty-result envelope in `src/reading/corpus-query.ts`.

**Test scenarios:**
- Edge case: punctuation-only query returns empty results and confidence `0`.
- Happy path: normal query still returns matching stored item.

**Verification:**
- `npm test` covers both paths.

### U3. Update General Skill and Docs

**Goal:** Make the general Reading Memory skill reflect capture-style discipline without becoming Obsidian-specific or brief-specific.

**Requirements:** R4, R5

**Dependencies:** U1

**Files:**
- Modify: `.agents/skills/use-reading-memory/SKILL.md`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`

**Approach:**
- Add search-before-ingest guidance.
- Explain how callers should use `dedupe_status`, `related_items`, and `/query` to merge/update/link at the agent/workflow layer.
- Keep `/brief-guide` documented as a consumer path, not the core identity.

**Patterns to follow:**
- Existing concise README and skill language.

**Test scenarios:**
- Test expectation: none, docs-only.

**Verification:**
- `npm run build` confirms bundled skill/docs-adjacent files still compile/copy.

## System-Wide Impact

- **Interaction graph:** `/ingest` response gains optional related corpus evidence; `/query` empty-normalized behavior becomes explicit.
- **Error propagation:** No new external failures; related lookup should be best-effort SQL over local indexed data.
- **State lifecycle risks:** No extra writes beyond existing analysis/indexing. Exact duplicates remain content-hash based.
- **API surface parity:** HTTP API and installed skill docs must describe the new response field.
- **Integration coverage:** Server tests should exercise `/ingest` and `/query` through the real HTTP stack.
- **Unchanged invariants:** Loopback auth, idempotency, SSRF protections, and Flue analysis boundary remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| FTS related results are noisy | Bound results, use conservative term extraction, and frame as hints for the calling agent |
| API response change surprises callers | Additive field only; existing fields remain unchanged |
| Migration breaks existing DBs | Use additive schema-free query logic where possible; avoid migration unless necessary |

## Documentation / Operational Notes

- Update the general skill contract so agents know Reading Memory is a corpus substrate with capture hygiene, not a note app and not a brief-only helper.

## Sources & References

- External comparison: `https://airskills.ai/chrismdp/capture`
- General skill: `.agents/skills/use-reading-memory/SKILL.md`
- Ingest implementation: `src/reading/item-store.ts`
- Query implementation: `src/reading/corpus-query.ts`
