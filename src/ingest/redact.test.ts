import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from './redact.js';

test('redacts email headers, addresses, and unsubscribe tokens', () => {
  const result = redactText(`To: aaron@example.com
From: sender@example.com
List-Unsubscribe: <https://example.com/u?token=abc123>

Hello aaron@example.com https://example.com/?utm_source=newsletter&fbclid=abc`);

  assert.doesNotMatch(result, /aaron@example\.com/);
  assert.doesNotMatch(result, /sender@example\.com/);
  assert.doesNotMatch(result, /abc123/);
  assert.match(result, /\[email-redacted\]/);
});
