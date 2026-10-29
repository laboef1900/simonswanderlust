import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type ServerConfig } from '../src/server.js';
import { memoryJourneyStore, type JourneyDraft } from '../src/journeys.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memorySecretsStore } from '../src/secrets.js';
import { defaultSettings, validate } from '../src/settings.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';

const imageBase = 'https://images.example';
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journey-admin-'));
  const posts = memoryPostStore(); const media = memoryMediaStore({ baseUrl: imageBase });
  const journeys = memoryJourneyStore(posts, posts.language, media, imageBase);
  const users = memoryUserStore(), sessions = memorySessionStore();
  const author = await users.create({ username: 'journey-author', password: 'password123456', isAdmin: false });
  const admin = await users.create({ username: 'journey-admin', password: 'password123456', isAdmin: true });
  const cookies = { author: { sid: await sessions.create(author.id, 60_000) }, admin: { sid: await sessions.create(admin.id, 60_000) } };
  let settings = defaultSettings(), writable = true;
  const build = vi.fn(async () => ({ ok: true }));
  const config: ServerConfig = {
    trustProxy: TEST_TRUST, storageDir: root, siteDir: join(root, 'site'), backupDir: join(root, 'backup'), baseUrl: imageBase, imgHost: 'images.example',
    users, sessions, posts, pages: memoryPageStore(posts.language), media, journeys, secrets: memorySecretsStore(), isWritable: () => writable,
    settings: { get: () => settings, update: patch => { settings = validate({ ...settings, ...patch }); return settings; } },
    builder: { build, hasRelease: () => true, quiesce: async () => {} }, dbCheck: async () => {},
    dbBackup: { dir: root, runNow: async () => ({}), running: () => false, state: () => ({}), sweepTempFiles: () => [], list: () => [], listImageArchives: () => [], listRouteArchives: () => [], quiesce: async () => {} },
    encodeQueue: { enqueue() {}, isActive: () => false, recover: async () => 0, drain: async () => {}, idle: async () => {}, quiesce: async () => {}, stats: () => ({ pending: 0, running: 0 }) },
  };
  const app = buildServer(config);
  disposers.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const keys: string[] = [];
  for (let i = 0; i < 3; i++) {
    const loc = (locale: 'de' | 'en') => ({ locale, slug: locale + '-story-' + i, title: 'Story ' + i, excerpt: '', country: 'X', bodyMarkdown: '', images: {}, heroImage: { src: imageBase + '/hero', width: 640, height: 400, alt: 'Landscape' } });
    const post = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 1 } }, de: loc('de'), en: loc('en') }); keys.push(post.translationKey);
  }
  await media.upsert({ key: 'hero', width: 640, height: 400, origBytes: 1, status: 'ready',
    exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
  const locale = { title: 'Journey', slug: 'journey', intro: 'A plain intro', heroImage: { src: imageBase + '/hero', width: 640, height: 400, alt: 'Landscape', focus: { x: 20, y: 80 } }, omitted: false };
  const draft: JourneyDraft = { de: structuredClone(locale), en: structuredClone(locale), members: keys };
  return { app, journeys, posts, media, cookies, draft, build, fence() { writable = false; } };
}

describe('journey admin boundary and ownership', () => {
  it('enforces the complete role matrix before UUID validation', async () => {
    const f = await fixture();
    for (const [method, url] of [['GET', '/journey-admin'], ['GET', '/journey-admin/not-uuid'], ['POST', '/journey-admin'], ['PUT', '/journey-admin/not-uuid'], ['POST', '/journey-admin/not-uuid/publish'], ['POST', '/journey-admin/not-uuid/unpublish'], ['DELETE', '/journey-admin/not-uuid']] as const) {
      expect((await f.app.inject({ method, url })).statusCode).toBe(401);
    }
    for (const [method, url] of [['POST', '/journey-admin/not-uuid/publish'], ['POST', '/journey-admin/not-uuid/unpublish'], ['DELETE', '/journey-admin/not-uuid']] as const) {
      expect((await f.app.inject({ method, url, cookies: f.cookies.author })).statusCode).toBe(403);
      expect((await f.app.inject({ method, url, cookies: f.cookies.admin })).statusCode).toBe(404);
    }
    const created = await f.app.inject({ method: 'POST', url: '/journey-admin', cookies: f.cookies.author, payload: f.draft }); expect(created.statusCode).toBe(201);
    const row = created.json(); expect((await f.app.inject({ method: 'GET', url: '/journey-admin/' + row.id, cookies: f.cookies.author })).statusCode).toBe(200);
    const saved = await f.app.inject({ method: 'PUT', url: '/journey-admin/' + row.id, cookies: f.cookies.author, payload: { ...f.draft, members: [...f.draft.members].reverse(), baseUpdatedAt: row.updatedAt } });
    expect(saved.statusCode).toBe(200); expect(saved.json().members).toEqual([...f.draft.members].reverse()); expect(saved.json().updatedAt).not.toBe(row.updatedAt); expect(f.build).not.toHaveBeenCalled();
    expect((await f.app.inject({ method: 'PUT', url: '/journey-admin/' + row.id, cookies: f.cookies.author, payload: { ...f.draft, baseUpdatedAt: row.updatedAt } })).json().code).toBe('conflict');
    expect((await f.app.inject({ method: 'GET', url: '/journey-admin?member=' + f.draft.members[0], cookies: f.cookies.author })).json().id).toBe(row.id);
  });
  it('rejects client history, unknown fields, invalid tokens, duplicate/unknown members and bodies over 64 KiB', async () => {
    const f = await fixture();
    for (const payload of [{ ...f.draft, status: 'published' }, { ...f.draft, de: { ...f.draft.de, publishedAt: null } }, { ...f.draft, members: ['unknown'] }, { ...f.draft, members: [f.draft.members[0], f.draft.members[0]] }]) {
      expect((await f.app.inject({ method: 'POST', url: '/journey-admin', cookies: f.cookies.author, payload })).statusCode).toBe(400);
    }
    expect((await f.app.inject({ method: 'POST', url: '/journey-admin', cookies: f.cookies.author, payload: { ...f.draft, junk: 'x'.repeat(65536) } })).statusCode).toBe(413);
    const row = await f.journeys.create(f.draft);
    for (const baseUpdatedAt of [null, '', '2026-01-01', '2026-02-30T00:00:00.000Z']) expect((await f.app.inject({ method: 'POST', url: `/journey-admin/${row.id}/publish`, cookies: f.cookies.admin, payload: { baseUpdatedAt } })).statusCode).toBe(400);
    expect(f.build).not.toHaveBeenCalled();
  });
  it('commits before awaiting one builder and returns the persisted token on failed builds without raw errors', async () => {
    const f = await fixture(); const row = await f.journeys.create(f.draft);
    const barrier = Promise.withResolvers<{ ok: boolean }>();
    f.build.mockImplementation(async () => { expect((await f.journeys.get(row.id))?.status).toBe('published'); return barrier.promise; });
    const publishing = f.app.inject({ method: 'POST', url: `/journey-admin/${row.id}/publish`, cookies: f.cookies.admin, payload: { baseUpdatedAt: row.updatedAt.toISOString() } });
    await vi.waitFor(() => expect(f.build).toHaveBeenCalledOnce()); barrier.resolve({ ok: false });
    const failed = await publishing; expect(failed.statusCode).toBe(502); expect(failed.json()).toMatchObject({ persisted: true, code: 'journey_build_failed', build: { ok: false }, saved: { status: 'published' } });
    expect(failed.json().saved.updatedAt).toBe((await f.journeys.get(row.id))?.updatedAt.toISOString());
    f.build.mockRejectedValueOnce(new Error('private database hostname'));
    const unpublish = await f.app.inject({ method: 'POST', url: `/journey-admin/${row.id}/unpublish`, cookies: f.cookies.admin }); expect(unpublish.statusCode).toBe(502); expect(unpublish.body).not.toContain('private database'); expect(unpublish.json().saved.status).toBe('draft');
  });
  it('protects working and retained heroes and deletes a published journey without changing any story', async () => {
    const f = await fixture(); let row = await f.journeys.create(f.draft); row = await f.journeys.publish(row.id, row.updatedAt);
    const before = await Promise.all(f.draft.members.map(key => f.posts.get(key)));
    const copy = structuredClone(f.draft); copy.de.heroImage = copy.en.heroImage = null; row = await f.journeys.save(row.id, copy, row.updatedAt);
    const usage = await f.app.inject({ method: 'GET', url: '/media/items/hero', cookies: f.cookies.author });
    expect(usage.json().usedIn).toContainEqual({ kind: 'journey', key: row.id, title: 'Journey', published: true, working: false });
    expect((await f.app.inject({ method: 'DELETE', url: '/media/items/hero', cookies: f.cookies.admin })).statusCode).toBe(409);
    const deleted = await f.app.inject({ method: 'DELETE', url: '/journey-admin/' + row.id, cookies: f.cookies.admin }); expect(deleted.json()).toMatchObject({ deleted: true, persisted: true, build: { ok: true } }); expect(f.build).toHaveBeenCalledOnce();
    expect(await Promise.all(f.draft.members.map(key => f.posts.get(key)))).toEqual(before);
  });
  it('fences every mutating route and quiesces an admitted rebuild', async () => {
    const f = await fixture(); const row = await f.journeys.create(f.draft);
    const barrier = Promise.withResolvers<{ ok: boolean }>(); f.build.mockImplementation(() => barrier.promise);
    const publishing = f.app.inject({ method: 'POST', url: `/journey-admin/${row.id}/publish`, cookies: f.cookies.admin, payload: { baseUpdatedAt: row.updatedAt.toISOString() } });
    await vi.waitFor(() => expect(f.build).toHaveBeenCalledOnce()); let drained = false; const quiescing = f.app.quiesceMutations().then(() => { drained = true; });
    expect(drained).toBe(false); f.fence();
    for (const [method, url] of [['POST', '/journey-admin'], ['PUT', '/journey-admin/' + row.id], ['POST', `/journey-admin/${row.id}/publish`], ['POST', `/journey-admin/${row.id}/unpublish`], ['DELETE', '/journey-admin/' + row.id]] as const) expect((await f.app.inject({ method, url, cookies: f.cookies.admin })).statusCode).toBe(503);
    barrier.resolve({ ok: true }); await publishing; await quiescing; expect(drained).toBe(true);
  });
});
