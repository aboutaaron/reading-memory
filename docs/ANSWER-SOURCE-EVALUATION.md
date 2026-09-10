# Answer and source alignment evaluation

An authentic quotation can support a true statement about the wrong article. A family assertion can also be false even when every quotation is real. Evaluate these dimensions separately from retrieval recall and relationship validity. This protocol changes consumer guidance and evaluation only; it does not change retrieval, source identity heuristics, models, or production settings.

## Run the synthetic regression controls

```bash
npm run eval:answer-sources
```

The underlying command is `node --import tsx src/evals/answer-source-eval.ts`. It runs twelve explicitly synthetic cases without a provider, database, credentials, network calls, or file writes. Exit zero means the **receipt scorer produces the expected dimensions on authored good and bad controls**. A deliberately bad answer is a passing regression control when its failure is detected. This is not a generated-answer test or a measurement of model quality.

The fixture sources are invented essays at `example.test`:

- Essay A critiques a library metaphor because recall reconstructs memories.
- Essay B retains that metaphor for finding notes, with a caveat about reconstruction.
- Essay C discusses searchable meeting notes and is a related but incorrect substitute for A.

Controls include a correct A/B comparison; a genuine C quotation substituted for A; exact quotations accompanied by an unsupported blanket conclusion; disclosure of a missing requested source; an ambiguous question that should be clarified; same-publisher articles at different URLs; absent family metadata; recognized repeated captures; and unjustified independence claims. The unit tests additionally exercise name-dropping A/B while answering about C, unread sources, stale reviews, bounded family resolution and incomplete labels.

## Freeze the experiment before retrieval

Maintain separate cohorts for explicit named-source questions and ambiguous recall questions. Record intended item identities before retrieving either arm. Do not repair a prompt or redefine its intended sources after inspecting an answer. If a historical prompt is ambiguous, preserve it as an ambiguous case and add a newly named-source variant as a separate case. A hidden intended pair does not make that pair unambiguous to the consumer.

Freeze the prompt, intended identities, corpus snapshot, retrieved payload, item reads, model/instructions and expected outcomes. Use the same inputs and answer instructions in paired arms, except for the retrieval treatment under test. Keep repeated runs and their provider costs bounded by the agreed experiment budget. Report new runs separately from retained historical results and from the repository's synthetic controls.

Preserve the actual graph labels, explanations, endpoints and direction, quotations, confidence, origin, unverified status, and available family metadata in the graph arm. Preserve absence of metadata in the other arm; do not enrich it from the graph arm's hidden records. A synthetic duplicate-corroboration attack may deliberately present multiple same-family captures even though normal graph retrieval suppresses them. Label that injection explicitly and save the actual payload seen by the answerer.

Before answering, open the retained text using `GET /items/:id?include=text`, inspect truncation, and verify each claim in that source. Retrieval snippets and graph explanations do not replace this read. If a named source cannot be identified, report which source is missing and qualify or withhold the comparison. For an ambiguous recollection, clarify the intended titles or clearly state the candidate interpretation rather than silently substituting a thematically related source.

## Record answers and score independent dimensions

`src/evals/answer-source-evaluation.ts` exports typed `AnswerSourceCase`, `AnswerReceipt`, `AnswerSourceReview`, `answerCaseHash`, `answerReceiptHash`, and `evaluateAnswerSources`. These are evaluation records, not new Reading Memory API fields. A local evaluation runner can import them to score privately held cases. The synthetic CLI accepts no private input files and makes no provider calls.

The case records the prompt kind, frozen intended IDs, expected outcomes, and **supplied source text and metadata available to this answer arm**. The receipt records the exact answer, outcome, actual opened item IDs, compared and missing source IDs, claims with exact quotation/item-ID citations, and family assertions. Populate opened IDs from the harness's actual item reads, not an answer model's unverified declaration. Extract the full claim/family assertion inventory and have a separate reviewer check it against the entire answer; an omitted unsupported sentence must not escape review.

| Dimension | Mechanical evidence | Separate review |
| --- | --- | --- |
| Quotation presence | Nonempty exact text in the cited supplied source; counts and all-present status | Quoting real text does not establish truth or meaning. |
| Source opening | Every citation refers to an item actually opened in the recorded run | A declared item read must be backed by the harness trace. |
| Requested-source alignment | Intended sources have opened, quote-valid citations and the receipt compares the intended IDs | The prose must actually answer the requested comparison. Merely name-dropping intended IDs is insufficient. |
| Family assertions | Affirmative same/different-family claims agree with complete metadata actually supplied | Distinct families do not establish independent reporting; independence needs its own review. |
| Semantic entailment | No automatic semantic inference | Review each claim against the passages, including scope, qualifications, direction and omitted unsupported prose. |
| Completeness | Required source coverage is reported separately | Did the answer address the whole question with adequate evidence? |
| Abstention | Outcome agrees with the predeclared acceptable outcomes | Was abstention or clarification appropriate given the actual available evidence? |

For explicit comparisons, `requested_source_alignment.passed` combines the receipt's identity check with a manual prose-alignment label. A mechanical failure can be detected without review, but mechanically valid references alone produce `null`, not a pass. Ambiguous cases have alignment `null`; report intended-source coverage and clarification outcomes separately rather than calling a hidden-intention mismatch a proven retrieval error.

Missing-source disclosure is mechanically accepted only when the named intended source is absent from that case's **frozen supplied source set**. This does not establish absence from the whole corpus or the web. Distinguish “not available in this answer context,” “not found in this search,” and “does not exist.” A missing source cannot be declared simply because the answerer chose not to open a supplied source.

Same publisher, similar title, topical overlap, or different URLs alone do not establish source-family identity. A positive family assertion requires complete family metadata in this scorer. Absent or `bounded_fallback` metadata supports uncertainty, not an invented equivalence or independence claim. Repeated captures with one recognized family cannot count as several independent sources. Different complete family IDs establish only distinct resolver families; independence remains unscored until separately reviewed. Graph labels remain unverified interpretations throughout.

## Attach a review without turning it into a model judge

Have an independent reviewer inspect the full answer, source text and provenance with model/arm identity blinded where feasible. Record reviewer identity, per-claim entailment labels, whether the claims cover the answer, prose source alignment, completeness, abstention appropriateness, and any independence judgments. Preserve uncertainty as `null`. Do not ask the answer model to certify itself or use keyword matching as semantic truth.

Bind the review to both `answerReceiptHash(receipt)` and `answerCaseHash(testCase)`. The scorer rejects mismatched hashes, unknown or duplicate claim labels, and malformed independence indices. Hashes use the exact JSON serialization of the typed records; preserve the frozen records rather than rebuilding them with different key order. Any changed answer, evidence, prompt, family metadata or intended identity needs a fresh review. These hashes prevent accidental reuse, not dishonest reviewer labels.

For example, a private TypeScript runner can call:

```ts
const result = evaluateAnswerSources(frozenCase, receipt); // Unreviewed semantic dimensions stay null.
// After independent review has been recorded for these exact inputs:
const reviewedResult = evaluateAnswerSources(frozenCase, receipt, review);
```

The scorer accepts typed records; it is not an untrusted JSON ingestion endpoint. A runner that loads external JSON must validate it before calling the function. Keep private inputs, complete answers, traces and reviews local. Report dimension-specific numerators, denominators and unknowns by cohort/arm. Do not average null judgments as zero, treat no quotations as a perfect quotation score, or combine exact quotation checks and semantic review into a single “verified answer” badge. Passing authored fixtures shows scorer behavior; model recommendations need a separately executed, reviewed comparison.
