import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { IngestRequestSchema } from './contracts.js';
import { payloadHash } from '../reading/extract-source.js';
import { sha256, stableJson } from '../ingest/content-hash.js';

const requestId = '00000000-0000-4000-8000-000000000036';
const cases = [
  { source_type: 'text', source: { text: 'Durable reading memory.', title: 'Note' } },
  { source_type: 'url', source: { url: 'https://example.com/article', title: 'Article' } },
  { source_type: 'pdf_url', source: { url: 'https://example.com/paper.pdf' } }
];

test('source_type selects and validates the source payload without a nested discriminator', () => {
  for (const item of cases) {
    const input = { request_id: requestId, ...item };
    const parsed = v.parse(IngestRequestSchema, input);
    assert.deepEqual(parsed, input);
    assert.equal('type' in parsed.source, false);
  }
  for (const item of [
    { source_type: 'text', source: { url: 'https://example.com' } },
    { source_type: 'url', source: { text: 'Missing URL' } },
    { source_type: 'pdf_url', source: { url: 'invalid' } },
    { source_type: 'file', source: { path: '/tmp/private.pdf' } },
    { source: { type: 'text', text: 'Missing source_type' } }
  ]) {
    assert.equal(v.safeParse(IngestRequestSchema, { request_id: requestId, ...item }).success, false);
  }
});

test('consistent legacy nested types are stripped and contradictory types are rejected', () => {
  for (const item of cases) {
    const parsed = v.parse(IngestRequestSchema, {
      request_id: requestId, ...item, source: { ...item.source, type: item.source_type }
    });
    assert.deepEqual(parsed.source, item.source);
    for (const type of ['text', 'url', 'pdf_url'].filter((type) => type !== item.source_type)) {
      assert.equal(v.safeParse(IngestRequestSchema, {
        request_id: requestId, ...item, source: { ...item.source, type }
      }).success, false);
    }
  }
});

test('canonical payload hashes remain compatible with persisted pre-simplification requests', () => {
  for (const item of cases) {
    for (const readerContext of [{}, { source_context: 'newsletter', ingest_reason: 'Evidence for a project' }]) {
      const input = { request_id: requestId, ...item, ...readerContext };
      const legacy = { ...input, source: { ...item.source, type: item.source_type } };
      const expectedLegacyHash = sha256(stableJson({
        source_type: legacy.source_type,
        source: legacy.source,
        source_context: 'source_context' in readerContext ? readerContext.source_context : null,
        ingest_reason: 'ingest_reason' in readerContext ? readerContext.ingest_reason : null
      }));
      assert.equal(payloadHash(v.parse(IngestRequestSchema, input)), expectedLegacyHash);
      assert.equal(payloadHash(v.parse(IngestRequestSchema, legacy)), expectedLegacyHash);
    }
  }
});
