# P1: Reading Memory data integrity and idempotency

Priority: P1
Status: implemented
Source: ce:review 2026-05-03
Plan: aboutaaron/kazan-workspace:docs/plans/2026-05-03-feat-kazan-mini-reading-api-plan.md

## Finding
SQLite must enforce integrity at the store layer. Idempotency and dedupe cannot rely on caller discipline or prose contracts.

## Required Work
- Enable WAL, busy_timeout, and `PRAGMA foreign_keys = ON`.
- Use `PRAGMA user_version` migrations.
- Implement `idempotency_keys` with 7-day TTL and payload hash.
- Hash normalized extracted text for all source types.
- Keep raw bytes hash separate from dedupe key.
- Use one DB transaction for item + analysis + tags + relationships + idempotency + activity log.
- Add relationship uniqueness constraints / canonical ordering for symmetric relations.

## Acceptance Criteria
- Replay same request returns saved response.
- Conflicting replay returns `IDEMPOTENCY_CONFLICT`.
- Failed write leaves no partial item/analysis/log split.
- Duplicate content across URL/text dedupes by normalized text hash.
