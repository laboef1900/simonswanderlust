import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BackupState, DbBackup } from '../src/backup.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';
import { memoryUserStore, type UserStore } from '../src/users.js';
import { memorySessionStore, type SessionStore } from '../src/sessions.js';
import { memoryPostStore, type PostStore } from '../src/posts.js';
import { memoryPageStore, type PageStore } from '../src/pages.js';
import { fixedWindowLimiter } from '../src/rate-limit.js';
import type { SiteBuilder, BuildOutcome } from '../src/build.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

const SETTINGS: Settings = defaultSettings();
function fakeStore(init: Settings = SETTINGS): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

function stubBuilder(outcome: BuildOutcome = { ok: true, release: 'r1' }) {
  const calls: number[] = [];
  return {
    calls,
    builder: {
      build: async () => { calls.push(1); return outcome; },
      hasRelease: () => true,
    } satisfies SiteBuilder,
  };
}

function stubBackup(dir = '/tmp/none') {
  let state: BackupState = {};
  const backup: DbBackup = {
    dir,
    runNow: async () => { state = { lastAttemptAt: 'a', lastSuccessAt: 's' }; return { ...state }; },
    list: () => [{ name: 'db-20260703-120000.json.gz', size: 3 }],
    state: () => ({ ...state }),
  };
  return { backup };
}

interface Built { app: ReturnType<typeof buildServer>; users: UserStore; sessions: SessionStore; posts: PostStore; }
function build(extra: Partial<ServerConfig> = {}): Built {
  const users = (extra.users as UserStore) ?? memoryUserStore();
  const sessions = (extra.sessions as SessionStore) ?? memorySessionStore();
  const posts = (extra.posts as PostStore) ?? memoryPostStore();
  const built = buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings: fakeStore(),
    posts,
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: (extra.builder as SiteBuilder) ?? stubBuilder().builder,
    backupDir: dir + '/backup',
    dbBackup: (extra.dbBackup as DbBackup) ?? stubBackup().backup,
    pages: (extra.pages as PageStore) ?? memoryPageStore(),
    ...extra,
  });
  return { app: built, users, sessions, posts };
}

// Seed a user and return a Cookie header value for an authenticated session.
async function authed(b: Built, opts: { isAdmin?: boolean; username?: string } = {}) {
  const u = await b.users.create({ username: opts.username ?? 'simon', password: 'pw', isAdmin: opts.isAdmin ?? true });
  const token = await b.sessions.create(u.id, 60_000);
  return { user: u, cookie: { sid: token } };
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1000, height: 800, channels: 3, background: '#444' } }).jpeg().toBuffer();
}

describe('POST /upload', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await build().app.inject({ method: 'POST', url: '/upload', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('400 for a non-image', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', Buffer.from('not an image'), { filename: 't.txt', contentType: 'text/plain' });
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 + snippet for a valid upload', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/bucharest-2024/hero');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.src).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero');
    expect(body.snippet).toContain("alt: 'Old town'");
  });

  it('serves stored variants with a long immutable cache header', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/cache/hero');
    form.append('alt', 'c');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const up = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(up.statusCode).toBe(200);
    const file = (up.json().files as string[]).find((f) => f.endsWith('.webp'))!;
    const res = await b.app.inject({ method: 'GET', url: '/' + file, headers: { host: 'img.simonswanderlust.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});

describe('buildServer config', () => {
  it('boots with a relative storageDir (resolves it to absolute)', async () => {
    const rel = relative(process.cwd(), dir);
    const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', users: memoryUserStore(), sessions: memorySessionStore(), settings: fakeStore(), posts: memoryPostStore(), pages: memoryPageStore(), imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'), builder: stubBuilder().builder, backupDir: dir + '/backup', dbBackup: stubBackup().backup });
    await expect(srv.ready()).resolves.toBeDefined();
    await srv.close();
  });
});

describe('settings endpoints', () => {
  it('GET /settings is admin-only: 401 unauthenticated, 403 for authors', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'GET', url: '/settings', cookies: author.cookie })).statusCode).toBe(403);
    const admin = await authed(b, { username: 'admin' });
    const res = await b.app.inject({ method: 'GET', url: '/settings', cookies: admin.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ backupSchedule: 'off', backupRetention: 14 });
  });

  it('POST /settings is admin-only: 403 for authors', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { backupSchedule: 'daily' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /settings persists backup schedule + retention', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { backupSchedule: 'daily', backupRetention: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ backupSchedule: 'daily', backupRetention: 5 });
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.json()).toMatchObject({ backupSchedule: 'daily', backupRetention: 5 });
  });

  it('POST /settings 400 on invalid backup retention', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { backupRetention: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});

describe('error handler', () => {
  it('sanitizes unexpected errors to a generic 500 and logs them server-side', async () => {
    const boom = memoryPostStore();
    boom.list = async () => { throw new Error('pg: connection to db:5432 refused (secret detail)'); };
    const b = build({ posts: boom });
    const { cookie } = await authed(b);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal server error' });
      expect(res.body).not.toContain('secret detail');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps intentional 4xx framework errors (malformed JSON stays a 400)', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('auth endpoints', () => {
  it('GET /auth/status reports needsSetup on an empty store', async () => {
    const b = build();
    const res = await b.app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.json()).toMatchObject({ authenticated: false, needsSetup: true });
  });

  it('POST /setup creates the first admin and sets a cookie; second call 409s', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'simon', password: 'pw' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'simon', isAdmin: true });
    expect(res.headers['set-cookie']).toMatch(/sid=/);
    const again = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'x', password: 'y' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('POST /login succeeds with correct creds, generic 401 otherwise', async () => {
    const b = build();
    await b.users.create({ username: 'simon', password: 'pw', isAdmin: false });
    const ok = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'Simon', password: 'pw' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/sid=/);
    const wrong = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'ghost', password: 'pw' } });
    expect(unknown.statusCode).toBe(401);
  });

  it('GET /auth/status returns the logged-in user', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'simon' });
    const res = await b.app.inject({ method: 'GET', url: '/auth/status', cookies: cookie });
    expect(res.json()).toMatchObject({ authenticated: true, username: 'simon', isAdmin: true });
  });

  it('POST /logout clears the session', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const out = await b.app.inject({ method: 'POST', url: '/logout', cookies: cookie });
    expect(out.statusCode).toBe(200);
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.statusCode).toBe(401);
  });

  it('rate-limits repeated login attempts from the same client (429)', async () => {
    const b = build({ loginLimiter: fixedWindowLimiter({ max: 2, windowMs: 60_000 }) });
    await b.users.create({ username: 'simon', password: 'pw', isAdmin: false });
    const login = () => b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(429); // 3rd attempt blocked
  });

  it('serializes concurrent /setup so only one admin is created (no TOCTOU)', async () => {
    const b = build();
    const [a, c] = await Promise.all([
      b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: 'first', password: 'pw' } }),
      b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: 'second', password: 'pw' } }),
    ]);
    const codes = [a.statusCode, c.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(await b.users.count()).toBe(1);
  });
});

describe('security headers', () => {
  it('sets nosniff + frame protection on responses', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('user management', () => {
  it('GET /users requires admin (403 for author)', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'GET', url: '/users', cookies: cookie })).statusCode).toBe(403);
  });

  it('admin can list, add and remove users', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    const add = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'pw', isAdmin: false } });
    expect(add.statusCode).toBe(200);
    const list = await b.app.inject({ method: 'GET', url: '/users', cookies: cookie });
    expect(list.json().map((u: { username: string }) => u.username)).toContain('bob');
    const bobId = list.json().find((u: { username: string; id: string }) => u.username === 'bob').id;
    expect((await b.app.inject({ method: 'DELETE', url: `/users/${bobId}`, cookies: cookie })).statusCode).toBe(200);
  });

  it('rejects deleting yourself and the last admin', async () => {
    const b = build();
    const me = await b.users.create({ username: 'admin', password: 'pw', isAdmin: true });
    const token = await b.sessions.create(me.id, 60_000);
    const res = await b.app.inject({ method: 'DELETE', url: `/users/${me.id}`, cookies: { sid: token } });
    expect(res.statusCode).toBe(409);
  });

  it('POST /users 409 on duplicate username', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'pw', isAdmin: false } });
    const dup = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'BOB', password: 'pw', isAdmin: false } });
    expect(dup.statusCode).toBe(409);
  });
});

describe('POST /users/me/password (change password)', () => {
  const change = (b: Built, cookie: Record<string, string> | undefined, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/users/me/password', headers: { 'content-type': 'application/json' }, ...(cookie ? { cookies: cookie } : {}), payload });

  it('401 unauthenticated', async () => {
    const res = await change(build(), undefined, { currentPassword: 'pw', newPassword: 'new-pw' });
    expect(res.statusCode).toBe(401);
  });

  it('400 when a field is missing or empty', async () => {
    const b = build();
    const { cookie } = await authed(b);
    expect((await change(b, cookie, { newPassword: 'new-pw' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'pw', newPassword: '' })).statusCode).toBe(400);
  });

  it('400 (not 401 — admin JS redirects on 401) on a wrong current password', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-pw' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('current password is incorrect');
  });

  it('changes the password, invalidates other sessions, keeps the caller logged in', async () => {
    const b = build();
    const { user, cookie } = await authed(b); // password 'pw'
    const otherToken = await b.sessions.create(user.id, 60_000);
    const res = await change(b, cookie, { currentPassword: 'pw', newPassword: 'brand-new' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Old password no longer logs in; the new one does.
    const login = (password: string) =>
      b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: user.username, password } });
    expect((await login('pw')).statusCode).toBe(401);
    expect((await login('brand-new')).statusCode).toBe(200);
    // The pre-existing other session and the caller's old session are dead…
    expect((await b.app.inject({ method: 'GET', url: '/settings', cookies: { sid: otherToken } })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie })).statusCode).toBe(401);
    // …but the fresh sid cookie set by the response still authenticates.
    const fresh = res.cookies.find((c) => c.name === 'sid');
    expect(fresh).toBeDefined();
    expect((await b.app.inject({ method: 'GET', url: '/settings', cookies: { sid: fresh!.value } })).statusCode).toBe(200);
  });

  it('is rate-limited like the other password-verifying endpoints (429)', async () => {
    const b = build({ loginLimiter: fixedWindowLimiter({ max: 2, windowMs: 60_000 }) });
    const { cookie } = await authed(b);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(429);
  });
});

describe('posts editor', () => {
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('GET /posts 401 without auth', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/posts' })).statusCode).toBe(401);
  });

  it('create → list → publish (triggers the builder)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.statusCode).toBe(200);
    const tk = created.json().translationKey;
    const list = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
    expect(list.json()).toHaveLength(1);
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ published: true, build: { ok: true, release: 'r1' } });
  });

  it('publish is admin-only: a non-admin author gets 403', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.statusCode).toBe(200); // authors may still create/edit drafts
    const tk = created.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(403);
  });

  it('publish rejects an incomplete post (400)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const bad = sample(); bad.de.excerpt = '';
    const c = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: bad });
    const tk = c.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(400);
  });
});

describe('WordPress import', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', '<rss></rss>', { filename: 'x.xml', contentType: 'text/xml' });
    const res = await build().app.inject({ method: 'POST', url: '/import', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('imports the fixture export as drafts', async () => {
    const b = build(); const { cookie } = await authed(b);
    const xml = readFileSync('test/fixtures/wxr-sample.xml', 'utf8');
    const form = new FormData();
    form.append('file', xml, { filename: 'export.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imported: 1, skipped: 0 });
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(1);
  });

  it('400 on a non-WXR upload', async () => {
    const b = build(); const { cookie } = await authed(b);
    const form = new FormData();
    form.append('file', 'just text', { filename: 'x.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(400);
  });

  it('400 when WXR-looking file has no importable post items', async () => {
    const b = build(); const { cookie } = await authed(b);
    const emptyWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Test</title>
  </channel>
</rss>`;
    const form = new FormData();
    form.append('file', emptyWxr, { filename: 'empty.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no importable posts found in export');
  });
});

describe('POST /rebuild and GET /health', () => {
  // Copied from the `posts editor` describe block's post-pair fixture, used
  // by the existing publish tests.
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('health is public', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rebuild is admin-only', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'POST', url: '/rebuild' })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false });
    expect((await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie })).statusCode).toBe(403);
  });

  it('rebuild triggers the builder and returns its outcome', async () => {
    const s = stubBuilder({ ok: true, release: 'r9' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, release: 'r9' });
    expect(s.calls.length).toBe(1);
  });

  it('publish reports a failed build without unpublishing', async () => {
    const s = stubBuilder({ ok: false, error: 'a build is already running' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toEqual({ ok: false, error: 'a build is already running' });
  });
});

describe('backup routes', () => {
  it('are admin-only', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    for (const [method, url] of [['GET', '/backups'], ['POST', '/backups'], ['GET', '/backups/db-20260703-120000.json.gz']] as const) {
      expect((await b.app.inject({ method, url })).statusCode).toBe(401);
      expect((await b.app.inject({ method, url, cookies: cookie })).statusCode).toBe(403);
    }
  });

  it('lists state + files and runs a backup on demand', async () => {
    const b = build({ dbBackup: stubBackup().backup });
    const { cookie } = await authed(b);
    const run = await b.app.inject({ method: 'POST', url: '/backups', cookies: cookie });
    expect(run.statusCode).toBe(200);
    expect(run.json().lastSuccessAt).toBe('s');
    const list = await b.app.inject({ method: 'GET', url: '/backups', cookies: cookie });
    expect(list.json().files[0].name).toBe('db-20260703-120000.json.gz');
  });

  it('downloads only well-formed backup filenames from the backup dir', async () => {
    const backupDir = join(dir, 'dbbackups');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'db-20260703-120000.json.gz'), 'gzbytes');
    const b = build({ dbBackup: { ...stubBackup(backupDir).backup, dir: backupDir } });
    const { cookie } = await authed(b);
    const ok = await b.app.inject({ method: 'GET', url: '/backups/db-20260703-120000.json.gz', cookies: cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/gzip');
    expect(ok.headers['content-disposition']).toContain('attachment');
    for (const evil of ['..%2Fsettings.json', 'state.json', 'db-1.json.gz']) {
      const res = await b.app.inject({ method: 'GET', url: `/backups/${evil}`, cookies: cookie });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    }
    const missing = await b.app.inject({ method: 'GET', url: '/backups/db-20990101-000000.json.gz', cookies: cookie });
    expect(missing.statusCode).toBe(404);
  });
});

describe('pages routes', () => {
  it('GET /pages/:key requires auth and returns the pair', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/pages/about' })).statusCode).toBe(401);
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url: '/pages/about', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe('about');
    expect(res.json().de.locale).toBe('de');
  });

  it('PUT /pages/:key is admin-only and saves + rebuilds', async () => {
    const s = stubBuilder({ ok: true, release: 'r7' });
    const b = build({ builder: s.builder });
    const body = {
      de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    };
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', payload: body })).statusCode).toBe(401);
    const nonAdmin = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: nonAdmin.cookie, payload: body })).statusCode).toBe(403);
    const admin = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved.de.title).toBe('Über mich');
    expect(res.json().build).toEqual({ ok: true, release: 'r7' });
    expect(s.calls.length).toBe(1);
  });

  it('PUT /pages/:key rejects an unsafe key with 400', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/Bad_Key', cookies: cookie, payload: { de: { locale: 'de', title: '', bodyMarkdown: '', images: {} }, en: { locale: 'en', title: '', bodyMarkdown: '', images: {} } } });
    expect(res.statusCode).toBe(400);
  });
});
