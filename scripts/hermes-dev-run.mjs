#!/usr/bin/env node
// Hermes cron --no-agent bridge. The run contract is the only work selector.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tick } from './lib/dev-manager.mjs';
import { openDatabase, rootFor } from './lib/dev-state.mjs';

export function noticeFor(state) {
  if (!['blocked', 'paused', 'cancelled'].includes(state.control) && state.phase !== 'ready') return null;
  return {
    task: state.id,
    objective: state.contract.objective,
    phase: state.phase,
    control: state.control,
    blocker: state.blocker,
    next_action: state.next_action,
    candidate: state.candidate,
    pr: state.pr?.url ?? null,
    tests: state.tests,
    review: state.review,
    ci: state.ci?.candidate ?? null,
  };
}

export function claimNotice(run, notice) {
  if (!notice) return false;
  const db = openDatabase(rootFor(run));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS hermes_notices (run TEXT PRIMARY KEY, notice TEXT NOT NULL)');
    const value = JSON.stringify(notice);
    const old = db.prepare('SELECT notice FROM hermes_notices WHERE run=?').get(resolve(run));
    if (old?.notice === value) { db.exec('COMMIT'); return false; }
    db.prepare('INSERT INTO hermes_notices VALUES(?,?) ON CONFLICT(run) DO UPDATE SET notice=excluded.notice').run(resolve(run), value);
    db.exec('COMMIT');
    return true;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--run') throw new Error('Usage: hermes-dev-run --run ABSOLUTE_RUN_DIRECTORY');
    const run = resolve(process.argv[3]);
    const state = await tick(run);
    const notice = noticeFor(state);
    if (claimNotice(run, notice)) console.log(JSON.stringify(notice, null, 2));
  } catch (error) {
    console.error(`Development coordinator failed: ${error.message}`);
    process.exitCode = 1;
  }
}
