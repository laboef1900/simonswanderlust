import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimiter {
  /** Returns true if the request is allowed, false if it should be blocked. */
  check(key: string): boolean;
}

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Minimal in-memory fixed-window limiter — no dependency, fits the project's
 * memory-store idiom. Intended for the small set of auth endpoints, keyed by
 * client IP. Memory is bounded by an opportunistic sweep of expired entries.
 */
export function fixedWindowLimiter({ max, windowMs, now = () => Date.now() }: RateLimitOptions): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key) {
      const t = now();
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      }
      const e = hits.get(key);
      if (!e || t >= e.resetAt) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (e.count >= max) return false;
      e.count++;
      return true;
    },
  };
}

/** Fastify preHandler that 429s when the per-IP limiter is exhausted. */
export function rateLimitPreHandler(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!limiter.check(req.ip)) {
      reply.code(429).send({ error: 'too many attempts, please wait and try again' });
    }
  };
}
