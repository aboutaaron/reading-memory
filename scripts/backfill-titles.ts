import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { configureDatabase, rebuildItemFts, transaction, type Database } from '../src/db/connection.js';
import { CURRENT_USER_VERSION } from '../src/db/migrations.js';
import { cleanMetadata } from '../src/ingest/extract-html.js';

export function inferStoredHeading(text: string): string | null {
  const lines = text.trimStart().split(/\r?\n/, 3);
  const first = lines[0]?.trim() ?? '';
  const markdown = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(first)?.[1];
  const setext = /^(?:={3,}|-{3,})\s*$/.test(lines[1] ?? '') ? first : null;
  const heading = markdown ?? setext;
  // Plain first sentences, filenames, URL slugs, and model guesses are not
  // evidence of a title. Only explicit stored heading syntax is eligible.
  if (!heading || heading.length < 3 || heading.length > 200 || /https?:\/\/|@/.test(heading)) return null;
  return cleanMetadata(heading, 200);
}

export function backfillTitles(db: Database, apply = false) {
  const rows = db.prepare("SELECT id, extracted_text, provenance_json FROM items WHERE title IS NULL OR trim(title) = '' ORDER BY ingested_at, id").all() as Array<{ id: string; extracted_text: string; provenance_json: string }>;
  const proposed: Array<{ item_id: string; proposed_title: string; provenance: Record<string, unknown> }> = [];
  const skipped: Array<{ item_id: string; reason: string }> = [];
  for (const row of rows) {
    const title = inferStoredHeading(row.extracted_text);
    if (!title) { skipped.push({ item_id: row.id, reason: 'no_explicit_stored_heading' }); continue; }
    let provenance: unknown;
    try { provenance = JSON.parse(row.provenance_json); } catch { provenance = null; }
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
      skipped.push({ item_id: row.id, reason: 'invalid_provenance' });
      continue;
    }
    proposed.push({ item_id: row.id, proposed_title: title, provenance: provenance as Record<string, unknown> });
  }
  let applied = 0;
  if (apply && proposed.length) {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== CURRENT_USER_VERSION) throw new Error('Start the updated service to migrate the database before applying title maintenance');
    transaction(db, () => {
      const update = db.prepare("UPDATE items SET title = ?, provenance_json = ? WHERE id = ? AND (title IS NULL OR trim(title) = '')");
      for (const candidate of proposed) {
        const provenance = {
          ...candidate.provenance,
          title_source: 'inferred-stored-heading',
          title_backfill: { version: 1, inferred: true, source: 'stored_text', applied_at: new Date().toISOString() }
        };
        const result = update.run(candidate.proposed_title, JSON.stringify(provenance), candidate.item_id);
        if (Number(result.changes) > 0) {
          db.prepare('DELETE FROM item_embeddings WHERE item_id = ?').run(candidate.item_id);
          rebuildItemFts(db, candidate.item_id); applied++;
        }
      }
    });
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    scanned: rows.length,
    eligible: proposed.length,
    applied,
    proposals: proposed.map(({ item_id, proposed_title }) => ({ item_id, proposed_title, title_source: 'inferred-stored-heading' })),
    skipped
  };
}

/** Dry runs stay read-only; writes use the service's timeout and FK settings. */
export function openTitleMaintenanceDatabase(dbPath: string, apply = false): Database {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    if (apply) configureDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run backfill:titles -- [--db PATH] [--apply]\nDefaults to a read-only dry run. Uses stored explicit headings only; never refetches URLs.');
    return;
  }
  let dbPath = loadConfig().dbPath;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--db' && args[index + 1] && !args[index + 1]?.startsWith('--')) dbPath = args[++index] as string;
    else throw new Error('Expected --db PATH or --apply; use --help for usage');
  }
  // Opening an existing database directly avoids migrations and FTS writes in
  // dry-run mode. No sources are fetched or analyzed by this maintenance task.
  const db = openTitleMaintenanceDatabase(dbPath, apply);
  try { console.log(JSON.stringify(backfillTitles(db, apply), null, 2)); }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
