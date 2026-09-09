import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Client, fetch } from 'undici';
import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';

export type Resolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

const ALLOWED_MIME = ['text/html', 'text/plain', 'application/xhtml+xml', 'application/pdf'];
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

// Conservative fetch policy: reject whole IANA special-purpose blocks, even
// their globally reachable service/anycast exceptions, plus IPv4 multicast.
// Registries checked 2026-09-09 (both last updated 2025-10-09):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blockedIpRanges = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedIpRanges.addSubnet(address, prefix, 'ipv4');

// The remaining IPv6 special-purpose blocks are outside 2000::/3 and rejected
// below. IPv4-mapped IPv6 addresses use the embedded IPv4 address's policy.
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['2620:4f:8000::', 48], ['3fff::', 20]
] as const) blockedIpRanges.addSubnet(address, prefix, 'ipv6');

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (!family || ip.includes('%')) return true;
  if (family === 6) {
    // URL canonicalization handles compressed, expanded, and dotted IPv4-mapped forms.
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      return isBlockedIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Restrict native IPv6 to 2000::/3, then apply the special-purpose policy.
    // This also excludes local, multicast, NAT64, and unspecified addresses.
    const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
    return firstHextet < 0x2000 || firstHextet > 0x3fff || blockedIpRanges.check(normalized, 'ipv6');
  }

  return blockedIpRanges.check(ip, 'ipv4');
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
    if (isBlockedIp(hostname)) throw new ApiError('FETCH_FAILED', 'Non-public or special-purpose IP URLs are blocked', 400);
    return { address: hostname, family };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new ApiError('FETCH_FAILED', 'DNS lookup failed for URL host', 502, true, 60);
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedIp(entry.address) || isIP(entry.address) !== entry.family)) {
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
