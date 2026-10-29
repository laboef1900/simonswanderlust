import { injectAuthoring } from './authoring-request.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSiteBuilder, type SiteBuilder, type BuildOutcome } from '../src/build.js';
import { buildFailureMessage, type BuildTrigger } from '../src/build-state.js';
import { ensureSchema } from '../src/db.js';
import { memoryPostStore, pgPostStore, type PostLocale, type PostStore } from '../src/posts.js';
import { memoryPageStore, pgPageStore, type PageStore, type StoredPagePair } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memorySecretsStore } from '../src/secrets.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { seedSiteIdentity } from '../src/site-identity.js';
import { buildServer } from '../src/server.js';
import { createWorkLock } from '../src/work-lock.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { idleBuildState } from './build-fixture.js';
import { publishBody } from './publish-tokens.js';

const origin = 'https://images.test';
const diagnostics = '/private/SECRET_DATABASE_HOST postgres://secret/internal stderr sentinel';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(options: { posts?: PostStore; pages?: PageStore; builder?: SiteBuilder; pool?: pg.Pool; isWritable?: () => boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'build-routes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const posts = options.posts ?? memoryPostStore();
  const pages = options.pages ?? memoryPageStore(posts.language);
  const media = memoryMediaStore({ baseUrl: origin });
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const lock = createWorkLock();
  const queue = createEncodeQueue({ store: media, storageDir: join(root, 'images'), lock });
  let fail = false;
  const builder = options.builder ?? createSiteBuilder({
    siteAppDir: join(root, 'astro'), releasesRoot: join(root, 'site'), lock,
    ...(options.pool ? { pool: options.pool } : {}),
    runBuild: async (outDir) => {
      if (fail) throw new Error(diagnostics);
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'index.html'), '<h1>Previous live release</h1>');
    },
  });
  await builder.initialize();
  const unavailable = async (): Promise<never> => { throw new Error('Not used by this test'); };
  const app = buildServer({
    storageDir: join(root, 'images'), siteDir: join(root, 'site'), backupDir: join(root, 'mdx'),
    baseUrl: origin, imgHost: 'images.test', posts, pages, media, users, sessions,
    isWritable: options.isWritable,
    secrets: memorySecretsStore(), encodeQueue: queue, builder,
    settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
    dbCheck: async () => {},
    dbBackup: { dir: join(root, 'backup'), runNow: unavailable, running: () => false,
      sweepTempFiles: () => [], list: () => [], listImageArchives: () => [], listRouteArchives: () => [],
      state: () => ({}), quiesce: async () => {} },
  });
  cleanup.push(async () => { await app.close(); await builder.quiesce(); await queue.quiesce(); });
  async function login(isAdmin: boolean) {
    const user = await users.create({ username: isAdmin ? 'admin' : 'author', password: 'test-password-123', isAdmin });
    return { sid: await sessions.create(user.id, 60_000) };
  }
  const cookies = await login(true);
  await media.upsert({ key: 'hero', status: 'ready', width: 640, height: 480, origBytes: 1,
    exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
  const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-build-report`, title: 'A story',
    excerpt: 'A story excerpt', country: 'Test', bodyMarkdown: 'A story body.', images: {},
    heroImage: { src: `${origin}/hero`, width: 640, height: 480, alt: 'Landscape' } });
  const draft = await posts.upsertDraft({ translationKey: '', status: 'draft',
    shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: locale('de'), en: locale('en') });
  const tk = draft.translationKey;
  const publish = async () => app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies,
    payload: await publishBody(posts, tk) });
  return { app, posts, pages, builder, cookies, login, tk, publish, failBuild: () => { fail = true; } };
}

async function retainsPreviousRelease(posts?: PostStore, pool?: pg.Pool) {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await fixture({ posts, pool });
  const initial = await f.builder.build('rebuild');
  expect(initial.ok).toBe(true);
  f.failBuild();
  // A failed optional post-commit backup read must not erase the acknowledgement.
  vi.spyOn(f.posts, 'getPublishedTrack').mockRejectedValueOnce(new Error('backup enrichment unavailable'));
  const response = await f.publish();
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ published: true, updatedAt: expect.any(String), build: {
    ok: false, attemptId: expect.any(String), code: 'internal', error: buildFailureMessage('internal'), liveRelease: initial.release,
  } });
  expect(response.body).not.toContain(diagnostics);
  expect(response.body).not.toContain('cause');
  expect(log.mock.calls.flat().map(String).join(' ')).toContain(diagnostics);
  const page = await f.app.inject({ url: '/' });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('Previous live release');
  const published = (await f.posts.get(f.tk))!;
  expect(published.status).toBe('published');
  expect(body.updatedAt).toBe(published.updatedAt.toISOString());
  await expect(f.posts.upsertDraft({ ...published, de: { ...published.de, title: 'Next save' } }, new Date(body.updatedAt))).resolves.toBeDefined();
  const status = await f.app.inject({ url: '/rebuild/status', cookies: f.cookies });
  expect(status.statusCode).toBe(200);
  expect(status.headers['cache-control']).toBe('no-store');
  expect(status.json()).toMatchObject({ live: { release: initial.release }, last: {
    result: 'failed', triggers: ['publish'], failure: { code: 'internal', message: buildFailureMessage('internal') },
  } });
  expect(status.body).not.toContain(diagnostics);
  const unpublish = await f.app.inject({ method: 'POST', url: `/posts/${f.tk}/unpublish`, cookies: f.cookies });
  expect(unpublish.statusCode).toBe(200);
  expect(unpublish.json()).toMatchObject({ unpublished: true, build: { ok: false, liveRelease: initial.release } });
  const unpublished = (await f.posts.get(f.tk))!;
  expect(unpublish.json().updatedAt).toBe(unpublished.updatedAt.toISOString());
  await expect(f.posts.upsertDraft(unpublished, new Date(unpublish.json().updatedAt))).resolves.toBeDefined();
}

describe('build reporting HTTP contract', () => {
  it('preserves the CMS commit and previous live bytes after a real build fails', async () => retainsPreviousRelease());

  it('restricts status to admins and permits read-only inspection without starting a build', async () => {
    const build = vi.fn(async (): Promise<BuildOutcome> => ({ ok: false, attemptId: null, code: 'build_stopped', error: buildFailureMessage('build_stopped') }));
    const status = vi.fn(idleBuildState.status);
    const f = await fixture({ isWritable: () => false, builder: { ...idleBuildState, build, status, hasRelease: () => false, quiesce: async () => {} } });
    expect((await f.app.inject({ url: '/rebuild/status' })).statusCode).toBe(401);
    const author = await f.login(false);
    expect((await f.app.inject({ url: '/rebuild/status', cookies: author })).statusCode).toBe(403);
    const response = await f.app.inject({ url: '/rebuild/status', cookies: f.cookies });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ live: null, running: null, last: null, record: 'missing' });
    expect(status).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps the unpublish mutation token when another writer edits during a failed rebuild', async () => {
    const posts = memoryPostStore();
    let committed: Date | undefined;
    let tk = '';
    const f = await fixture({ posts, builder: { ...idleBuildState, hasRelease: () => false, quiesce: async () => {},
      build: async (trigger) => {
        if (trigger === 'unpublish') {
          const pair = (await posts.get(tk))!;
          committed = pair.updatedAt;
          await posts.upsertDraft({ ...pair, de: { ...pair.de, title: 'Later writer' } });
        }
        return { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
      },
    } });
    tk = f.tk;
    expect((await f.publish()).statusCode).toBe(200);
    const response = await f.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: f.cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ unpublished: true, updatedAt: committed!.toISOString(), build: { ok: false } });
    expect((await posts.get(tk))!.updatedAt.getTime()).toBeGreaterThan(committed!.getTime());
  });

  it('keeps the About acknowledgement token when its failed build includes a later save', async () => {
    let onBuild: () => Promise<void> = async () => {};
    const f = await fixture({ builder: { ...idleBuildState, hasRelease: () => false, quiesce: async () => {},
      build: async () => {
        await onBuild();
        return { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
      },
    } });
    let committed: Date | undefined;
    onBuild = async () => {
      const page = await f.pages.get('about');
      committed = page.updatedAt ?? undefined;
      await f.pages.save({ key: 'about', de: { ...page.de, title: 'Later writer' } }, page.updatedAt ?? undefined);
    };
    const response = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: {
      de: { locale: 'de', title: 'Submitted', bodyMarkdown: 'Text', images: {} },
      en: { locale: 'en', title: 'About', bodyMarkdown: 'Text', images: {} },
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ saved: { updatedAt: committed!.toISOString(), de: { title: 'Submitted' } }, build: { ok: false } });
    expect((await f.pages.get('about')).updatedAt!.getTime()).toBeGreaterThan(committed!.getTime());
  });

  it('projects only sanitized report fields for every build-starting action', async () => {
    const triggers: BuildTrigger[] = [];
    const outcome = { ok: false, attemptId: 'failed', code: 'internal' as const,
      error: buildFailureMessage('internal'), cause: new Error(diagnostics), stderr: diagnostics };
    const f = await fixture({ builder: { ...idleBuildState, hasRelease: () => false, quiesce: async () => {},
      build: async (trigger) => { triggers.push(trigger); return outcome; } } });
    const report = { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
    const publish = await f.publish();
    expect(publish.json().build).toEqual(report);
    const unpublish = await f.app.inject({ method: 'POST', url: `/posts/${f.tk}/unpublish`, cookies: f.cookies });
    expect(unpublish.json().build).toEqual(report);
    const bulk = await f.app.inject({ method: 'POST', url: '/posts/bulk', cookies: f.cookies,
      payload: { action: 'publish', keys: [f.tk], baseLanguageUpdatedAt: (await f.posts.language.get()).updatedAt.toISOString() } });
    expect(bulk.json()).toMatchObject({ succeeded: 1, failed: 0, build: report });
    const deleted = await f.app.inject({ method: 'DELETE', url: `/posts/${f.tk}`, cookies: f.cookies });
    expect(deleted.json()).toMatchObject({ deleted: true, build: report });
    const saved = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: {
      de: { locale: 'de', title: 'Über', bodyMarkdown: 'Text', images: {} },
      en: { locale: 'en', title: 'About', bodyMarkdown: 'Text', images: {} },
    } });
    expect(saved.json()).toMatchObject({ saved: { updatedAt: expect.any(String) }, build: report });
    const rebuilt = await f.app.inject({ method: 'POST', url: '/rebuild', cookies: f.cookies });
    expect(rebuilt.json()).toEqual(report);
    for (const response of [publish, unpublish, bulk, deleted, saved, rebuilt]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(diagnostics);
      expect(response.body).not.toContain('cause');
      expect(response.body).not.toContain('stderr');
    }
    expect(triggers).toEqual(['publish', 'unpublish', 'bulk', 'delete', 'page', 'rebuild']);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('build reporting with PostgreSQL', () => {
  it('preserves the committed publish/token and previous live release after a real build fails', async () => {
    const schema = `build_report_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: databaseUrl });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    cleanup.push(async () => { await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); });
    await ensureSchema(pool);
    await seedSiteIdentity(pool);
    await retainsPreviousRelease(pgPostStore(pool), pool);
    const pages = pgPageStore(pool);
    const read = vi.spyOn(pages, 'get').mockRejectedValue(new Error('post-commit enrichment unavailable'));
    let later: StoredPagePair | undefined;
    const f = await fixture({ pages, builder: { ...idleBuildState, hasRelease: () => false, quiesce: async () => {},
      build: async () => {
        later = await pages.save({ key: 'about', de: { locale: 'de', title: 'Later writer', bodyMarkdown: 'Later', images: {} } });
        return { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
      },
    } });
    const response = await injectAuthoring(f.app, { method: 'PUT', url: '/pages/about', cookies: f.cookies, payload: {
      de: { locale: 'de', title: 'Submitted', bodyMarkdown: 'Original', images: {} },
      en: { locale: 'en', title: 'About', bodyMarkdown: 'Original', images: {} },
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ saved: { updatedAt: expect.any(String), de: { title: 'Submitted' } }, build: { ok: false } });
    expect(new Date(response.json().saved.updatedAt).getTime()).toBeLessThan(later!.updatedAt!.getTime());
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect((await pages.get('about')).de.title).toBe('Later writer');
  });
});
