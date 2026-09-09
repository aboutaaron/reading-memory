import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { buildReadingContext, READING_CONTEXT_LIMITS } from './reading-context.js';

function seed(db: Database, id: string, text: string, status = 'indexed') {
  db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', ?, '2026-09-01T00:00:00Z', ?, ?, ?)`).run(id, `Source ${id}`, id, status, text);
  db.prepare('INSERT INTO item_fts (item_id, title, body, summary, tags) VALUES (?, ?, ?, ?, ?)')
    .run(id, `Source ${id}`, text, '', '');
}

test('reading context is empty for an empty or unrelated corpus', () => {
  const db = openMemoryDatabase();
  const input = { itemId: 'current', title: null, text: 'Cache invalidation matters.' };
  assert.deepEqual(buildReadingContext(db, input).prior_items, []);
  seed(db, 'bread', 'Sourdough hydration produces oven spring.');
  assert.deepEqual(buildReadingContext(db, input).prior_items, []);
  assert.deepEqual(buildReadingContext(db, { ...input, text: 'Can you help me find the article?' }).prior_items, []);
});

test('reading context includes at most five indexed prior sources and excludes the current item', () => {
  const db = openMemoryDatabase();
  for (let i = 0; i < 8; i++) seed(db, `prior_${i}`, `Cache invalidation version ${i}.`);
  seed(db, 'current', 'Cache invalidation current item.');
  seed(db, 'failed', 'Cache invalidation failed source.', 'failed');
  const context = buildReadingContext(db, { itemId: 'current', title: 'Cache invalidation', text: 'Cache invalidation version rules.' });
  assert.equal(context.prior_items.length, READING_CONTEXT_LIMITS.priorItems);
  assert(context.prior_items.every((item) => item.item_id !== 'current' && item.item_id !== 'failed'));
});

test('source evidence is verbatim and can come from a relevant passage late in the source', () => {
  const db = openMemoryDatabase();
  const source = `${'Opening filler without the actual topic. '.repeat(200)}Cache invalidation requires checking the version before reuse. ${'Closing unrelated filler. '.repeat(100)}`;
  seed(db, 'prior', source);
  const context = buildReadingContext(db, { itemId: 'current', title: null, text: 'Cache invalidation version reuse.' });
  const passages = context.prior_items[0]!.source_passages;
  assert(passages.join('').includes('Cache invalidation requires checking the version before reuse.'));
  assert(passages.length <= READING_CONTEXT_LIMITS.sourcePassages);
  assert(passages.every((passage) => passage.length <= READING_CONTEXT_LIMITS.passageChars && source.includes(passage)));
});

test('reader context preserves attributed active notes with bounded caller and annotation fields', () => {
  const db = openMemoryDatabase();
  seed(db, 'prior', 'Cache invalidation is a hard problem.');
  const insert = db.prepare(`INSERT INTO reader_annotations (id, item_id, actor_type, actor, note, project, question, supersedes_annotation_id, created_at)
    VALUES (?, 'prior', ?, 'Aaron', ?, ?, ?, ?, ?)`);
  insert.run('old', 'user', 'I agree with this.', null, null, null, '2026-09-01T01:00:00Z');
  insert.run('new', 'user', 'I now disagree: '.repeat(100), 'project'.repeat(100), 'question'.repeat(100), 'old', '2026-09-02T01:00:00Z');
  insert.run('agent', 'agent', 'Agent interpretation, not user agreement.', null, null, null, '2026-09-02T02:00:00Z');
  const context = buildReadingContext(db, {
    itemId: 'current', title: null, text: 'Cache invalidation',
    readerContext: { source_context: 'caller'.repeat(1000), ingest_reason: 'reason'.repeat(1000) }
  });
  const annotations = context.prior_items[0]!.annotations;
  assert.deepEqual(annotations.map((annotation) => annotation.id), ['agent', 'new']);
  assert.equal(annotations[0]!.actor_type, 'agent');
  assert.equal(annotations[1]!.actor_type, 'user');
  assert.equal(annotations[1]!.actor, 'Aaron');
  assert.equal(annotations[1]!.note.length, READING_CONTEXT_LIMITS.noteChars);
  assert.equal(annotations[1]!.project!.length, READING_CONTEXT_LIMITS.projectChars);
  assert.equal(annotations[1]!.question!.length, READING_CONTEXT_LIMITS.questionChars);
  assert.equal(context.reader_context.source_context!.length, READING_CONTEXT_LIMITS.callerContextChars);
  assert.equal(context.reader_context.ingest_reason!.length, READING_CONTEXT_LIMITS.callerContextChars);
});
