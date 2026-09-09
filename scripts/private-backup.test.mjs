import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, verifyDatabase } from './backup-sqlite.mjs';
import { restoreDatabase } from './restore-sqlite.mjs';
import { privateDirectory } from './private-files.mjs';

const mode = (path) => statSync(path).mode & 0o777;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reading-backup-private-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o755 });
  const live = join(data, 'reading.sqlite');
  const db = new DatabaseSync(live);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('committed in WAL')");
  return { root, data, live, db };
}
function readNote(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT text FROM notes').get().text; } finally { db.close(); }
}

test('backup captures committed WAL state atomically with private modes and no ancestor chmod', (t) => {
  const { root, data, live, db } = fixture(t);
  t.after(() => db.close());
  chmodSync(root, 0o755); chmodSync(live, 0o644);
  const output = join(root, 'backups', 'reading.sqlite');
  const oldUmask = process.umask(0o022);
  try {
    const result = backupDatabase(live, output);
    assert.equal(result.integrity, 'ok');
    assert.equal(readNote(output), 'committed in WAL');
    for (const path of [live, live + '-wal', live + '-shm', output]) assert.equal(mode(path), 0o600, path);
    assert.equal(mode(data), 0o700); assert.equal(mode(join(root, 'backups')), 0o700);
    assert.equal(mode(root), 0o755);
    assert.equal(readdirSync(join(root, 'backups')).filter((f) => f.startsWith('.reading')).length, 0);
    assert.throws(() => backupDatabase(live, output), /already exists/);
    assert.equal(readNote(output), 'committed in WAL');
    assert.equal(process.umask(), 0o022);
  } finally { process.umask(oldUmask); }
});

test('restore uses private atomic replacement and keeps a self-contained private safety snapshot', (t) => {
  const { root, data, live, db } = fixture(t);
  const output = join(root, 'backups', 'reading.sqlite');
  backupDatabase(live, output);
  db.exec("UPDATE notes SET text = 'newer live state'"); db.close();
  chmodSync(output, 0o644); chmodSync(live, 0o644);
  const result = restoreDatabase(output, live);
  assert.equal(result.integrity, 'ok'); assert.equal(readNote(live), 'committed in WAL');
  assert.equal(readNote(result.safety_snapshot), 'newer live state');
  for (const path of [live, output, result.safety_snapshot]) assert.equal(mode(path), 0o600);
  assert.equal(mode(data), 0o700);
  assert.equal(readdirSync(data).filter((f) => f.startsWith('.reading')).length, 0);
});

test('corrupt restore rolls back to the private integrity-checked safety snapshot', (t) => {
  const { root, data, live, db } = fixture(t); db.close();
  const corrupt = join(root, 'bad.sqlite'); writeFileSync(corrupt, 'not sqlite', { mode: 0o644 });
  assert.throws(() => restoreDatabase(corrupt, live), /previous database restored from the safety snapshot/);
  assert.equal(readNote(live), 'committed in WAL'); assert.equal(mode(live), 0o600);
  const snapshots = readdirSync(data).filter((f) => f.includes('.before-restore-'));
  assert.equal(snapshots.length, 1);
  const safety = join(data, snapshots[0]); verifyDatabase(safety); assert.equal(mode(safety), 0o600);
  assert.equal(readdirSync(data).filter((f) => f.startsWith('.reading')).length, 0);
});

test('backup and restore reject symlink and hard-linked paths without changing unrelated files', (t) => {
  const { root, live, db } = fixture(t); db.close();
  const elsewhere = join(root, 'elsewhere'); writeFileSync(elsewhere, 'untouched', { mode: 0o644 });
  // Establish the permissive target regardless of the caller's umask: this
  // assertion must still catch an accidental chmod through either alias.
  chmodSync(elsewhere, 0o644);
  const backups = join(root, 'backups'); mkdirSync(backups);
  const output = join(backups, 'reading.sqlite'); symlinkSync(elsewhere, output);
  assert.throws(() => backupDatabase(live, output), /already exists/);
  assert.throws(() => restoreDatabase(output, live), /regular, unlinked file/);
  const hard = join(root, 'hard.sqlite'); linkSync(elsewhere, hard);
  assert.throws(() => restoreDatabase(hard, live), /regular, unlinked file/);
  const alias = join(root, 'directory-alias'); symlinkSync(backups, alias);
  assert.throws(() => backupDatabase(live, join(alias, 'new.sqlite')), /real directory, not a symlink/);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched'); assert.equal(mode(elsewhere), 0o644);
  assert.equal(existsSync(join(backups, 'new.sqlite')), false);
});

test('private directory guard refuses shared roots and systemd grants write access only to state paths', () => {
  assert.throws(() => privateDirectory(tmpdir()), /dedicated app directory/);
  for (const name of ['reading-memory.service', 'reading-memory-backup.service']) {
    const unit = readFileSync(new URL(`../systemd/${name}`, import.meta.url), 'utf8');
    assert.match(unit, /^UMask=0077$/m);
    const paths = /^ReadWritePaths=(.+)$/m.exec(unit)[1].split(' ');
    assert.deepEqual(paths, ['%h/.reading-api', '%h/backups/reading-memory']);
    assert.ok(!paths.includes('%h/reading-memory'));
  }
});


test('portable backup and restore wrappers operate with mocked service commands only', (t) => {
  const { root, live, db } = fixture(t); db.close();
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const command of ['systemctl', 'launchctl']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  const backupDir = join(root, 'backups with spaces');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, READING_API_DB: live,
    READING_API_BACKUP_DIR: backupDir, READING_API_ENV_FILE: join(root, 'missing-env') };
  const backedUp = spawnSync('bash', [fileURLToPath(new URL('./backup-sqlite.sh', import.meta.url))], { env, encoding: 'utf8' });
  assert.equal(backedUp.status, 0, backedUp.stderr);
  const backup = join(backupDir, readdirSync(backupDir).find((f) => f.endsWith('.sqlite')));
  const restored = spawnSync('bash', [fileURLToPath(new URL('./restore-from-backup.sh', import.meta.url)), backup], { env, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readNote(live), 'committed in WAL'); assert.equal(mode(live), 0o600);
  assert.equal(mode(backup), 0o600); assert.equal(mode(backupDir), 0o700);
});


test('restore recovers committed WAL when replacement rename fails after sidecar removal', (t) => {
  const { root, live, db } = fixture(t);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
  const backup = join(root, 'backups', 'reading.sqlite'); backupDatabase(live, backup);
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE notes SET text = 'new committed WAL'");
    process.kill(process.pid, 'SIGKILL');
  `, live], { encoding: 'utf8' });
  assert.equal(interrupted.signal, 'SIGKILL');
  assert.ok(statSync(live + '-wal').size > 0);

  const originalRename = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = (...args) => {
      if (++calls === 1) throw Object.assign(new Error('simulated rename I/O error'), { code: 'EIO' });
      return originalRename(...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => restoreDatabase(backup, live), (error) => {
      assert.match(error.message, /previous database restored from the safety snapshot/);
      assert.equal(error.code, 'EIO'); assert.notEqual(error.exitCode, 2);
      return true;
    });
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(calls, 2, 'a failed replacement must still attempt atomic rollback');
  assert.equal(readNote(live), 'new committed WAL');
  assert.equal(mode(live), 0o600);
  assert.equal(readdirSync(join(root, 'data')).filter((file) => file.startsWith('.reading')).length, 0);
});

test('ancestor aliases cannot bypass the guard against chmodding the current directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reading-ancestor-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real'); const shared = join(real, 'shared');
  mkdirSync(shared, { recursive: true }); chmodSync(shared, 0o755);
  const alias = join(root, 'alias'); symlinkSync(real, alias);
  const previousCwd = process.cwd();
  try {
    process.chdir(shared);
    assert.throws(() => privateDirectory(shared), /dedicated app directory/);
    assert.throws(() => privateDirectory(join(alias, 'shared')), /dedicated app directory/);
    assert.equal(mode(shared), 0o755);
  } finally { process.chdir(previousCwd); }
});
