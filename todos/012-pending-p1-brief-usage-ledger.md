# P1: Add brief usage ledger and resurfacing controls

## Problem

Morning brief prep can re-select stale newsletter items when old emails remain in the inbox. The current `/brief-guide` endpoint ranks recent Reading Memory ingests, but it does not know whether an item or substantially similar source was already included in a previous brief.

## Goal

Make Reading Memory track what has already been used in a brief, what was skipped, why, and when an item may resurface.

## Scope

- Add a `brief_events` table or equivalent persisted ledger with:
  - `item_id`
  - `brief_date`
  - `included_bool`
  - `rationale`
  - `source_context`
  - `created_at`
- Add an API path for the calling agent to record brief outcomes after delivery.
- Update `/brief-guide` to downrank or exclude recently included items unless:
  - the item has materially changed,
  - the candidate adds a new angle,
  - the same source is part of an ongoing story worth tracking.
- Include skip/resurface rationale in `/brief-guide` output.
- Add tests for stale inbox/newsletter reuse prevention.

## Acceptance Criteria

- A candidate included in yesterday's brief is not recommended again today by default.
- A skipped item can remain eligible if the rationale says it is still developing or needs a better hook.
- Repeated content with the same `content_hash` is deduped before recommendation.
- The morning brief caller can record delivered brief outcomes without Reading Memory sending the brief itself.
