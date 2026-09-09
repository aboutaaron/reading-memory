import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createEmbeddingProvider } from './embedding-provider.js';
import { EMBEDDING_DIMENSIONS } from './embeddings.js';

test('embedding SDK suppresses source, query and credential logging even with OPENAI_LOG=debug', async t => {
  const previousLogLevel = process.env.OPENAI_LOG;
  process.env.OPENAI_LOG = 'debug';
  t.after(() => {
    if (previousLogLevel === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousLogLevel;
  });
  const logs: unknown[][] = [];
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  const inputs = ['private source projection', 'private retrieval query'];
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ authorization: req.headers.authorization, input: JSON.parse(Buffer.concat(chunks).toString()).input });
    res.setHeader('content-type', 'application/json');
    if (seen.length === 2) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: inputs[1], type: 'server_error' } }));
      return;
    }
    res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0,
      embedding: [1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)] }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const embedder = createEmbeddingProvider('openai/text-embedding-3-small', {
    OPENAI_API_KEY: 'fixture-embedding-token',
    OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  });
  assert.ok(embedder);
  assert.equal((await embedder.embed(inputs[0]!)).length, EMBEDDING_DIMENSIONS);
  await assert.rejects(embedder.embed(inputs[1]!));
  assert.deepEqual(seen, inputs.map(input => ({ authorization: 'Bearer fixture-embedding-token', input })));
  assert.equal(logs.length, 0, 'provider requests and failures must not emit SDK debug logs');
});
