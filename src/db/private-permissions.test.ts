import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './connection.js';

const mode = (path: string) => statSync(path).mode & 0o777;

test('direct database opens create private data directories, database, and WAL sidecars under a permissive umask', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reading-private-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);
  const before = process.umask(0o022);
  try {
    const path = join(root, 'data', 'reading.sqlite');
    const db = openDatabase(path);
    try {
      db.exec("CREATE TABLE private_wal_probe (value TEXT); INSERT INTO private_wal_probe VALUES ('test')");
      assert.equal(mode(join(root, 'data')), 0o700);
      assert.equal(mode(path), 0o600);
      assert.equal(mode(path + '-wal'), 0o600);
      assert.equal(mode(path + '-shm'), 0o600);
      assert.equal(mode(root), 0o755, 'an existing ancestor is not chmodded');
    } finally { db.close(); }
    chmodSync(path, 0o644); chmodSync(join(root, 'data'), 0o755);
    const reopened = openDatabase(path);
    try { assert.equal(mode(path), 0o600); assert.equal(mode(join(root, 'data')), 0o700); }
    finally { reopened.close(); }
  } finally { process.umask(before); }
});

test('database and sidecar symlinks are rejected without touching their targets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reading-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside'); writeFileSync(outside, 'untouched', { mode: 0o644 });
  // A requested creation mode is filtered by umask. Keep this target explicitly
  // permissive so an accidental chmod through a symlink remains detectable.
  chmodSync(outside, 0o644);
  const dbPath = join(root, 'reading.sqlite');
  symlinkSync(outside, dbPath);
  assert.throws(() => openDatabase(dbPath), /regular, unlinked file/);
  assert.equal(mode(outside), 0o644);
  rmSync(dbPath);
  symlinkSync(outside, dbPath + '-wal');
  assert.throws(() => openDatabase(dbPath), /regular, unlinked file/);
  assert.equal(mode(outside), 0o644);
});
