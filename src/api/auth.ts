import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function requireAuth(req: IncomingMessage, expectedToken: string): string {
  if (!expectedToken) {
    throw new ApiError('UNAUTHORIZED', 'READING_API_TOKEN is not configured', 503);
  }

  const auth = req.headers.authorization ?? '';
  const [scheme, token, extra] = auth.split(' ');
  if (scheme !== 'Bearer' || !token || extra !== undefined) {
    throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  }

  const expected = createHash('sha256').update(expectedToken).digest();
  const actual = createHash('sha256').update(token).digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid bearer token', 401);
  }

  return `token:${tokenFingerprint(token)}`;
}
