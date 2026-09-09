import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { sourceFamilyResolver } from './source-families.js';

function add(db: Database, id: string, options: {
  canonical?: string; final?: string; uri?: string; parent?: string; date?: string; tag?: string; type?: string;
} = {}) {
  db.prepare(`INSERT INTO items(id, source_type, title, canonical_url, final_url, source_uri,
    ingested_at, content_hash, raw_bytes_hash, status, extracted_text, supersedes_item_id)
    VALUES (?, ?, 'The same title', ?, ?, ?, ?, ?, 'shared-raw-hash', 'indexed', 'Shared teaser text.', ?)`)
    .run(id, options.type ?? 'text', options.canonical ?? null, options.final ?? null, options.uri ?? null,
      options.date ?? '2026-09-09', id, options.parent ?? null);
  if (options.tag) db.prepare("INSERT INTO tags VALUES (?, ?, 'fixture', 1)").run(id, options.tag);
}

test('canonical, final and source URLs identify the same source across capture formats', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'web', { canonical: 'https://example.test/article', type: 'url' });
  add(db, 'pdf', { final: 'https://example.test/article', type: 'pdf_url' });
  add(db, 'text', { uri: 'https://example.test/article' });
  const family = sourceFamilyResolver(db);
  assert.equal(family('web').id, family('pdf').id);
  assert.equal(family('pdf').id, family('text').id);
  assert.equal(family('web').basis, 'canonical_url');
  assert.equal(family('pdf').basis, 'final_url');
  assert.equal(family('text').basis, 'source_uri');
});

test('URL identity preserves meaningful query, path, fragment and scheme differences', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  const urls = ['https://example.test/a?edition=1', 'https://example.test/a?edition=2',
    'https://example.test/a', 'https://example.test/b', 'https://example.test/a#chapter', 'http://example.test/a'];
  urls.forEach((canonical, index) => add(db, `item-${index}`, { canonical }));
  const family = sourceFamilyResolver(db);
  assert.equal(new Set(urls.map((_, index) => family(`item-${index}`).id)).size, urls.length);
});

test('unknown sources and shared titles, text and raw hashes remain separate', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'a'); add(db, 'b'); add(db, 'c', { canonical: 'https://one.test/article' });
  add(db, 'd', { canonical: 'https://two.test/article' });
  const family = sourceFamilyResolver(db);
  assert.equal(new Set(['a', 'b', 'c', 'd'].map(id => family(id).id)).size, 4);
  assert.equal(family('a').basis, 'item');
});

test('explicit lineage groups versions while filtered and forgotten ancestors supply no identity', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'old', { canonical: 'https://example.test/old', date: '2025-01-01', tag: 'old' });
  add(db, 'new', { canonical: 'https://example.test/new', parent: 'old', tag: 'current' });
  let family = sourceFamilyResolver(db);
  assert.equal(family('old').id, family('new').id);
  assert.equal(family('new').basis, 'explicit_lineage');
  family = sourceFamilyResolver(db, { since: '2026-01-01' });
  assert.equal(family('new').basis, 'canonical_url');
  assert.notEqual(family('old').id, family('new').id);
  assert.equal(sourceFamilyResolver(db, { tags: ['current'] })('new').basis, 'canonical_url');
  db.prepare("DELETE FROM items WHERE id = 'old'").run();
  const afterForget = sourceFamilyResolver(db)('new');
  assert.equal(afterForget.basis, 'canonical_url');
  assert.doesNotMatch(JSON.stringify(afterForget), /old/);
});

test('cyclic lineage falls back to individual identities without hanging', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'a'); add(db, 'b', { parent: 'a' });
  db.prepare("UPDATE items SET supersedes_item_id = 'b' WHERE id = 'a'").run();
  const family = sourceFamilyResolver(db);
  assert.equal(family('a').basis, 'item');
  assert.notEqual(family('a').id, family('b').id);
});

test('shared predecessors and transitive versions resolve consistently regardless of lookup order', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'root', { canonical: 'https://example.test/original' });
  add(db, 'revision', { canonical: 'https://example.test/revision', parent: 'root' });
  add(db, 'child', { parent: 'revision' });
  add(db, 'sibling', { parent: 'root' });
  for (const order of [['child', 'sibling', 'revision', 'root'], ['root', 'revision', 'sibling', 'child']]) {
    const family = sourceFamilyResolver(db);
    assert.equal(new Set(order.map(id => family(id).id)).size, 1);
  }
});

test('overlong lineage remains bounded and separate instead of using an arbitrary partial ancestor', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  for (let index = 0; index < 34; index++) add(db, `version-${index}`, index ? { parent: `version-${index - 1}` } : {});
  const family = sourceFamilyResolver(db);
  assert.equal(family('version-33').basis, 'item');
  assert.notEqual(family('version-33').id, family('version-32').id);
});

test('URL equivalence composes with reverse lineage for repeated captures of a revised URL', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  add(db, 'old', { canonical: 'https://example.test/old' });
  add(db, 'revision', { canonical: 'https://example.test/revised', parent: 'old' });
  add(db, 'repeat', { final: 'https://EXAMPLE.test:443/revised' });
  for (const order of [['repeat', 'old', 'revision'], ['old', 'revision', 'repeat']]) {
    const family = sourceFamilyResolver(db);
    assert.equal(new Set(order.map(id => family(id).id)).size, 1);
    assert.ok(order.every(id => family(id).resolution === 'complete'));
  }
});

test('snapshot overflow preserves simple same-URL dedup without claiming complete lineage resolution', t => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  db.exec('BEGIN');
  for (let index = 0; index < 4097; index++) add(db, `capture-${index}`, { canonical: 'https://example.test/article' });
  db.exec('COMMIT');
  const family = sourceFamilyResolver(db);
  assert.equal(family('capture-0').resolution, 'bounded_fallback');
  assert.equal(family('capture-4096').resolution, 'bounded_fallback');
  assert.equal(family('capture-0').id, family('capture-4096').id);
  assert.equal(family('capture-0').basis, 'canonical_url');
  add(db, 'other-url', { canonical: 'https://example.test/other' });
  assert.notEqual(family('capture-0').id, family('other-url').id);
});
