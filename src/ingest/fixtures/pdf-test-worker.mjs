import { workerData } from 'node:worker_threads';

// Test-only parser substitutes that cannot run on the API event loop.
if (workerData.started) Atomics.store(new Int32Array(workerData.started), 0, 1);
if (workerData.testMode === 'memory') {
  const heap = [];
  while (true) heap.push(new Array(10_000).fill('fixture allocation'));
} else if (workerData.testMode === 'crash') {
  throw new Error('sensitive source text must never leave this worker');
} else if (workerData.testMode !== 'exit') {
  while (true) { /* deliberately block the worker thread */ }
}
