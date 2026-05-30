import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import {
  appendRunEvent,
  createRunLedger,
  deriveRunState
} from './lib/run-ledger.mjs';

test('interrupted newsletter fixture identifies pending verification work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-resume-'));
  const runDir = join(root, 'newsletter_triage', 'fixture-interrupted');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'inputs.json'), JSON.stringify({
    run_id: 'fixture-interrupted',
    workflow: 'newsletter_triage',
    created_at: '2026-05-30T08:00:00.000Z',
    inputs: { mailbox: 'newsletters' }
  }, null, 2));
  await writeFile(join(runDir, 'outputs.json'), JSON.stringify({
    run_id: 'fixture-interrupted',
    workflow: 'newsletter_triage',
    status: 'active',
    completed_at: null,
    summary: null
  }, null, 2));
  await writeFile(
    join(runDir, 'events.jsonl'),
    await readFile(new URL('./fixtures/newsletter-triage-run.jsonl', import.meta.url), 'utf8')
  );

  const state = await deriveRunState(runDir);

  assert.deepEqual(state.captured_item_ids, ['item_ai_roundup_001']);
  assert.equal(state.completed_decisions.length, 2);
  assert.equal(state.pending_decisions.length, 0);
  assert.equal(state.pending_external_actions.length, 1);
  assert.equal(state.pending_external_actions[0].action_id, 'archive_ai_roundup');
  assert.equal(state.next_step, 'verify external actions');
});

test('completed run has no pending work after verification and completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-resume-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'complete-run' });

  await appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1', label: 'Done item' } });
  await appendRunEvent({ runDir, kind: 'decision_recorded', payload: { source_id: 'email_1', decision: 'done', rationale: 'No durable value' } });
  await appendRunEvent({ runDir, kind: 'external_action_recorded', payload: { source_id: 'email_1', action_id: 'archive_1', action: 'archive', status: 'pending' } });
  await appendRunEvent({ runDir, kind: 'verification_recorded', payload: { action_id: 'archive_1', status: 'verified' } });
  await appendRunEvent({ runDir, kind: 'run_completed', payload: { summary: 'All triage actions verified.' } });

  const state = await deriveRunState(runDir);

  assert.equal(state.status, 'completed');
  assert.equal(state.pending_decisions.length, 0);
  assert.equal(state.pending_external_actions.length, 0);
  assert.equal(state.next_step, 'done');
});

test('capture rows are not treated as external-action verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-resume-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'capture-not-verify' });

  await appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1' } });
  await appendRunEvent({ runDir, kind: 'decision_recorded', payload: { source_id: 'email_1', decision: 'save', rationale: 'Durable' } });
  await appendRunEvent({ runDir, kind: 'memory_capture_recorded', payload: { source_id: 'email_1', item_id: 'item_1' } });
  await appendRunEvent({ runDir, kind: 'external_action_recorded', payload: { source_id: 'email_1', action_id: 'archive_1', action: 'archive', status: 'pending' } });

  const state = await deriveRunState(runDir);

  assert.deepEqual(state.captured_item_ids, ['item_1']);
  assert.equal(state.pending_external_actions.length, 1);
  assert.equal(state.next_step, 'verify external actions');
});

test('considered sources without decisions remain pending recovery work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-resume-'));
  const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'pending-decision' });

  await appendRunEvent({ runDir, kind: 'source_considered', payload: { source_id: 'email_1', label: 'Needs decision' } });

  const state = await deriveRunState(runDir);

  assert.equal(state.status, 'active');
  assert.equal(state.pending_decisions.length, 1);
  assert.equal(state.pending_decisions[0].source_id, 'email_1');
  assert.equal(state.next_step, 'record pending decisions');
});
