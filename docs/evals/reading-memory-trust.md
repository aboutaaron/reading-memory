# Reading Memory Trust Eval

Reading Memory uses a deterministic regression eval before changing query ranking, brief-guide selection, or memory persistence. It currently contains **26 cases: 15 query cases, 8 briefing scenarios, and 3 memory durability checks**.

The checked-in sources, reader comments, analyses, and editorial decisions are synthetic. Analyses are canned: **this eval does not call a live model or establish model quality, semantic recall, real-world relevance, or usefulness of production briefs**. Parser and source-deduplication regressions have separate extraction/store tests.

Every scenario uses a fresh in-memory SQLite database. Corpus and analysis timestamps are fixed, briefing runs on September 9, 2026 UTC, and event ordering is explicit. Output uses stable fixture labels instead of random item IDs. The test suite checks that consecutive runs produce identical results.

## Run and interpret

```bash
npm run eval:reading
# Equivalent invocation without the tsx CLI process wrapper:
node --import tsx src/evals/reading-memory-eval.ts
```

The command emits a JSONL record per case followed by a summary. It exits nonzero when any case fails. `npm test` also runs the eval gates.

| Metric | Definition | Synthetic gate |
| --- | --- | --- |
| `recall_at_5` | Relevant expected source IDs found in the first five results, divided by the number of expected IDs, per positive query | 1 for every positive case |
| `mean_recall_at_5` | Unweighted mean of positive-query Recall@5; empty/no-evidence cases are excluded | 1 |
| `unsupported_query_false_positives` | Empty/no-evidence query cases that return any source | 0 |
| `unsupported_result_false_positives` | Total returned sources in those empty/no-evidence cases | 0 |
| `unsupported_answers` | Query responses that populate an answer despite the endpoint only performing lexical retrieval | 0 |
| `irrelevant_brief_selections` | Selected source IDs outside each scenario's expected candidates | 0 |
| `missed_due_items` | Explicitly due and in-focus items missing from a brief | 0 |
| `unwanted_repeats` | Items already included or resurfaced that appear again without a new due schedule | 0 |

These are exact synthetic expectations, not production targets. A 100% Recall@5 score here means the checked-in regressions pass; it does not estimate recall on an unseen reading corpus. Case records also check forbidden distractors, citation identities, partial-match labeling, absence of fabricated confidence probabilities, brief order, and preserved selection rationale. A failure in one of these gates can fail the run even when aggregate recall is 1.

## Coverage

Query fixtures cover natural-language recall; a topic appearing after the former eight-word cutoff; long conversational questions; short AI/ML terms; hyphens and Unicode; two relevant sources; a cooking distractor sharing “cache”; tag and date filtering; unsupported subjects; punctuation/filler-only input; and explicitly labeled partial evidence. Partial retrieval returns potentially useful sources without presenting them as an answer to an unsupported claim.

Brief scenarios cover confident `skip` items competing with a relevant `brief`, relevance ahead of confidence, more than 25 ineligible items before an eligible one, due material older than the ingestion window, future ingestion/deferral/event boundaries, consumed inclusion and resurfacing schedules, later editorial decisions preserving or replacing a schedule, and focus filtering. A due schedule is an explicit editorial override of the model's `skip`; it does not override the caller's focus filter.

Durability checks cover the original model rationale after duplicate ingestion and item lookup; exact source passages plus the origin of a connection; and verbatim reader comments with actor attribution, project/question context, immutable corrections, and retrieval of active rather than superseded notes.

Add a case for each newly observed failure. Keep expected IDs and exclusion rules explicit; do not weaken an expectation merely to accommodate a ranking change. Investigate failures before merging retrieval or selection changes.

## Production follow-up

Use a week of actual briefs as a separate, locally reviewed evaluation: label representative recall questions and relevant sources, record whether resurfaced items were useful, and inspect the evidence for every claimed connection. Keep user feedback distinct from the model's relevance score. Live analysis quality needs its own reviewed dataset and model-run reporting; changing the model cannot be validated by this canned-analysis suite alone.

Optional production snapshot fixtures may be generated for local regression checks, but they must be sanitized before storage:

- no raw article, newsletter, PDF, or email body text
- no bearer tokens, email recipients, unsubscribe URLs, or private headers
- bounded summaries, tags, source identity, and expected item ids only
- never required for CI

## Run-Ledger Resume Canary

Run ledgers have a separate resume canary because they test workflow state, not corpus quality.

The synthetic fixture at `scripts/fixtures/newsletter-triage-run.jsonl` models an interrupted newsletter triage run:

- fetched newsletter sources were considered
- reading decisions were recorded
- one Reading Memory capture returned an item id
- an archive action remains pending verification

The resume tests assert that a fresh agent can derive completed decisions, pending external actions, captured item ids, and the next recovery step without touching a real inbox or mutating Reading Memory.

Run:

```bash
node --test --import tsx scripts/run-ledger-resume.test.mjs
```

This canary complements `npm run eval:reading`. It should stay synthetic and must not include raw newsletter bodies, private headers, bearer tokens, unsubscribe URLs, or live mailbox identifiers.

Morning brief assembly is the next proof workflow for this pattern, but `/brief-guide` and `/brief-events` remain the service-backed source-selection surfaces until two or three real run ledgers prove the event names should move into SQLite-backed run events.
