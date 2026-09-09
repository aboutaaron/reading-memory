import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { saveEmbedding, type Embedder } from './embeddings.js';
import { queryGraphCorpus } from './graph-query.js';
import { queryHybridCorpus } from './hybrid-query.js';

const vector = () => [1, ...Array<number>(1535).fill(0)];
function item(db: Database, id: string, text: string, options: { date?: string; tag?: string; status?: string; embed?: boolean } = {}) {
  db.prepare(`INSERT INTO items(id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', ?, ?, ?, ?, ?)`).run(id, id, options.date ?? '2026-09-09', id, options.status ?? 'indexed', text);
  db.prepare('INSERT INTO item_fts(item_id, title, body) VALUES (?, ?, ?)').run(id, id, text);
  if (options.tag) db.prepare("INSERT INTO tags VALUES (?, ?, 'fixture', 0.8)").run(id, options.tag);
  db.prepare(`INSERT INTO analyses(id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
    VALUES (?, ?, ?, 'save', 0.8, 'test', '1', '2026-09-09')`).run(`analysis-${id}`, id, text);
  if (options.embed) saveEmbedding(db, id, `analysis-${id}`, { model: 'openai/test', inputHash: 'fixture', vector: vector() });
}

function edge(db: Database, id: string, from: string, to: string, options: {
  type?: string; origin?: string; evidence?: string | null;
} = {}) {
  const text = (itemId: string) => (db.prepare('SELECT extracted_text FROM items WHERE id = ?').get(itemId) as { extracted_text: string }).extracted_text;
  db.prepare(`INSERT INTO relationships(id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at, origin, evidence_json)
    VALUES (?, ?, ?, ?, 'A proposed connection.', 0.8, '2026-09-09', ?, ?)`)
    .run(id, from, to, options.type ?? 'supports', options.origin ?? 'model',
      options.evidence === undefined ? JSON.stringify({ source_quote: text(from), target_quote: text(to) }) : options.evidence);
}

function database(t: import('node:test').TestContext) {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  return db;
}

test('quoted outgoing and incoming relationships retain their direction and unverified meaning', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache invalidation needs dependencies.');
  item(db, 'support', 'A register of ownership enables reliable refreshes.');
  item(db, 'challenge', 'Explicit freshness windows can replace dependency tracking.');
  edge(db, 'a', 'seed', 'support');
  edge(db, 'b', 'challenge', 'seed', { type: 'contradicts' });

  const result = await queryGraphCorpus(db, { query: 'cache invalidation', topK: 5 }, null);
  assert.deepEqual(result.citations, ['seed', 'support', 'challenge']);
  assert.equal(result.requested_mode, 'hybrid+graph');
  assert.equal(result.retrieval_mode, 'fts+graph');
  assert.equal(result.base_retrieval_mode, 'fts');
  assert.equal(result.fallback_reason, 'embeddings_unavailable');
  assert.equal(result.answer, '');
  assert.equal(result.confidence, null);
  assert.equal(result.graph_expansion.added_results, 2);
  assert.match(result.retrieval_hint, /not that the proposed relationship is true/);
  const outgoing = result.results[1]!;
  const incoming = result.results[2]!;
  assert.equal(outgoing.graph?.direction, 'outgoing');
  assert.equal(incoming.graph?.direction, 'incoming');
  assert.equal(incoming.graph?.from_item_id, 'challenge');
  assert.equal(incoming.graph?.to_item_id, 'seed');
  assert.equal(incoming.graph?.relation_type, 'contradicts');
  assert.equal(incoming.graph?.relationship_verification, 'unverified');
  assert.equal(incoming.graph?.evidence_verification, 'exact_quotes_in_current_sources');
  assert.equal(incoming.graph?.model_confidence, 0.8);
  assert.equal(incoming.snippet, incoming.graph?.evidence.source_quote);
  assert.equal(incoming.score, null);
  assert.equal(incoming.direct_rank, null);
});

test('partial lexical matches never seed expansion, and empty queries do not traverse edges', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache data.');
  item(db, 'neighbor', 'Unrelated recipes.');
  edge(db, 'edge', 'seed', 'neighbor');
  const weak = await queryGraphCorpus(db, { query: 'cache astrophysics', topK: 5 }, null);
  assert.deepEqual(weak.citations, ['seed']);
  assert.deepEqual(weak.graph_expansion.seed_item_ids, []);
  assert.equal(weak.graph_expansion.added_results, 0);
  const empty = await queryGraphCorpus(db, { query: 'the and' }, null);
  assert.deepEqual(empty.citations, []);
  assert.equal(empty.confidence, 0);
  assert.equal(empty.fallback_reason, 'no_search_terms');
});

test('only valid model relationships with current exact bounded quotations can expand', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache invalidation.');
  const invalid = [
    { origin: 'heuristic' }, { type: 'same_theme' }, { evidence: null }, { evidence: '{bad' },
    { evidence: 'null' }, { evidence: JSON.stringify({ source_quote: 1, target_quote: 'Wrong text.' }) },
    { evidence: JSON.stringify({ source_quote: 'Cache invalidation.', target_quote: 'Invented passage.' }) },
    { evidence: JSON.stringify({ source_quote: ' ', target_quote: 'Wrong text.' }) },
    { evidence: JSON.stringify({ source_quote: 'Cache invalidation.', target_quote: 'x'.repeat(1501) }) }
  ];
  for (const [index, options] of invalid.entries()) {
    item(db, `invalid-${index}`, index === 8 ? 'x'.repeat(1501) : 'Wrong text.');
    edge(db, `edge-${index}`, 'seed', `invalid-${index}`, options);
  }
  item(db, 'valid', 'Dependencies require ownership.');
  edge(db, 'z-valid', 'seed', 'valid', { type: 'extends' });
  assert.deepEqual((await queryGraphCorpus(db, { query: 'cache invalidation' }, null)).citations, ['seed', 'valid']);
  db.prepare("UPDATE items SET extracted_text = 'The source has changed.' WHERE id = 'valid'").run();
  assert.deepEqual((await queryGraphCorpus(db, { query: 'cache invalidation' }, null)).citations, ['seed']);
});

test('graph neighbors honor status, date and any-of tag filters before scan limits', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache invalidation.', { tag: 'infra' });
  for (const [id, options] of Object.entries({ old: { date: '2025-01-01', tag: 'infra' },
    failed: { status: 'failed', tag: 'infra' }, wrong: { tag: 'cooking' }, valid: { tag: 'infra' } })) {
    item(db, id, 'Ownership determines freshness.', options);
    edge(db, `edge-${id}`, 'seed', id);
  }
  const result = await queryGraphCorpus(db, { query: 'cache invalidation', since: '2026-09-01', tags: ['infra', 'distributed'] }, null);
  assert.deepEqual(result.citations, ['seed', 'valid']);
});

test('bounded one-hop expansion deduplicates neighbors, preserves direct order and refills unused slots', async t => {
  const db = database(t);
  for (const id of ['a', 'b', 'c', 'd', 'e']) item(db, id, 'Cache invalidation.');
  item(db, 'neighbor', 'Ownership determines freshness.');
  item(db, 'second-hop', 'A deeper unrelated topic.');
  edge(db, 'a-edge', 'a', 'neighbor');
  edge(db, 'b-edge', 'b', 'neighbor');
  edge(db, 'cycle', 'neighbor', 'a');
  edge(db, 'two-hop', 'neighbor', 'second-hop');
  for (const topK of [1, 2, 5, 25]) {
    const base = await queryHybridCorpus(db, { query: 'cache invalidation', topK: 25 }, null);
    const result = await queryGraphCorpus(db, { query: 'cache invalidation', topK }, null);
    assert.equal(new Set(result.citations).size, result.citations.length);
    assert.ok(result.results.length <= topK);
    assert.ok(result.graph_expansion.seed_item_ids.length <= 3);
    assert.ok(result.graph_expansion.added_results <= Math.min(2, Math.floor(topK / 2)));
    assert.ok(!result.citations.includes('second-hop'));
    const keep = topK - Math.min(2, Math.floor(topK / 2));
    assert.deepEqual(result.citations.slice(0, Math.min(keep, base.results.length)), base.citations.slice(0, keep));
    if (topK === 5) assert.deepEqual(result.citations, ['a', 'b', 'c', 'neighbor', 'd']);
    if (topK === 1) assert.deepEqual(result.citations, ['a']);
  }
});

test('a lower-ranked direct candidate may be promoted through graph evidence without duplication', async t => {
  const db = database(t);
  for (const id of ['a', 'b', 'c', 'd', 'e']) item(db, id, 'Cache invalidation.');
  edge(db, 'edge', 'a', 'e');
  const result = await queryGraphCorpus(db, { query: 'cache invalidation', topK: 5 }, null);
  assert.deepEqual(result.citations, ['a', 'b', 'c', 'e', 'd']);
  assert.equal(result.results[3]?.retrieval_origin, 'graph');
  assert.equal(result.results[3]?.direct_rank, 5);
  assert.deepEqual(result.results[3]?.matched_terms, ['cache', 'invalidation']);
});

test('edge scan limit is explicit and invalid high-degree edges cannot create unbounded expansion', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache invalidation.');
  for (let index = 0; index < 101; index++) {
    const id = String(index).padStart(3, '0');
    item(db, `neighbor-${id}`, 'Ownership matters.');
    edge(db, `edge-${id}`, 'seed', `neighbor-${id}`, index < 100 ? { evidence: '{bad' } : {});
  }
  const result = await queryGraphCorpus(db, { query: 'cache invalidation' }, null);
  assert.deepEqual(result.citations, ['seed']);
  assert.equal(result.graph_expansion.scan_truncated, true);
  assert.equal(result.graph_expansion.considered_edges, 100);
  assert.equal(result.graph_expansion.edge_scan_limit_per_seed, 100);
});

test('semantic-only seeds expand, while provider failures and incompatible models retain strong lexical graph fallback', async t => {
  const db = database(t);
  item(db, 'seed', 'Cache invalidation.', { embed: true });
  item(db, 'neighbor', 'Ownership matters.');
  edge(db, 'edge', 'seed', 'neighbor');
  const embedder: Embedder = { model: 'openai/test', async embed() { return vector(); } };
  const semantic = await queryGraphCorpus(db, { query: 'freshness dependencies' }, embedder);
  assert.deepEqual(semantic.citations, ['seed', 'neighbor']);
  assert.equal(semantic.retrieval_mode, 'hybrid+graph');
  assert.deepEqual(semantic.results[0]?.matched_terms, []);
  for (const [provider, reason] of [
    [{ model: 'openai/different', async embed() { throw new Error('should not call'); } }, 'no_compatible_embeddings'],
    [{ model: 'openai/test', async embed() { throw new Error('secret'); } }, 'embedding_query_failed']
  ] as const) {
    const result = await queryGraphCorpus(db, { query: 'cache invalidation' }, provider);
    assert.deepEqual(result.citations, ['seed', 'neighbor']);
    assert.equal(result.fallback_reason, reason);
    assert.equal(result.retrieval_mode, 'fts+graph');
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test('forgetting or replacing relationships while provider is pending cannot leak stale graph content', async t => {
  for (const operation of ['forget', 'replace', 'change-text'] as const) {
    await t.test(operation, async t => {
      const db = database(t);
      item(db, 'seed', 'Cache invalidation.', { embed: true });
      item(db, 'neighbor', 'Private passage.');
      edge(db, 'edge', 'seed', 'neighbor');
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      const pending = queryGraphCorpus(db, { query: 'cache invalidation' }, {
        model: 'openai/test', async embed() { entered(); await resumed; return vector(); }
      });
      await started;
      if (operation === 'forget') db.prepare("DELETE FROM items WHERE id = 'neighbor'").run();
      if (operation === 'replace') db.prepare("DELETE FROM relationships WHERE from_item_id = 'seed'").run();
      if (operation === 'change-text') db.prepare("UPDATE items SET extracted_text = 'Replacement passage.' WHERE id = 'neighbor'").run();
      release();
      const result = await pending;
      assert.deepEqual(result.citations, ['seed']);
      assert.doesNotMatch(JSON.stringify(result), /Private passage|"neighbor"/);
    });
  }
});
