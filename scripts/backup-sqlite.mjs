import { closeSync, existsSync, fsyncSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertAbsent, privateDatabasePath, privateDirectory, privateFile } from './private-files.mjs';

export function verifyDatabase(path) {
  privateFile(path);
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = backup.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error(`Database integrity check failed: ${path}`);
  } finally { backup.close(); }
}

export function backupDatabase(dbPath, outPath) {
  const previousUmask = process.umask(0o077);
  let temporary;
  try {
    if (!existsSync(dbPath)) throw new Error(`SQLite database does not exist: ${dbPath}`);
    const sourcePath = privateDatabasePath(dbPath);
    const directory = privateDirectory(dirname(resolve(outPath)));
    const destination = join(directory, basename(outPath));
    assertAbsent(destination);
    temporary = join(directory, `.reading-backup-${randomUUID()}.sqlite`);
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout = 5000');
      source.exec(`VACUUM INTO ${sqlString(temporary)}`);
    } finally { source.close(); }
    privateFile(temporary);
    verifyDatabase(temporary);
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // A same-directory hard link publishes the completed snapshot exclusively;
    // an existing destination (including a symlink) can never be overwritten.
    linkSync(temporary, destination);
    unlinkSync(temporary); temporary = undefined;
    return { ok: true, source: sourcePath, destination, size_bytes: statSync(destination).size, integrity: 'ok' };
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    process.umask(previousUmask);
  }
}

function sqlString(value) { return `'${value.replaceAll("'", "''")}'`; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dbPath, outPath] = process.argv.slice(2);
  if (!dbPath || !outPath) throw new Error('Usage: backup-sqlite.mjs <db-path> <out-path>');
  console.log(JSON.stringify(backupDatabase(dbPath, outPath)));
}
