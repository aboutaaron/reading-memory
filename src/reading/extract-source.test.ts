import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSource } from './extract-source.js';

test('normalizes and hashes text after redaction', async () => {
  const source = await extractSource({
    request_id: '00000000-0000-4000-8000-000000000010',
    source_type: 'text',
    source: {
      type: 'text',
      text: 'To: aaron@example.com\n\nAgent memory needs durable recall.',
      title: 'Note'
    }
  });

  assert.equal(source.sourceType, 'text');
  assert.match(source.contentHash, /^sha256:/);
  assert.doesNotMatch(source.extractedText, /aaron@example\.com/);
});

test('infers canonical URL from newsletter text captures', async () => {
  const source = await extractSource({
    request_id: '00000000-0000-4000-8000-000000000011',
    source_type: 'text',
    source: {
      type: 'text',
      text: 'View this post on the web at https://example.com/post?utm_source=email#comments\n\nArticle body.',
      title: 'Newsletter capture'
    }
  });

  assert.equal(source.canonicalUrl, 'https://example.com/post');
});
