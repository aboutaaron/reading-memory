import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemoryDatabase } from '../db/connection.js';
import { createFlueReadingAnalyzer, flueAnalyzerHealth, normalizeAnalysis, READING_ANALYSIS_VERSION } from './flue-agent.js';
import { DEFAULT_READING_MODEL, resolveProviderModel } from './provider-model.js';
import type { PriorReadingItem } from './reading-context.js';

const testEnv = { OPENAI_API_KEY: 'test-openai-key', ANTHROPIC_API_KEY: 'test-anthropic-key' };
const validResult = {
  summary: 'Durable reading memory lets local agents recall important material.',
  claims: ['Local agents need durable reading memory.'],
  relevance: { score: 0.86, themes: ['agent-memory'] }, recommended_action: 'brief', confidence: 0.82,
  reason: 'Directly relevant to durable agent memory.', tags: [{ tag: 'agent-memory', reason: 'Core topic', confidence: 0.84 }],
  relationships: []
};
const input = { itemId: 'item_test', title: 'Durable memory', text: 'Local agents need durable reading memory and reliable citations.' };

function openaiResponse(value: unknown, overrides: Record<string, unknown> = {}) {
  return Response.json({ id: 'response-test', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.6-luna',
    output: [{ id: 'message-test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 }, ...overrides });
}

test('analysis health fails closed on missing key, unsupported provider, malformed ID, or invalid base URL', () => {
  assert.deepEqual(flueAnalyzerHealth(DEFAULT_READING_MODEL, testEnv), { status: 'ok', warn: false });
  for (const [model, env] of [
    [DEFAULT_READING_MODEL, {}], ['unknown/test', testEnv], ['openai/', testEnv], ['gpt 5', testEnv],
    [DEFAULT_READING_MODEL, { ...testEnv, OPENAI_BASE_URL: 'file:///tmp' }],
    [DEFAULT_READING_MODEL, { ...testEnv, OPENAI_BASE_URL: 'https://user:secret@provider.test' }]
  ] as const) assert.deepEqual(flueAnalyzerHealth(model, env), { status: 'unavailable', warn: true });
});

test('concrete default and legacy prefix resolve without a framework alias table', () => {
  const bare = resolveProviderModel(DEFAULT_READING_MODEL, testEnv);
  assert.deepEqual(bare, resolveProviderModel(`openai/${DEFAULT_READING_MODEL}`, testEnv));
  assert.equal(bare.id, 'gpt-5.6-luna');
  assert.equal(bare.baseUrl, 'https://api.openai.com/v1');
});

test('provider-specific base URL overrides preserve the matching credentials', () => {
  const env = { ...testEnv, OPENAI_BASE_URL: 'http://openai.test/v1', ANTHROPIC_BASE_URL: 'http://anthropic.test' };
  assert.deepEqual(resolveProviderModel('anthropic/claude-sonnet-4-5', env), {
    provider: 'anthropic', id: 'claude-sonnet-4-5', baseUrl: 'http://anthropic.test', apiKey: testEnv.ANTHROPIC_API_KEY
  });
  assert.equal(resolveProviderModel(DEFAULT_READING_MODEL, env).baseUrl, 'http://openai.test/v1');
});

test('OpenAI SDK sends one strict structured request and persists no conversation state', async () => {
  const db = openMemoryDatabase(); let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'http://proxy.test/v1/responses');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-openai-key');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.deepEqual(body.text.format.schema.properties.relationships.items.required,
      ['from_item_id', 'to_item_id', 'relation_type', 'explanation', 'confidence', 'evidence']);
    assert.match(body.instructions, /untrusted data/);
    assert.equal(body.tools, undefined);
    assert.equal(JSON.parse(body.input).source_passages.map((passage: { text: string }) => passage.text).join(''), input.text);
    assert.equal(JSON.parse(body.input).text, undefined);
    return openaiResponse(validResult);
  };
  try {
    const analyze = createFlueReadingAnalyzer(db, { model: DEFAULT_READING_MODEL,
      env: { ...testEnv, OPENAI_BASE_URL: 'http://proxy.test/v1' }, fetch: transport });
    const result = await analyze(input);
    assert.equal(result.analysis_version, READING_ANALYSIS_VERSION);
    assert.equal(result.model, 'openai/gpt-5.6-luna');
    assert.equal(result.recommended_action, 'brief');
    assert.equal(calls, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(), undefined);
  } finally { db.close(); }
});

test('Anthropic SDK uses one forced output tool through the selected proxy', async () => {
  const db = openMemoryDatabase(); let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'http://anthropic.test/v1/messages');
    assert.equal(new Headers(options?.headers).get('x-api-key'), 'test-anthropic-key');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'reading_analysis', disable_parallel_tool_use: true });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].input_schema.additionalProperties, false);
    return Response.json({ id: 'msg-test', type: 'message', role: 'assistant', model: body.model,
      stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-test', name: 'reading_analysis', input: validResult }],
      usage: { input_tokens: 100, output_tokens: 80 } });
  };
  try {
    const result = await createFlueReadingAnalyzer(db, { model: 'anthropic/claude-sonnet-4-5',
      env: { ...testEnv, ANTHROPIC_BASE_URL: 'http://anthropic.test' }, fetch: transport })(input);
    assert.equal(result.model, 'anthropic/claude-sonnet-4-5'); assert.equal(calls, 1);
  } finally { db.close(); }
});

test('invalid, refused, incomplete, empty, and HTTP error responses fail once without SDK retries', async () => {
  const responses = [
    () => openaiResponse({ summary: 'invalid' }),
    () => openaiResponse(validResult, { status: 'incomplete' }),
    () => openaiResponse(validResult, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }),
    () => openaiResponse(validResult, { output: [] }),
    () => Response.json({ error: { message: 'PRIVATE ERROR' } }, { status: 500 })
  ];
  for (const respond of responses) {
    const db = openMemoryDatabase(); let calls = 0;
    try {
      const analyze = createFlueReadingAnalyzer(db, { model: DEFAULT_READING_MODEL, env: testEnv,
        fetch: async () => { calls++; return respond(); } });
      await assert.rejects(analyze(input), /Reading analysis failed/);
      assert.equal(calls, 1);
    } finally { db.close(); }
  }
});

test('Anthropic rejects truncated, missing, unexpected, duplicate, or invalid structured tool output', async () => {
  const output = { type: 'tool_use', id: 'tool-test', name: 'reading_analysis', input: validResult };
  const cases = [
    { stop_reason: 'max_tokens', content: [output] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'No analysis' }] },
    { stop_reason: 'tool_use', content: [{ ...output, name: 'unexpected_tool' }] },
    { stop_reason: 'tool_use', content: [output, output] },
    { stop_reason: 'tool_use', content: [{ ...output, input: { summary: 'invalid' } }] }
  ];
  const db = openMemoryDatabase();
  try {
    for (const response of cases) {
      let calls = 0;
      const analyze = createFlueReadingAnalyzer(db, { model: 'anthropic/claude-sonnet-4-5', env: testEnv,
        fetch: async () => { calls++; return Response.json({ id: 'msg-test', type: 'message', role: 'assistant',
          model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 80 }, ...response }); } });
      await assert.rejects(analyze(input), /Reading analysis failed/);
      assert.equal(calls, 1);
    }
  } finally { db.close(); }
});

test('missing credentials and unsupported providers fail before any provider request', async () => {
  const db = openMemoryDatabase(); let calls = 0;
  try {
    for (const [model, env] of [[DEFAULT_READING_MODEL, {}], ['unknown/model', testEnv]] as const) {
      const analyze = createFlueReadingAnalyzer(db, { model, env,
        fetch: async () => { calls++; return openaiResponse(validResult); } });
      await assert.rejects(analyze(input), /Reading analysis failed/);
    }
    assert.equal(calls, 0);
  } finally { db.close(); }
});

test('analyzer rejects already-aborted calls before transport and propagates an in-flight abort', async () => {
  const db = openMemoryDatabase(); let calls = 0;
  let started!: () => void; const waiting = new Promise<void>((resolve) => { started = resolve; });
  const analyze = createFlueReadingAnalyzer(db, { model: DEFAULT_READING_MODEL, env: testEnv,
    fetch: async (_url, options) => {
      calls++; started();
      return new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        assert.ok(signal);
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    } });
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(analyze({ ...input, signal: before.signal }), /Reading analysis failed/);
    assert.equal(calls, 0);
    const active = new AbortController(); const result = analyze({ ...input, signal: active.signal });
    await waiting; active.abort();
    await assert.rejects(result, /Reading analysis failed/); assert.equal(calls, 1);
  } finally { db.close(); }
});

test('trace records only safe metadata on success, validation failure, and provider error', async () => {
  const db = openMemoryDatabase(); const tmp = await mkdtemp(join(tmpdir(), 'reading-api-traces-'));
  const tracePath = join(tmp, 'flue-events.jsonl');
  const privateText = 'PRIVATE SOURCE TEXT'; const privateTitle = 'PRIVATE TITLE'; const privateModelText = 'PRIVATE MODEL ECHO';
  try {
    const analyze = (fetch: typeof globalThis.fetch) => createFlueReadingAnalyzer(db, { model: DEFAULT_READING_MODEL,
      env: testEnv, tracePath, fetch })({ ...input, title: privateTitle, text: privateText });
    await analyze(async () => openaiResponse({ ...validResult, relevance: { score: 0.7, themes: [privateModelText] } }));
    await assert.rejects(analyze(async () => openaiResponse({ summary: privateModelText })), /Reading analysis failed/);
    await assert.rejects(analyze(async () => Response.json({ error: { message: privateText, code: privateModelText } }, { status: 500 })), /Reading analysis failed/);
    const text = await readFile(tracePath, 'utf8');
    for (const secret of [privateText, privateTitle, privateModelText, testEnv.OPENAI_API_KEY]) assert(!text.includes(secret));
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.event === 'analysis_start').length, 3);
    assert.equal(lines.filter((line) => line.event === 'provider_response').length, 2);
    assert.equal(lines.filter((line) => line.event === 'analysis_error').length, 2);
    assert.match(text, /error_message_sha256/);
  } finally { db.close(); await rm(tmp, { recursive: true, force: true }); }
});

test('trace write failures do not prevent a successful analysis', async () => {
  const db = openMemoryDatabase(); const tmp = await mkdtemp(join(tmpdir(), 'reading-api-traces-'));
  const blocker = join(tmp, 'blocker'); await writeFile(blocker, 'blocker');
  try {
    const analyze = createFlueReadingAnalyzer(db, { model: DEFAULT_READING_MODEL, env: testEnv,
      tracePath: join(blocker, 'events.jsonl'), fetch: async () => openaiResponse(validResult) });
    assert.equal((await analyze(input)).recommended_action, 'brief');
  } finally { db.close(); await rm(tmp, { recursive: true, force: true }); }
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

test('SDK receives prior source passages and attributed reader context before model judgment', async () => {
  const db = openMemoryDatabase();
  db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES ('prior', 'text', 'Cache reuse', '2026-09-01', 'prior', 'indexed', ?)`).run(evidencePrior.source_passages[0]!);
  db.prepare('INSERT INTO item_fts (item_id, title, body, summary, tags) VALUES (?, ?, ?, ?, ?)')
    .run('prior', 'Cache reuse', evidencePrior.source_passages[0]!, evidencePrior.summary, 'cache');
  db.prepare(`INSERT INTO reader_annotations (id, item_id, actor_type, actor, note, project, question, created_at)
    VALUES ('note', 'prior', 'user', 'Aaron', 'I am uncertain about staleness guarantees.', 'Analytics harness', 'When is reuse safe?', '2026-09-01')`).run();
  let providerInput = '';
  const transport: typeof fetch = async (_url, options) => {
    providerInput = String(options?.body);
    return openaiResponse({ ...evidenceResult, relationships: evidenceResult.relationships.map(relationship => ({
      ...relationship, evidence: { source_passage_id: 'current:1', target_passage_id: 'prior:1:1' }
    })) });
  };
  try {
    const analyze = createFlueReadingAnalyzer(db, { model: 'gpt-5.6-luna', env: testEnv, fetch: transport });
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
    db.close();
  }
});
