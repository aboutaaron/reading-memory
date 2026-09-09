import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ReadingHttpClient } from './http-client.js';

const run = promisify(execFile);
const token = 'mcp-tls-fixture-secret-at-least-thirty-two-bytes';
const response = { ok: true, request_id: null, data: { ready: true }, error: null };

async function localhostCertificate(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'reading-mcp-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certPath = join(dir, 'localhost-cert.pem');
  const keyPath = join(dir, 'localhost-key.pem');
  // Generate disposable test credentials rather than committing a private key
  // or adding a trust override to the production client.
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certPath], { timeout: 10_000 });
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o600);
  const cert = readFileSync(certPath);
  const parsed = new X509Certificate(cert);
  assert.equal(parsed.subjectAltName, 'DNS:localhost');
  assert.equal(parsed.checkHost('localhost'), 'localhost');
  assert.equal(parsed.checkIP('127.0.0.1'), undefined, 'the fixture must not hide an IP hostname rewrite');
  return { certPath, cert, key: readFileSync(keyPath) };
}

async function listen(t: TestContext, server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}

async function trustedRequest(url: string, certPath: string) {
  // Node reads extra roots only at startup. A separate process gives this
  // request its test trust root while keeping normal hostname verification.
  const script = `
    import dns from 'node:dns';
    import { ReadingHttpClient } from ${JSON.stringify(new URL('./http-client.js', import.meta.url).href)};
    let systemLookups = 0;
    dns.lookup = () => { systemLookups++; throw new Error('Unexpected system DNS lookup'); };
    const result = await new ReadingHttpClient({ url: process.argv[1], token: ${JSON.stringify(token)} }).request('GET', '/health');
    process.stdout.write(JSON.stringify({ result, systemLookups }));
  `;
  const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, url], {
    env: { PATH: process.env.PATH ?? '', NODE_EXTRA_CA_CERTS: certPath },
    timeout: 10_000
  });
  assert.equal(stderr, '');
  return JSON.parse(stdout) as {
    result: Awaited<ReturnType<ReadingHttpClient['request']>>;
    systemLookups: number;
  };
}

test('HTTPS localhost keeps its TLS identity and Host while connecting to the pinned loopback address', { timeout: 20_000 }, async t => {
  const { certPath, cert, key } = await localhostCertificate(t);
  const requests: Array<{ host: string | undefined; authorization: string | undefined; address: string | undefined }> = [];
  const servernames: Array<string | false | null> = [];
  const server = createHttpsServer({ cert, key }, (req, res) => {
    requests.push({ host: req.headers.host, authorization: req.headers.authorization, address: req.socket.remoteAddress });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  server.on('secureConnection', socket => servernames.push(socket.servername));
  const port = await listen(t, server);
  const { result, systemLookups } = await trustedRequest(`https://localhost:${port}`, certPath);
  assert.deepEqual(result, { isError: false, payload: response });
  assert.equal(systemLookups, 0, 'localhost never reaches the system DNS resolver');
  assert.deepEqual(servernames, ['localhost']);
  assert.deepEqual(requests, [{ host: `localhost:${port}`, authorization: `Bearer ${token}`, address: '127.0.0.1' }]);
});

test('a trusted localhost certificate is rejected for an IP hostname before sending bearer auth', { timeout: 20_000 }, async t => {
  const { certPath, cert, key } = await localhostCertificate(t);
  let requests = 0;
  const server = createHttpsServer({ cert, key }, (_req, res) => {
    requests++;
    res.end(JSON.stringify(response));
  });
  const port = await listen(t, server);
  const { result, systemLookups } = await trustedRequest(`https://127.0.0.1:${port}`, certPath);
  assert.equal(result.isError, true);
  assert.equal((result.payload.error as { code: string }).code, 'SERVICE_UNAVAILABLE');
  assert.equal(requests, 0, 'TLS hostname mismatch prevents the authenticated HTTP request');
  assert.equal(systemLookups, 0);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(certPath), false);
});

test('HTTP localhost preserves its Host header on the loopback connection', async t => {
  let host: string | undefined;
  let address: string | undefined;
  const server = createHttpServer((req, res) => {
    host = req.headers.host;
    address = req.socket.remoteAddress;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  const port = await listen(t, server);
  const result = await new ReadingHttpClient({ url: `http://localhost:${port}`, token }).request('GET', '/health');
  assert.deepEqual(result, { isError: false, payload: response });
  assert.equal(host, `localhost:${port}`);
  assert.equal(address, '127.0.0.1');
});
