import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rate-limit.js';
import { ApiError } from './errors.js';

test('prunes expired principals while retaining active rate-limit counts', () => {
  const limiter = new RateLimiter({ query: 2 });
  for (let i = 0; i < 1_000; i += 1) limiter.check(`inactive-${i}`, 'query', 0);
  limiter.check('active', 'query', 30_000);
  limiter.check('active', 'query', 60_000);

  assert.equal(limiter['buckets'].size, 1, 'expired principals must not accumulate indefinitely');
  assert.throws(() => limiter.check('active', 'query', 60_000), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 30);
    return true;
  });
  assert.doesNotThrow(() => limiter.check('active', 'query', 90_000));
  limiter.check('next', 'query', 150_000);
  assert.equal(limiter['buckets'].size, 1);
});

test('principal and route buckets remain independent', () => {
  const limiter = new RateLimiter({ query: 1, ingest: 1 });
  limiter.check('first', 'query', 0);
  assert.throws(() => limiter.check('first', 'query', 1), ApiError);
  assert.doesNotThrow(() => limiter.check('second', 'query', 1));
  assert.doesNotThrow(() => limiter.check('first', 'ingest', 1));
});
