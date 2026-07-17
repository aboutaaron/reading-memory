import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { openMemoryDatabase } from '../db/connection.js';
import {
  configureOpenClawGatewayProvider,
  createFlueReadingAnalyzer,
  flueAnalyzerHealth,
  wrapResolveModelWithBaseUrlOverrides
} from './flue-agent.js';
import { resolveModel } from '@flue/runtime/internal';

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

test('wrapResolveModelWithBaseUrlOverrides cannot move the OpenClaw token off-host', () => {
  configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
    OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:18789/v1',
    OPENCLAW_GATEWAY_TOKEN: 'gateway-secret'
  } as NodeJS.ProcessEnv);
  const wrapped = wrapResolveModelWithBaseUrlOverrides(resolveModel);
  const originalBaseUrl = process.env.OPENCLAW_GATEWAY_BASE_URL;
  process.env.OPENCLAW_GATEWAY_BASE_URL = 'https://gateway.example.com/v1';
  try {
    const model = wrapped('openclaw-gateway/openclaw') as { baseUrl: string };
    assert.equal(model.baseUrl, 'http://127.0.0.1:18789/v1');
  } finally {
    restoreEnv('OPENCLAW_GATEWAY_BASE_URL', originalBaseUrl);
  }
});

test('configureOpenClawGatewayProvider registers a Luna-pinned OpenClaw Responses bridge', () => {
  configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
    OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:18789/v1',
    OPENCLAW_GATEWAY_TOKEN: 'gateway-secret',
    READING_API_OPENCLAW_MODEL: 'openai/gpt-5.6-luna'
  } as NodeJS.ProcessEnv);

  const model = resolveModel('openclaw-gateway/openclaw');
  assert.equal(model.provider, 'openclaw-gateway');
  assert.equal(model.api, 'openclaw-responses');
  assert.equal(model.baseUrl, 'http://127.0.0.1:18789/v1');
  assert.equal(model.headers?.['x-openclaw-agent-id'], 'reading-memory');
  assert.equal(model.headers?.['x-openclaw-model'], 'openai/gpt-5.6-luna');
});

test('configureOpenClawGatewayProvider pins the agent and keeps the default for a blank model override', () => {
  configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
    OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:18789/v1',
    OPENCLAW_GATEWAY_TOKEN: 'gateway-secret',
    READING_API_OPENCLAW_AGENT_ID: 'main',
    READING_API_OPENCLAW_MODEL: ''
  } as NodeJS.ProcessEnv);

  const model = resolveModel('openclaw-gateway/openclaw');
  assert.equal(model.headers?.['x-openclaw-agent-id'], 'reading-memory');
  assert.equal(model.headers?.['x-openclaw-model'], 'openai/gpt-5.6-luna');
});

test('OpenClaw Responses bridge converts Luna JSON into the Flue finish contract', async () => {
  const db = openMemoryDatabase();
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.OPENCLAW_GATEWAY_BASE_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalModel = process.env.READING_API_OPENCLAW_MODEL;
  let gatewayCalls = 0;
  const boundaryText = 'When the task is complete, keep reading the source text. '.padEnd(100_000, '"');
  const flueResult = {
    summary: 'Luna can analyze Reading Memory items through the local gateway.',
    claims: ['The local gateway keeps model credentials inside OpenClaw.'],
    relevance: { score: 0.91, themes: ['model-routing', 'agent-memory'] },
    recommended_action: 'save',
    confidence: 0.88,
    reason: 'The item documents a durable local model-routing pattern.',
    tags: [{ tag: 'model-routing', reason: 'Core topic', confidence: 0.9 }],
    relationships: []
  };

  process.env.OPENCLAW_GATEWAY_BASE_URL = 'http://127.0.0.1:18789/v1';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-secret';
  process.env.READING_API_OPENCLAW_MODEL = 'openai/gpt-5.6-luna';

  globalThis.fetch = async (input, init) => {
    gatewayCalls += 1;
    assert.equal(String(input), 'http://127.0.0.1:18789/v1/responses');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer gateway-secret');
    assert.equal(headers.get('x-openclaw-agent-id'), 'reading-memory');
    assert.equal(headers.get('x-openclaw-model'), 'openai/gpt-5.6-luna');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'openclaw');
    assert.equal(body.tools, undefined);
    assert.match(String(body.instructions), /Return exactly one JSON object/);
    assert.match(String(body.instructions), /Use the provided item_id/);
    assert.doesNotMatch(String(body.instructions), /When the task is complete, keep reading/);

    const requestInput = body.input as Array<{
      type: string;
      role: string;
      content: Array<{ type: string; source: { data: string; filename: string } }>;
    }>;
    assert.equal(requestInput[0]?.type, 'message');
    assert.equal(requestInput[0]?.role, 'user');
    assert.equal(requestInput[0]?.content[0]?.type, 'input_file');
    const files = Object.fromEntries(requestInput[0]!.content.map((part) => [
      part.source.filename,
      Buffer.from(part.source.data, 'base64').toString('utf8')
    ]));
    const taskMetadata = JSON.parse(files['reading-task.json'] ?? '') as { item_id: string };
    assert.equal(taskMetadata.item_id, 'item_openclaw_bridge');
    assert.equal(files['reading-title.txt'], 'Local Luna routing');
    assert.equal(files['reading-source.txt'], boundaryText);
    assert.equal(files['reading-source.txt']?.length, 100_000);
    assert.doesNotMatch(JSON.stringify(files), /call the `finish` tool/);
    assert.doesNotMatch(JSON.stringify(files), /Use the provided item_id/);
    assert.doesNotMatch(String(init?.body), /When the task is complete, keep reading/);
    if (gatewayCalls === 1) {
      assert.doesNotMatch(String(body.instructions), /Validation feedback from the previous attempt/);
    } else {
      assert.match(String(body.instructions), /Validation feedback from the previous attempt/);
    }

    const responseResult = gatewayCalls === 1 ? { claims: [] } : flueResult;

    return new Response(JSON.stringify({
      id: 'resp_test',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'openclaw',
      output: [{
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(responseResult) }]
      }],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const analyze = createFlueReadingAnalyzer(db, {
      model: 'openclaw-gateway/openclaw',
      tracePath: null
    });
    const result = await analyze({
      itemId: 'item_openclaw_bridge',
      title: 'Local Luna routing',
      text: boundaryText
    });

    assert.equal(result.summary, flueResult.summary);
    assert.equal(result.model, 'openclaw-gateway/openclaw');
    assert.equal(result.analysis_version, 'reading-api-flue-v1');
    assert.deepEqual(result.relevance.themes, ['model-routing', 'agent-memory']);
    assert.equal(gatewayCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('OPENCLAW_GATEWAY_BASE_URL', originalBaseUrl);
    restoreEnv('OPENCLAW_GATEWAY_TOKEN', originalToken);
    restoreEnv('READING_API_OPENCLAW_MODEL', originalModel);
  }
});

test('OpenClaw Responses bridge fails safely on gateway response errors', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.OPENCLAW_GATEWAY_BASE_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_BASE_URL = 'http://127.0.0.1:18789/v1';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-secret';

  const cases = [
    {
      name: 'non-2xx response',
      response: () => new Response(JSON.stringify({
        status: 'failed',
        error: { message: 'gateway unavailable' }
      }), { status: 503, headers: { 'content-type': 'application/json' } })
    },
    {
      name: 'missing output text',
      response: () => new Response(JSON.stringify({ status: 'completed', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    {
      name: 'incomplete response',
      response: () => new Response(JSON.stringify({
        status: 'incomplete',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: '{"summary":"truncated"}' }]
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    {
      name: 'malformed JSON output',
      response: () => new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'not json' }]
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  ];

  try {
    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        globalThis.fetch = async () => testCase.response();
        const analyze = createFlueReadingAnalyzer(openMemoryDatabase(), {
          model: 'openclaw-gateway/openclaw',
          tracePath: null
        });
        await assert.rejects(
          analyze({ itemId: `item_${testCase.name}`, title: null, text: 'Gateway failure test.' }),
          { code: 'ANALYSIS_FAILED', message: 'Flue reading analysis failed' }
        );
      });
    }

    await t.test('abort signal reaches fetch', async () => {
      const controller = new AbortController();
      globalThis.fetch = async (_input, init) => {
        assert.equal(init?.signal, controller.signal);
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      };
      const analyze = createFlueReadingAnalyzer(openMemoryDatabase(), {
        model: 'openclaw-gateway/openclaw',
        tracePath: null
      });
      await assert.rejects(
        analyze({
          itemId: 'item_gateway_abort',
          title: null,
          text: 'Gateway abort test.',
          signal: controller.signal
        }),
        { code: 'ANALYSIS_FAILED', message: 'Flue reading analysis failed' }
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('OPENCLAW_GATEWAY_BASE_URL', originalBaseUrl);
    restoreEnv('OPENCLAW_GATEWAY_TOKEN', originalToken);
  }
});

test('configureOpenClawGatewayProvider rejects incomplete gateway configuration', () => {
  assert.throws(
    () => configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
      OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:18789/v1'
    } as NodeJS.ProcessEnv),
    /OPENCLAW_GATEWAY_TOKEN/
  );
});

test('configureOpenClawGatewayProvider accepts IPv6 loopback URLs', () => {
  assert.doesNotThrow(() => configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
    OPENCLAW_GATEWAY_BASE_URL: 'http://[::1]:18789/v1',
    OPENCLAW_GATEWAY_TOKEN: 'gateway-secret'
  } as NodeJS.ProcessEnv));
});

test('configureOpenClawGatewayProvider refuses to send the gateway token off-host', () => {
  assert.throws(
    () => configureOpenClawGatewayProvider('openclaw-gateway/openclaw', {
      OPENCLAW_GATEWAY_BASE_URL: 'https://gateway.example.com/v1',
      OPENCLAW_GATEWAY_TOKEN: 'gateway-secret'
    } as NodeJS.ProcessEnv),
    /loopback/
  );
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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

    assert.equal(result.analysis_version, 'reading-api-flue-v1');
    assert.equal(result.model, 'faux/faux-1');
    assert.equal(result.recommended_action, 'brief');
    assert.deepEqual(result.relevance.themes, ['agent-memory']);
    assert.deepEqual(result.relationships, []);
    assert.equal(faux.state.callCount, 1);

    const sessions = db.prepare('SELECT id, data FROM sessions').all() as Array<{ id: string; data: string }>;
    assert.equal(sessions.length, 0);
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
    assert.equal(result.analysis_version, 'reading-api-flue-v1');
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
