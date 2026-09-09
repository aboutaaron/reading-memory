import type { Database } from '../db/connection.js';

const CANDIDATE_LIMIT = 8;
const SKIP_LIMIT = 10;

export function briefGuide(db: Database, input: { briefDate: string; lookbackHours?: number; focus?: string[] }) {
  // A date describes the complete UTC day, including late arrivals. The upper
  // bound is exclusive so a historical brief cannot select tomorrow's reading.
  const until = briefDayEnd(input.briefDate);
  const since = new Date(until.getTime() - (input.lookbackHours ?? 36) * 60 * 60 * 1000).toISOString();
  const focus = input.focus ?? [];
  const rows = db.prepare(`
    WITH params AS (
      SELECT ? AS brief_date, ? AS until, ? AS since, ? AS focus
    ), event_history AS (
      SELECT be.*, ROW_NUMBER() OVER (
        PARTITION BY be.item_id ORDER BY be.brief_date DESC, be.created_at DESC, be.rowid DESC
      ) AS event_order
      FROM brief_events be, params p
      WHERE be.brief_date <= p.brief_date AND be.event_kind <> 'cited'
    ), event_positions AS (
      SELECT item_id,
        MIN(CASE WHEN event_kind IN ('included', 'resurfaced') THEN event_order END) AS consumed_order,
        MIN(CASE WHEN resurface_after IS NOT NULL THEN event_order END) AS scheduled_order
      FROM event_history GROUP BY item_id
    ), brief_outcomes AS (
      -- Multiple contexts in one brief date are one decision; any actual brief
      -- use on that date interrupts a run of skipped briefs.
      SELECT item_id, brief_date,
        MAX(CASE WHEN event_kind IN ('included', 'resurfaced') THEN 1 ELSE 0 END) AS used
      FROM event_history GROUP BY item_id, brief_date
    ), dated_outcomes AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY brief_date DESC) AS day_order
      FROM brief_outcomes
    ), skip_streaks AS (
      SELECT item_id, COALESCE(MIN(CASE WHEN used = 1 THEN day_order END) - 1, COUNT(*)) AS consecutive_skips
      FROM dated_outcomes GROUP BY item_id
    ), item_state AS (
      SELECT i.id AS item_id, i.title, i.source_uri, i.canonical_url, i.final_url, i.ingested_at,
        a.relevance_json, a.recommended_action, a.confidence, a.reason,
        COALESCE(streak.consecutive_skips, 0) AS consecutive_skips,
        COALESCE(json_extract(a.relevance_json, '$.score'), 0) AS relevance_score,
        latest.event_kind AS latest_event_kind, latest.rationale AS latest_event_rationale,
        consumed.event_kind AS consumed_kind, consumed.brief_date AS consumed_date,
        CASE WHEN scheduled.event_order < consumed.event_order OR consumed.event_order IS NULL
          OR (scheduled.event_order = consumed.event_order AND scheduled.resurface_after > consumed.brief_date)
          THEN scheduled.resurface_after END AS resurface_after,
        CASE WHEN scheduled.event_order < consumed.event_order OR consumed.event_order IS NULL
          OR (scheduled.event_order = consumed.event_order AND scheduled.resurface_after > consumed.brief_date)
          THEN scheduled.rationale END AS resurface_rationale,
        (
          SELECT tag FROM tags t
          WHERE t.item_id = i.id AND (json_array_length(p.focus) = 0 OR t.tag IN (SELECT value FROM json_each(p.focus)))
          ORDER BY t.confidence DESC, t.tag ASC LIMIT 1
        ) AS matching_tag
      FROM items i CROSS JOIN params p
      JOIN analyses a ON a.id = (
        SELECT id FROM analyses
        WHERE item_id = i.id AND created_at < p.until
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      )
      LEFT JOIN event_positions ep ON ep.item_id = i.id
      LEFT JOIN skip_streaks streak ON streak.item_id = i.id
      LEFT JOIN event_history latest ON latest.item_id = i.id AND latest.event_order = 1
      LEFT JOIN event_history consumed ON consumed.item_id = i.id AND consumed.event_order = ep.consumed_order
      LEFT JOIN event_history scheduled ON scheduled.item_id = i.id AND scheduled.event_order = ep.scheduled_order
      WHERE i.status = 'indexed' AND i.ingested_at < p.until
        AND (json_array_length(p.focus) = 0 OR EXISTS (
          SELECT 1 FROM tags t WHERE t.item_id = i.id AND t.tag IN (SELECT value FROM json_each(p.focus))
        ))
    ), considered AS (
      SELECT s.*, CASE WHEN resurface_after <= p.brief_date THEN 1 ELSE 0 END AS is_due,
        CASE
          WHEN resurface_after > p.brief_date THEN 'deferred until ' || resurface_after
          WHEN consumed_kind IS NOT NULL AND resurface_after IS NULL
            THEN 'recently ' || consumed_kind || ' on ' || consumed_date
          WHEN recommended_action = 'skip' AND (resurface_after IS NULL OR resurface_after > p.brief_date)
            THEN 'analysis recommends skip'
          ELSE NULL
        END AS skip_reason
      FROM item_state s CROSS JOIN params p
      WHERE ingested_at >= p.since OR resurface_after IS NOT NULL
    ), weighted AS (
      SELECT *, CASE WHEN consecutive_skips >= 3 AND is_due = 0 THEN 1 ELSE 0 END AS feedback_demoted,
        confidence * CASE WHEN consecutive_skips >= 3 AND is_due = 0 THEN 0.5 ELSE 1 END AS effective_confidence
      FROM considered
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY skip_reason IS NULL
        ORDER BY is_due DESC, feedback_demoted ASC,
          CASE recommended_action WHEN 'brief' THEN 0 WHEN 'save' THEN 1 ELSE 2 END,
          relevance_score DESC, effective_confidence DESC, ingested_at DESC, item_id ASC
      ) AS selection_rank
      FROM weighted
    ), output AS (
      SELECT *, CASE WHEN skip_reason IS NULL AND selection_rank <= ? THEN 1 ELSE 0 END AS selected
      FROM ranked
    )
    SELECT * FROM output WHERE selected = 1
    UNION ALL
    SELECT * FROM (
      SELECT * FROM output WHERE selected = 0
      ORDER BY skip_reason IS NULL DESC, selection_rank ASC, item_id ASC LIMIT ?
    )
    ORDER BY selected DESC, selection_rank ASC, item_id ASC
  `).all(input.briefDate, until.toISOString(), since, JSON.stringify(focus), CANDIDATE_LIMIT, SKIP_LIMIT) as BriefRow[];

  const candidates = rows.filter((row) => row.selected === 1).map((row) => {
    const relevance = JSON.parse(row.relevance_json) as { themes?: string[] };
    const themes = relevance.themes ?? [];
    return {
      item_id: row.item_id,
      title: row.title,
      source_uri: row.source_uri,
      canonical_url: row.canonical_url,
      final_url: row.final_url,
      why_now: whyNow(row, focus.length > 0),
      themes,
      suggested_lane: row.matching_tag ?? themes[0] ?? 'Reading Corpus',
      relevance_score: row.relevance_score,
      recommended_action: row.recommended_action,
      confidence: row.confidence,
      effective_confidence: row.effective_confidence,
      consecutive_skips: row.consecutive_skips,
      resurfacing_note: row.is_due
        ? `resurfacing after ${row.resurface_after}`
        : row.latest_event_rationale
    };
  });

  return {
    brief_date: input.briefDate,
    candidates,
    theme_clusters: clusterThemes(candidates.flatMap((candidate) => candidate.themes)),
    skip_items: rows.filter((row) => row.selected === 0).map((row) => ({
      item_id: row.item_id,
      reason: row.skip_reason ?? (row.feedback_demoted
        ? `lower priority after ${row.consecutive_skips} consecutive skipped briefs`
        : 'lower priority after scheduled items, brief recommendation, and relevance')
    }))
  };
}

type BriefRow = {
  item_id: string;
  title: string | null;
  source_uri: string | null;
  canonical_url: string | null;
  final_url: string | null;
  relevance_json: string;
  relevance_score: number;
  recommended_action: string;
  confidence: number;
  effective_confidence: number;
  consecutive_skips: number;
  feedback_demoted: number;
  reason: string | null;
  matching_tag: string | null;
  latest_event_rationale: string | null;
  resurface_after: string | null;
  resurface_rationale: string | null;
  is_due: number;
  skip_reason: string | null;
  selected: number;
};

function briefDayEnd(briefDate: string) {
  const start = new Date(`${briefDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(briefDate) || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== briefDate) {
    throw new Error(`Invalid brief_date: ${briefDate}`);
  }
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function whyNow(row: BriefRow, focused: boolean) {
  const selection = row.is_due
    ? `Scheduled to resurface on ${row.resurface_after}${row.recommended_action === 'skip' ? '; the explicit schedule overrides the analysis skip recommendation' : ''}.`
    : row.recommended_action === 'brief'
      ? 'Recent reading recommended for a brief.'
      : 'Recent saved reading eligible for a brief.';
  const focus = focused && row.matching_tag ? ` Matches focus: ${row.matching_tag}.` : '';
  const feedback = row.feedback_demoted ? ` Lower priority after ${row.consecutive_skips} consecutive skipped briefs; effective confidence halved.` : '';
  const rationale = row.is_due ? row.resurface_rationale : row.reason;
  return `${selection}${focus}${feedback} ${rationale?.trim() || 'The original analysis rationale was not recorded.'}`.slice(0, 600);
}

function clusterThemes(themes: string[]) {
  const counts = new Map<string, number>();
  for (const theme of themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  return [...counts.entries()].map(([theme, count]) => ({ theme, count }));
}
