---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, agent-native, api-contract, reading-memory]
dependencies: []
---

# Simplify and document agent-facing contracts

## Problem Statement

The API surface is usable but harder for agents than it needs to be: ingest has two discriminators, several endpoints are undocumented, and `/capabilities` does not expose the actual machine contract.

## Findings

- `src/api/contracts.ts` models `source_type` and `source.type`.
- `src/api/server.ts:124` normalizes missing `source.type`, but mismatches remain possible.
- README documents health/capabilities/ingest but not `/query`, `/brief-guide`, `/items/:id`, or `/activity`.
- `src/api/server.ts:165` returns limits but not endpoint schemas.

## Proposed Solutions

### Option 1: Keep only top-level `source_type`

**Approach:** Make source payload shape depend on `source_type`; remove `source.type` and normalization.

**Pros:** Matches AGENTS guidance and reduces agent mistakes.

**Cons:** Requires schema refactor.

**Effort:** Medium

**Risk:** Low

### Option 2: Keep only nested `source.type`

**Approach:** Remove top-level `source_type`.

**Pros:** Standard discriminated union shape.

**Cons:** Conflicts with current plan/README direction.

**Effort:** Medium

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/api/contracts.ts`
- `src/api/server.ts`
- `README.md`
- `AGENTS.md`

## Acceptance Criteria

- [ ] Ingest has exactly one discriminator.
- [ ] README includes examples for `/query`, `/brief-guide`, and `/items/:id`.
- [ ] `/activity` is documented as ops/debug or removed from public agent surface.
- [ ] `/capabilities` either exposes endpoint schemas or README/AGENTS clearly own that contract.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured simplicity and agent-native review findings.

**Learnings:**
- Agent-native APIs should remove fields that can disagree rather than normalize around them.

