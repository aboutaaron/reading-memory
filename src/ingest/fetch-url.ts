import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { LIMITS } from '../config.js';
import { ApiError } from '../api/errors.js';

export type Resolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

const ALLOWED_MIME = ['text/html', 'text/plain', 'application/xhtml+xml', 'application/pdf'];

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (ipv4Mapped?.[1]) return isPrivateIp(ipv4Mapped[1]);

  const parts = normalized.split('.').map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  return false;
}

export async function assertPublicHttpsUrl(url: URL, resolver: Resolver = dnsLookup) {
  if (url.protocol !== 'https:') {
    throw new ApiError('FETCH_FAILED', 'Only HTTPS URLs are supported', 400);
  }

  if (isIP(url.hostname) && isPrivateIp(url.hostname)) {
    throw new ApiError('FETCH_FAILED', 'Private IP URLs are blocked', 400);
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolver(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ApiError('FETCH_FAILED', 'DNS lookup failed for URL host', 502, true, 60);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new ApiError('FETCH_FAILED', 'URL resolves to a blocked address', 400);
  }
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
  const redirects = options.redirects ?? 0;
  if (redirects > LIMITS.maxRedirects) {
    throw new ApiError('FETCH_FAILED', 'Too many redirects', 400);
  }

  const url = new URL(input);
  await assertPublicHttpsUrl(url, options.resolver);

  const init: RequestInit = { redirect: 'manual' };
  if (options.signal) init.signal = options.signal;
  const response = await fetch(url, init);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new ApiError('FETCH_FAILED', 'Redirect response missing location', 502, true, 60);
    const next = new URL(location, url);
    await delay(1, undefined, { signal: options.signal });
    return fetchUrl(next.toString(), { ...options, redirects: redirects + 1 });
  }

  if (!response.ok) {
    throw new ApiError('FETCH_FAILED', `Fetch failed with HTTP ${response.status}`, 502, true, 60);
  }

  const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_MIME.includes(mime)) {
    throw new ApiError('UNSUPPORTED_MIME', `Unsupported MIME type: ${mime || 'unknown'}`, 415);
  }

  const maxBytes = options.maxBytes ?? LIMITS.maxUrlBytes;
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('FETCH_FAILED', 'Response body is empty', 502, true, 60);

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Fetched content exceeds byte limit', 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { finalUrl: response.url || url.toString(), mime, bytes, rawBytesHashInput: bytes };
}
