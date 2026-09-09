# URL fetching

URL and PDF ingestion share `src/ingest/fetch-url.ts`. Only HTTPS URLs without embedded credentials are accepted.

For each hop, including redirects to the same hostname, the service resolves all DNS answers and rejects the request if any answer is non-public or invalid. It then creates an isolated Undici client whose socket lookup returns the first validated address. The connector does not perform a second DNS lookup or fall back to an unvalidated address. The URL hostname remains the HTTP Host and TLS SNI/certificate identity; normal certificate verification stays enabled. Each redirect receives a new validation and client, with at most five redirects.

The address policy rejects IPv4 private, loopback, link-local, zero-net, shared, benchmark, multicast, and reserved ranges. IPv4-mapped IPv6 addresses receive the same IPv4 checks, including compressed and hexadecimal spellings. Other IPv6 addresses must be global unicast; local, link-local, multicast, unspecified, NAT64, transition tunnel, and documentation addresses are rejected. Loopback names (`localhost`, its subdomains, `localhost.localdomain`, `ip6-localhost`, and `ip6-loopback`) are rejected before DNS, even if a resolver supplies a public address.

The client is destroyed after each hop. Redirect/error bodies are canceled without downloading them; aborts and byte-limit failures also cancel the body and close its connection. Network and TLS failures return a retryable `FETCH_FAILED` envelope without exposing URL credentials, query strings, IP addresses, or transport error details. Abort signals return `TIMEOUT`.

`src/ingest/fetch-url.test.ts` exercises the real Undici connector against a local TLS fixture. At the test-only socket boundary it observes the pinned address before routing the socket to the fixture; TLS verification and the original Host/SNI remain intact. Tests cover rebinding, per-hop validation, unsafe redirects, certificate hostname mismatch, hanging oversized bodies, and cancellation. The certificate and private key under `src/ingest/fixtures/fetch-test-*` are public test fixtures only and must never be used for a deployed service.
