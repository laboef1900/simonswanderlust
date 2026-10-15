import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import type { EncodeQueue } from '../src/encode-queue.js';
import type { DbBackup } from '../src/backup.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryCommentAdminStore, type AdminComment } from '../src/comments-admin.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cadm-')); });

function fakeSettings(): SettingsStore {
  let cur: Settings = { ...defaultSettings() };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

const queue: EncodeQueue = {
  enqueue: () => {}, isActive: () => false, recover: async () => 0, drain: async () => {}, idle: async () => {},
  stats: () => ({ pending: 0, running: 0 }),
};
const backup: DbBackup = {
  dir: '/tmp/none', runNow: async () => ({}), running: () => false, sweepTempFiles: () => [],
  list: () => [], listImageArchives: () => [], state: () => ({}),
};

function pending(over: Partial<AdminComment> = {}): AdminComment {
  return {
    id: randomUUID(), translationKey: 'tk1', locale: 'de', name: 'Reader', email: null,
    body: 'Hello there', status: 'pending', isAuthor: false, createdAt: new Date('2026-09-01T00:00:00Z'), ...over,
  };
}

function build(extra: Partial<ServerConfig> = {}) {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const store = memoryCommentAdminStore();
  const app = buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings: fakeSettings(), secrets: memorySecretsStore(),
    posts: memoryPostStore(), pages: memoryPageStore(),
    media: memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' }), encodeQueue: queue,
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: { build: async () => ({ ok: true, release: 'r1' }), hasRelease: () => true },
    backupDir: join(dir, 'backup'), dbBackup: backup, dbCheck: async () => {},
    commentsAdmin: store,
    ...extra,
  });
  return { app, users, sessions, store };
}

type B = ReturnType<typeof build>;
async function authed(b: B, isAdmin: boolean, username = isAdmin ? 'admin' : 'author') {
  const u = await b.users.create({ username, password: 'password123456', isAdmin });
  return { sid: await b.sessions.create(u.id, 60_000) };
}

const ID = '11111111-2222-4333-8444-555555555555';
const ROUTES = [
  ['GET', '/moderation/comments'],
  ['POST', `/moderation/comments/${ID}/status`],
  ['DELETE', `/moderation/comments/${ID}`],
  ['POST', `/moderation/comments/${ID}/reply`],
] as const;

describe('admin comment moderation routes (SPEC-ADM-001)', () => {
  it('401 unauthenticated and 403 for a non-admin author on EVERY route, including GET', async () => {
    const b = build();
    const author = await authed(b, false);
    for (const [method, url] of ROUTES) {
      const anon = await b.app.inject({ method, url, payload: { status: 'approved', body: 'x' } });
      expect(anon.statusCode, `${method} ${url} anon`).toBe(401);
      const res = await b.app.inject({ method, url, cookies: author, payload: { status: 'approved', body: 'x' } });
      expect(res.statusCode, `${method} ${url} author`).toBe(403);
    }
  });

  it('authz runs BEFORE id validation: a malformed id is still 401/403, not 400', async () => {
    const b = build();
    const author = await authed(b, false);
    expect((await b.app.inject({ method: 'DELETE', url: '/moderation/comments/not-a-uuid' })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'DELETE', url: '/moderation/comments/not-a-uuid', cookies: author })).statusCode).toBe(403);
  });

  it('a non-UUID id is a 400 for an admin, never a pg error', async () => {
    const b = build();
    const admin = await authed(b, true);
    for (const [method, url] of [
      ['POST', '/moderation/comments/not-a-uuid/status'],
      ['DELETE', '/moderation/comments/not-a-uuid'],
      ['POST', '/moderation/comments/not-a-uuid/reply'],
    ] as const) {
      const res = await b.app.inject({ method, url, cookies: admin, payload: { status: 'approved', body: 'x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().error).toMatch(/invalid comment id/);
    }
  });

  it('lists the pending queue by default with the admin shape, no-store', async () => {
    const b = build();
    const admin = await authed(b, true);
    b.store.add(pending({ email: 'r@example.com' }));
    b.store.add(pending({ status: 'approved', name: 'Approved one' }));
    const res = await b.app.inject({ method: 'GET', url: '/moderation/comments', cookies: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.json().comments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Reader', status: 'pending', isAuthor: false, translationKey: 'tk1', locale: 'de', email: 'r@example.com' });
    const approved = await b.app.inject({ method: 'GET', url: '/moderation/comments?status=approved', cookies: admin });
    expect(approved.json().comments.map((c: { name: string }) => c.name)).toEqual(['Approved one']);
    expect((await b.app.inject({ method: 'GET', url: '/moderation/comments?status=spam', cookies: admin })).statusCode).toBe(400);
  });

  it('approve flips a pending row to approved in the store; unknown id 404s', async () => {
    const b = build();
    const admin = await authed(b, true);
    const c = pending();
    b.store.add(c);
    const res = await b.app.inject({ method: 'POST', url: `/moderation/comments/${c.id}/status`, cookies: admin, payload: { status: 'approved' } });
    expect(res.statusCode).toBe(200);
    expect(b.store.all().find((x) => x.id === c.id)?.status).toBe('approved');
    expect((await b.app.inject({ method: 'POST', url: `/moderation/comments/${c.id}/status`, cookies: admin, payload: { status: 'spam' } })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'POST', url: `/moderation/comments/${ID}/status`, cookies: admin, payload: { status: 'approved' } })).statusCode).toBe(404);
  });

  it('delete removes the row; a second delete 404s and the queue no longer lists it', async () => {
    const b = build();
    const admin = await authed(b, true);
    const c = pending();
    b.store.add(c);
    expect((await b.app.inject({ method: 'DELETE', url: `/moderation/comments/${c.id}`, cookies: admin })).statusCode).toBe(200);
    expect(b.store.all()).toEqual([]);
    expect((await b.app.inject({ method: 'DELETE', url: `/moderation/comments/${c.id}`, cookies: admin })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'GET', url: '/moderation/comments', cookies: admin })).json().comments).toEqual([]);
  });

  it('reply is inserted approved + isAuthor as a flat sibling, never pending', async () => {
    const b = build();
    const admin = await authed(b, true, 'simon');
    const c = pending({ translationKey: 'trip-x', locale: 'en' });
    b.store.add(c);
    const res = await b.app.inject({ method: 'POST', url: `/moderation/comments/${c.id}/reply`, cookies: admin, payload: { body: 'Thanks for reading!' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'approved', isAuthor: true, translationKey: 'trip-x', locale: 'en', name: 'simon', body: 'Thanks for reading!' });
    expect(res.json()).not.toHaveProperty('parentId');
    const rows = b.store.all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1); // only the reader's row
    expect(rows.find((r) => r.isAuthor)?.status).toBe('approved');
    // Parent gone → 404; empty body → 400.
    expect((await b.app.inject({ method: 'POST', url: `/moderation/comments/${ID}/reply`, cookies: admin, payload: { body: 'x' } })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'POST', url: `/moderation/comments/${c.id}/reply`, cookies: admin, payload: { body: '   ' } })).statusCode).toBe(400);
  });

  it('answers 503 without a store, but only AFTER authz', async () => {
    const b = build({ commentsAdmin: undefined });
    expect((await b.app.inject({ method: 'GET', url: '/moderation/comments' })).statusCode).toBe(401);
    const admin = await authed(b, true);
    expect((await b.app.inject({ method: 'GET', url: '/moderation/comments', cookies: admin })).statusCode).toBe(503);
  });
});
