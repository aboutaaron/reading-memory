import type { Analysis, Relationship } from './types.js';
import type { Database } from '../db/connection.js';
import { LIMITS } from '../config.js';

const THEME_KEYWORDS: Record<string, string[]> = {
  'agent-memory': ['memory', 'corpus', 'recall', 'session', 'durable'],
  evaluation: ['eval', 'evaluation', 'benchmark', 'measure', 'judge'],
  'analytics-agents': ['analytics', 'metric', 'semantic', 'dashboard', 'bi'],
  'agent-infrastructure': ['agent', 'workflow', 'tool', 'orchestration', 'infrastructure'],
  'career-leverage': ['career', 'leadership', 'strategy', 'leverage', 'visibility']
};

export function analyzeItem(db: Database, item: { itemId: string; title: string | null; text: string }): Analysis {
  const lower = item.text.toLowerCase();
  const themes = Object.entries(THEME_KEYWORDS)
    .filter(([, words]) => words.some((word) => lower.includes(word)))
    .map(([theme]) => theme);

  const sentences = item.text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 5);
  const summary = sentences.slice(0, 3).join(' ').slice(0, 900) || 'No extractable summary.';
  const claims = sentences.slice(0, 5).map((sentence) => sentence.slice(0, 280));
  const score = Math.min(0.95, 0.45 + themes.length * 0.12 + Math.min(item.text.length / 50_000, 0.2));
  const recommended_action = score >= 0.75 ? 'brief' : score >= 0.55 ? 'save' : 'skip';

  return {
    summary,
    claims,
    relevance: { score, themes },
    recommended_action,
    confidence: Math.min(0.9, score),
    reason: themes.length ? `Matched themes: ${themes.join(', ')}` : 'Stored for recall; no strong theme match.',
    tags: themes.map((theme) => ({
      tag: theme,
      reason: 'Keyword/theme match in normalized text',
      confidence: 0.72
    })),
    relationships: findRelationships(db, item.itemId, themes),
    model: 'deterministic-v1',
    analysis_version: 'reading-api-v1'
  };
}

export function findRelationships(db: Database, itemId: string, themes: string[]): Relationship[] {
  if (themes.length === 0) return [];
  const rows = db.prepare(`
    SELECT DISTINCT i.id AS item_id, i.title AS title, group_concat(t.tag) AS tags
    FROM items i
    JOIN tags t ON t.item_id = i.id
    WHERE i.id <> ? AND t.tag IN (${themes.map(() => '?').join(',')})
    GROUP BY i.id
    ORDER BY i.ingested_at DESC
    LIMIT 10
  `).all(itemId, ...themes) as Array<{ item_id: string; title: string | null; tags: string }>;

  return rows.slice(0, LIMITS.relationshipsPerItem).map((row) => canonicalRelationship(itemId, row.item_id, {
    relation_type: 'same_theme',
    explanation: `Shares reading themes: ${row.tags}`,
    confidence: LIMITS.relationshipMinConfidence
  }));
}

export function canonicalRelationship(
  a: string,
  b: string,
  data: { relation_type: string; explanation: string; confidence: number }
): Relationship {
  if (data.relation_type === 'same_theme' && a.localeCompare(b) > 0) {
    return { from_item_id: b, to_item_id: a, ...data };
  }
  return { from_item_id: a, to_item_id: b, ...data };
}
