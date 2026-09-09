import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadingApi } from './server.js';
import { LIMITS } from '../config.js';
import type { ReadingAnalyzerInput } from '../reading/flue-agent.js';
import { openMemoryDatabase } from '../db/connection.js';
import { createEmbeddingProvider } from '../reading/embedding-provider.js';
import { type Embedder } from '../reading/embeddings.js';
import { ItemStore } from '../reading/item-store.js';

const vector = () => [1, ...Array<number>(1535).fill(0)];
const analysis = { summary: 'Cache invalidation requires explicit dependencies.', claims: ['Cache dependencies matter.'],
  relevance: { score: 0.9, themes: ['caching'] }, recommended_action: 'save' as const, confidence: 0.8,
  reason: 'Tracks refresh dependencies.', tags: [], relationships: [], model: 'test', analysis_version: 'test' };

async function fixture(t: import('node:test').TestContext, embedder: Embedder | null) {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'hybrid-api-'));
  const priorIds: string[][] = [];
  const analysisInputs: ReadingAnalyzerInput[] = [];
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token', dataDir,
    backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db, {
      embedder, analyzer: async input => { priorIds.push(input.priorItemIds ?? []); analysisInputs.push(input); return analysis; }
    });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, body?: unknown, token = 'test-token') => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() as any };
  };
  return { db, request, priorIds, analysisInputs };
}

test('HTTP hybrid mode remains opt-in, supplies semantic neighbors, and preserves replay without embedding calls', async t => {
  let calls = 0;
  const { request, priorIds } = await fixture(t, { model: 'openai/test', async embed() { calls++; return vector(); } });
  const body = { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache invalidation requires explicit dependencies.' } };
  const first = await request('/ingest', body);
  assert.equal(first.status, 200);
  const firstId = first.json.data.item_id;
  const beforeReplay = calls;
  assert.equal((await request('/ingest', body)).json.data.dedupe_status, 'idempotent_replay');
  assert.equal(calls, beforeReplay);
  const second = await request('/ingest', { ...body, request_id: randomUUID(), source: { text: 'Ownership determines refresh policy.' } });
  assert.equal(second.status, 200);
  assert.deepEqual(priorIds, [[], [firstId]]);
  assert.ok(second.json.data.related_items.some((item: any) => item.item_id === firstId && item.match_reason.includes('semantic')));
  const query = { request_id: randomUUID(), query: 'outdated replicas purge', top_k: 2 };
  const lexical = await request('/query', query);
  assert.equal(lexical.json.data.retrieval_mode, 'fts');
  assert.deepEqual(lexical.json.data.results, []);
  const hybrid = await request('/query', { ...query, mode: 'hybrid' });
  assert.equal(hybrid.status, 200);
  assert.equal(hybrid.json.data.retrieval_mode, 'hybrid');
  assert.ok(hybrid.json.data.citations.includes(firstId));
  assert.equal(hybrid.json.data.confidence, null);
  assert.equal((await request('/query', { ...query, mode: 'hybrid' }, 'wrong')).status, 401);
  assert.ok((await request('/capabilities')).json.data.query_modes.includes('hybrid'));
  assert.equal((await request('/health')).json.data.embeddings.missing_items, 0);
  assert.doesNotMatch(JSON.stringify(hybrid.json), /inputHash|"embedding"|"vector"/);
});

test('embedding failures preserve successful ingestion and report a safe lexical fallback', async t => {
  const { request } = await fixture(t, { model: 'openai/test', async embed() { throw new Error('private-provider-token'); } });
  const ingest = await request('/ingest', { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache invalidation dependencies.' } });
  assert.equal(ingest.status, 200);
  const health = await request('/health');
  assert.equal(health.json.data.embeddings.missing_items, 1);
  const query = await request('/query', { request_id: randomUUID(), query: 'cache', mode: 'hybrid' });
  assert.equal(query.json.data.retrieval_mode, 'fts');
  assert.equal(query.json.data.fallback_reason, 'no_compatible_embeddings');
  assert.deepEqual(query.json.data.citations, [ingest.json.data.item_id]);
  assert.doesNotMatch(JSON.stringify([ingest, health, query, await request('/activity')]), /private-provider-token/);
});

test('HTTP lexical policy controls partial matches in FTS, usage mode and hybrid fallback', async t => {
  const { request } = await fixture(t, null);
  const ingest = await request('/ingest', { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache invalidation dependencies.' } });
  assert.equal(ingest.status, 200);
  for (const mode of ['fts', 'fts+usage', 'hybrid']) {
    const query = { request_id: randomUUID(), query: 'cache lunar orchard', mode };
    const compatible = await request('/query', query);
    assert.equal(compatible.status, 200);
    assert.equal(compatible.json.data.lexical_policy, 'any');
    assert.equal(compatible.json.data.results[0].weak_match, true);
    assert.equal(compatible.json.data.results[0].lexical_coverage, 1 / 3);
    const strict = await request('/query', { ...query, request_id: randomUUID(), lexical_policy: 'all' });
    assert.equal(strict.status, 200);
    assert.equal(strict.json.data.lexical_policy, 'all');
    assert.deepEqual(strict.json.data.results, []);
    if (mode === 'hybrid') assert.equal(strict.json.data.fallback_reason, 'embeddings_unavailable');
    const positive = await request('/query', { ...query, request_id: randomUUID(), query: 'cache dependencies', lexical_policy: 'all' });
    assert.deepEqual(positive.json.data.citations, [ingest.json.data.item_id]);
    assert.equal(positive.json.data.results[0].weak_match, false);
  }
  const invalid = await request('/query', { request_id: randomUUID(), query: 'cache', lexical_policy: 'confidence' });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await request('/capabilities')).json.data.lexical_policies, ['any', 'all']);
});

test('HTTP graph mode returns quoted relationship context and preserves strict lexical fallback', async t => {
  const { db, request } = await fixture(t, null);
  const source = 'Quartz clocks drift during winter.';
  const target = 'Temperature compensation corrects oscillator error.';
  const capture = async (text: string) => (await request('/ingest', {
    request_id: randomUUID(), source_type: 'text', source: { text }
  })).json.data.item_id as string;
  const seedId = await capture(source);
  const peerId = await capture(target);
  db.prepare(`INSERT INTO relationships (id, from_item_id, to_item_id, relation_type,
    explanation, confidence, created_at, origin, evidence_json)
    VALUES ('graph-api-edge', ?, ?, 'extends', 'Proposes a compensation mechanism.', 0.8, ?, 'model', ?)`)
    .run(seedId, peerId, new Date().toISOString(), JSON.stringify({ source_quote: source, target_quote: target }));
  const query = { request_id: randomUUID(), query: 'quartz', mode: 'hybrid+graph', lexical_policy: 'all', top_k: 5 };
  const result = await request('/query', query);
  assert.equal(result.status, 200);
  assert.equal(result.json.data.requested_mode, 'hybrid+graph');
  assert.equal(result.json.data.retrieval_mode, 'fts+graph');
  assert.equal(result.json.data.base_retrieval_mode, 'fts');
  assert.equal(result.json.data.fallback_reason, 'embeddings_unavailable');
  assert.deepEqual(result.json.data.citations, [seedId, peerId]);
  const peer = result.json.data.results[1];
  assert.equal(peer.retrieval_origin, 'graph');
  assert.equal(peer.graph.origin, 'model');
  assert.equal(peer.graph.seed_item_id, seedId);
  assert.equal(peer.graph.relationship_verification, 'unverified');
  assert.deepEqual(peer.graph.evidence, { source_quote: source, target_quote: target });
  const weak = await request('/query', { ...query, request_id: randomUUID(), query: 'quartz lunar' });
  assert.deepEqual(weak.json.data.results, []);
  assert.equal((await request('/capabilities')).json.data.graph_retrieval.hops, 1);
  assert.equal((await request('/query', { ...query, mode: 'fts+graph' })).status, 400, 'actual fallback mode is not a request mode');
});

test('embedding SDK uses the shared provider configuration and concrete model with fixed dimensions', async t => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: vector() }], model: 'test', usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const embedder = createEmbeddingProvider('openai/text-embedding-3-small', {
    OPENAI_API_KEY: 'fixture-secret', OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  });
  assert.ok(embedder);
  assert.equal((await embedder.embed('bounded source summary')).length, 1536);
  assert.deepEqual(seen, [{ url: '/v1/embeddings', authorization: 'Bearer fixture-secret', body: {
    model: 'text-embedding-3-small', input: 'bounded source summary', dimensions: 1536, encoding_format: 'float'
  } }]);
  assert.equal(createEmbeddingProvider('off'), null);
  assert.equal(createEmbeddingProvider('openai/text-embedding-3-small', {}), null);
  assert.equal(createEmbeddingProvider('anthropic/unsupported', { ANTHROPIC_API_KEY: 'fixture-secret' }), null);
});


test('ingest and reanalysis share absolute embedding deadlines and failed refresh embedding clears old vectors', async t => {
  let fail = false;
  const { db, request, analysisInputs } = await fixture(t, { model: 'openai/test', async embed() {
    if (fail) throw new Error('embedding transport failed');
    return vector();
  } });
  const started = Date.now();
  const ingest = await request('/ingest', { request_id: randomUUID(), source_type: 'text',
    source: { text: 'Cache invalidation depends on ownership.' } });
  assert.equal(ingest.status, 200);
  const itemId = ingest.json.data.item_id;
  assert.ok(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(itemId));
  assert.ok(db.prepare('SELECT 1 FROM item_vec WHERE item_id = ?').get(itemId));

  fail = true;
  const refreshed = await request(`/items/${itemId}/reanalyze`, { request_id: randomUUID() });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.data.dedupe_status, 'reanalyzed');
  assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(itemId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM item_vec WHERE item_id = ?').get(itemId), undefined);
  assert.equal(analysisInputs.length, 2);
  for (const input of analysisInputs) {
    assert.ok(input.deadline !== undefined);
    assert.ok(input.deadline >= started + LIMITS.maxSyncResponseSeconds * 1000);
    assert.ok(input.deadline <= Date.now() + LIMITS.maxSyncResponseSeconds * 1000);
    assert.equal(input.signal?.aborted, false);
  }
});

test('hybrid availability preserves explicit fts+usage mode without embedding query work', async t => {
  let calls = 0;
  const { request } = await fixture(t, { model: 'openai/test', async embed() { calls++; return vector(); } });
  const ingest = await request('/ingest', { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache dependencies.' } });
  assert.equal(ingest.status, 200);
  const before = calls;
  const result = await request('/query', { request_id: randomUUID(), query: 'cache', mode: 'fts+usage' });
  assert.equal(result.status, 200);
  assert.equal(result.json.data.retrieval_mode, 'fts+usage');
  assert.deepEqual(result.json.data.citations, [ingest.json.data.item_id]);
  assert.equal(calls, before);
  assert.deepEqual((await request('/capabilities')).json.data.query_modes, ['fts', 'fts+usage', 'hybrid', 'hybrid+graph']);
});


test('hybrid responses exclude reading forgotten while the embedding provider is pending', async t => {
  for (const outcome of ['success', 'failure'] as const) {
    await t.test(outcome, async t => {
      let hold = false;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      const { db, request } = await fixture(t, { model: 'openai/test', async embed() {
        if (hold) {
          started();
          await resumed;
          if (outcome === 'failure') throw new Error('Provider failed after forgetting.');
        }
        return vector();
      } });
      const captured = await request('/ingest', { request_id: randomUUID(), source_type: 'text',
        source: { title: 'Private retained title', text: 'Cache dependencies contain a unique forgotten passage.' } });
      assert.equal(captured.status, 200);
      const itemId = captured.json.data.item_id;
      hold = true;
      const pending = request('/query', { request_id: randomUUID(), query: 'cache', mode: 'hybrid' });
      await entered;
      new ItemStore(db).forget({ principal: 'local', itemId });
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.data.results, []);
      assert.deepEqual(response.json.data.citations, []);
      assert.equal(response.json.data.confidence, 0);
      assert.equal(response.json.data.retrieval_mode, outcome === 'success' ? 'hybrid' : 'fts');
      assert.equal(response.json.data.fallback_reason, outcome === 'success' ? null : 'embedding_query_failed');
      const serialized = JSON.stringify(response.json);
      for (const forgotten of [itemId, 'Private retained title', 'unique forgotten passage', analysis.summary]) {
        assert.equal(serialized.includes(forgotten), false, `must not return forgotten content: ${forgotten}`);
      }
    });
  }
});
