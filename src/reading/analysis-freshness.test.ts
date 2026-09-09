import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { analysisFreshness, listStaleItems } from './analysis-freshness.js';

test('freshness explains missing, version and canonical model differences independently', t => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  assert.deepEqual(analysisFreshness(db, 'current', 'gpt-5.6-luna').stale_reason_counts,
    { missing_analysis: 0, version_mismatch: 0, model_mismatch: 0 });
  const fixtures = [
    ['missing', null, null], ['version', 'old', 'gpt-5.6-luna'],
    ['model', 'current', 'anthropic/gpt-5.6-luna'], ['both', 'old', 'other'],
    ['canonical', 'current', 'openai/gpt-5.6-luna'], ['bare', 'current', 'gpt-5.6-luna'],
    ['failed', null, null]
  ];
  for (const [id, version, model] of fixtures) {
    db.prepare(`INSERT INTO items(id, source_type, ingested_at, content_hash, status, extracted_text) VALUES (?, 'text', '2026-09-09', ?, ?, 'Fixture text.')`)
      .run(id!, id!, id === 'failed' ? 'failed' : 'indexed');
    if (version) db.prepare(`INSERT INTO analyses(id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
      VALUES (?, ?, 'summary', 'save', 0.8, ?, ?, '2026-09-09')`).run(`analysis-${id}`, id!, model!, version);
  }
  const freshness = analysisFreshness(db, 'current', 'gpt-5.6-luna');
  assert.equal(freshness.current_model, 'openai/gpt-5.6-luna');
  assert.equal(freshness.stale_items, 4);
  assert.deepEqual(freshness.stale_reason_counts, { missing_analysis: 1, version_mismatch: 2, model_mismatch: 2 });
  assert.deepEqual(listStaleItems(db, 'current', 'gpt-5.6-luna', 10).items.map(item => [item.item_id, item.stale_reasons]), [
    ['both', ['version_mismatch', 'model_mismatch']], ['missing', ['missing_analysis']],
    ['model', ['model_mismatch']], ['version', ['version_mismatch']]
  ]);
  // Equal timestamps use the latest row, so an older incompatible analysis cannot mark an item stale.
  db.prepare(`INSERT INTO analyses(id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
    VALUES ('replacement', 'both', 'summary', 'save', 0.8, 'gpt-5.6-luna', 'current', '2026-09-09')`).run();
  assert.equal(analysisFreshness(db, 'current', 'openai/gpt-5.6-luna').stale_items, 3);
  assert.equal(listStaleItems(db, 'current', 'openai/gpt-5.6-luna', 1).items.length, 1);
});
