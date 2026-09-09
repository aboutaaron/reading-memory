import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import {
  AnnotationRequestSchema, BriefEventsRequestSchema, BriefGuideRequestSchema,
  IngestRequestSchema, QueryRequestSchema, ReanalyzeRequestSchema
} from '../api/contracts.js';
import { ReadingHttpClient, failure, type ReadingHttpConfig } from './http-client.js';

const ItemIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(100), v.regex(/^[a-zA-Z0-9_-]+$/));
type ToolDefinition = {
  name: string;
  description: string;
  schema: v.GenericSchema;
  method: 'GET' | 'POST' | 'DELETE';
  path: string | ((input: Record<string, unknown>) => string);
  itemBody?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
};

const definitions: ToolDefinition[] = [
  {
    name: 'ingest', method: 'POST', path: '/ingest', schema: IngestRequestSchema,
    description: 'Preserve durable articles, papers, newsletters, PDF URLs, or excerpts the user wants remembered. Search first when an existing capture is plausible; do not save every link or unavailable source. Include why it matters in ingest_reason. Use a fresh UUID request_id and retain it unchanged when retrying the same request.'
  },
  {
    name: 'query', method: 'POST', path: '/query', schema: QueryRequestSchema, readOnly: true,
    description: 'Search saved reading before answering recall-heavy questions or assuming a source is new. Results are evidence, not a final answer or proof of reader agreement. The optional usage mode ranks lexical matches using recorded prior use and skips; default fts preserves lexical order. Inspect match_strategy and matched_terms; weak or empty results require qualification. Read source text with get_item when needed to verify a claim. Supply a UUID request_id.'
  },
  {
    name: 'brief_guide', method: 'POST', path: '/brief-guide', schema: BriefGuideRequestSchema, readOnly: true,
    description: 'Choose candidates for a digest, morning brief, or reading roundup. Returns evidence and rationale; does not write or send the brief. Use brief_events after the final selection. Dates are UTC calendar dates.'
  },
  {
    name: 'brief_events', method: 'POST', path: '/brief-events', schema: BriefEventsRequestSchema,
    description: 'Record finalized brief outcomes or sources actually cited in a finished answer, never mere retrieval. For answer citations use event_kind=cited, included_bool=true, a stable source_context identifying the answer, and no resurface_after. Do not record a separate cited event for a source already counted as included or resurfaced in the same brief. included and resurfaced require included_bool=true; skipped requires false. Included or resurfaced sources stay suppressed until a new resurface_after schedule makes them eligible; answer citations do not consume brief eligibility. Saving or using a source does not establish reader agreement. Retain the same request_id for retries.'

  },
  {
    name: 'get_item', method: 'GET', schema: v.object({ item_id: ItemIdSchema, include_text: v.optional(v.boolean()) }),
    path: (input) => `/items/${input.item_id}${input.include_text ? '?include=text' : ''}`, readOnly: true,
    description: 'Inspect saved metadata, provenance, analysis rationale, relationships, and attributed reader notes. Set include_text=true only to inspect retained source text; it is omitted by default. truncated means the full source ending was not retained. Quotes establish provenance, not correctness.'
  },
  {
    name: 'annotations', method: 'POST', path: (input) => `/items/${input.item_id}/annotations`, itemBody: true,
    schema: v.object({ item_id: ItemIdSchema, ...AnnotationRequestSchema.entries }),
    description: 'Preserve an explicit reader reaction, question, or correction about a saved source. User notes must preserve statements the user actually made; label your own interpretation actor_type=agent. Corrections append a note with supersedes_annotation_id; prior notes stay in history. Notes do not immediately reanalyze the item. Retain request_id for retries.'
  },
  {
    name: 'health', method: 'GET', path: '/health', schema: v.object({}), readOnly: true,
    description: 'Check local Reading Memory readiness, database, analyzer, and backups when a request fails or before relying on the service. A successful HTTP response alone does not mean ready=true.'
  },
  {
    name: 'forget', method: 'DELETE', schema: v.strictObject({ item_id: ItemIdSchema }),
    path: (input) => `/items/${input.item_id}`, destructive: true,
    description: 'Permanently forget a saved item only when the user requests deletion. Removes that item and its related corpus records; backups are separate. A second deletion returns not found.'
  },
  {
    name: 'reanalyze', method: 'POST', schema: v.strictObject({ item_id: ItemIdSchema, ...ReanalyzeRequestSchema.entries }),
    path: (input) => `/items/${input.item_id}/reanalyze`, itemBody: true,
    description: 'Refresh an existing item analysis from its retained text after model, analysis instructions, or reader context changes. Does not fetch the original source again. Runs analysis and may incur provider cost. Use a new request_id for a new run; retain it unchanged for retries.'
  }
];

export function createReadingMcpServer(config: ReadingHttpConfig) {
  const client = new ReadingHttpClient(config);
  const server = new Server({ name: 'reading-memory', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      // Custom Valibot checks (calendar dates and non-whitespace notes) cannot
      // be represented in JSON Schema; runtime validation still enforces them.
      inputSchema: { ...toJsonSchema(tool.schema, { errorMode: 'ignore' }), type: 'object' } as Tool['inputSchema'],
      annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive, openWorldHint: ['ingest', 'reanalyze'].includes(tool.name) }
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = definitions.find((candidate) => candidate.name === request.params.name);
    const parsed = tool ? v.safeParse(tool.schema, request.params.arguments ?? {}) : null;
    let result;
    if (!tool || !parsed?.success) {
      // Valibot error text can echo caller inputs. Return no input fragments.
      result = failure('BAD_REQUEST', tool ? 'Arguments do not match the tool schema' : 'Unknown Reading Memory tool');
    } else {
      const input = parsed.output as Record<string, unknown>;
      const path = typeof tool.path === 'string' ? tool.path : tool.path(input);
      const { item_id: _itemId, ...itemBody } = input;
      result = await client.request(tool.method, path, tool.method === 'POST' ? (tool.itemBody ? itemBody : input) : undefined);
    }
    return { isError: result.isError, structuredContent: result.payload, content: [{ type: 'text', text: JSON.stringify(result.payload) }] };
  });
  return server;
}

export async function startReadingMcpServer(config: ReadingHttpConfig) {
  const server = createReadingMcpServer(config);
  await server.connect(new StdioServerTransport());
  return server;
}
