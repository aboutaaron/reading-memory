import type { Analysis, ExtractedSource } from '../reading/types.js';

export const EVAL_BRIEF_DATE = '2026-09-09';
export const EVAL_INGESTED_AT = '2026-09-09T08:00:00.000Z';

export type ReadingMemoryEvalFixture = {
  id: string;
  source: ExtractedSource;
  analysis: Analysis;
  ingestedAt: string;
};

export type QueryEvalFixture = {
  id: string;
  query: string;
  expected: string[];
  forbidden?: string[];
  tags?: string[];
  since?: string;
  partial?: boolean;
};

// Entirely synthetic. Distinct subjects and distractors make ranking mistakes visible.
export const readingMemoryEvalFixtures: ReadingMemoryEvalFixture[] = [
  fixture({ id: 'semantic-layers', title: 'Semantic layers encode institutional judgment',
    text: 'Semantic layers and metric catalogs help analytics agents answer with governed definitions.',
    themes: ['semantic-layers', 'analytics-agents'] }),
  fixture({ id: 'agent-memory', title: 'Agent memory needs evals',
    text: 'Durable agent memory needs recall evals, citations, and resurfacing controls.',
    themes: ['agent-memory', 'evaluation'] }),
  fixture({ id: 'memory-history', title: 'Agent memory retains reader history',
    text: 'Agent memory preserves reader comments and disagreement with exact source passages.',
    themes: ['agent-memory'], ingestedAt: '2026-08-01T08:00:00.000Z' }),
  fixture({ id: 'ai-economics', title: 'Why AI bills rise as token costs fall',
    text: 'AI agents can increase total token consumption even when per-token prices fall.',
    themes: ['ai-economics'], action: 'save' }),
  fixture({ id: 'writing-culture', title: 'Cultural criticism and AI writing',
    text: 'AI writing tools change editorial judgment, taste, and the work of cultural criticism.',
    themes: ['writing', 'culture'], action: 'save' }),
  fixture({ id: 'cache-invalidation', title: 'Cache invalidation with versioned dependencies',
    text: 'Cache invalidation follows dependency version changes to prevent stale analytics results.',
    themes: ['systems'] }),
  fixture({ id: 'cache-cooking', title: 'A cache of recipes for a small kitchen',
    text: 'Find an article to help with cooking. You can keep a cache of recipes about kitchen storage.',
    themes: ['cooking'], action: 'skip', confidence: 0.99 }),
  fixture({ id: 'cooking-filler', title: 'Can you help me find that article about cooking?',
    text: 'The cooking article you read has a recipe for roasted squash and chickpeas.',
    themes: ['cooking'], action: 'skip', confidence: 0.99 }),
  fixture({ id: 'ml-drift', title: 'ML monitoring and drift',
    text: 'ML monitoring compares feature distributions to find drift before retraining.',
    themes: ['ml'] }),
  fixture({ id: 'retrieval-augmented', title: 'Retrieval-augmented generation links evidence',
    text: 'Retrieval-augmented generation supplies source passages alongside a user question.',
    themes: ['retrieval'] }),
  fixture({ id: 'cafe-design', title: 'Café acoustics',
    text: 'Café acoustics depend on surfaces that absorb reflected sound.',
    themes: ['design'], action: 'save' })
];

export const readingMemoryQueryFixtures: QueryEvalFixture[] = [
  { id: 'natural-semantic', query: 'What did I read about semantic layers?', expected: ['semantic-layers'] },
  { id: 'late-subject', query: 'Can you help me find that article about cache invalidation?',
    expected: ['cache-invalidation'], forbidden: ['cache-cooking', 'cooking-filler'] },
  { id: 'long-question', query: 'I am trying to remember something that I read. Could you please help me find the article about versioned dependencies?',
    expected: ['cache-invalidation'], forbidden: ['cooking-filler'] },
  { id: 'short-ai', query: 'AI', expected: ['ai-economics', 'writing-culture'] },
  { id: 'short-ml', query: 'ML', expected: ['ml-drift'] },
  { id: 'hyphenated-topic', query: 'retrieval-augmented generation', expected: ['retrieval-augmented'] },
  { id: 'unicode-topic', query: 'café acoustics', expected: ['cafe-design'] },
  { id: 'multiple-sources', query: 'agent memory', expected: ['agent-memory', 'memory-history'] },
  { id: 'topic-disambiguation', query: 'cache invalidation', expected: ['cache-invalidation'], forbidden: ['cache-cooking'] },
  { id: 'tag-filter', query: 'AI', tags: ['ai-economics'], expected: ['ai-economics'], forbidden: ['writing-culture'] },
  { id: 'date-filter', query: 'agent memory', since: '2026-09-01T00:00:00.000Z',
    expected: ['agent-memory'], forbidden: ['memory-history'] },
  { id: 'unsupported-subject', query: 'axolotl terrariums', expected: [] },
  { id: 'punctuation-only', query: '--- !!! ()', expected: [] },
  { id: 'conversational-filler', query: 'Can you help me find that article?', expected: [] },
  { id: 'partial-evidence', query: 'cache interplanetary', expected: ['cache-invalidation', 'cache-cooking'], partial: true }
];

export function fixture(input: {
  id: string;
  title?: string;
  text?: string;
  themes?: string[];
  action?: Analysis['recommended_action'];
  confidence?: number;
  relevance?: number;
  reason?: string;
  ingestedAt?: string;
}): ReadingMemoryEvalFixture {
  const title = input.title ?? `Synthetic source ${input.id}`;
  const text = input.text ?? `Synthetic evidence for ${input.id}.`;
  const themes = input.themes ?? ['agent-memory'];
  return {
    id: input.id,
    ingestedAt: input.ingestedAt ?? EVAL_INGESTED_AT,
    source: {
      sourceType: 'text', sourceUri: null,
      canonicalUrl: `https://example.test/${input.id}`, finalUrl: null,
      title, extractedText: text, truncated: false,
      contentHash: `sha256:fixture-${input.id}`, rawBytesHash: null,
      provenance: { source_context: 'synthetic_eval_fixture' }
    },
    analysis: {
      summary: text, claims: [text],
      relevance: { score: input.relevance ?? 0.8, themes },
      recommended_action: input.action ?? 'brief', confidence: input.confidence ?? 0.85,
      reason: input.reason ?? `Synthetic selection rationale for ${input.id}`,
      tags: themes.map((theme) => ({ tag: theme, reason: 'Synthetic eval fixture', confidence: 0.9 })),
      relationships: [], model: 'fixture/model', analysis_version: 'fixture-v2'
    }
  };
}
