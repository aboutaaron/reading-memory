---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, api-contract, query, reading-memory]
dependencies: []
---

# Fix query and brief-guide edge cases

## Problem Statement

Several normal user-input paths return incorrect results or 500s: punctuation-only queries generate invalid FTS syntax, tag/focus filtering happens after SQL limits, and `brief_date` is echoed without anchoring the lookback window.

## Findings

- `src/reading/corpus-query.ts:6` falls back to `MATCH '*'`, which FTS5 rejects.
- `src/reading/corpus-query.ts:24` filters tags after `LIMIT`.
- `src/reading/brief-guide.ts:5` uses `Date.now()` instead of `input.briefDate`.
- `src/reading/brief-guide.ts:23` filters focus after `LIMIT 25`.

## Proposed Solutions

### Option 1: Push filters and anchors into SQL

**Approach:** Return an empty response for empty normalized terms, apply tag/focus filters in SQL, and compute lookback from `briefDate`.

**Pros:** Correct and predictable API behavior.

**Cons:** Requires SQL/test updates.

**Effort:** Medium

**Risk:** Low

### Option 2: Reject unsupported inputs explicitly

**Approach:** Return 400 for punctuation-only queries and non-current `brief_date`.

**Pros:** Smaller change.

**Cons:** Less useful for backfills and scheduled briefs.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/reading/corpus-query.ts`
- `src/reading/brief-guide.ts`
- `src/api/server.test.ts`

## Acceptance Criteria

- [ ] Punctuation-only query returns a typed empty result or 400, not 500.
- [ ] Tag filters are applied before limiting candidate rows.
- [ ] `brief_date` either anchors selection or unsupported dates are rejected.
- [ ] Focus filters do not hide valid candidates due pre-filter limit.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - Native Codex + CE Review

**By:** Kazan

**Actions:**
- Captured native Codex review and data/simplicity findings.

**Learnings:**
- Agent-facing APIs need predictable empty/error envelopes for ordinary malformed user input.

