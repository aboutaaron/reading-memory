import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSource } from './extract-source.js';
import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';
import type { FetchedUrl } from '../ingest/fetch-url.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000013';
function fetched(text: string, mime = 'text/html'): FetchedUrl {
  const bytes = new TextEncoder().encode(text);
  return { bytes, rawBytesHashInput: bytes, mime, finalUrl: 'https://example.com/article' };
}

test('normalizes and hashes text after redaction', async () => {
  const source = await extractSource({
    request_id: '00000000-0000-4000-8000-000000000010',
    source_type: 'text',
    source: {
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
      text: 'View this post on the web at https://example.com/post?utm_source=email#comments\n\nArticle body.',
      title: 'Newsletter capture'
    }
  });

  assert.equal(source.canonicalUrl, 'https://example.com/post');
});

test('ignores invalid canonical URL hints in text captures', async () => {
  const source = await extractSource({
    request_id: '00000000-0000-4000-8000-000000000012',
    source_type: 'text',
    source: {
      text: 'canonical url: https://[::broken\n\nArticle body.',
      title: 'Newsletter capture'
    }
  });

  assert.equal(source.canonicalUrl, null);
});

test('captures URL article metadata and prefers explicit caller titles', async () => {
  const html = '<html><head><title>Original heading</title><meta name="author" content="Ada Reader"><meta property="og:site_name" content="Memory Journal"><meta property="article:published_time" content="2026-09-01T12:00:00Z"></head><body><article><p>Remember the original evidence behind this claim.</p></article></body></html>';
  const source = await extractSource({ request_id: REQUEST_ID, source_type: 'url', source: { url: 'https://example.com/article', title: 'Reader supplied title' } }, undefined, { fetchUrl: async () => fetched(html) });
  assert.equal(source.title, 'Reader supplied title');
  assert.equal(source.author, 'Ada Reader');
  assert.equal(source.publisher, 'Memory Journal');
  assert.equal(source.publishedAt, '2026-09-01T12:00:00.000Z');
  assert.equal(source.provenance.title_source, 'explicit');
  assert.equal(source.provenance.extractor, 'readability');
});

test('preserves literal plain text from URLs without interpreting markup', async () => {
  const source = await extractSource({ request_id: REQUEST_ID, source_type: 'url', source: { url: 'https://example.com/note.txt' } }, undefined, { fetchUrl: async () => fetched('Types: Array<T> &amp; literal.\n\n<script>Not executable HTML</script>', 'text/plain') });
  assert.equal(source.extractedText, 'Types: Array<T> &amp; literal.\n\n<script>Not executable HTML</script>');
  assert.equal(source.title, null);
  assert.equal(source.provenance.extractor, 'text');
});

test('captures PDF metadata and explicit PDF title precedence', async () => {
  const request = { request_id: REQUEST_ID, source_type: 'pdf_url' as const, source: { url: 'https://example.com/paper.pdf' } };
  const dependencies = { fetchUrl: async () => fetched('fake PDF bytes', 'application/pdf'), extractPdfText: async () => ({ text: 'Paper text.', pages: 2, title: 'Metadata title', author: 'Sam Author' }) };
  const source = await extractSource(request, undefined, dependencies);
  assert.equal(source.title, 'Metadata title');
  assert.equal(source.author, 'Sam Author');
  assert.equal(source.provenance.title_source, 'pdf-metadata');
  assert.equal(source.provenance.pdf_pages, 2);
  const explicit = await extractSource({ ...request, source: { ...request.source, title: 'Reader title' } }, undefined, dependencies);
  assert.equal(explicit.title, 'Reader title');
  assert.equal(explicit.provenance.title_source, 'explicit');
});

test('long fetched sources with equal retained text have distinct full hashes', async () => {
  const request = { request_id: REQUEST_ID, source_type: 'url' as const, source: { url: 'https://example.com/long.txt' } };
  const prefix = 'x'.repeat(LIMITS.maxExtractedChars);
  const first = await extractSource(request, undefined, { fetchUrl: async () => fetched(`${prefix} ending one`, 'text/plain') });
  const second = await extractSource(request, undefined, { fetchUrl: async () => fetched(`${prefix} ending two`, 'text/plain') });
  assert.equal(first.extractedText, second.extractedText);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(first.truncated, true);
  assert.equal(first.provenance.truncated, true);
  assert.equal(first.provenance.content_hash_basis, 'full-normalized-redacted-v1');
});

test('rejects empty captured text and empty extracted HTML', async () => {
  await assert.rejects(extractSource({ request_id: REQUEST_ID, source_type: 'text', source: { text: ' \n\t' } }), (error: unknown) => error instanceof ApiError && error.code === 'BAD_REQUEST');
  await assert.rejects(extractSource({ request_id: REQUEST_ID, source_type: 'url', source: { url: 'https://example.com/empty' } }, undefined, { fetchUrl: async () => fetched('<html><body><script>Only code</script></body></html>') }), (error: unknown) => error instanceof ApiError && error.code === 'FETCH_FAILED');
});


test('propagates the extraction AbortSignal to PDF parsing for URL and PDF sources', async () => {
  for (const type of ['url', 'pdf_url'] as const) {
    const controller = new AbortController();
    const source = await extractSource({ request_id: REQUEST_ID, source_type: type, source: { url: 'https://example.com/paper.pdf' } }, controller.signal, {
      fetchUrl: async () => fetched('fake PDF bytes', 'application/pdf'),
      extractPdfText: async (_bytes, signal) => {
        assert.equal(signal, controller.signal);
        return { text: 'Paper text.', pages: 1, title: null, author: null };
      }
    });
    assert.equal(source.provenance.extractor, 'pdf');
  }
});
