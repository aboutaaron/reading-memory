import type { IngestRequest } from '../api/contracts.js';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';
import { fetchUrl } from '../ingest/fetch-url.js';
import { sha256, stableJson } from '../ingest/content-hash.js';
import { extractPdfText } from '../ingest/extract-pdf.js';
import { htmlToText, normalizeContent } from '../ingest/normalize-content.js';

export async function extractSource(request: IngestRequest, signal?: AbortSignal) {
  if (request.source_type !== request.source.type) {
    throw new ApiError('BAD_REQUEST', 'source_type must match source.type', 400);
  }

  if (request.source.type === 'text') {
    if (request.source.text.length > LIMITS.maxTextChars) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Text source exceeds character limit', 413);
    }
    const normalized = normalizeContent(request.source.text);
    return {
      sourceType: 'text' as const,
      sourceUri: null,
      canonicalUrl: null,
      finalUrl: null,
      title: request.source.title ?? null,
      extractedText: normalized.text,
      truncated: normalized.truncated,
      contentHash: sha256(normalized.text),
      rawBytesHash: null,
      provenance: { source_context: request.source_context ?? null, ingest_reason: request.ingest_reason ?? null }
    };
  }

  const url = request.source.url;
  const fetchOptions: Parameters<typeof fetchUrl>[1] = {
    maxBytes: request.source.type === 'pdf_url' ? LIMITS.maxPdfBytes : LIMITS.maxUrlBytes
  };
  if (signal) fetchOptions.signal = signal;
  const fetched = await fetchUrl(url, fetchOptions);

  if (request.source.type === 'pdf_url' && fetched.mime !== 'application/pdf') {
    throw new ApiError('UNSUPPORTED_MIME', `Expected PDF MIME type, got ${fetched.mime}`, 415);
  }

  const rawText = fetched.mime === 'application/pdf'
    ? (await extractPdfText(fetched.bytes)).text
    : htmlToText(new TextDecoder().decode(fetched.bytes));
  const normalized = normalizeContent(rawText);

  return {
    sourceType: request.source.type,
    sourceUri: url,
    canonicalUrl: canonicalizeUrl(url),
    finalUrl: fetched.finalUrl,
    title: null,
    extractedText: normalized.text,
    truncated: normalized.truncated,
    contentHash: sha256(normalized.text),
    rawBytesHash: sha256(fetched.rawBytesHashInput),
    provenance: {
      source_context: request.source_context ?? null,
      ingest_reason: request.ingest_reason ?? null,
      mime: fetched.mime,
      original_url: url,
      final_url: fetched.finalUrl
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
