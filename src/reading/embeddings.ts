import { createHash } from 'node:crypto';
import type { Database } from '../db/connection.js';
import type { Analysis } from './types.js';

export const EMBEDDING_DIMENSIONS = 1536;
export type Embedding = { model: string; vector: number[]; inputHash: string };
export type Embedder = { model: string; embed(text: string, signal?: AbortSignal): Promise<number[]> };
const vectorConnections = new WeakSet<Database>();
// Keep deletion available even when startup disables querying after a failed rebuild.
const initializedVectorConnections = new WeakSet<Database>();

export function enableVectorIndex(db: Database) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS item_vec USING vec0(
    item_id TEXT PRIMARY KEY, embedding float[1536] distance_metric=cosine
  )`);
  initializedVectorConnections.add(db);
  vectorConnections.add(db);
}

export function disableVectorIndex(db: Database) { vectorConnections.delete(db); }

export function vectorIndexAvailable(db: Database) { return vectorConnections.has(db); }

export function embeddingText(title: string | null, analysis: Pick<Analysis, 'summary' | 'claims'>) {
  return [title ?? '', analysis.summary, ...analysis.claims].join('\n').slice(0, 16_000);
}

export function embeddingHash(text: string) { return createHash('sha256').update(text).digest('hex'); }

export function validateVector(vector: number[]) {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some(x => !Number.isFinite(x) || !Number.isFinite(Math.fround(x)))
    || !vector.some(x => Math.fround(x) !== 0)) throw new Error('Invalid embedding vector');
  const norm = Math.hypot(...vector);
  return new Uint8Array(new Float32Array(vector.map(value => value / norm)).buffer);
}

/** Optional indexing must never make a successful analysis fail. No provider errors escape. */
export async function embedAnalysis(embedder: Embedder | null, title: string | null, analysis: Analysis,
  signal?: AbortSignal): Promise<Embedding | null> {
  if (!embedder) return null;
  try {
    const text = embeddingText(title, analysis);
    const vector = await embedder.embed(text, signal);
    validateVector(vector);
    return { model: embedder.model, vector, inputHash: embeddingHash(text) };
  } catch { return null; }
}

/** Caller owns the transaction. Clear canonical and any accessible derived projection. */
export function deleteEmbedding(db: Database, itemId: string) {
  db.prepare('DELETE FROM item_embeddings WHERE item_id = ?').run(itemId);
  if (!initializedVectorConnections.has(db)) return;
  db.exec('SAVEPOINT optional_embedding_delete');
  try {
    db.prepare('DELETE FROM item_vec WHERE item_id = ?').run(itemId);
    db.exec('RELEASE optional_embedding_delete');
  } catch {
    db.exec('ROLLBACK TO optional_embedding_delete');
    db.exec('RELEASE optional_embedding_delete');
    // A damaged derived index must not block canonical analysis updates or forgetting.
    // All vector candidates also join canonical embeddings, so removed projections stay excluded.
    disableVectorIndex(db);
  }
}

/** Called inside the analysis transaction, after the new analyses row exists. */
export function saveEmbedding(db: Database, itemId: string, analysisId: string, embedding: Embedding | null) {
  deleteEmbedding(db, itemId);
  if (!embedding) return;
  db.exec('SAVEPOINT optional_embedding');
  try {
    const bytes = validateVector(embedding.vector);
    db.prepare(`INSERT INTO item_embeddings(item_id, analysis_id, model, dimensions, input_hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId, analysisId, embedding.model, EMBEDDING_DIMENSIONS,
      embedding.inputHash, bytes, new Date().toISOString());
    if (vectorIndexAvailable(db)) db.prepare('INSERT INTO item_vec(item_id, embedding) VALUES (?, ?)').run(itemId, bytes);
    db.exec('RELEASE optional_embedding');
  } catch {
    db.exec('ROLLBACK TO optional_embedding');
    db.exec('RELEASE optional_embedding');
  }
}

/** Rebuild only the derived vec0 table; canonical vectors remain ordinary SQLite rows. */
export function rebuildVectorIndex(db: Database) {
  if (!vectorIndexAvailable(db)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM item_vec');
    const rows = db.prepare(`SELECT e.item_id, e.embedding FROM item_embeddings e JOIN items i ON i.id = e.item_id
      WHERE i.status = 'indexed' AND e.dimensions = ? AND e.analysis_id =
        (SELECT id FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1)`)
      .all(EMBEDDING_DIMENSIONS) as Array<{ item_id: string; embedding: Uint8Array }>;
    const insert = db.prepare('INSERT INTO item_vec(item_id, embedding) VALUES (?, ?)');
    for (const row of rows) insert.run(row.item_id, row.embedding);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export type VectorHit = { item_id: string; title: string | null; source_uri: string | null; snippet: string; distance: number };
export function vectorNeighbors(db: Database, vector: number[], model: string, options: {
  topK?: number; since?: string; tags?: string[]; excludeItemId?: string
} = {}): VectorHit[] {
  if (!vectorIndexAvailable(db)) return [];
  const tags = options.tags ?? [];
  const hits = db.prepare(`SELECT v.item_id, i.title, i.source_uri, substr(a.summary, 1, 400) AS snippet, v.distance
    FROM item_vec v JOIN items i ON i.id = v.item_id
    JOIN item_embeddings e ON e.item_id = i.id JOIN analyses a ON a.id = e.analysis_id
    WHERE v.embedding MATCH ? AND k = ? AND v.item_id IN (
      SELECT i2.id FROM items i2 JOIN item_embeddings e2 ON e2.item_id = i2.id
      WHERE i2.status = 'indexed' AND e2.model = ? AND e2.analysis_id =
        (SELECT id FROM analyses WHERE item_id = i2.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
      AND (? IS NULL OR i2.ingested_at >= ?) AND (? IS NULL OR i2.id <> ?)
      AND (? = 0 OR EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i2.id AND t.tag IN (${tags.map(() => '?').join(',') || "''"})))
    ) ORDER BY v.distance`)
    .all(validateVector(vector), Math.min(100, options.topK ?? 25), model,
      options.since ?? null, options.since ?? null, options.excludeItemId ?? null, options.excludeItemId ?? null,
      tags.length, ...tags) as VectorHit[];
  return hits.filter(hit => Number.isFinite(hit.distance)).sort((a, b) => a.distance - b.distance || a.item_id.localeCompare(b.item_id));
}

export function embeddingHealth(db: Database, model: string | null) {
  const { count } = db.prepare(`SELECT count(*) AS count FROM items i WHERE i.status = 'indexed' AND NOT EXISTS (
    SELECT 1 FROM item_embeddings e WHERE e.item_id = i.id AND (? IS NULL OR e.model = ?)
    AND e.analysis_id = (SELECT id FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  )`).get(model, model) as { count: number };
  return { enabled: model !== null, model, dimensions: EMBEDDING_DIMENSIONS,
    vector_index: vectorIndexAvailable(db) ? 'available' : 'unavailable', missing_items: count };
}
