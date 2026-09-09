import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const project = fileURLToPath(new URL('../', import.meta.url));

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('the real npm package runs native backup and restore under node_modules without a TypeScript loader', { timeout: 45_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'reading-package-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(existsSync(join(project, 'dist', 'src', 'filesystem', 'private-files.js')),
    'run npm run build before packaging; this regression uses real compiler output');
  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: project }))[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['dist/src/filesystem/private-files.js', 'dist/src/ingest/pdf-worker.mjs',
    'scripts/private-files.mjs', 'scripts/backup-sqlite.mjs', 'scripts/restore-sqlite.mjs']) {
    assert.ok(files.has(required), `npm package must contain ${required}`);
  }
  const app = join(root, 'node_modules', 'reading-memory');
  mkdirSync(app, { recursive: true });
  command('tar', ['-xzf', join(root, packed.filename), '-C', app, '--strip-components=1']);
  const run = (script, args) => JSON.parse(command(process.execPath,
    ['--no-experimental-strip-types', '--', join(app, script), ...args], {
      cwd: app, env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' }
    }));

  // Use only files extracted from the actual npm tarball. Neither production
  // dependencies nor a TypeScript loader are available in this installation.
  const live = join(root, 'data', 'reading.sqlite');
  mkdirSync(dirname(live), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(live);
  try { db.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('packaged snapshot')"); }
  finally { db.close(); }
  const backup = join(root, 'backups', 'reading.sqlite');
  assert.equal(run('scripts/backup-sqlite.mjs', [live, backup]).integrity, 'ok');
  const changed = new DatabaseSync(live);
  try { changed.exec("UPDATE notes SET text = 'newer reading'"); }
  finally { changed.close(); }
  const restored = run('scripts/restore-sqlite.mjs', [backup, live]);
  assert.equal(restored.integrity, 'ok');
  const verified = new DatabaseSync(live, { readOnly: true });
  try { assert.equal(verified.prepare('SELECT text FROM notes').get().text, 'packaged snapshot'); }
  finally { verified.close(); }
  for (const file of [live, backup, restored.safety_snapshot]) assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const directory of [dirname(live), dirname(backup)]) assert.equal(statSync(directory).mode & 0o777, 0o700);
});
