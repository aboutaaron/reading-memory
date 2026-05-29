import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, outPath] = process.argv.slice(2);

if (!dbPath || !outPath) {
  throw new Error('Usage: backup-sqlite.mjs <db-path> <out-path>');
}

if (!existsSync(dbPath)) {
  throw new Error(`SQLite database does not exist: ${dbPath}`);
}

mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(outPath), 0o700);

const source = new DatabaseSync(dbPath);
source.exec(`VACUUM INTO ${sqlString(outPath)}`);
source.close();
chmodSync(outPath, 0o600);

const backup = new DatabaseSync(outPath, { readOnly: true });
const row = backup.prepare('PRAGMA integrity_check').get();
backup.close();

if (!row || Object.values(row)[0] !== 'ok') {
  throw new Error(`Backup integrity check failed for ${outPath}`);
}

console.log(JSON.stringify({
  ok: true,
  source: dbPath,
  destination: outPath,
  size_bytes: statSync(outPath).size,
  integrity: 'ok'
}));

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
