---
status: completed
priority: p2
issue_id: "013"
tags: [dedupe, ingestion, reading-memory, source-identity]
dependencies: []
---

# Dedupe text captures by canonical source identity

Completed on branch `feat/reading-memory-trust-resurfacing`.

## Problem Statement

Reading Memory can store duplicate items when the same article is captured as newsletter text from different contexts. Exact normalized content hash dedupe works, but wrappers and excerpts change the hash. If text ingests do not preserve a `source_uri` or canonical article URL, the store has no stable source identity to collapse.

Observed on 2026-05-11 with The Leverage's "In Defense of AI Slop":

- `item_e20ccee710134960` from `morning_brief_2026-05-08_newsletter`
- `item_491b9abf24ef40e0` from `morning_email_digest_2026-05-10`

Both represent the same article, but both were `source_type: text`, `source_uri: null`, with different content hashes due to capture context.

## Proposed Solution

Prefer canonical article identity before falling back to content hash:

1. Make callers extract and pass durable article URLs from newsletter captures when present.
2. For text captures, infer a canonical URL from common lines like "View this post on the web at ...".
3. Treat same canonical URL as the same source; return `existing` or `content_changed` instead of creating an unrelated duplicate.
4. When canonical URL is unavailable, surface high-confidence duplicate candidates from title plus publisher/link evidence so the caller can avoid saving another copy.

## Acceptance Criteria

- [x] Ingesting two text captures containing the same article URL does not produce two independent search results.
- [x] Existing content-hash dedupe behavior still works.
- [x] A same-source-but-changed-content capture reports `content_changed` and links to the prior item via `supersedes_item_id`.
- [x] Query results for a duplicated title prefer the current/canonical item or clearly group duplicates.
- [x] `npm test` and `npm run build` pass.
