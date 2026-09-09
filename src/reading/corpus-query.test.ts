import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { queryCorpus } from './corpus-query.js';
import { extractSearchTerms, toFtsQuery } from './search-terms.js';

function addItem(db: Database, id: string, text: string, options: {
  title?: string;
  summary?: string;
  tags?: string[];
  ingestedAt?: string;
  status?: 'indexed' | 'failed';
} = {}) {
  const title = options.title ?? id;
  db.prepare(`
    INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', ?, ?, ?, ?, ?)
  `).run(id, title, options.ingestedAt ?? '2026-09-09T12:00:00.000Z', `sha256:${id}`, options.status ?? 'indexed', text);
  db.prepare('INSERT INTO item_fts (item_id, title, body, summary, tags) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, text, options.summary ?? '', options.tags?.join(' ') ?? '');
  for (const tag of options.tags ?? []) {
    db.prepare('INSERT INTO tags (item_id, tag, reason, confidence) VALUES (?, ?, ?, ?)')
      .run(id, tag, 'fixture', 0.5);
  }
}

test('a natural recall question finds its late subject and excludes conversational hard negatives', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'cache', 'Cache invalidation requires reliable change detection.', { title: 'Data freshness' });
  for (let i = 0; i < 8; i++) {
    addItem(db, `cooking-${i}`, 'Can you help me find that article about cooking dinner?');
  }

  const result = queryCorpus(db, { query: 'Can you help me find that article about cache invalidation?' });
  assert.deepEqual(result.search_terms, ['cache', 'invalidation']);
  assert.deepEqual(result.results.map((item) => item.item_id), ['cache']);
  assert.equal(result.match_strategy, 'all_terms');
  assert.deepEqual(result.results[0]?.matched_terms, ['cache', 'invalidation']);
  assert.equal(result.confidence, null);
  assert.equal(result.answer, '');
  assert.equal(result.retrieval_mode, 'fts');
  assert.match(result.retrieval_hint, /not confidence probabilities/);
});

test('short domain terms survive stopword removal and full matches take precedence', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'ai-ml', 'AI and ML support useful BI systems.');
  addItem(db, 'ai-only', 'AI AI AI is everywhere.');
  addItem(db, 'ordinary', 'Can you find articles about dinner?');

  const result = queryCorpus(db, { query: 'Can you find articles about AI and ML?' });
  assert.deepEqual(result.search_terms, ['ai', 'ml']);
  assert.deepEqual(result.citations, ['ai-ml']);
  assert.equal(result.match_strategy, 'all_terms');
});

test('OR fallback explicitly reports partial terms and makes no synthesized claim', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'semantic', 'Semantic layers govern definitions.');
  addItem(db, 'evidence', 'Executed evidence supports claims.');

  const result = queryCorpus(db, { query: 'semantic layers evidence' });
  assert.equal(result.match_strategy, 'partial_terms');
  assert.equal(result.confidence, null);
  assert.equal(result.answer, '');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.find((item) => item.item_id === 'semantic')?.matched_terms, ['semantic', 'layers']);
  assert.deepEqual(result.results.find((item) => item.item_id === 'evidence')?.matched_terms, ['evidence']);
  for (const row of result.results) assert.match(row.match_reason, /Partial lexical match.*OR/);
});

test('unknown topics and conversational-only questions abstain despite many unrelated documents', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (let i = 0; i < 10; i++) addItem(db, `filler-${i}`, 'Can you help me find that article about cooking?');

  for (const query of ['Can you help me find that article?', '!!! ---', 'Can you find that article about quasars?']) {
    const result = queryCorpus(db, { query });
    assert.equal(result.match_strategy, 'none');
    assert.equal(result.confidence, 0);
    assert.equal(result.answer, '');
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.results, []);
    assert.ok(result.empty_reason);
  }
});

test('both AND and OR respect date, tags, status, and result limits', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'old', 'Cache invalidation matters.', { ingestedAt: '2026-08-01T12:00:00.000Z', tags: ['infra'] });
  addItem(db, 'wrong-tag', 'Cache invalidation matters.', { tags: ['cooking'] });
  addItem(db, 'failed', 'Cache invalidation matters.', { tags: ['infra'], status: 'failed' });
  addItem(db, 'eligible', 'Cache invalidation matters.', { tags: ['infra'] });

  for (const query of ['cache invalidation', 'cache invalidation freshness']) {
    const result = queryCorpus(db, { query, since: '2026-09-01', tags: ['infra'], topK: 1 });
    assert.deepEqual(result.citations, ['eligible']);
  }
  assert.deepEqual(queryCorpus(db, { query: 'cache invalidation', tags: ['absent'] }).results, []);
});

test('FTS supplies matches across fields and diacritics rather than substring guesses', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'career', 'Practical advice.', { title: 'Résumé strategy', tags: ['leadership'] });
  addItem(db, 'comparison', 'An unrelated subject.', { summary: 'Career narratives' });

  const result = queryCorpus(db, { query: 'resume leadership missing' });
  assert.equal(result.match_strategy, 'partial_terms');
  assert.deepEqual(result.results[0]?.matched_terms, ['resume', 'leadership']);
  assert.match(result.results[0]?.snippet ?? '', /\[Résumé\]|\[leadership\]/);
});

test('lexical extraction deduplicates, preserves Unicode and hyphen parts, and safely quotes operators', () => {
  assert.deepEqual(extractSearchTerms('AI AI ml tool-use naïve 東京'), ['ai', 'ml', 'tool', 'use', 'naïve', '東京']);
  assert.deepEqual(extractSearchTerms([null, undefined, 'the article', 'ML and AI']), ['ml', 'ai']);
  assert.equal(toFtsQuery(['cache', 'invalidation'], 'AND'), '"cache" AND "invalidation"');
  assert.equal(toFtsQuery(['a"b', 'OR']), '"a""b" OR "OR"');
});

test('result counts never manufacture answer confidence', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'first', 'Cache invalidation needs change detection.');
  assert.equal(queryCorpus(db, { query: 'cache invalidation' }).confidence, null);
  for (let i = 0; i < 12; i++) addItem(db, `duplicate-topic-${i}`, 'Cache invalidation needs change detection.');
  const result = queryCorpus(db, { query: 'cache invalidation', topK: 12 });
  assert.equal(result.confidence, null);
  assert.equal(result.citations.length, result.results.length);
  assert.equal(result.results.length, 12);
});
