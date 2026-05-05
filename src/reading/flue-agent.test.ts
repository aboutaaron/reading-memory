import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, registerFauxProvider } from '@mariozechner/pi-ai';
import { openMemoryDatabase } from '../db/connection.js';
import { createFlueReadingAnalyzer } from './flue-agent.js';

test('Flue analyzer loads the analyze-item skill and persists session state in SQLite', async () => {
  const db = openMemoryDatabase();
  const faux = registerFauxProvider();
  const flueResult = JSON.stringify({
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
  });
  faux.setResponses([
    fauxAssistantMessage(`---RESULT_START---\n${flueResult}\n---RESULT_END---`)
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
    assert.equal(sessions.length, 1);
    assert.match(sessions[0]?.id ?? '', /agent-session/);
    assert.match(sessions[0]?.data ?? '', /Durable reading memory/);
  } finally {
    faux.unregister();
  }
});

test('Flue analyzer writes redacted local traces', async () => {
  const db = openMemoryDatabase();
  const tmp = await mkdtemp(join(tmpdir(), 'reading-api-traces-'));
  const tracePath = join(tmp, 'flue-events.jsonl');
  const faux = registerFauxProvider();
  const flueResult = JSON.stringify({
    summary: 'Trace logging records useful output without raw source text.',
    claims: ['Trace logs are useful.'],
    relevance: { score: 0.75, themes: ['observability'] },
    recommended_action: 'save',
    confidence: 0.8,
    reason: 'Useful for inspecting Flue behavior.',
    tags: [{ tag: 'observability', reason: 'Core topic', confidence: 0.88 }],
    relationships: []
  });
  faux.setResponses([
    fauxAssistantMessage(`---RESULT_START---\n${flueResult}\n---RESULT_END---`)
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
  const flueResult = JSON.stringify({
    summary: 'Analysis succeeds even when trace writing fails.',
    claims: ['Tracing must be best-effort.'],
    relevance: { score: 0.7, themes: ['reliability'] },
    recommended_action: 'save',
    confidence: 0.83,
    reason: 'Observability should not break ingest.',
    tags: [{ tag: 'reliability', reason: 'Core topic', confidence: 0.9 }],
    relationships: []
  });
  faux.setResponses([
    fauxAssistantMessage(`---RESULT_START---\n${flueResult}\n---RESULT_END---`)
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
    fauxAssistantMessage('---RESULT_START---\n"PRIVATE MODEL ECHO SHOULD NOT BE LOGGED"\n---RESULT_END---')
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
