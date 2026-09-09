import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { requireAuth, tokenFingerprint } from './auth.js';
import { ApiError } from './errors.js';

function request(authorization?: string) {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

test('bearer auth accepts exact tokens, including non-ASCII tokens, and returns the stable fingerprint', () => {
  for (const token of ['secret', 'long-secret-token-value', 'sëcret']) {
    assert.equal(requireAuth(request(`Bearer ${token}`), token), `token:${tokenFingerprint(token)}`);
  }
});

test('bearer auth rejects invalid tokens of shorter, equal, and longer lengths', () => {
  for (const token of ['s', 'secrex', 'much-longer-than-secret']) {
    assert.throws(() => requireAuth(request(`Bearer ${token}`), 'secret'),
      (error) => error instanceof ApiError && error.code === 'UNAUTHORIZED' && error.status === 401);
  }
});

test('bearer auth rejects absent, empty, malformed, and unconfigured credentials', () => {
  for (const auth of [undefined, '', 'Bearer', 'Bearer ', 'bearer secret', 'Basic secret', 'Bearer secret extra']) {
    assert.throws(() => requireAuth(request(auth), 'secret'),
      (error) => error instanceof ApiError && error.status === 401);
  }
  assert.throws(() => requireAuth(request('Bearer secret'), ''),
    (error) => error instanceof ApiError && error.status === 503);
});
