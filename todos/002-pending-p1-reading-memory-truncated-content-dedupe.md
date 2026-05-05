---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, data-integrity, dedupe, reading-memory]
dependencies: []
---

# Hash full content before truncation

## Problem Statement

The dedupe key is computed from truncated extracted text. Two long inputs with the same first 100k normalized characters but different tails collapse into one item, losing distinct content.

## Findings

- `src/ingest/normalize-content.ts:11` truncates normalized content.
- `src/reading/extract-source.ts` stores `contentHash` from that truncated text.
- `src/reading/item-store.ts:45` dedupes by `content_hash`.
- `src/db/schema.sql:19` enforces `UNIQUE (content_hash)`.

## Proposed Solutions

### Option 1: Separate full-content and indexed-text hashes

**Approach:** Compute `content_hash` from the full normalized/redacted content before truncation; optionally persist an `indexed_text_hash` for the stored truncated projection.

**Pros:** Preserves dedupe correctness and keeps bounded indexed text.

**Cons:** Requires schema and tests.

**Effort:** Medium

**Risk:** Medium

### Option 2: Reject over-limit content

**Approach:** Stop accepting content beyond `LIMITS.maxExtractedChars`.

**Pros:** Simple and safe.

**Cons:** Less useful for long articles/PDFs.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/ingest/normalize-content.ts`
- `src/reading/extract-source.ts`
- `src/db/schema.sql`
- `src/reading/item-store.test.ts`

## Acceptance Criteria

- [ ] Full normalized/redacted content drives dedupe identity.
- [ ] Stored/indexed text may still be truncated safely.
- [ ] Test covers two over-limit inputs sharing a prefix but differing after the limit.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured data-integrity review finding as P1.

**Learnings:**
- Truncation must be a projection decision, not identity semantics.

