import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openMemoryDatabase, reconcileFts } from './connection.js';
import { ItemStore } from '../reading/item-store.js';
import { queryCorpus } from '../reading/corpus-query.js';
import type { Analysis, ExtractedSource } from '../reading/types.js';

const source: ExtractedSource = {
  sourceType: 'text',
  sourceUri: null,
  canonicalUrl: null,
  finalUrl: null,
  title: 'FTS recovery',
  extractedText: 'FTS recovery should rebuild missing reading corpus rows.',
  truncated: false,
  contentHash: 'sha256:fts-recovery',
  rawBytesHash: null,
  provenance: {}
};

const analysis: Analysis = {
  summary: 'FTS recovery should rebuild missing reading corpus rows.',
  claims: ['FTS recovery rebuilds rows.'],
  relevance: { score: 0.75, themes: ['fts-recovery'] },
  recommended_action: 'save',
  confidence: 0.75,
  reason: 'Regression fixture',
  tags: [{ tag: 'fts-recovery', reason: 'test', confidence: 0.9 }],
  relationships: [],
  model: 'test',
  analysis_version: 'test'
};

test('refuses to stamp an incompatible v0 database as current', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');

  assert.throws(
    () => migrate(db),
    /user_version 0.*app tables already exist/
  );
});

test('reconciles missing FTS rows from canonical corpus tables', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const ingested = await store.ingest({
    principal: 'token:test',
    requestId: 'req-fts',
    payloadHash: 'sha256:req-fts',
    source,
    analyze: async () => analysis
  });

  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, [ingested.item_id]);

  db.prepare('DELETE FROM item_fts WHERE item_id = ?').run(ingested.item_id);
  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, []);

  reconcileFts(db);
  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, [ingested.item_id]);
});

test('does not rebuild FTS rows for incomplete ingests', () => {
  const db = openMemoryDatabase();
  db.prepare(`
    INSERT INTO items (
      id, source_type, title, ingested_at, content_hash, status, extracted_text, truncated, provenance_json
    ) VALUES (?, 'text', ?, ?, ?, 'analyzing', ?, 0, '{}')
  `).run(
    'item_incomplete',
    'Incomplete',
    new Date().toISOString(),
    'sha256:incomplete',
    'unfinished content should not be searchable'
  );

  reconcileFts(db);

  assert.deepEqual(queryCorpus(db, { query: 'unfinished searchable' }).citations, []);
});
