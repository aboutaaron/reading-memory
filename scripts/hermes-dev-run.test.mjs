import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { noticeFor, claimNotice } from './hermes-dev-run.mjs';

test('Hermes notice is quiet for progress and contains only actionable public evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-dev-notice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, 'development', 'example');
  mkdirSync(run, { recursive: true });
  const s = { id: 'example', contract: { objective: 'Fix ledger verification', privateExtra: 'not a notice field' }, phase: 'implementing', control: 'active', candidate: null, pr: null, next_action: 'observe worker' };
  assert.equal(noticeFor(s), null);
  const ready = noticeFor({ ...s, phase: 'ready', candidate: 'abc', pr: { url: 'https://example.invalid/pr' }, tests: { candidate: 'abc' }, review: { candidate: 'abc' }, ci: { candidate: 'abc' } });
  assert.ok(!JSON.stringify(ready).includes('privateExtra'));
  assert.equal(claimNotice(run, ready), true);
  assert.equal(claimNotice(run, ready), false);
  assert.equal(claimNotice(run, { ...ready, candidate: 'def' }), true);
  assert.equal(claimNotice(run, null), false);
  assert.ok(noticeFor({ ...s, control: 'blocked', blocker: 'Deadline exceeded' }));
});
