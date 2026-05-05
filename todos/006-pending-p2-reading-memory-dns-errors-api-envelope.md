---
status: implemented
priority: p2
issue_id: "006"
tags: [code-review, api-errors, url-ingest, reading-memory]
dependencies: ["001"]
---

# Normalize DNS failures into API errors

## Problem Statement

DNS lookup failures from URL ingestion currently escape as generic exceptions, producing `INTERNAL_ERROR`/500 instead of the documented `FETCH_FAILED` response.

## Findings

- `src/ingest/fetch-url.ts:45` awaits `resolver(...)` without wrapping resolver errors.
- Native Codex reproduced `EAI_AGAIN` for an unresolvable hostname.

## Proposed Solutions

### Option 1: Wrap resolver errors

**Approach:** Catch lookup failures in `assertPublicHttpsUrl` and throw `ApiError('FETCH_FAILED', ...)`.

**Pros:** Small, clear, aligned with contract.

**Cons:** Needs care to avoid hiding programming errors from custom resolvers in tests.

**Effort:** Small

**Risk:** Low

### Option 2: Validate URL hostnames earlier

**Approach:** Add a hostname validation layer before DNS lookup.

**Pros:** Cleaner client errors for malformed inputs.

**Cons:** Does not replace wrapping transient DNS failures.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/ingest/fetch-url.ts`
- `src/ingest/fetch-url.test.ts`

## Acceptance Criteria

- [ ] DNS NXDOMAIN/transient failures return `FETCH_FAILED`, not `INTERNAL_ERROR`.
- [ ] Test covers resolver rejection.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - Implemented

**By:** Kazan

**Actions:**
- Wrapped resolver failures in `assertPublicHttpsUrl` as retryable `FETCH_FAILED` errors.
- Added regression coverage for resolver rejection with an `EAI_AGAIN`-style failure.

**Verification:**
- `npm test` passed 15/15.
- `npm run build` passed.

### 2026-05-04 - Native Codex Review

**By:** Kazan

**Actions:**
- Captured native Codex review finding.

**Learnings:**
- User-supplied URL resolution failures are API-domain errors, not server crashes.
