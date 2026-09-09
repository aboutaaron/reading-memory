import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';
import { cleanMetadata } from './extract-html.js';

export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number; title: string | null; author: string | null }> {
  if (bytes.length > LIMITS.maxPdfBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds byte limit', 413);
  }

  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  // PDF.js assumes Uint8Array.slice copies; Buffer.slice instead aliases the
  // underlying bytes. Use a plain owned array to avoid corrupting small PDFs.
  const input = new Uint8Array(bytes);
  const parsed = await pdfParse(input, { max: LIMITS.maxPdfPages + 1 });
  if (parsed.numpages > LIMITS.maxPdfPages) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds page limit', 413);
  }

  const title = cleanMetadata(parsed.info?.Title);
  return {
    text: parsed.text,
    pages: parsed.numpages,
    title: title && !/^untitled(?:\s+\d+)?$/i.test(title) ? title : null,
    author: cleanMetadata(parsed.info?.Author, 200)
  };
}
