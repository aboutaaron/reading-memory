import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from './backup-sqlite.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'reading-backup-durability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const source = join(data, 'reading.sqlite');
  const db = new DatabaseSync(source);
  try { db.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('durable snapshot')"); }
  finally { db.close(); }
  const destination = join(root, 'backups', 'reading.sqlite');
  return { source, destination, directory: dirname(destination) };
}

function tracePublication({ destination, directory }, failAt, run) {
  const originals = Object.fromEntries(['openSync', 'fsyncSync', 'closeSync', 'linkSync', 'unlinkSync'].map((name) => [name, fs[name]]));
  const events = [];
  const paths = new Map();
  const failure = Object.assign(new Error(`simulated directory ${failAt} failure`), { code: 'EIO' });
  let published = false;
  let directoryFd;
  const record = (event) => {
    events.push(event);
    if (event === failAt) throw failure;
  };
  try {
    fs.openSync = (path, ...args) => {
      const publicationDirectory = published && path === directory;
      if (publicationDirectory) record('open-directory');
      const fd = originals.openSync(path, ...args);
      paths.set(fd, path);
      if (publicationDirectory) directoryFd = fd;
      return fd;
    };
    fs.fsyncSync = (fd) => {
      if (fd === directoryFd) record('sync-directory');
      else {
        assert.equal(dirname(paths.get(fd)), directory);
        assert.match(basename(paths.get(fd)), /^\.reading-backup-/);
        record('sync-snapshot');
      }
      return originals.fsyncSync(fd);
    };
    fs.closeSync = (fd) => {
      const result = originals.closeSync(fd);
      paths.delete(fd);
      if (fd === directoryFd) record('close-directory');
      return result;
    };
    fs.linkSync = (source, target) => {
      const result = originals.linkSync(source, target);
      if (target === destination) { published = true; record('publish'); }
      return result;
    };
    fs.unlinkSync = (path) => {
      const result = originals.unlinkSync(path);
      if (published && dirname(path) === directory && basename(path).startsWith('.reading-backup-')) record('remove-temporary');
      return result;
    };
    syncBuiltinESMExports();
    run({ events, failure });
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

test('backup syncs the snapshot before publication and its directory after both name changes', (t) => {
  const paths = fixture(t);
  tracePublication(paths, undefined, ({ events }) => {
    const result = backupDatabase(paths.source, paths.destination);
    assert.equal(result.ok, true);
    assert.deepEqual(events, ['sync-snapshot', 'publish', 'remove-temporary', 'open-directory', 'sync-directory', 'close-directory']);
  });
  assert.deepEqual(fs.readdirSync(paths.directory), ['reading.sqlite']);
  const backup = new DatabaseSync(paths.destination, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT text FROM notes').get().text, 'durable snapshot'); }
  finally { backup.close(); }
});

for (const failAt of ['open-directory', 'sync-directory']) {
  test(`backup reports ${failAt} failure instead of acknowledging an unconfirmed durable backup`, (t) => {
    const paths = fixture(t);
    const previousUmask = process.umask(0o022);
    try {
      tracePublication(paths, failAt, ({ events, failure }) => {
        assert.throws(() => backupDatabase(paths.source, paths.destination), (error) => error === failure);
        assert.deepEqual(events, [
          'sync-snapshot', 'publish', 'remove-temporary', 'open-directory',
          ...(failAt === 'sync-directory' ? ['sync-directory', 'close-directory'] : []),
        ]);
        assert.equal(process.umask(), 0o022);
      });
    } finally { process.umask(previousUmask); }
    // A publication failure must leave the completed snapshot intact, with no
    // temporary name left behind and no misleading success result.
    assert.deepEqual(fs.readdirSync(paths.directory), ['reading.sqlite']);
    const backup = new DatabaseSync(paths.destination, { readOnly: true });
    try { assert.equal(backup.prepare('SELECT text FROM notes').get().text, 'durable snapshot'); }
    finally { backup.close(); }
  });
}
