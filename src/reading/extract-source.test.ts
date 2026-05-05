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
