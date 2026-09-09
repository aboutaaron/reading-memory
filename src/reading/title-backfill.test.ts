import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillTitles, inferStoredHeading } from '../../scripts/backfill-titles.js';
import { openMemoryDatabase } from '../db/connection.js';

test('infers only explicit stored heading syntax and skips ambiguous text', () => {
  assert.equal(inferStoredHeading('# Durable Reading\n\nEvidence below.'), 'Durable Reading');
  assert.equal(inferStoredHeading('Durable Reading\n===============\nEvidence below.'), 'Durable Reading');
  assert.equal(inferStoredHeading('This sentence is the start of an article.\n\nEvidence below.'), null);
  assert.equal(inferStoredHeading('A Plausible Title\n\nBut no explicit heading syntax.'), null);
  assert.equal(inferStoredHeading('# https://example.com/article'), null);
});

test('title maintenance is read-only by default and applies inferred provenance with FTS updates', () => {
  const db = openMemoryDatabase();
  try {
    const insert = db.prepare("INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text, provenance_json) VALUES (?, 'text', ?, '2026-09-01T00:00:00Z', ?, 'indexed', ?, ?)");
    insert.run('heading', null, 'heading-hash', '# Durable Reading\n\nKeep the evidence.', '{"ingest_reason":"Research"}');
    insert.run('prose', null, 'prose-hash', 'This is the first paragraph of the source.', '{}');
    insert.run('titled', 'Explicit title', 'titled-hash', '# Another heading', '{}');
    const originalChanges = db.prepare('SELECT total_changes() AS count').get();
    const report = backfillTitles(db);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.scanned, 2);
    assert.equal(report.eligible, 1);
    assert.equal(report.applied, 0);
    assert.deepEqual(report.proposals, [{ item_id: 'heading', proposed_title: 'Durable Reading', title_source: 'inferred-stored-heading' }]);
    assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), originalChanges);
    assert.equal((db.prepare('SELECT title FROM items WHERE id = ?').get('heading') as { title: string | null }).title, null);

    const applied = backfillTitles(db, true);
    assert.equal(applied.applied, 1);
    const row = db.prepare('SELECT title, provenance_json FROM items WHERE id = ?').get('heading') as { title: string; provenance_json: string };
    assert.equal(row.title, 'Durable Reading');
    const provenance = JSON.parse(row.provenance_json);
    assert.equal(provenance.ingest_reason, 'Research');
    assert.equal(provenance.title_source, 'inferred-stored-heading');
    assert.equal(provenance.title_backfill.inferred, true);
    assert.equal((db.prepare('SELECT title FROM item_fts WHERE item_id = ?').get('heading') as { title: string }).title, 'Durable Reading');
    assert.equal((db.prepare('SELECT title FROM items WHERE id = ?').get('titled') as { title: string }).title, 'Explicit title');
    assert.equal(backfillTitles(db, true).applied, 0);
  } finally { db.close(); }
});
