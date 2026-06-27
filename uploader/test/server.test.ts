import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import type { Caption } from '../src/caption.js';
import { validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';
import { memoryUserStore, type UserStore } from '../src/users.js';
import { memorySessionStore, type SessionStore } from '../src/sessions.js';
import { memoryPostStore, type PostStore } from '../src/posts.js';
import { fixedWindowLimiter } from '../src/rate-limit.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

const SETTINGS: Settings = {
  lmBaseUrl: 'http://lm:1234/v1', lmModel: 'qwen/qwen3-vl-4b',
  captionTimeoutMs: 60000, captionMaxEdge: 768, captionPrompt: 'P',
};
function fakeStore(init: Settings = SETTINGS): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
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
    builderUrl: 'http://builder:4000', buildSecret: 'bs',
    backupDir: dir + '/backup',
    triggerImpl: extra.triggerImpl ?? (async () => ({ ok: true, release: 'r1' })),
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
    const res = await b.app.inject({ method: 'GET', url: '/' + file });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});

describe('buildServer config', () => {
  it('boots with a relative storageDir (resolves it to absolute)', async () => {
    const rel = relative(process.cwd(), dir);
    const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', users: memoryUserStore(), sessions: memorySessionStore(), settings: fakeStore(), posts: memoryPostStore(), builderUrl: 'http://builder:4000', buildSecret: 'bs', backupDir: dir + '/backup', triggerImpl: async () => ({ ok: true }) });
    await expect(srv.ready()).resolves.toBeDefined();
    await srv.close();
  });
});

describe('POST /suggest', () => {
  const okCaption = async (): Promise<Caption> => ({ altEn: 'Old town', altDe: 'Altstadt', slug: 'old-town' });

  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await build().app.inject({ method: 'POST', url: '/suggest', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('returns suggestions + dimensions', async () => {
    const b = build({ captionImpl: okCaption });
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ filename: 'a.jpg', slug: 'old-town', altEn: 'Old town', altDe: 'Altstadt', width: 1000, height: 800 });
  });

  it('degrades a row when captioning throws, keeping dimensions', async () => {
    const b = build({ captionImpl: async () => { throw new Error('down'); } });
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ captionError: true, slug: '', width: 1000, height: 800 });
  });

  it('returns one row per file part even when a file is undecodable', async () => {
    const b = build({ captionImpl: okCaption });
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'good.jpg', contentType: 'image/jpeg' });
    form.append('file', Buffer.from('not a real image'), { filename: 'bad.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    const rows = res.json().results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filename: 'good.jpg', slug: 'old-town' });
    expect(rows[1]).toMatchObject({ filename: 'bad.jpg', captionError: true, width: 0, height: 0 });
  });
});

describe('settings endpoints', () => {
  const modelsFetch = (ids: string[]) =>
    (async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as unknown as typeof fetch;

  it('GET /settings 401 without auth, returns current with auth', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lmModel: 'qwen/qwen3-vl-4b', captionMaxEdge: 768 });
  });

  it('POST /settings persists valid changes', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmModel: 'new-model', captionMaxEdge: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lmModel).toBe('new-model');
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.json().captionMaxEdge).toBe(1024);
  });

  it('POST /settings 400 on invalid', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmBaseUrl: 'ftp://nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('GET /settings/models returns ids from LM Studio', async () => {
    const b = build({ fetchImpl: modelsFetch(['a', 'b']) });
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'GET', url: '/settings/models', cookies: cookie,
    });
    expect(res.json().models).toEqual(['a', 'b']);
  });

  it('GET /settings/models degrades to empty + error on failure', async () => {
    const failing = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    const b = build({ fetchImpl: failing });
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'GET', url: '/settings/models', cookies: cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([]);
    expect(res.json().error).toBeTruthy();
  });

  it('POST /settings/test reports reachable + modelPresent', async () => {
    const b = build({ fetchImpl: modelsFetch(['qwen/qwen3-vl-4b']) });
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings/test',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { model: 'qwen/qwen3-vl-4b' },
    });
    expect(res.json()).toMatchObject({ ok: true, reachable: true, modelPresent: true });
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
