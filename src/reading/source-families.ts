import { createHash } from 'node:crypto';
import type { Database } from '../db/connection.js';

export type SourceFamily = {
  id: string;
  basis: 'canonical_url' | 'final_url' | 'source_uri' | 'explicit_lineage' | 'item';
  resolution: 'complete' | 'bounded_fallback';
};
type FamilyRow = {
  id: string; canonical_url: string | null; final_url: string | null;
  source_uri: string | null; supersedes_item_id: string | null;
};
const MAX_COMPONENT_ITEMS = 32;
const MAX_VISIBLE_ITEMS = 4096;

/** Deliberately retain query parameters, fragments, paths and schemes: none is presumed tracking noise. */
function sourceIdentity(row: FamilyRow): { key: string; basis: SourceFamily['basis'] } {
  for (const basis of ['canonical_url', 'final_url', 'source_uri'] as const) {
    try {
      const url = new URL(row[basis] ?? '');
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        return { key: `url:${url.href}`, basis };
      }
    } catch { /* An absent or invalid URL supplies no identity evidence. */ }
  }
  return { key: `item:${row.id}`, basis: 'item' };
}

/** Query-scoped identities; never infer identity from titles, text hashes or model labels.
 * A bounded visible snapshot lets URL equivalence and bidirectional lineage compose without
 * encounter-order-dependent representatives or repeatedly scanning the corpus per neighbor.
 */
export function sourceFamilyResolver(db: Database, filters: { since?: string; tags?: string[] } = {}) {
  const tags = filters.tags ?? [];
  const rows = db.prepare(`SELECT id, canonical_url, final_url, source_uri, supersedes_item_id FROM items i
    WHERE status = 'indexed' AND (? IS NULL OR ingested_at >= ?)
      AND (? = 0 OR EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i.id
        AND t.tag IN (${tags.map(() => '?').join(',') || "''"})))
    ORDER BY id LIMIT ?`).all(filters.since ?? null, filters.since ?? null, tags.length, ...tags,
      MAX_VISIBLE_ITEMS + 1) as FamilyRow[];
  const hash = (key: string) => `sf_${createHash('sha256').update(key).digest('hex')}`;
  const individual = (id: string, bounded: boolean): SourceFamily => ({ id: hash(`item:${id}`),
    basis: 'item', resolution: bounded ? 'bounded_fallback' : 'complete' });
  // Do not build partial lineage components when a bridge could be beyond the snapshot.
  // Keep direct URL equivalence useful for larger corpora, but explicitly label the incomplete
  // resolution: a URL change connected by lineage may remain in a separate family.
  if (rows.length > MAX_VISIBLE_ITEMS) {
    const find = db.prepare(`SELECT id, canonical_url, final_url, source_uri, supersedes_item_id FROM items i
      WHERE id = ? AND status = 'indexed' AND (? IS NULL OR ingested_at >= ?)
        AND (? = 0 OR EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i.id
          AND t.tag IN (${tags.map(() => '?').join(',') || "''"})))`);
    const cache = new Map<string, SourceFamily>();
    return (id: string): SourceFamily => {
      const known = cache.get(id);
      if (known) return known;
      const row = find.get(id, filters.since ?? null, filters.since ?? null, tags.length, ...tags) as FamilyRow | undefined;
      const identity = row ? sourceIdentity(row) : { key: `item:${id}`, basis: 'item' as const };
      const result: SourceFamily = { id: hash(identity.key), basis: identity.basis, resolution: 'bounded_fallback' };
      cache.set(id, result);
      return result;
    };
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const identities = new Map(rows.map(row => [row.id, sourceIdentity(row)]));
  const parent = new Map(rows.map(row => [row.id, row.id]));
  const root = (id: string): string => {
    let current = id;
    while (parent.get(current)! !== current) current = parent.get(current)!;
    return current;
  };
  const union = (a: string, b: string) => {
    const left = root(a), right = root(b);
    if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
  };
  const byIdentity = new Map<string, string>();
  for (const row of rows) {
    const key = identities.get(row.id)!.key;
    const existing = byIdentity.get(key);
    if (existing) union(row.id, existing);
    else byIdentity.set(key, row.id);
    if (row.supersedes_item_id && byId.has(row.supersedes_item_id)) union(row.id, row.supersedes_item_id);
  }
  const components = new Map<string, FamilyRow[]>();
  for (const row of rows) {
    const key = root(row.id);
    const members = components.get(key) ?? [];
    members.push(row);
    components.set(key, members);
  }
  const resolved = new Map<string, SourceFamily>();
  for (const members of components.values()) {
    let cyclic = false;
    if (members.length <= MAX_COMPONENT_ITEMS) {
      for (const row of members) {
        const visited = new Set<string>();
        let current: FamilyRow | undefined = row;
        while (current) {
          if (visited.has(current.id)) { cyclic = true; break; }
          visited.add(current.id);
          current = current.supersedes_item_id ? byId.get(current.supersedes_item_id) : undefined;
        }
        if (cyclic) break;
      }
    }
    if (members.length > MAX_COMPONENT_ITEMS || cyclic) {
      for (const row of members) resolved.set(row.id, individual(row.id, true));
      continue;
    }
    const keys = members.map(row => identities.get(row.id)!.key);
    // Prefer URL identity when any exists. IDs contain no ancestor/member identifiers.
    const key = (keys.filter(value => value.startsWith('url:')).sort()[0] ?? keys.sort()[0])!;
    const lineage = members.some(row => row.supersedes_item_id && byId.has(row.supersedes_item_id));
    for (const row of members) resolved.set(row.id, {
      id: hash(key), basis: lineage ? 'explicit_lineage' : identities.get(row.id)!.basis, resolution: 'complete'
    });
  }
  return (id: string): SourceFamily => resolved.get(id) ?? individual(id, false);
}
