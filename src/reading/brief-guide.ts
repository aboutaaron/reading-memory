import type { Database } from '../db/connection.js';

export function briefGuide(db: Database, input: { briefDate: string; lookbackHours?: number; focus?: string[] }) {
  const lookback = input.lookbackHours ?? 36;
  const briefAt = parseBriefDate(input.briefDate);
  const since = new Date(briefAt.getTime() - lookback * 60 * 60 * 1000).toISOString();
  const focus = input.focus ?? [];
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.title, i.source_uri, a.summary, a.relevance_json, a.confidence,
      be.event_kind AS latest_event_kind, be.brief_date AS latest_event_date, be.rationale AS latest_event_rationale,
      be.resurface_after AS latest_resurface_after
    FROM items i
    JOIN analyses a ON a.item_id = i.id
    LEFT JOIN brief_events be ON be.id = (
      SELECT id FROM brief_events
      WHERE item_id = i.id AND brief_date <= ?
      ORDER BY brief_date DESC, created_at DESC
      LIMIT 1
    )
    WHERE i.ingested_at >= ?
      AND (
        ? = 0 OR EXISTS (
          SELECT 1 FROM tags t
          WHERE t.item_id = i.id AND t.tag IN (${focus.map(() => '?').join(',') || "''"})
        )
      )
    ORDER BY a.confidence DESC, i.ingested_at DESC
    LIMIT 25
  `).all(input.briefDate, since, focus.length, ...focus) as Array<{
    item_id: string;
    title: string | null;
    source_uri: string | null;
    summary: string;
    relevance_json: string;
    confidence: number;
    latest_event_kind: string | null;
    latest_event_date: string | null;
    latest_event_rationale: string | null;
    latest_resurface_after: string | null;
  }>;

  const candidates = rows
    .map((row) => ({ row, relevance: JSON.parse(row.relevance_json) as { themes: string[]; score: number } }))
    .filter(({ row }) => isEligibleForBrief(row, input.briefDate))
    .slice(0, 8)
    .map(({ row, relevance }) => ({
      item_id: row.item_id,
      title: row.title,
      why_now: row.summary.slice(0, 240),
      themes: relevance.themes,
      suggested_lane: relevance.themes[0] ?? 'Reading Corpus',
      confidence: row.confidence,
      resurfacing_note: row.latest_event_kind ? resurfaceNote(row, input.briefDate) : null
    }));

  const skipped = rows
    .filter((row) => !candidates.some((candidate) => candidate.item_id === row.item_id))
    .slice(0, 10)
    .map((row) => ({ item_id: row.item_id, reason: skipReason(row, input.briefDate) }));

  return {
    brief_date: input.briefDate,
    candidates,
    theme_clusters: clusterThemes(candidates.flatMap((candidate) => candidate.themes)),
    skip_items: skipped
  };
}

type BriefRow = {
  latest_event_kind: string | null;
  latest_event_date: string | null;
  latest_event_rationale: string | null;
  latest_resurface_after: string | null;
};

function parseBriefDate(briefDate: string) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(briefDate) ? `${briefDate}T12:00:00.000Z` : briefDate;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid brief_date: ${briefDate}`);
  return parsed;
}

function isEligibleForBrief(row: BriefRow, briefDate: string) {
  if (!row.latest_event_kind) return true;
  if (row.latest_event_kind === 'included' && !hasResurfaced(row, briefDate)) return false;
  if (row.latest_resurface_after && row.latest_resurface_after > briefDate) return false;
  return true;
}

function hasResurfaced(row: BriefRow, briefDate: string) {
  return Boolean(row.latest_resurface_after && row.latest_resurface_after <= briefDate);
}

function skipReason(row: BriefRow, briefDate: string) {
  if (row.latest_resurface_after && row.latest_resurface_after > briefDate) {
    return `deferred until ${row.latest_resurface_after}`;
  }
  if (row.latest_event_kind === 'included' && !hasResurfaced(row, briefDate)) {
    return `recently included on ${row.latest_event_date}`;
  }
  return 'outside focus or lower confidence';
}

function resurfaceNote(row: BriefRow, briefDate: string) {
  if (hasResurfaced(row, briefDate)) return `resurfacing after ${row.latest_resurface_after}`;
  return row.latest_event_rationale ?? null;
}

function clusterThemes(themes: string[]) {
  const counts = new Map<string, number>();
  for (const theme of themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  return [...counts.entries()].map(([theme, count]) => ({ theme, count }));
}
