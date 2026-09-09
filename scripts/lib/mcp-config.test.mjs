import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadMcpConfig } from './mcp-config.mjs';

test('MCP loads the shared env format with explicit environment precedence', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'env');
  writeFileSync(path, '# Shared service config\nREADING_MEMORY_URL=http://127.0.0.1:5000\nREADING_API_TOKEN=saved-token\n');
  assert.deepEqual(loadMcpConfig(path, {}), { url: 'http://127.0.0.1:5000', token: 'saved-token' });
  assert.deepEqual(loadMcpConfig(undefined, { READING_MEMORY_ENV_FILE: path, READING_API_TOKEN: 'override' }),
    { url: 'http://127.0.0.1:5000', token: 'override' });
  assert.equal(loadMcpConfig(path, { READING_API_TOKEN: '' }).token, '');
});

test('setup mcp prints a launchable secret-free registration and preserves an existing token', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'env');
  const secret = 'setup-existing-secret-token';
  writeFileSync(path, `READING_API_TOKEN=${secret}\nCUSTOM=keep\n`);
  const result = spawnSync(process.execPath, [resolve('scripts/setup.mjs'), 'setup', '--target', 'mcp', '--env-file', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  const config = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(config.mcpServers['reading-memory'].command, process.execPath);
  assert.deepEqual(config.mcpServers['reading-memory'].args, [resolve('scripts/setup.mjs'), 'mcp', '--env-file', path]);
  assert.match(readFileSync(path, 'utf8'), /CUSTOM=keep/);
  assert.equal(loadMcpConfig(path, {}).token, secret);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
