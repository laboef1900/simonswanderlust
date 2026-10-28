import { describe, expect, it, beforeEach, beforeAll, afterAll, vi } from 'vitest';
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
import { memoryCommentAdminStore, pgCommentAdminStore, type AdminComment, type CommentAdminStore } from '../src/comments-admin.js';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgCommentStore } from '../src/comments.js';
import { publishTokens } from './publish-tokens.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cadm-')); });

function fakeSettings(): SettingsStore {
  let cur: Settings = { ...defaultSettings() };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

const queue: EncodeQueue = {
  enqueue: () => {}, isActive: () => false, recover: async () => 0, drain: async () => {}, idle: async () => {},
  quiesce: async () => {},
  stats: () => ({ pending: 0, running: 0 }),
};
const backup: DbBackup = {
  dir: '/tmp/none', runNow: async () => ({}), running: () => false, sweepTempFiles: () => [],
  list: () => [], listImageArchives: () => [], state: () => ({}),
  listRouteArchives: () => [], quiesce: async () => {},
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
    builder: { build: async () => ({ ok: true, release: 'r1' }), hasRelease: () => true, quiesce: async () => {} },
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

  it('pages through tied timestamps for two independent admins without mutating rows', async () => {
    const b = build();
    const admins = [await authed(b, true), await authed(b, true, 'second-admin')];
    const rows = moderationRows(551, 'approved');
    for (const row of [...rows].reverse()) b.store.add(row);
    b.store.add(pending());
    for (const cookies of admins) {
      const ids: string[] = [];
      for (let offset = 0; offset < rows.length; offset += 50) {
        const res = await b.app.inject({ method: 'GET', url: `/moderation/comments?status=approved&offset=${offset}`, cookies });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(Object.keys(res.json()).sort()).toEqual(['comments', 'hasMore']);
        expect(res.json().comments.length).toBeLessThanOrEqual(50);
        expect(res.json().hasMore).toBe(offset + 50 < rows.length);
        ids.push(...res.json().comments.map((c: AdminComment) => c.id));
      }
      expect(ids).toEqual(rows.map((c) => c.id));
      const beyond = await b.app.inject({ method: 'GET', url: '/moderation/comments?status=approved&offset=600', cookies });
      expect(beyond.json()).toEqual({ comments: [], hasMore: false });
    }
    expect(b.store.all()).toHaveLength(552);
  });

  it('rejects invalid offsets generically before listing, but after authorization', async () => {
    const store = memoryCommentAdminStore();
    const list = vi.spyOn(store, 'list');
    const b = build({ commentsAdmin: store });
    const admin = await authed(b, true);
    const author = await authed(b, false);
    for (const query of [
      'offset=', 'offset=-1', 'offset=1.5', 'offset=1e2', 'offset=%2B50',
      'offset=%2050', 'offset=0x32', 'offset=NaN', 'offset=Infinity',
      'offset=0&offset=50', 'offset=9007199254740942', 'offset=9007199254740992',
      'status=spam&offset=-1', 'status=pending&status=approved',
    ]) {
      const url = '/moderation/comments?' + query;
      expect((await b.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await b.app.inject({ method: 'GET', url, cookies: author })).statusCode).toBe(403);
      const res = await b.app.inject({ method: 'GET', url, cookies: admin });
      expect(res.statusCode, query).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({ error: query.startsWith('status=')
        ? 'status must be pending or approved' : 'invalid pagination' });
    }
    expect(list).not.toHaveBeenCalled();
    const valid = await b.app.inject({ method: 'GET', url: '/moderation/comments?offset=9007199254740941', cookies: admin });
    expect(valid.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('pending', Number.MAX_SAFE_INTEGER - 50);
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

function moderationRows(count: number, status: 'pending' | 'approved'): AdminComment[] {
  return Array.from({ length: count }, (_, i) => pending({
    id: `abcdef00-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    // Ties span several page boundaries, with a timestamp boundary inside a page.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 123))),
    status, name: `Reader ${i}`,
  }));
}

for (const kind of ['memory', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.TEST_DATABASE_URL ? describe.skip : describe;
  suite(`moderation pagination contract (${kind})`, () => {
    let root: DbPool;
    let pool: DbPool;
    let store: CommentAdminStore;
    const schema = 'moderation_' + randomUUID().replaceAll('-', '');
    beforeAll(async () => {
      if (kind !== 'postgres') return;
      root = createPool(process.env.TEST_DATABASE_URL!);
      await root.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      pool = createPool(url.toString());
      await ensureSchema(pool);
    });
    afterAll(async () => {
      if (kind !== 'postgres') return;
      await pool?.end();
      await root?.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root?.end();
    });
    beforeEach(async () => {
      if (kind === 'postgres') await pool.query('DELETE FROM comments');
      store = kind === 'memory' ? memoryCommentAdminStore() : pgCommentAdminStore(pool);
    });
    async function seed(rows: AdminComment[]) {
      if (kind === 'memory') {
        store = memoryCommentAdminStore(rows);
        return;
      }
      await pool.query(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, is_author, created_at)
         SELECT id, "translationKey", locale, name, email, body, status, "isAuthor", "createdAt"
         FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, "translationKey" text, locale text,
           name text, email text, body text, status text, "isAuthor" boolean, "createdAt" timestamptz)`,
        [JSON.stringify(rows)],
      );
    }
    it.each(['pending', 'approved'] as const)('traverses 551 %s rows exactly once in canonical UUID/timestamp order', async (status) => {
      const rows = moderationRows(551, status);
      // Mixed-case UUID spellings must compare as UUIDs, never locale collation.
      await seed([...rows].reverse().map((c, i) => ({ ...c, id: i % 2 ? c.id.toUpperCase() : c.id })));
      const actual: string[] = [];
      for (let offset = 0; offset < 600; offset += 50) {
        const page = await store.list(status, offset);
        expect(page.comments.length).toBeLessThanOrEqual(50);
        expect(page.hasMore).toBe(offset + 50 < rows.length);
        actual.push(...page.comments.map((c) => c.id.toLowerCase()));
      }
      expect(actual).toEqual(rows.map((c) => c.id));
      expect(new Set(actual).size).toBe(551);
      expect(await store.list(status, 600)).toEqual({ comments: [], hasMore: false });
      expect(await store.list(status === 'pending' ? 'approved' : 'pending')).toEqual({ comments: [], hasMore: false });
    });
    it.each([0, 1, 50, 51, 100])('handles an empty or exact page boundary (%s rows)', async (count) => {
      await seed(moderationRows(count, 'pending'));
      const first = await store.list('pending');
      expect(first.comments).toHaveLength(Math.min(count, 50));
      expect(first.hasMore).toBe(count > 50);
      const second = await store.list('pending', 50);
      expect(second.comments).toHaveLength(Math.max(0, count - 50));
      expect(second.hasMore).toBe(false);
    });
    it('rejects unsafe, fractional and nonnumeric offsets before querying', async () => {
      const query = kind === 'postgres' ? vi.spyOn(pool, 'query') : null;
      for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER - 49, '50', null, {}]) {
        await expect(store.list('pending', offset as number)).rejects.toThrow('invalid pagination');
      }
      expect(query?.mock.calls ?? []).toHaveLength(0);
      query?.mockRestore();
    });
    it('restarting after boundary mutations reaches shifted rows and an externally emptied page can be left', async () => {
      const rows = moderationRows(101, 'pending');
      await seed(rows);
      expect((await store.list('pending', 50)).comments[0]?.id).toBe(rows[50]!.id);
      await store.remove(rows[49]!.id);
      await store.setStatus(rows[50]!.id, 'approved');
      const restarted = [...(await store.list('pending')).comments, ...(await store.list('pending', 50)).comments];
      expect(restarted.map((c) => c.id)).toEqual(rows.filter((_, i) => i !== 49 && i !== 50).map((c) => c.id));
      expect(await store.list('pending', 100)).toEqual({ comments: [], hasMore: false });
      expect((await store.list('pending', 50)).comments).toHaveLength(49);
    });

    if (kind === 'postgres') {
      it.each(['delete', 'unapprove'] as const)('reaches oldest/newest through admin GET and %s takes effect on the next public GET without a build', async (action) => {
        const rows = moderationRows(551, 'approved');
        rows[550]!.translationKey = 'tk2';
        await seed(rows);
        const posts = memoryPostStore();
        for (const tk of ['tk1', 'tk2']) {
          const locale = (locale: 'de' | 'en') => ({
            locale, slug: `${tk}-${locale}`, title: 'Trip', excerpt: 'Trip', country: 'Germany',
            heroImage: { src: 'https://img.simonswanderlust.com/x', width: 1, height: 1, alt: 'Photo' },
            bodyMarkdown: 'Story', images: {},
          });
          await posts.upsertDraft({
            translationKey: tk, status: 'draft',
            shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 0, lng: 0 } },
            de: locale('de'), en: locale('en'),
          });
          await posts.publish(tk, await publishTokens(posts, tk));
        }
        const rebuild = vi.fn(async () => ({ ok: true, release: 'unused' }));
        const settings = fakeSettings();
        settings.update({ commentsEnabled: true });
        const b = build({ posts, settings, comments: pgCommentStore(pool), commentsAdmin: store,
          builder: { build: rebuild, hasRelease: () => true, quiesce: async () => {} } });
        const admin = await authed(b, true);
        try {
          const first = (await b.app.inject({ method: 'GET', url: '/moderation/comments?status=approved', cookies: admin })).json();
          const last = (await b.app.inject({ method: 'GET', url: '/moderation/comments?status=approved&offset=550', cookies: admin })).json();
          expect(first.comments[0].id).toBe(rows[0]!.id);
          expect(last.comments[0].id).toBe(rows[550]!.id);
          expect(last.hasMore).toBe(false);
          for (const target of [rows[0]!, rows[550]!]) {
            const url = '/comments?tk=' + target.translationKey;
            const before = (await b.app.inject({ method: 'GET', url })).json();
            expect(Object.keys(before).sort()).toEqual(['comments', 'enabled']);
            expect(before.comments.length).toBeLessThanOrEqual(500);
            expect(before.comments.some((c: { id: string }) => c.id === target.id)).toBe(true);
            expect(Object.keys(before.comments[0]).sort()).toEqual(['authorName', 'body', 'createdAt', 'id', 'isAuthor', 'postedLocale']);
            const result = await b.app.inject(action === 'delete'
              ? { method: 'DELETE', url: `/moderation/comments/${target.id}`, cookies: admin }
              : { method: 'POST', url: `/moderation/comments/${target.id}/status`, cookies: admin, payload: { status: 'pending' } });
            expect(result.statusCode).toBe(200);
            const after = (await b.app.inject({ method: 'GET', url })).json();
            expect(after.comments.some((c: { id: string }) => c.id === target.id)).toBe(false);
          }
          expect(rebuild).not.toHaveBeenCalled();
        } finally { await b.app.close(); }
      });
    }
  });
}
