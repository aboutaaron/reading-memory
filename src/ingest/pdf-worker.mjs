import { parentPort, workerData } from 'node:worker_threads';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// The worker only receives owned bytes and server-defined limits. It accepts no
// filesystem path or URL, and emits only bounded content or fixed error codes.
try {
  const parsed = await pdfParse(new Uint8Array(workerData.bytes), { max: workerData.maxPages + 1 });
  if (parsed.numpages > workerData.maxPages) {
    parentPort.postMessage({ ok: false, code: 'PAGE_LIMIT' });
  } else if (parsed.text.length > workerData.maxOutputChars) {
    parentPort.postMessage({ ok: false, code: 'TEXT_LIMIT' });
  } else {
    const metadata = (value) => typeof value === 'string' ? value.slice(0, 2_000) : null;
    parentPort.postMessage({ ok: true, text: parsed.text, pages: parsed.numpages,
      title: metadata(parsed.info?.Title), author: metadata(parsed.info?.Author) });
  }
} catch {
  parentPort.postMessage({ ok: false, code: 'PARSE_FAILED' });
} finally {
  parentPort.close();
}
