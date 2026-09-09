import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

function owned(stats, path) {
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Refusing path owned by another user: ${path}`);
  }
}

function entry(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Only the dedicated leaf directory is tightened; existing ancestors are untouched. */
export function privateDirectory(path) {
  const absolute = resolve(path);
  const reservedPaths = [parse(absolute).root, homedir(), tmpdir(), process.cwd()];
  if (reservedPaths.some((reserved) => absolute === resolve(reserved))) {
    throw new Error(`Choose a dedicated app directory instead of a shared location: ${absolute}`);
  }
  const existing = entry(absolute);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Expected a real directory, not a symlink: ${absolute}`);
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  // Resolve platform ancestor aliases (e.g. macOS /var) once; later writes use
  // this canonical directory instead of following an alias again.
  const canonical = realpathSync(absolute);
  if (reservedPaths.some((reserved) => canonical === realpathSync(resolve(reserved)))) {
    throw new Error(`Choose a dedicated app directory instead of a shared location: ${canonical}`);
  }
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd); owned(stats, canonical);
    if (!stats.isDirectory()) throw new Error(`Expected a directory: ${canonical}`);
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  return canonical;
}

/** Never chmod through a symlink or change another name for a hard-linked file. */
export function privateFile(path, { create = false, optional = false } = {}) {
  const existing = entry(path);
  if (!existing && !create && optional) return false;
  if (!existing && !create) throw new Error(`File does not exist: ${path}`);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Expected a regular, unlinked file: ${path}`);
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (!existing && create ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    const stats = fstatSync(fd); owned(stats, path);
    if (!stats.isFile() || stats.nlink !== 1) throw new Error(`Expected a regular, unlinked file: ${path}`);
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  return true;
}

export function privateDatabasePath(path, { create = false } = {}) {
  const absolute = resolve(path);
  const parent = privateDirectory(dirname(absolute));
  const canonical = join(parent, parse(absolute).base);
  // Check all sidecars before SQLite can follow them. SQLite copies the main
  // file's private mode when it later creates fresh WAL/SHM/journal files.
  for (const suffix of ['-wal', '-shm', '-journal']) privateFile(canonical + suffix, { optional: true });
  privateFile(canonical, { create, optional: !create });
  return canonical;
}

export function assertAbsent(path) {
  if (entry(path)) throw new Error(`Destination already exists: ${path}`);
}
