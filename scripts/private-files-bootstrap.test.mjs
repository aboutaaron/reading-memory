import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ts from 'typescript';

const project = new URL('../', import.meta.url);
const policyPath = 'src/filesystem/private-files.ts';

function checkout(t, installed = false) {
  const root = mkdtempSync(join(tmpdir(), 'reading-files-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = installed ? join(root, 'node_modules', 'reading-memory') : join(root, 'checkout');
  for (const path of [
    'package.json', policyPath, 'scripts/private-files.mjs', 'scripts/backup-sqlite.mjs',
    'scripts/restore-sqlite.mjs', 'scripts/setup.mjs', 'scripts/run-ledger.mjs',
    'scripts/lib/env-file.mjs', 'scripts/lib/mcp-config.mjs', 'scripts/lib/run-ledger.mjs'
  ]) {
    const destination = join(app, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(path, project), destination);
  }
  assert.equal(existsSync(join(app, 'dist')), false);
  assert.equal(existsSync(join(app, 'node_modules')), false);
  return { root, app };
}

function run(app, script, args) {
  const result = spawnSync(process.execPath, ['--', join(app, script), ...args], {
    cwd: app, encoding: 'utf8', timeout: 15_000,
    // The child must bootstrap without inheriting any TypeScript loader.
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function backupAndRestore({ root, app }) {
  const live = join(root, 'data', 'reading.sqlite');
  mkdirSync(dirname(live), { mode: 0o755 });
  const database = new DatabaseSync(live);
  database.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('saved note')");
  database.close();
  const destination = join(root, 'backups', 'reading.sqlite');
  const backup = JSON.parse(run(app, 'scripts/backup-sqlite.mjs', [live, destination]));
  assert.equal(backup.integrity, 'ok');
  const changed = new DatabaseSync(live);
  changed.exec("UPDATE notes SET text = 'newer note'");
  changed.close();
  const restore = JSON.parse(run(app, 'scripts/restore-sqlite.mjs', [destination, live]));
  assert.equal(restore.integrity, 'ok');
  const restored = new DatabaseSync(live, { readOnly: true });
  try { assert.equal(restored.prepare('SELECT text FROM notes').get().text, 'saved note'); }
  finally { restored.close(); }
  for (const file of [live, destination, restore.safety_snapshot]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  for (const directory of [dirname(live), dirname(destination)]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
}

test('unbuilt checkout bootstraps setup, status, backup, and restore without dependencies or a TypeScript loader', (t) => {
  const fixture = checkout(t);
  const { root, app } = fixture;
  const setup = run(app, 'scripts/setup.mjs', ['setup', '--target', 'env', '--env-file', join(root, 'data', 'env'), '--dry-run']);
  assert.match(setup, /Reading Memory setup checked/);
  const created = JSON.parse(run(app, 'scripts/run-ledger.mjs', ['create', '--root', join(root, 'runs'), '--run-id', 'bootstrap']));
  const status = JSON.parse(run(app, 'scripts/run-ledger.mjs', ['status', '--run', created.run_dir, '--json']));
  assert.equal(status.state.run_id, 'bootstrap');
  backupAndRestore(fixture);
  assert.equal(existsSync(join(app, 'dist')), false);
});

test('installed maintenance scripts consume compiled application policy under node_modules', (t) => {
  const fixture = checkout(t, true);
  const output = join(fixture.app, 'dist', 'src', 'filesystem', 'private-files.js');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, ts.transpileModule(readFileSync(new URL(policyPath, project), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
  }).outputText);
  backupAndRestore(fixture);
});
