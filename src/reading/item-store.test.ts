import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import type { Analysis, ExtractedSource } from './types.js';

const source: ExtractedSource = {
  sourceType: 'text',
  sourceUri: null,
  canonicalUrl: null,
  finalUrl: null,
  title: 'Agent memory',
  extractedText: 'Agent memory needs durable recall and evaluation.',
  truncated: false,
  contentHash: 'sha256:test',
  rawBytesHash: null,
  provenance: {}
};

const analysis: Analysis = {
  summary: 'Agent memory needs durable recall and evaluation.',
  claims: ['Agent memory needs durable recall and evaluation.'],
  relevance: { score: 0.8, themes: ['agent-memory', 'evaluation'] },
  recommended_action: 'brief',
  confidence: 0.8,
  reason: 'Matched themes',
  tags: [{ tag: 'agent-memory', reason: 'test', confidence: 0.8 }],
  relationships: [],
  model: 'test',
  analysis_version: 'test'
};

test('replays same request from idempotency snapshot', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => analysis
  });
  const second = await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => ({ ...analysis, summary: 'should not run' })
  });

  assert.equal(first.item_id, second.item_id);
  assert.equal(second.dedupe_status, 'idempotent_replay');
  assert.equal(second.summary, first.summary);
});

test('conflicting idempotency replay fails', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => analysis
  });

  await assert.rejects(
    () => store.ingest({
      principal: 'token:test',
      requestId: 'req-1',
      payloadHash: 'sha256:changed',
      source,
      analyze: async () => analysis
    }),
    /different payload/
  );
});

test('same request joins in-flight analysis instead of conflicting with itself', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let analyzeCount = 0;
  let resolveAnalysis!: (value: Analysis) => void;
  const pending = new Promise<Analysis>((resolve) => { resolveAnalysis = resolve; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => {
      analyzeCount += 1;
      return pending;
    }
  });
  const second = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => ({ ...analysis, summary: 'should not run' })
  });

  resolveAnalysis(analysis);
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(analyzeCount, 1);
  assert.equal(firstResponse.item_id, secondResponse.item_id);
  assert.equal(secondResponse.dedupe_status, 'idempotent_replay');
  assert.equal(secondResponse.summary, firstResponse.summary);
});

test('conflicting same request fails while first analysis is in flight', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let resolveAnalysis!: (value: Analysis) => void;
  const pending = new Promise<Analysis>((resolve) => { resolveAnalysis = resolve; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req',
    source,
    analyze: async () => pending
  });
  first.catch(() => undefined);

  await assert.rejects(
    () => store.ingest({
      principal: 'token:test',
      requestId: 'req-1',
      payloadHash: 'sha256:changed',
      source,
      analyze: async () => analysis
    }),
    /different payload/
  );

  resolveAnalysis(analysis);
  await first;
});

test('duplicates dedupe by normalized content hash', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => analysis
  });
  const second = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source: { ...source, title: 'Duplicate' },
    analyze: async () => analysis
  });

  assert.equal(first.item_id, second.item_id);
  assert.equal(second.dedupe_status, 'existing');
});

test('ingest response surfaces related stored reading without treating it as duplicate', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => analysis
  });
  const second = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source: {
      ...source,
      title: 'Agent evaluation notes',
      extractedText: 'Evaluation discipline helps durable agent memory stay useful.',
      contentHash: 'sha256:related'
    },
    analyze: async () => ({
      ...analysis,
      summary: 'Evaluation discipline helps durable agent memory stay useful.',
      claims: ['Agent memory benefits from evaluation discipline.']
    })
  });

  assert.notEqual(first.item_id, second.item_id);
  assert.equal(second.dedupe_status, 'created');
  assert.equal(second.related_items[0]?.item_id, first.item_id);
  assert.match(second.related_items[0]?.match_reason ?? '', /Matched stored reading/);
});

test('unrelated stored reading does not flood ingest related-item hints', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source: {
      ...source,
      title: 'Sourdough note',
      extractedText: 'Starter hydration and oven spring matter for bread.',
      contentHash: 'sha256:bread'
    },
    analyze: async () => ({
      ...analysis,
      summary: 'Starter hydration and oven spring matter for bread.',
      claims: ['Bread quality depends on starter hydration.'],
      relevance: { score: 0.2, themes: ['cooking'] },
      tags: [{ tag: 'cooking', reason: 'test', confidence: 0.6 }]
    })
  });
  const second = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source: { ...source, contentHash: 'sha256:agent-memory-2' },
    analyze: async () => analysis
  });

  assert.deepEqual(second.related_items, []);
});

test('duplicate while analysis is in progress returns retryable conflict', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let resolveAnalysis!: (value: Analysis) => void;
  const pending = new Promise<Analysis>((resolve) => { resolveAnalysis = resolve; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => pending
  });
  first.catch(() => undefined);

  await assert.rejects(
    () => store.ingest({
      principal: 'token:test',
      requestId: 'req-2',
      payloadHash: 'sha256:req2',
      source,
      analyze: async () => analysis
    }),
    /already being analyzed/
  );

  resolveAnalysis(analysis);
});

test('stale in-progress analysis can be retried for the same content hash', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let resolveAnalysis!: (value: Analysis) => void;
  const pending = new Promise<Analysis>((resolve) => { resolveAnalysis = resolve; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => pending
  });
  const row = db.prepare('SELECT id FROM items WHERE content_hash = ?').get(source.contentHash) as { id: string };
  db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), row.id);

  const retry = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source,
    analyze: async () => analysis
  });

  assert.equal(retry.item_id, row.id);
  assert.equal(retry.dedupe_status, 'created');
  resolveAnalysis(analysis);
  await first;
});

test('stale failed analysis cannot overwrite a successful retry', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let rejectAnalysis!: (error: Error) => void;
  const pending = new Promise<Analysis>((_, reject) => { rejectAnalysis = reject; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => pending
  });
  first.catch(() => undefined);

  const row = db.prepare('SELECT id FROM items WHERE content_hash = ?').get(source.contentHash) as { id: string };
  db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), row.id);

  const retry = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source,
    analyze: async () => analysis
  });

  rejectAnalysis(new Error('old attempt failed after retry succeeded'));
  await assert.rejects(() => first, /old attempt failed/);

  const status = db.prepare('SELECT status FROM items WHERE id = ?').get(retry.item_id) as { status: string };
  const failedLog = db.prepare("SELECT type FROM activity_log WHERE type = 'ingest.analysis_failed_stale'").get() as { type: string };
  assert.equal(status.status, 'indexed');
  assert.equal(failedLog.type, 'ingest.analysis_failed_stale');
});

test('stale successful analysis does not read a missing retry analysis', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  let resolveFirst!: (value: Analysis) => void;
  let resolveRetry!: (value: Analysis) => void;
  const firstPending = new Promise<Analysis>((resolve) => { resolveFirst = resolve; });
  const retryPending = new Promise<Analysis>((resolve) => { resolveRetry = resolve; });

  const first = store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source,
    analyze: async () => firstPending
  });
  first.catch(() => undefined);

  const row = db.prepare('SELECT id FROM items WHERE content_hash = ?').get(source.contentHash) as { id: string };
  db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), row.id);

  const retry = store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source,
    analyze: async () => retryPending
  });

  resolveFirst(analysis);
  const firstOutcome = await Promise.allSettled([first]).then(([outcome]) => outcome);
  resolveRetry(analysis);
  const retryResponse = await retry;

  assert.notEqual(firstOutcome?.status === 'rejected' ? firstOutcome.reason?.name : null, 'TypeError');
  assert.equal(retryResponse.item_id, row.id);
  assert.equal(retryResponse.status, 'indexed');
});

test('failed analysis can be retried for the same content hash', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);

  await assert.rejects(
    () => store.ingest({
      principal: 'token:test',
      requestId: 'req-1',
      payloadHash: 'sha256:req1',
      source,
      analyze: async () => { throw new Error('model unavailable'); }
    }),
    /model unavailable/
  );

  const retry = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source,
    analyze: async () => analysis
  });
  const row = db.prepare('SELECT status FROM items WHERE id = ?').get(retry.item_id) as { status: string };

  assert.equal(retry.dedupe_status, 'created');
  assert.equal(row.status, 'indexed');
});

test('analysis failure activity does not log raw error text', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);

  await assert.rejects(
    () => store.ingest({
      principal: 'token:test',
      requestId: 'req-1',
      payloadHash: 'sha256:req1',
      source,
      analyze: async () => { throw new TypeError('raw source leak: aaron@example.com durable recall'); }
    }),
    /raw source leak/
  );
  const row = db.prepare("SELECT metadata_json FROM activity_log WHERE type = 'ingest.analysis_failed'").get() as { metadata_json: string };

  assert.doesNotMatch(row.metadata_json, /aaron@example\.com/);
  assert.doesNotMatch(row.metadata_json, /durable recall/);
  assert.match(row.metadata_json, /TypeError/);
});

test('same source with changed content creates superseding item', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'token:test',
    requestId: 'req-1',
    payloadHash: 'sha256:req1',
    source: { ...source, sourceUri: 'https://example.com/a', canonicalUrl: 'https://example.com/a' },
    analyze: async () => analysis
  });
  const second = await store.ingest({
    principal: 'token:test',
    requestId: 'req-2',
    payloadHash: 'sha256:req2',
    source: {
      ...source,
      sourceUri: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      contentHash: 'sha256:changed',
      extractedText: 'Changed content about semantic analytics.'
    },
    analyze: async () => analysis
  });
  const row = db.prepare('SELECT supersedes_item_id FROM items WHERE id = ?').get(second.item_id) as { supersedes_item_id: string };

  assert.notEqual(first.item_id, second.item_id);
  assert.equal(second.dedupe_status, 'content_changed');
  assert.equal(row.supersedes_item_id, first.item_id);
});
