export type Tag = { tag: string; reason: string; confidence: number };
export type Relationship = {
  from_item_id: string;
  to_item_id: string;
  relation_type: string;
  explanation: string;
  confidence: number;
  origin?: 'model' | 'heuristic';
  evidence?: { source_quote: string; target_quote: string };
};
export type RelatedItem = {
  item_id: string;
  title: string | null;
  source_uri: string | null;
  score: number;
  match_reason: string;
};
export type Analysis = {
  /** Transient optional index projection; never included in API snapshots. */
  embedding?: import('./embeddings.js').Embedding | null;
  summary: string;
  claims: string[];
  relevance: { score: number; themes: string[] };
  recommended_action: 'brief' | 'save' | 'skip';
  confidence: number;
  reason: string;
  tags: Tag[];
  relationships: Relationship[];
  model: string;
  analysis_version: string;
};

export type ExtractedSource = {
  sourceType: 'url' | 'text' | 'pdf_url';
  sourceUri: string | null;
  canonicalUrl: string | null;
  finalUrl: string | null;
  title: string | null;
  extractedText: string;
  author?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  truncated: boolean;
  contentHash: string;
  rawBytesHash: string | null;
  provenance: Record<string, unknown>;
};
