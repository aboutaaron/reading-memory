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

### Weak lexical matches

All query modes accept `lexical_policy: "any" | "all"`. The default `any` preserves the existing behavior: first require every extracted search term, then retry with OR if no item matches them all. Set `all` to disable the OR fallback. This applies before the lexical candidate limit, including usage ranking and hybrid's provider fallback. It can reduce incidental keyword matches but miss useful sources when a question contains words the source does not use. It is a recall/precision control, not automatic answer abstention.

Results expose `lexical_match` (`all_terms`, `partial_terms`, or `not_selected`), `lexical_coverage` (fraction of extracted terms matched), and `weak_match` (true for partial lexical matches). Semantic-only candidates have null coverage and weak-match values because their lexical coverage was not measured; absence from the selected lexical candidates does not prove zero word overlap. The response reports the applied `lexical_policy` even when empty or falling back.

In hybrid mode, `all` restricts only lexical candidates: semantic neighbors can still be returned. Neither full term coverage nor a vector match proves a passage answers the question. Read retained source text, verify each claim, and decline to answer from the memory when evidence is insufficient.

When embeddings are available, prior-source analysis context and ingest-related-item hints can also include vector neighbors. Existing source quotation validation still applies to model relationships. A vector neighbor does not imply contradiction, agreement or reader endorsement.

### Optional relationship graph

Request `mode: "hybrid+graph"` to expand hybrid results through existing SQLite source relationships. No separate graph database, migration or provider call for traversal is required. It uses the same query embedding path as hybrid, and remains opt-in. `lexical_policy` and date/tag filters apply as usual.

For a requested `top_k`, the graph budget is `min(2, floor(top_k / 2))`. The first `top_k - budget` direct candidates retain their order. Up to three of those candidates can seed one-hop expansion when they match every extracted lexical term or have a semantic match passing the existing distance guard. Partial lexical-only matches cannot seed expansion. At `top_k: 5`, this reserves three direct positions and at most two graph positions; unused graph positions are filled with remaining direct candidates. At `top_k: 1`, no expansion occurs.

Each seed considers at most 100 relationship candidates ordered by relationship ID; one extra row detects truncation. Only model-origin `supports`, `contradicts`, `extends`, `duplicates_angle`, `related` and `updates` edges qualify. Both endpoints must be indexed, the neighboring item must satisfy the same date/tag filters, and both nonempty quotations must occur exactly in current retained source text. Malformed evidence, heuristic theme links and second-hop traversal are excluded. Results are deduplicated. The bounded deterministic edge order is not a query-relevance ranking; it may miss a useful connection beyond the scan or result budget.

Every result has `retrieval_origin` (`direct` or `graph`) and `direct_rank` (its base-retrieval rank, or null). Graph additions have a null score and include `graph.seed_item_id`, relationship ID, original `from_item_id`/`to_item_id`, incoming/outgoing direction relative to the seed, type, explanation, model origin/confidence, and both quotations. A lower-ranked direct candidate can be promoted through a graph edge, retaining its original `direct_rank`. Graph scores are not comparable to direct ranking scores. `relationship_verification: "unverified"` distinguishes a proposed interpretation from the exact-quotation provenance check.

`requested_mode` is `hybrid+graph`. `base_retrieval_mode` reports `hybrid` or `fts`; actual `retrieval_mode` is correspondingly `hybrid+graph` or `fts+graph`, including when no edges qualify. Embedding fallback retains its explicit reason and can still expand qualifying lexical seeds. `fts+graph` is a reported fallback mode, not a separate accepted request mode. `graph_expansion` reports seed IDs, result/scan limits, added results, `considered_edges` (candidates checked by traversal after SQL selection) and `scan_truncated`.

Forget removes connected edges; reanalysis replaces outgoing model relationships. Query traversal checks current text after query embedding completes, so deleted sources and invalidated quotations cannot be used. A target's reanalysis need not remove incoming edges when its retained source text still supports their quoted provenance. Exact quotations prove passage presence, not the truth of a relationship or support for an answer. Open both sources before using an edge to claim agreement or contradiction.

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

The expanded evaluation also tests lexical-policy tradeoffs and bounded graph context. Passing a fixture that records lost strict-policy recall makes that tradeoff explicit; it does not demonstrate improved quality. Follow the [OpenClaw retest protocol](OPENCLAW-RETEST.md) for a paired private-corpus comparison and a separate answer-support audit.

Implementation references: [sqlite-vec Node bindings](https://alexgarcia.xyz/sqlite-vec/js.html), [sqlite-vec KNN behavior](https://alexgarcia.xyz/sqlite-vec/features/knn.html), and [Node SQLite extension loading](https://nodejs.org/api/sqlite.html#databaseloadextensionpath-entrypoint).
