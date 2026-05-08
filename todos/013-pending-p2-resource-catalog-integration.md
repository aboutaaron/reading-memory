# Decide Resource Catalog Integration

## Status

Pending.

## Problem

Some callers keep a lightweight resource catalog such as `memory/resources.md` for URL pointers, keywords, and "where did I see this?" lookup. Reading Memory stores extracted content, reading judgment, provenance, and relationships. Those are different jobs, but the caller boundary is easy to blur.

## Decision To Make

Decide whether a command like `/add-resource` should also call `POST /ingest`, or whether it should stay catalog-only by default.

## Recommended Default

Keep `/add-resource` separate by default. Let it call `POST /ingest` only when the caller has a clear durable-reading signal, such as:

- the user explicitly asks to remember or use the source later
- the link is a substantive article, paper, post, PDF, or newsletter
- the source adds evidence for an active research theme
- the caller needs future recall, brief prep, or synthesis from the extracted content

## Acceptance Criteria

- Document the caller policy wherever `/add-resource` lives.
- If ingestion is added, make it opt-in or judgment-gated rather than automatic for every URL.
- Preserve idempotency by querying Reading Memory or relying on `dedupe_status` and `related_items`.
- Keep the resource catalog useful as a pointer list even when Reading Memory is unavailable.
