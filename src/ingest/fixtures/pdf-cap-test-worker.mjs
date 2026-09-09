import { parentPort, workerData } from 'node:worker_threads';

if (workerData.testMode === 'blocked') {
  while (true) { /* hold a real worker until the caller terminates it */ }
}

parentPort.postMessage({ ok: true, text: 'Parsed PDF evidence.', pages: 1, title: null, author: null });
// A result alone must not make the worker slot available.
setInterval(() => {}, 1_000);
