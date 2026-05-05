# P2: Keep query and relationships minimal and durable

Priority: P2
Status: implemented
Source: ce:review 2026-05-03
Plan: aboutaaron/kazan-workspace:docs/plans/2026-05-03-feat-kazan-mini-reading-api-plan.md

## Finding
Relationship generation can pollute the corpus or slow ingestion if treated as a hot-path graph-building task.

## Required Work
- Add FTS5 as rebuildable projection over item text + analysis summaries.
- Cap relationship candidate retrieval and persisted relationship count.
- Persist only confidence >= 0.70.
- Prevent duplicate/inverse duplicate relationships.
- Defer dedicated `connect-items` skill unless usage proves need.

## Acceptance Criteria
- Query returns cited useful results.
- Re-analysis/retry does not create duplicate relationship rows.
