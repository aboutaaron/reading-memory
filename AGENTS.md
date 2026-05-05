# Reading Memory Agent Notes

- V1 binds to `127.0.0.1` only and is called by a local agent over localhost with bearer auth.
- Keep Flue imports behind `.flue/` or the analysis boundary. Store, query, HTTP, ingestion, and DB modules should remain framework-owned TypeScript.
- SQLite corpus tables are canonical. Flue session state is opaque.
- Do not log request bodies, extracted text, bearer tokens, or email recipient metadata.
- Use one synchronous `POST /ingest` endpoint with `source_type`.
- No arbitrary local filesystem PDF ingestion in request bodies.
