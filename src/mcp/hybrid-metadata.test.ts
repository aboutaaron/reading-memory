import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toJsonSchema } from '@valibot/to-json-schema';
import { QueryRequestSchema } from '../api/contracts.js';
import { createReadingMcpServer } from './server.js';

test('MCP query metadata discloses optional provider traffic and advertises the shared query modes', async (t) => {
  const server = createReadingMcpServer({ url: 'http://127.0.0.1:4727', token: 'metadata-test-token-1234567890123456' });
  const client = new Client({ name: 'reading-memory-metadata-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const query = tools.find((tool) => tool.name === 'query');
  assert.ok(query);
  assert.equal(query.annotations?.readOnlyHint, true);
  assert.equal(query.annotations?.destructiveHint, false);
  assert.equal(query.annotations?.openWorldHint, true);
  assert.match(query.description ?? '', /optional hybrid mode may send query text to the configured embedding provider/i);
  assert.match(query.description ?? '', /usage mode ranks lexical matches using recorded prior use and skips; default fts preserves lexical order/);

  const sharedSchema = toJsonSchema(QueryRequestSchema, { errorMode: 'ignore' });
  const mode = query.inputSchema.properties?.mode as { enum?: string[] } | undefined;
  assert.deepEqual(mode?.enum, ['fts', 'fts+usage', 'hybrid']);
  assert.deepEqual(query.inputSchema.properties?.mode, sharedSchema.properties?.mode);
});
