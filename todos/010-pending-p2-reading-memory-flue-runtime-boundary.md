---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, architecture, flue, reading-memory]
dependencies: []
---

# Resolve Flue versus deterministic analysis boundary

## Problem Statement

The branch contains Flue agent/session scaffolding, but runtime ingest uses deterministic keyword analysis. That mismatch can mislead operators and future agents about the quality and behavior of analysis output.

## Findings

- `src/api/server.ts:48` calls local `analyzeItem`.
- `src/reading/analyzer.ts:38` reports `model: 'deterministic-v1'`.
- `.flue/agents/reading.ts` and `src/db/sqlite-session-store.ts` exist but are not wired.
- `src/db/schema.sql:66` includes a `sessions` table that is unused by the current runtime.

## Proposed Solutions

### Option 1: Wire Flue behind a narrow adapter

**Approach:** Keep persistence/query independent, but call Flue at the `analyzeItem` boundary with validation and fallback.

**Pros:** Matches intended architecture.

**Cons:** Requires runtime/tooling validation and failure handling.

**Effort:** Medium

**Risk:** Medium

### Option 2: Make V1 explicitly deterministic

**Approach:** Remove unused Flue/session scaffolding from this branch and document Flue as follow-up.

**Pros:** Smaller, honest V1.

**Cons:** Defers LLM judgment.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/api/server.ts`
- `src/reading/analyzer.ts`
- `.flue/agents/reading.ts`
- `src/db/sqlite-session-store.ts`
- `src/db/schema.sql`
- `package.json`

## Acceptance Criteria

- [ ] Runtime behavior and docs agree on deterministic versus Flue analysis.
- [ ] Unused Flue/session scaffolding is either wired or removed from V1.
- [ ] If Flue is wired, failures produce typed API errors and no partial DB writes.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Consolidated architecture and simplicity findings.

**Learnings:**
- Experimental scaffolding should not imply production behavior.

