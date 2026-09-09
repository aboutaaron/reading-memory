# Diagnose and audit graph coverage

Missing eligible model relationships and stale analyses describe stored data and configured policy; they do not establish that the current analysis model is poor. Read the live configuration and diagnostics before an audit, and preserve the configured analysis model for the first comparison.

## Embeddings and the analysis model are separate choices

Evaluate selective `hybrid` / `any` recall separately from strict lexical matching. If embeddings are already enabled, preserve their configuration and inspect coverage before deciding whether backfill is needed. To enable them after validation, set `READING_API_EMBEDDING_MODEL=openai/text-embedding-3-small` in the intended service environment, retain its existing analysis model, restart that service and confirm `/health.embeddings` reports the expected model and available index. Use the existing private `OPENAI_API_KEY`; never print it. See [hybrid configuration and backfill](HYBRID-RETRIEVAL.md).

Enabling embeddings does not change the default query mode from FTS. It does start embedding-provider calls for new ingestion/reanalysis, and allows explicit hybrid queries to send query text. Historical items need bounded dry-run-first backfill. Record coverage and process batches of at most 25; do not combine a full analysis-model switch, corpus-wide reanalysis and embedding rollout into one unmeasured operation. Embeddings can improve which prior sources the analyzer sees, but cannot guarantee valid model relationships. These instructions describe an operator rollout; the repository update itself does not change a running service's environment.

## Read diagnostics before changing anything

Use authenticated `GET /diagnostics` (or the MCP `diagnostics` tool). Its `analysis` object reports the current version/model, stale item count, and `stale_reason_counts`:

- `missing_analysis`: an indexed item has no analysis.
- `version_mismatch`: its latest analysis uses a different analysis contract version.
- `model_mismatch`: its latest analysis uses a different canonical provider/model ID.

Version and model mismatches can overlap, so their sum may exceed `stale_items`. Bare OpenAI IDs and `openai/`-prefixed IDs compare equally. Provider differences remain significant. `GET /items?stale=true&limit=25` adds `stale_reasons` to each selected item; it does not infer a content-quality problem from a mismatch.

The `graph` object reports `total_relationships`, `model_relationships`, `heuristic_relationships`, and `eligible_relationships`. Eligibility uses the same checks as graph retrieval: model origin, supported relationship type, indexed endpoints, bounded evidence containing exact quotations in current source text, and finite model confidence from zero to one. It does not require current analysis policy; quotation presence also does not establish that the model's proposed relationship is true. Query seeds, tags, dates, deduplication and scan limits can further reduce actual expansion.

This is an explicit full-corpus quote scan. Run it when diagnosing coverage; it is not part of routine `/health` requests. It performs no provider calls and returns counts rather than source text or quotations.

## Preview and reanalyze a bounded disposable batch

1. Follow the snapshot and isolated-service instructions in [OPENCLAW-RETEST.md](OPENCLAW-RETEST.md). Use a WAL-safe backup copy, a separate database/data/backup directory and loopback port. Confirm the service reports the copied database and intended model. Do not run this maintenance against production as part of the audit.
2. Record SHA, configured analysis model/version, embeddings configuration, and diagnostics before running maintenance. The CLI reads its host, port and token from the environment; use the isolated service's values. Keep credentials and private content out of public logs and GitHub.
3. Preview the next bounded batch:

   ```sh
   npm run reanalyze -- --stale --limit 25 --dry-run
   ```

   This reads stale item IDs and reasons through the service. It sends no reanalysis POST, makes no analysis/embedding provider requests, and does not change analyses or relationships. Output omits titles and source text. Service request metadata can still be recorded.
4. Review the selection. It is the oldest stale items by ingestion time and ID, not an automatically representative sample. Use fewer items or a disposable corpus prepared with representative sources when that ordering is unsuitable. Preserve useful related prior sources so analysis has candidates to compare. Record the exact selected IDs; preview does not reserve them, so keep ingestion/configuration unchanged between preview and apply.
5. Apply only the reviewed bounded batch:

   ```sh
   npm run reanalyze -- --stale --limit 25 --apply
   ```

   This incurs configured provider usage and may also generate embeddings when they are enabled. Operations are sequential and throttled; retries within each item reuse its request ID. The old command without a mode flag still applies for compatibility, so always write `--dry-run` when requesting a preview. A separate CLI invocation creates new request IDs.
6. Record diagnostics again, plus completed/failed counts, duration and available provider usage. Unknown token/cost totals must remain unknown. Do not continue to a full-corpus paid reanalysis automatically.

## Audit relationship meaning and decide what to change

Read each reanalyzed item's saved analysis, outgoing relationships and source passages, including the target source. Audit all model edges from the small batch, recording whether each relation type and explanation is supported by the two quotations. Separate invented/missing quotations, semantically incorrect edges, vague `related` edges, and useful support/contradiction/update connections. The service checks exact text, while a reviewer must judge meaning.

For sources that yield no model edges, check whether an actually related prior item was available among the supplied analysis context candidates and whether its provided source passage contained suitable evidence. Analysis considers only a bounded set of prior sources; it cannot cite arbitrary corpus items. No edge can be the correct outcome when no supplied passage justifies a relationship. Heuristic theme connections remain distinct and cannot be promoted into model evidence by maintenance.

If current Luna analyses contain specific relationship errors or clear omissions despite sufficient supplied evidence, compare a stronger analysis model on the same small frozen source/prior-context inputs in a second isolated copy. Label expected relationships before examining model outputs. Compare valid useful relationships, unsupported relationships, omissions, analysis quality, latency and cost; a model producing more edges has not necessarily improved quality. Do not switch production models merely to clear stale flags or because an old corpus lacks model edges.

Once real eligible edges exist, rerun the fixed cross-source and disagreement questions from the retest with identical filters and embedding coverage. Compare hybrid versus hybrid+graph; audit both useful additions and displaced direct results. Graph retrieval can operate on strong lexical seeds when embeddings are off, but semantic seed discovery needs embeddings. Report candidate relevance separately from whether OpenClaw's final answers are source-supported and appropriately abstain. Stop the disposable service after the audit and leave production configuration unchanged.
