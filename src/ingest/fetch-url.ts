import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Client, fetch } from 'undici';
import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';

export type Resolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

const ALLOWED_MIME = ['text/html', 'text/plain', 'application/xhtml+xml', 'application/pdf'];
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (!family || ip.includes('%')) return true;
  if (family === 6) {
    // URL canonicalization handles compressed, expanded, and dotted IPv4-mapped forms.
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Accept global unicast only. This also excludes local, multicast, NAT64,
    // and unspecified addresses. Block transition tunnels and documentation IPs.
    const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
    return firstHextet < 0x2000 || firstHextet > 0x3fff || normalized.startsWith('2002:') ||
      normalized.startsWith('2001:0:') || normalized.startsWith('2001::') ||
      normalized.startsWith('2001:db8:');
  }

  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

/** Resolve once and return the exact address permitted for this request's socket. */
export async function assertPublicHttpsUrl(url: URL, resolver: Resolver = dnsLookup): Promise<LookupAddress> {
  if (url.protocol !== 'https:') {
    throw new ApiError('FETCH_FAILED', 'Only HTTPS URLs are supported', 400);
  }
  if (url.username || url.password) {
    throw new ApiError('FETCH_FAILED', 'URLs containing credentials are not supported', 400);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const name = hostname.replace(/\.$/, '');
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost') || name.endsWith('.localhost.localdomain')) {
    throw new ApiError('FETCH_FAILED', 'Loopback URL hosts are blocked', 400);
  }
  const family = isIP(hostname);
  if (family) {
    if (isPrivateIp(hostname)) throw new ApiError('FETCH_FAILED', 'Private IP URLs are blocked', 400);
    return { address: hostname, family };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new ApiError('FETCH_FAILED', 'DNS lookup failed for URL host', 502, true, 60);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address) || isIP(entry.address) !== entry.family)) {
    throw new ApiError('FETCH_FAILED', 'URL resolves to a blocked address', 400);
  }
  return { ...addresses[0]! };
}

export type FetchedUrl = {
  finalUrl: string;
  mime: string;
  bytes: Uint8Array;
  rawBytesHashInput: Uint8Array;
};

export async function fetchUrl(
  input: string,
  options: { maxBytes?: number; resolver?: Resolver; redirects?: number; signal?: AbortSignal } = {}
): Promise<FetchedUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError('FETCH_FAILED', 'Invalid source URL', 400);
  }

  for (let redirects = options.redirects ?? 0; ; redirects += 1) {
    if (redirects > LIMITS.maxRedirects) throw new ApiError('FETCH_FAILED', 'Too many redirects', 400);
    if (options.signal?.aborted) throw new ApiError('TIMEOUT', 'URL fetch was aborted', 504, true, 60);
    const pinned = await assertPublicHttpsUrl(url, options.resolver);
    // Never call DNS again inside the transport. Keeping the original URL host
    // gives TLS its original SNI/certificate identity and preserves HTTP Host.
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ ...pinned }]);
      else callback(null, pinned.address, pinned.family);
    };
    const client = new Client(url.origin, { connect: { lookup }, autoSelectFamily: false });
    let response: Awaited<ReturnType<typeof fetch>> | undefined;
    try {
      response = await fetch(url, { redirect: 'manual', dispatcher: client, ...(options.signal ? { signal: options.signal } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new ApiError('FETCH_FAILED', 'Redirect response missing location', 502, true, 60);
        try {
          url = new URL(location, url);
        } catch {
          throw new ApiError('FETCH_FAILED', 'Invalid redirect URL', 502, true, 60);
        }
        continue;
      }
      if (!response.ok) throw new ApiError('FETCH_FAILED', `Fetch failed with HTTP ${response.status}`, 502, true, 60);

      const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!ALLOWED_MIME.includes(mime)) throw new ApiError('UNSUPPORTED_MIME', 'Unsupported response MIME type', 415);
      if (!response.body) throw new ApiError('FETCH_FAILED', 'Response body is empty', 502, true, 60);

      const maxBytes = options.maxBytes ?? LIMITS.maxUrlBytes;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'Fetched content exceeds byte limit', 413);
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { finalUrl: url.toString(), mime, bytes, rawBytesHashInput: bytes };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (options.signal?.aborted) throw new ApiError('TIMEOUT', 'URL fetch was aborted', 504, true, 60);
      // Do not leak target URLs, DNS answers, TLS details, or query credentials.
      throw new ApiError('FETCH_FAILED', 'Unable to fetch source URL', 502, true, 60);
    } finally {
      // Cancel redirects/errors without downloading their bodies and close the
      // per-hop pool, including failed/aborted/oversize response connections.
      await response?.body?.cancel().catch(() => {});
      await client.destroy();
    }
  }
}
