import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { redactText } from './redact.js';

export type ArticleExtraction = {
  text: string;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  extractor: 'readability' | 'html-fallback' | 'structured-article-body';
  completeness: 'unknown';
  titleSource: 'article' | 'document' | null;
};

type HtmlDocument = ReturnType<typeof parseHTML>['document'];
type HtmlNode = HtmlDocument['body'];

const CHROME = 'nav,footer,form,body > header,[role="navigation"],[role="banner"],[role="contentinfo"],[role="dialog"],[hidden],[aria-hidden="true"],.cookie-banner,.cookie-consent,.newsletter-signup,.advertisement,.social-share';
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);

export function cleanMetadata(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = redactText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function publicationTime(value: unknown): string | null {
  const cleaned = cleanMetadata(value, 100);
  // A year or arbitrary numeric metadata must not become a spurious timestamp.
  const calendar = cleaned?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$|\s)/);
  if (!cleaned || !calendar) return null;
  const year = Number(calendar[1]);
  const month = Number(calendar[2]);
  const day = Number(calendar[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  // Date.parse normalizes some impossible dates (e.g. February 31) into a
  // different month. Such metadata is unknown, not a corrected publication.
  if (maxDay === undefined || day < 1 || day > maxDay) return null;
  const date = new Date(cleaned);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function documentFromHtml(html: string, url: string): HtmlDocument {
  // LinkeDOM deliberately does not insert a body around fragments.
  const source = /<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(source);
  Object.defineProperties(document, {
    documentURI: { value: url, configurable: true },
    URL: { value: url, configurable: true },
    baseURI: { value: url, configurable: true }
  });
  return document;
}

function removeChrome(document: HtmlDocument) {
  for (const node of document.querySelectorAll(CHROME)) node.remove();
  for (const aside of document.querySelectorAll('aside')) {
    if (!aside.closest('article,main,[role="main"]')) { aside.remove(); continue; }
    // Article callouts can contain exceptions or evidence. Readability deletes
    // all ASIDE elements, so retain these as neutral content blocks first.
    const callout = document.createElement('blockquote');
    while (aside.firstChild) callout.appendChild(aside.firstChild);
    aside.replaceWith(callout);
  }
}

// Only plain text leaves this module. Parsing never executes scripts or loads
// subresources, and block boundaries survive entity decoding by the DOM parser.
function textFromNode(root: HtmlNode): string {
  for (const node of root.querySelectorAll('script,style,noscript,template,head,svg')) node.remove();
  const chunks: string[] = [];
  const walk = (node: HtmlNode) => {
    if (node.nodeType === 3) {
      chunks.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'BR') { chunks.push('\n'); return; }
    const block = BLOCKS.has(node.tagName);
    if (block) chunks.push('\n\n');
    for (const child of node.childNodes) walk(child as HtmlNode);
    if (node.tagName === 'TD' || node.tagName === 'TH') chunks.push(' ');
    if (block) chunks.push('\n\n');
  };
  walk(root);
  return chunks.join('').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// This is a shell-content check, not a minimum article length or a topic filter.
// A short sentence about privacy is still content. Only recognizable UI-only
// candidates are rejected; passing this check does not prove completeness.
function hasArticleText(root: HtmlNode, sourceProseAnchors?: ReadonlySet<string>): boolean {
  // Match complete known UI units. Prefixes such as "We use cookies" or
  // "By clicking" also begin legitimate technical statements.
  const shell = [
    /^(?:we|this (?:site|website)) (?:use|uses) cookies(?: to (?:personalize content(?: and measure traffic)?|remember your settings|measure traffic|improve your (?:experience|browsing experience)|enhance your (?:experience|browsing experience)))?[.!]?$/i,
    /^by (?:clicking ["“]?(?:accept(?: all)?|agree)["”]?|continuing|using this (?:site|website)),? you (?:agree|consent) to (?:our|the) (?:cookie policy|use of cookies|privacy policy)[.!]?$/i,
    /^(?:we|our partners) (?:and our partners )?(?:use|process|store|access) (?:your personal data|personal data|information on your device)[.!]?$/i,
    /^(?:please )?(?:accept|reject|allow|manage|customize|save) (?:all |your |our |the )?(?:cookies|cookie preferences|preferences|settings|choices)[.!]?$/i,
    /^(?:cookie|consent|privacy) (?:settings|preferences|policy|notice|choices|center|centre)[.!]?$/i,
    /^(?:your privacy|we value your privacy|we respect your privacy|privacy matters|cookies on this site|accept all|reject all|accept|reject|continue|close|menu|home|search|latest stories|opinion|next|previous|read more|sign in|log in|subscribe|all rights reserved)[.!]?$/i
  ];
  const candidate = root.cloneNode(true) as HtmlNode;
  for (const anchor of candidate.querySelectorAll('a')) {
    // Linked prose is article content regardless of terminal punctuation.
    // Known UI labels are checked below; bare link lists are not prose.
    const text = (anchor.textContent ?? '').trim();
    if (!anchor.closest('p,blockquote') || shell.some(pattern => pattern.test(text)) ||
      (sourceProseAnchors && !sourceProseAnchors.has(text))) anchor.remove();
  }
  for (const node of candidate.querySelectorAll('button,input,select,h1,h2,h3,script,style,noscript,template,head,svg')) node.remove();
  const text = textFromNode(candidate);
  if (!text) return false;
  const splitUnits = (value: string) => value.split(/\n+|(?<=[.!?])\s+/).map(unit => unit.trim()).filter(Boolean);
  const units = splitUnits(text);
  // Some notices never mention cookies or expose recognizable control markup.
  // Recognize this complete declaration + preference instruction together;
  // neither sentence alone establishes a consent shell. Do not classify an
  // authored quotation or a notice accompanied by substantive discussion as UI.
  const defaults = /^we use (?:analytics and advertising|advertising and analytics) tools by default[.!]?$/i;
  const preferences = /^you can (?:update|change) (?:this|these (?:settings|preferences)|your (?:settings|preferences)) (?:anytime|at any time)[.!]?$/i;
  const quoted = [...candidate.querySelectorAll('blockquote,q')].some(node => {
    const quotedUnits = splitUnits(textFromNode(node.cloneNode(true) as HtmlNode));
    return quotedUnits.some(unit => defaults.test(unit)) && quotedUnits.some(unit => preferences.test(unit));
  });
  if (!quoted && units.some(unit => defaults.test(unit)) && units.some(unit => preferences.test(unit)) &&
    units.every(unit => defaults.test(unit) || preferences.test(unit) || shell.some(pattern => pattern.test(unit)))) return false;
  return units.some(unit => !shell.some(pattern => pattern.test(unit)));
}

// Explicit JSON-LD identities must refer to the fetched page. A recommendation
// is not evidence from this URL, even when it is the only article in the script.
// Resolve relative identities locally and ignore fragments; never fetch them or
// trust an arbitrary canonical/metadata URL to relabel the captured response.
function articleMatchesPage(record: Record<string, unknown>, pageUrl: string): boolean {
  let page: URL;
  try { page = new URL(pageUrl); page.hash = ''; } catch { return false; }
  const matches = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
      const identity = new URL(value, pageUrl);
      identity.hash = '';
      return (identity.protocol === 'https:' || identity.protocol === 'http:') && identity.href === page.href;
    } catch { return false; }
  };
  for (const key of ['url', '@id']) {
    if (key in record && !matches(record[key])) return false;
  }
  if ('mainEntityOfPage' in record) {
    const entity = record.mainEntityOfPage;
    if (typeof entity === 'string') return matches(entity);
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return false;
    const identity = entity as Record<string, unknown>;
    const keys = ['url', '@id'].filter(key => key in identity);
    return keys.length > 0 && keys.every(key => matches(identity[key]));
  }
  return true;
}

// Recognize a small local subset of JSON-LD context syntax. No context URLs
// are fetched and no aliases are expanded. Reject term definitions or conflicting
// vocabularies rather than interpreting articleBody under an unknown meaning.
function schemaOrgContext(value: unknown): boolean {
  const literal = (entry: unknown): boolean => typeof entry === 'string' && /^https?:\/\/schema\.org\/?$/.test(entry);
  const entryMatches = (entry: unknown): boolean => {
    if (literal(entry)) return true;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const context = entry as Record<string, unknown>;
    return Object.keys(context).length === 1 && literal(context['@vocab']);
  };
  if (Array.isArray(value)) return value.length > 0 && value.length <= 16 && value.every(entryMatches);
  return entryMatches(value);
}

type StructuredArticle = { text: string; title: string | null };

// Only a recognized schema.org articleBody is read from JSON. Framework state,
// arbitrary scripts, metadata descriptions, and paywalled structured bodies are
// deliberately not fallback sources. Bounds are independent of fetched-byte caps.
function structuredArticleBody(document: HtmlDocument, url: string): StructuredArticle | null {
  const bodies = new Map<string, Set<string | null>>();
  let bytes = 0;
  let visited = 0;
  let exceededBudget = false;
  const inspect = (value: unknown, depth: number, conflictingPage = false): void => {
    if (depth > 8 || ++visited > 512) { exceededBudget = true; return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.length > 512) { exceededBudget = true; return; }
      for (const entry of value) inspect(entry, depth + 1, conflictingPage);
      return;
    }
    const record = value as Record<string, unknown>;
    if ('@context' in record && !schemaOrgContext(record['@context'])) return;
    const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
    if (types.some(type => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?(?:Article|NewsArticle|BlogPosting|ScholarlyArticle|TechArticle)$/.test(type)) && (record.isAccessibleForFree === true || record.isAccessibleForFree === 'true')) {
      if (typeof record.articleBody === 'string' && record.articleBody.length <= 256_000 && articleMatchesPage(record, url) &&
        (!conflictingPage || ['url', '@id', 'mainEntityOfPage'].some(key => key in record))) {
        // articleBody is text, not an HTML or script execution channel.
        const body = record.articleBody.replace(/\r\n?/g, '\n').trim();
        const holder = documentFromHtml('<p></p>', url);
        holder.body.querySelector('p')!.textContent = body;
        if (hasArticleText(holder.body)) {
          const titles = bodies.get(body) ?? new Set<string | null>();
          titles.add(cleanMetadata(record.headline));
          bodies.set(body, titles);
        }
      }
    }
    // JSON-LD commonly wraps nodes in @graph. Do not recurse through arbitrary
    // properties (e.g. a recommendation's nested article or framework state).
    if (record['@graph']) {
      const graph = record['@graph'];
      const siblings = Array.isArray(graph) ? graph.slice(0, 512) : [graph];
      const explicitOtherPage = siblings.some(sibling => {
        if (!sibling || typeof sibling !== 'object' || Array.isArray(sibling)) return false;
        const page = sibling as Record<string, unknown>;
        if ('@context' in page && !schemaOrgContext(page['@context'])) return false;
        const pageTypes = Array.isArray(page['@type']) ? page['@type'] : [page['@type']];
        return pageTypes.some(type => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?WebPage$/.test(type)) &&
          ['url', '@id', 'mainEntityOfPage'].some(key => key in page) && !articleMatchesPage(page, url);
      });
      inspect(graph, depth + 1, conflictingPage || explicitOtherPage);
    }
  };
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  if (scripts.length > 16) return null;
  for (const script of scripts) {
    const source = script.textContent ?? '';
    bytes += source.length;
    if (bytes > 512_000 || source.length > 256_000) return null;
    try {
      const parsed: unknown = JSON.parse(source);
      const context = Array.isArray(parsed) ? null : parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['@context'] : null;
      // Arrays may contain independently qualified article nodes.
      if (Array.isArray(parsed)) {
        if (parsed.length > 512) return null;
        for (const entry of parsed) {
          if (entry && typeof entry === 'object' && schemaOrgContext(entry['@context'])) inspect(entry, 0);
        }
      } else if (schemaOrgContext(context)) inspect(parsed, 0);
    } catch { /* Invalid JSON is not article text. Never log source content. */ }
  }
  if (exceededBudget || bodies.size !== 1) return null;
  const [text, titles] = [...bodies][0]!;
  // Duplicate identical bodies may disagree on metadata. Preserve the body but
  // do not arbitrarily pick a headline or fall back to a rejected shell heading.
  return { text, title: titles.size === 1 ? [...titles][0]! : null };
}

export function extractHtml(html: string, url = 'https://reading-memory.invalid/'): ArticleExtraction {
  const document = documentFromHtml(html, url);
  const meta = (names: string[]) => {
    for (const name of names) {
      const content = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content');
      if (cleanMetadata(content)) return content;
    }
    return null;
  };
  const fallbackTitle = cleanMetadata(meta(['og:title', 'twitter:title']) ?? document.querySelector('title')?.textContent ?? document.querySelector('h1')?.textContent);
  const fallbackAuthor = cleanMetadata(meta(['author', 'article:author']), 200);
  const fallbackPublisher = cleanMetadata(meta(['og:site_name', 'application-name']), 200);
  const fallbackPublished = publicationTime(meta(['article:published_time', 'datePublished', 'date']));
  const readerDocument = documentFromHtml(html, url);
  removeChrome(readerDocument);
  // Readability can wrap bare link lists in paragraphs. Preserve only anchors
  // that already had prose context in the fetched document.
  const sourceProseAnchors = new Set([...readerDocument.querySelectorAll('p a,blockquote a')].map(anchor => (anchor.textContent ?? '').trim()));

  try {
    const article = new Readability(readerDocument as unknown as ConstructorParameters<typeof Readability>[0], { maxElemsToParse: 100_000 }).parse();
    if (article?.content) {
      const articleDocument = documentFromHtml(article.content, url);
      const text = textFromNode(articleDocument.body);
      if (text && hasArticleText(articleDocument.body, sourceProseAnchors)) {
        return {
          text,
          title: cleanMetadata(article.title) ?? fallbackTitle,
          author: cleanMetadata(article.byline, 200) ?? fallbackAuthor,
          publisher: cleanMetadata(article.siteName, 200) ?? fallbackPublisher,
          publishedAt: publicationTime(article.publishedTime) ?? fallbackPublished,
          extractor: 'readability',
          completeness: 'unknown',
          titleSource: cleanMetadata(article.title) ? 'article' : fallbackTitle ? 'document' : null
        };
      }
    }
  } catch {
    // Malformed or non-article pages retain useful visible text. Do not log
    // source content or the parser's potentially content-bearing exception.
  }

  removeChrome(document);
  // A placeholder or consent block in the first candidate must not hide a
  // later article. Inspect at most 16 roots of each category, in priority order.
  const roots = [...new Set([
    ...[...document.querySelectorAll('[itemprop="articleBody"]')].slice(0, 16),
    ...[...document.querySelectorAll('article')].slice(0, 16),
    ...[...document.querySelectorAll('main,[role="main"]')].slice(0, 16)
  ])];
  if (roots.length === 0) roots.push(document.body);
  const root = roots.find(candidate => hasArticleText(candidate as HtmlNode, sourceProseAnchors));
  const structuredText = root ? null : structuredArticleBody(document, url);
  return {
    text: root ? textFromNode(root as HtmlNode) : structuredText?.text ?? '',
    title: structuredText ? structuredText.title : fallbackTitle,
    author: structuredText ? null : fallbackAuthor,
    publisher: structuredText ? null : fallbackPublisher,
    publishedAt: structuredText ? null : fallbackPublished,
    extractor: structuredText ? 'structured-article-body' : 'html-fallback',
    completeness: 'unknown',
    titleSource: structuredText ? structuredText.title ? 'article' : null : fallbackTitle ? 'document' : null
  };
}

export function htmlToText(html: string): string {
  return extractHtml(html).text;
}
