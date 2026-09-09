import { ApiError } from './errors.js';

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private nextPruneAt = 0;

  constructor(private readonly limits: Record<string, number>) {}

  check(principal: string, route: string, now = Date.now()) {
    // Reclaim inactive principals without scanning every bucket on each request.
    if (now >= this.nextPruneAt) {
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(key);
      }
      this.nextPruneAt = now + 60_000;
    }
    const limit = this.limits[route] ?? 30;
    const key = `${principal}:${route}`;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }

    if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      throw new ApiError('RATE_LIMITED', 'Rate limit exceeded', 429, true, retryAfter);
    }

    bucket.count += 1;
  }
}
