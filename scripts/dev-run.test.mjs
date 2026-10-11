// These are simulated coding/GitHub adapters with real SQLite, Git and processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { assign, tick, status } from './lib/dev-manager.mjs';
import { command, git, openDatabase, rootFor, getAttempt, getState, saveState, saveAttempt, validateContract } from './lib/dev-state.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-run-test-'));
  const repo = join(dir, 'repo'), remote = join(dir, 'remote.git'), root = join(dir, 'runs');
  mkdirSync(repo); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(join(repo, 'target.txt'), '0\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(dir, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main');
  const launches = join(dir, 'launches.jsonl'), pr = join(dir, 'pr.json'), creates = join(dir, 'creates');
  const codex = join(dir, 'codex-fixture');
  writeFileSync(codex, `#!${process.execPath}\nimport fs from 'node:fs';\nimport {execFileSync} from 'node:child_process';
    const kind=process.env.DEV_RUN_KIND;
    fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({kind,id:process.env.DEV_RUN_ATTEMPT})+'\\n');
    await new Promise(r=>setTimeout(r,${options.slow ?? 150}));
    if(kind!=='review')fs.writeFileSync('target.txt',kind==='repair'?'2\\n':'1\\n');
    const findings=kind==='review'&&fs.readFileSync('target.txt','utf8').trim()==='1'?['Change target to 2 to meet review acceptance']:[];
    fs.writeFileSync(process.env.DEV_RUN_OUTPUT,JSON.stringify({summary:'fixture result',candidate:process.env.DEV_RUN_CANDIDATE,approved:kind==='review'&&!findings.length,findings}));
    console.log(JSON.stringify({type:'thread.started',thread_id:process.env.DEV_RUN_ATTEMPT}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));`, { mode: 0o700 });
  const gh = join(dir, 'gh-fixture');
  writeFileSync(gh, `#!${process.execPath}\nimport fs from 'node:fs';
    import {execFileSync} from 'node:child_process';
    const args=process.argv.slice(2),file=${JSON.stringify(pr)};
    let pr=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
    if(args[1]==='list')console.log(JSON.stringify(pr?[pr]:[]));
    else if(args[1]==='view')console.log(JSON.stringify(pr));
    else if(args[1]==='create'){
      fs.appendFileSync(${JSON.stringify(creates)},'create\\n');
      pr={url:'https://github.com/fixture/repo/pull/1',state:'OPEN',body:fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8'),headRefOid:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),isDraft:true,statusCheckRollup:[{name:'fixture-ci',status:'COMPLETED',conclusion:'SUCCESS'}]};
      fs.writeFileSync(file,JSON.stringify(pr));
      ${options.ambiguousCreate ? "process.exit(1);" : "console.log(pr.url);"}
    }else if(args[1]==='ready'){pr.isDraft=false;fs.writeFileSync(file,JSON.stringify(pr));}
    else process.exit(2);`, { mode: 0o700 });
  const contract = { version: 1, id: `trial-${Math.random().toString(36).slice(2, 10)}`, approved: true, objective: 'Improve fixture target', acceptance: ['Target is reviewed and tested'], constraints: ['No corpus access'], scope: ['target.txt'], repository: repo, github: 'fixture/repo', base: 'main', tests: [[process.execPath, '-e', 'if(!["1","2"].includes(require("fs").readFileSync("target.txt","utf8").trim()))process.exit(1)']], authority: { push: true, pull_request: true }, required_checks: ['fixture-ci'], budgets: { attempts: 12, wall_seconds: 300, worker_seconds: 30, tokens: 10000 }, codex, gh };
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return { dir, repo, root, contract, launches, pr, creates };
}
async function until(run, predicate, maximum = 250) {
  for (let n = 0; n < maximum; n++) {
    const state = await tick(run);
    if (predicate(state)) return state;
    if (state.control === 'blocked') assert.fail(state.blocker);
    await delay(100);
  }
  assert.fail('workflow did not reach expected state');
}
function attempt(run, id) { const db = openDatabase(rootFor(run)); try { return getAttempt(db, id); } finally { db.close(); } }
function mutate(run, fn) { const db = openDatabase(rootFor(run)); try { db.exec('BEGIN IMMEDIATE'); const s = getState(db, run); fn(s, db); saveState(db, s); db.exec('COMMIT'); return s; } finally { db.close(); } }

test('simulated end-to-end: killed manager, fresh process, separate review repair and ambiguous PR response', { timeout: 60000 }, async t => {
  const f = fixture(t, { ambiguousCreate: true, slow: 400 });
  const s = await assign(f.contract, f.root);
  const manager = spawn(process.execPath, [resolve('scripts/dev-run.mjs'), 'run', '--run', s.run_dir], { stdio: 'ignore' });
  for (let n = 0; n < 100 && !existsSync(f.launches); n++) await delay(50);
  assert.ok(existsSync(f.launches), 'implementation began before interrupt');
  manager.kill('SIGKILL'); await new Promise(r => manager.once('exit', r));
  const interrupted = status(s.run_dir); assert.equal(interrupted.phase, 'implementing');
  assert.equal(interrupted.attempts.length, 1);
  // A fresh CLI process reconciles persisted worker/Git state, no chat context.
  const recovered = JSON.parse(command(process.execPath, [resolve('scripts/dev-run.mjs'), 'tick', '--run', s.run_dir]));
  assert.equal(recovered.state.id, s.id);
  const done = await until(s.run_dir, state => state.phase === 'ready');
  assert.equal(done.tests.candidate, done.candidate); assert.equal(done.review.candidate, done.candidate); assert.equal(done.ci.candidate, done.candidate);
  assert.equal(readFileSync(join(done.worktree, 'target.txt'), 'utf8'), '2\n');
  const launches = readFileSync(f.launches, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(launches.map(l => l.kind), ['implement', 'review', 'repair', 'review']);
  assert.equal(new Set(launches.map(l => l.id)).size, launches.length);
  assert.equal(readFileSync(f.creates, 'utf8'), 'create\n');
  const before = done.attempts.length;
  assert.equal((await tick(s.run_dir)).attempts.length, before, 'ready retries do not replay actions');
});

test('simulated contention: two managers, pause drains, resume reuses worker', { timeout: 30000 }, async t => {
  const f = fixture(t, { slow: 1500 }); const s = await assign(f.contract, f.root);
  const invoke = () => new Promise((done, reject) => {
    const p = spawn(process.execPath, [resolve('scripts/dev-run.mjs'), 'tick', '--run', s.run_dir], { stdio: 'ignore' });
    p.once('exit', code => code === 0 ? done() : reject(new Error('tick failed')));
  });
  await Promise.all([invoke(), invoke()]);
  assert.equal(status(s.run_dir).attempts.length, 1, JSON.stringify(status(s.run_dir)));
  for (let n = 0; n < 100 && !existsSync(f.launches); n++) await delay(50);
  const paused = await tick(s.run_dir, 'pause'); assert.equal(paused.control, 'paused');
  await delay(3500);
  assert.equal((await tick(s.run_dir)).attempts.length, 1);
  assert.equal(readFileSync(f.launches, 'utf8').trim().split('\n').length, 1);
  await tick(s.run_dir, 'resume');
  assert.equal(status(s.run_dir).phase, 'testing');
});

test('contract authorization, operational boundary, deadline and required check gates fail closed', { timeout: 30000 }, async t => {
  const f = fixture(t);
  assert.throws(() => validateContract({ ...f.contract, approved: false }), /approved/);
  assert.throws(() => validateContract({ ...f.contract, required_checks: [] }), /required_checks/);
  assert.throws(() => validateContract({ ...f.contract, authority: { ...f.contract.authority, merge: true } }), /merging/);
  await assert.rejects(assign(f.contract, join(f.repo, 'not-yet-created')), /outside a Git checkout/);
  const s = await assign(f.contract, f.root);
  const db = openDatabase(rootFor(s.run_dir));
  db.exec('BEGIN IMMEDIATE'); const expired = getState(db, s.run_dir); expired.deadline = Date.now() - 1; saveState(db, expired); db.exec('COMMIT'); db.close();
  const stopped = await tick(s.run_dir); assert.equal(stopped.control, 'blocked'); assert.equal(stopped.attempts.length, 0);
});

test('cancel terminates a verified active supervisor and does not relaunch', { timeout: 20000 }, async t => {
  const f = fixture(t, { slow: 10000 }); const s = await assign(f.contract, f.root); const started = await tick(s.run_dir);
  for (let n = 0; n < 100 && !existsSync(f.launches); n++) await delay(50);
  assert.ok(existsSync(f.launches));
  const cancelling = await tick(s.run_dir, 'cancel'); assert.equal(cancelling.control, 'cancelling');
  const cancelled = await until(s.run_dir, x => x.phase === 'cancelled');
  assert.equal(cancelled.attempts.length, 1); assert.equal(attempt(s.run_dir, started.attempt).status, 'finished');
  assert.equal((await tick(s.run_dir, 'resume')).phase, 'cancelled');
});

test('crash after commit and interrupted review worktree creation reconcile without repeated implementation', { timeout: 20000 }, async t => {
  const f = fixture(t); const s = await assign(f.contract, f.root); const started = await tick(s.run_dir);
  for (let n = 0; n < 100 && attempt(s.run_dir, started.attempt).status !== 'finished'; n++) await delay(50);
  git(started.worktree, 'add', '--all'); git(started.worktree, 'commit', '-m', `${s.contract.objective.slice(0, 100)} [${s.id}]`);
  const committed = git(started.worktree, 'rev-parse', 'HEAD');
  assert.equal((await tick(s.run_dir)).candidate, committed);
  const reviewing = await until(s.run_dir, x => x.phase === 'reviewing');
  const directory = join(s.run_dir, 'attempts', `${s.id}-${String(reviewing.attempts.length + 1).padStart(3, '0')}-review`);
  mkdirSync(directory, { recursive: true }); git(f.repo, 'worktree', 'add', '--detach', join(directory, 'review'), committed);
  const reviewStarted = await tick(s.run_dir); assert.equal(reviewStarted.control, 'active');
  await until(s.run_dir, x => x.phase === 'repairing');
  const db = openDatabase(rootFor(s.run_dir)); db.prepare('DELETE FROM runs WHERE id=?').run(s.id); db.close();
  writeFileSync(join(s.run_dir, 'state.json'), '{}');
  assert.equal(status(s.run_dir).phase, 'repairing', 'rebuild reads authoritative transition history');
  const same = await assign(f.contract, f.root); assert.equal(same.id, s.id);
  await assert.rejects(assign({ ...f.contract, objective: 'different' }, f.root), /different contract/);
});

test('required CI and final ready reconciliation reject missing, skipped, failing and different-SHA checks', { timeout: 20000 }, async t => {
  const f = fixture(t); const s = await assign(f.contract, f.root);
  const atCI = await until(s.run_dir, x => x.phase === 'ci');
  const original = JSON.parse(readFileSync(f.pr, 'utf8'));
  for (const [checks, expected] of [[[], 'active'], [[{ name: 'fixture-ci', status: 'COMPLETED', conclusion: 'SKIPPED' }], 'blocked'], [[{ name: 'fixture-ci', status: 'COMPLETED', conclusion: 'FAILURE' }], 'blocked']]) {
    mutate(s.run_dir, x => { x.phase = 'ci'; x.control = 'active'; });
    writeFileSync(f.pr, JSON.stringify({ ...original, statusCheckRollup: checks }));
    assert.equal((await tick(s.run_dir)).control, expected);
    assert.equal(status(s.run_dir).phase, 'ci');
  }
  mutate(s.run_dir, x => { x.phase = 'ci'; x.control = 'active'; });
  writeFileSync(f.pr, JSON.stringify({ ...original, headRefOid: s.base_commit }));
  assert.match((await tick(s.run_dir)).blocker, /head drifted/);
  // A non-draft PR cannot turn an ambiguous ready failure into success if CI failed.
  mutate(s.run_dir, (x, db) => { x.phase = 'readying'; x.control = 'active'; x.attempt = `${s.id}-synthetic-ready`; saveAttempt(db, { id: x.attempt, run_id: s.id, kind: 'ready', status: 'finished', tokens: 0, result: { ok: false } }); });
  writeFileSync(f.pr, JSON.stringify({ ...original, isDraft: false, statusCheckRollup: [{ name: 'fixture-ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
  assert.equal((await tick(s.run_dir)).control, 'blocked');
  assert.notEqual(status(s.run_dir).phase, 'ready');
  // New local changes invalidate old review/test evidence before any publication.
  mutate(s.run_dir, x => { x.phase = 'publishing'; x.control = 'active'; x.attempt = null; });
  writeFileSync(join(atCI.worktree, 'target.txt'), '3\n');
  assert.match((await tick(s.run_dir)).blocker, /drifted/);
});

test('paused reserved supervisor, uncertain lost identity and exhausted budgets never launch another worker', { timeout: 10000 }, async t => {
  const f = fixture(t); const s = await assign(f.contract, f.root); const id = `${s.id}-reserved`;
  mutate(s.run_dir, (x, db) => { x.control = 'paused'; x.attempt = id; x.attempts = [id]; saveAttempt(db, { id, run_id: s.id, status: 'reserved' }); });
  command(process.execPath, [resolve('scripts/lib/dev-supervisor.mjs'), s.run_dir, id]);
  assert.equal(attempt(s.run_dir, id).status, 'reserved'); assert.equal(existsSync(f.launches), false);
  mutate(s.run_dir, (x, db) => { x.control = 'active'; saveAttempt(db, { id, run_id: s.id, status: 'running', pid: process.pid, identity: 'not-this-process' }); });
  assert.match((await tick(s.run_dir)).blocker, /identity lost/);
  assert.match((await tick(s.run_dir, 'resume')).blocker, /identity lost/);
  mutate(s.run_dir, x => { x.control = 'active'; x.attempt = null; x.tokens = x.contract.budgets.tokens; });
  assert.match((await tick(s.run_dir)).blocker, /token budget/);
  mutate(s.run_dir, x => { x.control = 'active'; x.tokens = 0; x.phase = 'implementing'; x.attempts = Array(x.contract.budgets.attempts).fill('used'); });
  assert.match((await tick(s.run_dir)).blocker, /Attempt budget/);
});

test('foreign remote branch is never pushed over before PR ownership reconciliation', { timeout: 20000 }, async t => {
  const f = fixture(t); const s = await assign(f.contract, f.root);
  const publishing = await until(s.run_dir, x => x.phase === 'publishing');
  git(f.repo, 'push', 'origin', `${s.base_commit}:refs/heads/${s.branch}`);
  await tick(s.run_dir);
  let stopped;
  for (let n = 0; n < 150; n++) { stopped = await tick(s.run_dir); if (stopped.control === 'blocked') break; await delay(50); }
  assert.equal(stopped.control, 'blocked');
  assert.equal(git(f.repo, 'ls-remote', '--heads', 'origin', `refs/heads/${s.branch}`).split(/\s/)[0], s.base_commit);
  assert.equal(existsSync(f.creates), false); assert.notEqual(publishing.candidate, s.base_commit);
});
