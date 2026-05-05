---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, security, ssrf, reading-memory]
dependencies: []
---

# Block DNS rebinding in URL fetches

## Problem Statement

`reading-memory` validates DNS results before calling native `fetch()`, but the actual request performs a second DNS resolution. This leaves a DNS rebinding/TOCTOU SSRF gap for authenticated URL ingestion.

## Findings

- `src/ingest/fetch-url.ts:45` validates resolver output.
- `src/ingest/fetch-url.ts:72` then calls `fetch(url, init)`, allowing Undici to resolve the hostname again.
- Existing tests cover private resolver output and redirect-to-private, but not validation/fetch split rebinding.

## Proposed Solutions

### Option 1: Pinned-address HTTP client

**Approach:** Use an HTTP client/Undici dispatcher that connects to a validated IP while preserving Host/SNI for TLS.

**Pros:** Strongest SSRF fix; keeps URL ingestion.

**Cons:** More implementation complexity around TLS and redirects.

**Effort:** Medium

**Risk:** Medium

### Option 2: Temporarily disable URL/PDF URL ingestion

**Approach:** Ship only `text` ingestion until fetch pinning is implemented.

**Pros:** Low risk; removes hostile network fetches from V1.

**Cons:** Reduces product usefulness.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/ingest/fetch-url.ts`
- `src/ingest/fetch-url.test.ts`
- `src/reading/extract-source.ts`

## Acceptance Criteria

- [ ] Actual socket connection uses the validated public address or URL ingestion is disabled.
- [ ] Regression test simulates DNS returning public during validation and private during fetch.
- [ ] Redirect validation keeps the same protection.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Consolidated findings from security, ops, learnings, and native Codex review.

**Learnings:**
- Preflight DNS validation is not enough unless the fetch socket is pinned.

