// A detached process owns one attempt. It claims once before starting any child.
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, getAttempt, getState, saveAttempt, rootFor, processIdentity, atomicJson, git } from './dev-state.mjs';

const [run, id] = process.argv.slice(2);
const db = openDatabase(rootFor(run));
db.exec('BEGIN IMMEDIATE');
let a = getAttempt(db, id);
const owner = getState(db, run);
if (!a || a.status !== 'reserved' || owner.control !== 'active' || owner.attempt !== id || Date.now() >= owner.deadline) { db.exec('ROLLBACK'); db.close(); process.exit(0); }
a = { ...a, status: 'running', pid: process.pid, identity: processIdentity(process.pid), started_at: new Date().toISOString() };
saveAttempt(db, a); db.exec('COMMIT');
const output = join(a.directory, 'output.json');
const log = openSync(join(a.directory, 'private.log'), 'a', 0o600);
let child;
let timedOut = false;
let stopping = null;
const timer = setTimeout(() => { timedOut = true; stop(); }, a.timeout_seconds * 1000);
function stop() {
  if (!child || stopping) return stopping;
  const pid = child.pid;
  try { process.kill(-pid, 0); } catch { return Promise.resolve(); }
  stopping = new Promise(resolve => {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} resolve(); }, 1500);
  });
  return stopping;
}
process.on('SIGTERM', () => { timedOut = true; stop(); });
async function execute(exe, args, cwd, stdin, capture = false) {
  return await new Promise((resolve, reject) => {
    stopping = null;
    child = spawn(exe, args, { cwd, detached: true, env: { ...process.env, DEV_RUN_ATTEMPT: a.id, DEV_RUN_KIND: a.kind, DEV_RUN_OUTPUT: output, DEV_RUN_CANDIDATE: a.candidate ?? '' }, stdio: ['pipe', capture ? 'pipe' : log, log] });
    let stdout = '';
    if (capture) child.stdout.on('data', data => { stdout += data; if (stdout.length > 4 * 1024 * 1024) { timedOut = true; stop(); } });
    db.exec('BEGIN IMMEDIATE'); a.child_pid = child.pid; a.child_identity = child.pid ? processIdentity(child.pid) : null; saveAttempt(db, a); db.exec('COMMIT');
    child.once('error', reject);
    child.once('exit', async (code, signal) => { await stop(); resolve({ code, signal, stdout: stdout.trim() }); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}
async function checked(exe, args) {
  const current = getState(db, run);
  if (current.control !== 'active' || Date.now() >= current.deadline || timedOut) throw new Error('External action paused, cancelled or expired');
  const r = await execute(exe, args, a.cwd, undefined, true);
  if (r.code !== 0 || timedOut) throw new Error('External command failed');
  return r.stdout;
}
let result;
try {
  if (a.kind === 'test') {
    for (const argv of a.tests) {
      const exit = await execute(argv[0], argv.slice(1), a.cwd);
      if (exit.code !== 0 || timedOut) throw new Error('acceptance command failed');
    }
    if (git(a.cwd, 'rev-parse', 'HEAD') !== a.candidate || git(a.cwd, 'status', '--porcelain')) throw new Error('tests changed candidate worktree');
    result = { ok: true, candidate: a.candidate };
  } else if (a.kind === 'publish') {
    const gh = a.gh ?? 'gh';
    const call = args => checked(gh, args);
    const prs = JSON.parse(await call(['pr', 'list', '--repo', a.github, '--head', a.branch, '--state', 'all', '--json', 'url,state,body,headRefOid']));
    if (prs.length > 1 || prs.some(p => !p.body.includes(a.marker) || p.state !== 'OPEN')) throw new Error('PR branch identity conflict');
    const remote = (await checked('git', ['ls-remote', '--heads', 'origin', `refs/heads/${a.branch}`])).split(/\s/)[0];
    if (remote && remote !== a.candidate && !prs.length) throw new Error('Remote branch exists without a matching owned PR');
    // Initial push is replay-safe only at the same exact commit. Never force-push.
    await checked('git', ['push', 'origin', `${a.candidate}:refs/heads/${a.branch}`]);
    let url = prs[0]?.url;
    if (!url) {
      // Durable intent distinguishes uncertain external outcome from safe retries.
      db.exec('BEGIN IMMEDIATE'); a.create_attempted = true; saveAttempt(db, a); db.exec('COMMIT');
      const bodyFile = join(a.directory, 'pr-body.md');
      writeFileSync(bodyFile, `${a.marker}\n\n${a.objective}\n\nManaged run: \`${a.run_id}\`. Independent review and acceptance tests passed for \`${a.candidate}\`.\n\n${a.acceptance.map(x => `- ${x}`).join('\n')}\n`, { mode: 0o600 });
      url = await call(['pr', 'create', '--repo', a.github, '--base', a.base, '--head', a.branch, '--draft', '--title', a.objective.slice(0, 120), '--body-file', bodyFile]);
    }
    result = { ok: true, url };
  } else if (a.kind === 'ready') {
    const current = JSON.parse(await checked(a.gh ?? 'gh', ['pr', 'view', a.url, '--repo', a.github, '--json', 'headRefOid,body,state,statusCheckRollup,isDraft']));
    if (current.headRefOid !== a.candidate || current.state !== 'OPEN' || !current.body.includes(a.marker)) throw new Error('Remote PR identity drifted');
    const checks = a.required_checks.map(name => current.statusCheckRollup.find(c => (c.name ?? c.context) === name));
    if (checks.some(c => !c || (c.status && c.status !== 'COMPLETED') || (c.conclusion ?? c.state) !== 'SUCCESS')) throw new Error('Final required CI gates are not successful');
    await checked(a.gh ?? 'gh', ['pr', 'ready', a.url, '--repo', a.github]);
    result = { ok: true };
  } else {
    const schema = { type: 'object', additionalProperties: false, required: ['summary', 'candidate', 'approved', 'findings'], properties: { summary: { type: 'string' }, candidate: { type: 'string' }, approved: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } };
    const schemaFile = join(a.directory, 'schema.json');
    atomicJson(schemaFile, schema);
    const args = ['exec', '--json', '--color', 'never', '--sandbox', a.kind === 'review' ? 'read-only' : 'workspace-write', '-C', a.cwd, '--output-schema', schemaFile, '--output-last-message', output, '-'];
    const exit = await execute(a.codex ?? 'codex', args, a.cwd, a.prompt);
    if (exit.code !== 0 || timedOut) throw new Error('coding worker failed or timed out');
    const structured = JSON.parse(readFileSync(output, 'utf8'));
    if (typeof structured.summary !== 'string' || typeof structured.approved !== 'boolean' || !Array.isArray(structured.findings) || structured.findings.some(x => typeof x !== 'string')) throw new Error('invalid worker result');
    if (a.kind === 'review' && (structured.candidate !== a.candidate || git(a.cwd, 'rev-parse', 'HEAD') !== a.candidate || git(a.cwd, 'status', '--porcelain'))) throw new Error('review does not correspond to unchanged candidate');
    result = { ok: true, structured };
  }
} catch { result = { ok: false, reason: timedOut ? 'worker deadline exceeded' : 'attempt failed; inspect private.log' }; }
clearTimeout(timer);
closeSync(log);
let tokens = 0;
let session = null;
for (const line of readFileSync(join(a.directory, 'private.log'), 'utf8').split('\n')) {
  try { const event = JSON.parse(line); if (event.type === 'thread.started') session = event.thread_id; if (event.usage) tokens += (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0); } catch {}
}
db.exec('BEGIN IMMEDIATE');
a = { ...getAttempt(db, id), status: 'finished', finished_at: new Date().toISOString(), result, tokens, session };
saveAttempt(db, a); db.exec('COMMIT'); db.close();
atomicJson(join(a.directory, 'result.json'), a);
