import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserStore } from './users.js';
import type { SessionStore } from './sessions.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 2_592_000_000; // 30 days

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function loadUser(req: FastifyRequest, users: UserStore, sessions: SessionStore): Promise<AuthUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await sessions.find(token);
  if (!session) return null;
  const user = await users.findById(session.userId);
  if (!user) return null;
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

export type AuthGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface Authn {
  /** Resolves the session if a cookie is present; never refuses the request. */
  optionalAuth: AuthGuard;
  /** 401 when anonymous. */
  requireAuth: AuthGuard;
  /** 401 when anonymous, 403 when not an admin. */
  requireAdmin: AuthGuard;
}

/**
 * The session is resolved ONLY by these preHandlers, on the routes that declare
 * one — never by a global hook (#129). The blog, the image host, the basemap
 * and the admin static pages read no session, so they must not pay a Postgres
 * round trip per cookie-bearing request, and a down or hung database must not
 * 500 the public site for the one browser that holds an admin cookie.
 * `req.authUser` is therefore `null` on any route without one of these; a
 * handler that reads it must declare `optionalAuth` at least.
 *
 * A failing store propagates out of the guard (sanitized 500 via the error
 * handler). It is never read as "anonymous": that would turn a database outage
 * into a 401 and send the admin to a login form that cannot work either.
 */
export function createAuthn(users: UserStore, sessions: SessionStore): Authn {
  const optionalAuth: AuthGuard = async (req) => {
    req.authUser = await loadUser(req, users, sessions);
  };
  const requireAuth: AuthGuard = async (req, reply) => {
    await optionalAuth(req, reply);
    if (!req.authUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
  };
  const requireAdmin: AuthGuard = async (req, reply) => {
    await optionalAuth(req, reply);
    if (!req.authUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
    if (!req.authUser.isAdmin) { reply.code(403).send({ error: 'forbidden' }); return; }
  };
  return { optionalAuth, requireAuth, requireAdmin };
}
