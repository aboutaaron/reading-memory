import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { graphDiagnostics } from './graph-diagnostics.js';
import { queryGraphCorpus } from './graph-query.js';

test('graph diagnostics count only the same current, quote-backed model edges accepted by retrieval', async t => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  assert.equal(graphDiagnostics(db).total_relationships, 0);
  const item = (id: string, body: string, status = 'indexed') => {
    db.prepare(`INSERT INTO items(id, source_type, title, ingested_at, content_hash, status, extracted_text)
      VALUES (?, 'text', ?, '2026-09-09', ?, ?, ?)`).run(id, id, id, status, body);
    db.prepare('INSERT INTO item_fts(item_id, title, body) VALUES (?, ?, ?)').run(id, id, body);
  };
  item('seed', 'Cache invalidation.');
  const variants = [
    {}, { origin: 'heuristic' }, { type: 'same_theme' }, { evidence: '{bad' },
    { evidence: JSON.stringify({ source_quote: 'Cache invalidation.', target_quote: 'Missing passage.' }) },
    { evidence: JSON.stringify({ source_quote: '', target_quote: 'Ownership matters.' }) },
    { evidence: JSON.stringify({ source_quote: 1, target_quote: 'Ownership matters.' }) },
    { evidence: JSON.stringify({ source_quote: 'Cache invalidation.', target_quote: 'x'.repeat(1501) }) },
    { confidence: 1.1 }, { status: 'failed' }, { evidence: ' '.repeat(16001) }, { evidence: null }
  ];
  for (const [index, options] of variants.entries()) {
    item(`peer-${index}`, index === 7 ? 'x'.repeat(1501) : 'Ownership matters.', options.status);
    db.prepare(`INSERT INTO relationships(id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at, origin, evidence_json)
      VALUES (?, 'seed', ?, ?, 'Proposed interpretation.', ?, '2026-09-09', ?, ?)`)
      .run(`edge-${index}`, `peer-${index}`, options.type ?? 'supports', options.confidence ?? 0.8,
        options.origin ?? 'model', options.evidence === undefined
          ? JSON.stringify({ source_quote: 'Cache invalidation.', target_quote: 'Ownership matters.' }) : options.evidence);
  }
  const result = graphDiagnostics(db);
  assert.equal(result.total_relationships, variants.length);
  assert.equal(result.model_relationships, variants.length - 1);
  assert.equal(result.heuristic_relationships, 1);
  assert.equal(result.eligible_relationships, 1);
  const query = await queryGraphCorpus(db, { query: 'cache invalidation', topK: 5 }, null);
  assert.equal(query.graph_expansion.added_results, result.eligible_relationships);
  assert.deepEqual(query.citations, ['seed', 'peer-0']);
  assert.doesNotMatch(JSON.stringify(result), /Cache invalidation|Ownership matters/);
  db.prepare("UPDATE items SET extracted_text = 'Changed content.' WHERE id = 'peer-0'").run();
  assert.equal(graphDiagnostics(db).eligible_relationships, 0);
  assert.equal((await queryGraphCorpus(db, { query: 'cache invalidation' }, null)).graph_expansion.added_results, 0);
});
