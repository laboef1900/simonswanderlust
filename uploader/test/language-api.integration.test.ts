import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { injectAuthoring } from './authoring-request.js';
import { idleBuildState } from './build-fixture.js';
import { buildFailureMessage } from '../src/build-state.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureSchema, type DbPool } from '../src/db.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { memoryLanguageStore, pgLanguageStore, type LanguageConfig } from '../src/language.js';
import { memoryPostStore, pgPostStore, type PostLocale } from '../src/posts.js';
import { memoryPageStore, pgPageStore } from '../src/pages.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryMediaStore, pgMediaStore } from '../src/media-store.js';
import { memorySecretsStore } from '../src/secrets.js';
import { defaultSettings, validate } from '../src/settings.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import type { BuildOutcome } from '../src/build.js';
import { publishBody } from './publish-tokens.js';
import { pgOnboardingStore, type OnboardingStore } from '../src/onboarding.js';
import { captureBootEvidence, initializeApplicationSchema, initializeOnboarding } from '../src/onboarding-bootstrap.js';

const modes: [LanguageConfig, LanguageConfig, LanguageConfig, LanguageConfig] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(initial: LanguageConfig = modes[0]!, pool?: DbPool, onboarding?: OnboardingStore) {
  const dir = await mkdtemp(join(tmpdir(), 'language-api-'));
  const language = pool ? pgLanguageStore(pool) : memoryLanguageStore(initial);
  if (pool) await language.update(initial);
  const posts = pool ? pgPostStore(pool) : memoryPostStore({ language });
  const pages = pool ? pgPageStore(pool) : memoryPageStore(language);
  const mediaOptions = { baseUrl: 'https://images.test' };
  const media = pool ? pgMediaStore(pool, mediaOptions) : memoryMediaStore(mediaOptions);
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
    trustProxy: TEST_TRUST,
    storageDir: dir, baseUrl: 'https://images.test', imgHost: 'images.test', siteDir: join(dir, 'site'),
    posts, pages, media, users, sessions, secrets: memorySecretsStore(),
    onboarding,
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
  const put = (payload: object) => injectAuthoring(app, { method: 'PUT', url: '/language', cookies, payload });
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
  return { app, language, posts, pages, media, cookies, login, put, story, build, dir,
    failBuild: () => { outcome = { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') }; },
    recoverBuild: () => { outcome = { ok: true, attemptId: 'recovered-release', release: 'recovered-release' }; } };
}

describe('language API', () => {
  it('requires a session to read, admin to write, and never caches either success or refusal', async () => {
    const f = await fixture();
    const author = await f.login(false);
    for (const method of ['GET', 'PUT'] as const) {
      const response = await injectAuthoring(f.app, { method, url: '/language', ...(method === 'PUT' ? { payload: modes[2] } : {}) });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const read = await injectAuthoring(f.app, { method: 'GET', url: '/language', cookies: author });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json()).toMatchObject({ ...modes[0], lockedAt: null });
    const denied = await injectAuthoring(f.app, { method: 'PUT', url: '/language', cookies: author, payload: modes[2] });
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
    expect((await injectAuthoring(f.app, { method: 'GET', url: '/language', cookies: f.cookies })).json()).toEqual(storedLanguage);
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
    const published = await injectAuthoring(f.app, { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies,
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
    const response = await injectAuthoring(f.app, { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies,
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
    const retried = await injectAuthoring(f.app, { method: 'POST', url: '/rebuild', cookies: f.cookies });
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
    const save = (payload: object) => injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload });
    expect((await save({ [primary]: active })).statusCode).toBe(200);
    const original = await f.pages.get('about');
    const unsafe = { title: '', bodyMarkdown: '![unsafe](https://foreign.test/photo.jpg)', images: {} };
    // Ordinary single-language editing cannot change the inactive content.
    expect((await save({ [secondary]: unsafe, updatedAt: original.updatedAt!.toISOString() })).statusCode).toBe(200);
    expect((await f.pages.get('about'))[secondary].bodyMarkdown).toBe('');
    const before = await f.pages.get('about');
    const prepared = await save({ prepareLocale: secondary, [secondary]: unsafe, updatedAt: before.updatedAt!.toISOString() });
    expect(prepared.statusCode).toBe(200);
    expect((await f.pages.get('about'))[primary]).toEqual(original[primary]);
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary] });
    f.build.mockClear();
    const refused = await f.put({ primary, locales: [primary, secondary] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'language_pages_incomplete', blockers: [{ key: 'about', locale: secondary, field: 'images' }] });
    expect(f.build).not.toHaveBeenCalled();
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary] });
    expect((await f.pages.get('about'))[primary]).toEqual(original[primary]);
    const current = await f.pages.get('about');
    const stale = await save({ prepareLocale: secondary, [secondary]: { title: '', bodyMarkdown: '', images: {} }, updatedAt: before.updatedAt!.toISOString() });
    expect(stale.statusCode).toBe(409);
    expect(await f.pages.get('about')).toEqual(current);
    expect((await save({ prepareLocale: secondary, [secondary]: { title: '', bodyMarkdown: '', images: {} }, updatedAt: current.updatedAt!.toISOString() })).statusCode).toBe(200);
    expect((await f.put({ primary, locales: [primary, secondary] })).statusCode).toBe(200);
    expect((await f.pages.get('about'))[primary]).toEqual(original[primary]);
    expect((await f.pages.get('about'))[secondary].bodyMarkdown).toBe('');
  });

  it.each(['de', 'en'] as const)('keeps a prepared %s-secondary photo private until encoding is ready', async (secondary) => {
    const primary = secondary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary] });
    await f.media.upsert({ key: 'prepared-photo', width: 100, height: 80, origBytes: 100, status: 'processing',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const prepared = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies,
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

  it.each(['de', 'en'] as const)('keeps prepared About content and committed %s-primary activation after a failed rebuild', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary] });
    const active = await f.pages.save({ key: 'about', [primary]: { locale: primary, title: 'Public', bodyMarkdown: 'Keep primary.', images: {} } });
    await f.pages.save({ key: 'about', [secondary]: { locale: secondary, title: 'Prepared', bodyMarkdown: 'Prepared secondary.', images: {} } },
      active.updatedAt!, { prepareLocale: secondary });
    const before = await f.pages.get('about');
    expect(before[secondary].publishedAt).toBeNull();
    f.failBuild();
    const failed = await f.put({ primary, locales: [primary, secondary] });
    // #297: the committed activation answers 200 with its failed build attempt.
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ primary, locales: [primary, secondary], build: { ok: false } });
    const activated = await f.pages.get('about');
    expect(activated[secondary].publishedAt).toBeInstanceOf(Date);
    expect(activated).toEqual({
      ...before,
      [secondary]: { ...before[secondary], publishedAt: activated[secondary].publishedAt },
      updatedAt: activated.updatedAt,
    });
    expect(activated.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt!.getTime());
    await expect(f.pages.save({ key: 'about', [primary]: active[primary] }, before.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.pages.get('about')).toEqual(activated);
    expect(await f.language.get()).toMatchObject({ primary, locales: [primary, secondary] });
    f.recoverBuild();
    expect((await injectAuthoring(f.app, { method: 'POST', url: '/rebuild', cookies: f.cookies })).statusCode).toBe(200);
    expect(await f.pages.get('about')).toEqual(activated);
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
      const request = injectAuthoring(f.app, publication === 'single'
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
      const publishing = injectAuthoring(f.app, publication === 'single'
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
      const response = await injectAuthoring(f.app, publication === 'single'
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

describe('editable page API lifecycle', () => {
  const payload = () => ({
    de: { title: 'Kontakt', bodyMarkdown: 'Schreib mir.', images: {}, slug: 'kontakt' },
    en: { title: 'Contact', bodyMarkdown: 'Write to me.', images: {}, slug: 'contact' },
  });
  it.each(['about', 'contact', 'privacy', 'legal'])('requires and privately reconciles the captured owner/save identity for %s', async key => {
    const f = await fixture();
    const before = await f.pages.get(key);
    const beforeHistory = await f.pages.listRevisions(key);
    const ownerUserId = (await f.app.inject({ method: 'GET', url: '/auth/me', cookies: f.cookies })).json().userId;
    const body = Object.fromEntries((['de', 'en'] as const).map(locale => [locale, {
      title: locale + ' title', bodyMarkdown: 'Complete page', images: {}, slug: key === 'about' ? '' : 'receipt-' + key + '-' + locale,
    }]));
    const missing = await f.app.inject({ method: 'PUT', url: '/pages/' + key, cookies: f.cookies, payload: body });
    expect(missing.statusCode).toBe(400);
    const wrong = await f.app.inject({ method: 'PUT', url: '/pages/' + key, cookies: f.cookies,
      payload: { ...body, saveId: randomUUID(), expectedOwnerId: randomUUID() } });
    expect(wrong.statusCode).toBe(403); expect(wrong.json().code).toBe('owner_changed');
    expect(await f.pages.get(key)).toEqual(before);
    expect(await f.pages.listRevisions(key)).toEqual(beforeHistory);
    expect(f.build).not.toHaveBeenCalled();
    const saveId = randomUUID();
    const saved = await f.app.inject({ method: 'PUT', url: '/pages/' + key, cookies: f.cookies,
      payload: { ...body, updatedAt: before.updatedAt, saveId, expectedOwnerId: ownerUserId } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ownerUserId, saveId });
    const read = await f.app.inject({ method: 'GET', url: '/pages/' + key, cookies: f.cookies });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json()).toEqual({ ...saved.json().saved, ownerUserId, lastSaveId: saveId });
    const other = await f.app.inject({ method: 'GET', url: '/pages/' + key, cookies: await f.login(false) });
    expect(other.json().lastSaveId).toBeNull();
    expect(other.json().ownerUserId).not.toBe(ownerUserId);
  });
  it('returns owner-naming 409s for page/story and static claims in either creation order', async () => {
    const f = await fixture(); const storedStory = await f.story();
    const reserved = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies,
      payload: { ...payload(), de: { ...payload().de, slug: 'settings' } } });
    expect(reserved.statusCode).toBe(409); expect(reserved.json()).toMatchObject({ code: 'reserved_slug', owner: { type: 'app', name: 'settings' } });
    const taken = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies,
      payload: { ...payload(), de: { ...payload().de, slug: storedStory.de.slug } } });
    expect(taken.statusCode).toBe(409); expect(taken.json()).toMatchObject({ owner: { type: 'story', name: storedStory.translationKey } });
    expect((await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies, payload: payload() })).statusCode).toBe(200);
    const changedStory = await injectAuthoring(f.app, { method: 'PUT', url: '/posts/' + storedStory.translationKey, cookies: f.cookies,
      payload: { ...storedStory, de: { ...storedStory.de, slug: 'kontakt' }, confirmSlugChange: true, baseUpdatedAt: storedStory.updatedAt.toISOString() } });
    expect(changedStory.statusCode).toBe(409); expect(changedStory.json()).toMatchObject({ code: 'reserved_slug', owner: { type: 'page', name: 'contact' } });
    expect((await f.posts.get(storedStory.translationKey))!.de.slug).toBe(storedStory.de.slug); expect(f.build).not.toHaveBeenCalled();
  });
  it('creates drafts without rebuilding, previews sanitized content, publishes, locks slugs and deletes histories', async () => {
    const f = await fixture();
    const put = (body: object) => injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies, payload: body });
    const first = await put({ ...payload(), en: { ...payload().en, bodyMarkdown: ['Write to me.', '<script>alert("page-preview")</script>', '<a href="javascript:alert(1)">Unsafe link</a>'].join('\n\n') } });
    expect(first.statusCode).toBe(200); expect(first.json().saved.status).toBe('draft'); expect(first.json().build).toBeNull();
    expect(f.build).not.toHaveBeenCalled();
    const preview = await injectAuthoring(f.app, { method: 'GET', url: '/pages/contact/preview?locale=en', cookies: f.cookies });
    expect(preview.statusCode).toBe(200); expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.headers['content-security-policy']).toContain("default-src 'none'");
    expect(preview.body).toContain('Write to me.');
    expect(preview.body).not.toContain('<script>'); expect(preview.body).not.toContain('javascript:');
    const saved = await put({ ...payload(), updatedAt: first.json().saved.updatedAt });
    const rev = (await f.pages.listRevisions('contact'))[0]!;
    const published = await injectAuthoring(f.app, { method: 'POST', url: '/pages/contact/publish', cookies: f.cookies, payload: { updatedAt: saved.json().saved.updatedAt } });
    expect(published.statusCode).toBe(200); expect(f.build).toHaveBeenCalledTimes(1);
    const locked = await put({ ...payload(), de: { ...payload().de, slug: 'changed' }, updatedAt: published.json().saved.updatedAt });
    expect(locked.statusCode).toBe(409); expect(locked.json().code).toBe('page_slug_locked');
    const incomplete = await put({ ...payload(), en: { ...payload().en, bodyMarkdown: '' }, updatedAt: published.json().saved.updatedAt });
    expect(incomplete.statusCode).toBe(400); expect(f.build).toHaveBeenCalledTimes(1);
    const deleted = await injectAuthoring(f.app, { method: 'DELETE', url: '/pages/contact', cookies: f.cookies, payload: { updatedAt: published.json().saved.updatedAt } });
    expect(deleted.statusCode).toBe(200); expect(f.build).toHaveBeenCalledTimes(2);
    for (const path of ['/pages/contact/revisions', '/pages/contact/revisions/' + rev.id, '/pages/contact/preview?locale=en']) {
      expect((await injectAuthoring(f.app, { method: 'GET', url: path, cookies: f.cookies })).statusCode).toBe(404);
    }
  });

  it('keeps page reads at session level and every mutation/deletion scope admin-only', async () => {
    const f = await fixture(); const author = await f.login(false);
    await f.pages.save({ key: 'contact', de: { locale: 'de', ...payload().de }, en: { locale: 'en', ...payload().en } });
    for (const path of ['/pages', '/pages/contact', '/pages/contact/revisions', '/pages/contact/preview?locale=de']) {
      expect((await injectAuthoring(f.app, { method: 'GET', url: path, cookies: author })).statusCode).toBe(200);
      expect((await injectAuthoring(f.app, { method: 'GET', url: path })).statusCode).toBe(401);
    }
    for (const [method, path] of [['PUT', '/pages/contact'], ['POST', '/pages/contact/publish'], ['POST', '/pages/contact/unpublish'], ['DELETE', '/pages/contact'], ['GET', '/pages/contact/deletion']] as const) {
      expect((await injectAuthoring(f.app, { method, url: path, cookies: author, ...(method !== 'GET' ? { payload: payload() } : {}) })).statusCode).toBe(403);
    }
    expect(f.build).not.toHaveBeenCalled();
    expect((await injectAuthoring(f.app, { method: 'PUT', url: '/pages/new-kind', cookies: f.cookies, payload: payload() })).json()).toMatchObject({ code: 'unknown_page_kind' });
    for (const [method, path] of [['DELETE', '/pages/about'], ['POST', '/pages/about/unpublish']] as const) {
      await f.pages.save({ key: 'about' });
      expect((await injectAuthoring(f.app, { method, url: path, cookies: f.cookies })).json()).toMatchObject({ code: 'page_fixed' });
    }
  });

  it('refuses foreign images on first Publish, live PUT and revision restoration before any write or build', async () => {
    const f = await fixture(); const clean = payload();
    const bad = { ...clean, de: { ...clean.de, bodyMarkdown: '```gallery\nhttps://foreign.test/photo | 800x600 | alt="Photo"\n```' } };
    const draft = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies, payload: bad });
    expect(draft.statusCode).toBe(200);
    const refused = await injectAuthoring(f.app, { method: 'POST', url: '/pages/contact/publish', cookies: f.cookies });
    expect(refused.statusCode).toBe(409); expect(refused.json()).toMatchObject({ code: 'foreign_images', locale: 'de', foreignImageCount: 1, foreignImages: ['https://foreign.test/photo'] });
    expect(f.build).not.toHaveBeenCalled();
    await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies, payload: clean });
    const unsafe = (await f.pages.listRevisions('contact'))[0]!;
    await injectAuthoring(f.app, { method: 'POST', url: '/pages/contact/publish', cookies: f.cookies });
    const before = await f.pages.get('contact'); const history = await f.pages.listRevisions('contact');
    const revision = (await f.pages.getRevision('contact', unsafe.id))!;
    for (const body of [bad, revision.snapshot]) {
      const result = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies, payload: { ...body, updatedAt: before.updatedAt?.toISOString() } });
      expect(result.statusCode).toBe(409); expect(result.json().code).toBe('foreign_images');
      expect(await f.pages.get('contact')).toEqual(before); expect(await f.pages.listRevisions('contact')).toEqual(history);
    }
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it('reports saved-but-not-rebuilt with the committed token and recovers through a validated revision PUT', async () => {
    const f = await fixture();
    const initial = { key: 'about', de: { locale: 'de' as const, title: 'Before', bodyMarkdown: '', images: {} } };
    await f.pages.save(initial); f.failBuild();
    const result = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: { de: { ...initial.de, title: 'Saved despite build failure' } } });
    // #297: the committed save answers 200 beside its failed build attempt.
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ build: { ok: false }, ownerUserId: expect.any(String), saveId: expect.any(String), saved: { de: { title: 'Saved despite build failure' } } });
    const revision = (await f.pages.getRevision('about', (await f.pages.listRevisions('about'))[0]!.id))!;
    f.recoverBuild();
    const restored = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: { ...revision.snapshot, updatedAt: result.json().saved.updatedAt } });
    expect(restored.statusCode).toBe(200); expect(restored.json().saved.de.title).toBe('Before'); expect(restored.json().build.ok).toBe(true);
  });

  it.each(['de', 'en'] as const)('preflights complete non-About pages before adding the %s-primary secondary and retains saved mode on build failure', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de'; const f = await fixture({ primary, locales: [primary] });
    const draft = await f.pages.save({ key: 'contact', [primary]: { locale: primary, ...payload()[primary] } });
    await f.pages.publish('contact', draft.updatedAt!);
    const before = await f.language.get();
    const denied = await f.put({ primary, locales: [primary, secondary] });
    expect(denied.statusCode).toBe(409); expect(denied.json().code).toBe('language_pages_incomplete'); expect(await f.language.get()).toEqual(before);
    const current = await f.pages.get('contact');
    const prepared = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/contact', cookies: f.cookies,
      payload: { prepareLocale: secondary, updatedAt: current.updatedAt?.toISOString(), [secondary]: payload()[secondary] } });
    expect(prepared.statusCode).toBe(200); expect(prepared.json().saved[secondary].publishedAt).toBeNull();
    expect((await f.pages.getForSave('contact', prepared.json().ownerUserId)).lastSaveId).toBe(prepared.json().saveId);
    expect(await f.language.get()).toEqual(before);
    f.failBuild();
    const activation = await f.put({ primary, locales: [primary, secondary] });
    expect(activation.statusCode).toBe(200); expect(activation.json()).toMatchObject({ primary, locales: [primary, secondary], build: { ok: false } });
    expect((await f.pages.get('contact'))[secondary].publishedAt).toBeInstanceOf(Date);
    expect((await f.pages.getForSave('contact', prepared.json().ownerUserId)).lastSaveId).toBeNull();
    f.recoverBuild();
    expect((await injectAuthoring(f.app, { method: 'POST', url: '/rebuild', cookies: f.cookies })).json().ok).toBe(true);
  });
});

describe('revision restoration with a disabled language', () => {
  it.each(['de', 'en'] as const)('ignores the hidden %s slug while preserving active slug protections', async (secondary) => {
    const primary = secondary === 'de' ? 'en' : 'de';
    const f = await fixture({ primary, locales: [primary, secondary] });
    const original = await f.story();
    const tk = original.translationKey;
    const save = (payload: object) => injectAuthoring(f.app, { method: 'PUT', url: `/posts/${tk}`, cookies: f.cookies, payload });
    const renamed = await save({ ...original, confirmSlugChange: true,
      [secondary]: { ...original[secondary], slug: `renamed-${secondary}`, bodyMarkdown: 'Retained translation.' } });
    expect(renamed.statusCode).toBe(200);
    const revision = await f.posts.getRevision(tk, (await f.posts.listRevisions(tk))[0]!.id);
    expect(revision?.snapshot[secondary].slug).toBe(original[secondary].slug);
    expect((await f.put({ primary, locales: [primary] })).statusCode).toBe(200);
    const before = (await f.posts.get(tk))!;
    const restored = await save({ ...revision!.snapshot, updatedAt: before.updatedAt,
      [primary]: { ...revision!.snapshot[primary], bodyMarkdown: 'Restored and edited active content.' } });
    expect(restored.statusCode).toBe(200);
    const saved = (await f.posts.get(tk))!;
    expect(saved[primary].bodyMarkdown).toBe('Restored and edited active content.');
    expect(saved[secondary]).toEqual(before[secondary]);
    expect(saved[secondary]).toMatchObject({ slug: `renamed-${secondary}`, bodyMarkdown: 'Retained translation.', omitted: true });

    const draftRename = await save({ ...saved, [primary]: { ...saved[primary], slug: `renamed-${primary}` } });
    expect(draftRename.statusCode).toBe(409);
    expect(draftRename.json()).toMatchObject({ code: 'slug_change_unconfirmed' });
    expect(await f.posts.get(tk)).toEqual(saved);
    const published = await injectAuthoring(f.app, { method: 'POST', url: `/posts/${tk}/publish`, cookies: f.cookies,
      payload: await publishBody(f.posts, tk) });
    expect(published.statusCode).toBe(200);
    const live = (await f.posts.get(tk))!;
    const liveRename = await save({ ...live, confirmSlugChange: true,
      [primary]: { ...live[primary], slug: `renamed-${primary}` } });
    expect(liveRename.statusCode).toBe(409);
    expect(liveRename.json()).toMatchObject({ code: 'slug_locked' });
    expect(await f.posts.get(tk)).toEqual(live);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
for (const backend of ['memory', 'postgres'] as const) {
  const suite = backend === 'postgres' && !databaseUrl ? describe.skip : describe;
  suite(`${backend} draft consent during language activation`, () => {
    it.each(['de', 'en'] as const)('refuses a pending restore when %s becomes enabled after consent validation', async (secondary) => {
      const primary = secondary === 'de' ? 'en' : 'de';
      let pool: pg.Pool | undefined;
      if (backend === 'postgres') {
        const schema = `consent_${randomUUID().replaceAll('-', '')}`;
        const observer = new pg.Pool({ connectionString: databaseUrl });
        pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
        cleanups.push(async () => {
          await pool!.end();
          await observer.query(`DROP SCHEMA ${schema} CASCADE`);
          await observer.end();
        });
        await observer.query(`CREATE SCHEMA ${schema}`);
        await ensureSchema(pool);
      }
      const f = await fixture({ primary, locales: [primary, secondary] }, pool);
      const original = await f.story();
      const tk = original.translationKey;
      const save = (payload: object) => injectAuthoring(f.app, { method: 'PUT', url: `/posts/${tk}`, cookies: f.cookies, payload });
      const renamed = await save({ ...original, confirmSlugChange: true,
        [secondary]: { ...original[secondary], slug: `renamed-${secondary}` } });
      expect(renamed.statusCode).toBe(200);
      const revision = await f.posts.getRevision(tk, (await f.posts.listRevisions(tk))[0]!.id);
      expect((await f.put({ primary, locales: [primary] })).statusCode).toBe(200);
      const before = (await f.posts.get(tk))!;
      const payload = { ...revision!.snapshot, updatedAt: before.updatedAt };
      const history = await f.posts.listRevisions(tk);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const upsert = f.posts.upsertDraft.bind(f.posts);
      vi.spyOn(f.posts, 'upsertDraft').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await resume.promise;
        return upsert(...args);
      });
      const pending = save(payload).then((response) => response);
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('save barrier was not reached'); })]);
        expect((await f.put({ primary, locales: [primary, secondary] })).statusCode).toBe(200);
        const activated = (await f.posts.get(tk))!;
        // Mode activation alone need not invalidate the pair's save token.
        expect(activated.updatedAt).toEqual(before.updatedAt);
        resume.resolve();
        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
        expect(await f.posts.get(tk)).toEqual(activated);
        expect(await f.posts.listRevisions(tk)).toEqual(history);
        const unconfirmed = await save(payload);
        expect(unconfirmed.statusCode).toBe(409);
        expect(unconfirmed.json().code).toBe('slug_change_unconfirmed');
        expect((await save({ ...payload, confirmSlugChange: true })).statusCode).toBe(200);
        expect((await f.posts.get(tk))![secondary].slug).toBe(original[secondary].slug);
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
      }
    });
  });
}

(databaseUrl ? describe : describe.skip)('publication readiness with a saturated PostgreSQL pool', () => {
  it.each(['single', 'bulk', 'about', 'activation'] as const)('%s reuses its locked client while other mutations wait', async (operation) => {
    const schema = `readiness_${randomUUID().replaceAll('-', '')}`;
    const observer = new pg.Pool({ connectionString: databaseUrl });
    // The acquisition deadline is test containment: a regression fails rather than
    // hanging teardown. Production must not depend on a timeout to free this cycle.
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 1500,
      application_name: schema, options: `-c search_path=${schema}` });
    cleanups.push(async () => {
      await pool.end();
      await observer.query(`DROP SCHEMA ${schema} CASCADE`);
      await observer.end();
    });
    await observer.query(`CREATE SCHEMA ${schema}`);
    await ensureSchema(pool);
    const f = await fixture({ primary: 'de', locales: ['de'] }, pool);
    const pair = await f.story();
    pair.de.titleImage = { ...pair.de.heroImage };
    await f.posts.upsertDraft(pair);
    const tokens = await publishBody(f.posts, pair.translationKey);
    const content = { title: 'About', bodyMarkdown: '![View](https://images.test/hero-640.webp)', images: {} };
    if (operation === 'activation') {
      await f.pages.save({ key: 'about', de: { locale: 'de', ...content } });
    }
    const waitingDrafts = await Promise.all([f.story('waiting-one'), f.story('waiting-two')]);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const notReadyKeys = f.media.notReadyKeys.bind(f.media);
    vi.spyOn(f.media, 'notReadyKeys').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return notReadyKeys(...args);
    });
    const request = (operation === 'single'
      ? injectAuthoring(f.app, { method: 'POST', url: `/posts/${pair.translationKey}/publish`, cookies: f.cookies, payload: tokens })
      : operation === 'bulk'
        ? injectAuthoring(f.app, { method: 'POST', url: '/posts/bulk', cookies: f.cookies,
          payload: { action: 'publish', keys: [pair.translationKey], baseLanguageUpdatedAt: tokens.baseLanguageUpdatedAt } })
        : operation === 'about'
          ? injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: { de: content } })
          : f.put({ primary: 'de', locales: ['de', 'en'] })).then((response) => response);
    const waiters: Array<Promise<unknown>> = [];
    try {
      await Promise.race([entered.promise, request.then(() => { throw new Error('readiness barrier was not reached'); })]);
      for (const draft of waitingDrafts) {
        const waiting = f.posts.upsertDraft({ ...draft, de: { ...draft.de, title: 'Queued edit' } });
        waiters.push(waiting);
        // Observe rejection immediately even if the assertion below fails first.
        void waiting.catch(() => {});
      }
      // An independent observer proves both other checked-out connections are
      // blocked on the actual language-row lock, not merely scheduled promises.
      await expect.poll(async () => Number((await observer.query<{ count: string }>(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND query LIKE '%FROM site_language%'`, [schema],
      )).rows[0]!.count), { timeout: 3000, interval: 10 }).toBe(2);
      expect(pool.totalCount).toBe(3);
      expect(pool.idleCount).toBe(0);
      resume.resolve();
      const [response] = await Promise.all([request, ...waiters]);
      expect(response.statusCode).toBe(200);
      if (operation === 'single' || operation === 'bulk') {
        expect(await f.posts.getPublishedLocales(pair.translationKey)).toEqual(['de']);
        expect((await f.language.get()).lockedAt).toBeInstanceOf(Date);
      } else if (operation === 'about') {
        expect((await f.pages.get('about')).de.bodyMarkdown).toBe(content.bodyMarkdown);
      } else {
        expect((await f.language.get()).locales).toEqual(['de', 'en']);
      }
      for (const draft of waitingDrafts) expect((await f.posts.get(draft.translationKey))?.de.title).toBe('Queued edit');
    } finally {
      resume.resolve();
      await Promise.allSettled([request, ...waiters]);
    }
  });
});

(databaseUrl ? describe : describe.skip)('eligible onboarding using the shared language API', () => {
  async function fresh(mode: LanguageConfig = modes[0]) {
    const schema = `onboarding_language_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: databaseUrl });
    await owner.query(`CREATE SCHEMA ${schema}`);
    // A one-connection pool makes a second read connection a deterministic failure,
    // rather than concealing a snapshot split behind plentiful idle connections.
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1500,
      options: `-c search_path=${schema}` });
    cleanups.push(async () => { await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); });
    const writable = async () => {};
    const evidence = await captureBootEvidence(pool, writable);
    await initializeApplicationSchema(pool, writable);
    const onboarding = pgOnboardingStore(pool, () => true);
    const f = await fixture(mode, pool, onboarding);
    const dataRoot = await realpath(f.dir);
    await initializeOnboarding(pool, {
      storageDir: join(dataRoot, 'images'), settingsPath: join(dataRoot, 'settings.json'),
      siteDir: join(dataRoot, 'site'), backupDir: join(dataRoot, 'backup'),
    }, evidence, writable);
    const read = () => f.app.inject({ method: 'GET', url: '/onboarding', cookies: f.cookies });
    return { ...f, pool, onboarding, read };
  }

  it.each(modes)('persists %j through PUT and exposes only current configuration, without progress or acknowledgement changes', async (mode) => {
    const f = await fresh(mode.primary === 'de' ? modes[3] : modes[2]);
    const before = (await f.read()).json();
    const metadata = (await f.pool.query('SELECT * FROM onboarding_state')).rows;
    const saved = await f.put(mode);
    expect(saved.statusCode).toBe(200);
    const read = await f.read();
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const projection = read.json();
    expect(Object.keys(projection).sort()).toEqual(['complete', 'language', 'status', 'steps']);
    // The acknowledgement adds the build attempt (#297) beside the stored configuration.
    const { build: _build, ...stored } = saved.json();
    expect(projection.language).toEqual(stored);
    expect(Object.keys(projection.language).sort()).toEqual(['locales', 'lockedAt', 'primary', 'updatedAt']);
    expect(projection.steps).toEqual(before.steps);
    expect(projection.complete).toBe(false);
    expect(projection.steps.filter((step: { required: boolean }) => step.required)).toHaveLength(3);
    expect((await f.pool.query('SELECT * FROM onboarding_state')).rows).toEqual(metadata);
    f.build.mockClear();
    expect((await f.put(mode)).json()).toEqual(stored);
    expect((await f.read()).json()).toEqual(projection);
    expect(f.build).not.toHaveBeenCalled();
    expect((await f.pool.query('SELECT * FROM onboarding_state')).rows).toEqual(metadata);
  });

  it('keeps a committed build failure visible to onboarding and recovers through Rebuild, not a second configuration write', async () => {
    const f = await fresh();
    f.failBuild();
    const saved = await f.put(modes[3]);
    // #297: the committed configuration answers 200 with its failed build attempt.
    expect(saved.statusCode).toBe(200);
    const { build, ...stored } = saved.json();
    expect(build).toMatchObject({ ok: false, code: 'internal' });
    expect((await f.read()).json().language).toEqual(stored);
    expect((await pgOnboardingStore(f.pool, () => true).read())).toMatchObject({ language: modes[3], complete: false });
    f.recoverBuild();
    const recovered = await f.app.inject({ method: 'POST', url: '/rebuild', cookies: f.cookies });
    expect(recovered.statusCode).toBe(200);
    expect((await f.read()).json().language).toEqual(stored);
    expect(f.build).toHaveBeenCalledTimes(2);
  });

  it('refuses a now-forbidden mode after publication wins between the checklist read and Save', async () => {
    const f = await fresh();
    const pair = await f.story();
    const before = (await f.read()).json();
    expect(before.language.lockedAt).toBeNull();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const update = f.posts.language.update.bind(f.posts.language);
    vi.spyOn(f.posts.language, 'update').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return update(...args);
    });
    const saving = f.put(modes[1]).then((response) => response);
    await entered.promise;
    try {
      const published = await f.app.inject({ method: 'POST', url: `/posts/${pair.translationKey}/publish`,
        cookies: f.cookies, payload: await publishBody(f.posts, pair.translationKey) });
      expect(published.statusCode).toBe(200);
    } finally { release.resolve(); }
    const refused = await saving;
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('language_primary_locked');
    const after = (await f.read()).json();
    expect(after.language).toMatchObject({ ...modes[0], lockedAt: expect.any(String) });
    expect(await f.posts.getPublishedLocales(pair.translationKey)).toEqual(['de', 'en']);
    expect(after.steps.find((step: { id: string }) => step.id === 'publish').state).toBe('done');
    expect(after.complete).toBe(true);
    expect(f.build).toHaveBeenCalledTimes(1);
    const finished = await f.app.inject({ method: 'POST', url: '/onboarding', cookies: f.cookies, payload: { action: 'finish' } });
    expect(finished.json()).toEqual({ status: 'retired' });
    expect((await f.read()).json()).toEqual({ status: 'retired' });
  });

  it('protects the shared onboarding read and language write from authors and anonymous callers', async () => {
    const f = await fresh();
    const author = await f.login(false);
    const before = (await f.read()).json();
    for (const [cookies, status] of [[undefined, 401], [author, 403]] as const) {
      const read = await f.app.inject({ method: 'GET', url: '/onboarding', cookies });
      const write = await f.app.inject({ method: 'PUT', url: '/language', cookies, payload: modes[3] });
      expect(read.statusCode).toBe(status);
      expect(write.statusCode).toBe(status);
      expect(read.headers['cache-control']).toBe('no-store');
    }
    expect((await f.read()).json()).toEqual(before);
    expect(f.build).not.toHaveBeenCalled();
  });
});
