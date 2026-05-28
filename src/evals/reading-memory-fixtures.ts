import type { Analysis, ExtractedSource } from '../reading/types.js';

export type ReadingMemoryEvalFixture = {
  id: string;
  source: ExtractedSource;
  analysis: Analysis;
};

export const readingMemoryEvalFixtures: ReadingMemoryEvalFixture[] = [
  fixture({
    id: 'semantic-layers',
    title: 'Semantic layers encode institutional judgment',
    text: 'Semantic layers and metric catalogs help analytics agents answer with governed definitions.',
    themes: ['semantic-layers', 'analytics-agents'],
    action: 'brief'
  }),
  fixture({
    id: 'agent-memory',
    title: 'Agent memory needs evals',
    text: 'Durable agent memory needs recall evals, citations, and resurfacing controls.',
    themes: ['agent-memory', 'evaluation'],
    action: 'brief'
  }),
  fixture({
    id: 'ai-economics',
    title: 'Why AI bills rise as token costs fall',
    text: 'AI agents can increase total token consumption even when per-token prices fall.',
    themes: ['ai-economics', 'ai-agents'],
    action: 'save'
  }),
  fixture({
    id: 'writing-culture',
    title: 'Cultural criticism and AI writing',
    text: 'AI writing tools change editorial judgment, taste, and the work of cultural criticism.',
    themes: ['writing', 'culture'],
    action: 'save'
  })
];

function fixture(input: {
  id: string;
  title: string;
  text: string;
  themes: string[];
  action: Analysis['recommended_action'];
}): ReadingMemoryEvalFixture {
  const itemId = `fixture_${input.id}`;
  return {
    id: input.id,
    source: {
      sourceType: 'text',
      sourceUri: null,
      canonicalUrl: `https://example.test/${input.id}`,
      finalUrl: null,
      title: input.title,
      extractedText: input.text,
      truncated: false,
      contentHash: `sha256:fixture-${input.id}`,
      rawBytesHash: null,
      provenance: { source_context: 'eval_fixture' }
    },
    analysis: {
      summary: input.text,
      claims: [input.text],
      relevance: { score: 0.8, themes: input.themes },
      recommended_action: input.action,
      confidence: 0.85,
      reason: 'Synthetic eval fixture',
      tags: input.themes.map((theme) => ({ tag: theme, reason: 'eval fixture', confidence: 0.9 })),
      relationships: [],
      model: 'fixture/model',
      analysis_version: 'fixture-v1'
    }
  };
}
