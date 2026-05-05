import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpsUrl, fetchUrl } from './fetch-url.js';
import { ApiError } from '../api/errors.js';

test('blocks private IP URLs before fetch', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl(new URL('https://127.0.0.1/private')),
    (error) => error instanceof ApiError && error.code === 'FETCH_FAILED'
  );
});

test('blocks DNS results that resolve to private IPs', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl(new URL('https://example.test/post'), async () => [{ address: '10.0.0.5', family: 4 }]),
    (error) => error instanceof ApiError && error.message.includes('blocked')
  );
});

test('requires HTTPS URLs', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl(new URL('http://example.test/post')),
    (error) => error instanceof ApiError && error.message.includes('HTTPS')
  );
});

test('normalizes DNS lookup failures into fetch errors', async () => {
  await assert.rejects(
    () =>
      assertPublicHttpsUrl(new URL('https://missing.example.test/post'), async () => {
        throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
      }),
    (error) =>
      error instanceof ApiError &&
      error.code === 'FETCH_FAILED' &&
      error.status === 502 &&
      error.retryable === true &&
      error.message.includes('DNS')
  );
});

test('blocks non-127 loopback URLs before fetch', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl(new URL('https://127.0.0.2/private')),
    (error) => error instanceof ApiError && error.message.includes('Private IP')
  );
});

test('blocks redirects to private IPs before following them', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/private' }
    });
  };

  try {
    await assert.rejects(
      () => fetchUrl('https://example.test/post', {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }]
      }),
      (error) => error instanceof ApiError && error.message.includes('Private IP')
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
