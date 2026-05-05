---
status: implemented
priority: p2
issue_id: "007"
tags: [code-review, data-integrity, sqlite, migrations, reading-memory]
dependencies: []
---

# Validate migrations and recover FTS projections

## Problem Statement

The v0 migration path can stamp an incompatible existing database as current, and the FTS projection has no startup reconciliation if rows go missing.

## Findings

- `src/db/connection.ts:41` treats any `user_version = 0` database as eligible for `CREATE TABLE IF NOT EXISTS`.
- `CREATE TABLE IF NOT EXISTS` skips incompatible existing tables but `PRAGMA user_version = 1` is still set.
- `src/reading/corpus-query.ts:7` depends entirely on `item_fts`.
- `src/reading/item-store.ts:132` rebuilds FTS only for the current item.

## Proposed Solutions

### Option 1: Validate v0 schema and reconcile FTS at startup

**Approach:** Fail if app tables already exist with missing required columns/indexes; add a rebuild/reconcile step for `item_fts`.

**Pros:** Prevents silent broken DB states.

**Cons:** Adds startup checks.

**Effort:** Medium

**Risk:** Medium

### Option 2: Only support empty DB creation in V1

**Approach:** If `user_version = 0` and any app table exists, fail with recovery instructions.

**Pros:** Simple and safe for V1.

**Cons:** Manual recovery for partial DBs.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/db/connection.ts`
- `src/db/schema.sql`
- `src/reading/item-store.ts`
- `src/reading/corpus-query.ts`

## Acceptance Criteria

- [ ] Incompatible pre-existing v0 DB fails loudly before serving.
- [ ] Missing FTS rows are rebuilt or a repair command exists.
- [ ] Tests cover partial schema and missing FTS recovery/failure.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - Implemented

**By:** Kazan

**Actions:**
- Added v0 schema guard so a database with existing app tables cannot be stamped current by `CREATE TABLE IF NOT EXISTS`.
- Added FTS reconciliation from canonical `items`/`analyses`/`tags` tables at database open.
- Added regression tests for incompatible partial schema and missing FTS row recovery.

**Verification:**
- `npm test` passed 17/17.
- `npm run build` passed.
- Temp localhost smoke test passed with `READING_API_TOKEN=dev-secret`.

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured data-integrity review findings.

**Learnings:**
- Idempotent schema blobs are not a substitute for compatibility checks.
