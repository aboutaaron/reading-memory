import { closeSync, constants, copyFileSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { backupDatabase, verifyDatabase } from './backup-sqlite.mjs';
import { privateDatabasePath, privateFile } from './private-files.mjs';

/** The runner must be stopped by the caller before replacing its SQLite file. */
export function restoreDatabase(backupPath, dbPath) {
  const previousUmask = process.umask(0o077);
  let temporary;
  const temporaryFiles = new Set();
  let safety = null;
  let destructive = false;
  let target;
  try {
    privateFile(backupPath);
    target = privateDatabasePath(dbPath);
    if (resolve(backupPath) === target) throw new Error('Backup and live database must be different files');
    if (existsSync(target)) {
      safety = `${target}.before-restore-${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
      backupDatabase(target, safety);
    }
    temporary = privateCopy(backupPath, dirname(target));
    temporaryFiles.add(temporary);
    // Removing the WAL can discard committed data even if replacement fails.
    // From this point onward, recover the complete safety snapshot on any error.
    destructive = true;
    clearSidecars(target);
    renameSync(temporary, target); temporaryFiles.delete(temporary); temporary = undefined;
    verifyDatabase(target);
    return { ok: true, source: resolve(backupPath), destination: target, safety_snapshot: safety, integrity: 'ok' };
  } catch (error) {
    // A failed pre-replacement step may reflect a corrupt live database. Only
    // permit the wrapper to restart a database whose integrity we can verify.
    if (!destructive) {
      try {
        if (!target || !existsSync(target)) throw new Error('No verified live database');
        verifyDatabase(target);
      } catch { error.exitCode = 2; }
    }
    if (destructive) {
      if (!safety) {
        error.exitCode = 2; // No recoverable previous database: keep runner stopped.
      } else {
        try {
          temporary = privateCopy(safety, dirname(target));
          temporaryFiles.add(temporary);
          clearSidecars(target);
          renameSync(temporary, target); temporaryFiles.delete(temporary); temporary = undefined;
          verifyDatabase(target);
          error.message += '; previous database restored from the safety snapshot';
        } catch (rollbackError) {
          error = new Error(`Restore and rollback failed; leave service stopped. Safety snapshot: ${safety}`, { cause: rollbackError });
          error.exitCode = 2;
        }
      }
    }
    throw error;
  } finally {
    // Preserve the recovery status if cleanup itself fails. Leftover candidates
    // remain private and must never turn an unrecoverable failure into exit 1.
    for (const path of temporaryFiles) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* Best-effort private temp cleanup. */ }
    }
    process.umask(previousUmask);
  }
}

function privateCopy(source, directory) {
  const temporary = join(directory, `.reading-restore-${randomUUID()}.sqlite`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    privateFile(temporary);
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return temporary;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function clearSidecars(target) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = target + suffix;
    if (privateFile(sidecar, { optional: true })) unlinkSync(sidecar);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [backupPath, dbPath] = process.argv.slice(2);
  if (!backupPath || !dbPath) throw new Error('Usage: restore-sqlite.mjs <backup-path> <db-path>');
  try { console.log(JSON.stringify(restoreDatabase(backupPath, dbPath))); }
  catch (error) { console.error(`restore: ${error.message}`); process.exitCode = error.exitCode ?? 1; }
}
