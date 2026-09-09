# Optional hybrid retrieval

Full-text search remains the default. Hybrid mode combines lexical candidates with semantic vector neighbors using reciprocal rank fusion (`1 / (60 + rank)` per list). Each list contributes at most 25 candidates. Date, tag, indexed-status and current-model/current-analysis filters apply before the vector candidate limit. A candidate appearing in both lists appears once.

## Configuration

Set `READING_API_EMBEDDING_MODEL=openai/text-embedding-3-small` in the service environment to enable embeddings. The default is `off`. Embeddings share the OpenAI analysis provider's `OPENAI_API_KEY` and optional `OPENAI_BASE_URL`; the analysis model may independently use another supported provider. Other OpenAI-compatible embedding models must accept the dimensions parameter and return 1,536 numbers. Anthropic embeddings are not supported by this adapter.

Enabling this option sends a bounded source context for prior-item lookup and a bounded title/summary/claims projection after analysis to the configured provider. Hybrid queries send the query text. It does not send the reader-annotation history as embedding input. Stored vectors are normalized float32 values and are never returned in item, ingest, query, replay or activity responses.

Optional embedding calls have a five-second ceiling and yield to the ingestion deadline. Failures do not turn a completed analysis into failed ingestion. Items remain available through full-text search and are eligible for embedding backfill. Existing idempotent retries do not repeat provider calls.

## Query contract

Use the ordinary authenticated `/query` envelope with `mode: "hybrid"`:

```json
{
  "request_id": "1c9ee441-5529-4d9b-9ff9-e6c2498c62bd",
  "query": "purging obsolete memoized answers",
  "mode": "hybrid",
  "top_k": 5
}
```

`retrieval_mode` reports what actually ran. `requested_mode: "hybrid"` plus a non-null `fallback_reason` identifies lexical fallback (unavailable provider/extension, no compatible current embeddings, or a failed query embedding). `confidence` remains null for nonempty retrieval and zero for empty results; `answer` stays empty.

Hybrid results expose `lexical_rank`, `vector_rank`, `cosine_distance` and matched lexical terms. Semantic-only hits can have no matched terms. Vector candidates require cosine distance at most 0.5. This threshold is a conservative, uncalibrated relevance guard, not a calibrated confidence score. It can miss useful reading and still admit irrelevant neighbors; inspect the retained source before making claims.

When embeddings are available, prior-source analysis context and ingest-related-item hints can also include vector neighbors. Existing source quotation validation still applies to model relationships. A vector neighbor does not imply contradiction, agreement or reader endorsement.

## Storage and maintenance

Schema v7 adds `item_embeddings`, an ordinary SQLite table linked to each item and its latest analysis, storing the model, dimensions, input digest and vector. Provider calls run outside write transactions; successful vectors persist with the corresponding analysis. Embedding generation or canonical-write failures leave a missing projection. A failed derived-index write preserves the canonical vector and disables vector retrieval on that connection; a later successful index rebuild can reuse the saved vector without another provider call. Reanalysis replaces or clears the projection; older analysis vectors cannot silently match the current model. Title maintenance invalidates outdated embeddings.

`item_vec` is a derived `vec0` virtual table. The service loads only the packaged sqlite-vec extension and then disables extension loading. Startup rebuilds the vector index from canonical rows. Extension/platform or rebuild failures leave the corpus and full-text retrieval usable; health reports the unavailable vector index. No model download or provider call happens during startup.

`/health.embeddings` reports whether embedding generation is enabled, the configured available model, dimensions, index availability and missing-item count. Item details expose `embedding_status` and `embedding_model` as metadata. Reconfigure the model and backfill to replace incompatible projections; no automatic corpus-wide paid backfill occurs.

With the same environment used by the service:

```bash
npm run backfill:embeddings -- --limit 25
npm run backfill:embeddings -- --limit 25 --apply
```

The default dry run opens the existing database read-only, reports item IDs, and makes no provider calls. Start the updated service first so schema migration has completed. `--apply` processes the selected batch sequentially; it sends the title/summary/claims projection to the configured provider. Failed items remain eligible for retry. If an item is deleted, retitled or reanalyzed during provider work, the old result is discarded. `--db PATH` selects another existing corpus; `--limit` accepts 1–1,000. Maintenance output contains item IDs and outcomes, not source text or provider errors.

## Evaluation limits

The deterministic suite uses the real sqlite-vec extension with canned 1,536-dimensional vectors. It verifies paraphrase routing with zero lexical overlap, hard-negative abstention, pre-limit filtering, rank fusion, transaction/restart behavior, provider failure and API privacy. These fixtures test storage and retrieval contracts. They do not establish that a live embedding model improves this reader's recall, or measure live model quality, cost or latency. Keep hybrid opt-in until a private, representative reading evaluation demonstrates that improvement.

Implementation references: [sqlite-vec Node bindings](https://alexgarcia.xyz/sqlite-vec/js.html), [sqlite-vec KNN behavior](https://alexgarcia.xyz/sqlite-vec/features/knn.html), and [Node SQLite extension loading](https://nodejs.org/api/sqlite.html#databaseloadextensionpath-entrypoint).
