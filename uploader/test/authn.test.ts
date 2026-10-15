import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { createAuthn, loadUser, setSessionCookie, SESSION_COOKIE } from '../src/authn.js';
import type { SessionStore } from '../src/sessions.js';

async function tinyApp(sessionStore?: SessionStore) {
  const users = memoryUserStore();
  const sessions = sessionStore ?? memorySessionStore();
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('authUser', null);
  const { optionalAuth, requireAuth, requireAdmin } = createAuthn(users, sessions);
  app.get('/public', async (req) => ({ user: req.authUser }));
  app.get('/whoami', { preHandler: optionalAuth }, async (req) => ({ user: req.authUser }));
  app.get('/auth-only', { preHandler: requireAuth }, async () => ({ ok: true }));
  app.get('/admin-only', { preHandler: requireAdmin }, async () => ({ ok: true }));
  return { app, users, sessions };
}

/** A session store that records lookups and can be made to fail like a down Postgres. */
function spyingSessions(fail = false) {
  const inner = memorySessionStore();
  let finds = 0;
  const store: SessionStore = {
    ...inner,
    find: async (token) => {
      finds++;
      if (fail) throw new Error('pg: connection refused');
      return inner.find(token);
    },
  };
  return { store, finds: () => finds };
}

describe('auth hooks', () => {
  it('loadUser returns null without a cookie and the user with a valid one', async () => {
    const { users, sessions } = await tinyApp();
    const u = await users.create({ username: 'a', password: 'password123456', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    expect(await loadUser({ cookies: {} } as never, users, sessions)).toBeNull();
    const got = await loadUser({ cookies: { [SESSION_COOKIE]: token } } as never, users, sessions);
    expect(got).toMatchObject({ username: 'a', isAdmin: false });
  });

  it('requireAuth: 401 anonymous, 200 with session', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/auth-only' })).statusCode).toBe(401);
    const u = await users.create({ username: 'a', password: 'password123456', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    const res = await app.inject({ method: 'GET', url: '/auth-only', cookies: { sid: token } });
    expect(res.statusCode).toBe(200);
  });

  it('requireAdmin: 401 anonymous, 403 author, 200 admin', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/admin-only' })).statusCode).toBe(401);
    const author = await users.create({ username: 'author', password: 'password123456', isAdmin: false });
    const at = await sessions.create(author.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: at } })).statusCode).toBe(403);
    const admin = await users.create({ username: 'admin', password: 'password123456', isAdmin: true });
    const adt = await sessions.create(admin.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: adt } })).statusCode).toBe(200);
  });

  // #129: the session is resolved by the route's preHandler, never globally.
  it('a route without an auth preHandler never consults the session store, cookie or not', async () => {
    const spy = spyingSessions();
    const { app, users, sessions } = await tinyApp(spy.store);
    const u = await users.create({ username: 'a', password: 'password123456', isAdmin: true });
    const token = await sessions.create(u.id, 60_000);
    const res = await app.inject({ method: 'GET', url: '/public', cookies: { sid: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
    expect(spy.finds()).toBe(0);
    const who = await app.inject({ method: 'GET', url: '/whoami', cookies: { sid: token } });
    expect(who.json().user).toMatchObject({ username: 'a', isAdmin: true });
    expect(spy.finds()).toBe(1);
  });

  it('optionalAuth admits anonymous callers; a failing store is an error on guarded routes, never "anonymous"', async () => {
    const down = spyingSessions(true);
    const { app } = await tinyApp(down.store);
    expect((await app.inject({ method: 'GET', url: '/whoami' })).json()).toEqual({ user: null });
    // With a cookie the lookup runs and its failure surfaces as a 500, not a 401
    // (which would read as "logged out") and not a pass.
    for (const url of ['/whoami', '/auth-only', '/admin-only']) {
      expect((await app.inject({ method: 'GET', url, cookies: { sid: 'x' } })).statusCode, url).toBe(500);
    }
    // The public route on the same app is untouched by the outage.
    expect((await app.inject({ method: 'GET', url: '/public', cookies: { sid: 'x' } })).statusCode).toBe(200);
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

  // A guard that refuses a request must be OBSERVED to have refused it before
  // the handler is reached. `reply.sent` only flips once the response is
  // written, so an async hook anywhere in the onSend chain delays that — and a
  // guard that merely called `reply.send()` without returning the reply let the
  // handler run on top of the refusal (a 401 came back as the handler's 400, an
  // admin-only route answered 404, a rebuild ran three times). This pins the
  // fix with the exact trigger; it fails without `return reply` in createAuthn.
  it('refuses before the handler even with an async hook in the send chain', async () => {
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const app = Fastify();
    await app.register(cookie);
    app.decorateRequest('authUser', null);
    // Stands in for any async onSend hook — compression, headers, a plugin.
    // It awaits once, which is what pushes the write past the guard's promise.
    app.addHook('onSend', async (_req, _reply, payload) => { await Promise.resolve(); return payload; });
    const { requireAuth, requireAdmin } = createAuthn(users, sessions);
    let handlerRuns = 0;
    const handler = async () => { handlerRuns += 1; return { ok: true }; };
    app.get('/auth-only', { preHandler: requireAuth }, handler);
    app.get('/admin-only', { preHandler: requireAdmin }, handler);

    const anon = await app.inject({ method: 'GET', url: '/auth-only' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: 'unauthorized' });
    const author = await users.create({ username: 'author', password: 'password123456', isAdmin: false });
    const token = await sessions.create(author.id, 60_000);
    const forbidden = await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: token } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'forbidden' });
    expect(handlerRuns).toBe(0);

    // The admit path is unaffected: the guard returns nothing and the handler runs.
    const admin = await users.create({ username: 'admin', password: 'password123456', isAdmin: true });
    const adminToken = await sessions.create(admin.id, 60_000);
    const ok = await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: adminToken } });
    expect(ok.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });
});
