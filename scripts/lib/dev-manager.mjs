import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunLedger, appendRunEvent, defaultRunRoot } from './run-ledger.mjs';
import { atomicJson, readJson, command, git, openDatabase, rootFor, getState, saveState, getAttempt, saveAttempt, processMatches, processIdentity, validateContract } from './dev-state.mjs';

const supervisor = fileURLToPath(new URL('./dev-supervisor.mjs', import.meta.url));
const terminal = new Set(['ready', 'cancelled']);
const phases = { implementing: 'implement', repairing: 'repair', testing: 'test', reviewing: 'review', publishing: 'publish', readying: 'ready' };

export async function assign(contract, root = defaultRunRoot()) {
  const c = validateContract(structuredClone(contract));
  root = resolve(root);
  // Operational state must never be placed in a source checkout.
  let ancestor = root; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  try { command('git', ['rev-parse', '--show-toplevel'], ancestor, { stdio: ['ignore', 'pipe', 'ignore'] }); throw new Error('Operational root must be outside a Git checkout'); }
  catch (error) { if (error.message === 'Operational root must be outside a Git checkout') throw error; }
  const baseCommit = git(c.repository, 'rev-parse', '--verify', `${c.base}^{commit}`);
  const run = join(root, 'development', c.id);
  const db = openDatabase(root);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT snapshot FROM transitions WHERE run_id=? ORDER BY sequence DESC LIMIT 1').get(c.id);
    if (existing) {
      const state = JSON.parse(existing.snapshot);
      if (JSON.stringify(state.contract) !== JSON.stringify(c)) throw new Error('Task id is already assigned with a different contract');
      db.exec('COMMIT'); return state;
    }
    if (!existsSync(run)) await createRunLedger({ root, workflow: 'development', runId: c.id, inputs: { task_id: c.id, objective: c.objective } });
    const state = { id: c.id, run_dir: run, contract: c, base_commit: baseCommit, branch: `codex/dev-${c.id}`, worktree: join(run, 'worktree'), created_at: new Date().toISOString(), deadline: Date.now() + c.budgets.wall_seconds * 1000, phase: 'assigned', control: 'active', next_action: 'create isolated worktree and dispatch implementation', attempt: null, attempts: [], tokens: 0, candidate: null, review: null, tests: null, pr: null, blocker: null, decisions: ['Only this explicitly approved contract may be executed; no backlog discovery.'] };
    saveState(db, state); db.exec('COMMIT');
    atomicJson(join(run, 'contract.json'), c);
    return state;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function prState(s) {
  const list = JSON.parse(command(s.contract.gh ?? 'gh', ['pr', 'list', '--repo', s.contract.github, '--head', s.branch, '--state', 'all', '--json', 'url,state,body,headRefOid,isDraft,statusCheckRollup'], s.worktree));
  if (list.length > 1 || list.some(p => !p.body.includes(marker(s)) || p.state !== 'OPEN')) throw new Error('PR identity conflict or PR no longer open');
  return list[0] ?? null;
}
function marker(s) { return `<!-- reading-memory-development:${s.id} -->`; }
function successfulChecks(s, remote) {
  return s.contract.required_checks.every(name => (remote.statusCheckRollup ?? []).some(c => (c.name ?? c.context) === name && (!c.status || c.status === 'COMPLETED') && (c.conclusion ?? c.state) === 'SUCCESS'));
}
function block(s, reason) { s.blocker = reason; s.control = 'blocked'; s.next_action = 'inspect durable state and resolve blocker, then resume'; }
function phase(s, name, next) { s.phase = name; s.next_action = next; s.blocker = null; }
function assertCandidate(s) {
  if (git(s.worktree, 'rev-parse', 'HEAD') !== s.candidate || git(s.worktree, 'status', '--porcelain')) throw new Error('Candidate worktree drifted; refusing stale gates');
}
function collect(s) {
  const paths = git(s.worktree, 'status', '--porcelain', '-z').split('\0').filter(Boolean).map(x => x.slice(3));
  const all = [...paths, ...git(s.worktree, 'diff', '--name-only', s.base_commit, 'HEAD').split('\n').filter(Boolean)];
  if (all.some(path => !s.contract.scope.some(allowed => allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed))) throw new Error('Worker changed paths outside the approved scope');
  // Workers may not create commits; the manager alone attributes the final candidate.
  const expected = s.candidate ?? s.base_commit;
  const actual = git(s.worktree, 'rev-parse', 'HEAD');
  const message = `${s.contract.objective.slice(0, 100)} [${s.id}]`;
  if (actual !== expected && (paths.length || git(s.worktree, 'rev-parse', 'HEAD^') !== expected || git(s.worktree, 'log', '-1', '--format=%s') !== message)) throw new Error('Worker changed branch history; inspect before proceeding');
  if (paths.length) {
    git(s.worktree, 'add', '--all');
    git(s.worktree, 'commit', '-m', message);
  }
  s.candidate = git(s.worktree, 'rev-parse', 'HEAD');
  if (s.candidate === s.base_commit) throw new Error('Implementation produced no changes');
  s.tests = null; s.review = null;
  phase(s, 'testing', 'run acceptance commands against candidate commit');
}
function prompt(s, kind) {
  const task = { objective: s.contract.objective, acceptance: s.contract.acceptance, scope: s.contract.scope, constraints: s.contract.constraints };
  return `You are the ${kind === 'review' ? 'independent reviewer' : 'implementation worker'} for explicitly approved development task ${s.id}.\n${JSON.stringify(task, null, 2)}\nRead AGENTS.md and ARCHITECTURE.md. Work only in the supplied worktree. Do not push, create PRs, commit, contact others, deploy, or read/write the private corpus. The manager owns all Git history and external actions. Tools runtime PATH=${process.env.PATH}.\n${kind === 'review' ? `Independently inspect git diff ${s.base_commit}..${s.candidate}, tests and acceptance. Do not edit any files. Return candidate exactly ${s.candidate}. Set approved true only with no actionable findings; report concrete findings requiring repair otherwise.` : `Implement the bounded task, including meaningful tests. Leave changes uncommitted. Acceptance commands: ${JSON.stringify(s.contract.tests)}. ${kind === 'repair' ? `Correct these review/test findings: ${JSON.stringify(s.feedback)}. Prior attempt artifacts: ${s.feedback_artifact ?? 'none'}.` : ''} Return summary and any remaining findings; candidate may be empty, approved false.`}\nYour structured final output is private operational data; never include secrets or corpus contents.`;
}
function reserve(db, s, kind) {
  if (s.attempts.length >= s.contract.budgets.attempts) { block(s, 'Attempt budget exhausted'); return null; }
  // One active worker across all runs in this operational root.
  const active = db.prepare('SELECT record FROM attempts').all().map(row => JSON.parse(row.record)).find(a => a.run_id !== s.id && ['reserved', 'running'].includes(a.status));
  if (active) { s.next_action = `waiting for shared worker slot (${active.run_id})`; return null; }
  if (kind === 'review') {
    assertCandidate(s);
  }
  const id = `${s.id}-${String(s.attempts.length + 1).padStart(3, '0')}-${kind}`;
  const directory = join(s.run_dir, 'attempts', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const cwd = kind === 'review' ? join(directory, 'review') : s.worktree;
  if (kind === 'review') {
    if (!existsSync(cwd)) git(s.contract.repository, 'worktree', 'add', '--detach', cwd, s.candidate);
    if (git(cwd, 'rev-parse', 'HEAD') !== s.candidate || git(cwd, 'status', '--porcelain')) throw new Error('Review worktree drifted');
  }
  const a = { id, run_id: s.id, directory, kind, status: 'reserved', cwd, candidate: s.candidate, timeout_seconds: Math.max(1, Math.min(s.contract.budgets.worker_seconds, Math.floor((s.deadline - Date.now()) / 1000))), codex: s.contract.codex, gh: s.contract.gh, tests: s.contract.tests, required_checks: s.contract.required_checks, prompt: prompt(s, kind), branch: s.branch, github: s.contract.github, base: s.contract.base, marker: marker(s), objective: s.contract.objective, acceptance: s.contract.acceptance, url: s.pr?.url, reserved_at: new Date().toISOString() };
  saveAttempt(db, a); s.attempts.push(id); s.attempt = id; s.next_action = `observe ${kind} worker ${id}`;
  return a;
}
function launch(a, run) {
  // Re-spawning a reserved supervisor is safe: SQLite admits one claimant.
  const child = spawn(process.execPath, [supervisor, run, a.id], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {}); child.unref();
}
function reconcileAttempt(db, s) {
  const a = getAttempt(db, s.attempt);
  if (!a) throw new Error('Missing durable attempt record');
  if (a.status === 'reserved') return a;
  if (a.status === 'running') {
    if (!processMatches(a)) {
      // A child may still be alive after its supervisor dies. Never replay it.
      block(s, `Supervisor identity lost for ${a.id}; outcome uncertain. Inspect its process group and artifacts. No replacement worker will launch.`);
    }
    return null;
  }
  if (a.status !== 'finished') return null;
  s.attempt = null; s.tokens += a.tokens ?? 0;
  if (!a.result?.ok) {
    if (a.kind === 'publish') {
      const remote = prState(s);
      if (remote?.headRefOid === s.candidate) { s.pr = remote; phase(s, 'ci', 'wait for CI on exact candidate'); return null; }
      if (a.create_attempted) { block(s, 'PR creation outcome uncertain; no automatic duplicate create. Inspect GitHub and resume to reconcile.'); s.uncertain_publish = true; return null; }
    }
    if (a.kind === 'ready') {
      const remote = prState(s);
      if (remote && !remote.isDraft && remote.headRefOid === s.candidate && successfulChecks(s, remote)) { s.pr = remote; s.ci = { candidate: s.candidate, checked_at: new Date().toISOString(), checks: remote.statusCheckRollup }; phase(s, 'ready', 'return verified PR'); return null; }
    }
    if (a.kind === 'test') { s.feedback = ['Acceptance command failed. Inspect the previous test log and correct the cause.']; s.feedback_artifact = join(a.directory, 'private.log'); phase(s, 'repairing', 'dispatch repair for failed acceptance tests'); }
    else block(s, `${a.kind} attempt failed; inspect ${a.id} private artifacts before retry`);
    return null;
  }
  if (['implement', 'repair'].includes(a.kind)) collect(s);
  else if (a.kind === 'test') { s.tests = { candidate: a.candidate, attempt: a.id }; phase(s, 'reviewing', 'dispatch independent review at tested commit'); }
  else if (a.kind === 'review') {
    assertCandidate(s);
    const r = a.result.structured;
    if (r.approved && r.findings.length === 0) { s.review = { candidate: a.candidate, attempt: a.id }; phase(s, 'publishing', 'push candidate and reconcile draft PR'); }
    else { s.feedback = r.findings.length ? r.findings : ['Reviewer did not approve; address review summary in private artifact.']; s.feedback_artifact = join(a.directory, 'output.json'); phase(s, 'repairing', 'dispatch repair of independent review findings'); }
  } else if (a.kind === 'publish') { s.pr = { url: a.result.url }; phase(s, 'ci', 'wait for CI on exact candidate'); }
  else if (a.kind === 'ready') {
    const remote = prState(s);
    if (!remote || remote.isDraft || remote.headRefOid !== s.candidate || !successfulChecks(s, remote)) throw new Error('Ready PR does not match candidate or successful required CI');
    s.pr = remote; s.ci = { candidate: s.candidate, checked_at: new Date().toISOString(), checks: remote.statusCheckRollup }; phase(s, 'ready', 'return verified PR');
  }
  return null;
}

export async function tick(run, control) {
  run = resolve(run);
  const db = openDatabase(rootFor(run));
  let s, launchAttempt;
  db.exec('BEGIN IMMEDIATE');
  try {
    s = getState(db, run);
    s.manager = { pid: process.pid, identity: processIdentity(process.pid), acquired_at: new Date().toISOString() };
    if (control === 'pause' && !terminal.has(s.phase)) { s.control = 'paused'; s.next_action = 'paused; active worker may finish, no new actions'; }
    if (control === 'resume' && !terminal.has(s.phase)) { s.control = 'active'; s.blocker = null; }
    if (control === 'cancel' && !terminal.has(s.phase)) {
      const a = s.attempt && getAttempt(db, s.attempt);
      if (a?.status === 'running') {
        if (!processMatches(a)) { block(s, 'Cannot cancel unknown process identity; inspect process group manually'); }
        else { process.kill(-a.pid, 'SIGTERM'); s.control = 'cancelling'; s.next_action = 'waiting for verified worker termination'; }
      } else { if (a?.status === 'reserved') { a.status = 'cancelled'; saveAttempt(db, a); } s.control = 'cancelled'; phase(s, 'cancelled', 'cancelled; worktree and evidence retained'); }
    }
    if (s.control === 'cancelling') {
      const a = s.attempt && getAttempt(db, s.attempt);
      if (!a || a.status === 'finished') { s.control = 'cancelled'; phase(s, 'cancelled', 'cancelled; worktree and evidence retained'); }
      else if (!processMatches(a)) block(s, 'Cancellation outcome uncertain; inspect process group manually');
    }
    if (s.control === 'active' && !terminal.has(s.phase)) {
      if (s.attempt && getAttempt(db, s.attempt)?.status !== 'reserved') launchAttempt = reconcileAttempt(db, s);
      else if (Date.now() >= s.deadline || s.tokens >= s.contract.budgets.tokens) block(s, 'Run wall-clock or observed token budget exhausted; no further actions permitted');
      else if (s.attempt) launchAttempt = reconcileAttempt(db, s);
      else if (s.uncertain_publish) {
        const remote = prState(s);
        if (remote?.headRefOid === s.candidate) { s.pr = remote; delete s.uncertain_publish; phase(s, 'ci', 'wait for exact candidate CI'); }
        else block(s, 'PR creation still uncertain; no automatic duplicate create');
      } else if (s.phase === 'assigned') {
        if (!existsSync(s.worktree)) {
          const branchExists = git(s.contract.repository, 'branch', '--list', s.branch);
          if (branchExists) throw new Error('Task branch already exists without its worktree; inspect ownership');
          git(s.contract.repository, 'worktree', 'add', '-b', s.branch, s.worktree, s.base_commit);
        }
        if (git(s.worktree, 'rev-parse', 'HEAD') !== s.base_commit || git(s.worktree, 'branch', '--show-current') !== s.branch || git(s.worktree, 'status', '--porcelain')) throw new Error('Assigned worktree does not match approved base');
        phase(s, 'implementing', 'dispatch implementation');
        launchAttempt = reserve(db, s, 'implement');
      } else if (phases[s.phase]) {
        if (['testing', 'reviewing', 'publishing', 'readying'].includes(s.phase)) assertCandidate(s);
        if (['publishing', 'readying'].includes(s.phase) && (s.tests?.candidate !== s.candidate || s.review?.candidate !== s.candidate)) throw new Error('Missing exact-commit test or review gate');
        launchAttempt = reserve(db, s, phases[s.phase]);
      } else if (s.phase === 'ci') {
        assertCandidate(s);
        const remote = prState(s);
        if (!remote || remote.headRefOid !== s.candidate) throw new Error('Remote PR head drifted; refusing stale CI');
        s.pr = remote;
        const checks = remote.statusCheckRollup ?? [];
        const required = s.contract.required_checks.map(name => checks.find(c => (c.name ?? c.context) === name));
        if (required.some(c => !c)) s.next_action = 'waiting for all named required GitHub CI checks';
        else if (required.some(c => c.status && c.status !== 'COMPLETED' || c.state === 'PENDING' || c.state === 'EXPECTED')) s.next_action = 'waiting for candidate CI completion';
        else if (required.some(c => (c.conclusion ?? c.state) !== 'SUCCESS')) block(s, 'Candidate required CI failed or skipped; inspect GitHub checks');
        else { s.ci = { candidate: s.candidate, checked_at: new Date().toISOString(), checks: checks.map(c => ({ name: c.name ?? c.context, conclusion: c.conclusion ?? c.state })) }; phase(s, 'readying', 'mark verified draft PR ready for review'); }
      }
    }
    saveState(db, s); await project(s); db.exec('COMMIT');
  } catch (error) {
    if (s) { block(s, error.message); saveState(db, s); db.exec('COMMIT'); }
    else { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  // SQLite is authoritative. These are recoverable human-readable projections.
  if (launchAttempt && s.control === 'active') launch(launchAttempt, run);
  return s;
}

export async function project(s) {
  atomicJson(join(s.run_dir, 'state.json'), s);
  // Avoid duplicating arbitrary model findings in the public summary/event log.
  const safe = { task_id: s.id, phase: s.phase, control: s.control, candidate: s.candidate, worker_id: s.attempt, attempt_count: s.attempts.length, tokens: s.tokens };
  const digest = JSON.stringify(safe);
  const projection = join(s.run_dir, '.last-event');
  if (!existsSync(projection) || readFileSync(projection, 'utf8') !== digest) {
    await appendRunEvent({ runDir: s.run_dir, kind: 'custom:dev-transition', payload: safe });
    writeFileSync(projection, digest, { mode: 0o600 });
  }
  writeFileSync(join(s.run_dir, 'development.md'), `# Development run ${s.id}\n\nObjective: ${s.contract.objective}\n\n- Phase: ${s.phase}\n- Control: ${s.control}\n- Candidate: ${s.candidate ?? 'none'}\n- Worker: ${s.attempt ?? 'none'}\n- Next: ${s.next_action}\n- Blocker: ${s.blocker ?? 'none'}\n- PR: ${s.pr?.url ?? 'none'}\n\nCanonical state and append-only transition history: ../../coordination.sqlite\n`, { mode: 0o600 });
}
export function status(run) {
  const db = openDatabase(rootFor(run));
  try {
    const s = getState(db, resolve(run));
    return { ...s, worker: s.attempt ? (() => { const a = getAttempt(db, s.attempt); return { id: a.id, kind: a.kind, status: a.status, pid: a.pid, alive: processMatches(a), session: a.session ?? null }; })() : null };
  } finally { db.close(); }
}
export async function runCli(argv) {
  const [verb, ...args] = argv;
  const option = name => { const at = args.indexOf(name); if (at < 0) return undefined; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value`); return args[at + 1]; };
  let state;
  if (verb === 'assign') { const file = option('--contract'); if (!file) throw new Error('--contract is required'); state = await assign(readJson(file), option('--root')); await project(state); }
  else {
    const run = option('--run'); if (!run) throw new Error('--run is required');
    if (verb === 'status') state = status(run);
    else if (['tick', 'pause', 'resume', 'cancel'].includes(verb)) state = await tick(run, verb === 'tick' ? undefined : verb);
    else if (verb === 'run') {
      do { state = await tick(run); console.log(JSON.stringify({ ok: true, state })); if (state.control !== 'active' || terminal.has(state.phase)) return; await delay(2000); } while (true);
    } else throw new Error('Usage: dev-run assign --contract FILE [--root ROOT] | status|tick|run|pause|resume|cancel --run DIR');
  }
  console.log(JSON.stringify({ ok: true, state }));
}
