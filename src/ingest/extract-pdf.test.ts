import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from './extract-pdf.js';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';

// A deterministic one-page PDF fixture with an actual Info dictionary. No
// filesystem fixture or network fetch is needed to exercise PDF parsing.
function pdfFixture(info: string | null): Uint8Array {
  const content = 'BT /F1 12 Tf 72 720 Td (Durable reading memory retains evidence.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...(info ? [`<< ${info} >>`] : [])
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info ? ' /Info 6 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('extracts PDF title and author from document metadata', async () => {
  const pdf = await extractPdfText(pdfFixture('/Title (Durable Reading) /Author (Ada Reader)'));
  assert.equal(pdf.title, 'Durable Reading');
  assert.equal(pdf.author, 'Ada Reader');
  assert.equal(pdf.pages, 1);
  assert.match(pdf.text, /Durable reading memory retains evidence\./);
});

test('keeps absent or placeholder PDF title metadata null', async () => {
  const absent = await extractPdfText(pdfFixture(null));
  assert.equal(absent.title, null);
  assert.equal(absent.author, null);
  const placeholder = await extractPdfText(pdfFixture('/Title (Untitled)'));
  assert.equal(placeholder.title, null);
});

test('rejects oversized PDFs before parsing', async () => {
  await assert.rejects(extractPdfText(new Uint8Array(LIMITS.maxPdfBytes + 1)), (error: unknown) => error instanceof ApiError && error.code === 'PAYLOAD_TOO_LARGE');
});
