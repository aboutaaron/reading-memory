import { LIMITS } from '../config.js';
import { redactText } from './redact.js';

export function normalizeContent(input: string): { text: string; truncated: boolean } {
  const redacted = redactText(input)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (redacted.length > LIMITS.maxExtractedChars) {
    return { text: redacted.slice(0, LIMITS.maxExtractedChars), truncated: true };
  }

  return { text: redacted, truncated: false };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
