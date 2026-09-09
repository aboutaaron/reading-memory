# OpenClaw retrieval retest

Test the merged revision containing the lexical-policy and graph changes. Produce a private report with reproducible results and a recommendation about which mode/policy OpenClaw should request. Keep the service defaults unchanged during evaluation.

## 1. Record and isolate the environment

Record the exact `git rev-parse HEAD`, clean/dirty state, Node version, operating system, analysis model, embedding model and actual SQLite/vector-index availability. Install/build from that revision, run `npm test` and `npm run eval:reading`, and retain their summaries. The deterministic eval now has 36 cases; they use canned analyses, relationships and vectors and do not establish live-provider quality.

Create a private test directory with `umask 077`; directories must be mode 0700 and database/log/report files 0600. Make a consistent SQLite snapshot using the repository backup utility, which handles a live WAL database; do not copy only the live `.sqlite` file. Keep production service configuration and content unchanged. For example, after setting `TRIAL_PRODUCTION_DB` to the known production database path:

```bash
umask 077
TRIAL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/reading-retest.XXXXXXXX")"
node scripts/backup-sqlite.mjs "$TRIAL_PRODUCTION_DB" "$TRIAL_DIR/reading.sqlite"
export READING_API_HOST=127.0.0.1
export READING_API_PORT=4827
export READING_API_DB="$TRIAL_DIR/reading.sqlite"
export READING_API_DATA_DIR="$TRIAL_DIR/data"
export READING_API_BACKUP_DIR="$TRIAL_DIR/backups"
export READING_API_FLUE_TRACE_PATH=off
export READING_API_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export READING_API_EMBEDDING_MODEL=openai/text-embedding-3-small
export READING_MEMORY_URL="http://127.0.0.1:$READING_API_PORT"
mkdir -m 700 "$READING_API_DATA_DIR" "$READING_API_BACKUP_DIR"
```

Choose another unused loopback port if 4827 is occupied. Use the existing provider credential through the normal private secret mechanism; do not print or include credentials in commands, logs, report, or GitHub. Preserve the existing analysis model. Inspect all resolved paths and the test URL before starting `npm start`; none may resolve to production paths. Start the updated isolated service once before backfill so migrations have run. Keep its PID so cleanup stops only that process.

Use a separately configured MCP process pointed at `READING_MEMORY_URL`, with the same test token. Do not replace OpenClaw's production connection. Inspect `/health` and authenticated `/capabilities`; successful HTTP status alone does not establish readiness. Confirm the advertised modes, lexical policies, actual embedding model, 1,536 dimensions, available index and missing-item count.

## 2. Expand embedding coverage in bounded stages

Record total items, indexed eligible items, compatible current embeddings and coverage percentage. Begin with the original 25-item cohort if it is available, but choose new question labels independently of whether a source already has an embedding.

Run these with the isolated environment and explicit database path:

```bash
npm run backfill:embeddings -- --db "$READING_API_DB" --limit 25
npm run backfill:embeddings -- --db "$READING_API_DB" --limit 25 --apply
```

Review the dry-run IDs before each apply batch. Work sequentially in batches of at most 25, recording success/failure counts and elapsed time. Evaluate at the initial coverage and again after at least 100 eligible items, or all eligible items if fewer. Include sources across topics and dates. For a corpus the size of the previous trial, complete the remaining eligible corpus in these bounded batches if practical within the agreed provider budget. Otherwise state the stopping budget and exact coverage; do not describe a convenience slice as representative. Use the CLI's actual selected IDs; it does not support arbitrary per-item selection. More embedded competitors can change rankings even when the expected source was already embedded.

Verify each stored projection references the current analysis and expected model, has a nonempty input hash, 1,536 finite float32 values, and a 6,144-byte BLOB. Restart the isolated service and verify canonical counts remain stable and the index rebuilds. Check the dry run leaves database content unchanged and does not call the provider; use a local instrumented stub or existing deterministic test for the no-call claim. An unreachable endpoint plus unchanged data alone does not prove zero attempted requests.

Record observed calls, failures and timing. Provider usage/cost must be reported as unknown if unavailable; do not infer token counts from BLOB size or treat unknown cost as zero. This run sends query text and title/summary/claims projections to the configured provider.

## 3. Freeze questions and relevance labels before searching

Reuse the original 30 questions verbatim: 10 direct keyword, 10 paraphrase, five cross-source and five absent. Keep original labels for paired comparison, and document any corrections after reviewing actual source passages.

Add at least 25 fresh held-out questions before observing results: five direct, five paraphrase, five cross-source, five absent and five near-miss questions. Near misses should share real corpus terms while asking about an unsupported subject, entity, date, number or causal claim. Cross-source cases should include both supporting and contradicting arguments. For each question save private source-grounded expected IDs, supporting passages, absent-evidence rationale, and expected relationship direction where relevant. Distinguish sources that answer the question from sources that merely provide background. If an expected connection has no stored edge, record that coverage gap rather than inventing an edge or counting it as a traversal bug.

Do not select all positives from the embedded set. Report results for the whole labelled set and separately for expected sources with compatible embeddings. Keep source text, questions, labels and exact private item IDs out of public GitHub issues. If no suitable contradiction exists in the retained corpus, report the limitation; a clearly labelled synthetic control can exercise the path but cannot establish live extraction quality.

## 4. Run paired retrieval comparisons

Use the same frozen corpus and embedding coverage for every arm. Do not ingest, reanalyze, annotate, record citation/brief events, or backfill during a comparison round. Use `top_k: 5`, a fresh UUID `request_id` per query, and identical query/filter values. Balance or rotate arm order to reduce provider warm-up/order effects.

| Arm | `mode` | `lexical_policy` | Purpose |
| --- | --- | --- | --- |
| A | `fts` | `any` | Existing AND-then-OR baseline |
| B | `fts` | `all` | Skip partial OR fallback |
| C | `hybrid` | `any` | Semantic retrieval with broad lexical candidates |
| D | `hybrid` | `all` | Semantic retrieval with all-term lexical candidates |
| E | `hybrid+graph` | `all` | Incremental graph context over arm D |

Also run `hybrid+graph` with `any` on every absent/near-miss case and a representative positive subset to verify weak lexical-only seeds do not trigger expansion. `all` applies only to lexical candidates; it must not suppress otherwise qualifying semantic neighbors. It is not a guarantee of answer support and can lose useful lexical recall.

Example request body:

```json
{
  "request_id": "REPLACE_WITH_FRESH_UUID",
  "query": "REPLACE_WITH_FIXED_QUESTION",
  "mode": "hybrid+graph",
  "lexical_policy": "all",
  "top_k": 5
}
```

The service allows 30 query requests per minute per principal. Pace requests at least 2.5 seconds apart, without parallel bursts; start a fresh timing window after other query checks. Record 429s and transport/provider errors separately, honor retry information where available, and rerun affected comparisons after the window clears. Do not count a 429 as a retrieval miss. Measure latency around the request itself, excluding deliberate pacing and label review.

Save requested and actual mode, fallback reason, lexical policy, ranked IDs, matched terms, lexical-match/coverage/weak-match metadata, vector ranks/distances, graph provenance and request latency. A semantic-only hit's null lexical rank or coverage means it was not in the selected lexical list; it does not establish no lexical overlap across the index. `weak_match: false`, high coverage, BM25, cosine distance, graph presence and model confidence are not calibrated answer-confidence scores.

## 5. Judge candidates, answers and graph relations separately

Review returned sources outside the initial expected set before labelling them irrelevant. Record relevant, useful background, irrelevant and uncertain; add justified newly discovered relevant IDs to a reviewed label set and report both original-label and reviewed-label metrics. Do not silently tune questions or labels after seeing one arm's output.

For every arm report Recall@5 on positive questions, expected-source rank, reviewed irrelevant-result rate (with its denominator), absent/near-miss query rate returning candidates, and median/p95 request latency. Show paired per-question changes and exact counts, including useful results lost by `all`. Split original vs held-out questions and embedding-coverage cohorts. Report successful hybrid execution and fallback counts separately.

Run a separate answer-support pass using the same OpenClaw model and instructions for each arm. Require OpenClaw to open retained text before answering, cite only passages that support the actual claim, and explicitly say when memory lacks support. Score fully supported, partly supported, unsupported and appropriate abstention; report absent-question unsupported-answer rate independently of candidate-return rate. An empty API `answer` only confirms that retrieval did not synthesize text; it does not test OpenClaw's answering behavior. Do not write citation events merely for this experiment.

For graph results, audit the seed, both endpoint IDs, incoming/outgoing direction, relation type, `origin: "model"`, explanation and exact source/target quotations. Confirm the quotes occur in current retained text. Separately judge whether the passages justify the claimed support/contradiction/extension: quote validation establishes provenance, not semantic truth. Graph relationships must be marked unverified. Record `graph_expansion.considered_edges`, `scan_truncated`, `seed_item_ids` and `added_results`; the edge budget can omit useful connections and truncation is not an exhaustive graph search. Count relevant additions, irrelevant additions, useful direct hits displaced within `top_k`, and queries where no usable edge exists. Report stored-edge coverage (including quote-valid model edges) so a sparse graph is not mistaken for a retrieval failure.

## 6. Exercise operational behavior on a second disposable copy

Finish the frozen quality comparison first. Snapshot that isolated database again for mutations and failure injection, using a new service port and every path/token overridden as above. Run representative HTTP requests and actual MCP `query`, `get_item` and `health` calls; checking advertised MCP metadata alone is insufficient.

- Omitted mode/policy remains `fts`/`any`; invalid policies/modes return validation errors. Both policies preserve empty answers and honest confidence metadata.
- Disable embeddings, then simulate a failed query embedding against a local stub. Verify explicit fallback preserves `lexical_policy`. Graph fallback reports the actual base retrieval mode and graph mode; qualifying full-term lexical seeds may still expand, while partial lexical-only seeds do not.
- Verify support and contradiction can be discovered in both edge directions, remain within the advertised one-hop/seed/edge/result budgets, and carry exact quote provenance. Heuristic edges, missing/invalid quotations and second-hop-only neighbors must not be expanded. Treat deterministic fixtures as the control when the private corpus lacks a suitable case.
- Verify date, tag and indexed-status filters apply to seeds and graph neighbors, no duplicate IDs appear, and `top_k` bounds hold (including 1, 2 and 5). Confirm a graph-added source is distinguishable from a direct hit.
- On disposable synthetic items only, verify successful reanalysis replaces embedding and outgoing relationships; an embedding failure still leaves analysis searchable via FTS, clears the stale vector and permits backfill. Do not require a live model to produce a particular relationship type deterministically.
- Forget a connected disposable item and verify it disappears from direct/vector/graph results and surviving item relationships. Retry the original ingest request ID and verify it cannot resurrect the item. Check both incoming and outgoing deletion cases. Use existing automated race tests for deletion/reanalysis during provider work; do not claim they were exercised live unless they were.
- Restart and verify canonical vectors rebuild and current source/relationship evidence persists. Check responses do not expose raw vectors, credentials or unrelated request metadata. Existing deterministic tests cover deliberate index corruption and transactional failures; report which checks were automated versus separately exercised here.

Stop only the test processes when finished. Retain private reports/results through the normal private artifact workflow; remove disposable test copies according to that workflow. Confirm production service settings and connection were not changed.

## Report to return

Provide the tested revision/runtime; baseline build/test/eval summaries; corpus/embedding/edge coverage; provider calls, timing and known or unknown cost; paired metric tables by arm and cohort; five concrete examples spanning improvements, regressions and absent/near-miss handling; graph relation-audit results; OpenClaw answer-support results; operational pass/fail/not-run table; and minimal sanitized reproduction steps for each bug. State whether OpenClaw should keep broad retrieval, explicitly request `all`, use graph selectively for relationship questions, or wait for further fixes. Keep retrieval modes opt-in unless the evidence supports a separate rollout decision.
