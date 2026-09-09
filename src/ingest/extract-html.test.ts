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

const structured = (body: Record<string, unknown> | Record<string, unknown>[]) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(body)}</script></head><body><nav><a href="/">Home</a></nav><div><p>We use cookies to personalize content.</p><button>Accept all</button></div></body></html>`;
const publicArticle = (articleBody: string) => ({ '@context': 'https://schema.org', '@type': 'NewsArticle', isAccessibleForFree: true, articleBody });

test('rejects consent-only shells, navigation-only pages, and metadata descriptions', () => {
  for (const html of [
    '<main><h1>We value your privacy</h1><p>We use cookies to personalize content and measure traffic.</p><p>By clicking accept, you agree to our cookie policy.</p><button>Accept all</button><a href="/privacy">Privacy policy</a></main>',
    '<div><h1>News</h1><a href="/a">Latest stories</a><a href="/b">Opinion</a><button>Search</button></div>',
    '<html><head><meta name="description" content="A very useful description of the article."></head><body><nav>Home</nav></body></html>',
    structured({ '@context': 'https://schema.org', '@type': 'NewsArticle', description: 'A description is not a captured article.' })
  ]) assert.equal(extractHtml(html).text, '');
});

test('keeps short substantive notes and articles discussing cookies and privacy', () => {
  for (const text of [
    'The vote passed.',
    'Cookies are small records stored by a browser.',
    'Privacy laws changed the design of consent dialogs.',
    'We use cookies in this experiment. The measurements show a decrease in repeated requests.'
  ]) {
    const article = extractHtml(`<article><h1>Privacy</h1><p>${text}</p></article>`);
    assert.ok(article.text.includes(text));
    assert.equal(article.completeness, 'unknown');
  }
});

test('recovers explicitly public schema.org articleBody without running scripts or loading resources', () => {
  const html = structured(publicArticle('A stored article can survive a failed client render.\n\nIts actual body is available in structured data.'))
    .replace('</body>', '<script>throw new Error("must never execute")</script><img src="http://127.0.0.1/private"></body>');
  const result = extractHtml(html);
  assert.equal(result.extractor, 'structured-article-body');
  assert.equal(result.text, 'A stored article can survive a failed client render.\n\nIts actual body is available in structured data.');
  assert.equal(result.completeness, 'unknown');
  assert.doesNotMatch(result.text, /cookies|must never execute/);
  const graph = extractHtml(structured({ '@context': 'https://schema.org', '@graph': [publicArticle('Graph-wrapped article text.')] }));
  assert.equal(graph.text, 'Graph-wrapped article text.');
});

test('structured fallback rejects restricted, unqualified, ambiguous, oversized, and malformed bodies', () => {
  for (const record of [
    { ...publicArticle('Restricted article.'), isAccessibleForFree: false },
    { ...publicArticle('Unknown access article.'), isAccessibleForFree: undefined },
    { ...publicArticle('Unrecognized body.'), '@type': 'Product' },
    { ...publicArticle('Unqualified context.'), '@context': 'https://example.com/schema' },
    [publicArticle('First candidate.'), publicArticle('Different candidate.')],
    publicArticle('a'.repeat(256_001)),
    publicArticle('We use cookies to remember your settings.')
  ]) assert.equal(extractHtml(structured(record)).text, '');
  assert.equal(extractHtml('<main><script type="application/ld+json">{broken</script><script type="application/json">{"articleBody":"Framework state is not a supported article."}</script></main>').text, '');
});

test('prefers readable visible content and supports server-rendered articleBody markup', () => {
  const html = structured(publicArticle('Different structured body.')).replace('<nav>', '<article><p>The visible article has priority.</p></article><nav>');
  assert.match(extractHtml(html).text, /The visible article has priority\./);
  assert.doesNotMatch(extractHtml(html).text, /Different structured body/);
  const ssr = extractHtml('<main><div itemprop="articleBody"><p>Server-rendered evidence is available without running a client.</p></div><script>startClient()</script></main>');
  assert.match(ssr.text, /Server-rendered evidence/);
  assert.doesNotMatch(ssr.text, /startClient/);
});

test('structured fallback fails closed when its inspection budget cannot rule out ambiguity', () => {
  const manyScripts = '<html><head>' + Array.from({ length: 17 }, () => `<script type="application/ld+json">${JSON.stringify(publicArticle('Possible article.'))}</script>`).join('') + '</head><body></body></html>';
  assert.equal(extractHtml(manyScripts).text, '');
  const tooManyNodes = { '@context': 'https://schema.org', '@graph': [publicArticle('First article.'), ...Array.from({ length: 513 }, () => ({ '@type': 'Thing' }))] };
  assert.equal(extractHtml(structured(tooManyNodes)).text, '');
  let nested: Record<string, unknown> = publicArticle('Deep article.');
  for (let i = 0; i < 10; i += 1) nested = { '@graph': nested };
  assert.equal(extractHtml(structured({ '@context': 'https://schema.org', '@graph': [publicArticle('First article.'), nested] })).text, '');
});

test('structured fallback cannot attribute an explicitly unrelated article to the fetched URL', () => {
  const page = 'https://example.com/current';
  for (const identity of [
    { url: 'https://example.com/recommended' },
    { '@id': 'https://example.com/recommended#article' },
    { mainEntityOfPage: 'https://example.com/recommended' },
    { mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://example.com/recommended' } },
    { url: page, mainEntityOfPage: { '@id': 'https://example.com/recommended' } },
    { url: 'http://[' },
    { url: 'javascript:alert(1)' },
    { mainEntityOfPage: { '@type': 'WebPage' } }
  ]) assert.equal(extractHtml(structured({ ...publicArticle('Unrelated article must not be attributed here.'), ...identity }), page).text, '');
  for (const identity of [
    { url: page + '#article' },
    { '@id': '#article', mainEntityOfPage: { '@type': 'WebPage', '@id': page + '#webpage' } },
    { url: '/current', mainEntityOfPage: { url: page } }
  ]) assert.equal(extractHtml(structured({ ...publicArticle('Matching current article.'), ...identity }), page + '#fragment').text, 'Matching current article.');
});

test('keeps an authored single-sentence cookie article without accepting a consent-control shell', () => {
  const sentence = 'We use cookies to maintain authenticated sessions in our application.';
  assert.equal(extractHtml(`<article><p>${sentence}</p></article>`).text, sentence);
  assert.equal(extractHtml(`<div itemprop="articleBody"><p>${sentence}</p></div>`).text, sentence);
  assert.equal(extractHtml(`<main><p>${sentence}</p><button>Accept all</button></main>`).text, '');
  assert.equal(extractHtml(`<article><p>${sentence}</p><button>Accept all</button></article>`).text, '');
  assert.equal(extractHtml(`<article><p>${sentence}</p><form><button>Accept all</button></form></article>`).text, '');
});
