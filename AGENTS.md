# Reading Memory Agent Notes

- V1 binds to `127.0.0.1` only and is called by a local agent over localhost with bearer auth.
- Keep provider SDK imports behind the analysis/provider boundary. Store, query, HTTP, ingestion, and DB modules remain application-owned TypeScript.
- SQLite corpus tables are canonical. Analysis performs one structured provider request; do not introduce conversation state or a tool execution loop.
- Do not log request bodies, extracted text, bearer tokens, or email recipient metadata.
- Use one synchronous `POST /ingest` endpoint with `source_type`.
- No arbitrary local filesystem PDF ingestion in request bodies.
