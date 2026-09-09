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

test('handles very long non-email words with and without an @', () => {
  const word = 'a'.repeat(500_000);
  assert.equal(redactText(word), word);
  assert.equal(redactText(`${word}@`), `${word}@`);
  assert.equal(redactText(`${word}@invalid`), `${word}@invalid`);
  assert.equal(redactText(`${word}@example.com`), '[email-redacted]');
});

test('email scanning preserves existing redaction boundaries', () => {
  assert.equal(redactText('Before first+tag@example.com, after second_name@sub.domain.co.uk.'), 'Before [email-redacted], after [email-redacted].');
  assert.equal(redactText('a@b.co@c.com a@b.c a@b.cc.d foo@example.com-extra'), '[email-redacted]@c.com a@b.c [email-redacted].d [email-redacted]-extra');
});
