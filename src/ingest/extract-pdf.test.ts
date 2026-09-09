import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, PDF_PARSE_LIMITS } from './extract-pdf.js';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';

// A deterministic one-page PDF fixture with an actual Info dictionary. No
// filesystem fixture or network fetch is needed to exercise PDF parsing.
function pdfFixture(info: string | null, pages = 1): Uint8Array {
  const content = 'BT /F1 12 Tf 72 720 Td (Durable reading memory retains evidence.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, () => '3 0 R').join(' ')}] /Count ${pages} >>`,
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


test('rejects PDF page counts above the existing cap inside the worker', async () => {
  await assert.rejects(extractPdfText(pdfFixture(null, LIMITS.maxPdfPages + 1)),
    (error: unknown) => error instanceof ApiError && error.code === 'PAYLOAD_TOO_LARGE' && error.message === 'PDF exceeds page limit');
});

test('bounds output before transferring parsed text and cleans up a successful worker', async () => {
  const workers: Worker[] = [];
  const input = pdfFixture('/Title (Worker metadata)');
  const originalBytes = new Uint8Array(input);
  const createWorker = (url: URL, options: WorkerOptions) => {
    assert.deepEqual(options.resourceLimits, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
    assert.deepEqual(options.execArgv, []);
    assert.deepEqual(options.env, {});
    assert.equal(options.stdout, true);
    assert.equal(options.stderr, true);
    assert.equal(options.workerData.maxOutputChars, PDF_PARSE_LIMITS.maxOutputChars);
    const worker = new Worker(url, options);
    workers.push(worker);
    return worker;
  };
  const parsed = await extractPdfText(input, undefined, { createWorker });
  assert.equal(parsed.title, 'Worker metadata');
  assert.deepEqual(new Uint8Array(input), originalBytes, 'the input Buffer is neither detached nor modified');
  assert.equal(workers[0]?.threadId, -1, 'success settles after the worker terminates');
  await assert.rejects(extractPdfText(input, undefined, { createWorker: (url, options) => {
    const worker = new Worker(url, { ...options, workerData: { ...options.workerData, maxOutputChars: 10 } });
    workers.push(worker);
    return worker;
  } }), (error: unknown) => error instanceof ApiError && error.message === 'PDF exceeds extracted text limit');
  assert.equal(workers[1]?.threadId, -1);
});

function fixtureWorker(mode: string, workers: Worker[], started?: SharedArrayBuffer) {
  return (_url: URL, options: WorkerOptions) => {
    const worker = new Worker(new URL('./fixtures/pdf-test-worker.mjs', import.meta.url), {
      ...options,
      ...(mode === 'memory' ? { resourceLimits: { ...options.resourceLimits, maxOldGenerationSizeMb: 16 } } : {}),
      workerData: { ...options.workerData, testMode: mode, started }
    });
    workers.push(worker);
    return worker;
  };
}

test('hard deadline terminates a CPU-bound parser while the main event loop stays responsive', { timeout: 5_000 }, async (t) => {
  const workers: Worker[] = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const started = new SharedArrayBuffer(4);
  let mainLoopTicks = 0;
  const timer = setInterval(() => { mainLoopTicks++; }, 10);
  try {
    await assert.rejects(extractPdfText(new Uint8Array([1]), undefined, {
      createWorker: fixtureWorker('blocked', workers, started), timeoutMs: 1_000
    }), (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT' && error.message.includes('time limit'));
    assert.equal(Atomics.load(new Int32Array(started), 0), 1, 'the parser actually started its busy loop');
    assert.ok(mainLoopTicks > 5, 'API event loop continues serving callbacks while parsing is blocked');
    assert.equal(workers[0]?.threadId, -1, 'timed-out parser is gone before returning');
  } finally {
    clearInterval(timer);
  }
});

test('caller cancellation terminates active parsing and pre-aborted calls never spawn', { timeout: 5_000 }, async (t) => {
  const workers: Worker[] = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const started = new SharedArrayBuffer(4);
  const controller = new AbortController();
  const pending = extractPdfText(new Uint8Array([1]), controller.signal, { createWorker: fixtureWorker('blocked', workers, started) });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT' && error.message === 'PDF parsing was aborted');
  while (!Atomics.load(new Int32Array(started), 0)) await delay(5);
  controller.abort(new Error('sensitive caller reason'));
  await rejected;
  assert.equal(workers[0]?.threadId, -1);
  await assert.rejects(extractPdfText(new Uint8Array([1]), controller.signal, { createWorker: () => { throw new Error('must not spawn'); } }),
    (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT');
});

test('worker memory exhaustion, crashes, and early exits are sanitized and cleaned up', { timeout: 10_000 }, async (t) => {
  const workers: Worker[] = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  for (const mode of ['memory', 'crash', 'exit']) {
    await assert.rejects(extractPdfText(new Uint8Array([1]), undefined, { createWorker: fixtureWorker(mode, workers) }),
      (error: unknown) => error instanceof ApiError && error.code === (mode === 'memory' ? 'PAYLOAD_TOO_LARGE' : 'FETCH_FAILED') &&
        !error.message.includes('sensitive'));
    assert.equal(workers.at(-1)?.threadId, -1);
  }
});

test('malformed PDFs return a typed error without source text', async () => {
  await assert.rejects(extractPdfText(new TextEncoder().encode('secret source text is not a PDF')),
    (error: unknown) => error instanceof ApiError && error.code === 'FETCH_FAILED' && error.status === 422 && error.message === 'Unable to parse PDF');
});
