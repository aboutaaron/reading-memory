import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}
export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function command(exe, args, cwd, options = {}) {
  return execFileSync(exe, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options }).trimEnd();
}
export function git(cwd, ...args) { return command('git', args, cwd); }
export function openDatabase(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'coordination.sqlite');
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=35000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, directory TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transitions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL);`);
  return db;
}
export function rootFor(run) { return resolve(run, '../..'); }
export function getState(db, run) {
  // The append-only transition history is authoritative; runs/state.json are views.
  const row = db.prepare("SELECT snapshot FROM transitions WHERE json_extract(snapshot,'$.run_dir')=? ORDER BY sequence DESC LIMIT 1").get(resolve(run));
  if (!row) throw new Error('Unknown run; use its original durable directory');
  return JSON.parse(row.snapshot);
}
export function saveState(db, state) {
  state.version = 1;
  state.checkpoint = (state.checkpoint ?? 0) + 1;
  state.updated_at = new Date().toISOString();
  const value = JSON.stringify(state);
  db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(state.id, state.run_dir, value);
  db.prepare('INSERT INTO transitions(run_id,at,snapshot) VALUES(?,?,?)').run(state.id, state.updated_at, value);
}
export function getAttempt(db, id) {
  const row = db.prepare('SELECT record FROM attempts WHERE id=?').get(id);
  return row ? JSON.parse(row.record) : null;
}
export function saveAttempt(db, a) {
  db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(a.id, a.run_id, JSON.stringify(a));
}
export function processIdentity(pid) {
  try { return command('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command=']); } catch { return null; }
}
export function processMatches(a) { return a.pid && a.identity && processIdentity(a.pid) === a.identity; }
export function validateContract(c) {
  if (!c || c.version !== 1 || c.approved !== true || !/^[a-z][a-z0-9-]{2,60}$/.test(c.id ?? '')) throw new Error('version:1, explicit approved:true and a lowercase task id are required');
  for (const field of ['objective', 'repository', 'github', 'base']) if (typeof c[field] !== 'string' || !c[field].trim()) throw new Error(`${field} is required`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(c.github)) throw new Error('github must be owner/repository');
  for (const field of ['acceptance', 'scope', 'constraints']) if (!Array.isArray(c[field]) || !c[field].every(x => typeof x === 'string' && x.length > 0 && x.length <= 2000) || (field !== 'constraints' && !c[field].length)) throw new Error(`${field} must be a bounded string array`);
  if (c.scope.some(p => p.startsWith('/') || p.split('/').includes('..') || p === '.')) throw new Error('scope must list repository-relative files or directory prefixes ending in /');
  if (!Array.isArray(c.tests) || !c.tests.length || c.tests.some(t => !Array.isArray(t) || !t.length || t.some(x => typeof x !== 'string'))) throw new Error('tests must contain executable argv arrays');
  if (c.authority?.push !== true || c.authority?.pull_request !== true) throw new Error('Explicit push and pull_request authority is required');
  if (Object.keys(c.authority).some(key => !['push', 'pull_request'].includes(key))) throw new Error('Only push and pull_request authority is supported; merging and deployment are excluded');
  if (!Array.isArray(c.required_checks) || !c.required_checks.length || c.required_checks.some(x => typeof x !== 'string' || !x.trim())) throw new Error('required_checks must name every required GitHub CI check');
  const limits = { attempts: [3, 30], wall_seconds: [60, 86400], worker_seconds: [10, 7200], tokens: [1000, 10000000] };
  for (const [key, [min, max]] of Object.entries(limits)) if (!Number.isInteger(c.budgets?.[key]) || c.budgets[key] < min || c.budgets[key] > max) throw new Error(`budgets.${key} must be ${min}..${max}`);
  c.repository = resolve(c.repository);
  return c;
}
