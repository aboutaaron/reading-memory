import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractHtml } from './extract-html.js';

test('extracts article text and metadata while excluding page chrome', () => {
  const html = readFileSync(new URL('./fixtures/article.html', import.meta.url), 'utf8');
  const article = extractHtml(html, 'https://example.com/posts/cache');
  assert.equal(article.extractor, 'readability');
  assert.equal(article.title, 'Cache Invalidation & Durable Recall');
  assert.equal(article.author, 'Ada Reader');
  assert.equal(article.publisher, 'Memory Journal');
  assert.equal(article.publishedAt, '2026-09-01T15:30:00.000Z');
  assert.match(article.text, /“Memory”/);
  assert.match(article.text, /©, ©, —, <T>, and & entities/);
  assert.match(article.text, /formed\.\n\nA second paragraph/);
  assert.match(article.text, /A concrete example\n\nAn analyst/);
  assert.doesNotMatch(article.text, /Subscribe now|Archive navigation|Site header|Sponsor promotion|Accept our cookies|Footer legal|weekly updates|tracking script|Hidden duplicate/);
});

test('preserves readable fragments and malformed markup without inventing metadata', () => {
  const article = extractHtml('<main><h1>A short note</h1><p>First &amp; second.<p>Third paragraph.</main>');
  assert.match(article.text, /First & second\.\n\nThird paragraph\./);
  assert.equal(article.title, 'A short note');
  assert.equal(article.author, null);
  assert.equal(article.publisher, null);
  assert.equal(article.publishedAt, null);
});

test('preserves factual article callouts while removing outside asides', () => {
  const article = extractHtml('<html><body><aside>Outside promotional sidebar</aside><article><p>Version checks make reuse safe for ordinary cached data.</p><aside><p>Exception: never reuse cached authorization results.</p></aside><p>Applications must check the current version before reuse.</p></article></body></html>');
  assert.match(article.text, /Version checks make reuse safe/);
  assert.match(article.text, /Exception: never reuse cached authorization results\./);
  assert.match(article.text, /Applications must check the current version/);
  assert.doesNotMatch(article.text, /Outside promotional sidebar/);
});

test('rejects impossible publication calendar dates instead of normalizing them', () => {
  const capture = (date: string) => extractHtml(`<html><head><meta property="article:published_time" content="${date}"></head><body><p>Readable article body.</p></body></html>`);
  assert.equal(capture('2026-02-31').publishedAt, null);
  assert.equal(capture('2026-02-29T12:00:00Z').publishedAt, null);
  assert.equal(capture('2024-02-29T12:00:00Z').publishedAt, '2024-02-29T12:00:00.000Z');
});

test('fallback excludes non-content nodes even when the page has no article', () => {
  const article = extractHtml('<html><head><title>Metadata only</title></head><body><nav>Links</nav><script>code</script><style>css</style><form>Sign up</form></body></html>');
  assert.equal(article.extractor, 'html-fallback');
  assert.equal(article.text, '');
  assert.equal(article.title, 'Metadata only');
});

test('uses JSON-LD article metadata and bounds title metadata', () => {
  const article = extractHtml(`<html><head><title>Site name</title><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Article', headline: 'Specific article heading',
    author: { '@type': 'Person', name: 'Sam Author' }, publisher: { '@type': 'Organization', name: 'Source Journal' },
    datePublished: '2026-08-01T10:00:00Z'
  })}</script></head><body><article><h1>Specific article heading</h1><p>${'This article presents evidence supporting the main claim, and identifies several important limitations. '.repeat(8)}</p></article></body></html>`);
  assert.equal(article.title, 'Specific article heading');
  assert.equal(article.author, 'Sam Author');
  assert.equal(article.publisher, 'Source Journal');
  assert.equal(article.publishedAt, '2026-08-01T10:00:00.000Z');
  const longTitle = extractHtml(`<html><head><title>${'a'.repeat(900)}</title></head><body><p>Readable body.</p></body></html>`);
  assert.equal(longTitle.title?.length, 500);
});
