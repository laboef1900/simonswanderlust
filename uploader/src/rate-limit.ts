import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimiter {
  /** Returns true if the request is allowed, false if it should be blocked. */
  check(key: string): boolean;
}

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  /**
   * Hard cap on tracked keys. Keys are attacker-chosen (any string on the
   * wire, any address behind the proxy), so without a cap the map is a
   * memory sink; at the cap the oldest window is evicted, which can only
   * ever forget a counter, never lock anyone out (#109).
   */
  maxKeys?: number;
  now?: () => number;
}

export const DEFAULT_MAX_KEYS = 10_000;

interface WindowEntry { count: number; resetAt: number }

/**
 * Fixed-window counters with a hard size cap. Every window has the same
 * length, so insertion order IS expiry order: `open` re-inserts the key at the
 * back, expired entries are swept from the front, and when the cap is reached
 * the front (earliest-expiring, live) entry is evicted — all amortised O(1),
 * with no full-map sweep an attacker could trigger per request.
 */
function windowMap(windowMs: number, maxKeys: number) {
  const entries = new Map<string, WindowEntry>();
  return {
    /** The live entry for `key`, dropping it if its window has passed. */
    live(key: string, t: number): WindowEntry | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      if (t >= e.resetAt) {
        entries.delete(key);
        return undefined;
      }
      return e;
    },
    /** Starts a fresh window for `key` with one hit, evicting to stay under the cap. */
    open(key: string, t: number): WindowEntry {
      entries.delete(key);
      for (const [k, e] of entries) {
        if (t < e.resetAt && entries.size < maxKeys) break;
        entries.delete(k);
      }
      const e = { count: 1, resetAt: t + windowMs };
      entries.set(key, e);
      return e;
    },
    delete(key: string): void {
      entries.delete(key);
    },
  };
}

/**
 * Minimal in-memory fixed-window limiter — no dependency, fits the project's
 * memory-store idiom. Intended for the small set of auth endpoints, keyed by
 * client IP.
 */
export function fixedWindowLimiter({ max, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = () => Date.now() }: RateLimitOptions): RateLimiter {
  const hits = windowMap(windowMs, maxKeys);
  return {
    check(key) {
      const t = now();
      const e = hits.live(key, t);
      if (!e) {
        hits.open(key, t);
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

/**
 * Per-account failure limiter. The key is whatever identifies the account at
 * the call site: the submitted username on /login, the session's user id on
 * /users/me/password (the caller is already authenticated there). Failures
 * are counted across ALL sources — this is the defence against a brute force
 * spread over many addresses, which the per-IP limiter cannot see. Its
 * flip side is that anyone who can reach the budget can lock the account, so
 * the /login budget is set well above what one address can spend (#109).
 */
export interface AccountLimiter {
  /** Returns true if the account is locked due to excessive failed attempts. */
  isLocked(account: string): boolean;
  /** Records a failed attempt for the account. */
  recordFailure(account: string): void;
  /** Clears failures on a successful attempt for the account. */
  recordSuccess(account: string): void;
}

/**
 * Longest account key stored verbatim. Anything longer is stored as `#` +
 * SHA-256 hex: 65 characters, so it can never equal a verbatim key.
 */
export const MAX_KEY_LENGTH = 64;

/**
 * In-memory account lockout limiter: `max` failures inside one window lock the
 * account until the window ends. Bounded in key COUNT like `fixedWindowLimiter`
 * and in key LENGTH by hashing over-long accounts, so a 1 MiB username costs the
 * map 64 characters, while an account that really has such a name (created
 * before #109 capped them) keeps its own lockout budget.
 */
export function accountLockoutLimiter({ max = 5, windowMs = 900_000, maxKeys = DEFAULT_MAX_KEYS, now = () => Date.now() }: Partial<RateLimitOptions> = {}): AccountLimiter {
  const failures = windowMap(windowMs, maxKeys);
  const normalize = (u: string) => {
    const key = u.toLowerCase().trim();
    return key.length <= MAX_KEY_LENGTH ? key : `#${createHash('sha256').update(key).digest('hex')}`;
  };
  return {
    isLocked(username) {
      if (!username) return false;
      const entry = failures.live(normalize(username), now());
      return entry !== undefined && entry.count >= max;
    },
    recordFailure(username) {
      if (!username) return;
      const key = normalize(username);
      const t = now();
      const entry = failures.live(key, t);
      if (entry) entry.count++;
      else failures.open(key, t);
    },
    recordSuccess(username) {
      if (!username) return;
      failures.delete(normalize(username));
    },
  };
}
