import * as v from 'valibot';

export const RequestIdSchema = v.pipe(v.string(), v.uuid());
export const DateSchema = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/), v.check((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a valid calendar date'));
const TitleSchema = v.optional(v.pipe(v.string(), v.maxLength(300)));

const IngestCommonFields = {
  request_id: RequestIdSchema,
  source_context: v.optional(v.pipe(v.string(), v.maxLength(1000))),
  ingest_reason: v.optional(v.pipe(v.string(), v.maxLength(4000)))
};

export const IngestRequestSchema = v.variant('source_type', [
  v.object({
    ...IngestCommonFields,
    source_type: v.literal('text'),
    source: v.pipe(
      v.object({ type: v.optional(v.literal('text')), text: v.string(), title: TitleSchema }),
      v.transform(({ type: _legacyType, ...source }) => source)
    )
  }),
  v.object({
    ...IngestCommonFields,
    source_type: v.literal('url'),
    source: v.pipe(
      v.object({ type: v.optional(v.literal('url')), url: v.pipe(v.string(), v.url()), title: TitleSchema }),
      v.transform(({ type: _legacyType, ...source }) => source)
    )
  }),
  v.object({
    ...IngestCommonFields,
    source_type: v.literal('pdf_url'),
    source: v.pipe(
      v.object({ type: v.optional(v.literal('pdf_url')), url: v.pipe(v.string(), v.url()), title: TitleSchema }),
      v.transform(({ type: _legacyType, ...source }) => source)
    )
  })
]);

export const QueryRequestSchema = v.object({
  request_id: RequestIdSchema,
  mode: v.optional(v.picklist(['fts', 'fts+usage', 'hybrid', 'hybrid+graph'])),
  lexical_policy: v.optional(v.picklist(['any', 'all'])),
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  filters: v.optional(v.object({
    since: v.optional(v.string()),
    tags: v.optional(v.array(v.string()))
  })),
  top_k: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25)))
});

export const BriefGuideRequestSchema = v.object({
  request_id: RequestIdSchema,
  brief_date: DateSchema,
  lookback_hours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(168))),
  focus: v.optional(v.array(v.string()))
});

const BriefEventFields = {
  item_id: v.pipe(v.string(), v.minLength(1)),
  brief_date: DateSchema,
  included_bool: v.boolean(),
  rationale: v.pipe(v.string(), v.minLength(1)),
  resurface_after: v.optional(v.nullable(DateSchema))
};

export const BriefEventSchema = v.variant('event_kind', [
  v.object({
    ...BriefEventFields,
    event_kind: v.picklist(['included', 'skipped', 'resurfaced']),
    source_context: v.optional(v.string())
  }),
  v.object({
    ...BriefEventFields,
    event_kind: v.literal('cited'),
    source_context: v.pipe(v.string(), v.regex(/\S/, 'cited events require a nonblank source_context identifying the answer'))
  })
]);

export const BriefEventsRequestSchema = v.object({
  request_id: RequestIdSchema,
  events: v.pipe(v.array(BriefEventSchema), v.minLength(1), v.maxLength(50))
});

function noteField(max: number) {
  return v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.check((value) => value.trim().length > 0, 'Must contain non-whitespace text'));
}

export const AnnotationRequestSchema = v.object({
  request_id: RequestIdSchema,
  actor_type: v.picklist(['user', 'agent']),
  actor: noteField(120),
  note: noteField(4000),
  project: v.optional(noteField(200)),
  question: v.optional(noteField(1000)),
  supersedes_annotation_id: v.optional(noteField(100))
});
export type AnnotationRequest = v.InferOutput<typeof AnnotationRequestSchema>;

export type IngestRequest = v.InferOutput<typeof IngestRequestSchema>;
export type QueryRequest = v.InferOutput<typeof QueryRequestSchema>;
export type BriefGuideRequest = v.InferOutput<typeof BriefGuideRequestSchema>;
export type BriefEventsRequest = v.InferOutput<typeof BriefEventsRequestSchema>;

export type Envelope<T> = {
  ok: boolean;
  request_id: string | null;
  data: T | null;
  error: unknown | null;
};

export const ReanalyzeRequestSchema = v.strictObject({ request_id: RequestIdSchema });
export type ReanalyzeRequest = v.InferOutput<typeof ReanalyzeRequestSchema>;
