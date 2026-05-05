# P1: Reading Memory security controls

Priority: P1
Status: implemented
Source: ce:review 2026-05-03
Plan: docs/plans/2026-05-03-feat-kazan-mini-reading-memory-plan.md

## Finding
The API ingests hostile external content and private text/email excerpts. Security controls must be built before first deploy, not added later.

## Required Work
- Bearer token from env/root-readable secret, constant-time compare, no token logging, rotation path.
- URL fetcher blocks SSRF including DNS rebinding/TOCTOU and redirects to private IPs.
- TLS verification mandatory.
- MIME allowlist and content sniffing where practical.
- Default redaction for email headers, recipients, unsubscribe tokens.
- Log metadata only, never raw text/extracted content/request bodies.
- No permissive CORS.
- Global HTTP body size limit.

## Acceptance Criteria
- Tests cover private IP, redirect-to-private, DNS rebinding fixture, invalid TLS, unsupported MIME, too-large body, prompt injection, and log redaction.
