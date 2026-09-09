# Article extraction quality

HTML capture rejects recognizable consent-only and navigation-only output before analysis or indexing. The API returns `FETCH_FAILED` with status 422 when no usable article text remains. The error contains no source text. A failed capture can remain in diagnostics; it is not evidence for answering a question.

This is a conservative check of extracted content, not a word-count threshold or a topic filter. Short substantive notes and articles about cookies or privacy remain eligible. It cannot recognize every language or custom consent interface. A successful extraction does not certify that the complete article was captured.

## Fallback behavior

Readability remains the first extractor. Visible server-rendered `article`, `main`, or `itemprop="articleBody"` markup can also supply text after page controls are removed. No scripts execute and no subresources are loaded.

When visible output is unusable, the extractor can read a single unambiguous `articleBody` string from schema.org JSON-LD with a recognized article type and explicit `isAccessibleForFree: true`. Arrays and `@graph` wrappers are supported. Explicit `url`, `@id`, or `mainEntityOfPage` identities must match the fetched page after resolving relative URLs and removing fragments. Conflicting, malformed, or unrelated identities cannot supply a body; no identity URLs are fetched. Metadata descriptions, arbitrary framework state, invalid JSON, unknown access status, and restricted bodies are not article content sources. The fallback never signs in, clicks consent controls, renders a client application, or circumvents a subscription gate.

Structured parsing examines at most 16 scripts, 256,000 characters per script/body, 512,000 script characters total, 512 visited nodes, and eight nesting levels. These are additional bounds; the URL fetcher's existing byte, deadline, redirect, and SSRF protections still apply. Multiple distinct candidate bodies fail conservatively.

HTML captures record `extraction_completeness: "unknown"` in provenance, including when `truncated` is false. `truncated` describes the local extraction cap, not whether a website supplied its entire article. The original URL, final URL, canonicalization rules, and raw-response hash remain intact. Structured fallback records `extractor: "structured-article-body"`.

## Checking a failed capture

Use a disposable database snapshot to retry the URL after updating. Compare the captured text with the article you can legitimately access. Check the opening, ending, quotations, and any missing callouts. If the response only contains a shell or unsupported client state, capture authorized article text manually with its original URL attribution, following [failed capture recovery](FAILED-CAPTURES.md).

Automated fixtures use synthetic pages. They cover consent-only failure before provider analysis and FTS indexing, short notes and privacy articles, visible article markup, structured public bodies, malformed/ambiguous/restricted input, and URL provenance. These checks do not establish that any particular live site's extraction is repaired. Keep actual source content and private URLs out of public bug reports and fixtures.
