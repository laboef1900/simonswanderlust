import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CommentError, cleanBody, cleanName, type CommentStore, type PublicComment } from './comments.js';
import type { Locale, PostStore, StoredPostPair } from './posts.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * Public reader-comment API (SPEC-API-001, issue #206).
 *
 * @ai-warning These routes declare NO session preHandler: a reader's request
 * (even one carrying the admin's `sid` cookie) must never query the session
 * store (#129). Nothing here may log a comment field — name, body, the
 * honeypot and the translation key are reader data on this path (spec
 * invariant 11), which is also why store failures are caught HERE rather than
 * left to the global error handler (it logs `req.url`, which on GET carries
 * the key).
 *
 * POST order is load-bearing and pinned by tests: rate limit (429) → honeypot
 * (204, no row, no log) → Origin/Referer origin equality (403) → validation
 * (400 `invalid_comment`) → published pair (404) → flags (409
 * `comments_disabled`) → insert `pending` → 201 `{ ok: true }` without echoing
 * the input or the new id.
 *
 * Email is deliberately NOT read off the body (spec decision 3: no email is
 * collected); `create` is always called with `email: null`.
 */
export interface PublicCommentsOptions {
  comments?: CommentStore;
  posts: PostStore;
  /** Exact origin (scheme://host[:port]) a browser POST must carry. */
  allowedOrigin: string;
  /** Site-wide comments switch; false answers 409 and `enabled: false`. */
  commentsEnabled: () => boolean;
  /** Per-IP limiter — its OWN map, never the login limiter. */
  ipLimiter: RateLimiter;
  /** Process-wide limiter (single key). */
  globalLimiter: RateLimiter;
  /**
   * Ids of APPROVED author replies (`is_author = true`) for one translation
   * key. The public store's shape carries no author flag, so the route asks
   * for the id set separately; absent → every comment reports `isAuthor: false`.
   */
  isAuthorIds?: (translationKey: string) => Promise<Set<string>>;
}

/** Honeypot field name: hidden from humans, filled by naive bots. */
export const HONEYPOT_FIELD = 'website';
/** JSON body cap for POST /comments (spec decision 6). */
export const COMMENT_BODY_LIMIT = 4096;
/** Hard cap on rows one GET returns (spec misuse case 9). */
export const GET_LIMIT = 500;
/** Translation keys are UUIDs today; 128 is generous and bounds the lookup. */
export const TK_MAX = 128;

const LOCALES: readonly Locale[] = ['de', 'en'];
const isLocale = (v: unknown): v is Locale => v === 'de' || v === 'en';
const isKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= TK_MAX && !/\p{C}/u.test(v);

/** The ONLY public serialization. Never status, never email, never anything else. */
export interface PublicCommentJson {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
  isAuthor: boolean;
  postedLocale: Locale;
}

export function toPublic(c: PublicComment, postedLocale: Locale, isAuthor: boolean): PublicCommentJson {
  return {
    id: c.id, authorName: c.name, body: c.body,
    createdAt: new Date(c.createdAt).toISOString(), isAuthor, postedLocale,
  };
}

/** Origin of the request: `Origin`, else the origin of `Referer`; null when neither parses. */
export function requestOrigin(headers: { origin?: unknown; referer?: unknown }): string | null {
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    try { return new URL(origin).origin; } catch { return null; }
  }
  const referer = headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try { return new URL(referer).origin; } catch { return null; }
  }
  return null;
}

const NOT_FOUND = { error: 'not_found' } as const;

export function registerPublicComments(app: FastifyInstance, opts: PublicCommentsOptions): void {
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: 'comments_unavailable' });
  // Sanitized 500 that never logs the request URL or any field (invariant 11).
  const failed = (reply: FastifyReply, where: string, e: unknown) => {
    console.error(`comments: ${where} failed: ${e instanceof Error ? e.message : String(e)}`);
    return reply.code(500).send({ error: 'internal server error' });
  };
  const publishedPair = async (tk: string): Promise<StoredPostPair | null> => {
    const pair = await opts.posts.get(tk);
    return pair && pair.status === 'published' ? pair : null;
  };
  const isEnabled = (pair: StoredPostPair) => opts.commentsEnabled() && pair.shared.commentsEnabled !== false;

  app.get('/comments', async (req, reply) => {
    const q = (req.query ?? {}) as { tk?: unknown };
    if (!isKey(q.tk)) return reply.code(400).send({ error: 'invalid_key' });
    if (!opts.comments) return unavailable(reply);
    const tk = q.tk;
    let pair: StoredPostPair | null;
    let rows: PublicCommentJson[];
    try {
      pair = await publishedPair(tk);
      if (!pair) return reply.code(404).send(NOT_FOUND);
      const authorIds = opts.isAuthorIds ? await opts.isAuthorIds(tk) : new Set<string>();
      const perLocale = await Promise.all(LOCALES.map(async (loc) =>
        (await opts.comments!.listApproved(tk, loc)).map((c) => ({ c, loc }))));
      rows = perLocale.flat()
        .sort((a, b) => new Date(a.c.createdAt).getTime() - new Date(b.c.createdAt).getTime())
        .slice(0, GET_LIMIT)
        .map(({ c, loc }) => toPublic(c, loc, authorIds.has(c.id)));
    } catch (e) {
      return failed(reply, 'GET', e);
    }
    return reply.header('cache-control', 'no-store').send({ enabled: isEnabled(pair), comments: rows });
  });

  const limit = async (req: FastifyRequest, reply: FastifyReply) => {
    // Per-IP first so one flooder cannot drain the global budget alone.
    if (!opts.ipLimiter.check(req.ip) || !opts.globalLimiter.check('global')) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
  };

  app.post('/comments', { onRequest: limit, bodyLimit: COMMENT_BODY_LIMIT }, async (req, reply) => {
    const raw = req.body;
    const b = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    // 2. Honeypot: a filled field is a bot — "pretend success", no row, no log.
    const pot = b[HONEYPOT_FIELD];
    if (pot !== undefined && pot !== null && (typeof pot !== 'string' || pot.trim() !== '')) {
      return reply.code(204).send();
    }
    // 3. Origin equality (never a prefix), Referer as the fallback.
    if (requestOrigin(req.headers) !== opts.allowedOrigin) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // 4. Validation — one generic code; the island maps it to i18n copy.
    const tk = b.translationKey;
    const postedLocale = b.postedLocale;
    if (!isKey(tk) || !isLocale(postedLocale)) return reply.code(400).send({ error: 'invalid_comment' });
    let name: string;
    let body: string;
    try {
      name = cleanName(b.authorName);
      body = cleanBody(b.body);
    } catch (e) {
      if (e instanceof CommentError) return reply.code(400).send({ error: 'invalid_comment' });
      throw e;
    }
    if (!opts.comments) return unavailable(reply);
    try {
      // 5. Published pair, 6. flags, 7. insert pending.
      const pair = await publishedPair(tk);
      if (!pair) return reply.code(404).send(NOT_FOUND);
      if (!isEnabled(pair)) return reply.code(409).send({ error: 'comments_disabled' });
      await opts.comments.create({ translationKey: tk, locale: postedLocale, name, body, email: null });
    } catch (e) {
      if (e instanceof CommentError) return reply.code(400).send({ error: 'invalid_comment' });
      return failed(reply, 'POST', e);
    }
    return reply.code(201).send({ ok: true });
  });
}
