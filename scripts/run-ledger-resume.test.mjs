import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

for (const status of ['failed', 'pending']) {
  for (const completionFirst of [false, true]) {
    test(`${status} verification ${completionFirst ? 'after' : 'before'} completion stays pending on replay`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'run-ledger-resume-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const { run_dir: runDir } = await createRunLedger({ root, workflow: 'newsletter_triage', runId: 'completion-verification' });
      await appendRunEvent({ runDir, kind: 'external_action_recorded', payload: { action_id: 'archive_1', action: 'archive', status: 'verified' } });
      const complete = () => appendRunEvent({ runDir, kind: 'run_completed', payload: { summary: 'Completion recorded.' } });
      if (completionFirst) await complete();
      await appendRunEvent({ runDir, kind: 'verification_recorded', payload: { action_id: 'archive_1', status } });
      if (!completionFirst) await complete();

      const assertPending = async () => {
        const state = await deriveRunState(runDir);
        assert.equal(state.status, 'active');
        assert.equal(state.pending_external_actions.length, 1);
        assert.equal(state.pending_external_actions[0].action_id, 'archive_1');
        assert.equal(state.pending_external_actions[0].status, status);
        assert.equal(state.next_step, 'verify external actions');
        assert.ok(state.completed_at);
        assert.equal(state.summary, 'Completion recorded.');
      };

      // A completion snapshot cannot override outstanding verification work.
      assert.equal(JSON.parse(await readFile(join(runDir, 'outputs.json'), 'utf8')).status, 'completed');
      await assertPending();
      assert.match(await readFile(join(runDir, 'run.md'), 'utf8'), /Status: active/);
      assert.match(await readFile(join(runDir, 'run.md'), 'utf8'), /Pending external actions: 1/);

      // Replay must also work if completion was never saved to outputs.json.
      await writeFile(join(runDir, 'outputs.json'), JSON.stringify({ status: 'active', completed_at: null, summary: null }));
      await assertPending();
      await appendRunEvent({ runDir, kind: 'run_resumed' });
      await assertPending();

      await appendRunEvent({ runDir, kind: 'verification_recorded', payload: { action_id: 'archive_1', status: 'verified' } });
      const recovered = await deriveRunState(runDir);
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.pending_external_actions.length, 0);
      assert.equal(recovered.next_step, 'done');
      assert.equal(recovered.summary, 'Completion recorded.');
      assert.match(await readFile(join(runDir, 'run.md'), 'utf8'), /Status: completed/);
      assert.match(await readFile(join(runDir, 'run.md'), 'utf8'), /Pending external actions: 0/);
    });
  }
}

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
