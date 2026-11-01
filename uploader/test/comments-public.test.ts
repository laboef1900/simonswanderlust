import { TEST_TRUST, GATEWAY_TRUST } from './trusted-proxy-fixture.js';
import { publishTokens } from './publish-tokens.js';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore, pgPostStore, type PostPair } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import type { EncodeQueue } from '../src/encode-queue.js';
import type { DbBackup } from '../src/backup.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryCommentStore, pgCommentStore } from '../src/comments.js';
import { memoryCommentAdminStore, withPublicLocaleMetadata } from '../src/comments-admin.js';
import { commentLimiters, fixedWindowLimiter } from '../src/rate-limit.js';
import { commentAuthorityOrigin, requestOrigin } from '../src/comments-public.js';
import { createPool, ensureSchema } from '../src/db.js';
import { memoryLanguageStore } from '../src/language.js';
import pg from 'pg';
import { memorySiteIdentityStore, pgSiteIdentityStore, seedSiteIdentity } from '../src/site-identity.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cpub-')); });

const BASE = 'https://simonswanderlust.com';

function fakeSettings(): SettingsStore {
  let cur: Settings = { ...defaultSettings() };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}
const queue: EncodeQueue = {
  withAdmission: (_key, operation) => operation(),
  enqueue: () => {}, isActive: () => false, recover: async () => 0, drain: async () => {}, idle: async () => {},
  quiesce: async () => {},
  stats: () => ({ pending: 0, running: 0 }),
};
const backup: DbBackup = {
  dir: '/tmp/none', runNow: async () => ({}), running: () => false, sweepTempFiles: () => [],
  list: () => [], listImageArchives: () => [], state: () => ({}),
  listRouteArchives: () => [], quiesce: async () => {},
};

function pair(tk: string, over: Partial<PostPair['shared']> = {}): PostPair {
  const loc = (locale: 'de' | 'en') => ({
    locale, slug: `${tk}-${locale}`, title: 'T', excerpt: 'E', country: 'C',
    heroImage: { src: 'https://img.simonswanderlust.com/x', width: 1, height: 1, alt: 'a' },
    bodyMarkdown: 'body', images: {},
  });
  return {
    translationKey: tk, status: 'draft',
    shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 0, lng: 0 }, ...over },
    de: loc('de'), en: loc('en'),
  };
}

function build(extra: Partial<ServerConfig> = {}) {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const posts = memoryPostStore();
  const comments = memoryCommentStore();
  const settings = fakeSettings();
  settings.update({ commentsEnabled: true });
  const app = buildServer({
    trustProxy: TEST_TRUST,
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings, secrets: memorySecretsStore(),
    posts, pages: memoryPageStore(),
    media: memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' }), encodeQueue: queue,
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: { build: async () => ({ ok: true, release: 'r1' }), hasRelease: () => true, quiesce: async () => {} },
    backupDir: join(dir, 'backup'), dbBackup: backup, dbCheck: async () => {},
    comments,
    // Generous limiter so multi-POST tests never 429 spuriously.
    commentIpLimiter: fixedWindowLimiter({ max: 1000, windowMs: 60_000 }),
    commentGlobalLimiter: fixedWindowLimiter({ max: 1000, windowMs: 60_000 }),
    ...extra,
  });
  return { app, users, sessions, posts, comments, settings };
}
type B = ReturnType<typeof build>;

async function published(b: B, tk = 'tk-pub', over: Partial<PostPair['shared']> = {}) {
  await b.posts.upsertDraft(pair(tk, over));
  await b.posts.publish(tk, await publishTokens(b.posts, tk));
  return tk;
}
async function draft(b: B, tk = 'tk-draft') { await b.posts.upsertDraft(pair(tk)); return tk; }

const good = (tk: string, over: Record<string, unknown> = {}) =>
  ({ translationKey: tk, postedLocale: 'de', authorName: 'Reader', body: 'Nice trip!', ...over });

function post(b: B, payload: unknown, headers: Record<string, string> = { origin: BASE }, cookies?: Record<string, string>) {
  return b.app.inject({
    method: 'POST', url: '/comments', payload: payload as Record<string, unknown>,
    headers: { host: 'simonswanderlust.com', 'x-forwarded-proto': 'https', ...headers },
    ...(cookies ? { cookies } : {}),
  });
}

const PUBLIC_KEYS = ['id', 'authorName', 'body', 'createdAt', 'isAuthor', 'postedLocale'].sort();
describe('canonical comment-origin precedence (#276)', () => {
  it('uses the current cached identity, explicit override first, then restores #319 fallback when cleared', async () => {
    const identityStore = memorySiteIdentityStore({ ...neutralIdentity(), canonicalOrigin: 'https://new.example' });
    const b = build({ identityStore });
    const tk = await published(b);
    const find = vi.spyOn(b.sessions, 'find').mockRejectedValue(new Error('database unavailable'));
    const overridden = build({ identityStore, commentsOrigin: 'https://override.example', posts: b.posts, comments: b.comments });
    const invalid = build({ identityStore, commentsOrigin: 'https://user@new.example', posts: b.posts, comments: b.comments });
    try {
      expect((await post(b, good(tk), { origin: 'https://new.example' }, { sid: 'owner-cookie' })).statusCode).toBe(201);
      for (const origin of [BASE, 'https://img.simonswanderlust.com', 'https://new.example.evil.test', 'https://user@new.example']) {
        expect((await post(b, good(tk), { origin })).statusCode).toBe(403);
      }
      expect((await post(b, good(tk), { referer: 'https://new.example@evil.test/trip/' })).statusCode).toBe(403);
      expect((await post(b, good(tk), { referer: 'https://new.example/trip/' })).statusCode).toBe(201);
      expect((await post(overridden, good(tk), { origin: 'https://new.example' })).statusCode).toBe(403);
      expect((await post(overridden, good(tk), { origin: 'https://override.example' })).statusCode).toBe(201);
      expect((await post(invalid, good(tk), { origin: 'https://new.example' })).statusCode).toBe(403);
      await identityStore.update(1, { ...identityStore.get().identity, canonicalOrigin: null });
      expect((await post(b, good(tk))).statusCode).toBe(201);
      expect((await post(b, good(tk), { origin: 'https://new.example' })).statusCode).toBe(403);
      expect(find).not.toHaveBeenCalled();
    } finally { await Promise.all([b.app.close(), overridden.app.close(), invalid.app.close()]); }
  });
  it('keeps limiter then honeypot ahead of canonical origin refusal', async () => {
    const identityStore = memorySiteIdentityStore({ ...neutralIdentity(), canonicalOrigin: 'https://new.example' });
    const b = build({ identityStore, commentIpLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    try {
      expect((await post(b, good('missing', { website: 'bot' }))).statusCode).toBe(204);
      expect((await post(b, good('missing', { website: 'bot' }))).statusCode).toBe(429);
      expect(b.comments.all()).toEqual([]);
    } finally { await b.app.close(); }
  });
});

it.skipIf(!process.env.TEST_DATABASE_URL)('switches canonical comments immediately through the real identity save and Postgres stores', async () => {
  const schema = `canonical_${randomUUID().replaceAll('-', '')}`;
  const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let pool: pg.Pool | undefined;
  let app: B['app'] | undefined;
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
    await seedSiteIdentity(pool);
    const identityStore = await pgSiteIdentityStore(pool);
    const posts = pgPostStore(pool), comments = pgCommentStore(pool);
    const tk = randomUUID();
    await posts.upsertDraft(pair(tk));
    await posts.publish(tk, await publishTokens(posts, tk));
    const b = build({ identityStore, posts, comments });
    app = b.app;
    const admin = await b.users.create({ username: 'fixture-admin', password: 'fixture-password-1234', isAdmin: true });
    const cookies = { sid: await b.sessions.create(admin.id, 60_000) };
    expect((await post(b, good(tk))).statusCode).toBe(201);
    const save = await app.inject({ method: 'PUT', url: '/settings/identity', cookies,
      payload: { revision: 1, identity: { ...identityStore.get().identity, canonicalOrigin: 'https://NEW.example:443/' } } });
    expect(save.statusCode).toBe(200);
    expect((await pgSiteIdentityStore(pool)).get().identity.canonicalOrigin).toBe('https://new.example');
    for (const origin of [BASE, 'https://img.simonswanderlust.com', 'https://new.example.evil.test', 'https://new.example@evil.test']) {
      expect((await post(b, good(tk), { origin })).statusCode).toBe(403);
    }
    expect((await post(b, good(tk), { origin: 'https://new.example' })).statusCode).toBe(201);
    expect(await comments.listForAdmin({ translationKey: tk, status: 'pending' })).toHaveLength(2);
    expect(await comments.listApproved(tk)).toEqual([]);
  } finally {
    await app?.close();
    await pool?.end();
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
});

describe('committed comment locale coverage', () => {
  it.each(['de', 'en'] as const)('keeps saved secondary work private until publication with %s primary', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const posts = memoryPostStore({ language });
    const b = { ...build({ posts }), posts };
    const tk = `coverage-${primary}`;
    const initial = pair(tk);
    initial[secondary].omitted = true;
    await posts.upsertDraft(initial);
    await posts.publish(tk, await publishTokens(posts, tk));
    const legacy = await b.comments.create({ translationKey: tk, locale: secondary, name: 'Legacy', body: 'Retained translation discussion' });
    await b.comments.approve(legacy.id);
    const active = await b.comments.create({ translationKey: tk, locale: primary, name: 'Active', body: 'Primary discussion' });
    await b.comments.approve(active.id);
    const list = async () => (await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).json();
    const hidden = async () => {
      expect((await post(b, good(tk, { postedLocale: secondary }))).statusCode).toBe(400);
      expect((await list()).comments.map((row: { id: string }) => row.id)).toEqual([active.id]);
      const moderation = await withPublicLocaleMetadata([legacy, active], posts);
      expect(moderation.map((row) => [row.id, row.publicLocale])).toEqual([[legacy.id, false], [active.id, true]]);
    };
    await hidden();
    const saved = (await posts.get(tk))!;
    const incomplete = await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], omitted: false, title: '' } }, saved.updatedAt);
    await expect(posts.publish(tk, await publishTokens(posts, tk))).rejects.toThrow(/title required/);
    await hidden();
    await posts.upsertDraft({ ...incomplete, [secondary]: { ...incomplete[secondary], title: 'Translated title' } }, incomplete.updatedAt);
    await hidden();
    const staleTokens = await publishTokens(posts, tk);
    const current = (await posts.get(tk))!;
    await posts.upsertDraft({ ...current, [secondary]: { ...current[secondary], title: 'Changed after token' } }, current.updatedAt);
    await expect(posts.publish(tk, staleTokens)).rejects.toThrow();
    await hidden();
    await posts.publish(tk, await publishTokens(posts, tk));
    expect((await post(b, good(tk, { postedLocale: secondary }))).statusCode).toBe(201);
    const publishedRows = (await list()).comments;
    expect(new Set(publishedRows.map((row: { id: string }) => row.id))).toEqual(new Set([legacy.id, active.id]));
    for (const row of publishedRows) expect(Object.keys(row).sort()).toEqual(PUBLIC_KEYS);
    expect((await withPublicLocaleMetadata([legacy, active], posts)).every((row) => row.publicLocale)).toBe(true);
    await posts.unpublish(tk);
    expect((await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).statusCode).toBe(404);
    expect((await post(b, good(tk, { postedLocale: primary }))).statusCode).toBe(404);
    expect(b.comments.all().some((row) => row.id === legacy.id)).toBe(true);
    expect((await withPublicLocaleMetadata([legacy, active], posts)).every((row) => !row.publicLocale)).toBe(true);
    await b.app.close();
  });

  it('filters hidden locales before the public result cap and before the flags verdict', async () => {
    const posts = memoryPostStore();
    const b = { ...build({ posts }), posts };
    const tk = 'coverage-cap';
    const initial = pair(tk, { commentsEnabled: false });
    initial.en.omitted = true;
    await posts.upsertDraft(initial);
    await posts.publish(tk, await publishTokens(posts, tk));
    for (let i = 0; i < 501; i++) {
      const row = await b.comments.create({ translationKey: tk, locale: 'en', name: 'Legacy', body: `Hidden ${i}` });
      await b.comments.approve(row.id);
    }
    const active = await b.comments.create({ translationKey: tk, locale: 'de', name: 'Active', body: 'Still returned' });
    await b.comments.approve(active.id);
    const result = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(result.json()).toMatchObject({ enabled: false, comments: [{ id: active.id }] });
    expect(result.json().comments).toHaveLength(1);
    expect((await post(b, good(tk, { postedLocale: 'en' }))).statusCode).toBe(400);
    expect((await post(b, good(tk))).statusCode).toBe(409);
    expect(b.comments.all()).toHaveLength(502);
    await b.app.close();
  });
});

describe('GET /comments (SPEC-API-001)', () => {
  it('400 without tk, empty tk, or an over-long tk', async () => {
    const b = build();
    for (const url of ['/comments', '/comments?tk=', `/comments?tk=${'a'.repeat(129)}`]) {
      expect((await b.app.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }
  });

  it('404 for an unknown key and for a draft-only key (same response)', async () => {
    const b = build();
    const tk = await draft(b);
    const unknown = await b.app.inject({ method: 'GET', url: '/comments?tk=nope' });
    const draftRes = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(unknown.statusCode).toBe(404);
    expect(draftRes.statusCode).toBe(404);
    expect(draftRes.body).toBe(unknown.body);
  });

  it('lists approved only, both locales merged oldest first, and the key set is exactly the public shape', async () => {
    const b = build();
    const tk = await published(b);
    const a = await b.comments.create({ translationKey: tk, locale: 'de', name: 'A', body: 'first', email: 'a@example.com' });
    const p = await b.comments.create({ translationKey: tk, locale: 'de', name: 'P', body: 'pending' });
    const e = await b.comments.create({ translationKey: tk, locale: 'en', name: 'E', body: 'second' });
    await b.comments.approve(a.id);
    await b.comments.approve(e.id);
    void p;
    const res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const json = res.json();
    expect(Object.keys(json).sort()).toEqual(['comments', 'enabled']);
    expect(json.enabled).toBe(true);
    expect(json.comments.map((c: { body: string }) => c.body)).toEqual(['first', 'second']);
    expect(json.comments.map((c: { postedLocale: string }) => c.postedLocale)).toEqual(['de', 'en']);
    for (const c of json.comments) {
      expect(Object.keys(c).sort()).toEqual(PUBLIC_KEYS);
      expect(c.isAuthor).toBe(false);
    }
    expect(res.body).not.toContain('pending');
    expect(res.body).not.toContain('example.com');
  });

  it('enabled is false when the global switch is off or the per-post flag is off; approved comments still listed', async () => {
    const b = build();
    const tk = await published(b);
    const a = await b.comments.create({ translationKey: tk, locale: 'de', name: 'A', body: 'kept' });
    await b.comments.approve(a.id);
    b.settings.update({ commentsEnabled: false });
    let res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(res.json()).toMatchObject({ enabled: false });
    expect(res.json().comments).toHaveLength(1);
    b.settings.update({ commentsEnabled: true });
    const tk2 = await published(b, 'tk-off', { commentsEnabled: false });
    res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk2}` });
    expect(res.json()).toEqual({ enabled: false, comments: [] });
  });

  it('preserves an author reply beyond the site-wide moderation window', async () => {
    const admin = memoryCommentAdminStore();
    const b = build({ commentsAdmin: admin });
    const older = await published(b, 'older-thread');
    for (let i = 0; i < 500; i++) {
      admin.add({ id: randomUUID(), translationKey: older, locale: 'de', name: 'Reader',
        email: null, body: 'Older thread', status: 'approved', isAuthor: false,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    }
    const tk = await published(b);
    const reply = await b.comments.replyAsAuthor({ translationKey: tk, body: 'Thanks!', postedLocale: 'en' }, 'Simon');
    admin.add({ ...reply, status: 'approved' });
    const res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().comments).toEqual([{
      id: reply.id, authorName: reply.name, body: 'Thanks!', createdAt: reply.createdAt.toISOString(),
      isAuthor: true, postedLocale: 'en',
    }]);
    await b.comments.setStatus(reply.id, 'spam');
    expect((await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).json().comments).toEqual([]);
  });

  it.each([false, true])('serves stored author flags without a usable moderation store (%s)', async (configured) => {
    const admin = memoryCommentAdminStore();
    const b = build(configured ? { commentsAdmin: {
      ...admin, list: async () => { throw new Error('Moderation unavailable'); },
    } } : {});
    const tk = await published(b);
    const reply = await b.comments.replyAsAuthor({ translationKey: tk, body: 'Author reply' }, 'Simon');
    const reader = await b.comments.create({ translationKey: tk, locale: 'de', name: reply.name, body: 'Reader reply' });
    await b.comments.approve(reader.id);
    const res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    const flags = new Map(res.json().comments.map((c: { id: string; isAuthor: boolean }) => [c.id, c.isAuthor]));
    expect(flags.get(reply.id)).toBe(true);
    expect(flags.get(reader.id)).toBe(false);
  });

  it('a store failure is a sanitized 500 that never logs the key', async () => {
    const b = build({ comments: { ...memoryCommentStore(), listApproved: async () => { throw new Error('boom'); } } });
    const tk = await published(b, 'secret-key-xyz');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal server error' });
      const logged = spy.mock.calls.flat().map(String).join('\n');
      expect(logged).not.toContain('secret-key-xyz');
    } finally {
      spy.mockRestore();
    }
  });

  it('503 when no store is configured (after validation)', async () => {
    const b = build({ comments: undefined });
    expect((await b.app.inject({ method: 'GET', url: '/comments' })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'GET', url: '/comments?tk=x' })).statusCode).toBe(503);
  });
});

describe('POST /comments (SPEC-API-001)', () => {
  it('happy path: 201 { ok: true }, row is pending, GET still empty, no echo', async () => {
    const b = build();
    const tk = await published(b);
    const res = await post(b, good(tk));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    const rows = b.comments.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', name: 'Reader', body: 'Nice trip!', locale: 'de', email: null });
    expect(res.body).not.toContain(rows[0]!.id);
    expect((await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).json().comments).toEqual([]);
  });

  it('email is never collected even when sent', async () => {
    const b = build();
    const tk = await published(b);
    expect((await post(b, good(tk, { email: 'r@example.com' }))).statusCode).toBe(201);
    expect(b.comments.all()[0]!.email).toBeNull();
  });

  it('honeypot: 204 empty body, no row, nothing logged; whitespace-only is NOT a hit', async () => {
    const b = build();
    const tk = await published(b);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Honeypot runs BEFORE the Origin check: no headers at all still 204s.
      const res = await post(b, good(tk, { website: 'https://spam.example' }), {});
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(b.comments.all()).toHaveLength(0);
      expect(log).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally { log.mockRestore(); err.mockRestore(); }
    expect((await post(b, good(tk, { website: '   ' }))).statusCode).toBe(201);
  });

  it('403 without Origin and Referer, with a foreign Origin, with a prefix-lookalike, and with an unparsable Origin', async () => {
    const b = build();
    const tk = await published(b);
    const cases: Record<string, string>[] = [
      {},
      { origin: 'https://evil.example' },
      { origin: 'https://simonswanderlust.com.evil.example' },
      { origin: 'null' },
      { referer: 'https://evil.example/page' },
    ];
    for (const headers of cases) {
      const res = await post(b, good(tk), headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
    }
    expect(b.comments.all()).toHaveLength(0);
  });

  it('201 with a matching Origin, and with a matching Referer when Origin is absent', async () => {
    const b = build();
    const tk = await published(b);
    expect((await post(b, good(tk), { origin: BASE })).statusCode).toBe(201);
    expect((await post(b, good(tk), { referer: `${BASE}/rumaenien/?x=1` })).statusCode).toBe(201);
  });

  it('uses the explicit override before request authority, and never falls through invalid configuration', async () => {
    const b = build({ commentsOrigin: 'https://configured.example:443/' });
    const tk = await published(b);
    expect((await post(b, good(tk), { origin: 'https://configured.example' })).statusCode).toBe(201);
    expect((await post(b, good(tk))).statusCode).toBe(403);
    expect(b.comments.all()).toHaveLength(1);
    for (const commentsOrigin of ['', 'null', 'https://user@simonswanderlust.com', `${BASE}/path`, `${BASE}?q=1`, 'https:/simonswanderlust.com']) {
      const invalid = build({ commentsOrigin });
      const key = await published(invalid);
      expect((await post(invalid, good(key))).statusCode, commentsOrigin).toBe(403);
      expect(invalid.comments.all()).toHaveLength(0);
    }
  });

  it('refuses credentials and malformed Origin without rescuing them with Referer', async () => {
    const b = build();
    const tk = await published(b);
    for (const origin of [
      'null', 'https:/simonswanderlust.com', 'https://simonswanderlust.com@evil.example',
      'https://evil.example@simonswanderlust.com', 'https://@simonswanderlust.com',
      `${BASE}/path`, `${BASE}/path/..`, `${BASE}?`, `${BASE}#`, `${BASE}:`,
      'https://%73imonswanderlust.com', 'https://simonswanderlust.com\\@evil.example',
    ]) {
      expect((await post(b, good(tk), { origin, referer: `${BASE}/trip/` })).statusCode, origin).toBe(403);
    }
    for (const referer of ['https://evil.example@simonswanderlust.com/trip', 'https://@simonswanderlust.com/trip']) {
      expect((await post(b, good(tk), { referer })).statusCode).toBe(403);
    }
    expect(b.comments.all()).toHaveLength(0);
    expect((await post(b, good(tk), { origin: '', referer: `${BASE}/trip/?q=1#h` })).statusCode).toBe(201);
    expect((await post(b, good(tk), { origin: 'https://SIMONSWANDERLUST.com:443/' })).statusCode).toBe(201);
  });

  it('excludes both configured image authorities under either scheme, not just PUBLIC_BASE_URL', async () => {
    const b = build({ baseUrl: 'https://cdn.example', imgHost: 'images.example' });
    const tk = await published(b);
    for (const host of ['cdn.example', 'images.example']) {
      for (const scheme of ['http', 'https']) {
        expect((await post(b, good(tk), { host, origin: `${scheme}://${host}`, 'x-forwarded-proto': scheme })).statusCode).toBe(403);
      }
    }
    expect(b.comments.all()).toHaveLength(0);
    expect((await post(b, good(tk))).statusCode).toBe(201);
  });

  it.each([80, 443])('normalizes explicit image port %i under the request protocol without blocking unrelated ports', async (port) => {
    // Deliberately distinct: PUBLIC_BASE_URL must not hide an IMG_HOST bypass.
    const b = build({ baseUrl: 'https://cdn.example', imgHost: `images.example:${port}` });
    const tk = await published(b);
    for (const scheme of ['http', 'https']) {
      for (const host of [`images.example:${port}`, 'images.example', 'cdn.example']) {
        const res = await post(b, good(tk), {
          host, origin: new URL(`${scheme}://${host}`).origin, 'x-forwarded-proto': scheme,
        });
        expect(res.statusCode, `${scheme}://${host}`).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
        expect(b.comments.all()).toHaveLength(0);
      }
    }
    expect((await post(b, good(tk))).statusCode).toBe(201);
    for (const host of ['images.example:8443', 'cdn.example:8443']) {
      expect((await post(b, good(tk), { host, origin: `https://${host}` })).statusCode).toBe(201);
    }
    expect(b.comments.all()).toHaveLength(3);
  });

  it.each([
    { baseUrl: 'https://cdn.example:80', scheme: 'http', port: 80 },
    { baseUrl: 'http://cdn.example:443', scheme: 'https', port: 443 },
  ])('normalizes the image-base authority under $scheme too', async ({ baseUrl, scheme, port }) => {
    const b = build({ baseUrl, imgHost: 'images.example:8443' });
    const tk = await published(b);
    for (const host of ['cdn.example', `cdn.example:${port}`]) {
      expect((await post(b, good(tk), { host, origin: `${scheme}://cdn.example`, 'x-forwarded-proto': scheme })).statusCode).toBe(403);
      expect(b.comments.all()).toHaveLength(0);
    }
    expect((await post(b, good(tk))).statusCode).toBe(201);
  });

  it('keeps explicit origin precedence and fails closed on malformed image authority', async () => {
    const b = build({ baseUrl: 'https://cdn.example', imgHost: 'images.example:443', commentsOrigin: 'https://images.example' });
    const tk = await published(b);
    expect((await post(b, good(tk), { host: 'images.example:443', origin: 'https://images.example' })).statusCode).toBe(201);
    expect(b.comments.all()).toHaveLength(1);
    for (const imgHost of ['images.example:', 'user@images.example', 'images.example/path']) {
      const invalid = build({ imgHost });
      const key = await published(invalid);
      expect((await post(invalid, good(key))).statusCode).toBe(403);
      expect(invalid.comments.all()).toHaveLength(0);
    }
  });

  it('retains only the documented single-origin loopback image/blog topology', async () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
      const origin = `http://${host}`;
      const b = build({ baseUrl: origin, imgHost: host });
      const tk = await published(b);
      expect((await post(b, good(tk), { host, origin, 'x-forwarded-proto': 'http' })).statusCode).toBe(201);
    }
    for (const [scheme, port] of [['http', 80], ['https', 443]] as const) {
      const host = `localhost:${port}`;
      const b = build({ baseUrl: `${scheme}://${host}`, imgHost: host });
      const tk = await published(b);
      expect((await post(b, good(tk), { host, origin: `${scheme}://localhost`, 'x-forwarded-proto': scheme })).statusCode).toBe(201);
      expect(b.comments.all()).toHaveLength(1);
    }
    const b = build({ baseUrl: 'https://cdn.example', imgHost: 'localhost:3000' });
    const tk = await published(b);
    expect((await post(b, good(tk), { host: 'cdn.example', origin: 'https://cdn.example' })).statusCode).toBe(403);
    expect((await post(b, good(tk), { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-forwarded-proto': 'http' })).statusCode).toBe(403);
  });

  it('uses trusted immediate-peer protocol and raw Host, never forwarded Host or submitted Origin', async () => {
    const b = build({ trustProxy: GATEWAY_TRUST });
    const tk = await published(b);
    const send = (remoteAddress: string, headers: Record<string, string>) => b.app.inject({
      method: 'POST', url: '/comments', remoteAddress, payload: good(tk),
      headers: { host: 'simonswanderlust.com', 'x-forwarded-proto': 'https', ...headers },
    });
    expect((await send('172.18.0.1', { origin: BASE, 'x-forwarded-host': 'evil.example' })).statusCode).toBe(201);
    expect((await send('172.18.0.1', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })).statusCode).toBe(403);
    expect((await send('172.18.0.3', { origin: BASE })).statusCode).toBe(403);
    expect((await send('172.18.0.3', { origin: 'http://simonswanderlust.com', 'x-forwarded-host': 'evil.example' })).statusCode).toBe(201);
    expect((await send('172.18.0.1', { origin: 'http://simonswanderlust.com' })).statusCode).toBe(403);
    expect((await send('172.18.0.1', { origin: `${BASE}:444` })).statusCode).toBe(403);
    expect((await send('172.18.0.1', { origin: BASE, host: 'img.simonswanderlust.com', 'x-forwarded-host': 'simonswanderlust.com' })).statusCode).toBe(403);
    for (const host of ['', 'user@simonswanderlust.com', 'simonswanderlust.com/path', 'simonswanderlust.com:', 'simonswanderlust.com?x', 'simonswanderlust.com#x']) {
      expect((await send('172.18.0.1', { host, origin: BASE })).statusCode, host).toBe(403);
    }
    expect(b.comments.all()).toHaveLength(2);
  });

  it('400 invalid_comment for bad locale, empty name, over-long body — no store wording leaks', async () => {
    const b = build();
    const tk = await published(b);
    for (const over of [
      { postedLocale: 'fr' },
      { authorName: '   ' },
      { body: 'x'.repeat(2001) },
      { authorName: 42 },
    ]) {
      const res = await post(b, good(tk, over));
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_comment' });
    }
    expect(b.comments.all()).toHaveLength(0);
  });

  it('404 for unknown and draft-only keys', async () => {
    const b = build();
    const tk = await draft(b);
    expect((await post(b, good('nope'))).statusCode).toBe(404);
    expect((await post(b, good(tk))).statusCode).toBe(404);
    expect(b.comments.all()).toHaveLength(0);
  });

  it('409 comments_disabled with no row when the global switch is off or the per-post flag is off', async () => {
    const b = build();
    const tk = await published(b);
    b.settings.update({ commentsEnabled: false });
    let res = await post(b, good(tk));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'comments_disabled' });
    b.settings.update({ commentsEnabled: true });
    const tk2 = await published(b, 'tk-off', { commentsEnabled: false });
    res = await post(b, good(tk2));
    expect(res.statusCode).toBe(409);
    expect(b.comments.all()).toHaveLength(0);
  });

  it('429 over the per-IP budget, before any other check (no row, even for a valid post)', async () => {
    const b = build({ commentIpLimiter: fixedWindowLimiter({ max: 2, windowMs: 60_000 }) });
    const tk = await published(b);
    expect((await post(b, good(tk))).statusCode).toBe(201);
    expect((await post(b, good(tk))).statusCode).toBe(201);
    const res = await post(b, good(tk));
    expect(res.statusCode).toBe(429);
    // Honeypot and Origin are both behind the limiter.
    expect((await post(b, good(tk, { website: 'x' }), {})).statusCode).toBe(429);
    expect(b.comments.all()).toHaveLength(2);
  });

  it('uses the gateway-appended client for comment buckets and never trusts a co-tenant peer', async () => {
    const b = build({ trustProxy: GATEWAY_TRUST, commentsOrigin: BASE, commentIpLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    const tk = await published(b);
    const send = (remoteAddress: string, xff: string) => b.app.inject({
      method: 'POST', url: '/comments', remoteAddress,
      headers: { origin: BASE, 'x-forwarded-for': xff }, payload: good(tk),
    });
    expect((await send('172.18.0.1', '10.0.0.1, 198.51.100.7')).statusCode).toBe(201);
    expect((await send('172.18.0.1', '10.0.0.2, 198.51.100.7')).statusCode).toBe(429);
    expect((await send('172.18.0.1', '10.0.0.2, 203.0.113.9')).statusCode).toBe(201);
    expect((await send('172.18.0.3', '198.51.100.8')).statusCode).toBe(201);
    expect((await send('172.18.0.3', '198.51.100.9')).statusCode).toBe(429);
    expect(b.comments.all()).toHaveLength(3);
  });

  it('a request carrying a sid cookie never queries the session store (#129), on GET and POST', async () => {
    const b = build();
    const tk = await published(b);
    const find = vi.spyOn(b.sessions, 'find');
    const cookies = { sid: 'forged-token' };
    const get = await b.app.inject({ method: 'GET', url: `/comments?tk=${tk}`, cookies });
    expect(get.statusCode).toBe(200);
    expect((await post(b, good(tk), { origin: BASE }, cookies)).statusCode).toBe(201);
    expect(find).not.toHaveBeenCalled();
  });

  it('ignores unknown fields (parentId, status) and never stores them', async () => {
    const b = build();
    const tk = await published(b);
    expect((await post(b, good(tk, { parentId: randomUUID(), status: 'approved' }))).statusCode).toBe(201);
    expect(b.comments.all()[0]!.status).toBe('pending');
  });

  it('a store failure on insert is a sanitized 500 that logs no comment field', async () => {
    const b = build({ comments: { ...memoryCommentStore(), create: async () => { throw new Error('boom'); } } });
    const tk = await published(b, 'secret-key-xyz');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post(b, good(tk, { authorName: 'SecretName', body: 'SecretBody' }));
      expect(res.statusCode).toBe(500);
      const logged = spy.mock.calls.flat().map(String).join('\n');
      for (const s of ['secret-key-xyz', 'SecretName', 'SecretBody']) expect(logged).not.toContain(s);
    } finally { spy.mockRestore(); }
  });
});

it.skipIf(!process.env.TEST_DATABASE_URL)('persists only accepted explicit/fallback origins with the real Postgres stores', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const posts = pgPostStore(pool);
  const comments = pgCommentStore(pool);
  const tk = randomUUID();
  const apps: B['app'][] = [];
  try {
    await ensureSchema(pool);
    await posts.upsertDraft(pair(tk));
    await posts.publish(tk, await publishTokens(posts, tk));
    const configured = build({ posts, comments, commentsOrigin: 'https://canonical.example' });
    apps.push(configured.app);
    expect((await post(configured, good(tk))).statusCode).toBe(403);
    expect((await post(configured, good(tk), { origin: 'https://canonical.example' })).statusCode).toBe(201);

    const invalid = build({ posts, comments, commentsOrigin: 'https://user@simonswanderlust.com' });
    apps.push(invalid.app);
    expect((await post(invalid, good(tk))).statusCode).toBe(403);

    const fallback = build({ posts, comments, trustProxy: GATEWAY_TRUST });
    apps.push(fallback.app);
    for (const [remoteAddress, origin, status] of [
      ['172.18.0.1', BASE, 201],
      ['172.18.0.3', BASE, 403],
      ['172.18.0.3', 'http://simonswanderlust.com', 201],
    ] as const) {
      const response = await fallback.app.inject({
        method: 'POST', url: '/comments', remoteAddress, payload: good(tk),
        headers: { host: 'simonswanderlust.com', origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'spoof.example' },
      });
      expect(response.statusCode).toBe(status);
    }
    const pending = await comments.listForAdmin({ translationKey: tk, status: 'pending' });
    expect(pending).toHaveLength(3);
    expect(await comments.listApproved(tk)).toEqual([]);
    expect((await fallback.app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).json()).toEqual({ enabled: true, comments: [] });
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await posts.remove(tk);
    await pool.end();
  }
});

describe('requestOrigin', () => {
  it('prefers Origin, falls back to the origin of Referer, null otherwise', () => {
    expect(requestOrigin({ origin: BASE, referer: 'https://evil.example/' })).toBe(BASE);
    expect(requestOrigin({ referer: `${BASE}/en/trip/?q=1#h` })).toBe(BASE);
    expect(requestOrigin({ origin: 'not a url' })).toBeNull();
    expect(requestOrigin({})).toBeNull();
  });

  it('fails closed for absent or ambiguous request authority and unsupported protocol', () => {
    for (const host of [undefined, '', 'user@blog.example', 'blog.example/path', 'blog.example:', 'blog.example\\path', 'blog.example?x', 'blog.example#x', 'blog.example other.example', '%62log.example']) {
      expect(commentAuthorityOrigin('https', host)).toBeNull();
    }
    expect(commentAuthorityOrigin('ftp', 'blog.example')).toBeNull();
    expect(commentAuthorityOrigin('https', '[::1]:3000')).toBe('https://[::1]:3000');
    expect(requestOrigin({ origin: ['https://blog.example'], referer: 'https://blog.example/trip/' })).toBeNull();
  });
});

describe('commentLimiters', () => {
  it('builds fresh maps every call — never shared with the login limiter', () => {
    const a = commentLimiters(() => 0);
    const b = commentLimiters(() => 0);
    for (let i = 0; i < 5; i++) expect(a.ip.check('1.2.3.4')).toBe(true);
    expect(a.ip.check('1.2.3.4')).toBe(false);
    expect(b.ip.check('1.2.3.4')).toBe(true);
    const login = fixedWindowLimiter({ max: 10, windowMs: 900_000, now: () => 0 });
    expect(login.check('1.2.3.4')).toBe(true);
  });

  it('per-IP map stays bounded under many distinct addresses', () => {
    const { ip } = commentLimiters(() => 0);
    for (let i = 0; i < 20_000; i++) ip.check(`10.0.${(i >> 8) & 255}.${i & 255}-${i}`);
    // The first address has long been evicted (10 000 cap) → fresh budget.
    expect(ip.check('10.0.0.0-0')).toBe(true);
    // The newest is still tracked and still within budget.
    expect(ip.check('10.0.78.31-19999')).toBe(true);
  });
});
