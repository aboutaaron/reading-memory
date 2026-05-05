import type { Database } from '../db/connection.js';

export function briefGuide(db: Database, input: { briefDate: string; lookbackHours?: number; focus?: string[] }) {
  const lookback = input.lookbackHours ?? 36;
  const since = new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.title, i.source_uri, a.summary, a.relevance_json, a.confidence
    FROM items i
    JOIN analyses a ON a.item_id = i.id
    WHERE i.ingested_at >= ?
    ORDER BY a.confidence DESC, i.ingested_at DESC
    LIMIT 25
  `).all(since) as Array<{
    item_id: string;
    title: string | null;
    source_uri: string | null;
    summary: string;
    relevance_json: string;
    confidence: number;
  }>;

  const focus = new Set(input.focus ?? []);
  const candidates = rows
    .map((row) => ({ row, relevance: JSON.parse(row.relevance_json) as { themes: string[]; score: number } }))
    .filter(({ relevance }) => focus.size === 0 || relevance.themes.some((theme) => focus.has(theme)))
    .slice(0, 8)
    .map(({ row, relevance }) => ({
      item_id: row.item_id,
      title: row.title,
      why_now: row.summary.slice(0, 240),
      themes: relevance.themes,
      suggested_lane: relevance.themes[0] ?? 'Reading Corpus',
      confidence: row.confidence
    }));

  const skipped = rows
    .filter((row) => !candidates.some((candidate) => candidate.item_id === row.item_id))
    .slice(0, 10)
    .map((row) => ({ item_id: row.item_id, reason: 'outside focus or lower confidence' }));

  return {
    brief_date: input.briefDate,
    candidates,
    theme_clusters: clusterThemes(candidates.flatMap((candidate) => candidate.themes)),
    skip_items: skipped
  };
}

function clusterThemes(themes: string[]) {
  const counts = new Map<string, number>();
  for (const theme of themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  return [...counts.entries()].map(([theme, count]) => ({ theme, count }));
}
