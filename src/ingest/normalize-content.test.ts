import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../config.js';
import { sha256 } from './content-hash.js';
import { normalizeContent } from './normalize-content.js';

test('full normalized source identity survives storage truncation', () => {
  const prefix = 'a'.repeat(LIMITS.maxExtractedChars);
  const first = normalizeContent(`${prefix} first ending`);
  const second = normalizeContent(`${prefix} different ending`);
  assert.equal(first.text, second.text);
  assert.equal(first.text.length, LIMITS.maxExtractedChars);
  assert.equal(first.truncated, true);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(first.contentHash, sha256(`${prefix} first ending`));
  assert.equal(first.extractedChars, LIMITS.maxExtractedChars + ' first ending'.length);
});

test('identity uses redacted normalized content and preserves paragraphs', () => {
  const first = normalizeContent('  One\r\n\r\nTwo\t words.\n\n\nTo: private@example.com  ');
  const second = normalizeContent('One\n\nTwo words.\n\nTo: another@example.com');
  assert.equal(first.text, 'One\n\nTwo words.\n\nTo: [redacted]');
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.contentHash, sha256(first.text));
  assert.equal(first.truncated, false);
});
