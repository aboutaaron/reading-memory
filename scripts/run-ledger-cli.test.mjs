import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const script = new URL('./run-ledger.mjs', import.meta.url).pathname;

test('CLI create, append, status, and JSON status work together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-cli-'));
  const create = runCli([
    'create',
    '--root', root,
    '--workflow', 'newsletter_triage',
    '--run-id', 'cli-run',
    '--input-json', '{"mailbox":"newsletters"}'
  ]);
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout);
  assert.equal(created.ok, true);
  assert.equal(created.run_id, 'cli-run');

  const append = runCli([
    'append',
    '--run', created.run_dir,
    '--event-kind', 'source_considered',
    '--payload-json', '{"source_id":"email_1","label":"CLI source"}'
  ]);
  assert.equal(append.status, 0, append.stderr);
  assert.equal(JSON.parse(append.stdout).event.kind, 'source_considered');

  const status = runCli(['status', '--run', created.run_dir]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Run: cli-run/);
  assert.match(status.stdout, /Pending decisions: 1/);

  const jsonStatus = runCli(['status', '--run', created.run_dir, '--json']);
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  assert.equal(JSON.parse(jsonStatus.stdout).state.next_step, 'record pending decisions');
});

test('CLI reports invalid JSON and missing arguments with non-zero exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-cli-'));
  const invalidJson = runCli([
    'create',
    '--root', root,
    '--workflow', 'newsletter_triage',
    '--input-json', '{not-json}'
  ]);
  assert.notEqual(invalidJson.status, 0);
  assert.match(invalidJson.stderr, /--input-json must be valid JSON/);

  const missingRun = runCli(['status']);
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /--run is required/);
});

test('CLI exposes machine-readable schema for agents', () => {
  const result = runCli(['schema']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);

  assert.equal(body.ok, true);
  assert.deepEqual(body.schema.required_event_fields.decision_recorded, ['source_id', 'decision']);
  assert.ok(body.schema.decisions.includes('skim'));
  assert.ok(body.schema.external_actions.includes('archive'));
  assert.match(body.schema.extension_rule, /custom:<lowercase-slug>/);
});

test('CLI rejects scalar and array payload JSON before persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-ledger-cli-'));
  const create = runCli([
    'create',
    '--root', root,
    '--workflow', 'newsletter_triage',
    '--run-id', 'privacy-cli'
  ]);
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout);

  for (const payload of ['"full newsletter body"', '["full newsletter body"]']) {
    const result = runCli([
      'append',
      '--run', created.run_dir,
      '--event-kind', 'source_considered',
      '--payload-json', payload
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /payload must be a JSON object/);
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8'
  });
}
