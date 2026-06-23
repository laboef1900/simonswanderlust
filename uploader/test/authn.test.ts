import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { loadUser, requireAuth, requireAdmin, setSessionCookie, SESSION_COOKIE } from '../src/authn.js';

async function tinyApp() {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', async (req) => { req.authUser = await loadUser(req, users, sessions); });
  app.get('/auth-only', { preHandler: requireAuth }, async () => ({ ok: true }));
  app.get('/admin-only', { preHandler: requireAdmin }, async () => ({ ok: true }));
  return { app, users, sessions };
}

describe('auth hooks', () => {
  it('loadUser returns null without a cookie and the user with a valid one', async () => {
    const { users, sessions } = await tinyApp();
    const u = await users.create({ username: 'a', password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    expect(await loadUser({ cookies: {} } as never, users, sessions)).toBeNull();
    const got = await loadUser({ cookies: { [SESSION_COOKIE]: token } } as never, users, sessions);
    expect(got).toMatchObject({ username: 'a', isAdmin: false });
  });

  it('requireAuth: 401 anonymous, 200 with session', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/auth-only' })).statusCode).toBe(401);
    const u = await users.create({ username: 'a', password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    const res = await app.inject({ method: 'GET', url: '/auth-only', cookies: { sid: token } });
    expect(res.statusCode).toBe(200);
  });

  it('requireAdmin: 401 anonymous, 403 author, 200 admin', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/admin-only' })).statusCode).toBe(401);
    const author = await users.create({ username: 'author', password: 'pw', isAdmin: false });
    const at = await sessions.create(author.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: at } })).statusCode).toBe(403);
    const admin = await users.create({ username: 'admin', password: 'pw', isAdmin: true });
    const adt = await sessions.create(admin.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: adt } })).statusCode).toBe(200);
  });

  it('setSessionCookie sets HttpOnly SameSite=Strict with Secure only when asked', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/s', async (_req, reply) => { setSessionCookie(reply, 'tok', true); return 'ok'; });
    app.get('/i', async (_req, reply) => { setSessionCookie(reply, 'tok', false); return 'ok'; });
    const secure = await app.inject({ method: 'GET', url: '/s' });
    const insecure = await app.inject({ method: 'GET', url: '/i' });
    expect(secure.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(secure.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    expect(secure.headers['set-cookie']).toMatch(/Secure/i);
    expect(insecure.headers['set-cookie']).not.toMatch(/Secure/i);
  });
});
