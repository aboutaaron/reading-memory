import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FlueTraceLogger } from './flue-trace.js';

test('provider metadata is copied from a whitelist and error identifiers are hashed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-memory-provider-trace-'));
  const path = join(root, 'events.jsonl');
  const trace = new FlueTraceLogger(path).createTrace({ itemId: 'item', sessionId: 'session', title: null,
    text: 'PRIVATE SOURCE', model: 'test/model' });
  try {
    trace.onResponse({ provider: 'openai', output_chars: 100, input_tokens: 50, output_tokens: 25,
      raw: 'PRIVATE OUTPUT' } as Parameters<typeof trace.onResponse>[0]);
    await trace.error({ code: 'PRIVATE ERROR CODE', message: 'PRIVATE SOURCE' });
    const text = await readFile(path, 'utf8');
    assert(!text.includes('PRIVATE'));
    const events = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events[1].event, 'provider_response');
    assert.equal(events[1].output_chars, 100);
    assert.match(events[2].error_kind, /^sha256:/);
    assert.match(events[2].error_message_sha256, /^sha256:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
