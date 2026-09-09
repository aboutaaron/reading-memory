import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../api/errors.js';
import type { AnnotationRequest } from '../api/contracts.js';
import { openDatabase, openMemoryDatabase, type Database } from '../db/connection.js';
import { listReaderAnnotations, ReaderAnnotationStore } from './reader-annotations.js';

function seedItem(db: Database, id = 'item_one') {
  db.prepare(`
    INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text, truncated, provenance_json)
    VALUES (?, 'text', 'Source article', '2026-09-01T00:00:00.000Z', ?, 'indexed', 'Source evidence.', 0, '{}')
  `).run(id, `sha256:${id}`);
}

function input(requestId: string, overrides: Partial<AnnotationRequest> = {}, itemId = 'item_one') {
  return {
    principal: 'token:test',
    requestId,
    itemId,
    body: {
      request_id: requestId,
      actor_type: 'user' as const,
      actor: 'Aaron',
      note: 'I disagree with the conclusion.',
      ...overrides
    }
  };
}

function expectError(status: number, code: ApiError['code']) {
  return (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;
}

function matches(db: Database, term: string) {
  return db.prepare('SELECT item_id FROM item_fts WHERE item_fts MATCH ?').all(term)
    .map((row) => row.item_id);
}

test('preserves the exact reader statement, separates agent interpretation, and logs metadata only', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  const store = new ReaderAnnotationStore(db);
  const note = '  I disagree.\n\nThis does not resolve my concern.  ';
  const first = store.record(input('req-user', { note, project: 'Personal project', question: 'My private question?' }));
  const second = store.record(input('req-agent', { actor_type: 'agent', actor: 'Reading assistant', note: 'Possible interpretation.' }));

  assert.equal(first.annotation.note, note);
  const history = listReaderAnnotations(db, 'item_one');
  assert.deepEqual(history.map((entry) => [entry.id, entry.actor_type, entry.actor, entry.active]), [
    [first.annotation.id, 'user', 'Aaron', true],
    [second.annotation.id, 'agent', 'Reading assistant', true]
  ]);
  assert.equal(history[0]?.question, 'My private question?');
  assert.equal(history[0]?.project, 'Personal project');
  const logs = db.prepare('SELECT metadata_json FROM activity_log ORDER BY id').all();
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(logs[0]?.metadata_json as string), {
    annotation_id: first.annotation.id, actor_type: 'user', supersedes_annotation_id: null
  });
  for (const privateText of [note, 'Aaron', 'Personal project', 'My private question?', 'Reading assistant']) {
    assert.equal(JSON.stringify(logs).includes(privateText), false);
  }
});

test('idempotent replay does not duplicate annotation, FTS entries, or activity logs', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  const store = new ReaderAnnotationStore(db);
  const first = store.record(input('req-one', { note: 'Distinctive quokkamemory marker.' }));
  const second = new ReaderAnnotationStore(db).record(input('req-one', { note: 'Distinctive quokkamemory marker.' }));
  assert.deepEqual(second, { ...first, dedupe_status: 'idempotent_replay' });
  assert.equal(listReaderAnnotations(db, 'item_one').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()?.n, 1);
  assert.deepEqual(matches(db, 'quokkamemory'), ['item_one']);
});

test('idempotency conflicts include changed fields, target item, and another operation sharing the key', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  seedItem(db, 'item_two');
  const store = new ReaderAnnotationStore(db);
  store.record(input('req-one'));
  for (const changes of [
    { note: 'Changed statement.' }, { actor: 'Someone else' }, { actor_type: 'agent' as const },
    { project: 'Another project' }, { question: 'Another question?' }, { supersedes_annotation_id: 'annotation_missing' }
  ]) {
    assert.throws(() => store.record(input('req-one', changes)), expectError(409, 'IDEMPOTENCY_CONFLICT'));
  }
  assert.throws(() => store.record(input('req-one', {}, 'item_two')), expectError(409, 'IDEMPOTENCY_CONFLICT'));

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO idempotency_keys (principal, request_id, payload_hash, item_id, response_snapshot, created_at, expires_at)
    VALUES ('token:test', 'req-ingest', 'sha256:ingest-operation', 'item_one', '{}', ?, ?)
  `).run(now, new Date(Date.now() + 86_400_000).toISOString());
  assert.throws(() => store.record(input('req-ingest')), expectError(409, 'IDEMPOTENCY_CONFLICT'));
  assert.equal(listReaderAnnotations(db, 'item_one').length, 1);
  assert.equal(listReaderAnnotations(db, 'item_two').length, 0);
});

test('rejects missing items and missing or cross-item correction targets without saving side effects', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  seedItem(db, 'item_two');
  const store = new ReaderAnnotationStore(db);
  const first = store.record(input('req-first'));
  assert.throws(() => store.record(input('req-missing-item', {}, 'item_missing')), expectError(404, 'NOT_FOUND'));
  assert.throws(() => store.record(input('req-missing-annotation', { supersedes_annotation_id: 'annotation_missing' })), expectError(404, 'NOT_FOUND'));
  assert.throws(() => store.record(input('req-wrong-item', { supersedes_annotation_id: first.annotation.id }, 'item_two')), expectError(400, 'BAD_REQUEST'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reader_annotations').get()?.n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()?.n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()?.n, 1);
});

test('corrections retain immutable history and atomically replace searchable reader context', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  const store = new ReaderAnnotationStore(db);
  const first = store.record(input('req-first', { note: 'Old axolotlclaim.', project: 'Oldprojectmarker', question: 'Oldquestionmarker?' }));
  assert.deepEqual(matches(db, 'axolotlclaim'), ['item_one']);
  const originalRow = db.prepare('SELECT * FROM reader_annotations WHERE id = ?').get(first.annotation.id);
  const correction = store.record(input('req-correction', {
    note: 'New pangolinclaim.',
    project: 'Newprojectmarker',
    question: 'Newquestionmarker?',
    supersedes_annotation_id: first.annotation.id
  }));
  assert.deepEqual(db.prepare('SELECT * FROM reader_annotations WHERE id = ?').get(first.annotation.id), originalRow);
  assert.deepEqual(listReaderAnnotations(db, 'item_one').map((entry) => [entry.id, entry.active]), [
    [first.annotation.id, false], [correction.annotation.id, true]
  ]);
  for (const oldTerm of ['axolotlclaim', 'Oldprojectmarker', 'Oldquestionmarker']) assert.deepEqual(matches(db, oldTerm), []);
  for (const newTerm of ['pangolinclaim', 'Newprojectmarker', 'Newquestionmarker']) assert.deepEqual(matches(db, newTerm), ['item_one']);

  assert.throws(() => store.record(input('req-competing-correction', {
    note: 'Conflicting toucanclaim.', supersedes_annotation_id: first.annotation.id
  })), expectError(409, 'IDEMPOTENCY_CONFLICT'));
  assert.equal(listReaderAnnotations(db, 'item_one').length, 2);
  assert.deepEqual(matches(db, 'toucanclaim'), []);
  const next = store.record(input('req-next-correction', { note: 'Final wombatclaim.', supersedes_annotation_id: correction.annotation.id }));
  assert.deepEqual(listReaderAnnotations(db, 'item_one').map((entry) => [entry.id, entry.active]), [
    [first.annotation.id, false], [correction.annotation.id, false], [next.annotation.id, true]
  ]);
  assert.deepEqual(matches(db, 'pangolinclaim'), []);
  assert.deepEqual(matches(db, 'wombatclaim'), ['item_one']);
});

test('corrections and their search index survive a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reading-annotations-'));
  const dbPath = join(directory, 'reading.sqlite');
  let db = openDatabase(dbPath);
  try {
    seedItem(db);
    const store = new ReaderAnnotationStore(db);
    const original = store.record(input('req-original', { note: 'Obsolete narwhalcontext.' }));
    const correctionInput = input('req-corrected', { note: 'Current platypuscontext.', supersedes_annotation_id: original.annotation.id });
    const corrected = store.record(correctionInput);
    db.close();
    db = openDatabase(dbPath);
    assert.deepEqual(listReaderAnnotations(db, 'item_one').map((entry) => entry.active), [false, true]);
    assert.deepEqual(matches(db, 'narwhalcontext'), []);
    assert.deepEqual(matches(db, 'platypuscontext'), ['item_one']);
    assert.deepEqual(new ReaderAnnotationStore(db).record(correctionInput), { ...corrected, dedupe_status: 'idempotent_replay' });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('defensive validation rejects blank fields and limits without trimming accepted notes', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  const store = new ReaderAnnotationStore(db);
  const invalid: Partial<AnnotationRequest>[] = [
    { note: ' \n\t ' }, { actor: ' ' }, { project: ' ' }, { question: '\n' },
    { note: 'a'.repeat(4001) }, { actor: 'a'.repeat(121) },
    { project: 'a'.repeat(201) }, { question: 'a'.repeat(1001) },
    { supersedes_annotation_id: 'a'.repeat(101) }
  ];
  for (const [index, changes] of invalid.entries()) {
    assert.throws(() => store.record(input(`req-invalid-${index}`, changes)), expectError(400, 'BAD_REQUEST'));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reader_annotations').get()?.n, 0);
});

test('annotation insert rolls back if its FTS refresh fails', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seedItem(db);
  db.exec('DROP TABLE item_fts');
  assert.throws(() => new ReaderAnnotationStore(db).record(input('req-index-failure')), /item_fts/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reader_annotations').get()?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()?.n, 0);
});
