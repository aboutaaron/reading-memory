import * as v from 'valibot';

export const RequestIdSchema = v.pipe(v.string(), v.uuid());

export const IngestRequestSchema = v.object({
  request_id: RequestIdSchema,
  source_type: v.picklist(['url', 'text', 'pdf_url']),
  source: v.variant('type', [
    v.object({ type: v.literal('url'), url: v.pipe(v.string(), v.url()) }),
    v.object({ type: v.literal('text'), text: v.string(), title: v.optional(v.string()) }),
    v.object({ type: v.literal('pdf_url'), url: v.pipe(v.string(), v.url()) })
  ]),
  source_context: v.optional(v.string()),
  ingest_reason: v.optional(v.string())
});

export const QueryRequestSchema = v.object({
  request_id: RequestIdSchema,
  query: v.pipe(v.string(), v.minLength(1)),
  filters: v.optional(v.object({
    since: v.optional(v.string()),
    tags: v.optional(v.array(v.string()))
  })),
  top_k: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25)))
});

export const BriefGuideRequestSchema = v.object({
  request_id: RequestIdSchema,
  brief_date: v.string(),
  lookback_hours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(168))),
  focus: v.optional(v.array(v.string()))
});

export type IngestRequest = v.InferOutput<typeof IngestRequestSchema>;
export type QueryRequest = v.InferOutput<typeof QueryRequestSchema>;
export type BriefGuideRequest = v.InferOutput<typeof BriefGuideRequestSchema>;

export type Envelope<T> = {
  ok: boolean;
  request_id: string | null;
  data: T | null;
  error: unknown | null;
};
