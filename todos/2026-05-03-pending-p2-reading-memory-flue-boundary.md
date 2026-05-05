# P2: Keep Flue behind an explicit boundary

Priority: P2
Status: implemented
Source: ce:review 2026-05-03
Plan: aboutaaron/kazan-workspace:docs/plans/2026-05-03-feat-kazan-mini-reading-api-plan.md

## Finding
Flue is experimental. The implementation should not let Flue APIs leak through HTTP, persistence, query, or ingestion code.

## Required Work
- Flue owns agent/session orchestration and structured LLM calls only.
- Plan-owned modules own auth, HTTP contracts, ingestion, normalization, dedupe, SQLite, and query.
- Core stores below `analyze-item` output boundary should not import Flue APIs.
- Treat `SESSIONS` as opaque Flue state; corpus tables are canonical.

## Acceptance Criteria
- Replacing Flue analysis calls would not require rewriting persistence/query/ingest modules.
