import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import { FlueTraceLogger } from './flue-trace.js';

const envelope = {
  v: 3 as const,
  eventIndex: 1,
  timestamp: '2026-07-14T00:00:00.000Z',
  session: 'runtime-session',
  parentSession: 'parent-session'
};

test('Flue 1.0 terminal events retain safe success metadata', async () => {
  const cases: Array<{ event: FlueEvent; expected: Record<string, unknown> }> = [
    {
      event: { ...envelope, type: 'operation', operationId: 'op-1', operationKind: 'skill', durationMs: 12, isError: false, result: { ok: true } },
      expected: { flue_type: 'operation', is_error: false, result_summary: 'object(ok)' }
    },
    {
      event: { ...envelope, type: 'run_end', runId: 'run-1', durationMs: 15, isError: false, result: ['done'] },
      expected: { flue_type: 'run_end', is_error: false, result_summary: 'array(1)' }
    },
    {
      event: { ...envelope, type: 'compaction', messagesBefore: 8, messagesAfter: 3, durationMs: 20, isError: false },
      expected: { flue_type: 'compaction', is_error: false }
    },
    {
      event: { ...envelope, type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed', result: 'done' },
      expected: { flue_type: 'submission_settled', is_error: false, result_summary: '4 chars' }
    }
  ];

  const lines = await writeEvents(cases.map(({ event }) => event));
  const eventLines = lines.filter((line) => line.event === 'flue_event');

  assert.equal(eventLines.length, cases.length);
  for (const [index, { expected }] of cases.entries()) {
    assert.deepEqual(eventLines[index], {
      trace_id: eventLines[index].trace_id,
      item_id: 'item-trace-contract',
      requested_session_id: 'requested-session',
      event: 'flue_event',
      session_id: 'runtime-session',
      parent_session_id: 'parent-session',
      ts: eventLines[index].ts,
      ...expected
    });
  }
});

test('Flue 1.0 terminal events hash errors without persisting their messages', async () => {
  const secret = 'PRIVATE FLUE ERROR';
  const cases: FlueEvent[] = [
    { ...envelope, type: 'operation', operationId: 'op-1', operationKind: 'skill', durationMs: 12, isError: true, error: new Error(secret) },
    { ...envelope, type: 'run_end', runId: 'run-1', durationMs: 15, isError: true, error: { code: 'RUN_FAILED', message: secret } },
    { ...envelope, type: 'compaction', messagesBefore: 8, messagesAfter: 8, durationMs: 20, isError: true, error: secret },
    { ...envelope, type: 'submission_settled', submissionId: 'sub-1', outcome: 'failed', error: { name: 'SubmissionError', message: secret } }
  ];

  const lines = await writeEvents(cases);
  const serialized = JSON.stringify(lines);
  const eventLines = lines.filter((line) => line.event === 'flue_event');

  assert.equal(eventLines.length, cases.length);
  assert(!serialized.includes(secret));
  for (const line of eventLines) {
    assert.equal(line.is_error, true);
    assert.equal(line.error_message_chars, secret.length);
    assert.match(line.error_message_sha256, /^sha256:/);
  }
  assert.deepEqual(eventLines.map((line) => line.error_kind), ['Error', 'RUN_FAILED', 'string', 'SubmissionError']);
});

test('errorKind hashes content-bearing error identifiers before tracing them', async () => {
  const leakyCode = `LEAKY_${'PRIVATE PAYLOAD TEXT '.repeat(10)}`;
  const events: FlueEvent[] = [
    { ...envelope, type: 'run_end', runId: 'run-1', durationMs: 5, isError: true, error: { code: leakyCode, message: 'boom' } }
  ];

  const lines = await writeEvents(events);
  const eventLine = lines.find((line) => line.event === 'flue_event');

  assert(eventLine);
  assert.match(eventLine.error_kind, /^sha256:/);
  assert(!JSON.stringify(lines).includes('PRIVATE PAYLOAD TEXT'));
});

async function writeEvents(events: FlueEvent[]) {
  const root = await mkdtemp(join(tmpdir(), 'reading-memory-flue-trace-'));
  const tracePath = join(root, 'flue-events.jsonl');
  const logger = new FlueTraceLogger(tracePath);
  const trace = logger.createTrace({
    itemId: 'item-trace-contract',
    sessionId: 'requested-session',
    title: null,
    text: 'PRIVATE SOURCE TEXT',
    model: 'test/model'
  });

  try {
    for (const event of events) trace.onEvent(event);
    await trace.flush();
    return (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
