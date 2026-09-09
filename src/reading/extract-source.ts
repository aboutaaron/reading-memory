import type { IngestRequest } from '../api/contracts.js';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';
import { fetchUrl } from '../ingest/fetch-url.js';
import { sha256, stableJson } from '../ingest/content-hash.js';
import { extractPdfText } from '../ingest/extract-pdf.js';
import { normalizeContent } from '../ingest/normalize-content.js';
import { cleanMetadata, extractHtml } from '../ingest/extract-html.js';

type ExtractionDependencies = { fetchUrl?: typeof fetchUrl; extractPdfText?: typeof extractPdfText };

export async function extractSource(request: IngestRequest, signal?: AbortSignal, dependencies: ExtractionDependencies = {}) {
  if (request.source_type !== request.source.type) {
    throw new ApiError('BAD_REQUEST', 'source_type must match source.type', 400);
  }

  if (request.source.type === 'text') {
    if (request.source.text.length > LIMITS.maxTextChars) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Text source exceeds character limit', 413);
    }
    const normalized = normalizeContent(request.source.text);
    if (!normalized.text) throw new ApiError('BAD_REQUEST', 'Text source contains no readable text', 400);
    const canonicalUrl = extractCanonicalUrlFromText(request.source.text);
    const title = cleanMetadata(request.source.title);
    return {
      sourceType: 'text' as const,
      sourceUri: null,
      canonicalUrl,
      finalUrl: null,
      title,
      author: null,
      publisher: null,
      publishedAt: null,
      extractedText: normalized.text,
      truncated: normalized.truncated,
      contentHash: normalized.contentHash,
      rawBytesHash: null,
      provenance: {
        source_context: request.source_context ?? null,
        ingest_reason: request.ingest_reason ?? null,
        extractor: 'text',
        title_source: title ? 'explicit' : null,
        truncated: normalized.truncated,
        extracted_chars: normalized.extractedChars,
        content_hash_basis: 'full-normalized-redacted-v1'
      }
    };
  }

  const url = request.source.url;
  const fetchOptions: Parameters<typeof fetchUrl>[1] = {
    maxBytes: request.source.type === 'pdf_url' ? LIMITS.maxPdfBytes : LIMITS.maxUrlBytes
  };
  if (signal) fetchOptions.signal = signal;
  const fetched = await (dependencies.fetchUrl ?? fetchUrl)(url, fetchOptions);

  if (request.source.type === 'pdf_url' && fetched.mime !== 'application/pdf') {
    throw new ApiError('UNSUPPORTED_MIME', `Expected PDF MIME type, got ${fetched.mime}`, 415);
  }

  const explicitTitle = cleanMetadata('title' in request.source ? request.source.title : null);
  let capture: { text: string; title: string | null; author: string | null; publisher: string | null; publishedAt: string | null; extractor: string; titleSource: string | null; pages?: number };
  if (fetched.mime === 'application/pdf') {
    const pdf = await (dependencies.extractPdfText ?? extractPdfText)(fetched.bytes);
    capture = { ...pdf, publisher: null, publishedAt: null, extractor: 'pdf', titleSource: pdf.title ? 'pdf-metadata' : null };
  } else if (fetched.mime === 'text/plain') {
    capture = { text: new TextDecoder().decode(fetched.bytes), title: null, author: null, publisher: null, publishedAt: null, extractor: 'text', titleSource: null };
  } else {
    capture = extractHtml(new TextDecoder().decode(fetched.bytes), fetched.finalUrl);
  }
  const normalized = normalizeContent(capture.text);
  if (!normalized.text) throw new ApiError('FETCH_FAILED', 'Source contains no readable text', 422);

  return {
    sourceType: request.source.type,
    sourceUri: url,
    canonicalUrl: canonicalizeUrl(url),
    finalUrl: fetched.finalUrl,
    title: explicitTitle ?? capture.title,
    author: capture.author,
    publisher: capture.publisher,
    publishedAt: capture.publishedAt,
    extractedText: normalized.text,
    truncated: normalized.truncated,
    contentHash: normalized.contentHash,
    rawBytesHash: sha256(fetched.rawBytesHashInput),
    provenance: {
      source_context: request.source_context ?? null,
      ingest_reason: request.ingest_reason ?? null,
      mime: fetched.mime,
      original_url: url,
      final_url: fetched.finalUrl,
      extractor: capture.extractor,
      title_source: explicitTitle ? 'explicit' : capture.titleSource,
      truncated: normalized.truncated,
      extracted_chars: normalized.extractedChars,
      content_hash_basis: 'full-normalized-redacted-v1',
      ...(capture.pages === undefined ? {} : { pdf_pages: capture.pages })
    }
  };
}

export function payloadHash(request: IngestRequest): string {
  return sha256(stableJson({
    source_type: request.source_type,
    source: request.source,
    source_context: request.source_context ?? null,
    ingest_reason: request.ingest_reason ?? null
  }));
}

function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hash = '';
  return url.toString();
}

function extractCanonicalUrlFromText(input: string): string | null {
  const patterns = [
    /view (?:this|the) (?:post|article|newsletter|email)[^\n]*?\b(?:at|on)\s+(https?:\/\/\S+)/i,
    /read (?:this|the) (?:post|article|newsletter)[^\n]*?\b(?:at|on)\s+(https?:\/\/\S+)/i,
    /canonical(?:\s+url)?\s*[:=]\s*(https?:\/\/\S+)/i,
    /\bsource\s*[:=]\s*(https?:\/\/\S+)/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    const candidate = match?.[1] ? cleanUrl(match[1]) : null;
    if (candidate) {
      try {
        return canonicalizeUrl(candidate);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function cleanUrl(input: string) {
  return input.replace(/[)\].,;!?'"<>]+$/g, '');
}
