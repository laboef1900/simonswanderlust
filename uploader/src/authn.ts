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

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.authUser) reply.code(401).send({ error: 'unauthorized' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.authUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
  if (!req.authUser.isAdmin) reply.code(403).send({ error: 'forbidden' });
}
