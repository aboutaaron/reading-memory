import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ReadingHttpClient } from './http-client.js';

test('MCP rejects short custom or preserved tokens before they can corrupt the API envelope', () => {
  for (const token of ['', 'a', 'data', 'request_id', 'recommended_action', 'a'.repeat(31),
    'a'.repeat(31) + ' ', 'a'.repeat(31) + '\n', 'a'.repeat(31) + 'é']) {
    assert.throws(() => new ReadingHttpClient({ url: 'http://127.0.0.1:4727', token }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /at least 32 non-whitespace ASCII characters/);
      assert.match(error.message, /same token for the service and MCP client/);
      return true;
    });
  }
  assert.doesNotThrow(() => new ReadingHttpClient({ url: 'http://127.0.0.1:4727', token: randomUUID() }));
});

test('a generated UUID token preserves the API envelope and redacts service echoes in keys and values', async t => {
  const token = randomUUID();
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, request_id: null, data: {
      summary: 'The data supports a recommendation to save the source.',
      recommended_action: 'save', [token]: [{ credentials: `Bearer ${token}` }],
      metadata: `echo-prefix-${token}-echo-suffix`
    }, error: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const client = new ReadingHttpClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token });

  const result = await client.request('GET', '/health');

  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, { ok: true, request_id: null, data: {
    summary: 'The data supports a recommendation to save the source.',
    recommended_action: 'save', '[REDACTED]': [{ credentials: 'Bearer [REDACTED]' }],
    metadata: 'echo-prefix-[REDACTED]-echo-suffix'
  }, error: null });
  assert.equal(JSON.stringify(result).includes(token), false);
});
