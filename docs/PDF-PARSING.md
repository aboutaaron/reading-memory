# PDF parsing

PDF URL ingestion uses the same validated, pinned HTTPS fetch path as article URLs. The API accepts bytes from that fetch only; it does not accept local PDF paths.

Parsing runs in a fresh worker thread, so a CPU-bound parser cannot block the API event loop. `extractSource` passes its request AbortSignal through to `extractPdfText`. The parent also enforces a 15-second parser deadline. Cancellation, deadline expiry, parser failure, memory exhaustion, and successful completion all terminate the worker before the parser promise settles. The existing 60-second overall ingestion deadline still includes fetching and analysis.

The parser retains the 10 MiB input cap and 50-page cap. It transfers an owned byte array to avoid modifying the caller's Buffer. Each worker has a 128 MiB old-generation V8 heap budget, 16 MiB young-generation budget, and 4 MiB stack budget. At most 2,000,000 extracted characters and bounded title/author fields can be returned to the API process. PDFs above the page, byte, memory, or text cap receive `PAYLOAD_TOO_LARGE`; aborts and deadline expiry receive `TIMEOUT`; malformed PDFs receive `FETCH_FAILED`. Title, author, page count, and text extraction remain supported.

These are parser workload limits, not an operating-system sandbox: Node's V8 resource limits do not cap every native allocation or total process RSS. Keep the deployment's service memory limit in place as the outer bound. Workers receive no service environment variables, and parser stdout/stderr are discarded. Public error messages contain no source text or parser exception details.

`pdf-worker.mjs` is plain ESM and is copied into the build output. Tests run the real parser on a valid metadata fixture and an oversized page tree, then exercise CPU-bound, crashed, early-exit, and memory-exhausting workers. They verify that main-thread timers keep running and no worker remains alive when extraction returns.
