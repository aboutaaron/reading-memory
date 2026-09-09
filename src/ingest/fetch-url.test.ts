import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import type { LookupFunction } from 'node:net';
import tls from 'node:tls';
import { assertPublicHttpsUrl, fetchUrl, type Resolver } from './fetch-url.js';
import { ApiError } from '../api/errors.js';

const publicAddress = { address: '93.184.216.34', family: 4 };
const publicResolver: Resolver = async () => [publicAddress];
const cert = readFileSync(new URL('./fixtures/fetch-test-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/fetch-test-key.pem', import.meta.url));

/** Exercise the real Undici connector and TLS verification, routing only the
 * already-pinned socket to a local fixture server at the final test boundary. */
async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer({ cert, key }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const connections: { host: string | undefined; servername: string | undefined; address: string; family: number | undefined }[] = [];
  const realConnect = tls.connect;
  t.mock.method(tls, 'connect', (options: tls.ConnectionOptions) => {
    assert.equal(options.rejectUnauthorized, undefined, 'production certificate verification stays enabled');
    assert.equal(options.checkServerIdentity, undefined, 'production uses Node hostname verification');
    assert.equal(typeof options.lookup, 'function', 'every hostname socket must have the pinned lookup');
    const pinnedLookup = options.lookup!;
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      pinnedLookup(hostname, lookupOptions, (error, address, family) => {
        assert.ifError(error);
        const selected = Array.isArray(address) ? address[0]! : { address, family };
        connections.push({ host: options.host, servername: options.servername, address: selected.address, family: selected.family });
        // Local routing is a test-only replacement after observing the actual
        // connector's lookup result. SNI and Host remain the production values.
        if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      });
    };
    return realConnect({ ...options, port, ca: cert, lookup });
  });
  return { server, connections };
}

for (const url of [
  'https://127.0.0.1/private', 'https://127.0.0.2/private', 'https://0.1.2.3/',
  'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:0.1.2.3]/',
  'https://[0:0:0:0:0:ffff:7f00:2]/', 'https://[fe90::1]/', 'https://[fc00::1]/',
  'https://[2::1]/', 'https://[20::1]/', 'https://[200::1]/', 'https://[4000::1]/',
  'https://[ff02::1]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::]/'
]) {
  test(`blocks non-public literal before DNS or transport: ${url}`, async () => {
    let lookups = 0;
    await assert.rejects(assertPublicHttpsUrl(new URL(url), async () => { lookups++; return [publicAddress]; }),
      (error) => error instanceof ApiError && error.code === 'FETCH_FAILED' && error.status === 400);
    assert.equal(lookups, 0);
  });
}

for (const host of ['localhost', 'LOCALHOST.', 'reader.localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']) {
  test(`blocks loopback hostname even if DNS claims a public IP: ${host}`, async () => {
    let lookups = 0;
    await assert.rejects(assertPublicHttpsUrl(new URL(`https://${host}/`), async () => { lookups++; return [publicAddress]; }),
      (error) => error instanceof ApiError && error.message.includes('Loopback'));
    assert.equal(lookups, 0);
  });
}

test('rejects mixed public/private, mapped, invalid, and empty DNS answers', async () => {
  for (const addresses of [
    [publicAddress, { address: '10.0.0.5', family: 4 }],
    [{ address: '::ffff:0.1.2.3', family: 6 }],
    [{ address: '::ffff:7f00:1', family: 6 }],
    [{ address: '0:0:0:0:0:ffff:a00:1', family: 6 }],
    [{ address: 'not-an-ip', family: 4 }],
    [{ address: 'fe80::1%lo', family: 6 }],
    [{ address: publicAddress.address, family: 6 }], []
  ]) {
    await assert.rejects(assertPublicHttpsUrl(new URL('https://article.example.test/'), async () => addresses),
      (error) => error instanceof ApiError && error.message.includes('blocked'));
  }
});

test('accepts public IPv4, IPv6, and mapped IPv4 literals without DNS', async () => {
  for (const host of ['93.184.216.34', '[2606:4700::1111]', '[::ffff:93.184.216.34]']) {
    const pinned = await assertPublicHttpsUrl(new URL(`https://${host}/`), async () => { throw new Error('must not resolve a literal'); });
    assert.ok(pinned.family === 4 || pinned.family === 6);
  }
});

test('requires HTTPS and rejects credentials and invalid URLs without leaking them', async () => {
  for (const url of ['http://article.example.test/', 'https://secret:password@article.example.test/', 'not a URL']) {
    await assert.rejects(fetchUrl(url), (error) => error instanceof ApiError && error.status === 400 && !error.message.includes('password'));
  }
});

test('normalizes DNS failures into sanitized retryable fetch errors', async () => {
  await assert.rejects(assertPublicHttpsUrl(new URL('https://missing.example.test/post'), async () => {
    throw Object.assign(new Error('sensitive resolver/URL details'), { code: 'EAI_AGAIN' });
  }), (error) => error instanceof ApiError && error.code === 'FETCH_FAILED' && error.status === 502 &&
    error.retryable && error.message === 'DNS lookup failed for URL host');
});

test('pins the validated address without a second DNS lookup and preserves TLS SNI and Host', async (t) => {
  let host: string | undefined;
  const { connections } = await fixture(t, (request, response) => {
    host = request.headers.host;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('Pinned article');
  });
  let calls = 0;
  const resolver: Resolver = async () => [{ address: ++calls === 1 ? publicAddress.address : '127.0.0.1', family: 4 }];
  const result = await fetchUrl('https://article.example.test/post', { resolver });
  assert.equal(new TextDecoder().decode(result.bytes), 'Pinned article');
  assert.equal(result.finalUrl, 'https://article.example.test/post');
  assert.equal(calls, 1, 'a second DNS lookup would return a private IP');
  assert.equal(host, 'article.example.test');
  assert.deepEqual(connections, [{ host: 'article.example.test', servername: 'article.example.test', ...publicAddress }]);
});

test('resolves and pins each redirect, including a new address on the same host', async (t) => {
  const { connections } = await fixture(t, (request, response) => {
    if (request.url === '/start') response.writeHead(302, { location: '/next' }).end();
    else if (request.url === '/next') response.writeHead(307, { location: 'https://redirect.example.test/final' }).end();
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('Final article');
  });
  const hosts: string[] = [];
  const result = await fetchUrl('https://article.example.test/start', { resolver: async (hostname) => {
    hosts.push(hostname);
    return [{ address: `93.184.216.${hosts.length}`, family: 4 }];
  } });
  assert.equal(result.finalUrl, 'https://redirect.example.test/final');
  assert.deepEqual(hosts, ['article.example.test', 'article.example.test', 'redirect.example.test']);
  assert.deepEqual(connections.map(({ address }) => address), ['93.184.216.1', '93.184.216.2', '93.184.216.3']);
  assert.equal(connections[2]?.servername, 'redirect.example.test');
});

test('blocks a private redirect without opening another socket', async (t) => {
  const { connections } = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: 'https://redirect.example.test/private' }).end();
  });
  await assert.rejects(fetchUrl('https://article.example.test/start', { resolver: async (hostname) =>
    [{ address: hostname === 'article.example.test' ? publicAddress.address : '::ffff:0.1.2.3', family: hostname === 'article.example.test' ? 4 : 6 }]
  }), (error) => error instanceof ApiError && error.message.includes('blocked'));
  assert.equal(connections.length, 1);
});

test('checks the original hostname against the TLS certificate and sanitizes failures', async (t) => {
  const { connections } = await fixture(t, (_request, response) => { response.end('Must not reach HTTP'); });
  await assert.rejects(fetchUrl('https://wrong.example.test/private?token=secret', { resolver: publicResolver }),
    (error) => error instanceof ApiError && error.status === 502 && error.retryable && error.message === 'Unable to fetch source URL');
  assert.equal(connections[0]?.servername, 'wrong.example.test');
});

test('closes oversized streams, unsupported bodies, and excessive redirect chains', async (t) => {
  const { connections } = await fixture(t, (request, response) => {
    if (request.url === '/oversize') response.writeHead(200, { 'content-type': 'text/plain' }).write('too much text');
    else if (request.url === '/mime') response.writeHead(200, { 'content-type': 'application/private-secret' }).write('unused');
    else response.writeHead(302, { location: '/loop' }).write('unused redirect body');
  });
  await assert.rejects(fetchUrl('https://article.example.test/oversize', { resolver: publicResolver, maxBytes: 2 }),
    (error) => error instanceof ApiError && error.code === 'PAYLOAD_TOO_LARGE');
  await assert.rejects(fetchUrl('https://article.example.test/mime', { resolver: publicResolver }),
    (error) => error instanceof ApiError && error.code === 'UNSUPPORTED_MIME' && !error.message.includes('private-secret'));
  await assert.rejects(fetchUrl('https://article.example.test/loop', { resolver: publicResolver }),
    (error) => error instanceof ApiError && error.message === 'Too many redirects');
  assert.equal(connections.length, 8);
});

test('aborted fetches close the connection and return a sanitized timeout', async (t) => {
  const controller = new AbortController();
  await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).write('partial');
    controller.abort(new Error('secret abort details'));
  });
  await assert.rejects(fetchUrl('https://article.example.test/', { resolver: publicResolver, signal: controller.signal }),
    (error) => error instanceof ApiError && error.code === 'TIMEOUT' && !error.message.includes('secret'));
});
