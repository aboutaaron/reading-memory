# P1: Simplify Reading Memory V1 scope before implementation

Priority: P1
Status: implemented
Source: ce:review 2026-05-03
Plan: docs/plans/2026-05-03-feat-kazan-mini-reading-memory-plan.md

## Finding
The original plan overbuilt V1 with event-sourcing, chunks, multiple ingest endpoints, and complex relationship machinery.

## Required Work
- Use one `POST /ingest` endpoint with `source_type`.
- Synchronous-only V1 with 60s budget.
- Activity log, not event-sourcing.
- No chunks table in V1.
- No arbitrary local PDF path ingestion.
- Defer batch ingestion and complex graph maintenance.
- Tests ship with each phase, not deferred.

## Acceptance Criteria
- Implementation follows Phase 0-3 simplified plan.
- No background async/polling contract exists in V1.
- No unused V1 tables for chunks or brief feedback.
