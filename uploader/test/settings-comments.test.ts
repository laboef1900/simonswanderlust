import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupState, DbBackup } from '../src/backup.js';
import { buildServer, type ServerConfig } from '../src/server.js';
import { createImportRunner, memoryImportJobStore } from '../src/import-jobs.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { BacklogFullError, type EncodeQueue } from '../src/encode-queue.js';
import type { SiteBuilder } from '../src/build.js';
import { memorySecretsStore } from '../src/secrets.js';

/**
 * Issue #207 / SPEC-FLAG-002: the comments enablement flags travel through the
 * settings and posts routes as plain persisted state — no build, no work-lock.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'comments-flags-')); });

function fakeStore(init: Settings = { ...defaultSettings(), importDelayMs: 0, importRetries: 0 }): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

function stubBuilder() {
  const calls: number[] = [];
  const builder: SiteBuilder = {
    build: async () => { calls.push(1); return { ok: true, release: 'r1' }; },
    hasRelease: () => true,
  };
  return { calls, builder };
}

function stubBackup(): DbBackup {
  const state: BackupState = {};
  return {
    dir: '/tmp/none',
    runNow: async () => ({ ...state }),
    running: () => false,
    sweepTempFiles: () => [],
    list: () => [],
    listImageArchives: () => [],
    state: () => ({ ...state }),
  };
}

const queue: EncodeQueue = {
  enqueue: () => { throw new BacklogFullError(); },
  isActive: () => false,
  recover: async () => 0,
  drain: async () => {},
  idle: async () => {},
  stats: () => ({ pending: 0, running: 0 }),
};

function build(extra: Partial<ServerConfig> = {}) {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const posts = memoryPostStore();
  const settings = extra.settings ?? fakeStore();
  const b = stubBuilder();
  const app = buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings, secrets: memorySecretsStore(),
    posts, pages: memoryPageStore(),
    media: memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' }),
    encodeQueue: queue,
    importJobs: createImportRunner({ store: memoryImportJobStore(), log: () => {} }),
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: b.builder, backupDir: join(dir, 'backup'), dbBackup: stubBackup(),
    dbCheck: async () => {},
    ...extra,
  });
  const authed = async (isAdmin: boolean) => {
    const u = await users.create({ username: isAdmin ? 'admin' : 'writer', password: 'password123456', isAdmin });
    return { sid: await sessions.create(u.id, 60_000) };
  };
  return { app, posts, settings, buildCalls: b.calls, authed };
}

const json = { 'content-type': 'application/json' };

describe('global comments switch via /settings (#207)', () => {
  it('defaults off and round-trips commentsEnabled through GET/POST /settings', async () => {
    const b = build();
    const cookie = await b.authed(true);
    const before = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(before.statusCode).toBe(200);
    expect(before.json().commentsEnabled).toBe(false);

    const on = await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, headers: json, payload: { commentsEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().commentsEnabled).toBe(true);
    expect(b.settings.get().commentsEnabled).toBe(true);
    expect((await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie })).json().commentsEnabled).toBe(true);

    const off = await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, headers: json, payload: { commentsEnabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().commentsEnabled).toBe(false);
    expect(b.settings.get().commentsEnabled).toBe(false);
  });

  it('is admin-only: anonymous 401, author 403, and the flag stays off', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'POST', url: '/settings', headers: json, payload: { commentsEnabled: true } })).statusCode).toBe(401);
    const author = await b.authed(false);
    expect((await b.app.inject({ method: 'POST', url: '/settings', cookies: author, headers: json, payload: { commentsEnabled: true } })).statusCode).toBe(403);
    expect(b.settings.get().commentsEnabled).toBe(false);
  });

  it('never calls the builder when the flag is toggled', async () => {
    const b = build();
    const cookie = await b.authed(true);
    for (const commentsEnabled of [true, false, true]) {
      const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, headers: json, payload: { commentsEnabled } });
      expect(res.statusCode).toBe(200);
    }
    expect(b.buildCalls).toEqual([]);
  });

  it('a wrong type for the flag is a 400 that leaves backupSchedule alone (#112)', async () => {
    const b = build({ settings: fakeStore({ ...defaultSettings(), importDelayMs: 0, importRetries: 0, backupSchedule: 'daily' }) });
    const cookie = await b.authed(true);
    for (const bad of ['true', 1, null, 'yes']) {
      const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, headers: json, payload: { commentsEnabled: bad, backupSchedule: 'weekly' } });
      expect(res.statusCode, `value ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(b.settings.get()).toMatchObject({ backupSchedule: 'daily', commentsEnabled: false });
    expect(b.buildCalls).toEqual([]);
  });

  it('drops unknown keys from the payload instead of persisting them', async () => {
    const b = build();
    const cookie = await b.authed(true);
    const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, headers: json, payload: { commentsEnabled: true, notASetting: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('notASetting');
    expect(b.settings.get()).not.toHaveProperty('notASetting');
  });
});

describe('per-post comments flag via the editor payload (#207)', () => {
  const draft = (commentsEnabled?: boolean) => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 }, ...(commentsEnabled === undefined ? {} : { commentsEnabled }) },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('an author can save shared.commentsEnabled:false and it persists, without a build', async () => {
    const b = build();
    const cookie = await b.authed(false);
    const created = await b.app.inject({ method: 'POST', url: '/posts', cookies: cookie, headers: json, payload: draft(false) });
    expect(created.statusCode).toBe(200);
    const tk = created.json().translationKey as string;
    expect((await b.posts.get(tk))?.shared.commentsEnabled).toBe(false);
    const loaded = await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie });
    expect(loaded.json().shared.commentsEnabled).toBe(false);

    // Re-ticking it is an ordinary draft save, same as any other shared field.
    const reopened = await b.app.inject({ method: 'PUT', url: `/posts/${tk}`, cookies: cookie, headers: json, payload: { ...draft(true), translationKey: tk, updatedAt: loaded.json().updatedAt } });
    expect(reopened.statusCode).toBe(200);
    expect((await b.posts.get(tk))?.shared.commentsEnabled).toBe(true);
    expect(b.buildCalls).toEqual([]);
  });

  it('a payload without the field (old editor / old row) defaults to enabled', async () => {
    const b = build();
    const cookie = await b.authed(true);
    const created = await b.app.inject({ method: 'POST', url: '/posts', cookies: cookie, headers: json, payload: draft() });
    expect(created.statusCode).toBe(200);
    expect((await b.posts.get(created.json().translationKey))?.shared.commentsEnabled).not.toBe(false);
  });
});
