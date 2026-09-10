# OpenClaw evidence-quality retest

Test the merged revision on a private, disposable copy. Return a private report separating operational checks, retrieval quality, and model interpretation quality. Preserve production settings throughout this trial. Read the live embedding configuration first: enabled embeddings need a coverage check, not another enablement step.

## Prepare and freeze the baseline

Follow the WAL-safe backup, private directory permissions, separate loopback port, credentials, and process cleanup instructions in [OPENCLAW-RETEST.md](OPENCLAW-RETEST.md). Record the exact commit and runtime, build/test/eval summaries, analysis model/version, embedding model and coverage, and authenticated `/diagnostics`. Do not infer failure causes or model quality from stale flags. Counts of mismatch reasons can overlap.

Keep the original copy frozen for paired retrieval. Use another disposable copy for ingestion, reanalysis, failure injection, and forgetting. No source text, private URLs, item IDs, provider responses, credentials, or corpus inventories belong in GitHub; public reproductions must use synthetic material.

Record an execution date and revision for each experiment separately. Label reused frozen results and their original dates explicitly; fetching an unchanged main branch or rerunning unit tests does not make an earlier model comparison a fresh experiment. New live URL checks establish only those capture outcomes. Preserve private raw receipts for each claimed check and mark missing checks `not run`.

## Check extraction before evaluating analysis

Run the automated extraction tests, then retry a small selection of the previously problematic original URL requests on the mutation copy. Record HTTP outcome, extractor provenance, retained text, truncation, and whether the captured text contains the article's actual argument. HTTP 200, a nonempty text field, or an existing item ID is not evidence of successful article capture.

Check consent-only pages, an ordinary short article, an article about cookies or privacy, and a public preview. A consent shell must fail before analysis and indexing. A valid short article should remain usable. Preserve the distinction between a public preview and a complete article; extraction cannot establish completeness merely by returning text.

Include the synthetic analytics/advertising notice in issue #70 and two distinct URLs serving that notice. Both requests must return `422 / FETCH_FAILED` before analysis, embeddings, indexing, or successful content-hash deduplication. Verify no new corpus item or vector was created and preserve existing failed captures and version lineage. Repeat the original affected URL requests privately after the fix: either substantive article material or an honest extraction failure is acceptable. Passing the synthetic regression alone does not close the live-URL verification gate.

Inventory previously indexed shell captures separately on the disposable copy. Rejecting new captures does not repair or delete old indexed content. Report those records privately for an explicit cleanup decision; preserve original failed records and lineage and do not silently delete records to improve the reported failure count.

For structured article content, follow [ARTICLE-EXTRACTION.md](ARTICLE-EXTRACTION.md). Exercise its supported synthetic fixtures, malformed and ambiguous payloads, and unsupported application shells. The extractor does not execute JavaScript or fetch subresources. Do not infer that a framework's hidden state is supported, and do not bypass publisher access controls to make a test pass. Report live sources that still fail as unresolved extraction cases, with a sanitized structural reproduction when possible.

For an unchanged-content failed capture, verify the retry recovers the same item. For changed content, record the new item and its version lineage separately; the old failed record can remain. Follow [FAILED-CAPTURES.md](FAILED-CAPTURES.md). Do not submit a retained excerpt as a substitute for the original request.

## Check independent-source retrieval

Use the same frozen questions, filters, `top_k`, and embedding coverage for `hybrid` and `hybrid+graph`, with `lexical_policy: "any"`. Keep ordinary FTS and hybrid as baselines. Save source-family metadata and graph suppression counters along with ranks and graph provenance. See [SOURCE-FAMILIES.md](SOURCE-FAMILIES.md) for the conservative identity rules and traversal limits.

Include synthetic same-source captures in different formats, explicit changed-content versions, distinct URLs with identical titles, and unrelated pages sharing a teaser. Verify graph results do not spend multiple slots on a recognized source family, refill with available distinct candidates within the bounded pool, and do not treat same-title or model `duplicates_angle` labels as identity. All original captures must remain individually readable. Check filters and forgetting on the mutation copy; hidden/deleted item IDs must not leak through family metadata.

Report item Recall@5 and independent-source-family coverage separately. Audit added sources and useful direct sources displaced by graph expansion. Fewer returned hits may reflect the bounded candidate pool; it is not a guarantee that the whole corpus has no other independent sources.

Separate actual `retrieval_origin: "graph"` additions from diversification and direct-result refill. For each category count useful, background, and irrelevant additions and displaced results, including whether a displaced item's family remains represented. Recognized family coverage measures conservative source identity; it is not proof of independent reporting. Report original and held-out cohorts separately even when their pooled result improves. Retain full-round latency measurements; fresh-connection subsets may diagnose transport effects but cannot replace full-round quality or latency results or establish a database regression on their own.

## Check evidence selection and relationship meaning

Reanalyze only a small reviewed batch on the mutation copy, first previewing with `npm run reanalyze -- --stale --limit 10 --dry-run`, then explicitly applying if the intended provider budget permits. This updates the isolated copy and can incur analysis and embedding calls. Do not run an automatic corpus-wide reanalysis merely because the analysis contract changed.

Verify the new analysis version and that stored model relationships contain exact source and target quotations. The provider selects supplied passage IDs; the application resolves their text. Existing quote-based stored relationships remain readable. Use automated adversarial tests for unknown IDs, cross-target IDs, summary/annotation substitution, and punctuation/newline preservation. A live model need not emit a particular relationship deterministically.

Review relationship meaning separately: support must substantiate a proposition; contradiction must concern the same proposition under comparable conditions. Preserve populations, dates, scope, and qualifications. Shared themes alone do not establish either. Record invalid references, wrong relation types, unsupported explanations, useful edges, and omissions separately. Exact quotations establish provenance, not semantic truth.

## Compare models and graph-aware answers

Follow [ANALYZER-COMPARISON.md](ANALYZER-COMPARISON.md) to prepare at most 25 frozen cases, label expected relationships before inspecting outputs, and preserve the identical current/prior inputs for both models. Include ordinary cases as well as known difficult cases; report those cohorts separately.

```bash
npm run compare:analyzers -- --input /private/frozen.json --model-a openai/gpt-5.6-luna --model-b openai/gpt-5.6-sol
npm run compare:analyzers -- --input /private/frozen.json --model-a openai/gpt-5.6-luna --model-b openai/gpt-5.6-sol --apply --output /private/new-report.json
```

The first command is a dry run. Review its bounded call count before the second command, which makes paid provider requests and writes a private report. The CLI does not read or mutate the production database or change its configured model. Report latency and available usage; unknown token counts or cost remain unknown. Automated reference/type checks are not a substitute for blinded semantic review.

Run the separate graph-aware answer protocol in that guide. The graph arm must actually receive relationship labels, explanations, exact quotations, endpoint direction, source-family identity, and the unverified status. Require inspection of source passages and cite only claims they support. Include false-support, qualified-disagreement, duplicate-source, absent, and near-miss controls. Record unsupported answers separately from irrelevant retrieval candidates. An answer experiment that omits graph explanations cannot establish that the answerer safely handles those explanations.

Also run [answer/source alignment controls](ANSWER-SOURCE-EVALUATION.md). Freeze intended source IDs before retrieval and keep ambiguous recall questions separate from explicit named-source comparisons. Genuine quotations from a related essay do not substitute for the requested essay. Score quotation presence, entailment, requested-source alignment, family assertions, completeness, and abstention separately. Supply only identity metadata available in that arm: same publisher or topical similarity proves neither a shared family nor independent corroboration. Missing metadata requires uncertainty.

## Report and decide

Return the tested revision, pass/fail/not-run table, live extraction outcomes, family diversity and paired recall, evidence-reference validity, blinded semantic judgments, graph-aware answer support, provider call counts, latency, and known/unknown usage. Identify operational blockers separately from small or uncertain quality differences. Keep the analysis model unless the frozen comparison shows enough useful improvement to justify its latency and cost. Keep retrieval modes opt-in unless a separate measured rollout supports changing defaults. Stop only the disposable processes and confirm production settings were preserved.

Issue #72 records the decision gates. A small repair-selected advantage is insufficient for a global model change: prepare a larger representative, genuinely held-out cohort before examining outputs, report repair cases separately, and state reviewer and stochastic uncertainty. Known token usage does not establish billed dollar cost. These instructions do not schedule recurring evaluations or authorize production reanalysis/backfill. Close code work independently of still-unverified live checks, and record which gates remain open.
