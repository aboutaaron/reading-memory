export type Tag = { tag: string; reason: string; confidence: number };
export type Relationship = {
  from_item_id: string;
  to_item_id: string;
  relation_type: string;
  explanation: string;
  confidence: number;
};
export type RelatedItem = {
  item_id: string;
  title: string | null;
  source_uri: string | null;
  score: number;
  match_reason: string;
};
export type Analysis = {
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
  truncated: boolean;
  contentHash: string;
  rawBytesHash: string | null;
  provenance: Record<string, unknown>;
};
