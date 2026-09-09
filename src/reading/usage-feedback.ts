import type { Database } from '../db/connection.js';

// One as-of parameter. Counts describe recorded use, never agreement with a
// source. Event dates weight usefulness; created_at tells when use was recorded.
export const USAGE_SUMMARY_CTES = `
  usage_clock AS (SELECT julianday(?) AS now),
  usage_summary AS (
    SELECT item_id,
      SUM(CASE WHEN event_kind IN ('included', 'cited') THEN 1 ELSE 0 END) AS usage_count,
      MAX(CASE WHEN event_kind IN ('included', 'cited') THEN created_at END) AS last_used_at,
      SUM(CASE WHEN event_kind = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN event_kind IN ('included', 'cited') THEN 1.0 ELSE -1.0 END /
        (1.0 + MAX(0, c.now - julianday(brief_date)) / 30.0)) AS weighted_balance
    FROM brief_events CROSS JOIN usage_clock c
    WHERE event_kind IN ('included', 'cited', 'skipped')
      AND julianday(created_at) <= c.now AND julianday(brief_date) <= c.now
    GROUP BY item_id
  )`;

// Bounded multipliers preserve lexical relevance: usage contributes at most
// +/-20%, old unused low-relevance sources lose at most another 10%.
export const USAGE_BOOST_SQL = `0.2 * COALESCE(u.weighted_balance, 0) /
  (1.0 + ABS(COALESCE(u.weighted_balance, 0)))`;
export const UNUSED_DECAY_SQL = `CASE
  WHEN COALESCE(u.usage_count, 0) = 0 AND (
    SELECT json_extract(a.relevance_json, '$.score') FROM analyses a, usage_clock c
    WHERE a.item_id = i.id AND julianday(a.created_at) <= c.now
    ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1
  ) < 0.35 THEN 0.1 * MIN(1.0, MAX(0, ((SELECT now FROM usage_clock) - julianday(i.ingested_at) - 30) / 60.0))
  ELSE 0 END`;

export type UsageStats = { usage_count: number; last_used_at: string | null; skipped_count: number; weighted_balance: number };

export function getUsageStats(db: Database, itemId: string, asOf = new Date().toISOString()): UsageStats {
  return db.prepare(`WITH ${USAGE_SUMMARY_CTES}
    SELECT usage_count, last_used_at, skipped_count, weighted_balance
    FROM usage_summary WHERE item_id = ?`).get(asOf, itemId) as UsageStats | undefined
    ?? { usage_count: 0, last_used_at: null, skipped_count: 0, weighted_balance: 0 };
}
