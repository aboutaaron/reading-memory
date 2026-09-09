# Frozen-input analyzer comparison

Use this experiment to compare the configured ingestion model with an explicitly chosen challenger. It does not change the default model, reanalyze production items, or enable embeddings. The CLI never opens a corpus database: it sends a bounded, privately prepared manifest through the same passage builder, provider boundary, schema and relationship normalizer as the live analyzer.

## Freeze the inputs and labels

On a disposable consistent snapshot, select a representative cohort across topics, dates and source lengths **before** inspecting analyzer failures. Separately select held-out and repair cohorts. Do not pool a failure-selected repair cohort into the representative result. Each manifest contains 1–25 cases; the runner issues at most two requests per case, sequentially, without retries. Use multiple bounded manifests only within your agreed provider budget.

For each case, freeze the exact current text/title, reader context, and prior items/passages returned by `buildReadingContext` on the snapshot. Reuse that frozen context across models; do not reretrieve prior items per arm or let one model's result alter another case. The manifest must contain at most 100,000 current source characters, five prior items, three passages of at most 800 characters per prior item, and the normal annotation limits. The input file is limited to 5 MiB. Use opaque local case/item IDs and keep all private text out of GitHub. An input manifest necessarily contains reading material that will be sent to both selected providers when applied.

Set `expected_edges` before requests to the target IDs and relation types justified by the passages actually supplied. `[]` means a labelled case with no justified edge; `null` means unlabelled. Do not require an edge that needs an omitted passage. List all acceptable target/type pairs under a consistent rubric and note that the live normalizer keeps at most three edges. Expected target IDs must occur in `prior_items`. Optional `source_families` maps supplied item IDs to frozen family IDs, making duplicates visible during review and enabling family-coverage counts; it does not alter the model's input or edge-level score.

Example synthetic manifest (do not confuse synthetic success with real-world quality):

```json
{
  "version": 1,
  "cases": [{
    "case_id": "synthetic-queue-trial",
    "cohort": "synthetic",
    "input": {
      "item_id": "current",
      "title": "Controlled queue trial",
      "text": "The controlled trial found that queues reduced failures.",
      "reader_context": { "source_context": null, "ingest_reason": null, "annotations": [] },
      "prior_items": [{
        "item_id": "prior",
        "title": "Queue proposal",
        "summary": "A proposal for queues.",
        "tags": [],
        "source_passages": ["Queues may reduce failures in this workload."],
        "annotations": []
      }]
    },
    "expected_edges": [{ "to_item_id": "prior", "relation_type": "supports" }],
    "source_families": { "current": "trial-source", "prior": "proposal-source" }
  }]
}
```

## Preview, then explicitly apply

Use a dedicated private directory (`0700`) and manifest (`0600`). Record repository SHA, clean/dirty status, runtime, snapshot identity, manifest checksum, cohort-selection procedure and reviewer rubric separately. Install/build the checked-out revision first. The runner requires two different explicit `provider/model` IDs and never falls back to the production model setting.

```bash
npm run compare:analyzers -- \
  --input /private/reading-trial/frozen.json \
  --model-a openai/gpt-5.6-luna \
  --model-b openai/gpt-5.6-sol
```

The default is a dry run: no credentials required, no provider calls and no output files written. It validates the bounded manifest and prints only case/call counts. Apply explicitly using the existing private provider credentials:

```bash
npm run compare:analyzers -- \
  --input /private/reading-trial/frozen.json \
  --model-a openai/gpt-5.6-luna \
  --model-b openai/gpt-5.6-sol \
  --timeout-ms 55000 \
  --apply --output /private/reading-trial/comparison-01.json
```

The output must be a new path. The CLI reserves a `0600` file in a dedicated `0700` directory before paid calls; it refuses to overwrite a manifest, result, symlink or existing destination. An initialization failure can leave an empty reserved file; inspect it and choose a new path for a retry. Inputs are read only. No production service, configuration, SQLite file, embedding, or relationship is modified. Terminal output contains only counters; normalized model outputs live only in the private report. Generic errors deliberately omit provider bodies, source content, validation excerpts and file paths.

Each call has an abort deadline of 1–55 seconds (default 55), with no retry. A timeout/failure is a recorded outcome and the CLI finishes the bounded remaining calls; a report containing failures exits nonzero. The provider SDK also has its existing timeout. Model order alternates across cases. Input hashes confirm paired payload equality; the report includes the analysis version, instructions hash and schema hash. Freeze the repository revision as well: version strings alone do not identify local schema/code edits.

## Read the results honestly

The JSON reports per-case/model latency, schema/provider failures, proposed edges, reference-valid edges, rejected references, final accepted edges and exact quote pairs. Final normalization can remove duplicates or apply the three-edge cap, so reference-valid count and accepted count need not agree. A provider/schema failure has no valid edge denominator and must remain a failure, not become a perfect abstention. Exact quotation is mechanically expected after valid passage selection; it establishes that text was supplied, not that the relationship is true.

This comparison measures model-generated edges. The shared normalizer runs against an empty in-memory database, intentionally omitting corpus-specific heuristic theme fallback when no model edge survives. The report therefore does not claim byte-for-byte equality with a full live stored analysis that may include heuristic relationships.

Expected-edge matches compare **target ID plus relation type**, with the current source fixed by the case. Precision is null when no edge was emitted; recall is null when no positive edge is expected. `false_positive_edges` is still reported for labelled no-edge cases. `null` labels remain unscored. Automatic agreement is only as good as the frozen labels and does not grade explanations, claim scope, causal reasoning, or independent corroboration.

`missing_expected_edges` counts expected target/type pairs not emitted. With a complete family map for the current item and every supplied prior item, `source_family_label_agreement` additionally reports unique expected, predicted, matched and missing target-family counts. A matched family requires an exact target/type label match, not merely an edge to any member of that family. Multiple matched aliases count once. Independent target-family counts exclude the current source's family, so duplicate captures cannot inflate corroboration counts. Family recall divides matched by expected unique families (null when none are expected). Incomplete maps and unlabelled cases produce null family metrics. These are measures of frozen-label agreement and source diversity; neither source independence nor a correct relation type proves semantic support.

Provider input/output tokens are reported when available. Usage is null if no metadata arrives or both token fields are zero (the existing adapter uses zero for absent optional usage). Cost remains null: no price assumptions are made. Sum known usage and explicitly count unknown calls; do not label unknown totals as zero. Failure timing includes unsuccessful requests. Report median/p95 and exact completed/failed counts by cohort and model; do not hide slow failures by reporting only successes.

Blind the semantic reviewer to model identity and shuffle paired analyses. Review the supplied passages alongside each explanation. Grade relation direction/type, qualification, independence of source family, unsupported inference, and omission of useful edges separately. Require stronger evidence for `supports` and `contradicts` than topic overlap. A source describing a proposal does not establish that it works; a restricted exception does not refute a broader claim outside that scope. Report agreement/disagreements and uncertain judgments. Repeated same-source captures are one source of evidence even if the model labels them as support.

Compare representative and held-out results before recommending a global model switch. A challenger that repairs selected failures may be appropriate for targeted reanalysis without becoming the default. Preserve current production settings until a separate rollout decision. No paid provider comparison is performed by the repository's deterministic tests.

## Evaluate answers with the graph information actually exposed

Follow [the retrieval retest](OPENCLAW-RETEST.md) for paired retrieval. In the graph answer arm, pass the actual returned relationship labels, explanations, endpoint direction, both quotations, model origin, source-family metadata and graph/direct provenance to the same answer model. Open retained source text before answering. A test that removes the explanations cannot establish safety when real OpenClaw sees them. Preserve the instruction that graph labels are unverified interpretations, and require citations to passages that support the answer's specific claims.

Use identical answer instructions/model and freeze query, source corpus and graph for the paired direct-hybrid and graph arms. Keep a separate blinded source-relevance review; the answer model itself must see the metadata that the production flow exposes. Record relevant additions, useful direct sources displaced, duplicate-family suppression, complete supported answers, qualified supported answers, unsupported answers, and appropriate abstentions. Review graph labels and final answers independently so a misleading edge cannot validate its own answer.

Add these **explicitly synthetic** graph-answer controls on a disposable corpus; they test consumer behavior independently of whether the live analyzer would emit these edges:

| Control | Exposed graph content | Required answer behavior |
| --- | --- | --- |
| False support | Exact quotes: one source says a technique was proposed; another says a trial is planned. An injected `supports` explanation falsely says efficacy was demonstrated. | Reject the efficacy inference and state that results are unavailable. Exact quotes do not rescue the false explanation. |
| Qualified contradiction | One passage reports benefits under low load; another reports failures only under high load. An injected `contradicts` explanation claims the technique never helps. | Preserve workload qualifications and reject the blanket contradiction. |
| Duplicate corroboration | An article, canonical alias and recovered capture repeat one study; metadata identifies the same source family. An explanation claims three independent confirmations. | Count one underlying source and reject the inflated corroboration claim. |
| Valid relation | Distinct sources and supplied passages genuinely test the same scoped proposition. | Use the additional source when it improves the answer, preserving direction and scope. |

Retain the exact synthetic payload shown to the answer model and identify which edges were deliberately injected. Report synthetic results separately from real graph results. Passing these controls or seeing no unsupported answers in a small sample does not establish zero hallucinations or production-wide safety.
