import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { resolveModel } from '@flue/runtime/internal';
import { openMemoryDatabase } from '../db/connection.js';
import { createFlueReadingAnalyzer, flueAnalyzerHealth, normalizeAnalysis, wrapResolveModelWithBaseUrlOverrides } from './flue-agent.js';
import type { PriorReadingItem } from './reading-context.js';

test('flueAnalyzerHealth reports the packaged analyze-item skill as ready', () => {
  assert.deepEqual(flueAnalyzerHealth(), { status: 'ok', warn: false });
});

test('wrapResolveModelWithBaseUrlOverrides passes through when no env override is set', () => {
  const original = { id: 'claude-sonnet-4-5', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  const wrapped = wrapResolveModelWithBaseUrlOverrides(() => original as never);
  delete process.env.ANTHROPIC_BASE_URL;
  const result = wrapped('anthropic/claude-sonnet-4-5') as { baseUrl: string };
  assert.equal(result.baseUrl, 'https://api.anthropic.com');
});

test('wrapResolveModelWithBaseUrlOverrides applies <PROVIDER>_BASE_URL env override', () => {
  const original = { id: 'claude-sonnet-4-5', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  const wrapped = wrapResolveModelWithBaseUrlOverrides(() => original as never);
  process.env.ANTHROPIC_BASE_URL = 'http://proxy.test:9123';
  try {
    const result = wrapped('anthropic/claude-sonnet-4-5') as { baseUrl: string; provider: string };
    assert.equal(result.baseUrl, 'http://proxy.test:9123');
    assert.equal(result.provider, 'anthropic');
    // Original object is unchanged (functional override).
    assert.equal(original.baseUrl, 'https://api.anthropic.com');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

test('wrapResolveModelWithBaseUrlOverrides only overrides the matching provider', () => {
  const openai = { id: 'gpt-test', provider: 'openai', baseUrl: 'https://api.openai.com' };
  const wrapped = wrapResolveModelWithBaseUrlOverrides(() => openai as never);
  process.env.ANTHROPIC_BASE_URL = 'http://anthropic-proxy.test:9123';
  try {
    const result = wrapped('openai/gpt-test') as { baseUrl: string };
    assert.equal(result.baseUrl, 'https://api.openai.com');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

test('wrapResolveModelWithBaseUrlOverrides translates hyphenated provider names to env keys', () => {
  const cf = { id: 'sonnet-via-cf', provider: 'cloudflare-ai-gateway', baseUrl: 'https://gateway.ai.cloudflare.com/...' };
  const wrapped = wrapResolveModelWithBaseUrlOverrides(() => cf as never);
  process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL = 'http://cf-proxy.test:9123';
  try {
    const result = wrapped('cloudflare-ai-gateway/sonnet-via-cf') as { baseUrl: string };
    assert.equal(result.baseUrl, 'http://cf-proxy.test:9123');
  } finally {
    delete process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL;
  }
});

test('production resolver resolves the OpenAI Luna default through the standard Responses API', () => {
  const wrapped = wrapResolveModelWithBaseUrlOverrides(resolveModel);
  const result = wrapped('openai/gpt-5.6-luna') as {
    id: string;
    provider: string;
    api: string;
    baseUrl: string;
  };

  assert.equal(result.id, 'gpt-5.6-luna');
  assert.equal(result.provider, 'openai');
  assert.equal(result.api, 'openai-responses');
  assert.equal(result.baseUrl, 'https://api.openai.com/v1');
});

test('production resolver remains provider-agnostic for another registered provider', () => {
  const wrapped = wrapResolveModelWithBaseUrlOverrides(resolveModel);
  const result = wrapped('anthropic/claude-sonnet-4-5') as {
    id: string;
    provider: string;
    api: string;
  };

  assert.equal(result.id, 'claude-sonnet-4-5');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.api, 'anthropic-messages');
});

test('Flue analyzer loads the packaged analyze-item skill without persisting opaque session state', async () => {
  const db = openMemoryDatabase();
  const faux = registerFauxProvider();
  const flueResult = {
    summary: 'Durable reading memory lets local agents recall important material.',
    claims: ['Local agents need durable reading memory.'],
    relevance: { score: 0.86, themes: ['agent-memory'] },
    recommended_action: 'brief',
    confidence: 0.82,
      reason: 'Directly relevant to durable agent memory.',
      tags: [{ tag: 'agent-memory', reason: 'Core topic', confidence: 0.84 }],
      relationships: [{
        from_item_id: 'item_test',
        to_item_id: 'item_hallucinated',
        relation_type: 'same_theme',
        explanation: 'Fake relationship from model output',
        confidence: 0.8
      }]
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('finish', flueResult), { stopReason: 'toolUse' })
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      resolveModel: () => faux.getModel()
    });
    const result = await analyze({
      itemId: 'item_test',
      title: 'Durable memory',
      text: 'Local agents need durable reading memory and reliable citations.'
    });

    assert.equal(result.analysis_version, 'reading-api-flue-v2');
    assert.equal(result.model, 'faux/faux-1');
    assert.equal(result.recommended_action, 'brief');
    assert.deepEqual(result.relevance.themes, ['agent-memory']);
    assert.deepEqual(result.relationships, []);
    assert.equal(faux.state.callCount, 1);

    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(), undefined);
  } finally {
    faux.unregister();
  }
});

test('Flue analyzer writes redacted local traces', async () => {
  const db = openMemoryDatabase();
  const tmp = await mkdtemp(join(tmpdir(), 'reading-api-traces-'));
  const tracePath = join(tmp, 'flue-events.jsonl');
  const faux = registerFauxProvider();
  const flueResult = {
    summary: 'Trace logging records useful output without raw source text.',
    claims: ['Trace logs are useful.'],
    relevance: { score: 0.75, themes: ['observability'] },
    recommended_action: 'save',
    confidence: 0.8,
    reason: 'Useful for inspecting Flue behavior.',
    tags: [{ tag: 'observability', reason: 'Core topic', confidence: 0.88 }],
    relationships: []
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('finish', flueResult), { stopReason: 'toolUse' })
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      tracePath,
      resolveModel: () => faux.getModel()
    });
    await analyze({
      itemId: 'item_trace',
      title: 'Trace me',
      text: 'PRIVATE SOURCE TEXT SHOULD NOT APPEAR IN TRACE EVENTS.',
      sessionId: 'analysis:item_trace:trace-request'
    });

    const lines = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].event, 'analysis_start');
    assert.equal(lines[0].title_chars, 8);
    assert.match(lines[0].title_sha256, /^sha256:/);
    assert.equal(lines[0].text_chars, 54);
    assert.match(lines[0].text_sha256, /^sha256:/);
    assert.equal(lines.at(-1).event, 'analysis_success');
    assert.equal(lines.at(-1).recommended_action, 'save');
    assert(!JSON.stringify(lines).includes('Trace me'));
    assert(!JSON.stringify(lines).includes('PRIVATE SOURCE TEXT'));
  } finally {
    faux.unregister();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Flue trace write failures do not fail analysis', async () => {
  const db = openMemoryDatabase();
  const tmp = await mkdtemp(join(tmpdir(), 'reading-api-bad-traces-'));
  const blocker = join(tmp, 'not-a-directory');
  await writeFile(blocker, 'blocker');
  const faux = registerFauxProvider();
  const flueResult = {
    summary: 'Analysis succeeds even when trace writing fails.',
    claims: ['Tracing must be best-effort.'],
    relevance: { score: 0.7, themes: ['reliability'] },
    recommended_action: 'save',
    confidence: 0.83,
    reason: 'Observability should not break ingest.',
    tags: [{ tag: 'reliability', reason: 'Core topic', confidence: 0.9 }],
    relationships: []
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('finish', flueResult), { stopReason: 'toolUse' })
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      tracePath: join(blocker, 'flue-events.jsonl'),
      resolveModel: () => faux.getModel()
    });
    const result = await analyze({
      itemId: 'item_bad_trace',
      title: 'Bad trace path',
      text: 'Analysis should still complete.'
    });

    assert.equal(result.recommended_action, 'save');
    assert.equal(result.analysis_version, 'reading-api-flue-v2');
  } finally {
    faux.unregister();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Flue trace analysis errors do not persist raw model output', async () => {
  const db = openMemoryDatabase();
  const tmp = await mkdtemp(join(tmpdir(), 'reading-api-error-traces-'));
  const tracePath = join(tmp, 'flue-events.jsonl');
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('finish', { summary: 'PRIVATE MODEL ECHO SHOULD NOT BE LOGGED' }), { stopReason: 'toolUse' })
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      tracePath,
      resolveModel: () => faux.getModel()
    });
    await assert.rejects(
      () => analyze({
        itemId: 'item_error_trace',
        title: 'Error trace',
        text: 'PRIVATE SOURCE TEXT SHOULD ALSO NOT BE LOGGED.'
      }),
      /Flue reading analysis failed/
    );

    const trace = await readFile(tracePath, 'utf8');
    assert(!trace.includes('PRIVATE MODEL ECHO'));
    assert(!trace.includes('PRIVATE SOURCE TEXT'));
    assert(!trace.includes('Error trace'));
    assert.match(trace, /"event":"analysis_error"/);
    assert.match(trace, /"error_message_sha256":"sha256:/);
  } finally {
    faux.unregister();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Flue analyzer rejects promptly when the abort signal is already aborted', async () => {
  const db = openMemoryDatabase();
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('finish', { summary: 'should never be reached' }), { stopReason: 'toolUse' })
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      resolveModel: () => faux.getModel()
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => analyze({
        itemId: 'item_aborted',
        title: 'Aborted before start',
        text: 'This analysis should be cancelled before the model is called.',
        signal: controller.signal
      }),
      /Flue reading analysis failed/
    );
    assert.equal(faux.state.callCount, 0);
  } finally {
    faux.unregister();
  }
});

test('Flue analyzer propagates an abort after the provider request starts', async () => {
  const db = openMemoryDatabase();
  const faux = registerFauxProvider();
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  faux.setResponses([
    async (_context, options) => {
      providerStarted();
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('Expected an AbortSignal at the provider boundary.'));
          return;
        }
        const abort = () => reject(signal.reason ?? new Error('Request was aborted'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      throw new Error('Provider request unexpectedly continued after abort.');
    }
  ]);

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'faux/faux-1',
      resolveModel: () => faux.getModel()
    });
    const controller = new AbortController();
    const analysis = analyze({
      itemId: 'item_aborted_in_flight',
      title: 'Abort in flight',
      text: 'This analysis should be cancelled after the provider call begins.',
      signal: controller.signal
    });

    await started;
    controller.abort(new Error('request deadline exceeded'));

    await assert.rejects(analysis, /Flue reading analysis failed/);
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

const evidenceResult: Parameters<typeof normalizeAnalysis>[2] = {
  summary: 'Version checks make cache reuse safer.',
  claims: ['Cache reuse requires version checks.'],
  relevance: { score: 0.85, themes: ['cache'] },
  recommended_action: 'brief',
  confidence: 0.9,
  reason: 'Addresses the reader\'s cache invalidation question.',
  tags: [{ tag: 'cache', reason: 'Core topic', confidence: 0.9 }],
  relationships: [{
    from_item_id: 'current', to_item_id: 'prior', relation_type: 'supports',
    explanation: 'Both sources require a version check.', confidence: 0.88,
    evidence: { source_quote: 'Check the cache version before reuse.', target_quote: 'Cache reuse requires checking the version.' }
  }]
};

const evidencePrior: PriorReadingItem = {
  item_id: 'prior', title: 'Cache reuse', summary: 'A model summary is not source evidence.', tags: ['cache'],
  source_passages: ['Cache reuse requires checking the version.'], annotations: []
};

test('model relationships retain exact evidence, deduplicate, and do not mix in theme fallback', () => {
  const db = openMemoryDatabase();
  db.prepare(`INSERT INTO items (id, source_type, ingested_at, content_hash, status, extracted_text)
    VALUES ('other', 'text', '2026-09-01', 'other', 'indexed', 'cache')`).run();
  db.prepare("INSERT INTO tags (item_id, tag, reason, confidence) VALUES ('other', 'cache', 'test', 0.9)").run();
  const result = normalizeAnalysis(db, 'current', {
    ...evidenceResult, relationships: [...evidenceResult.relationships, ...evidenceResult.relationships]
  }, 'test', { text: 'Check the cache version before reuse.', priorItems: [evidencePrior] });
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0]!.origin, 'model');
  assert.deepEqual(result.relationships[0]!.evidence, evidenceResult.relationships[0]!.evidence);
});

test('model relationships reject unsupplied IDs, invalid types, wrong directions, and unsupported quotes', () => {
  const db = openMemoryDatabase();
  db.prepare(`INSERT INTO items (id, source_type, ingested_at, content_hash, status, extracted_text)
    VALUES ('not_supplied', 'text', '2026-09-01', 'not_supplied', 'indexed', 'Cache reuse requires checking the version.')`).run();
  const base = evidenceResult.relationships[0]!;
  const invalid = [
    { ...base, to_item_id: 'not_supplied' },
    { ...base, from_item_id: 'other' },
    { ...base, to_item_id: 'current' },
    { ...base, relation_type: 'mysteriously_related' },
    { ...base, relation_type: 'same_theme' },
    { ...base, evidence: { source_quote: 'Fabricated quote.', target_quote: base.evidence!.target_quote } },
    { ...base, evidence: { source_quote: base.evidence!.source_quote, target_quote: evidencePrior.summary } },
    { ...base, evidence: { source_quote: base.evidence!.source_quote, target_quote: 'Text omitted from the supplied excerpts.' } },
    { ...base, evidence: { source_quote: ' ', target_quote: base.evidence!.target_quote } },
    { ...base, evidence: undefined }
  ];
  for (const relationship of invalid) {
    const result = normalizeAnalysis(db, 'current', { ...evidenceResult, relationships: [relationship] }, 'test', {
      text: 'Check the cache version before reuse.', priorItems: [evidencePrior]
    });
    assert.deepEqual(result.relationships, [], JSON.stringify(relationship));
  }
});

test('invalid model relationships fall back to clearly labeled theme matches at 0.5 confidence', () => {
  const db = openMemoryDatabase();
  for (const [id, status] of [['prior', 'indexed'], ['failed', 'failed']]) {
    db.prepare(`INSERT INTO items (id, source_type, ingested_at, content_hash, status, extracted_text)
      VALUES (?, 'text', '2026-09-01', ?, ?, 'cache')`).run(id!, id!, status!);
    db.prepare("INSERT INTO tags (item_id, tag, reason, confidence) VALUES (?, 'cache', 'test', 0.9)").run(id!);
  }
  const result = normalizeAnalysis(db, 'current', {
    ...evidenceResult, relationships: [{ ...evidenceResult.relationships[0]!, to_item_id: 'invented' }]
  }, 'test', { text: 'Check the cache version before reuse.', priorItems: [evidencePrior] });
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0]!.relation_type, 'same_theme');
  assert.equal(result.relationships[0]!.origin, 'heuristic');
  assert.equal(result.relationships[0]!.confidence, 0.5);
  assert.equal(result.relationships[0]!.evidence, undefined);
});

test('Flue receives prior source passages and attributed reader context before model judgment', async () => {
  const db = openMemoryDatabase();
  db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES ('prior', 'text', 'Cache reuse', '2026-09-01', 'prior', 'indexed', ?)`).run(evidencePrior.source_passages[0]!);
  db.prepare('INSERT INTO item_fts (item_id, title, body, summary, tags) VALUES (?, ?, ?, ?, ?)')
    .run('prior', 'Cache reuse', evidencePrior.source_passages[0]!, evidencePrior.summary, 'cache');
  db.prepare(`INSERT INTO reader_annotations (id, item_id, actor_type, actor, note, project, question, created_at)
    VALUES ('note', 'prior', 'user', 'Aaron', 'I am uncertain about staleness guarantees.', 'Analytics harness', 'When is reuse safe?', '2026-09-01')`).run();
  const faux = registerFauxProvider();
  let providerInput = '';
  faux.setResponses([async (context) => {
    providerInput = JSON.stringify(context);
    return fauxAssistantMessage(fauxToolCall('finish', evidenceResult), { stopReason: 'toolUse' });
  }]);
  try {
    const analyze = createFlueReadingAnalyzer(db, { model: 'faux/faux-1', resolveModel: () => faux.getModel() });
    const result = await analyze({
      itemId: 'current', title: 'Cache versions', text: 'Check the cache version before reuse.',
      readerContext: { source_context: 'user_shared_link', ingest_reason: 'Investigating cache invalidation.' }
    });
    assert.match(providerInput, /Investigating cache invalidation/);
    assert.match(providerInput, /Cache reuse requires checking the version/);
    assert.match(providerInput, /I am uncertain about staleness guarantees/);
    assert.match(providerInput, /actor_type/);
    assert.match(providerInput, /Analytics harness/);
    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0]!.origin, 'model');
    assert.equal(result.relationships[0]!.to_item_id, 'prior');
  } finally {
    faux.unregister();
  }
});
