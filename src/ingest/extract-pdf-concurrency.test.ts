import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { extractPdfText, PDF_PARSE_LIMITS } from './extract-pdf.js';
import { ApiError } from '../api/errors.js';

const input = new Uint8Array([1]);

function fixtureWorkers(t: TestContext) {
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => Worker.prototype.terminate.call(worker)));
  });
  const createWorker = (mode = 'result') => (_url: URL, options: WorkerOptions) => {
    const worker = new Worker(new URL('./fixtures/pdf-cap-test-worker.mjs', import.meta.url), {
      ...options,
      workerData: { ...options.workerData, testMode: mode }
    });
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
}

function isOverload(error: unknown) {
  return error instanceof ApiError && error.code === 'FETCH_FAILED' && error.status === 503 &&
    error.retryable && error.retryAfterSeconds === 60 && error.message === 'PDF parser is busy; retry later';
}

test('ten concurrent PDF requests spawn one worker and reject overload without queuing', { timeout: 5_000 }, async (t) => {
  const { workers, createWorker } = fixtureWorkers(t);
  const controller = new AbortController();
  let allowTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => { allowTermination = resolve; });
  t.after(() => { allowTermination(); });
  let terminating = false;
  const blockedFactory = createWorker('blocked');
  const active = extractPdfText(input, controller.signal, { createWorker: (url, options) => {
    const worker = blockedFactory(url, options);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminating = true;
      return terminationGate.then(terminate);
    };
    return worker;
  } });
  const cancelled = assert.rejects(active, (error: unknown) => error instanceof ApiError &&
    error.code === 'TIMEOUT' && error.message === 'PDF parsing was aborted');

  // All excess calls must finish while the first worker remains alive.
  await Promise.all(Array.from({ length: 9 }, () => assert.rejects(
    extractPdfText(input, undefined, { createWorker: createWorker('blocked') }), isOverload)));
  assert.equal(PDF_PARSE_LIMITS.maxConcurrentWorkers, 1);
  assert.equal(workers.length, 1);
  assert.notEqual(workers[0]!.threadId, -1);

  const preAborted = new AbortController();
  preAborted.abort(new Error('sensitive abort reason'));
  await assert.rejects(extractPdfText(input, preAborted.signal, { createWorker: createWorker() }),
    (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT');

  controller.abort();
  assert.equal(terminating, true);
  await assert.rejects(extractPdfText(input, undefined, { createWorker: createWorker() }), isOverload);
  assert.equal(workers.length, 1, 'cancellation retains capacity until the old worker exits');
  allowTermination();
  await cancelled;
  assert.equal(workers[0]!.threadId, -1);

  const result = await extractPdfText(input, undefined, { createWorker: createWorker() });
  assert.equal(result.text, 'Parsed PDF evidence.');
  assert.equal(workers.length, 2, 'rejected calls did not leave a delayed queue');
  assert.equal(workers[1]!.threadId, -1);
});

test('a PDF parser deadline releases capacity after terminating the worker', { timeout: 5_000 }, async (t) => {
  const { workers, createWorker } = fixtureWorkers(t);
  await assert.rejects(extractPdfText(input, undefined, { createWorker: createWorker('blocked'), timeoutMs: 30 }),
    (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT' && error.message.includes('time limit'));
  assert.equal(workers[0]!.threadId, -1);
  assert.equal((await extractPdfText(input, undefined, { createWorker: createWorker() })).pages, 1);
  assert.equal(workers.length, 2);
});

test('worker construction failure returns a sanitized error and releases PDF capacity', async (t) => {
  const { workers, createWorker } = fixtureWorkers(t);
  await assert.rejects(extractPdfText(input, undefined, { createWorker: () => {
    throw new Error('sensitive construction failure');
  } }), (error: unknown) => error instanceof ApiError && error.code === 'FETCH_FAILED' &&
    error.status === 502 && error.retryable && error.message === 'Unable to start PDF parser');
  assert.equal((await extractPdfText(input, undefined, { createWorker: createWorker() })).pages, 1);
  assert.equal(workers.length, 1);
});

for (const failure of ['reject', 'throw'] as const) {
  test(`PDF worker termination ${failure} retains capacity until actual exit`, { timeout: 5_000 }, async (t) => {
    const { workers, createWorker } = fixtureWorkers(t);
    const controller = new AbortController();
    const blockedFactory = createWorker('blocked');
    const pending = extractPdfText(input, controller.signal, { createWorker: (url, options) => {
      const worker = blockedFactory(url, options);
      worker.terminate = () => {
        const error = new Error('sensitive termination failure');
        if (failure === 'throw') throw error;
        return Promise.reject(error);
      };
      return worker;
    } });
    const failed = assert.rejects(pending, (error: unknown) => error instanceof ApiError &&
      error.code === 'FETCH_FAILED' && error.status === 502 && error.retryable &&
      error.message === 'Unable to stop PDF parser');
    controller.abort();
    await failed;
    assert.notEqual(workers[0]!.threadId, -1);
    await assert.rejects(extractPdfText(input, undefined, { createWorker: createWorker() }), isOverload);
    assert.equal(workers.length, 1);

    await Worker.prototype.terminate.call(workers[0]!);
    assert.equal(workers[0]!.threadId, -1);
    assert.equal((await extractPdfText(input, undefined, { createWorker: createWorker() })).pages, 1);
    assert.equal(workers.length, 2);
  });
}

test('successful PDF results retain capacity while worker termination is pending', { timeout: 5_000 }, async (t) => {
  const { workers, createWorker } = fixtureWorkers(t);
  let allowTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => { allowTermination = resolve; });
  t.after(() => { allowTermination(); });
  let reportTerminating!: () => void;
  const terminating = new Promise<void>((resolve) => { reportTerminating = resolve; });
  const resultFactory = createWorker();
  const pending = extractPdfText(input, undefined, { createWorker: (url, options) => {
    const worker = resultFactory(url, options);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      reportTerminating();
      return terminationGate.then(terminate);
    };
    return worker;
  } });
  await terminating;
  await assert.rejects(extractPdfText(input, undefined, { createWorker: createWorker() }), isOverload);
  assert.notEqual(workers[0]!.threadId, -1);
  allowTermination();
  assert.equal((await pending).pages, 1);
  assert.equal(workers[0]!.threadId, -1);
  assert.equal((await extractPdfText(input, undefined, { createWorker: createWorker() })).pages, 1);
  assert.equal(workers.length, 2);
});
