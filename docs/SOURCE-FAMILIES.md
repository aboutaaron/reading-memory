# Source families in graph retrieval

`hybrid+graph` selects distinct source families so repeated captures of one source do not occupy several evidence slots. Ordinary `fts`, `fts+usage` and `hybrid` behavior stays unchanged. No item, analysis, relationship or embedding is deleted or rewritten by retrieval.

For each capture, the family resolver prefers a valid HTTP(S) `canonical_url`, then `final_url`, then `source_uri`. It uses the URL parser's normalized URL and preserves the scheme, path, query parameters and fragment. It does not remove presumed tracking parameters, merge related domains, equate HTML/PDF paths or strip article versions. Captures in different formats can share a family when their stored source URLs identify the same source.

Primary-URL equality and explicit `supersedes_item_id` links compose into connected families in both directions. For example, an original at URL A, its revision at URL B, and another capture at URL B share one family, regardless of lookup order. All members must be indexed and satisfy the query's date and any-of tag filters. Forgotten, failed and filtered members supply no identity evidence. The resolver reads at most 4,097 identity rows to detect a 4,096-row visible-snapshot bound. Complete components have at most 32 members; cyclic or larger components fall back to individual capture identity. When the visible snapshot exceeds its bound, direct primary-URL matching still works through indexed per-item lookups, but cross-URL lineage resolution is skipped. Both bounded fallbacks are labeled explicitly. A capture without a usable URL or explicit visible lineage remains separate.

Shared titles, extracted teasers, byte hashes and model `duplicates_angle` labels do not establish source identity. Two different URLs remain separate unless explicit lineage connects them. This conservative rule can miss duplicates: distinct URL variants and cross-format versions need matching source provenance or explicit lineage. Family IDs can change after forgetting, metadata changes or filtering; they are retrieval metadata, not durable IDs for external storage.

## Selection and response metadata

1. Fetch the existing bounded hybrid candidate pool (at most 25 items).
2. Retain the highest-ranked representative of each family, preserving relative rank order. Reserve the existing graph budget and select up to three eligible seeds from retained direct results.
3. Follow the existing one-hop, quote-validated model relationships. Skip peers whose families are already represented, respecting existing filters and edge scan limits.
4. Fill unused result slots from the remaining direct candidate families. Do not exceed the requested result count, fetch an unbounded lexical pool or traverse more graph hops to fill a page.

Each graph-mode result has `source_family: { id, basis, resolution }`. The ID is an opaque SHA-256-derived identity; `basis` is `canonical_url`, `final_url`, `source_uri`, `explicit_lineage`, or `item`. `resolution` is `complete` or `bounded_fallback`. Bounded fallback may leave related versions in separate families and must not be treated as evidence of independence. No list of family members or ancestor IDs is returned.

`graph_expansion` adds:

- `family_policy: "distinct_sources"` and `base_candidate_limit: 25`.
- `suppressed_direct_family_candidates`: distinct direct candidate items skipped because an earlier candidate or selected graph result represents their family. The initial diversification scans the entire bounded direct pool, so this count can include candidates beyond the requested result count.
- `suppressed_graph_family_candidates`: distinct graph peer items skipped for an already represented family after passing relationship and quotation checks. Repeated edges to the same skipped peer count once. An already selected identical item is handled by item deduplication and does not increment this counter.

Suppression counters do not disclose suppressed item IDs or source content. Graph relationship metadata continues to identify the selected seed and selected peer so both can be inspected. A short page is possible when the bounded pool contains too few distinct sources.

Family diversity is not proof of independent corroboration: two publishers may repeat one original report, and articles at one URL may disagree across revisions. Graph explanations and model confidence remain unverified interpretations. Inspect the quoted claims and their provenance before counting sources as independent evidence.

## Checks for a local audit

On a disposable copy, compare unchanged `hybrid` results with `hybrid+graph` for the same queries, filters and embedding coverage. Include repeated captures with matching provenance, same-title articles at different URLs, unknown-source text, explicit revisions, and unrelated items mislabeled `duplicates_angle`. Check whether distinct useful sources replace duplicate slots without losing useful version-specific evidence. Record family suppression counts and complete supported answers separately; fewer duplicates alone does not establish better answers.
