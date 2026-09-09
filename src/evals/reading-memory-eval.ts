import { pathToFileURL } from 'node:url';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { BriefEventStore } from '../reading/brief-events.js';
import { briefGuide } from '../reading/brief-guide.js';
import { getItem, queryCorpus } from '../reading/corpus-query.js';
import { ItemStore } from '../reading/item-store.js';
import { ReaderAnnotationStore } from '../reading/reader-annotations.js';
import { runHybridRetrievalEval } from './hybrid-retrieval-eval.js';
import { runRetrievalQualityEval } from './retrieval-quality-eval.js';
import { readingMemoryBriefFixtures } from './reading-memory-brief-fixtures.js';
import {
  EVAL_BRIEF_DATE, EVAL_INGESTED_AT, fixture,
  readingMemoryEvalFixtures, readingMemoryQueryFixtures,
  type ReadingMemoryEvalFixture
} from './reading-memory-fixtures.js';

export type ReadingMemoryEvalResult = {
  fixture_id: string;
  check: 'query_recall' | 'brief_selection' | 'memory_durability' | 'hybrid_retrieval' | 'lexical_policy' | 'graph_retrieval';
  passed: boolean;
  details: Record<string, unknown>;
};

/** Tests retrieval/persistence/selection with canned analyses; never calls a model. */
export async function runReadingMemoryEval(): Promise<ReadingMemoryEvalResult[]> {
  assertUniqueIds(readingMemoryEvalFixtures.map((item) => item.id));
  assertUniqueIds([...readingMemoryQueryFixtures, ...readingMemoryBriefFixtures].map((item) => item.id));
  const results: ReadingMemoryEvalResult[] = [];
  const db = openMemoryDatabase();
  try {
    const ids = await seed(db, readingMemoryEvalFixtures);
    const labels = fixtureLabels(ids);
    for (const query of readingMemoryQueryFixtures) {
      const response = queryCorpus(db, { query: query.query, topK: 5,
        ...(query.tags ? { tags: query.tags } : {}), ...(query.since ? { since: query.since } : {}) });
      const returned = response.results.slice(0, 5).map((item) => labels.get(item.item_id) ?? 'UNKNOWN_ITEM');
      const hits = query.expected.filter((id) => returned.includes(id)).length;
      const recall = query.expected.length ? hits / query.expected.length : null;
      const forbidden = (query.forbidden ?? []).filter((id) => returned.includes(id));
      const unsupportedResults = query.expected.length === 0 ? returned.length : 0;
      const citationsValid = response.citations.length === response.results.length
        && response.citations.every((id, index) => id === response.results[index]?.item_id && labels.has(id));
      const confidenceHonest = response.confidence === (returned.length ? null : 0);
      const partialLabeled = !query.partial || (response.match_strategy === 'partial_terms'
        && response.results.every((item) => item.match_reason.includes('Partial') && item.matched_terms.length > 0));
      results.push({
        fixture_id: query.id,
        check: 'query_recall',
        passed: (recall === null || recall === 1) && forbidden.length === 0 && unsupportedResults === 0
          && response.answer === '' && citationsValid && confidenceHonest && partialLabeled,
        details: {
          query: query.query, expected: query.expected, returned, recall_at_5: recall,
          forbidden_hits: forbidden, unsupported_result_count: unsupportedResults,
          unsupported_answer: response.answer !== '', citations_valid: citationsValid,
          confidence_contract: confidenceHonest, partial_label_contract: partialLabeled,
          match_strategy: response.match_strategy
        }
      });
    }
    results.push(...await memoryChecks(db, ids));
  } finally {
    db.close();
  }

  for (const scenario of readingMemoryBriefFixtures) {
    const briefDb = openMemoryDatabase();
    try {
      const ids = await seed(briefDb, scenario.items);
      const labels = fixtureLabels(ids);
      const events = new BriefEventStore(briefDb);
      for (const [index, event] of (scenario.events ?? []).entries()) {
        events.record({
          principal: 'eval', requestId: `brief-${index}`, payloadHash: `synthetic-brief-${index}`,
          body: { request_id: `brief-${index}`, events: [{
            item_id: ids.get(event.item)!, brief_date: event.date, event_kind: event.kind,
            included_bool: event.kind !== 'skipped', rationale: 'Synthetic editorial decision',
            source_context: 'synthetic_eval_fixture', resurface_after: event.resurfaceAfter
          }] }
        });
        // Make event ordering independent of runtime speed and wall clock.
        briefDb.prepare('UPDATE brief_events SET created_at = ? WHERE item_id = ? AND brief_date = ? AND event_kind = ?')
          .run(new Date(Date.parse(`${event.date}T09:00:00.000Z`) + index).toISOString(),
            ids.get(event.item)!, event.date, event.kind);
      }
      const guide = briefGuide(briefDb, { briefDate: EVAL_BRIEF_DATE, lookbackHours: 24,
        ...(scenario.focus ? { focus: scenario.focus } : {}) });
      const selected = guide.candidates.map((item) => labels.get(item.item_id) ?? 'UNKNOWN_ITEM');
      const missed = scenario.expected.filter((id) => !selected.includes(id));
      const irrelevant = selected.filter((id) => !scenario.expected.includes(id));
      const forbidden = (scenario.forbidden ?? []).filter((id) => selected.includes(id));
      const missedDue = (scenario.due ?? []).filter((id) => !selected.includes(id));
      const repeats = (scenario.repeats ?? []).filter((id) => selected.includes(id));
      const ordering = !scenario.first || selected[0] === scenario.first;
      const rationale = !scenario.rationale || Boolean(guide.candidates.find(
        (item) => item.item_id === ids.get(scenario.rationale!.item)
      )?.why_now.includes(scenario.rationale.includes));
      results.push({
        fixture_id: scenario.id, check: 'brief_selection',
        passed: missed.length === 0 && irrelevant.length === 0 && forbidden.length === 0
          && missedDue.length === 0 && repeats.length === 0 && ordering && rationale,
        details: {
          brief_date: EVAL_BRIEF_DATE, expected: scenario.expected, selected,
          missed_expected: missed, irrelevant_selections: irrelevant, forbidden_selections: forbidden,
          missed_due_items: missedDue, unwanted_repeats: repeats,
          ordering_correct: ordering, rationale_preserved: rationale
        }
      });
    } finally {
      briefDb.close();
    }
  }
  results.push(...await runHybridRetrievalEval());
  results.push(...await runRetrievalQualityEval());
  return results;
}

export function summarizeReadingMemoryEval(results: ReadingMemoryEvalResult[]) {
  const queries = results.filter((result) => result.check === 'query_recall');
  const recall = queries.map((result) => result.details.recall_at_5).filter((value): value is number => typeof value === 'number');
  const briefs = results.filter((result) => result.check === 'brief_selection');
  const hybrid = results.filter((result) => result.check === 'hybrid_retrieval');
  const lexicalPolicy = results.filter((result) => result.check === 'lexical_policy');
  const graph = results.filter((result) => result.check === 'graph_retrieval');
  const countLists = (rows: ReadingMemoryEvalResult[], key: string) => rows.reduce(
    (sum, row) => sum + (Array.isArray(row.details[key]) ? row.details[key].length : 0), 0
  );
  return {
    fixture_id: 'summary', check: 'summary', passed: results.every((result) => result.passed),
    scope: 'Synthetic deterministic regression; canned analyses and embedding vectors; no live model or private corpus',
    checks: results.length, passed_checks: results.filter((result) => result.passed).length,
    query_cases: queries.length, positive_query_cases: recall.length,
    mean_recall_at_5: recall.length ? recall.reduce((sum, value) => sum + value, 0) / recall.length : null,
    unsupported_query_false_positives: queries.filter((result) => Number(result.details.unsupported_result_count) > 0).length,
    unsupported_result_false_positives: queries.reduce((sum, result) => sum + Number(result.details.unsupported_result_count), 0),
    unsupported_answers: queries.filter((result) => result.details.unsupported_answer === true).length,
    hybrid_cases: hybrid.length,
    passed_hybrid_cases: hybrid.filter((result) => result.passed).length,
    lexical_policy_cases: lexicalPolicy.length,
    passed_lexical_policy_cases: lexicalPolicy.filter((result) => result.passed).length,
    graph_cases: graph.length,
    passed_graph_cases: graph.filter((result) => result.passed).length,
    brief_cases: briefs.length,
    irrelevant_brief_selections: countLists(briefs, 'irrelevant_selections'),
    missed_due_items: countLists(briefs, 'missed_due_items'),
    unwanted_repeats: countLists(briefs, 'unwanted_repeats')
  };
}

async function seed(db: Database, fixtures: ReadingMemoryEvalFixture[]) {
  assertUniqueIds(fixtures.map((item) => item.id));
  const store = new ItemStore(db);
  const ids = new Map<string, string>();
  for (const [index, item] of fixtures.entries()) {
    const ingested = await store.ingest({
      principal: 'eval', requestId: `eval-${item.id}`, payloadHash: `sha256:eval-${item.id}`,
      source: item.source, analyze: async () => item.analysis
    });
    ids.set(item.id, ingested.item_id);
    // Stable distinct timestamps prevent random IDs from resolving ranking ties.
    const at = new Date(Date.parse(item.ingestedAt) + index).toISOString();
    db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run(at, ingested.item_id);
    db.prepare('UPDATE analyses SET created_at = ? WHERE item_id = ?').run(at, ingested.item_id);
  }
  return ids;
}

async function memoryChecks(db: Database, ids: Map<string, string>): Promise<ReadingMemoryEvalResult[]> {
  const item = readingMemoryEvalFixtures.find((source) => source.id === 'agent-memory')!;
  const itemId = ids.get(item.id)!;
  const duplicate = await new ItemStore(db).ingest({
    principal: 'eval', requestId: 'eval-durable-duplicate', payloadHash: 'sha256:eval-durable-duplicate',
    source: item.source, analyze: async () => { throw new Error('Duplicate must not rerun analysis'); }
  });
  const stored = getItem(db, itemId);
  const results: ReadingMemoryEvalResult[] = [{
    fixture_id: 'durable-analysis-rationale', check: 'memory_durability',
    passed: duplicate.reason === item.analysis.reason && stored?.analysis?.reason === item.analysis.reason,
    details: { duplicate_reason_preserved: duplicate.reason === item.analysis.reason,
      item_reason_preserved: stored?.analysis?.reason === item.analysis.reason }
  }];

  const related = fixture({ id: 'evidence-connection', text: 'Replay evidence to verify a recalled claim.' });
  const sourceQuote = related.source.extractedText;
  const targetQuote = item.source.extractedText;
  const connected = await new ItemStore(db).ingest({
    principal: 'eval', requestId: 'eval-evidence', payloadHash: 'sha256:eval-evidence', source: related.source,
    analyze: async (fromId) => ({ ...related.analysis, relationships: [{
      from_item_id: fromId, to_item_id: itemId, relation_type: 'supports',
      explanation: 'Synthetic passage supports checking recalled claims against evidence.',
      confidence: 0.8, origin: 'model', evidence: { source_quote: sourceQuote, target_quote: targetQuote }
    }] })
  });
  db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run(EVAL_INGESTED_AT, connected.item_id);
  db.prepare('UPDATE analyses SET created_at = ? WHERE item_id = ?').run(EVAL_INGESTED_AT, connected.item_id);
  const retrieved = getItem(db, connected.item_id, { includeText: true });
  const relationship = retrieved?.relationships.find((connection) => connection.to_item_id === itemId);
  results.push({
    fixture_id: 'durable-connection-evidence', check: 'memory_durability',
    passed: retrieved?.extracted_text === sourceQuote && relationship?.origin === 'model'
      && relationship?.evidence?.source_quote === sourceQuote && relationship?.evidence?.target_quote === targetQuote,
    details: { source_text_preserved: retrieved?.extracted_text === sourceQuote,
      evidence_preserved: relationship?.evidence?.source_quote === sourceQuote && relationship?.evidence?.target_quote === targetQuote,
      origin_preserved: relationship?.origin === 'model' }
  });

  const annotations = new ReaderAnnotationStore(db);
  const originalNote = '  I disagree with the amberanchor assumption.\nKeep the exact wording.  ';
  const original = annotations.record({
    principal: 'eval', requestId: 'annotation-original', itemId,
    body: { request_id: 'annotation-original', actor_type: 'user', actor: 'Synthetic reader',
      note: originalNote, project: 'Synthetic evaluation project', question: 'Can evidence be replayed?' }
  });
  const agent = annotations.record({
    principal: 'eval', requestId: 'annotation-agent', itemId,
    body: { request_id: 'annotation-agent', actor_type: 'agent', actor: 'Synthetic analyst',
      note: 'Interpretation: the reader may want reproducible claims.' }
  });
  const corrected = annotations.record({
    principal: 'eval', requestId: 'annotation-correction', itemId,
    body: { request_id: 'annotation-correction', actor_type: 'user', actor: 'Synthetic reader',
      note: 'The heliotrope assumption is acceptable after replay.', supersedes_annotation_id: original.annotation.id }
  });
  for (const [index, annotation] of [original, agent, corrected].entries()) {
    db.prepare('UPDATE reader_annotations SET created_at = ? WHERE id = ?')
      .run(new Date(Date.parse(EVAL_INGESTED_AT) + index).toISOString(), annotation.annotation.id);
  }
  const history = getItem(db, itemId)?.reader_annotations ?? [];
  const originalStored = history.find((note) => note.id === original.annotation.id);
  const correctionStored = history.find((note) => note.id === corrected.annotation.id);
  const agentStored = history.find((note) => note.id === agent.annotation.id);
  const activeRecall = queryCorpus(db, { query: 'heliotrope', topK: 5 }).citations.some((id) => id === itemId);
  const staleRecall = queryCorpus(db, { query: 'amberanchor', topK: 5 }).citations.some((id) => id === itemId);
  results.push({
    fixture_id: 'durable-reader-judgment-and-correction', check: 'memory_durability',
    passed: history.length === 3 && originalStored?.note === originalNote && originalStored.active === false
      && originalStored.project === 'Synthetic evaluation project' && originalStored.question === 'Can evidence be replayed?'
      && correctionStored?.active === true && correctionStored.supersedes_annotation_id === original.annotation.id
      && originalStored.actor_type === 'user' && agentStored?.actor_type === 'agent' && agentStored.active === true
      && activeRecall && !staleRecall,
    details: { exact_reader_words_preserved: originalStored?.note === originalNote,
      reader_and_agent_distinguished: originalStored?.actor_type === 'user' && agentStored?.actor_type === 'agent',
      correction_keeps_history: originalStored?.active === false && correctionStored?.active === true,
      active_note_recalled: activeRecall, superseded_note_recalled: staleRecall }
  });
  return results;
}

function fixtureLabels(ids: Map<string, string>) {
  return new Map([...ids].map(([label, id]) => [id, label]));
}

function assertUniqueIds(ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate eval fixture id: ${id}`);
    seen.add(id);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runReadingMemoryEval();
  for (const result of results) console.log(JSON.stringify(result));
  const summary = summarizeReadingMemoryEval(results);
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}
