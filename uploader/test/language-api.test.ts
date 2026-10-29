import { idleBuildState } from './build-fixture.js';
import { buildFailureMessage } from '../src/build-state.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { memoryLanguageStore, type LanguageConfig } from '../src/language.js';
import { memoryPostStore, type PostLocale } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memorySecretsStore } from '../src/secrets.js';
import { defaultSettings, validate } from '../src/settings.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import type { BuildOutcome } from '../src/build.js';
import { publishBody } from './publish-tokens.js';

const modes: [LanguageConfig, LanguageConfig, LanguageConfig, LanguageConfig] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(initial: LanguageConfig = modes[0]!) {
  const dir = await mkdtemp(join(tmpdir(), 'language-api-'));
  const language = memoryLanguageStore(initial);
  const posts = memoryPostStore({ language });
  const pages = memoryPageStore(language);
  const media = memoryMediaStore({ baseUrl: 'https://images.test' });
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const lock = createWorkLock();
  const queue = createEncodeQueue({ store: media, storageDir: dir, lock });
  let settings = defaultSettings();
  let outcome: BuildOutcome = { ok: true, attemptId: 'language-release', release: 'language-release' };
  // Acquiring the real non-reentrant work lock here also catches a route that
  // incorrectly wraps an ordinary builder invocation in that same lock.
  const build = vi.fn(async () => lock.runExclusive(async () => ({ ...outcome })));
  const unavailable = async (): Promise<never> => { throw new Error('Not part of this fixture'); };
  const app = buildServer({
    storageDir: dir, baseUrl: 'https://images.test', imgHost: 'images.test', siteDir: join(dir, 'site'),
    posts, pages, media, users, sessions, secrets: memorySecretsStore(),
    // Deliberately omit cfg.language: the server must use posts.language.
    settings: { get: () => ({ ...settings }), update: (patch) => (settings = validate({ ...settings, ...patch })) },
    builder: { ...idleBuildState, build, hasRelease: () => true, quiesce: async () => {} },
    workLock: lock, encodeQueue: queue, backupDir: join(dir, 'backup'), dbCheck: unavailable,
    dbBackup: { dir, runNow: unavailable, running: () => false, sweepTempFiles: () => [], list: () => [],
      listImageArchives: () => [], listRouteArchives: () => [], state: () => ({}), quiesce: async () => {} },
  });
  cleanups.push(async () => { await app.close(); await queue.quiesce(); await rm(dir, { recursive: true, force: true }); });
  async function login(isAdmin: boolean) {
    const user = await users.create({ username: isAdmin ? 'admin' : 'author', password: 'password123456', isAdmin });
    return { sid: await sessions.create(user.id, 60_000) };
  }
  const cookies = await login(true);
  const put = (payload: object) => app.inject({ method: 'PUT', url: '/language', cookies, payload });
  async function story(suffix = 'one') {
    await media.upsert({ key: 'hero', width: 100, height: 100, origBytes: 100, status: 'ready',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${suffix}`, title: `${locale} story`,
      country: 'Test', excerpt: 'An excerpt', bodyMarkdown: 'A complete story.', images: {},
      heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Landscape' } });
    return posts.upsertDraft({ translationKey: '', status: 'draft',
      shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: locale('de'), en: locale('en') });
  }
  return { app, language, posts, pages, media, cookies, login, put, story, build,
    failBuild: () => { outcome = { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') }; },
    recoverBuild: () => { outcome = { ok: true, attemptId: 'recovered-release', release: 'recovered-release' }; } };
}

describe('language API', () => {
  it('requires a session to read, admin to write, and never caches either success or refusal', async () => {
    const f = await fixture();
    const author = await f.login(false);
    for (const method of ['GET', 'PUT'] as const) {
      const response = await f.app.inject({ method, url: '/language', ...(method === 'PUT' ? { payload: modes[2] } : {}) });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const read = await f.app.inject({ method: 'GET', url: '/language', cookies: author });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json()).toMatchObject({ ...modes[0], lockedAt: null });
    const denied = await f.app.inject({ method: 'PUT', url: '/language', cookies: author, payload: modes[2] });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(await f.language.get()).toMatchObject(modes[0]!);
    expect(f.build).not.toHaveBeenCalled();
  });

  it.each(modes)('persists and immediately rebuilds mode %j before launch', async (mode) => {
    const f = await fixture(mode.primary === 'de' ? modes[3] : modes[2]);
    const response = await f.put(mode);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ ...mode, lockedAt: null });
    expect(await f.language.get()).toMatchObject(mode);
    const { build, ...storedLanguage } = response.json();
    expect(build).toMatchObject({ ok: true, attemptId: 'language-release', release: 'language-release' });
    expect((await f.app.inject({ method: 'GET', url: '/language', cookies: f.cookies })).json()).toEqual(storedLanguage);
    expect(f.build).toHaveBeenCalledTimes(1);
    const saved = await f.language.get();
    expect((await f.put(mode)).statusCode).toBe(200);
    expect(await f.language.get()).toEqual(saved);
  });

  it('keeps an unchanged mode and its token without rebuilding', async () => {
    const f = await fixture();
    const before = await f.language.get();
    expect((await f.put(modes[0])).statusCode).toBe(200);
    expect(await f.language.get()).toEqual(before);
    expect(f.build).not.toHaveBeenCalled();
  });

  it.each([
    {}, { primary: 'fr', locales: ['fr'] }, { primary: 'de', locales: ['en'] },
    { primary: 'de', locales: ['de', 'de'] }, { primary: 'de', locales: [] },
    { primary: 'de', locales: ['de'], lockedAt: null },
  ])('rejects invalid mode %j without rebuilding or mutating', async (input) => {
    const f = await fixture();
    const before = await f.language.get();
    const response = await f.put(input);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_language');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await f.language.get()).toEqual(before);
    expect(f.build).not.toHaveBeenCalled();
  });

  it.each(['de', 'en'] as const)('locks %s publication even after deleting every story', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary, secondary] });
    const pair = await f.story();
    const published = await f.app.inject({ method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies,
      payload: await publishBody(f.posts, pair.translationKey) });
    expect(published.statusCode).toBe(200);
    const locked = await f.language.get();
    expect(locked.lockedAt).toBeInstanceOf(Date);
    await f.posts.remove(pair.translationKey);
    f.build.mockClear();
    for (const [mode, code] of [
      [{ primary: secondary, locales: [secondary, primary] }, 'language_primary_locked'],
      [{ primary, locales: [primary] }, 'language_locale_published'],
    ] as const) {
      const response = await f.put(mode);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe(code);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await f.language.get()).toEqual(locked);
    }
    expect(f.build).not.toHaveBeenCalled();
  });

  it.each(['de', 'en'] as const)('enables the secondary after %s publication without publishing an omitted story translation', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary] });
    const pair = await f.story();
    const response = await f.app.inject({ method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies,
      payload: await publishBody(f.posts, pair.translationKey) });
    expect(response.statusCode).toBe(200);
    const before = await f.posts.get(pair.translationKey);
    expect((await f.put({ primary, locales: [primary, secondary] })).statusCode).toBe(200);
    expect(await f.posts.getPublishedLocales(pair.translationKey)).toEqual([primary]);
    expect((await f.posts.get(pair.translationKey))?.[secondary]).toEqual(before?.[secondary]);
    expect((await f.language.get()).lockedAt).not.toBeNull();
  });

  it('reports a committed mode separately from build failure and rebuilds using that persisted mode', async () => {
    const f = await fixture();
    f.failBuild();
    const response = await f.put(modes[3]);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ ...modes[3], build: { ok: false, code: 'internal' } });
    expect(f.build).toHaveBeenCalledWith('rebuild');
    expect(await f.language.get()).toMatchObject(modes[3]!);
    f.recoverBuild();
    const retried = await f.app.inject({ method: 'POST', url: '/rebuild', cookies: f.cookies });
    expect(retried.statusCode).toBe(200);
    expect(await f.language.get()).toMatchObject(modes[3]!);
    expect(f.build).toHaveBeenCalledTimes(2);
  });
});

describe('inactive About preparation', () => {
  it.each(['de', 'en'] as const)('preserves active %s content, refuses unsafe activation, and permits the empty About fallback', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary] });
    const active = { locale: primary, title: 'Active About', bodyMarkdown: 'Keep this public text.', images: {} };
    const save = (payload: object) => f.app.inject({ method: 'PUT', url: '/pages/about', cookies: f.cookies, payload });
    expect((await save({ [primary]: active })).statusCode).toBe(200);
    const original = await f.pages.get('about');
    const unsafe = { title: '', bodyMarkdown: '![unsafe](https://foreign.test/photo.jpg)', images: {} };
    // Ordinary single-language editing cannot change the inactive content.
    expect((await save({ [secondary]: unsafe, updatedAt: original.updatedAt!.toISOString() })).statusCode).toBe(200);
    expect((await f.pages.get('about'))[secondary].bodyMarkdown).toBe('');
    const before = await f.pages.get('about');
    const prepared = await save({ prepareLocale: secondary, [secondary]: unsafe, updatedAt: before.updatedAt!.toISOString() });
    expect(prepared.statusCode).toBe(200);
    expect((await f.pages.get('about'))[primary]).toEqual(active);
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary] });
    f.build.mockClear();
    const refused = await f.put({ primary, locales: [primary, secondary] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'language_pages_incomplete', blockers: [{ key: 'about', locale: secondary, field: 'images' }] });
    expect(f.build).not.toHaveBeenCalled();
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary] });
    expect((await f.pages.get('about'))[primary]).toEqual(active);
    const current = await f.pages.get('about');
    const stale = await save({ prepareLocale: secondary, [secondary]: { title: '', bodyMarkdown: '', images: {} }, updatedAt: before.updatedAt!.toISOString() });
    expect(stale.statusCode).toBe(409);
    expect(await f.pages.get('about')).toEqual(current);
    expect((await save({ prepareLocale: secondary, [secondary]: { title: '', bodyMarkdown: '', images: {} }, updatedAt: current.updatedAt!.toISOString() })).statusCode).toBe(200);
    expect((await f.put({ primary, locales: [primary, secondary] })).statusCode).toBe(200);
    expect((await f.pages.get('about'))[primary]).toEqual(active);
    expect((await f.pages.get('about'))[secondary].bodyMarkdown).toBe('');
  });

  it.each(['de', 'en'] as const)('keeps a prepared %s-secondary photo private until encoding is ready', async (secondary) => {
    const primary = secondary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary] });
    await f.media.upsert({ key: 'prepared-photo', width: 100, height: 80, origBytes: 100, status: 'processing',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const prepared = await f.app.inject({ method: 'PUT', url: '/pages/about', cookies: f.cookies,
      payload: { prepareLocale: secondary, updatedAt: null, [secondary]: { title: 'Prepared', bodyMarkdown: '![Photo](https://images.test/prepared-photo)', images: {} } } });
    expect(prepared.statusCode).toBe(200);
    f.build.mockClear();
    const response = await f.put({ primary, locales: [primary, secondary] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'language_pages_incomplete', blockers: [{ key: 'about', locale: secondary, field: 'images' }] });
    expect(f.build).not.toHaveBeenCalled();
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary] });
    await f.media.setStatus('prepared-photo', 'ready');
    expect((await f.put({ primary, locales: [primary, secondary] })).statusCode).toBe(200);
    expect((await f.pages.get('about'))[secondary].bodyMarkdown).toContain('prepared-photo');
  });

  it('keeps prepared About content and the committed activation after a failed rebuild', async () => {
    const f = await fixture({ primary: 'de', locales: ['de'] });
    const active = await f.pages.save({ key: 'about', de: { locale: 'de', title: 'Public', bodyMarkdown: 'Keep DE.', images: {} } });
    await f.pages.save({ key: 'about', en: { locale: 'en', title: 'Prepared', bodyMarkdown: 'Prepared EN.', images: {} } },
      active.updatedAt!, { prepareLocale: 'en' });
    const before = await f.pages.get('about');
    f.failBuild();
    const failed = await f.put({ primary: 'de', locales: ['de', 'en'] });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ primary: 'de', locales: ['de', 'en'], build: { ok: false } });
    expect(await f.pages.get('about')).toEqual(before);
    expect(await f.language.get()).toMatchObject({ primary: 'de', locales: ['de', 'en'] });
    f.recoverBuild();
    expect((await f.app.inject({ method: 'POST', url: '/rebuild', cookies: f.cookies })).statusCode).toBe(200);
    expect(await f.pages.get('about')).toEqual(before);
  });
});

for (const publication of ['single', 'bulk'] as const) {
  describe(`${publication} publication language revalidation`, () => {
    it.each(['primary', 'disable', 'enable'] as const)('refuses a %s change committed after the reviewed state was read', async (change) => {
      const f = await fixture(change === 'enable' ? modes[2] : modes[0]);
      const pair = await f.story();
      const tokens = await publishBody(f.posts, pair.translationKey);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const publish = f.posts.publish.bind(f.posts);
      vi.spyOn(f.posts, 'publish').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return publish(...args);
      });
      const request = f.app.inject(publication === 'single'
        ? { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies, payload: tokens }
        : { method: 'POST', url: '/posts/bulk', cookies: f.cookies,
          payload: { action: 'publish', keys: [pair.translationKey], baseLanguageUpdatedAt: tokens.baseLanguageUpdatedAt } }).then((response) => response);
      await entered.promise;
      try {
        const next = change === 'primary' ? modes[1] : change === 'disable' ? modes[2] : modes[0];
        expect((await f.put(next)).statusCode).toBe(200);
      } finally { release.resolve(); }
      const response = await request;
      if (publication === 'single') {
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      }
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await f.posts.get(pair.translationKey))?.status).toBe('draft');
      expect(await f.posts.getPublishedLocales(pair.translationKey)).toEqual([]);
      expect((await f.language.get()).lockedAt).toBeNull();
      expect(f.build).toHaveBeenCalledTimes(1); // mode rebuild only; failed publication builds nothing
    });

    it('locks the primary when publication wins the serialized race', async () => {
      const f = await fixture();
      const pair = await f.story();
      const tokens = await publishBody(f.posts, pair.translationKey);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const markPublished = f.language.markPublished.bind(f.language);
      vi.spyOn(f.language, 'markPublished').mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        await markPublished();
      });
      const publishing = f.app.inject(publication === 'single'
        ? { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies, payload: tokens }
        : { method: 'POST', url: '/posts/bulk', cookies: f.cookies,
          payload: { action: 'publish', keys: [pair.translationKey], baseLanguageUpdatedAt: tokens.baseLanguageUpdatedAt } }).then((response) => response);
      await entered.promise;
      const changing = f.put(modes[1]!).then((response) => response);
      release.resolve();
      const [published, refused] = await Promise.all([publishing, changing]);
      expect(published.statusCode).toBe(200);
      if (publication === 'bulk') expect(published.json()).toMatchObject({ succeeded: 1, failed: 0 });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('language_primary_locked');
      expect(await f.posts.getPublishedLocales(pair.translationKey)).toEqual(['de', 'en']);
      expect(await f.language.get()).toMatchObject(modes[0]!);
      expect((await f.language.get()).lockedAt).not.toBeNull();
      expect(f.build).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, 'not-a-date', '2026-10-27'])('rejects invalid language review token %s instead of bypassing the mode gate', async (baseLanguageUpdatedAt) => {
      const f = await fixture();
      const pair = await f.story();
      const tokens = await publishBody(f.posts, pair.translationKey);
      const response = await f.app.inject(publication === 'single'
        ? { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies,
          payload: { baseUpdatedAt: tokens.baseUpdatedAt, baseRouteVersion: tokens.baseRouteVersion, baseLanguageUpdatedAt } }
        : { method: 'POST', url: '/posts/bulk', cookies: f.cookies, payload: { action: 'publish', keys: [pair.translationKey], baseLanguageUpdatedAt } });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_publish_tokens');
      expect((await f.posts.get(pair.translationKey))?.status).toBe('draft');
      expect(f.build).not.toHaveBeenCalled();
    });
  });
}
