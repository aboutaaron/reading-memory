import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { redactText } from './redact.js';

export type ArticleExtraction = {
  text: string;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  extractor: 'readability' | 'html-fallback';
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

  try {
    const article = new Readability(readerDocument as unknown as ConstructorParameters<typeof Readability>[0], { maxElemsToParse: 100_000 }).parse();
    if (article?.content) {
      const articleDocument = documentFromHtml(article.content, url);
      const text = textFromNode(articleDocument.body);
      if (text) {
        return {
          text,
          title: cleanMetadata(article.title) ?? fallbackTitle,
          author: cleanMetadata(article.byline, 200) ?? fallbackAuthor,
          publisher: cleanMetadata(article.siteName, 200) ?? fallbackPublisher,
          publishedAt: publicationTime(article.publishedTime) ?? fallbackPublished,
          extractor: 'readability',
          titleSource: cleanMetadata(article.title) ? 'article' : fallbackTitle ? 'document' : null
        };
      }
    }
  } catch {
    // Malformed or non-article pages retain useful visible text. Do not log
    // source content or the parser's potentially content-bearing exception.
  }

  removeChrome(document);
  const root = document.querySelector('article,main,[role="main"]') ?? document.body;
  return {
    text: textFromNode(root as HtmlNode),
    title: fallbackTitle,
    author: fallbackAuthor,
    publisher: fallbackPublisher,
    publishedAt: fallbackPublished,
    extractor: 'html-fallback',
    titleSource: fallbackTitle ? 'document' : null
  };
}

export function htmlToText(html: string): string {
  return extractHtml(html).text;
}
