# P2: Tighten Kazan-facing API contracts

Priority: P2
Status: implemented
Source: ce:review 2026-05-03
Plan: docs/plans/2026-05-03-feat-kazan-mini-reading-memory-plan.md

## Finding
Kazan needs stable machine contracts for branching, retries, citations, dedupe, and debug retrieval.

## Required Work
- Define `dedupe_status` enum.
- Define `GET /items/:id` shape.
- Keep `/capabilities` minimal but machine-readable.
- Add `RATE_LIMITED` / retry-after fields.
- Use inline citation markers in `/query` answers matching `citations` array.
- If list endpoints exist, add cursor pagination.
- Remove trusted `caller` request field.

## Acceptance Criteria
- Kazan can branch on stable enums/errors without parsing prose.
- Query citations are programmatically checkable.
