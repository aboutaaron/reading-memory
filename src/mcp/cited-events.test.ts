import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReadingMcpServer } from './server.js';

type EventsBody = { request_id: string; events: Record<string, unknown>[] };
type RecordedRequest = { method: string | undefined; path: string | undefined; body: EventsBody };

async function connect(t: TestContext) {
  const requests: RecordedRequest[] = [];
  const recordedEvents: Record<string, unknown>[] = [];
  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as EventsBody;
    requests.push({ method: req.method, path: req.url, body });
    recordedEvents.push(...body.events);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, request_id: body.request_id, data: { events: body.events }, error: null }));
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((done) => httpServer.close(() => done()));
  });

  const server = createReadingMcpServer({
    url: `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`,
    token: 'cited-events-test-token-1234567890'
  });
  const client = new Client({ name: 'reading-memory-cited-events-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, requests, recordedEvents };
}

function event(eventKind: 'included' | 'skipped' | 'resurfaced' | 'cited', itemId: string, sourceContext?: string) {
  return {
    item_id: itemId,
    brief_date: '2026-09-09',
    event_kind: eventKind,
    included_bool: eventKind !== 'skipped',
    rationale: 'Finalized source selection.',
    ...(sourceContext === undefined ? {} : { source_context: sourceContext })
  };
}

test('MCP rejects cited events without nonblank source context before forwarding any part of the batch', async (t) => {
  const { client, requests, recordedEvents } = await connect(t);
  for (const [label, context] of [['missing', undefined], ['empty', ''], ['whitespace', ' \t\n\r\u00a0 ']] as const) {
    await t.test(label, async () => {
      const result = await client.callTool({ name: 'brief_events', arguments: {
        request_id: randomUUID(),
        events: [
          event('included', 'valid-brief-source'),
          event('cited', 'invalid-answer-source', context),
          event('cited', 'valid-answer-source', 'answer:valid-after-invalid')
        ]
      } });

      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        ok: false, request_id: null, data: null,
        error: { code: 'BAD_REQUEST', message: 'Arguments do not match the tool schema' }
      });
      assert.deepEqual(requests, [], 'invalid batches must be rejected before the HTTP boundary');
      assert.deepEqual(recordedEvents, [], 'neither valid nor invalid events in a rejected batch may be recorded');
    });
  }
});

test('MCP forwards a cited event with its exact source context and request identity', async (t) => {
  const { client, requests, recordedEvents } = await connect(t);
  const body = {
    request_id: randomUUID(),
    events: [event('cited', 'answer-source', '  conversation:reading/answer:17\n')]
  };
  const result = await client.callTool({ name: 'brief_events', arguments: body });

  assert.equal(result.isError, false);
  assert.deepEqual(requests, [{ method: 'POST', path: '/brief-events', body }]);
  assert.deepEqual(recordedEvents, body.events);
  assert.deepEqual(result.structuredContent, {
    ok: true, request_id: body.request_id, data: { events: body.events }, error: null
  });
});

test('MCP preserves optional source context for included, skipped, and resurfaced events', async (t) => {
  const { client, requests, recordedEvents } = await connect(t);
  const body = {
    request_id: randomUUID(),
    events: (['included', 'skipped', 'resurfaced'] as const).flatMap((kind) =>
      [undefined, '', ' \t\n ', 'brief:morning'].map((context, index) => event(kind, `${kind}-${index}`, context)))
  };
  const result = await client.callTool({ name: 'brief_events', arguments: body });

  assert.equal(result.isError, false);
  assert.deepEqual(requests, [{ method: 'POST', path: '/brief-events', body }]);
  assert.deepEqual(recordedEvents, body.events);
});

test('MCP tool metadata requires nonblank context only for cited events', async (t) => {
  const { client, requests } = await connect(t);
  const { tools } = await client.listTools();
  const briefEvents = tools.find((tool) => tool.name === 'brief_events');
  assert.ok(briefEvents);
  type EventSchema = {
    required?: string[];
    properties?: { event_kind?: { const?: string; enum?: string[] }; source_context?: { type?: string; pattern?: string } };
  };
  const events = briefEvents.inputSchema.properties?.events as { items?: { oneOf?: EventSchema[] } } | undefined;
  const branches = events?.items?.oneOf;
  assert.ok(branches);
  const cited = branches.find((branch) => branch.properties?.event_kind?.const === 'cited');
  const legacy = branches.find((branch) => branch.properties?.event_kind?.enum?.includes('included'));
  assert.ok(cited);
  assert.ok(cited.required?.includes('source_context'));
  assert.equal(cited.properties?.source_context?.type, 'string');
  const pattern = cited.properties?.source_context?.pattern;
  assert.ok(pattern, 'clients must see the nonblank requirement');
  assert.equal(new RegExp(pattern).test(' \t\n\r\u00a0 '), false);
  assert.equal(new RegExp(pattern).test('answer:17'), true);
  assert.ok(legacy);
  assert.deepEqual(legacy.properties?.event_kind?.enum, ['included', 'skipped', 'resurfaced']);
  assert.equal(legacy.required?.includes('source_context'), false);
  assert.deepEqual(requests, [], 'listing tool metadata must not contact HTTP');
});
