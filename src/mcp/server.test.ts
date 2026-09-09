import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createReadingApi } from '../api/server.js';
import { openMemoryDatabase } from '../db/connection.js';
import { loopbackServiceUrl } from './http-client.js';

const token = 'mcp-test-secret-never-output-12345678';
const cli = resolve('scripts/setup.mjs');
const envelope = (result: Awaited<ReturnType<Client['callTool']>>) => result.structuredContent as Record<string, unknown>;

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'reading-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(t: TestContext, server: HttpServer) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function connect(t: TestContext, url: string, credential = token, throughNpx = false, env: Record<string, string> = {}) {
  const dir = directory(t);
  const envFile = join(dir, 'env');
  writeFileSync(envFile, `READING_MEMORY_URL=${url}\nREADING_API_TOKEN=${credential}\n`, { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: throughNpx ? 'npx' : process.execPath,
    args: throughNpx ? ['--no-install', 'reading-memory', 'mcp', '--env-file', envFile] : [cli, 'mcp', '--env-file', envFile], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...env }
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'reading-memory-test', version: '1.0.0' });
  t.after(async () => { await client.close(); assert.equal(stderr.includes(credential), false); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

test('stdio MCP lists typed tools and round-trips capture, recall, annotations, text, reanalysis, and forget through the real HTTP API', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const dataDir = directory(t);
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: token, dataDir,
    backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db, {
    analyzer: async () => ({ summary: 'Cobalt caches require explicit invalidation.', claims: ['Dependencies matter.'],
      relevance: { score: 0.9, themes: ['systems'] }, recommended_action: 'brief', confidence: 0.8,
      reason: 'Useful evidence.', tags: [], relationships: [], model: 'test', analysis_version: 'test' })
  });
  const url = await listen(t, server);
  const { client, stderr } = await connect(t, url, token, true);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(),
    ['annotations', 'brief_events', 'brief_guide', 'forget', 'get_item', 'health', 'ingest', 'query', 'reanalyze']);
  const query = tools.find((tool) => tool.name === 'query')!;
  assert.ok(query.inputSchema.required?.includes('query'));
  assert.equal(query.annotations?.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'forget')?.annotations?.destructiveHint, true);
  const capture = await client.callTool({ name: 'ingest', arguments: {
    request_id: randomUUID(), source_type: 'text', source: { text: 'Cobalt caches require explicit invalidation.' }
  } });
  assert.equal(capture.isError, false);
  const itemId = (envelope(capture).data as { item_id: string }).item_id;
  const result = await client.callTool({ name: 'query', arguments: { request_id: randomUUID(), query: 'Cobalt caches' } });
  assert.equal(result.isError, false);
  assert.deepEqual((envelope(result).data as { citations: string[] }).citations, [itemId]);
  const strict = await client.callTool({ name: 'query', arguments: {
    request_id: randomUUID(), query: 'Cobalt lunar orchard', lexical_policy: 'all'
  } });
  assert.equal(strict.isError, false);
  assert.equal((envelope(strict).data as { lexical_policy: string }).lexical_policy, 'all');
  assert.deepEqual((envelope(strict).data as { citations: string[] }).citations, []);
  const graph = await client.callTool({ name: 'query', arguments: {
    request_id: randomUUID(), query: 'Cobalt caches', lexical_policy: 'all', mode: 'hybrid+graph'
  } });
  assert.equal(graph.isError, false);
  assert.equal((envelope(graph).data as { requested_mode: string }).requested_mode, 'hybrid+graph');
  assert.equal((envelope(graph).data as { lexical_policy: string }).lexical_policy, 'all');
  assert.deepEqual((envelope(graph).data as { citations: string[] }).citations, [itemId]);
  const annotated = await client.callTool({ name: 'annotations', arguments: {
    item_id: itemId, request_id: randomUUID(), actor_type: 'user', actor: 'Reader', note: 'This matters for my project.'
  } });
  assert.equal(annotated.isError, false);
  const metadata = await client.callTool({ name: 'get_item', arguments: { item_id: itemId } });
  assert.equal(Object.hasOwn(envelope(metadata).data as object, 'extracted_text'), false);
  const expanded = await client.callTool({ name: 'get_item', arguments: { item_id: itemId, include_text: true } });
  assert.equal((envelope(expanded).data as { extracted_text: string }).extracted_text, 'Cobalt caches require explicit invalidation.');
  const invalidDate = await client.callTool({ name: 'brief_guide', arguments: { request_id: randomUUID(), brief_date: '2026-02-30' } });
  assert.equal(invalidDate.isError, true, 'custom Valibot checks still run after JSON Schema conversion');
  const traversal = await client.callTool({ name: 'get_item', arguments: { item_id: '../health' } });
  assert.equal(traversal.isError, true);
  const reanalysis = { item_id: itemId, request_id: randomUUID() };
  const refreshed = await client.callTool({ name: 'reanalyze', arguments: reanalysis });
  assert.equal(refreshed.isError, false);
  assert.equal((envelope(refreshed).data as { dedupe_status: string }).dedupe_status, 'reanalyzed');
  const replayed = await client.callTool({ name: 'reanalyze', arguments: reanalysis });
  assert.equal((envelope(replayed).data as { dedupe_status: string }).dedupe_status, 'idempotent_replay');
  assert.equal(db.prepare('SELECT count(*) AS count FROM analyses WHERE item_id = ?').get(itemId)?.count, 2);
  const invalidRefresh = await client.callTool({ name: 'reanalyze', arguments: { ...reanalysis, force: true } });
  assert.equal(invalidRefresh.isError, true);
  const forgotten = await client.callTool({ name: 'forget', arguments: { item_id: itemId } });
  assert.equal(forgotten.isError, false);
  const missing = await client.callTool({ name: 'get_item', arguments: { item_id: itemId } });
  assert.equal(missing.isError, true);
  assert.equal((envelope(missing).error as { code: string }).code, 'NOT_FOUND');
  assert.equal(JSON.stringify({ tools, result, metadata, expanded, annotated, stderr: stderr() }).includes(token), false);
});

test('stdio tool failures report API authentication errors without credentials', async (t) => {
  let receivedAuthorization = '';
  const url = await listen(t, createServer((req, res) => {
    receivedAuthorization = req.headers.authorization ?? '';
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, data: null, request_id: null, error: { code: 'UNAUTHORIZED', message: 'Invalid bearer token' } }));
  }));
  const { client } = await connect(t, url);
  const result = await client.callTool({ name: 'query', arguments: { request_id: randomUUID(), query: 'caches' } });
  assert.equal(receivedAuthorization, `Bearer ${token}`);
  assert.equal(result.isError, true);
  assert.equal((envelope(result).error as { code: string }).code, 'UNAUTHORIZED');
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('stdio results redact a credential echoed by a service, including keys and nested strings', async (t) => {
  const url = await listen(t, createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { [token]: ['Bearer ' + token] }, error: null }));
  }));
  const { client } = await connect(t, url);
  const result = await client.callTool({ name: 'health' });
  assert.equal(result.isError, false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(JSON.stringify(result), /REDACTED/);
});

test('MCP HTTP requests refuse redirects and do not expose untrusted failure bodies', async (t) => {
  let redirectedRequests = 0;
  const target = await listen(t, createServer((_req, res) => { redirectedRequests++; res.end(token); }));
  const url = await listen(t, createServer((_req, res) => { res.writeHead(302, { location: target }); res.end(token); }));
  const { client } = await connect(t, url);
  const result = await client.callTool({ name: 'health' });
  assert.equal(result.isError, true);
  assert.equal(redirectedRequests, 0);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('MCP keeps bearer auth on loopback even when Node environment proxies are enabled', async (t) => {
  let proxyRequests = 0;
  const proxyServer = createServer((_req, res) => { proxyRequests++; res.writeHead(502); res.end(); });
  proxyServer.on('connect', (_req, socket) => { proxyRequests++; socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  const proxy = await listen(t, proxyServer);
  let auth = '';
  const url = await listen(t, createServer((req, res) => {
    auth = req.headers.authorization ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { ready: true }, error: null }));
  }));
  const { client } = await connect(t, url, token, false, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '' });
  const result = await client.callTool({ name: 'health' });
  assert.equal(result.isError, false);
  assert.equal(auth, `Bearer ${token}`);
  assert.equal(proxyRequests, 0);
});

test('MCP startup rejects remote origins and missing tokens without stdout or secret diagnostics', (t) => {
  const dir = directory(t);
  for (const url of ['https://example.com', `http://${token}@127.0.0.1:4727`, 'http://localhost.evil.test', 'file:///tmp/test', 'http://127.0.0.1/path']) {
    assert.throws(() => loopbackServiceUrl(url), /loopback/);
  }
  assert.equal(loopbackServiceUrl('http://localhost:4727'), 'http://localhost:4727');
  for (const content of [`READING_MEMORY_URL=http://${token}.example.com\nREADING_API_TOKEN=${token}\n`, 'READING_MEMORY_URL=http://127.0.0.1:4727\n']) {
    const envFile = join(dir, 'env');
    writeFileSync(envFile, content);
    const result = spawnSync(process.execPath, [cli, 'mcp', '--env-file', envFile], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(token), false);
    assert.match(result.stderr, /could not start/);
  }
});
