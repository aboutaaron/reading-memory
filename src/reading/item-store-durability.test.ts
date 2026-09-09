import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openMemoryDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import type { Analysis, ExtractedSource } from './types.js';

const source: ExtractedSource = {
  sourceType: 'url',
  sourceUri: 'https://example.com/reading-memory',
  canonicalUrl: 'https://example.com/reading-memory',
  finalUrl: 'https://example.com/reading-memory',
  title: 'Durable reading memory',
  extractedText: 'Reader judgment should remain distinguishable from model interpretation.',
  truncated: false,
  contentHash: 'sha256:durability-source',
  rawBytesHash: null,
  provenance: { ingest_reason: 'Compare this with my analytics project.' }
};

const analysis: Analysis = {
  summary: 'Reader judgment needs explicit provenance.',
  claims: ['Reader judgment should remain distinguishable from model interpretation.'],
  relevance: { score: 0.85, themes: ['agent-memory'] },
  recommended_action: 'brief',
  confidence: 0.8,
  reason: 'Addresses the reader’s unresolved question about evidence.\nPreserve this specific rationale verbatim.',
  tags: [{ tag: 'agent-memory', reason: 'Shared theme only', confidence: 0.7 }],
  relationships: [],
  model: 'durability-fixture',
  analysis_version: 'test'
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('completed replay and request conflict perform no extraction or analysis', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'test', requestId: 'replay', payloadHash: 'payload:first', source,
    analyze: async (itemId, extractedSource) => {
      assert.match(itemId, /^item_/);
      assert.equal(extractedSource, source);
      return analysis;
    }
  });
  let extractionCount = 0;
  let analysisCount = 0;
  const retry = {
    principal: 'test', requestId: 'replay', payloadHash: 'payload:first',
    extract: async () => { extractionCount++; throw new Error('Replay must not fetch'); },
    analyze: async () => { analysisCount++; throw new Error('Replay must not analyze'); }
  };
  const replay = await store.ingest(retry);
  assert.deepEqual(replay, { ...first, dedupe_status: 'idempotent_replay' });
  await assert.rejects(() => store.ingest({ ...retry, payloadHash: 'payload:different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(extractionCount, 0);
  assert.equal(analysisCount, 0);
});

test('concurrent same-payload retries share exactly one extraction and analysis', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const extraction = deferred<ExtractedSource>();
  const started = deferred<void>();
  let extractionCount = 0;
  let analysisCount = 0;
  const input = {
    principal: 'test', requestId: 'concurrent', payloadHash: 'payload:concurrent',
    extract: async () => {
      extractionCount++;
      started.resolve();
      return extraction.promise;
    },
    analyze: async (_itemId: string, extractedSource: ExtractedSource) => {
      analysisCount++;
      assert.equal(extractedSource, source);
      return analysis;
    }
  };
  const first = store.ingest(input);
  const second = store.ingest(input);
  const third = store.ingest(input);
  await started.promise;
  assert.equal(extractionCount, 1);
  extraction.resolve(source);
  const responses = await Promise.all([first, second, third]);
  assert.equal(extractionCount, 1);
  assert.equal(analysisCount, 1);
  assert.deepEqual(responses.map((response) => response.dedupe_status), ['created', 'idempotent_replay', 'idempotent_replay']);
  assert.equal(new Set(responses.map((response) => response.item_id)).size, 1);
});

test('a conflicting payload while extraction is pending cannot start another fetch', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const extraction = deferred<ExtractedSource>();
  const started = deferred<void>();
  const first = store.ingest({
    principal: 'test', requestId: 'inflight-conflict', payloadHash: 'payload:first',
    extract: async () => { started.resolve(); return extraction.promise; },
    analyze: async () => analysis
  });
  await started.promise;
  let conflictExtractions = 0;
  await assert.rejects(() => store.ingest({
    principal: 'test', requestId: 'inflight-conflict', payloadHash: 'payload:changed',
    extract: async () => { conflictExtractions++; return source; },
    analyze: async () => { throw new Error('Conflicting request must not analyze'); }
  }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(conflictExtractions, 0);
  extraction.resolve(source);
  assert.equal((await first).dedupe_status, 'created');
});

test('failed shared extraction leaves no persisted request and can be retried', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const extraction = deferred<ExtractedSource>();
  const started = deferred<void>();
  let extractionCount = 0;
  let analysisCount = 0;
  const input = {
    principal: 'test', requestId: 'failed-extract', payloadHash: 'payload:failed-extract',
    extract: async () => { extractionCount++; started.resolve(); return extraction.promise; },
    analyze: async () => { analysisCount++; return analysis; }
  };
  const failures = Promise.allSettled([store.ingest(input), store.ingest(input)]);
  await started.promise;
  extraction.reject(new Error('Temporary fetch failure'));
  const rejected = await failures;
  assert.equal(rejected.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(extractionCount, 1);
  assert.equal(analysisCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()?.count, 0);

  const retried = await store.ingest({
    ...input,
    extract: async () => { extractionCount++; return source; }
  });
  assert.equal(retried.dedupe_status, 'created');
  assert.equal(extractionCount, 2);
  assert.equal(analysisCount, 1);
});

test('specific analysis rationale survives content dedupe and database reopen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-rationale-'));
  const path = join(dir, 'reading.sqlite');
  let db = openDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'test', requestId: 'original', payloadHash: 'payload:original', source,
    analyze: async () => analysis
  });
  const duplicateInput = {
    principal: 'test', requestId: 'duplicate', payloadHash: 'payload:duplicate', source,
    analyze: async () => { throw new Error('Duplicate content must not be analyzed'); }
  };
  const duplicate = await store.ingest(duplicateInput);
  assert.equal(duplicate.dedupe_status, 'existing');
  assert.equal(duplicate.reason, analysis.reason);
  assert.equal(db.prepare('SELECT reason FROM analyses WHERE item_id = ?').get(first.item_id)?.reason, analysis.reason);

  db.close();
  db = openDatabase(path);
  store = new ItemStore(db);
  const reopened = await store.ingest({ ...duplicateInput, requestId: 'after-reopen', payloadHash: 'payload:reopened' });
  assert.equal(reopened.item_id, first.item_id);
  assert.equal(reopened.reason, analysis.reason);
  assert.notEqual(reopened.reason, 'Matched themes: agent-memory');
  let refetchCount = 0;
  const replay = await store.ingest({
    principal: 'test', requestId: 'original', payloadHash: 'payload:original',
    extract: async () => { refetchCount++; throw new Error('Reopened replay must not fetch'); },
    analyze: async () => analysis
  });
  assert.equal(replay.reason, analysis.reason);
  assert.equal(refetchCount, 0);
});

test('legacy missing rationale is identified honestly instead of rebuilt from tags', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const first = await store.ingest({
    principal: 'test', requestId: 'legacy-first', payloadHash: 'payload:legacy-first', source,
    analyze: async () => analysis
  });
  db.prepare('UPDATE analyses SET reason = NULL WHERE item_id = ?').run(first.item_id);
  const duplicate = await store.ingest({
    principal: 'test', requestId: 'legacy-duplicate', payloadHash: 'payload:legacy-duplicate', source,
    analyze: async () => { throw new Error('Legacy duplicate must not be reanalyzed'); }
  });
  assert.match(duplicate.reason, /Original analysis rationale was not recorded/);
});

test('relationship evidence and origin survive content dedupe and database reopen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-evidence-'));
  const path = join(dir, 'reading.sqlite');
  let db = openDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let store = new ItemStore(db);
  const target = await store.ingest({
    principal: 'test', requestId: 'target', payloadHash: 'payload:target', source,
    analyze: async () => analysis
  });
  const linkedSource: ExtractedSource = {
    ...source,
    sourceUri: null,
    canonicalUrl: null,
    finalUrl: null,
    title: 'Evidence and interpretation',
    extractedText: 'Reader statements and model interpretations need separate provenance.',
    contentHash: 'sha256:linked-source'
  };
  const evidence = {
    source_quote: linkedSource.extractedText,
    target_quote: source.extractedText
  };
  const linked = await store.ingest({
    principal: 'test', requestId: 'linked', payloadHash: 'payload:linked', source: linkedSource,
    analyze: async (itemId) => ({
      ...analysis,
      relationships: [{
        from_item_id: itemId, to_item_id: target.item_id,
        relation_type: 'extends', explanation: 'Both sources distinguish reader judgment from generated interpretation.',
        confidence: 0.8, origin: 'model', evidence
      }]
    })
  });
  assert.deepEqual(linked.connections[0]?.evidence, evidence);
  const row = db.prepare('SELECT origin, evidence_json FROM relationships WHERE from_item_id = ?').get(linked.item_id);
  assert.equal(row?.origin, 'model');
  assert.deepEqual(JSON.parse(String(row?.evidence_json)), evidence);
  const duplicateInput = {
    principal: 'test', requestId: 'linked-duplicate', payloadHash: 'payload:linked-duplicate', source: linkedSource,
    analyze: async () => { throw new Error('Duplicate must use persisted relationship'); }
  };
  const duplicate = await store.ingest(duplicateInput);
  assert.deepEqual(duplicate.connections, linked.connections);
  assert.equal('evidence_json' in (duplicate.connections[0] ?? {}), false);

  db.close();
  db = openDatabase(path);
  store = new ItemStore(db);
  const reopened = await store.ingest({ ...duplicateInput, requestId: 'linked-reopened', payloadHash: 'payload:linked-reopened' });
  assert.deepEqual(reopened.connections, linked.connections);
});

test('persisted legacy relationships without evidence remain marked as heuristic', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const target = await store.ingest({
    principal: 'test', requestId: 'heuristic-target', payloadHash: 'payload:heuristic-target', source,
    analyze: async () => analysis
  });
  const linkedSource = { ...source, contentHash: 'sha256:heuristic-source' };
  await store.ingest({
    principal: 'test', requestId: 'heuristic-linked', payloadHash: 'payload:heuristic-linked', source: linkedSource,
    analyze: async (itemId) => ({
      ...analysis,
      relationships: [{
        from_item_id: itemId, to_item_id: target.item_id,
        relation_type: 'same_theme', explanation: 'Shared tags are a discovery hint.', confidence: 0.6
      }]
    })
  });
  const duplicate = await store.ingest({
    principal: 'test', requestId: 'heuristic-duplicate', payloadHash: 'payload:heuristic-duplicate', source: linkedSource,
    analyze: async () => { throw new Error('Duplicate must use stored heuristic'); }
  });
  assert.equal(duplicate.connections[0]?.origin, 'heuristic');
  assert.equal(duplicate.connections[0]?.evidence, undefined);
});
