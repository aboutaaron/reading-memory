import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { briefGuide } from './brief-guide.js';

const BRIEF_DATE = '2026-09-09';
const RECENT = '2026-09-09T20:00:00.000Z';

type AnalysisOptions = {
  action?: 'brief' | 'save' | 'skip';
  score?: number;
  confidence?: number;
  reason?: string | null;
  themes?: string[];
  analyzedAt?: string;
};

function addAnalysis(db: Database, itemId: string, id: string, input: AnalysisOptions = {}) {
  db.prepare(`
    INSERT INTO analyses (id, item_id, summary, relevance_json, recommended_action, confidence, reason, model, analysis_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 'test', ?)
  `).run(id, itemId, 'Summary describes the source, not its selection rationale.',
    JSON.stringify({ score: input.score ?? 0.8, themes: input.themes ?? ['agent-memory'] }),
    input.action ?? 'brief', input.confidence ?? 0.8,
    input.reason === undefined ? 'New evidence about reliable memory recall.' : input.reason,
    input.analyzedAt ?? RECENT);
}

function addItem(db: Database, id: string, input: AnalysisOptions & { ingestedAt?: string; tags?: [string, number][]; status?: string } = {}) {
  db.prepare(`
    INSERT INTO items (id, source_type, source_uri, canonical_url, final_url, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'url', ?, ?, ?, ?, ?, ?, ?, 'Source passage')
  `).run(id, `https://example.com/${id}?utm_source=test`, `https://example.com/${id}`, `https://example.com/${id}`,
    id, input.ingestedAt ?? RECENT, `hash-${id}`, input.status ?? 'indexed');
  addAnalysis(db, id, `analysis-${id}`, { ...input, analyzedAt: input.analyzedAt ?? input.ingestedAt ?? RECENT });
  for (const [tag, confidence] of input.tags ?? [['agent-memory', 0.8]]) {
    db.prepare('INSERT INTO tags (item_id, tag, reason, confidence) VALUES (?, ?, ?, ?)').run(id, tag, 'tag evidence', confidence);
  }
}

function addEvent(db: Database, itemId: string, id: string, input: {
  date: string;
  kind: 'included' | 'skipped' | 'resurfaced';
  resurfaceAfter?: string;
  createdAt?: string;
}) {
  db.prepare(`
    INSERT INTO brief_events (id, item_id, brief_date, event_kind, included_bool, rationale, source_context, resurface_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, itemId, input.date, input.kind, input.kind === 'skipped' ? 0 : 1,
    `Rationale for ${id}`, id, input.resurfaceAfter ?? null, input.createdAt ?? `${input.date}T21:00:00.000Z`);
}

function guide(db: Database, lookbackHours = 36, focus?: string[]) {
  return briefGuide(db, { briefDate: BRIEF_DATE, lookbackHours, ...(focus ? { focus } : {}) });
}

test('brief recommendation and relevance precede confidence; model skips cannot fill the brief', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (let i = 0; i < 8; i++) addItem(db, `skip-${i}`, { action: 'skip', score: 0.1, confidence: 0.99 });
  addItem(db, 'relevant', { score: 0.95, confidence: 0.4 });
  addItem(db, 'confident', { score: 0.4, confidence: 0.95 });
  addItem(db, 'saved', { action: 'save', score: 0.99, confidence: 0.99 });

  const result = guide(db);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['relevant', 'confident', 'saved']);
  assert.ok(result.skip_items.every((row) => row.reason === 'analysis recommends skip'));
  assert.match(result.candidates[0]!.why_now, /New evidence about reliable memory recall/);
  assert.doesNotMatch(result.candidates[0]!.why_now, /Summary describes/);
});

test('eligibility is applied before limits so many suppressed articles cannot hide useful reading', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (let i = 0; i < 30; i++) {
    addItem(db, `included-${i}`, { score: 0.99, confidence: 0.99 });
    addEvent(db, `included-${i}`, `included-event-${i}`, { date: BRIEF_DATE, kind: 'included' });
  }
  for (let i = 0; i < 12; i++) addItem(db, `eligible-${i}`, { confidence: 0.2 });

  const result = guide(db);
  assert.equal(result.candidates.length, 8);
  assert.ok(result.candidates.every((row) => row.item_id.startsWith('eligible-')));
  assert.equal(result.skip_items.length, 10);
  assert.equal(new Set([...result.candidates, ...result.skip_items].map((row) => row.item_id)).size, 18);
});

test('explicitly scheduled old reading resurfaces outside the seven-day lookback and overrides model skip', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'old-due', { ingestedAt: '2026-09-01T08:00:00.000Z', action: 'skip', score: 0.1 });
  addEvent(db, 'old-due', 'schedule', { date: '2026-09-01', kind: 'skipped', resurfaceAfter: BRIEF_DATE });
  for (let i = 0; i < 9; i++) addItem(db, `recent-${i}`, { score: 0.99 });

  const result = guide(db, 168);
  assert.equal(result.candidates[0]!.item_id, 'old-due');
  assert.equal(result.candidates[0]!.resurfacing_note, 'resurfacing after 2026-09-09');
  assert.match(result.candidates[0]!.why_now, /explicit schedule overrides the analysis skip/);
  assert.match(result.candidates[0]!.why_now, /Rationale for schedule/);
});

test('future schedules defer both recent and old reading; a later skip without a date preserves the schedule', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (const id of ['recent', 'old']) {
    addItem(db, id, { ingestedAt: id === 'old' ? '2026-08-01T08:00:00.000Z' : RECENT });
    addEvent(db, id, `schedule-${id}`, { date: '2026-09-01', kind: 'skipped', resurfaceAfter: '2026-09-10' });
    addEvent(db, id, `skip-${id}`, { date: '2026-09-08', kind: 'skipped' });
  }
  const result = guide(db);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skip_items.map((row) => row.reason), ['deferred until 2026-09-10', 'deferred until 2026-09-10']);
});

test('included and resurfaced events suppress repeat appearances even when followed by a skipped event', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (const kind of ['included', 'resurfaced'] as const) {
    addItem(db, kind, { ingestedAt: '2026-09-08T20:00:00.000Z' });
    addEvent(db, kind, `schedule-${kind}`, { date: '2026-09-01', kind: 'skipped', resurfaceAfter: '2026-09-08' });
    addEvent(db, kind, `consumed-${kind}`, { date: '2026-09-08', kind });
    addEvent(db, kind, `skip-${kind}`, { date: BRIEF_DATE, kind: 'skipped' });
  }
  const result = guide(db);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.skip_items.some((row) => row.reason === 'recently included on 2026-09-08'));
  assert.ok(result.skip_items.some((row) => row.reason === 'recently resurfaced on 2026-09-08'));
});

test('a new explicit schedule after consumption makes an item eligible again and newer deferral wins', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (const id of ['rescheduled', 'deferred']) {
    addItem(db, id, { ingestedAt: '2026-08-01T08:00:00.000Z' });
    addEvent(db, id, `consumed-${id}`, { date: '2026-09-01', kind: 'resurfaced' });
    addEvent(db, id, `due-${id}`, { date: '2026-09-02', kind: 'skipped', resurfaceAfter: BRIEF_DATE });
  }
  addEvent(db, 'deferred', 'new-deferral', { date: '2026-09-03', kind: 'skipped', resurfaceAfter: '2026-09-20' });
  const result = guide(db);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['rescheduled']);
  assert.equal(result.skip_items[0]!.reason, 'deferred until 2026-09-20');
});

test('a consumption event may schedule a future appearance but cannot repeat on its own brief date', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'next-day', { ingestedAt: '2026-09-01T08:00:00.000Z' });
  addEvent(db, 'next-day', 'schedule-next', { date: '2026-09-08', kind: 'included', resurfaceAfter: BRIEF_DATE });
  addItem(db, 'same-day');
  addEvent(db, 'same-day', 'schedule-same', { date: BRIEF_DATE, kind: 'resurfaced', resurfaceAfter: BRIEF_DATE });
  const result = guide(db);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['next-day']);
  assert.equal(result.skip_items[0]!.reason, 'recently resurfaced on 2026-09-09');
});

test('historical dates include the full UTC day, exclude future items/analyses/events, and honor lookback boundary', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'late', { ingestedAt: '2026-09-09T23:59:59.999Z' });
  addItem(db, 'boundary', { ingestedAt: '2026-09-09T23:00:00.000Z' });
  addItem(db, 'too-old', { ingestedAt: '2026-09-09T22:59:59.999Z' });
  addItem(db, 'future', { ingestedAt: '2026-09-10T00:00:00.000Z' });
  addItem(db, 'future-analysis', { ingestedAt: '2026-09-09T23:10:00.000Z', analyzedAt: '2026-09-10T00:00:00.000Z' });
  addEvent(db, 'late', 'future-consumed', { date: '2026-09-10', kind: 'included' });
  const result = guide(db, 1);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['late', 'boundary']);
});

test('only the latest analysis as of the brief day affects selection and each item appears once', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'new-skip');
  addAnalysis(db, 'new-skip', 'new-skip-latest', { action: 'skip', analyzedAt: '2026-09-09T22:00:00.000Z' });
  addItem(db, 'new-brief', { action: 'skip' });
  addAnalysis(db, 'new-brief', 'new-brief-latest', { reason: 'Current analysis rationale.', analyzedAt: '2026-09-09T22:00:00.000Z' });
  addAnalysis(db, 'new-brief', 'future-skip', { action: 'skip', analyzedAt: '2026-09-10T00:00:00.000Z' });
  const result = guide(db);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['new-brief']);
  assert.match(result.candidates[0]!.why_now, /Current analysis rationale/);
  assert.equal(result.skip_items[0]!.item_id, 'new-skip');
});

test('focus gates candidates and lane uses the strongest matching tag, with URLs and readable selection rationale', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'focused', {
    themes: ['irrelevant-first-theme', 'evaluation'],
    tags: [['outside-focus', 0.99], ['agent-memory', 0.7], ['evaluation', 0.9]]
  });
  addItem(db, 'off-focus', { tags: [['cooking', 0.99]] });
  const result = guide(db, 36, ['agent-memory', 'evaluation']);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['focused']);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.suggested_lane, 'evaluation');
  assert.equal(candidate.source_uri, 'https://example.com/focused?utm_source=test');
  assert.equal(candidate.canonical_url, 'https://example.com/focused');
  assert.equal(candidate.final_url, 'https://example.com/focused');
  assert.match(candidate.why_now, /Matches focus: evaluation/);
});

test('missing historical rationale is explicit and failed items never enter a brief', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  addItem(db, 'legacy', { reason: null });
  addItem(db, 'failed', { status: 'failed' });
  const result = guide(db);
  assert.deepEqual(result.candidates.map((row) => row.item_id), ['legacy']);
  assert.match(result.candidates[0]!.why_now, /original analysis rationale was not recorded/);
});

test('invalid calendar dates are rejected instead of silently rolling into another month', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  assert.throws(() => briefGuide(db, { briefDate: '2026-02-30' }), /Invalid brief_date/);
});
