---
status: pending
priority: p2
issue_id: "004"
tags: [code-review, security, reliability, pdf, reading-memory]
dependencies: []
---

# Isolate or defer PDF parsing

## Problem Statement

PDF parsing happens inside the main Node process and does not receive an abort signal. A crafted or expensive PDF can block the event loop despite the 60-second wrapper.

## Findings

- `src/api/server.ts:42` wraps extraction in `withTimeout`.
- `src/ingest/extract-pdf.ts:10` calls `pdfParse(Buffer.from(bytes))`.
- The page-count check happens after parsing at `src/ingest/extract-pdf.ts:11`.

## Proposed Solutions

### Option 1: Worker/child process parser

**Approach:** Run PDF extraction in an isolated worker or child process with a hard timeout and memory limit.

**Pros:** Keeps PDF ingestion with bounded blast radius.

**Cons:** More moving parts.

**Effort:** Medium

**Risk:** Medium

### Option 2: Remove PDF URL support from V1

**Approach:** Disable `pdf_url` until a sandboxed parser exists.

**Pros:** Small, safe V1.

**Cons:** Defers a desired source type.

**Effort:** Small

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `src/ingest/extract-pdf.ts`
- `src/reading/extract-source.ts`
- `src/api/contracts.ts`
- `README.md`

## Acceptance Criteria

- [ ] PDF parsing cannot block the main API process indefinitely, or `pdf_url` is disabled.
- [ ] Timeout behavior is tested.
- [ ] README and `/capabilities` match the shipped support.
- [ ] `npm test` and `npm run build` pass.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Captured security review DoS finding.

**Learnings:**
- An async timeout wrapper cannot preempt CPU/event-loop blocking parser work.

