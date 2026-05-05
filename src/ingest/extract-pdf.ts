import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';

export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.length > LIMITS.maxPdfBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds byte limit', 413);
  }

  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const parsed = await pdfParse(Buffer.from(bytes));
  if (parsed.numpages > LIMITS.maxPdfPages) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds page limit', 413);
  }

  return { text: parsed.text, pages: parsed.numpages };
}
