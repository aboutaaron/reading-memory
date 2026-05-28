import { openMemoryDatabase } from '../db/connection.js';
import { briefGuide } from '../reading/brief-guide.js';
import { queryCorpus } from '../reading/corpus-query.js';
import { ItemStore } from '../reading/item-store.js';
import { readingMemoryEvalFixtures } from './reading-memory-fixtures.js';

export type ReadingMemoryEvalResult = {
  fixture_id: string;
  check: string;
  passed: boolean;
  details: Record<string, unknown>;
};

export async function runReadingMemoryEval(): Promise<ReadingMemoryEvalResult[]> {
  const duplicate = firstDuplicate(readingMemoryEvalFixtures.map((fixture) => fixture.id));
  if (duplicate) throw new Error(`Duplicate eval fixture id: ${duplicate}`);

  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const itemIds = new Map<string, string>();

  for (const fixture of readingMemoryEvalFixtures) {
    const ingested = await store.ingest({
      principal: 'eval',
      requestId: `eval-${fixture.id}`,
      payloadHash: `sha256:eval-${fixture.id}`,
      source: fixture.source,
      analyze: async () => fixture.analysis
    });
    itemIds.set(fixture.id, ingested.item_id);
  }

  const results: ReadingMemoryEvalResult[] = [];
  const semantic = queryCorpus(db, { query: 'semantic layers analytics agents', topK: 3 });
  const semanticCitations = semantic.citations as string[];
  results.push({
    fixture_id: 'semantic-layers',
    check: 'query_expected_citation',
    passed: semanticCitations.includes(itemIds.get('semantic-layers') ?? ''),
    details: { citations: semantic.citations, empty_reason: semantic.empty_reason }
  });

  const noisy = queryCorpus(db, { query: '--- !!!', topK: 3 });
  results.push({
    fixture_id: 'empty-query',
    check: 'empty_query_is_low_confidence',
    passed: noisy.confidence === 0 && noisy.results.length === 0,
    details: { confidence: noisy.confidence, empty_reason: noisy.empty_reason }
  });

  const guide = briefGuide(db, {
    briefDate: new Date().toISOString().slice(0, 10),
    lookbackHours: 24,
    focus: ['agent-memory']
  });
  results.push({
    fixture_id: 'agent-memory',
    check: 'brief_expected_candidate',
    passed: guide.candidates.some((candidate) => candidate.item_id === itemIds.get('agent-memory')),
    details: { candidates: guide.candidates.map((candidate) => candidate.item_id), skip_items: guide.skip_items }
  });

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runReadingMemoryEval();
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

function firstDuplicate(values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
