---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, security, observability, reading-memory]
dependencies: []
---

# Tighten minor security and observability gaps

## Problem Statement

Several lower-risk issues remain after the core blockers: bearer comparison exits early on token length, `/health` is safe only while loopback remains enforced, and logs/activity are too thin for operating failures.

## Findings

- `src/api/auth.ts:22` checks token length before `timingSafeEqual`.
- `src/api/server.ts:28` exposes unauthenticated health details.
- `src/index.ts:10` logs startup/shutdown only.
- `src/reading/item-store.ts:245` logs ingest activity but not request failures/latency.

## Proposed Solutions

### Option 1: Improve comparison and structured request logs

**Approach:** Hash both supplied/expected tokens before constant-time comparison; add metadata-only request logs with status/error/latency/source_type.

**Pros:** Better defense and operations without major behavior changes.

**Cons:** More log volume.

**Effort:** Small

**Risk:** Low

### Option 2: Keep as runbook caveat

**Approach:** Document that health is unauthenticated only because host binding is loopback-only.

**Pros:** Minimal code.

**Cons:** Leaves observability thin.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/api/auth.ts`
- `src/api/server.ts`
- `src/index.ts`
- `README.md`

## Acceptance Criteria

- [ ] Token verification avoids observable length-branch comparison where practical.
- [ ] Health exposure is documented and covered by host-binding tests.
- [ ] Request failure/latency logs contain metadata only, never body/extracted text.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured low-severity security and ops findings.

**Learnings:**
- Loopback lowers risk but should not become the only line of defense.

