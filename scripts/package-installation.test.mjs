import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('../', import.meta.url));

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('the real npm package boots installed setup and MCP from its shipped compiled output', { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'reading-package-installation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(existsSync(join(project, 'dist', 'src', 'mcp', 'server.js')),
    'run npm run build before packaging; this regression uses real compiler output');
  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: project }))[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const required of [
    'dist/src/index.js', 'dist/src/mcp/server.js', 'dist/src/db/schema.sql',
    'scripts/setup.mjs', 'scripts/lib/env-file.mjs', 'scripts/lib/mcp-config.mjs',
    'scripts/backup-sqlite.sh', 'scripts/restore-from-backup.sh',
    'scripts/run-ledger.mjs', 'scripts/lib/run-ledger.mjs',
    '.agents/skills/use-reading-memory/SKILL.md', '.agents/commands/reading:status.md',
    'systemd/reading-memory.service', 'launchd/start.sh', '.env.example', 'tsconfig.json'
  ]) assert.ok(files.has(required), `npm package must contain ${required}`);
  assert.equal([...files].some(path => path.startsWith('node_modules/') || path === '.env'), false);

  const app = join(root, 'node_modules', 'reading-memory');
  mkdirSync(app, { recursive: true });
  command('tar', ['-xzf', join(root, packed.filename), '-C', app, '--strip-components=1']);
  const env = { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' };
  const run = (script, args = [], overrides = {}) => command(process.execPath,
    ['--no-experimental-strip-types', '--', join(app, script), ...args], { cwd: app, env: { ...env, ...overrides } });

  // Setup reads the actual packed skills and slash commands. Its dry run stays
  // inside the disposable environment rather than changing an installed client.
  const setup = run('scripts/setup.mjs', ['setup', '--target', 'claude-code', '--env-file', join(root, 'data', 'env'), '--dry-run']);
  assert.match(setup, /Reading Memory setup checked/);
  assert.match(setup, /would copy skill:/);
  assert.match(setup, /would copy command:/);
  const created = JSON.parse(run('scripts/run-ledger.mjs', ['create', '--root', join(root, 'runs'), '--run-id', 'packed']));
  const status = JSON.parse(run('scripts/run-ledger.mjs', ['status', '--run', created.run_dir, '--json']));
  assert.equal(status.state.run_id, 'packed');

  // Reuse only real, already-installed production dependencies; do not download
  // packages or copy/manufacture application build output into this installation.
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = join(root, 'node_modules', dependency);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(join(project, 'node_modules', dependency), destination, 'dir');
  }
  const token = randomUUID();
  const envFile = join(root, 'data', 'env');
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  writeFileSync(envFile, `READING_MEMORY_URL=http://127.0.0.1:4727\nREADING_API_TOKEN=${token}\n`, { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--no-experimental-strip-types', '--', join(app, 'scripts', 'setup.mjs'), 'mcp', '--env-file', envFile],
    cwd: app, env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '--no-experimental-strip-types' }, stderr: 'pipe' });
  const client = new Client({ name: 'package-installation-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(),
      ['annotations', 'brief_events', 'brief_guide', 'forget', 'get_item', 'health', 'ingest', 'query', 'reanalyze']);
    assert.equal(JSON.stringify(tools).includes(token), false);
  } finally { await client.close(); }
  assert.equal(stderr.includes(token), false);
  assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|ERR_MODULE_NOT_FOUND/);
});
