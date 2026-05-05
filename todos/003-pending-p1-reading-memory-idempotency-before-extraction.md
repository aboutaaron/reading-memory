---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, idempotency, reliability, reading-memory]
dependencies: []
---

# Check idempotency before external extraction

## Problem Statement

Idempotency replay is checked inside `ItemStore.ingest()` after URL/PDF/text extraction. Retries with the same `request_id` can repeat slow, expensive, or failing external work instead of returning the saved response.

## Findings

- `src/api/server.ts:42` calls `extractSource(...)`.
- `src/api/server.ts:43` only then enters `store.ingest(...)`.
- `src/reading/item-store.ts:35` checks idempotency after extraction has already completed.

## Proposed Solutions

### Option 1: Add store preflight

**Approach:** Compute `payloadHash(body)` after validation, check idempotency before extraction, and return replay/conflict immediately.

**Pros:** Correct retry semantics; avoids repeated network/PDF work.

**Cons:** Exposes another store method.

**Effort:** Small

**Risk:** Low

### Option 2: Move extraction into store transaction boundary

**Approach:** Let `ItemStore` own the full ingest flow.

**Pros:** Single orchestration point.

**Cons:** Mixes IO/extraction with persistence and complicates transactions.

**Effort:** Medium

**Risk:** Medium

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/api/server.ts`
- `src/reading/item-store.ts`
- `src/api/server.test.ts`

## Acceptance Criteria

- [ ] Same `request_id`/payload returns saved response before URL/PDF fetch.
- [ ] Same `request_id`/different payload returns conflict before URL/PDF fetch.
- [ ] Regression test proves extraction is not called for replay/conflict.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured ops/architecture finding as P1 due retry correctness and external IO risk.

**Learnings:**
- Idempotency needs to guard side effects, not just database writes.

