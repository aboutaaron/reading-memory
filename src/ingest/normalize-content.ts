import { LIMITS } from '../config.js';
import { redactText } from './redact.js';
import { sha256 } from './content-hash.js';

export function normalizeContent(input: string): { text: string; truncated: boolean; contentHash: string; extractedChars: number } {
  const redacted = redactText(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (redacted.length > LIMITS.maxExtractedChars) {
    return { text: redacted.slice(0, LIMITS.maxExtractedChars), truncated: true, contentHash: sha256(redacted), extractedChars: redacted.length };
  }

  return { text: redacted, truncated: false, contentHash: sha256(redacted), extractedChars: redacted.length };
}

// Kept for callers that only need the extracted text.
export { htmlToText } from './extract-html.js';
