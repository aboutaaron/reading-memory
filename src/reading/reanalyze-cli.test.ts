import test from 'node:test';
import assert from 'node:assert/strict';
import { reanalyzeStale, parseReanalyzeArgs } from '../../scripts/reanalyze.js';

const success = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });

test('stale maintenance bounds selection, throttles operations and retries with the same request ID', async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const waits: number[] = [];
  let firstAttempts = 0;
  const result = await reanalyzeStale({ baseUrl: 'http://127.0.0.1:4727', token: 'local-test', limit: 2,
    wait: async (ms) => { waits.push(ms); }, fetcher: (async (url, options) => {
      assert.equal(options?.redirect, 'error');
      assert.equal((options?.headers as Record<string, string>).authorization, 'Bearer local-test');
      calls.push({ url: String(url), body: options?.body?.toString() });
      if (String(url).includes('?stale=true')) return success({ items: [{ item_id: 'first' }, { item_id: 'second' }, { item_id: 'excess' }] });
      if (String(url).includes('/first/') && firstAttempts++ === 0) return new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', retryable: true, retry_after_seconds: 17 } }), { status: 429 });
      return success({ dedupe_status: 'reanalyzed' });
    }) as typeof fetch });
  assert.deepEqual(result, { selected: 2, completed: 2, failed: 0 });
  assert.equal(calls[1]?.body, calls[2]?.body);
  assert.notEqual(calls[2]?.body, calls[3]?.body);
  assert.deepEqual(waits, [17000, 6000]);
});

test('stale maintenance rejects remote endpoints and caps failures without printing server content', async () => {
  await assert.rejects(reanalyzeStale({ baseUrl: 'https://example.com', token: 'test', limit: 1 }), /loopback/);
  let attempts = 0;
  const events: unknown[] = [];
  const result = await reanalyzeStale({ baseUrl: 'http://localhost:4727', token: 'test', limit: 1,
    wait: async () => {}, report: (event) => events.push(event), fetcher: (async (url) => {
      if (String(url).includes('?stale=true')) return success({ items: [{ item_id: 'first' }] });
      attempts += 1;
      throw new Error('Sensitive server body');
    }) as typeof fetch });
  assert.equal(attempts, 4);
  assert.deepEqual(result, { selected: 1, completed: 0, failed: 1 });
  assert.doesNotMatch(JSON.stringify(events), /Sensitive/);
  assert.equal(parseReanalyzeArgs(['--stale', '--limit', '5']), 5);
  assert.throws(() => parseReanalyzeArgs(['--stale', '--limit', '0']), /limit/);
  assert.throws(() => parseReanalyzeArgs(['--limit', '5']), /Usage/);
});

test('dry-run only reads bounded stale selection, reports policy reasons, and never mutates', async () => {
  const calls: string[] = [];
  const { parseReanalyzeOptions } = await import('../../scripts/reanalyze.js');
  const result = await reanalyzeStale({ baseUrl: 'http://127.0.0.1:4727', token: 'test', limit: 1, dryRun: true,
    wait: async () => { assert.fail('preview must not schedule analysis'); },
    report: () => { assert.fail('preview must not report completed analysis'); },
    fetcher: (async (url, options) => {
      calls.push(String(url));
      assert.equal(options?.method, 'GET');
      assert.equal(options?.body, undefined);
      return success({ items: [{ item_id: 'first', analysis_version: 'old', model: 'gpt-5.6-luna',
        stale_reasons: ['version_mismatch'], title: 'Private reading title' }, { item_id: 'extra' }] });
    }) as typeof fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { selected: 1, completed: 0, failed: 0, dry_run: true,
    items: [{ item_id: 'first', analysis_version: 'old', model: 'gpt-5.6-luna', stale_reasons: ['version_mismatch'] }] });
  assert.doesNotMatch(JSON.stringify(result), /Private reading title/);
  assert.deepEqual(parseReanalyzeOptions(['--stale', '--limit', '25', '--dry-run']), { limit: 25, dryRun: true });
  assert.deepEqual(parseReanalyzeOptions(['--apply', '--stale', '--limit', '25']), { limit: 25, dryRun: false });
  assert.deepEqual(parseReanalyzeOptions(['--stale', '--limit', '25']), { limit: 25, dryRun: false });
  assert.throws(() => parseReanalyzeOptions(['--stale', '--limit', '25', '--apply', '--dry-run']), /Usage/);
  assert.throws(() => parseReanalyzeOptions(['--stale', '--limit', '25', '--dry-run', '--dry-run']), /Usage/);
});
