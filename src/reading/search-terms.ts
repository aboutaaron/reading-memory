// Conversational scaffolding should not outweigh the subject someone wants to recall.
// Keep short domain terms such as AI, ML, BI, and UI: length is not relevance.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'ours',
  's', 'she', 'should', 'so', 'some', 't', 'than', 'that', 'the', 'their',
  'them', 'there', 'these', 'they', 'this', 'those', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
  'about', 'article', 'articles', 'find', 'help', 'looking', 'please',
  'read', 'reading', 'recall', 'remember', 'remind', 'show', 'something', 'tell'
]);

/** Shared lexical terms for recall and related-item retrieval, not semantic expansion. */
export function extractSearchTerms(
  values: string | Array<string | null | undefined>,
  maxTerms = 64
): string[] {
  const seen = new Set<string>();
  for (const value of typeof values === 'string' ? [values] : values) {
    // Match FTS's word-oriented behavior: a hyphen separates words, never operators.
    const words = String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
    for (const word of words) {
      if (STOP_WORDS.has(word)) continue;
      seen.add(word);
    }
  }
  return [...seen].slice(0, Math.max(0, maxTerms));
}

/** Rank source terms over the whole article; equal counts retain first-seen order. */
export function extractFrequentSearchTerms(text: string, maxTerms = 64): string[] {
  const counts = new Map<string, { count: number; firstSeen: number }>();
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    const existing = counts.get(word);
    if (existing) existing.count++;
    else counts.set(word, { count: 1, firstSeen: counts.size });
  }
  return [...counts]
    .sort(([, a], [, b]) => b.count - a.count || a.firstSeen - b.firstSeen)
    .slice(0, Math.max(0, maxTerms))
    .map(([word]) => word);
}

/** Quote each lexical term so user text can never introduce FTS operators. */
export function toFtsQuery(terms: string[], operator: 'AND' | 'OR' = 'OR'): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(` ${operator} `);
}
