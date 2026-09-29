import { HttpError } from './errors.ts';

export interface RateLimiter {
  /** Throws a 429 if `key` has exceeded the limit within the window. */
  check(key: string): void;
}

/**
 * A minimal in-memory fixed-window limiter. Good enough for a single-instance,
 * small community; it only exists to blunt brute-force login attempts.
 */
export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string): void {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < options.windowMs);

      if (recent.length >= options.limit) {
        throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a moment and try again.');
      }

      recent.push(now);
      hits.set(key, recent);

      // Prune idle keys so long-running servers do not leak memory.
      if (hits.size > 5_000) {
        for (const [entryKey, timestamps] of hits) {
          if (timestamps.every((at) => now - at >= options.windowMs)) hits.delete(entryKey);
        }
      }
    },
  };
}
