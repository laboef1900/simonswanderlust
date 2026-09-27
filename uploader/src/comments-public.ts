import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CommentError, cleanBody, cleanEmail, cleanName, type CommentStore, type PublicComment } from './comments.js';
import type { Locale, PostStore } from './posts.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * Public reader-comment API (SPEC-API-001).
 *
 * @ai-warning These routes declare NO session preHandler: a reader's request
 * (even one carrying the admin's `sid` cookie) must never query the session
 * store (#129). Nothing here may log a comment field — name, email, body and
 * the honeypot are reader data.
 *
 * POST order is load-bearing: rate limit → honeypot (204) → Origin equality
 * (403) → validation (400) → published post (404) → comments flag (409) →
 * insert `pending` → 201 without echoing the input.
 */
export interface PublicCommentsOptions {
  comments?: CommentStore;
  posts: PostStore;
  /** Exact origin (scheme://host[:port]) a browser POST must carry. */
  allowedOrigin: string;
  /** Site-wide comments switch; false answers 409. */
  commentsEnabled: () => boolean;
  /** Per-IP limiter — its OWN map, never the login limiter. */
  ipLimiter: RateLimiter;
  /** Process-wide limiter (single key). */
  globalLimiter: RateLimiter;
}

/** Honeypot field name: hidden from humans, filled by naive bots. */
export const HONEYPOT_FIELD = 'website';
/** JSON body cap for POST /comments (spec decision 6). */
export const COMMENT_BODY_LIMIT = 4096;
const TK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const isLocale = (v: unknown): v is Locale => v === 'de' || v === 'en';

/** Explicit public serialization — exactly id, name, body, createdAt. */
export function toPublic(c: PublicComment): { id: string; name: string; body: string; createdAt: string } {
  return { id: c.id, name: c.name, body: c.body, createdAt: new Date(c.createdAt).toISOString() };
}

type PostLookup = 'missing' | 'disabled' | 'ok';

async function lookupPost(posts: PostStore, tk: string, locale: Locale): Promise<PostLookup> {
  const pair = await posts.get(tk);
  if (!pair || pair.status !== 'published' || !pair[locale]?.slug) return 'missing';
  return pair.shared.commentsEnabled === false ? 'disabled' : 'ok';
}

export function registerPublicComments(app: FastifyInstance, opts: PublicCommentsOptions): void {
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: 'comments are not available' });

  app.get('/comments', async (req, reply) => {
    const q = (req.query ?? {}) as { translationKey?: unknown; locale?: unknown };
    if (typeof q.translationKey !== 'string' || !TK_RE.test(q.translationKey) || !isLocale(q.locale)) {
      return reply.code(400).send({ error: 'translationKey and locale (de|en) are required' });
    }
    if (!opts.comments) return unavailable(reply);
    if ((await lookupPost(opts.posts, q.translationKey, q.locale)) === 'missing') {
      return reply.code(404).send({ error: 'not found' });
    }
    const list = await opts.comments.listApproved(q.translationKey, q.locale);
    return reply.header('cache-control', 'no-store').send({ comments: list.map(toPublic) });
  });

  const limit = async (req: FastifyRequest, reply: FastifyReply) => {
    // Per-IP first so one flooder cannot drain the global budget alone.
    if (!opts.ipLimiter.check(req.ip) || !opts.globalLimiter.check('global')) {
      return reply.code(429).send({ error: 'too many comments, please try again later' });
    }
  };

  app.post('/comments', { onRequest: limit, bodyLimit: COMMENT_BODY_LIMIT }, async (req, reply) => {
    const raw = req.body;
    const b = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const pot = b[HONEYPOT_FIELD];
    if (pot !== undefined && pot !== null && pot !== '') return reply.code(204).send();
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== opts.allowedOrigin) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const tk = b.translationKey;
    const locale = b.locale;
    if (typeof tk !== 'string' || !TK_RE.test(tk)) return reply.code(400).send({ error: 'invalid translationKey' });
    if (!isLocale(locale)) return reply.code(400).send({ error: 'locale must be de or en' });
    if (!opts.comments) return unavailable(reply);
    // Validate the reader fields without writing: create() re-cleans them.
    const input = { translationKey: tk, locale, name: b.name, body: b.body, email: b.email };
    try {
      cleanName(input.name); cleanBody(input.body); cleanEmail(input.email);
    } catch (e) {
      if (e instanceof CommentError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const post = await lookupPost(opts.posts, tk, locale);
    if (post === 'missing') return reply.code(404).send({ error: 'not found' });
    if (post === 'disabled' || !opts.commentsEnabled()) return reply.code(409).send({ error: 'comments are disabled' });
    try {
      await opts.comments.create({
        translationKey: tk, locale,
        name: input.name as string, body: input.body as string,
        email: (input.email as string | null | undefined) ?? null,
      });
    } catch (e) {
      if (e instanceof CommentError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return reply.code(201).send({ status: 'pending' });
  });
}
