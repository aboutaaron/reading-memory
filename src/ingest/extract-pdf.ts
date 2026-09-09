import { Worker, type WorkerOptions } from 'node:worker_threads';
import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';
import { cleanMetadata } from './extract-html.js';

export const PDF_PARSE_LIMITS = {
  maxConcurrentWorkers: 1,
  timeoutMs: 15_000,
  maxOutputChars: 2_000_000,
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
} as const;

type PdfText = { text: string; pages: number; title: string | null; author: string | null };
type ParserDependencies = { createWorker?: (url: URL, options: WorkerOptions) => Worker; timeoutMs?: number };

// Shared by all ingestion requests. Reject excess work without allocating input
// copies or retaining a queue of PDF buffers in the service process.
let activePdfWorkers = 0;

export async function extractPdfText(bytes: Uint8Array, signal?: AbortSignal, dependencies: ParserDependencies = {}): Promise<PdfText> {
  if (bytes.length > LIMITS.maxPdfBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds byte limit', 413);
  if (signal?.aborted) throw new ApiError('TIMEOUT', 'PDF parsing was aborted', 504, true, 60);
  if (activePdfWorkers >= PDF_PARSE_LIMITS.maxConcurrentWorkers) {
    throw new ApiError('FETCH_FAILED', 'PDF parser is busy; retry later', 503, true, 60);
  }

  activePdfWorkers++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    activePdfWorkers--;
  };

  let worker: Worker;
  try {
    // Transfer an owned array; do not detach the caller's bytes or a pooled Buffer.
    const input = new Uint8Array(bytes);
    worker = (dependencies.createWorker ?? ((url, options) => new Worker(url, options)))(new URL('./pdf-worker.mjs', import.meta.url), {
      workerData: { bytes: input.buffer, maxPages: LIMITS.maxPdfPages, maxOutputChars: PDF_PARSE_LIMITS.maxOutputChars },
      transferList: [input.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: PDF_PARSE_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: PDF_PARSE_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: PDF_PARSE_LIMITS.stackSizeMb
      },
      // Worker code is plain ESM in both source and build output. Keep parser
      // diagnostics and the service's environment out of the ingestion surface.
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true
    });
  } catch {
    releaseSlot();
    throw new ApiError('FETCH_FAILED', 'Unable to start PDF parser', 502, true, 60);
  }
  worker.stdout?.resume();
  worker.stderr?.resume();

  return new Promise<PdfText>((resolve, reject) => {
    let finished = false;
    const onStopped = () => {
      releaseSlot();
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const onTerminationFailure = () => {
      // A failed terminate call does not establish that the worker stopped.
      // Keep its slot and exit/error listeners until actual termination.
      if (worker.threadId === -1) onStopped();
      reject(new ApiError('FETCH_FAILED', 'Unable to stop PDF parser', 502, true, 60));
    };
    const finish = (error?: ApiError, result?: PdfText) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.removeListener('message', onMessage);
      // Settle only after termination, including success and malformed results.
      try {
        void worker.terminate().then(() => {
          onStopped();
          if (error) reject(error);
          else resolve(result!);
        }, onTerminationFailure);
      } catch {
        onTerminationFailure();
      }
    };
    const onAbort = () => finish(new ApiError('TIMEOUT', 'PDF parsing was aborted', 504, true, 60));
    const onExit = () => {
      onStopped();
      finish(new ApiError('FETCH_FAILED', 'PDF parser exited without a result', 422));
    };
    const onError = (error: Error & { code?: string }) => finish(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds parser memory limit', 413)
      : new ApiError('FETCH_FAILED', 'Unable to parse PDF', 422));
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object') { finish(new ApiError('FETCH_FAILED', 'Invalid PDF parser result', 422)); return; }
      const result = value as Record<string, unknown>;
      if (result.code === 'PAGE_LIMIT') { finish(new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds page limit', 413)); return; }
      if (result.code === 'TEXT_LIMIT') { finish(new ApiError('PAYLOAD_TOO_LARGE', 'PDF exceeds extracted text limit', 413)); return; }
      if (result.ok !== true || typeof result.text !== 'string' || !Number.isInteger(result.pages) ||
        (result.pages as number) < 1 || (result.pages as number) > LIMITS.maxPdfPages || result.text.length > PDF_PARSE_LIMITS.maxOutputChars) {
        finish(new ApiError('FETCH_FAILED', 'Unable to parse PDF', 422));
        return;
      }
      const title = cleanMetadata(result.title);
      finish(undefined, {
        text: result.text,
        pages: result.pages as number,
        title: title && !/^untitled(?:\s+\d+)?$/i.test(title) ? title : null,
        author: cleanMetadata(result.author, 200)
      });
    };
    const timer = setTimeout(() => finish(new ApiError('TIMEOUT', 'PDF parsing exceeded its time limit', 504, true, 60)),
      dependencies.timeoutMs ?? PDF_PARSE_LIMITS.timeoutMs);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
