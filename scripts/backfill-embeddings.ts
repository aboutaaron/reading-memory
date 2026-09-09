import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, transaction, type Database } from '../src/db/connection.js';
import { createEmbeddingProvider } from '../src/reading/embedding-provider.js';
import { embeddingHash, embeddingText, saveEmbedding, validateVector, type Embedder } from '../src/reading/embeddings.js';

export async function backfillEmbeddings(db: Database, embedder: Embedder, options: { apply?: boolean; limit?: number } = {}) {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer from 1 to 1000');
  const rows = db.prepare(`SELECT i.id, i.title, a.id AS analysis_id, a.summary, a.claims_json
    FROM items i JOIN analyses a ON a.id = (SELECT id FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
    LEFT JOIN item_embeddings e ON e.item_id = i.id
    WHERE i.status = 'indexed' AND (e.item_id IS NULL OR e.model <> ? OR e.analysis_id <> a.id)
    ORDER BY i.ingested_at, i.id LIMIT ?`).all(embedder.model, limit) as Array<{
      id: string; title: string | null; analysis_id: string; summary: string; claims_json: string
    }>;
  const outcomes: Array<{ item_id: string; status: string }> = [];
  for (const row of rows) {
    if (!options.apply) { outcomes.push({ item_id: row.id, status: 'would_embed' }); continue; }
    try {
      const text = embeddingText(row.title, { summary: row.summary, claims: JSON.parse(row.claims_json) });
      const vector = await embedder.embed(text, AbortSignal.timeout(5000));
      validateVector(vector);
      const applied = transaction(db, () => {
        const current = db.prepare(`SELECT i.title FROM items i WHERE i.id = ? AND i.status = 'indexed' AND
          (SELECT id FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1) = ?`)
          .get(row.id, row.analysis_id) as { title: string | null } | undefined;
        if (!current || current.title !== row.title) return false;
        saveEmbedding(db, row.id, row.analysis_id, { model: embedder.model, vector, inputHash: embeddingHash(text) });
        return Boolean(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ? AND model = ? AND analysis_id = ?')
          .get(row.id, embedder.model, row.analysis_id));
      });
      outcomes.push({ item_id: row.id, status: applied ? 'embedded' : 'changed_or_unavailable' });
    } catch { outcomes.push({ item_id: row.id, status: 'embedding_failed' }); }
  }
  return { mode: options.apply ? 'apply' : 'dry-run', model: embedder.model, outcomes };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run backfill:embeddings -- [--db PATH] [--limit N] [--apply]\nSet READING_API_EMBEDDING_MODEL=openai/text-embedding-3-small. Default is a read-only dry run; --apply sends title, summary and claims to the configured provider.');
    return;
  }
  const config = loadConfig();
  let dbPath = config.dbPath;
  let limit = 25;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--db' && args[i + 1]) dbPath = args[++i]!;
    else if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
    else throw new Error('Invalid arguments; use --help');
  }
  const model = config.embeddingModel;
  if (!model || model === 'off') throw new Error('Configure READING_API_EMBEDDING_MODEL first');
  const embedder = apply ? createEmbeddingProvider(model) : { model: model.includes('/') ? model : `openai/${model}`,
    async embed(): Promise<number[]> { throw new Error('Dry run cannot call provider'); } };
  if (!embedder) throw new Error('Embedding provider is unavailable; check model and credentials');
  const db = apply ? openDatabase(dbPath) : new DatabaseSync(dbPath, { readOnly: true });
  try { console.log(JSON.stringify(await backfillEmbeddings(db, embedder, { apply, limit }))); }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Embedding maintenance failed; check configuration, arguments, and database version.'); process.exitCode = 1; });
}
