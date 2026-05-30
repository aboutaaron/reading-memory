import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import {
  appendRunEvent,
  createRunLedger,
  deriveRunState,
  readEvents
} from './lib/run-ledger.mjs';

test('creating a run produces expected files and valid JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const result = await createRunLedger({
    root,
    workflow: 'newsletter_triage',
    runId: 'triage-1',
    inputs: { window: 'today' },
    now: new Date('2026-05-30T10:00:00.000Z')
  });

  assert.equal(result.run_id, 'triage-1');
  assert.deepEqual(JSON.parse(await readFile(join(result.run_dir, 'inputs.json'), 'utf8')).inputs, { window: 'today' });
  assert.equal(JSON.parse(await readFile(join(result.run_dir, 'outputs.json'), 'utf8')).status, 'active');
  assert.equal((await readEvents(join(result.run_dir, 'events.jsonl'))).length, 1);
  assert.match(await readFile(join(result.run_dir, 'run.md'), 'utf8'), /Status: active/);
});

test('appending events preserves rows and derives resume state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'triage-2' });

  await appendRunEvent({
    runDir,
    kind: 'source_considered',
    payload: { source_id: 'email_1', source_kind: 'newsletter', label: 'Good Signal' }
  });
  await appendRunEvent({
    runDir,
    kind: 'decision_recorded',
    payload: { source_id: 'email_1', decision: 'skim', rationale: 'Useful but not durable enough' }
  });
  await appendRunEvent({
    runDir,
    kind: 'external_action_recorded',
    payload: { source_id: 'email_1', action_id: 'archive_email_1', action: 'archive', status: 'pending' }
  });
  await appendRunEvent({
    runDir,
    kind: 'memory_capture_recorded',
    payload: { source_id: 'email_1', item_id: 'item_abc123' }
  });

  const events = await readEvents(join(runDir, 'events.jsonl'));
  const state = await deriveRunState(runDir);

  assert.equal(events.length, 5);
  assert.equal(state.completed_decisions.length, 1);
  assert.equal(state.pending_external_actions.length, 1);
  assert.deepEqual(state.captured_item_ids, ['item_abc123']);
  assert.equal(state.next_step, 'verify external actions');
});

test('verification events clear pending external actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'triage-3' });

  await appendRunEvent({
    runDir,
    kind: 'external_action_recorded',
    payload: { action_id: 'restore_1', action: 'restore', status: 'pending' }
  });
  await appendRunEvent({
    runDir,
    kind: 'verification_recorded',
    payload: { action_id: 'restore_1', status: 'verified' }
  });

  const state = await deriveRunState(runDir);

  assert.equal(state.pending_external_actions.length, 0);
  assert.equal(state.next_step, 'record completion');
});

test('unknown event kinds and raw content fields are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'triage-4' });

  await assert.rejects(
    appendRunEvent({ runDir, kind: 'gmail_archived', payload: {} }),
    /Unknown run-ledger event kind/
  );
  await assert.rejects(
    appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1', body: 'full email body' } }),
    /raw-content-like field/
  );
});

test('privacy guard rejects documented aliases and nested raw content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'triage-privacy' });

  for (const key of ['body', 'text', 'html', 'content', 'raw_text', 'model_output']) {
    await assert.rejects(
      appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: `email_${key}`, nested: [{ [key]: 'private' }] } }),
      /raw-content-like field/
    );
  }
});

test('privacy guard rejects overlong string fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'triage-long' });

  await assert.rejects(
    appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1', label: 'x'.repeat(2001) } }),
    /too long/
  );
});

test('create rejects raw content in inputs before writing a ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));

  await assert.rejects(
    createRunLedger({
      root,
      workflow: 'newsletter_triage',
      runId: 'bad-inputs',
      inputs: { body: 'full newsletter body' }
    }),
    /raw-content-like field/
  );
});

test('create refuses duplicate run ids without overwriting existing ledger files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const first = await createRunLedger({
    root,
    workflow: 'newsletter_triage',
    runId: 'duplicate-run',
    inputs: { mailbox: 'original' }
  });
  await writeFile(join(first.run_dir, 'outputs.json'), JSON.stringify({
    run_id: 'duplicate-run',
    workflow: 'newsletter_triage',
    status: 'active',
    completed_at: null,
    summary: 'preserve me'
  }, null, 2));

  await assert.rejects(
    createRunLedger({
      root,
      workflow: 'newsletter_triage',
      runId: 'duplicate-run',
      inputs: { mailbox: 'replacement' }
    }),
    /already exists/
  );

  assert.equal(JSON.parse(await readFile(join(first.run_dir, 'inputs.json'), 'utf8')).inputs.mailbox, 'original');
  assert.equal(JSON.parse(await readFile(join(first.run_dir, 'outputs.json'), 'utf8')).summary, 'preserve me');
});

test('create rejects run ids that are not safe path segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));

  for (const runId of ['../outside', '/absolute', '..', '.', 'nested/path']) {
    await assert.rejects(
      createRunLedger({ root, workflow: 'newsletter_triage', runId }),
      /run_id must be/
    );
  }
});

test('completion replays from events when outputs are stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'event-complete' });
  await appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1' } });
  await appendRunEvent({ runDir, kind: 'decision_recorded', payload: { source_id: 'email_1', decision: 'done', rationale: 'No durable value' } });
  await appendRunEvent({ runDir, kind: 'run_completed', payload: { summary: 'Completed in event log.' } });
  await writeFile(join(runDir, 'outputs.json'), JSON.stringify({
    run_id: 'event-complete',
    workflow: 'newsletter_triage',
    status: 'active',
    completed_at: null,
    summary: null
  }, null, 2));

  const state = await deriveRunState(runDir);

  assert.equal(state.status, 'completed');
  assert.equal(state.summary, 'Completed in event log.');
  assert.equal(state.next_step, 'done');
});
