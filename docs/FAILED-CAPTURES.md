# Inspect and recover failed captures

Failed items are excluded from retrieval. The diagnostic inventory is read-only: it neither calls a provider nor retries a capture. It can explain newly recorded failures using safe error codes. Older activity records usually contain only an exception class, which cannot identify a cause; these remain `unknown`.

## Inventory on an isolated snapshot

1. Make a private, WAL-safe backup and start an isolated service against its copy, following `docs/OPENCLAW-RETEST.md`. Record the tested commit, analysis model, embedding configuration, and failed-item count. Keep production unchanged during diagnosis.
2. Call authenticated `GET /items?status=failed&limit=25&offset=0`, or the MCP `list_failed_items` tool with `limit: 25, offset: 0`. The response contains `items`, the full `total`, and `next_offset`. Follow `next_offset` until it is null. Limits are 1–100; offsets are nonnegative safe integers.
3. Finish the inventory before retrying or deleting items. Pages sort by capture/attempt time and item ID. Each page has a consistent count, but offset pagination is not a snapshot across requests: changes between pages can shift rows. For a fresh inventory after changes, restart at offset 0.
4. Inspect selected records through the existing authenticated item-read endpoint when needed. This inventory omits extracted text, arbitrary error messages, and provenance. Treat its source URLs and titles as private metadata too; do not post a corpus inventory to GitHub.

`retained_text` reports whether stored extracted text is nonempty. `failure_stage: analysis` means a durable `ingest.analysis_failed` event exists, not that a particular model is defective. The latest failure supplies an allowlisted API code, its recorded retryability, timestamp, and request ID when available. Unknown or malformed legacy metadata is never promoted to a retryable cause.

| Diagnostic | Next step |
| --- | --- |
| `retry_disposition: retryable` | Inspect the recorded code and original response; address transient provider/configuration problems, then try one bounded retry. |
| `retry_disposition: not_retryable` | Inspect and correct the cause before attempting another capture. Do not blindly loop on validation, MIME, authorization, or size failures. |
| `retry_disposition: unknown` | Inspect the original caller response and service configuration. Do not infer a cause from an old exception class or assume upgrading the model will fix it. |
| `recovery: retry_original_ingest` | Text remains stored, but failed items still recover through the original ingest contract. Recover the original request before retrying. |
| `recovery: recapture_original_source` | No usable text is retained. Locate the original source/request; report missing source material when it cannot be recovered. |
| `recovery: inspect_failure` | The recorded error was not retryable. Investigate before choosing a recovery action. |

The recovery field describes a possible manual route, not an automatic command or a guarantee of success. A retained text flag does not prove the source was fully extracted. Review `truncated` and source provenance on the item read if completeness matters.

## Retry through the existing ingest contract

Use `POST /ingest` with the original `source_type`, source payload, optional title, `source_context`, and `ingest_reason`. Use the original request ID when retrying the same request and keep its payload unchanged. The diagnostic request ID does not reconstruct the original payload; obtain that from the capturing agent or its private records. If it is unavailable, investigate before preparing an intentional new capture.

For `url` and `pdf_url`, re-fetch the original source through that source type. Do not submit the retained excerpt as a new `text` source: doing so can change the content hash, source identity, extraction completeness, and provenance. For `text`, use the original submitted text rather than assuming the stored text is an exact substitute: normalization, redaction, and truncation can prevent reconstructing the original request.

When extraction yields the same content hash, ingestion retries analysis on the existing failed item and preserves its item ID and stored source metadata/provenance. The attempt timestamp can advance. When a remote source has changed, ingestion can create a new superseding item instead; record both IDs and the changed-content outcome. Do not delete the old failed item merely to make the failure count disappear.

`POST /items/:id/reanalyze` accepts indexed items; it is not the failed-ingest recovery endpoint. There is no new mutation endpoint in this work. Respect normal ingest rate limits and the retry guidance from each response. Start with one or a few selected records and stop repeating a failure without investigating it.

If a retry returns `ITEM_FORGOTTEN`, stop. Never replace its request ID automatically to bypass the deletion tombstone. A new request ID represents an explicitly intentional new capture.

## Verify and report

- Record attempted, recovered, changed-content, still-failed, and unavailable-source counts separately. Include the before/after failed count, item IDs for private follow-up, sanitized error codes, and unknown causes.
- For recovery with unchanged extracted content, verify the same item ID is now indexed, source type/URI and provenance still describe the original capture, and an appropriate FTS query retrieves it.
- When embeddings are enabled, inspect embedding status separately. Embedding failure must not turn a successfully analyzed item into an ingest failure.
- Capture failures during fetch/extraction can happen before any item is inserted. They are not counted by this failed-item inventory; examine the capturing agent's original failed requests too. Absence from this list is not proof that every attempted capture succeeded.
- Adding these diagnostics does not recover production records. Use a live inventory and a source-specific recovery pass to establish current outcomes.
