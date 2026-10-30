import { formatsFor, variantWidths } from '../src/variants.js';
import { injectAuthoring } from './authoring-request.js';
import { createUploadService } from '../src/upload-service.js';
import { memoryUploadReceiptStore } from '../src/upload-receipts.js';
import { idleBuildState } from './build-fixture.js';
import { buildFailureMessage, type BuildTrigger } from '../src/build-state.js';
import { TEST_TRUST, GATEWAY_TRUST } from './trusted-proxy-fixture.js';
import { publishBody, publishTokens } from './publish-tokens.js';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BackupState, DbBackup } from '../src/backup.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import { rehostImage } from '../src/wp-images.js';
import { contentHashKey } from '../src/storage.js';
import { rehostKey, ImportTooLargeError, ImportInsufficientSpaceError, type ImportDeps, type ImportProgress, type ImportSummary, type PreparedImport } from '../src/wp-import.js';
import { createImportRunner, memoryImportJobStore, type ImportRunner } from '../src/import-jobs.js';
import { defaultSettings, validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';
import { memoryUserStore, hashPassword, type User, type UserStore } from '../src/users.js';
import { randomUUID } from 'node:crypto';
import { memorySessionStore, type SessionStore } from '../src/sessions.js';
import { memoryPostStore, type PostStore } from '../src/posts.js';
import { memoryPageStore, type PageStore } from '../src/pages.js';
import { memoryLanguageStore } from '../src/language.js';
import { memoryNavigationStore } from '../src/navigation.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import type { MediaImpact } from '../src/media-impact.js';
import { createEncodeQueue, type EncodeQueue } from '../src/encode-queue.js';
import { createWorkLock, type WorkLock } from '../src/work-lock.js';
import { fixedWindowLimiter, accountLockoutLimiter } from '../src/rate-limit.js';
import type { SiteBuilder, BuildOutcome } from '../src/build.js';
import { memorySecretsStore, SecretsError } from '../src/secrets.js';
import type { AiProvider, AiProviderKind } from '../src/ai-providers.js';
import { memoryOnboardingStore, type OnboardingProgress, type OnboardingState } from '../src/onboarding.js';
import type { ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

// @ai-note Import pacing is switched OFF for the route suite: the fixture's
// image URLs are unreachable, and the production default (1200 ms spacing, 3
// retries) would add real sleeps to every import test for no coverage. The
// pacing itself is covered in wp-import.test.ts with an injected clock; the
// tests below that DO exercise it set the values explicitly.
const SETTINGS: Settings = { ...defaultSettings(), importDelayMs: 0, importRetries: 0 };
function fakeStore(init: Settings = SETTINGS): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

function stubBuilder(outcome: BuildOutcome = { ok: true, attemptId: 'r1', release: 'r1' }) {
  const calls: BuildTrigger[] = [];
  return {
    calls,
    builder: {
      ...idleBuildState,
      build: async (trigger: BuildTrigger) => { calls.push(trigger); return outcome; },
      hasRelease: () => true,
      quiesce: async () => {},
    } satisfies SiteBuilder,
  };
}

function stubBackup(dir = '/tmp/none', running = false) {
  let state: BackupState = {};
  const backup: DbBackup = {
    dir,
    runNow: async () => { state = { lastAttemptAt: 'a', lastSuccessAt: 's' }; return { ...state }; },
    running: () => running,
    sweepTempFiles: () => [],
    list: () => [{ name: 'db-20260703-120000.json.gz', size: 3 }],
    listImageArchives: () => [{ name: 'images-20260703-120000.tar', size: 7 }],
    listRouteArchives: () => [], quiesce: async () => {},
    state: () => ({ ...state }),
  };
  return { backup };
}

/**
 * An encode queue that records what was enqueued instead of running sharp —
 * the real encoder is covered in encode-queue.test.ts, and a 19s-per-frame
 * pipeline has no place in the route suite.
 */
function stubQueue() {
  const enqueued: string[] = [];
  const queue: EncodeQueue = {
    withAdmission: (_key, operation) => operation(),
    enqueue: (key) => { enqueued.push(key); },
    isActive: (key) => enqueued.includes(key),
    availableCapacity: () => 100,
    onCapacity: () => () => {},
    recover: async () => 0,
    drain: async () => {},
    quiesce: async () => {},
    idle: async () => {},
    stats: () => ({ pending: enqueued.length, running: 0 }),
  };
  return { enqueued, queue };
}

interface Built {
  app: ReturnType<typeof buildServer>; users: UserStore; sessions: SessionStore;
  posts: PostStore; pages: PageStore; media: MediaStore; enqueued: string[]; importJobs: ImportRunner;
}
function build(extra: Partial<ServerConfig> = {}): Built {
  const users = (extra.users as UserStore) ?? memoryUserStore();
  const sessions = (extra.sessions as SessionStore) ?? memorySessionStore();
  const posts = (extra.posts as PostStore) ?? memoryPostStore(extra.language ? { language: extra.language } : undefined);
  const media = (extra.media as MediaStore) ?? memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
  const q = stubQueue();
  const encodeQueue = (extra.encodeQueue as EncodeQueue) ?? q.queue;
  const importJobs = (extra.importJobs as ImportRunner) ?? createImportRunner({ store: memoryImportJobStore(), log: () => {} });
  const pages = (extra.pages as PageStore) ?? memoryPageStore(extra.language ?? posts.language);
  const settings = extra.settings ?? fakeStore();
  const uploads = createUploadService({ receipts: memoryUploadReceiptStore(), media, queue: encodeQueue,
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', settings,
    isWritable: () => extra.isWritable?.() !== false });
  const built = buildServer({
    trustProxy: TEST_TRUST,
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings, secrets: memorySecretsStore(),
    posts, media, encodeQueue, importJobs, pages, uploads,
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: (extra.builder as SiteBuilder) ?? stubBuilder().builder,
    backupDir: dir + '/backup',
    dbBackup: (extra.dbBackup as DbBackup) ?? stubBackup().backup,
    dbCheck: async () => {},
    ...extra,
  });
  return { app: built, users, sessions, posts, pages, media, enqueued: q.enqueued, importJobs };
}

/** Route-only ready fixture: readiness requires the complete nonempty variant set. */
async function markReady(media: MediaStore, key: string) {
  const item = await media.get(key);
  if (!item) throw new Error('missing upload fixture');
  for (const width of variantWidths(item.width)) for (const format of formatsFor(item.format)) {
    await writeFile(join(dir, `${key}-${width}.${format}`), 'fixture-variant');
  }
  await media.setStatus(key, 'ready');
}

// Seed a user and return a Cookie header value for an authenticated session.
async function authed(b: Built, opts: { isAdmin?: boolean; username?: string } = {}) {
  const u = await b.users.create({ username: opts.username ?? 'simon', password: 'password123456', isAdmin: opts.isAdmin ?? true });
  const token = await b.sessions.create(u.id, 60_000);
  return { user: u, cookie: { sid: token } };
}

describe('Postgres navigation API boundary', () => {
  it('requires admin, validates URLs, detects stale tokens and builds once after a valid save', async () => {
    const language = memoryLanguageStore();
    const navigation = memoryNavigationStore(language);
    const s = stubBuilder();
    const b = build({ language, navigation, builder: s.builder });
    try {
      const admin = await authed(b);
      const author = await authed(b, { isAdmin: false, username: 'author' });
      for (const method of ['GET', 'PUT'] as const) {
        expect((await b.app.inject({ method, url: '/settings/navigation' })).statusCode).toBe(401);
        expect((await b.app.inject({ method, url: '/settings/navigation', cookies: author.cookie })).statusCode).toBe(403);
      }
      const loaded = await b.app.inject({ url: '/settings/navigation', cookies: admin.cookie });
      expect(loaded.headers['cache-control']).toBe('no-store');
      expect(loaded.json().config).toEqual(DEFAULT_NAVIGATION);
      const updatedAt = loaded.json().updatedAt;
      for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.test']) {
        const bad = await b.app.inject({ method: 'PUT', url: '/settings/navigation', cookies: admin.cookie,
          payload: { updatedAt, config: { ...DEFAULT_NAVIGATION, header: [{ kind: 'external', href: { de: href }, label: { de: 'Link' } }] } } });
        expect(bad.statusCode).toBe(400);
      }
      expect(s.calls).toHaveLength(0);
      const payload = { updatedAt, config: { ...DEFAULT_NAVIGATION, legal: [{ kind: 'page', target: 'privacy' }] } };
      const saved = await b.app.inject({ method: 'PUT', url: '/settings/navigation', cookies: admin.cookie, payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().saved.config.legal).toEqual(payload.config.legal);
      expect(saved.json().saved.updatedAt).not.toBe(updatedAt);
      expect(s.calls).toHaveLength(1);
      expect((await b.app.inject({ method: 'PUT', url: '/settings/navigation', cookies: admin.cookie, payload })).statusCode).toBe(409);
      expect(s.calls).toHaveLength(1);
    } finally { await b.app.close(); }
  });
  it('acknowledges committed navigation with a sanitized failed-build report', async () => {
    const language = memoryLanguageStore();
    const navigation = memoryNavigationStore(language);
    const builder = stubBuilder({ ok: false, attemptId: '1793300000000-1-1234', liveRelease: '1793290000000-1-1234', code: 'build_failed', error: 'private infrastructure detail' }).builder;
    const b = build({ language, navigation, builder });
    try {
      const { cookie } = await authed(b);
      const updatedAt = (await navigation.get()).updatedAt.toISOString();
      const saved = await b.app.inject({ method: 'PUT', url: '/settings/navigation', cookies: cookie,
        payload: { updatedAt, config: { ...DEFAULT_NAVIGATION, footer: [] } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ saved: { config: { footer: [] } },
        build: { ok: false, attemptId: '1793300000000-1-1234', liveRelease: '1793290000000-1-1234', code: 'build_failed' } });
      expect(saved.json()).not.toHaveProperty('persisted');
      expect(saved.body).not.toContain('private infrastructure detail');
      expect((await navigation.get()).updatedAt.toISOString()).toBe(saved.json().saved.updatedAt);
      expect((await navigation.get()).config.footer).toEqual([]);
    } finally { await b.app.close(); }
  });
});

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1000, height: 800, channels: 3, background: '#444' } }).jpeg().toBuffer();
}

/**
 * A server wired to the REAL encode queue, so tests that need actual variant
 * files on disk (static serving, cache headers, the private original) still
 * exercise the whole path. Await `settle()` after an upload — encoding is
 * asynchronous now, which is the entire point of the phase.
 */
function buildEncoding(extra: Partial<ServerConfig> = {}) {
  const media = memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
  const queue = createEncodeQueue({ store: media, storageDir: dir, lock: createWorkLock(), concurrency: 1 });
  const b = build({ media, encodeQueue: queue, ...extra });
  return { ...b, media, settle: () => queue.idle() };
}

/** Upload one image and return the parsed body. */
async function upload(
  b: { app: ReturnType<typeof buildServer> },
  cookie: { sid: string },
  fields: { key?: string; alt?: string; folder?: string; title?: string; filename?: string },
  img?: Buffer,
) {
  const form = new FormData();
  if (fields.key !== undefined) form.append('key', fields.key);
  if (fields.alt !== undefined) form.append('alt', fields.alt);
  if (fields.folder !== undefined) form.append('folder', fields.folder);
  if (fields.title !== undefined) form.append('title', fields.title);
  form.append('file', img ?? (await jpeg()), { filename: fields.filename ?? 't.jpg', contentType: 'image/jpeg' });
  return injectAuthoring(b.app, { method: 'POST', url: '/upload', headers: { ...form.getHeaders() }, cookies: cookie, payload: form, });
}

describe('POST /upload', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await injectAuthoring(build().app, { method: 'POST', url: '/upload', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('400 for a non-image', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', Buffer.from('not an image'), { filename: 't.txt', contentType: 'text/plain' });
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/upload', headers: { ...form.getHeaders() }, cookies: cookie, payload: form, });
    expect(res.statusCode).toBe(400);
  });

  it('200 + snippet for a valid upload', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/bucharest-2024/hero');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/upload', headers: { ...form.getHeaders() }, cookies: cookie, payload: form, });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The key is content-hash versioned server-side (issue #26).
    expect(body.src).toMatch(/^https:\/\/img\.simonswanderlust\.com\/trips\/bucharest-2024\/hero-[0-9a-f]{8}$/);
    expect(body.snippet).toContain("alt: 'Old town'");
  });

  it('re-uploading a different image under the same key mints a new URL; the old URL keeps serving unchanged', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const first = await upload(b, cookie, { key: 'trips/t/hero', alt: 'a' });
    expect(first.statusCode).toBe(200);
    await b.settle();
    const oldFile = `${first.json().key}-640.webp`;
    const get = () => b.app.inject({ method: 'GET', url: '/' + oldFile, headers: { host: 'img.simonswanderlust.com' } });
    const before = await get();
    expect(before.statusCode).toBe(200);

    const other = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#a00' } }).jpeg().toBuffer();
    const second = await upload(b, cookie, { key: 'trips/t/hero', alt: 'a' }, other);
    expect(second.statusCode).toBe(200);
    expect(second.json().src).not.toBe(first.json().src);
    await b.settle();

    // Published posts reference the first URL — it must keep serving the same bytes.
    const after = await get();
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.equals(before.rawPayload)).toBe(true);
  });

  it('re-uploading identical bytes reuses the same URL and short-circuits (idempotent)', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const img = await jpeg();
    const first = await upload(b, cookie, { key: 'trips/same/hero', alt: 'a' }, img);
    expect(first.statusCode).toBe(200);
    await b.settle();
    const second = await upload(b, cookie, { key: 'trips/same/hero', alt: 'a' }, img);
    expect(second.statusCode).toBe(200);
    expect(second.json().src).toBe(first.json().src);
    // Already encoded: reported as a duplicate rather than re-encoded.
    expect(second.json()).toMatchObject({ duplicate: true, status: 'ready' });
  });

  // #135: the browser always sends the folder that is currently open, so a
  // second drop of the same camera export relocated a curated photo while
  // reporting `duplicate: true`.
  it('a duplicate upload never moves a curated photo, only fills an empty folder, and names where it lives', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const img = await jpeg();
    const first = await upload(b, cookie, { key: 'trips/dup/hero' }, img);
    const key = first.json().key as string;
    await markReady(b.media, key);
    // Still in the root: the drop target applies.
    const filled = await upload(b, cookie, { key: 'trips/dup/hero', folder: 'Iceland/South' }, img);
    expect(filled.json()).toMatchObject({ duplicate: true, folder: 'Iceland/South' });
    expect((await b.media.get(key))?.folder).toBe('Iceland/South');
    // Curated: the drop target is ignored and the stored folder reported.
    const kept = await upload(b, cookie, { key: 'trips/dup/hero', folder: 'Norway' }, img);
    expect(kept.json()).toMatchObject({ duplicate: true, folder: 'Iceland/South' });
    expect((await b.media.get(key))?.folder).toBe('Iceland/South');
    // Same while the first upload is still encoding — and the queued job is not
    // queued a second time (#348's re-enqueue covers only an absent key).
    await b.media.setStatus(key, 'processing');
    const busy = await upload(b, cookie, { key: 'trips/dup/hero', folder: 'Norway' }, img);
    expect(busy.json()).toMatchObject({ duplicate: true, status: 'processing', folder: 'Iceland/South' });
    expect(b.enqueued).toEqual([key]);
  });

  it('a failed duplicate metadata transaction never claims acceptance or the requested folder', async () => {
    const media = memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
    const failing: MediaStore = { ...media, patch: async () => { throw new Error('db down'); } };
    const b = build({ media: failing });
    const { cookie } = await authed(b);
    const img = await jpeg();
    const key = (await upload(b, cookie, { key: 'trips/dup/hero' }, img)).json().key as string;
    await markReady(media, key);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await upload(b, cookie, { key: 'trips/dup/hero', folder: 'Iceland/South' }, img);
      expect(res.statusCode).toBe(500);
      expect((await media.get(key))?.folder).toBe('');
    } finally { log.mockRestore(); }
  });

  it('serves stored variants with a long immutable cache header', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const up = await upload(b, cookie, { key: 'trips/cache/hero', alt: 'c' });
    expect(up.statusCode).toBe(200);
    await b.settle();
    const res = await b.app.inject({ method: 'GET', url: `/${up.json().key}-640.webp`, headers: { host: 'img.simonswanderlust.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('serves variants but not the untouched original on the public image host', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const up = await upload(b, cookie, { key: 'trips/private/hero', alt: 'p' });
    expect(up.statusCode).toBe(200);
    await b.settle();
    const key = up.json().key as string;
    // The original is written to disk (for the backup tar) even before encoding.
    expect(existsSync(join(dir, `${key}-orig.jpg`))).toBe(true);
    const img = { host: 'img.simonswanderlust.com' };
    // The lossy variant is public...
    const variant = await b.app.inject({ method: 'GET', url: `/${key}-640.webp`, headers: img });
    expect(variant.statusCode).toBe(200);
    expect(variant.headers['access-control-allow-origin']).toBe('*');
    // ...but the full-resolution original is not downloadable.
    expect((await b.app.inject({ method: 'GET', url: `/${key}-orig.jpg`, headers: img })).statusCode).toBe(404);
    // ...and neither is a crash-leftover temp of it (#118: storage.ts writes
    // `<final>.part-<hex>` then renames — the deny-list on `-orig.*` alone would serve it).
    await writeFile(join(dir, `${key}-orig.jpg.part-0a1b2c3d`), 'half an original with GPS');
    await writeFile(join(dir, `${key}-1280.webp.part-0a1b2c3d`), 'half a variant');
    expect((await b.app.inject({ method: 'GET', url: `/${key}-orig.jpg.part-0a1b2c3d`, headers: img })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'GET', url: `/${key}-1280.webp.part-0a1b2c3d`, headers: img })).statusCode).toBe(404);
    for (const suffix of ['-orig.jpg', '-orig.jpg.part-0a1b2c3d', '-1280.webp.part-0a1b2c3d']) {
      const privateBytes = readFileSync(join(dir, `${key}${suffix}`));
      for (const prefix of ['//', '/./', '/x/../', '/x/%2e%2e/']) {
        const url = `${prefix}${key}${suffix}`;
        const denied = await b.app.inject({ method: 'GET', url, headers: img });
        // Static 10 rejects ambiguous path syntax with 403 before allowedPath;
        // canonical private files still 404 above. Either refusal protects the
        // boundary, but a redirect, success or server error must never pass.
        expect([403, 404], url).toContain(denied.statusCode);
        expect(denied.rawPayload.includes(privateBytes), url).toBe(false);
      }
    }
  });

  it('returns immediately with status "processing" and enqueues the encode', async () => {
    // The whole point of the async path: the response is complete (src, real
    // orientation-corrected dimensions, snippet) before any variant exists.
    const b = build();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { key: 'trips/async/hero', alt: 'a' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processing', width: 1000, height: 800 });
    expect(b.enqueued).toEqual([res.json().key]);
    expect(await b.media.get(res.json().key)).toMatchObject({ status: 'processing' });
  });

  it('snapshots the profile, mints a new identity on change, and serves JPEG variants privately', async () => {
    const settings = fakeStore();
    const b = buildEncoding({ settings });
    const { cookie } = await authed(b);
    const image = await jpeg();
    const modern = await upload(b, cookie, { key: 'trips/profile/hero', alt: 'a' }, image);
    await b.settle();
    settings.update({ convertJpeg: false, webpQuality: 81, avifQuality: 61 });
    const jpegMode = await upload(b, cookie, { key: 'trips/profile/hero', alt: 'a' }, image);
    await b.settle();

    expect(jpegMode.json()).toMatchObject({ status: 'processing', format: 'jpeg' });
    expect(jpegMode.json().key).not.toBe(modern.json().key);
    expect(await b.media.get(jpegMode.json().key)).toMatchObject({
      status: 'ready', format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 81, avifQuality: 61 },
      thumbSrc: `${jpegMode.json().src}-640.jpeg`,
    });
    const host = { host: 'img.simonswanderlust.com' };
    expect((await b.app.inject({ url: `/${modern.json().key}-640.webp`, headers: host })).statusCode).toBe(200);
    expect((await b.app.inject({ url: `/${jpegMode.json().key}-640.jpeg`, headers: host })).statusCode).toBe(200);
    expect((await b.app.inject({ url: `/${jpegMode.json().key}-640.webp`, headers: host })).statusCode).toBe(404);
    expect((await b.app.inject({ url: `/${jpegMode.json().key}-orig.jpg`, headers: host })).statusCode).toBe(404);
  });

  it('keeps PNG uploads modern when JPEG conversion is off', async () => {
    const settings = fakeStore({ ...SETTINGS, convertJpeg: false });
    const b = buildEncoding({ settings });
    const { cookie } = await authed(b);
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#246' },
    }).png().toBuffer();
    const response = await upload(b, cookie, { key: 'trips/profile/png' }, png);
    await b.settle();
    expect(response.json()).not.toHaveProperty('format');
    expect(await b.media.get(response.json().key)).toMatchObject({
      status: 'ready',
      encoding: { convertJpeg: false, webpQuality: 75, avifQuality: 55 },
    });
    expect((await b.app.inject({
      url: `/${response.json().key}-640.webp`, headers: { host: 'img.simonswanderlust.com' },
    })).statusCode).toBe(200);
  });

  it('derives a storage key from the filename when the client sends none', async () => {
    // Bulk library upload has no post slug, and KEY_RE is lowercase-only — a
    // Leica's L1002345.JPG would otherwise be a 400.
    const b = build();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { filename: 'L1002345.JPG' });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toMatch(/^library\/\d{4}\/l1002345-[0-9a-f]{8}$/);
  });

  /**
   * #348: a REAL encode queue at its backlog limit — its one slot encoding and
   * its one backlog slot taken by two fillers, both parked behind a held
   * exclusive lock (a "build") — so the next enqueue is a genuine
   * BacklogFullError. `release()` lets the queue drain with real sharp encodes.
   * `wrap` decorates the store the ROUTES see; the queue writes the inner one.
   */
  async function buildFullQueue(wrap: (m: MediaStore) => MediaStore = (m) => m) {
    const inner = memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
    const lock = createWorkLock();
    const gate = Promise.withResolvers<void>();
    const held = lock.runExclusive(() => gate.promise);
    const queue = createEncodeQueue({ store: inner, storageDir: dir, lock, concurrency: 1, maxBacklog: 1, log: () => {} });
    const b = build({ media: wrap(inner), encodeQueue: queue });
    const { cookie } = await authed(b);
    for (const background of ['#a11', '#1a1']) {
      const filler = await sharp({ create: { width: 64, height: 48, channels: 3, background } }).jpeg().toBuffer();
      expect((await upload(b, cookie, { key: 'trips/filler/photo' }, filler)).statusCode).toBe(200);
    }
    expect(queue.stats()).toEqual({ pending: 1, running: 1 });
    const img = await jpeg();
    const key = contentHashKey('trips/full/hero', img, SETTINGS);
    const release = async () => { gate.resolve(); await held; await queue.idle(); };
    const retry = () => b.app.inject({ method: 'POST', url: '/media/retry', cookies: cookie, payload: { keys: [key] } });
    return { ...b, media: inner, queue, cookie, img, key, release, retry };
  }

  it('a 429 from a full backlog leaves a recoverable failed row, and a re-send after the drain encodes to ready', async () => {
    const b = await buildFullQueue();
    const form = { key: 'trips/full/hero', folder: 'Iceland', title: 'Glacier' };
    const res = await upload(b, b.cookie, form, b.img);
    expect(res.statusCode).toBe(429);
    // Not `processing` with nothing queued: retryable, deletable, and the
    // original plus the request's metadata are kept for the recovery.
    expect(await b.media.get(b.key)).toMatchObject({ status: 'failed', error: 'queue_full', folder: 'Iceland', title: 'Glacier' });
    expect(b.queue.isActive(b.key)).toBe(false);
    expect(existsSync(join(dir, `${b.key}-orig.jpg`))).toBe(true);

    // Still full: the client's retry (same form) is refused again — never a false success.
    expect((await upload(b, b.cookie, form, b.img)).statusCode).toBe(429);
    expect(await b.media.get(b.key)).toMatchObject({ status: 'failed', error: 'queue_full' });

    await b.release();
    const again = await upload(b, b.cookie, form, b.img);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ key: b.key, status: 'processing' });
    expect(again.json().duplicate).toBe(true);
    expect(b.queue.isActive(b.key)).toBe(true);
    await b.queue.idle();
    expect(await b.media.get(b.key)).toMatchObject({ status: 'ready', error: null, folder: 'Iceland', title: 'Glacier' });
    expect(existsSync(join(dir, `${b.key}-640.webp`))).toBe(true);
  });

  it.each([
    ['failed', 'encode_failed'],
    ['missing', null],
  ] as const)('a 429 re-send of a %s row restores its status and error; the re-send after the drain encodes it', async (status, error) => {
    const b = await buildFullQueue();
    expect((await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img)).statusCode).toBe(429);
    await b.media.setStatus(b.key, status, error ?? undefined);

    expect((await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img)).statusCode).toBe(429);
    expect(await b.media.get(b.key)).toMatchObject({ status, error });
    expect(b.queue.isActive(b.key)).toBe(false);

    await b.release();
    const again = await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBeUndefined();
    await b.queue.idle();
    expect(await b.media.get(b.key)).toMatchObject({ status: 'ready', error: null });
  });

  it('a stranded processing row the queue does not hold is settled on a refused re-send and enqueued on a later one', async () => {
    const b = await buildFullQueue();
    expect((await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img)).statusCode).toBe(429);
    // The state a pre-#348 429 (or a crash) left behind: `processing`, nothing
    // queued — here without even the original on disk.
    const strand = async () => {
      await b.media.setStatus(b.key, 'processing');
      await rm(join(dir, `${b.key}-orig.jpg`));
    };
    await strand();

    // Still full: an honest 429 that leaves no unqueued `processing` row; the
    // original is back, so the failed row is recoverable.
    expect((await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img)).statusCode).toBe(429);
    expect(await b.media.get(b.key)).toMatchObject({ status: 'failed', error: 'queue_full' });
    expect(b.queue.isActive(b.key)).toBe(false);
    expect(existsSync(join(dir, `${b.key}-orig.jpg`))).toBe(true);

    await b.release();
    await strand();
    const again = await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ key: b.key, status: 'processing', duplicate: true });
    expect(b.queue.isActive(b.key)).toBe(true);
    await b.queue.idle();
    expect(await b.media.get(b.key)).toMatchObject({ status: 'ready', error: null });
    expect(existsSync(join(dir, `${b.key}-orig.jpg`))).toBe(true);
  });

  it('POST /media/retry recovers a queue_full row once the backlog drains, and keeps it failed while full', async () => {
    const b = await buildFullQueue();
    expect((await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img)).statusCode).toBe(429);
    const full = await b.retry();
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ queued: 0 });
    expect(await b.media.get(b.key)).toMatchObject({ status: 'failed', error: 'queue_full' });

    await b.release();
    const res = await b.retry();
    expect(res.json()).toEqual({ ok: true, queued: 1 });
    await b.queue.idle();
    expect(await b.media.get(b.key)).toMatchObject({ status: 'ready', error: null });
  });

  it.each(['upload', 'retry'] as const)('a pending refusal rollback excludes same-key %s admission until the row is settled', async (entry) => {
    const reached = Promise.withResolvers<void>();
    const landing = Promise.withResolvers<void>();
    const b = await buildFullQueue((m) => ({
      ...m,
      setStatusIfProcessing: async (...args) => {
        reached.resolve();
        await landing.promise;
        return m.setStatusIfProcessing(...args);
      },
    }));
    const a = upload(b, b.cookie, { key: 'trips/full/hero', folder: 'Iceland/South', alt: 'Curated' }, b.img);
    await reached.promise;
    await b.release();
    // Hold the second encode: checking only after ready missed the original race.
    const encodeGate = Promise.withResolvers<void>();
    // Occupy the queue's next job via its store read without replacing the encoder.
    const get = b.media.get;
    const encoding = Promise.withResolvers<void>();
    b.media.get = async (key) => {
      const row = await get(key);
      if (key === b.key && b.queue.isActive(key)) {
        encoding.resolve();
        await encodeGate.promise;
      }
      return row;
    };
    const admission = Promise.withResolvers<void>();
    const withAdmission = b.queue.withAdmission;
    b.queue.withAdmission = (key, operation) => {
      admission.resolve();
      return withAdmission(key, operation);
    };
    const second = entry === 'upload'
      ? upload(b, b.cookie, { key: 'trips/full/hero', folder: 'Norway', alt: 'Replacement' }, b.img)
      : b.retry();
    await admission.promise;
    expect(b.queue.isActive(b.key)).toBe(false);
    expect(await get(b.key)).toMatchObject({ status: 'processing' });
    landing.resolve();
    expect((await a).statusCode).toBe(429);
    expect((await second).statusCode).toBe(200);
    await encoding.promise;
    expect(b.queue.isActive(b.key)).toBe(true);
    expect(await get(b.key)).toMatchObject({
      status: 'processing', error: null, folder: 'Iceland/South',
      alt: { de: 'Curated', en: 'Curated' },
    });
    // This is the exact persisted state a crash must recover.
    expect((await b.media.list({ status: 'processing' })).items.map((item) => item.key)).toContain(b.key);
    encodeGate.resolve();
    await b.queue.idle();
    expect(await get(b.key)).toMatchObject({ status: 'ready', error: null });
  });

  it('repeated queue-refused orphan uploads preserve curated metadata before and after admission', async () => {
    const b = await buildFullQueue();
    await upload(b, b.cookie, { key: 'trips/full/hero' }, b.img);
    await b.media.setStatus(b.key, 'processing');
    const curated = {
      folder: 'Iceland/South', title: 'Glacier',
      alt: { de: 'Gletscher', en: 'Glacier' },
      caption: { de: 'Am Morgen', en: 'At dawn' }, tags: ['ice'],
    };
    await b.media.patch(b.key, curated);
    const before = await b.media.get(b.key);
    const form = { key: 'trips/full/hero', folder: 'Norway', title: 'Replacement', alt: 'Replacement' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await upload(b, b.cookie, form, b.img)).statusCode).toBe(429);
      expect(await b.media.get(b.key)).toMatchObject({ ...curated, status: 'failed', error: 'queue_full' });
    }
    await b.release();
    const accepted = await upload(b, b.cookie, form, b.img);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ duplicate: true, folder: curated.folder, status: 'processing' });
    await b.queue.idle();
    expect(await b.media.get(b.key)).toMatchObject({
      ...curated, status: 'ready', error: null,
      encoding: before?.encoding, uploadedAt: before?.uploadedAt, uploadedBy: before?.uploadedBy,
    });
  });

  it('records EXIF-free uploads without lat/lng and stores the supplied folder/title', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { key: 'trips/meta/hero', title: 'Sunrise', folder: 'Island 2024', alt: 'A' });
    expect(res.statusCode).toBe(200);
    const item = await b.media.get(res.json().key);
    expect(item).toMatchObject({ title: 'Sunrise', folder: 'Island 2024', alt: { de: 'A', en: 'A' } });
    expect(item?.exif).toMatchObject({ lat: null, lng: null });
  });

  // #133: the store validated the folder in upsert(), AFTER storeOriginal, so
  // a bad folder was a 500 plus an orphan original that the next reconcile
  // adopted as an anonymous processing row.
  it('400s a bad folder BEFORE writing the original', async () => {
    const b = build();
    const { cookie } = await authed(b);
    for (const folder of ['trip/', 'a/../b', 'A\u0301lesund']) {
      const res = await upload(b, cookie, { key: 'trips/f/hero', folder });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/folder/);
    }
    expect(existsSync(join(dir, 'trips', 'f'))).toBe(false);
    expect(b.enqueued).toEqual([]);
  });

  it('400s a key too deep or too long for the filesystem instead of mkdir -p-ing it', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const deep = await upload(b, cookie, { key: Array.from({ length: 12 }, () => 'a').join('/') });
    expect(deep.statusCode).toBe(400);
    expect(existsSync(join(dir, 'a'))).toBe(false);
    const long = await upload(b, cookie, { key: 'a'.repeat(300) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).not.toContain('aaaaaaaaaa');
  });

  it('rejects a multi-file upload instead of silently keeping only the last', async () => {
    // @ai-context: the handler reassigns `buf` on every file part, so N files
    // meant N-1 were fully buffered into memory and then dropped, with the last
    // one stored under the single `key`. Silent data loss, not an unsupported
    // feature — and bulk upload makes multi-file requests an obvious attempt.
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/x/photo');
    form.append('alt', 'a');
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    form.append('file', await jpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/upload', headers: { ...form.getHeaders() }, cookies: cookie, payload: form, });
    // @fastify/multipart raises FST_FILES_LIMIT, typed 413 by createError, from
    // inside req.parts() — before the handler ever sees the second file. A
    // handler-level 400 is therefore unreachable by construction.
    expect(res.statusCode).toBe(413);
  });

  it('still accepts a single-file upload unchanged', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/x/photo');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/upload', headers: { ...form.getHeaders() }, cookies: cookie, payload: form, });
    expect(res.statusCode).toBe(200);
    expect(res.json().src).toMatch(
      /^https:\/\/img\.simonswanderlust\.com\/trips\/x\/photo-[0-9a-f]{8}$/,
    );
  });
});

describe('media library', () => {
  /** Upload + finish encoding, returning the stored (content-hashed) key. */
  async function put(
    b: ReturnType<typeof buildEncoding>, cookie: { sid: string }, key: string, img?: Buffer,
  ): Promise<{ src: string; storedKey: string }> {
    const res = await upload(b, cookie, { key, alt: 'a' }, img);
    expect(res.statusCode).toBe(200);
    await b.settle();
    return { src: res.json().src, storedKey: res.json().key };
  }

  const draftUsing = (src: string) => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'media-de', title: 'Mediennutzer', excerpt: 'e', country: 'X', heroImage: { src, width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'media-en', title: 'Media user', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/other', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('GET /media requires a session but NOT admin — the gallery picker needs authors', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/media' })).statusCode).toBe(401);
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'GET', url: '/media', cookies: author.cookie })).statusCode).toBe(200);
  });

  // @ai-warning: this is what makes the privilege drop from admin-only
  // GET /images to session-level GET /media safe. Assert the REDACTION, not
  // just the status code — handing every author photo GPS through a lower gate
  // would undo the Phase 0 privacy fix.
  it('redacts exif.lat/lng and uploadedBy for non-admins, and keeps them for admins', async () => {
    const media = memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
    const b = build({ media });
    const admin = await authed(b);
    await media.upsert({
      key: 'library/2025/geo', status: 'ready', width: 800, height: 600, origBytes: 1,
      uploadedBy: 'user-1',
      exif: { takenAt: new Date('2025-01-01T10:00:00Z'), camera: 'Leica Q2', lens: 'Summilux', lat: 63.4, lng: 10.4 },
    });
    const author = await authed(b, { isAdmin: false, username: 'author' });

    const asAdmin = (await b.app.inject({ method: 'GET', url: '/media', cookies: admin.cookie })).json();
    expect(asAdmin.items[0].exif).toMatchObject({ lat: 63.4, lng: 10.4, camera: 'Leica Q2' });
    expect(asAdmin.items[0].uploadedBy).toBe('user-1');

    const asAuthor = (await b.app.inject({ method: 'GET', url: '/media', cookies: author.cookie })).json();
    expect(asAuthor.items[0].exif).toMatchObject({ lat: null, lng: null });
    expect(asAuthor.items[0].uploadedBy).toBeNull();
    // Non-location metadata is still useful to an author and is NOT redacted.
    expect(asAuthor.items[0].exif.camera).toBe('Leica Q2');
  });

  it('GET /media/items/* redacts for non-admins too', async () => {
    const media = memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
    const b = build({ media });
    await media.upsert({
      key: 'library/2025/geo', status: 'ready', width: 8, height: 6, origBytes: 1, uploadedBy: 'u1',
      exif: { takenAt: null, camera: null, lens: null, lat: 1.5, lng: 2.5 },
    });
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const res = await b.app.inject({ method: 'GET', url: '/media/items/library/2025/geo', cookies: author.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().exif).toMatchObject({ lat: null, lng: null });
    expect(res.json().uploadedBy).toBeNull();
  });

  it('GET /media lists an uploaded key with a server-derived thumbnail and empty usedIn', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src, storedKey } = await put(b, cookie, 'trips/bucharest-2024/hero');
    const res = await b.app.inject({ method: 'GET', url: '/media', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0]).toMatchObject({
      key: storedKey, src, width: 1000, height: 800,
      thumbSrc: `${src}-640.webp`, status: 'ready', usedIn: [],
    });
  });

  it('GET /media reports usedIn when a post references the image', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src } = await put(b, cookie, 'trips/used/hero');
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    expect(created.statusCode).toBe(200);
    const res = await b.app.inject({ method: 'GET', url: '/media', cookies: cookie });
    expect(res.json().items[0].usedIn).toEqual([
      { kind: 'post', key: created.json().translationKey, title: 'Mediennutzer', published: false, working: true },
    ]);
  });

  it('PATCH /media/items/* edits metadata and is author-accessible', async () => {
    const b = buildEncoding();
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const { storedKey } = await put(b, author.cookie, 'trips/edit/hero');
    const before = (await b.app.inject({ method: 'GET', url: `/media/items/${storedKey}`, cookies: author.cookie })).json();
    const res = await b.app.inject({
      method: 'PATCH', url: `/media/items/${storedKey}`, cookies: author.cookie,
      headers: { 'content-type': 'application/json' },
      payload: { conditional: { version: 1,
        patch: { title: 'Sonnenaufgang', alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3' }, tags: ['island', 'island', ' '] },
        expect: { title: before.title, alt: before.alt, caption: { de: before.caption.de }, tags: before.tags },
      } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Sonnenaufgang', alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3' },
      tags: ['island'], conditionalVersion: 1, uploadedBy: null,
    });
  });

  it('GET and PATCH expose only the approved author impact keys and retain amended AC4 whole-item redaction', async () => {
    const b = build();
    const author = await authed(b, { isAdmin: false, username: 'impact-author' });
    const admin = await authed(b);
    const photo = await b.media.upsert({ key: 'impact', status: 'ready', width: 800, height: 600, origBytes: 1,
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'Before', en: 'Same' }, uploadedBy: 'private-user',
      exif: { takenAt: new Date('2025-01-01T10:00:00Z'), camera: 'Leica', lens: 'Summilux', lat: 1, lng: 2 } });
    for (let n = 0; n < 3; n++) {
      const input = draftUsing(photo.src);
      for (const locale of ['de', 'en'] as const) {
        input[locale].slug += '-' + n;
        input[locale].bodyMarkdown = `\`\`\`gallery\n${photo.src} | 800x600\n\`\`\``;
      }
      const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: author.cookie, payload: input });
      expect(created.statusCode).toBe(200);
      if (n < 2) await b.posts.publish(created.json().translationKey, await publishTokens(b.posts, created.json().translationKey));
    }
    const get = await b.app.inject({ method: 'GET', url: '/media/items/impact', cookies: author.cookie });
    const patch = await b.app.inject({ method: 'PATCH', url: '/media/items/impact', cookies: author.cookie,
      payload: { conditional: { version: 1, patch: { caption: { de: 'After', en: 'Same' } }, expect: { caption: { de: 'Before', en: 'Same' } } } } });
    for (const response of [get, patch]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(body).not.toHaveProperty('livePending');
      expect(body.uploadedBy).toBeNull();
      expect(body.exif).toEqual({ takenAt: '2025-01-01T10:00:00.000Z', camera: 'Leica', lens: 'Summilux', lat: null, lng: null });
      const impact = body.impact as MediaImpact;
      expect(Object.keys(impact).sort()).toEqual(['availability', 'drafts', 'newerDrafts', 'published']);
      if (impact.availability !== 'available') throw new Error('expected impact');
      expect(impact.published).toHaveLength(2); expect(impact.drafts).toHaveLength(1); expect(impact.newerDrafts).toEqual([]);
      for (const story of [...impact.published, ...impact.drafts]) {
        expect(Object.keys(story).sort()).toEqual(['locales', 'title', 'translationKey']);
        expect(Object.keys(story.locales).sort()).toEqual(['de', 'en']);
        for (const locale of ['de', 'en'] as const) {
          expect(Object.keys(story.locales[locale]).sort()).toEqual(['gallery', 'galleryCaptionFollowsLibrary', 'heroTitle', 'inline']);
          // draftUsing references this photo as DE hero, but a different EN hero.
          expect(story.locales[locale]).toEqual({ gallery: 1, galleryCaptionFollowsLibrary: 1, heroTitle: locale === 'de', inline: 0 });
        }
      }
    }
    expect(patch.json().conditionalVersion).toBe(1);
    expect(patch.json().changedDescriptions).toEqual({ de: { alt: false, caption: true }, en: { alt: false, caption: false } });
    expect((await b.app.inject({ method: 'GET', url: '/media/items/impact', cookies: admin.cookie })).json().livePending).toBeNull();
    expect((await b.app.inject({ method: 'GET', url: '/publication/summary', cookies: author.cookie })).statusCode).toBe(403);
  });

  it.each(['about', 'contact'])('keeps %s-only references in deletion guards but out of story impact', async (key) => {
    const b = build(); const { cookie } = await authed(b);
    const photo = await b.media.upsert({ key: 'about-only', status: 'ready', width: 800, height: 600, origBytes: 1,
      uploadedBy: null, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null } });
    const about = await b.pages.get(key);
    await b.pages.save({ ...about, de: { ...about.de, bodyMarkdown: `\`\`\`gallery\n${photo.src} | 800x600\n\`\`\`` } });
    const response = await b.app.inject({ method: 'GET', url: '/media/items/about-only', cookies: cookie });
    expect(response.json().impact).toEqual({ availability: 'available', published: [], drafts: [], newerDrafts: [] });
    expect(response.json().usedIn).toMatchObject([{ kind: 'page', key }]);
    expect((await b.app.inject({ method: 'DELETE', url: '/media/items/about-only', cookies: cookie })).statusCode).toBe(409);
  });

  it('preserves this write and its delta when optional enrichment fails or another writer lands', async () => {
    const s = stubBuilder(); const b = build({ builder: s.builder }); const { cookie } = await authed(b);
    await b.media.upsert({ key: 'impact', status: 'ready', width: 800, height: 600, origBytes: 1,
      uploadedBy: null, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null } });
    b.posts.mediaImpactCorpus = async () => {
      await b.media.patch('impact', { caption: { de: 'later writer', en: 'later EN' } });
      throw new Error('optional classification failed');
    };
    const response = await b.app.inject({ method: 'PATCH', url: '/media/items/impact', cookies: cookie,
      payload: { conditional: { version: 1, patch: { caption: { de: 'mine' } }, expect: { caption: { de: '' } } } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conditionalVersion: 1, caption: { de: 'mine', en: '' },
      changedDescriptions: { de: { alt: false, caption: true }, en: { alt: false, caption: false } },
      impact: { availability: 'unavailable' }, livePending: null });
    expect(Object.keys(response.json().impact)).toEqual(['availability']);
    expect((await b.media.get('impact'))?.caption).toEqual({ de: 'later writer', en: 'later EN' });
    expect(s.calls).toEqual([]);
  });

  it('refreshes same-release Media pending content, clears only captured descriptions, and never rebuilds on save', async () => {
    const builder = stubBuilder({ ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') });
    const b = build({ builder: builder.builder }); const { cookie } = await authed(b);
    const photo = await b.media.upsert({ key: 'pending', status: 'ready', width: 800, height: 600, origBytes: 1,
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'Before', en: 'English' }, uploadedBy: null,
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null } });
    const input = draftUsing(photo.src);
    for (const locale of ['de', 'en'] as const) input[locale].bodyMarkdown =
      `\`\`\`gallery\n${photo.src} | 800x600\n${photo.src} | 800x600 | caption-override=""\n\`\`\``;
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: input });
    const tk = created.json().translationKey as string;
    await b.posts.publish(tk, await publishTokens(b.posts, tk));
    const fact = (await b.posts.publicationFacts())[0]!;
    async function promote(stamp: string, caption: string) {
      const manifest: ReleaseManifestV1 = { schema: 1, stamp, posts: (['de', 'en'] as const).map((locale) => ({
        translationKey: tk, locale, slug: input[locale].slug, digest: fact.rowDigest[locale]!,
        gallery: [{ src: photo.src, alt: locale === 'de' ? 'DE' : 'EN', caption: locale === 'de' ? caption : 'English' },
          { src: photo.src, alt: locale === 'de' ? 'DE' : 'EN', caption: null }],
      })) };
      await mkdir(join(dir, 'site', 'manifests'), { recursive: true });
      await mkdir(join(dir, 'site', 'releases', stamp), { recursive: true });
      await writeFile(join(dir, 'site', 'manifests', `${stamp}.json`), JSON.stringify(manifest));
      await symlink(join('releases', stamp), join(dir, 'site', 'next'));
      await rename(join(dir, 'site', 'next'), join(dir, 'site', 'current'));
    }
    const get = async () => (await b.app.inject({ method: 'GET', url: '/media/items/pending', cookies: cookie })).json();
    const summary = async () => (await b.app.inject({ method: 'GET', url: '/publication/summary', cookies: cookie })).json();
    const patch = async (before: string, after: string) => b.app.inject({ method: 'PATCH', url: '/media/items/pending', cookies: cookie,
      payload: { conditional: { version: 1, patch: { caption: { de: after } }, expect: { caption: { de: before } } } } });
    await promote('1793000000000-1-0001', 'Before');
    expect((await get()).livePending.de.caption).toBe(false);
    expect((await patch('Before', '')).json().livePending).toEqual({ de: { alt: false, caption: true }, en: { alt: false, caption: false } });
    expect((await summary()).galleryDescriptions).toEqual({ photos: 1, stories: 1 });
    expect((await patch('', '')).json().changedDescriptions.de.caption).toBe(false);
    await patch('', 'Before');
    expect((await summary()).galleryDescriptions).toEqual({ photos: 0, stories: 0 });
    await patch('Before', 'Captured');
    expect(builder.calls).toEqual([]);
    expect((await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie })).json().ok).toBe(false);
    // A failed build leaves current unchanged; its optional status cannot clear content differences.
    expect((await get()).livePending.de.caption).toBe(true);
    await patch('Captured', 'After capture');
    await promote('1793000000001-1-0002', 'Captured');
    expect((await get()).livePending.de.caption).toBe(true);
    await promote('1793000000002-1-0003', 'After capture');
    expect((await get()).livePending.de.caption).toBe(false);
    expect((await summary()).galleryDescriptions).toEqual({ photos: 0, stories: 0 });
    expect(builder.calls).toEqual(['rebuild']);
  });

  it('conditional media writes reject malformed and legacy envelopes without changing metadata or folders', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const before = await b.media.upsert({
      key: 'conditional', status: 'ready', width: 8, height: 6, origBytes: 1, uploadedBy: null,
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null },
    });
    const valid = { version: 1, patch: { title: 'new' }, expect: { title: '' } };
    for (const payload of [
      {}, { title: 'legacy' }, { conditional: valid, title: 'legacy' },
      { conditional: { ...valid, version: 2 } },
      { conditional: { ...valid, extra: true } },
      { conditional: { version: 1, patch: { title: 'new' } } },
      { conditional: { ...valid, expect: {} } },
      { conditional: { ...valid, expect: { title: '', folder: '' } } },
      { conditional: { ...valid, patch: { alt: { de: 'new' } }, expect: { alt: { en: '' } } } },
      { conditional: { ...valid, patch: { title: 7 } } },
      { conditional: { ...valid, patch: { folder: 'New/Folder', status: 'ready' }, expect: { folder: '' } } },
      { conditional: { version: 1, patch: {}, expect: {} } },
    ]) {
      const response = await b.app.inject({ method: 'PATCH', url: '/media/items/conditional', cookies: cookie, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_media_conditional' });
      expect(await b.media.get('conditional')).toEqual(before);
      expect(await b.media.folders()).toEqual([]);
    }
  });

  it('conditional media conflict redacts current for authors, preserves admin visibility and distinguishes missing', async () => {
    const b = build();
    await b.media.upsert({
      key: 'conditional', title: 'stored', status: 'ready', width: 8, height: 6, origBytes: 1, uploadedBy: 'u1',
      exif: { takenAt: null, camera: null, lens: null, lat: 1.5, lng: 2.5 },
    });
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const admin = await authed(b);
    const payload = { conditional: { version: 1, patch: { title: 'mine', folder: 'New/Folder' }, expect: { title: 'old', folder: '' } } };
    for (const [cookies, isAdmin] of [[author.cookie, false], [admin.cookie, true]] as const) {
      const response = await b.app.inject({ method: 'PATCH', url: '/media/items/conditional', cookies, payload });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'media_changed', current: {
        title: 'stored', folder: '', uploadedBy: isAdmin ? 'u1' : null,
        exif: { lat: isAdmin ? 1.5 : null, lng: isAdmin ? 2.5 : null },
      } });
    }
    expect(await b.media.folders()).toEqual([]);
    expect((await b.app.inject({ method: 'PATCH', url: '/media/items/missing', cookies: author.cookie, payload })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'PATCH', url: '/media/items/conditional', payload })).statusCode).toBe(401);
  });

  it('DELETE /media/items/* is admin-only: 401 unauthenticated, 403 for authors', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'DELETE', url: '/media/items/trips/x/hero' })).statusCode).toBe(401);
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'DELETE', url: '/media/items/trips/x/hero', cookies: author.cookie })).statusCode).toBe(403);
  });

  it('DELETE /media/items/* rejects unsafe keys (traversal) with 400', async () => {
    const b = build();
    const { cookie } = await authed(b);
    // %2F-encoded traversal reaches the handler as '../evil' — assertSafeKey rejects it.
    for (const url of ['/media/items/..%2Fevil', '/media/items/Evil', '/media/items/a//b']) {
      const res = await b.app.inject({ method: 'DELETE', url, cookies: cookie });
      expect(res.statusCode).toBe(400);
    }
    // A raw ../ segment is normalized away by the router before matching: never our handler.
    const raw = await b.app.inject({ method: 'DELETE', url: '/media/items/../evil', cookies: cookie });
    expect(raw.statusCode).toBe(404);
  });

  it('DELETE /media/items/* 404s for an unknown key', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'DELETE', url: '/media/items/trips/ghost/hero', cookies: cookie });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /media/items/* refuses (409) while a post references the image, keeping the files', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src, storedKey } = await put(b, cookie, 'trips/keep/hero');
    await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    const res = await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().usedIn).toHaveLength(1);
    expect(existsSync(join(dir, `${storedKey}-640.webp`))).toBe(true);
  });

  it('DELETE /media/items/* still 409s for a stranded single-locale row (get() → null)', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src, storedKey } = await put(b, cookie, 'trips/stranded/hero');
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    expect(created.statusCode).toBe(200);
    // Simulate the pg half-pair: a crash between upsertDraft's two locale
    // INSERTs leaves a key that usageRows() sees but get() cannot pair.
    const deRow = (await b.posts.usageRows()).filter((r) => r.heroImage.src === src);
    expect(deRow).toHaveLength(1);
    b.posts.get = async () => null;
    b.posts.usageRows = async () => deRow;
    const res = await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().usedIn).toEqual([
      { kind: 'post', key: created.json().translationKey, title: 'Mediennutzer', published: false, working: true },
    ]);
  });

  // #115: the blog is built from published_snapshot, not the working copy. A
  // draft save that swaps the photo out leaves the live site (and every
  // rebuild until a republish) still rendering it — and deleteMedia removes
  // the original too, so nothing could ever re-encode it.
  it('DELETE /media/items/* 409s while the PUBLISHED version still renders the image after a draft swapped it out', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src, storedKey } = await put(b, cookie, 'trips/live/hero');
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    const tk = created.json().translationKey;
    await b.posts.publish(tk, await publishTokens(b.posts, tk));
    // The working copy now points at a different photo; the snapshot still has `src`.
    const swapped = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...draftUsing('https://i/replacement'), status: 'published' }, });
    expect(swapped.statusCode).toBe(200);
    expect((await b.posts.get(tk))?.de.heroImage.src).toBe('https://i/replacement');

    const res = await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/republish/);
    expect(res.json().usedIn).toEqual([{ kind: 'post', key: tk, title: 'Mediennutzer', published: true, working: false }]);
    expect(existsSync(join(dir, `${storedKey}-640.webp`))).toBe(true);

    // Republishing promotes the swap into the snapshot — now nothing serves it.
    await b.posts.publish(tk, await publishTokens(b.posts, tk));
    expect((await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie })).statusCode).toBe(200);
  });

  // #116: a running job holds the original in memory and writes its variants
  // under the key afterwards; the next rescan would resurrect the deleted
  // photo as a zombie `ready` row with no original.
  it('DELETE /media/items/* 409s while the photo is still encoding, then succeeds once it is ready', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { key: 'trips/race/hero', alt: 'a' });
    expect(res.statusCode).toBe(200);
    const storedKey = res.json().key as string;
    expect((await b.media.get(storedKey))?.status).toBe('processing');
    const early = await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/still being encoded/);
    await b.settle();
    expect((await b.media.get(storedKey))?.status).toBe('ready');
    expect(existsSync(join(dir, `${storedKey}-640.webp`))).toBe(true);
    expect((await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie })).statusCode).toBe(200);
    expect(existsSync(join(dir, `${storedKey}-640.webp`))).toBe(false);
  });

  it('DELETE /media/items/* also 409s on the queue signal alone (row no longer says processing)', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { key: 'trips/queued/hero', alt: 'a' });
    const storedKey = res.json().key as string;
    expect(b.enqueued).toContain(storedKey);
    // A status write that lands while the key is still queued must not open the window.
    await b.media.setStatus(storedKey, 'failed', 'encode_failed');
    expect((await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie })).statusCode).toBe(409);
  });

  it('DELETE /media/items/* unlinks all variants of exactly that key and drops the row', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const other = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
    const gone = await put(b, cookie, 'trips/x/hero');
    const kept = await put(b, cookie, 'trips/x/hero-b', other);
    const res = await b.app.inject({ method: 'DELETE', url: `/media/items/${gone.storedKey}`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    // 4 variants + the untouched -orig original are all removed.
    expect(res.json()).toEqual({ ok: true, deleted: 5 });
    expect(existsSync(join(dir, `${gone.storedKey}-640.webp`))).toBe(false);
    expect(existsSync(join(dir, `${kept.storedKey}-640.webp`))).toBe(true);
    const after = await b.app.inject({ method: 'GET', url: '/media', cookies: cookie });
    expect(after.json().items.map((m: { key: string }) => m.key)).toEqual([kept.storedKey]);
  });

  it('folder create is author-level; rename and delete are admin-only', async () => {
    const b = build();
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const create = await b.app.inject({
      method: 'POST', url: '/media/folders', cookies: author.cookie,
      headers: { 'content-type': 'application/json' }, payload: { path: 'Island 2024' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().folders).toContain('Island 2024');
    for (const call of [
      { method: 'PATCH' as const, payload: { from: 'Island 2024', to: 'Island' } },
      { method: 'DELETE' as const, payload: { path: 'Island 2024' } },
    ]) {
      const res = await b.app.inject({
        method: call.method, url: '/media/folders', cookies: author.cookie,
        headers: { 'content-type': 'application/json' }, payload: call.payload,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects an invalid folder path with 400 and a rename onto an existing folder with 409', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const post = async (payload: Record<string, unknown>) => b.app.inject({
      method: 'POST', url: '/media/folders', cookies: cookie,
      headers: { 'content-type': 'application/json' }, payload,
    });
    expect((await post({ path: 'a/../b' })).statusCode).toBe(400);
    expect((await post({ path: '%' })).statusCode).toBe(400);
    expect((await post({ path: 'a/b/c/d/e/f/g' })).statusCode).toBe(400);
    await post({ path: 'Iceland' });
    await post({ path: 'Norway' });
    const clash = await b.app.inject({
      method: 'PATCH', url: '/media/folders', cookies: cookie,
      headers: { 'content-type': 'application/json' }, payload: { from: 'Iceland', to: 'Norway' },
    });
    expect(clash.statusCode).toBe(409);
  });

  it('POST /media/rescan is admin-only and returns the reconcile report', async () => {
    const b = build({ reconciler: { run: async () => ({ scanned: 1, inserted: 0, altHarvested: 0, markedMissing: 0, demoted: 0, recovered: 1 }) } });
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'POST', url: '/media/rescan', cookies: author.cookie })).statusCode).toBe(403);
    const admin = await authed(b, { username: 'boss' });
    const res = await b.app.inject({ method: 'POST', url: '/media/rescan', cookies: admin.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scanned: 1, recovered: 1 });
  });
});

describe('buildServer config', () => {
  it('boots with a relative storageDir (resolves it to absolute)', async () => {
    const rel = relative(process.cwd(), dir);
    const srv = buildServer({ trustProxy: TEST_TRUST, storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', users: memoryUserStore(), sessions: memorySessionStore(), settings: fakeStore(), secrets: memorySecretsStore(), posts: memoryPostStore(), pages: memoryPageStore(), media: memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' }), encodeQueue: stubQueue().queue, imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'), builder: stubBuilder().builder, backupDir: dir + '/backup', dbBackup: stubBackup().backup, dbCheck: async () => {} });
    await expect(srv.ready()).resolves.toBeDefined();
    await srv.close();
  });

  it('sets an explicit request timeout instead of relying on Fastify\'s disabled default', () => {
    // @ai-context: requestTimeout bounds how long the server waits to fully
    // RECEIVE a request (headers + body), not how long a handler then spends
    // processing it. Fastify defaults it to 0 (disabled), overriding Node's
    // own 300s default, so without this a stalled request would never time
    // out at this layer — an explicit value closes that gap.
    // @ai-note: asserts on the underlying node http.Server, not
    // `app.initialConfig` — fastify's own .d.ts omits `requestTimeout` from
    // `initialConfig`'s type (a gap in the upstream types, not ours), while
    // `@types/node` correctly types `http.Server#requestTimeout` as a plain
    // `number`, so this needs no cast and asserts the field that actually
    // governs timeout enforcement.
    const b = build();
    expect(b.app.server.requestTimeout).toBe(120_000);
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
    expect(res.json()).toEqual({ ...SETTINGS, aiProviders: SETTINGS.aiProviders.map((p) => ({ ...p, hasApiKey: false })) });
  });

  it('POST /settings is admin-only: authors cannot mutate image conversion fields', async () => {
    const settings = fakeStore();
    const b = build({ settings });
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { convertJpeg: false, webpQuality: 1, avifQuality: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(settings.get()).toMatchObject({ convertJpeg: true, webpQuality: 75, avifQuality: 55 });
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

  // @ai-warning POST /settings has its OWN allow-list, separate from
  // settings.ts's known-key pick. A field missing from it is silently ignored by
  // the API while every unit test on settings.ts still passes, and tsc catches
  // neither. This test is that allow-list.
  it('POST /settings persists the WordPress-import pacing knobs', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { importDelayMs: 2500, importRetries: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ importDelayMs: 2500, importRetries: 1 });
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.json()).toMatchObject({ importDelayMs: 2500, importRetries: 1 });
  });

  it('POST /settings allow-list round-trips image conversion controls', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { convertJpeg: false, webpQuality: 83, avifQuality: 63 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ convertJpeg: false, webpQuality: 83, avifQuality: 63 });
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.json()).toMatchObject({ convertJpeg: false, webpQuality: 83, avifQuality: 63 });
  });

  it('POST /settings rejects malformed image conversion controls', async () => {
    const b = build();
    const { cookie } = await authed(b);
    for (const payload of [
      { convertJpeg: 'false' }, { webpQuality: 0 }, { webpQuality: 101 },
      { avifQuality: 0 }, { avifQuality: 101 }, { avifQuality: 55.5 },
    ]) {
      const res = await b.app.inject({
        method: 'POST', url: '/settings',
        headers: { 'content-type': 'application/json' }, cookies: cookie, payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('POST /settings 400 on out-of-range import pacing', async () => {
    const b = build();
    const { cookie } = await authed(b);
    for (const payload of [{ importDelayMs: 99999 }, { importRetries: 9 }]) {
      const res = await b.app.inject({
        method: 'POST', url: '/settings',
        headers: { 'content-type': 'application/json' }, cookies: cookie, payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
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

describe('GET /ai-config', () => {
  it('401 without auth', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/ai-config' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the LM config for a non-admin author (no backup fields)', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    const res = await b.app.inject({ method: 'GET', url: '/ai-config', cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      captionBaseUrl: 'http://localhost:1234/v1',
      lmModel: 'qwen/qwen3-vl-4b',
      captionTimeoutMs: 60000,
      captionMaxEdge: 768,
    });
    expect(body.captionPrompt).toBeTruthy();
    expect(body).not.toHaveProperty('backupSchedule');
    expect(body).not.toHaveProperty('backupRetention');
  });
});

/** A second provider beside the default local one; names stay unique per id. */
const remote = (id: string, kind: AiProviderKind = 'openrouter', baseUrl = 'https://openrouter.ai/api/v1'): AiProvider =>
  ({ id, name: `Remote ${id}`, kind, baseUrl });
function registry(providers: AiProvider[], extra: Partial<Settings> = {}): Settings {
  return { ...SETTINGS, aiProviders: [...SETTINGS.aiProviders, ...providers], ...extra };
}
const LOCAL_CAPTION = {
  lmModel: SETTINGS.lmModel, captionPrompt: SETTINGS.captionPrompt,
  captionTimeoutMs: SETTINGS.captionTimeoutMs, captionMaxEdge: SETTINGS.captionMaxEdge,
  captionMaxTokens: SETTINGS.captionMaxTokens,
  captionProvider: 'lm-studio', captionBaseUrl: 'http://localhost:1234/v1',
};
const NAME_ERROR = 'AI provider name must be 1–60 characters without control characters.';
const URL_ERROR = 'AI provider base URL must be an absolute HTTP(S) URL of at most 300 characters, without credentials, query, or fragment.';
const KEY_ERROR = 'API key must be a string without control characters, or null.';
const LOCAL_KEY_ERROR = 'Local LM Studio providers do not use an API key.';

describe('AI provider routes', () => {
  it('are admin-only (401 anonymous, 403 author) and every response is no-store', async () => {
    const b = build({ settings: fakeStore(registry([remote('remote')])) });
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const admin = await authed(b, { username: 'admin' });
    const routes = [
      { method: 'POST', url: '/ai-providers', payload: { name: 'New', kind: 'custom', baseUrl: 'https://new.example/v1' }, ok: 201 },
      { method: 'PUT', url: '/ai-providers/remote', payload: { name: 'Renamed' }, ok: 200 },
      { method: 'GET', url: '/ai-providers/remote/credential', payload: undefined, ok: 200 },
      { method: 'DELETE', url: '/ai-providers/remote', payload: undefined, ok: 200 },
    ] as const;
    for (const { method, url, payload } of routes) {
      const anonymous = await b.app.inject({ method, url, payload });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
      expect((await b.app.inject({ method, url, payload, cookies: author.cookie })).statusCode, `${method} ${url}`).toBe(403);
    }
    for (const { method, url, payload, ok } of routes) {
      const res = await b.app.inject({ method, url, payload, cookies: admin.cookie });
      expect(res.statusCode, `${method} ${url}`).toBe(ok);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    await b.app.close();
  });

  it('creates, edits and deletes a provider, with its key omitted, replaced and removed in its own slot', async () => {
    const secrets = memorySecretsStore();
    const settings = fakeStore();
    const b = build({ secrets, settings });
    const { cookie } = await authed(b);
    const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      b.app.inject({ method, url, cookies: cookie, payload });
    const created = await call('POST', '/ai-providers', {
      name: '  OpenRouter  ', kind: 'openrouter', baseUrl: ' https://openrouter.ai/api/v1 ', apiKey: 'fixture-first',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('fixture-first');
    expect(Object.keys(created.json()).sort()).toEqual(Object.keys(SETTINGS).sort());
    const view = created.json().aiProviders[1];
    expect(view).toEqual({
      id: expect.stringMatching(/^p-[0-9a-f]{8}$/), name: 'OpenRouter', kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true,
    });
    const url = `/ai-providers/${view.id as string}`;
    const slot = `ai_provider_key:${view.id as string}`;
    expect(await secrets.get(slot)).toBe('fixture-first');
    expect(settings.get().aiProviders).toHaveLength(2);

    const edited = await call('PUT', url, { name: 'OpenRouter main', baseUrl: 'https://openrouter.ai/api/v2', kind: 'openrouter' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().aiProviders[1]).toEqual({ ...view, name: 'OpenRouter main', baseUrl: 'https://openrouter.ai/api/v2' });
    expect(await secrets.get(slot)).toBe('fixture-first');
    expect((await call('PUT', url, { apiKey: 'fixture-replacement' })).statusCode).toBe(200);
    expect(await secrets.get(slot)).toBe('fixture-replacement');
    for (const apiKey of ['', null]) {
      await secrets.set(slot, 'fixture');
      const removed = await call('PUT', url, { apiKey });
      expect(removed.json().aiProviders[1].hasApiKey).toBe(false);
      expect(await secrets.has(slot)).toBe(false);
    }
    const settingsPage = await b.app.inject({ url: '/settings', cookies: cookie });
    expect(settingsPage.json().aiProviders[1]).toMatchObject({ id: view.id, hasApiKey: false });

    await secrets.set(slot, 'fixture-delete');
    const deleted = await call('DELETE', url);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).not.toContain('fixture-delete');
    expect(deleted.json().aiProviders.map((p: { id: string }) => p.id)).toEqual(['lm-studio']);
    expect(await secrets.has(slot)).toBe(false);
    expect((await call('DELETE', url)).statusCode).toBe(404);
    await b.app.close();
  });

  it('refuses invalid input with fixed messages before touching either store', async () => {
    const secrets = memorySecretsStore();
    await secrets.set('ai_provider_key:remote', 'original');
    const settings = fakeStore(registry([remote('remote')]));
    const b = build({ secrets, settings });
    const { cookie } = await authed(b);
    const before = settings.get();
    const cases: ['POST' | 'PUT', string, unknown, string][] = [
      ['POST', '/ai-providers', { name: 'Local 2', kind: 'lm-studio', baseUrl: 'http://localhost:1235/v1', apiKey: 'secret-fixture' }, LOCAL_KEY_ERROR],
      ['PUT', '/ai-providers/lm-studio', { apiKey: 'secret-fixture' }, LOCAL_KEY_ERROR],
      ['PUT', '/ai-providers/remote', { kind: 'deepseek' }, 'A provider\'s kind cannot change.'],
      ['PUT', '/ai-providers/remote', { apiKey: 42 }, KEY_ERROR],
      ['PUT', '/ai-providers/remote', { apiKey: ['secret-fixture'] }, KEY_ERROR],
      ['PUT', '/ai-providers/remote', { apiKey: 'header\r\nsecret-fixture' }, KEY_ERROR],
      ['PUT', '/ai-providers/remote', { name: 'local LM studio' }, 'AI provider names must be unique.'],
      ['PUT', '/ai-providers/remote', { name: 'x'.repeat(61) }, NAME_ERROR],
      ['PUT', '/ai-providers/remote', { baseUrl: 'https://user:secret-fixture@x.example/v1' }, URL_ERROR],
      ['POST', '/ai-providers', { name: 'X', kind: 'ollama', baseUrl: 'https://x.example/v1' }, 'AI provider kind must be lm-studio, openrouter, deepseek, or custom.'],
      ['POST', '/ai-providers', { name: 'tab\there', kind: 'custom', baseUrl: 'https://x.example/v1' }, NAME_ERROR],
      ['POST', '/ai-providers', { name: 'X', kind: 'custom', baseUrl: 'https://x.example/v1?key=secret-fixture' }, URL_ERROR],
      ['POST', '/ai-providers', { name: 'X', kind: 'custom', baseUrl: '' }, URL_ERROR],
      ['POST', '/ai-providers', [], 'AI provider must be a JSON object.'],
    ];
    for (const [method, url, payload, error] of cases) {
      const res = await b.app.inject({ method, url, cookies: cookie, payload: payload as Record<string, unknown> });
      expect(res.statusCode, `${method} ${url} ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json()).toEqual({ error });
      expect(res.body).not.toContain('secret-fixture');
    }
    expect(settings.get()).toEqual(before);
    expect(await secrets.get('ai_provider_key:remote')).toBe('original');
    expect(await secrets.has('ai_provider_key:lm-studio')).toBe(false);
    // Removing the (non-existent) key of a local provider is a no-op, not a store call.
    const remove = vi.spyOn(secrets, 'delete');
    expect((await injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/lm-studio', cookies: cookie, payload: { apiKey: null } })).statusCode).toBe(200);
    expect(remove).not.toHaveBeenCalled();
    await b.app.close();
  });

  it('caps the registry at 20 providers', async () => {
    const providers = Array.from({ length: 19 }, (_, i) => remote(`p-${i}`, 'custom', 'https://ai.example/v1'));
    const settings = fakeStore(registry(providers));
    const b = build({ settings });
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'POST', url: '/ai-providers', cookies: cookie, payload: { name: 'One more', kind: 'custom', baseUrl: 'https://x.example/v1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Configure between 1 and 20 AI providers.' });
    expect(settings.get().aiProviders).toHaveLength(20);
    await b.app.close();
  });

  it('answers 404 for an id that is not in the registry, before building any slot name', async () => {
    const secrets = memorySecretsStore();
    const calls = [vi.spyOn(secrets, 'get'), vi.spyOn(secrets, 'set'), vi.spyOn(secrets, 'delete'), vi.spyOn(secrets, 'has')];
    const b = build({ secrets, settings: fakeStore(registry([remote('remote')])) });
    const { cookie } = await authed(b);
    for (const id of ['gone', 'UPPER', 'a_b', 'x'.repeat(41), 'ai_provider_key:remote']) {
      for (const [method, suffix] of [['PUT', ''], ['DELETE', ''], ['GET', '/credential']] as const) {
        const res = await b.app.inject({ method, url: `/ai-providers/${encodeURIComponent(id)}${suffix}`, cookies: cookie, payload: method === 'PUT' ? { apiKey: 'fixture' } : undefined });
        expect(res.statusCode, `${method} ${id}${suffix}`).toBe(404);
        expect(res.json()).toEqual({ error: 'AI provider not found.' });
      }
    }
    for (const spy of calls) expect(spy).not.toHaveBeenCalled();
    await b.app.close();
  });

  it('refuses to delete the default or an assigned provider, naming the use cases', async () => {
    const secrets = memorySecretsStore();
    await secrets.set('ai_provider_key:b', 'keep-fixture');
    const settings = fakeStore(registry([remote('a'), remote('b', 'deepseek', 'https://api.deepseek.com/v1')], {
      aiDefaultProviderId: 'a', reviewProviderId: 'b', captionProviderId: 'b',
    }));
    const b = build({ secrets, settings });
    const { cookie } = await authed(b);
    const del = (id: string) => b.app.inject({ method: 'DELETE', url: `/ai-providers/${id}`, cookies: cookie });
    const isDefault = await del('a');
    expect(isDefault.statusCode).toBe(409);
    expect(isDefault.json()).toMatchObject({ code: 'provider_is_default', error: expect.any(String) });
    const inUse = await del('b');
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ code: 'provider_in_use', error: expect.any(String), useCases: ['review', 'caption'] });
    settings.update({ reviewProviderId: null });
    expect((await del('b')).json().useCases).toEqual(['caption']);
    expect(settings.get().aiProviders.map((p) => p.id)).toEqual(['lm-studio', 'a', 'b']);
    expect(await secrets.get('ai_provider_key:b')).toBe('keep-fixture');
    await b.app.close();
  });

  it('reports a committed key change when the settings write fails, then permits recovery', async () => {
    const settings = fakeStore(registry([remote('remote')]));
    const secrets = memorySecretsStore();
    let fail = true;
    const b = build({ secrets, settings: {
      get: settings.get,
      update(partial) { if (fail) throw new Error('disk fixture'); return settings.update(partial); },
    } });
    const { cookie } = await authed(b);
    const put = (payload: Record<string, unknown>) => injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/remote', cookies: cookie, payload });
    const partial = await put({ apiKey: 'new-fixture', baseUrl: 'https://other.example/v1' });
    expect(partial.statusCode).toBe(500);
    expect(partial.json()).toEqual({
      code: 'settings_partial_failure', error: 'API key change saved, but settings were not saved. Reload settings before retrying.',
    });
    expect(partial.body).not.toContain('new-fixture');
    expect(partial.body).not.toContain('disk fixture');
    expect(await secrets.get('ai_provider_key:remote')).toBe('new-fixture');
    expect(settings.get().aiProviders[1]!.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect((await put({ name: 'Other' })).json()).toEqual({
      code: 'settings_write_failed', error: 'Settings were not saved. Reload settings before retrying.',
    });
    const deleted = await b.app.inject({ method: 'DELETE', url: '/ai-providers/remote', cookies: cookie });
    expect(deleted.statusCode).toBe(500);
    expect(deleted.json()).toEqual({
      code: 'settings_partial_failure',
      error: 'The provider\'s API key was removed, but the provider was not deleted. Reload settings before retrying.',
    });
    expect(await secrets.has('ai_provider_key:remote')).toBe(false);
    expect(settings.get().aiProviders.map((p) => p.id)).toEqual(['lm-studio', 'remote']);
    fail = false;
    expect((await put({ baseUrl: 'https://other.example/v1' })).statusCode).toBe(200);
    await b.app.close();
  });

  it('credential returns a remote provider\'s stored key, null for local without a store call, 503 when unreadable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secrets = memorySecretsStore();
    await secrets.set('ai_provider_key:remote', 'fixture-remote');
    const get = vi.spyOn(secrets, 'get');
    const has = vi.spyOn(secrets, 'has');
    const b = build({ secrets, settings: fakeStore(registry([remote('remote'), remote('empty', 'deepseek', 'https://api.deepseek.com/v1')])) });
    try {
      const { cookie } = await authed(b);
      const credential = (id: string) => b.app.inject({ url: `/ai-providers/${id}/credential`, cookies: cookie });
      expect((await credential('lm-studio')).json()).toEqual({ apiKey: null });
      expect(get).not.toHaveBeenCalled();
      expect(has).not.toHaveBeenCalled();
      expect((await credential('remote')).json()).toEqual({ apiKey: 'fixture-remote' });
      expect(get).toHaveBeenCalledWith('ai_provider_key:remote');
      expect((await credential('empty')).json()).toEqual({ apiKey: null });
      secrets.get = async () => { throw new Error('DO-NOT-LEAK driver fixture'); };
      const failed = await credential('remote');
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ code: 'ai_secret_store_unavailable', error: 'AI credential storage is unavailable. Reload settings before retrying.' });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); await b.app.close(); }
  });
});

describe('AI credential boundaries', () => {
  it('POST /settings assigns use cases, refuses keys and provider lists, and ignores removed fields', async () => {
    const secrets = memorySecretsStore();
    const settings = fakeStore(registry([remote('remote')]));
    const b = build({ secrets, settings });
    const { cookie } = await authed(b);
    const save = (payload: Record<string, unknown>) => b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, payload });
    const before = settings.get();
    for (const [payload, error] of [
      [{ aiApiKey: 'fixture', aiModel: 'changed' }, 'API keys are managed per provider.'],
      [{ aiApiKey: null }, 'API keys are managed per provider.'],
      [{ aiProviders: [], aiModel: 'changed' }, 'Providers are managed with /ai-providers.'],
    ] as const) {
      const res = await save(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    for (const payload of [{ reviewProviderId: 'gone' }, { captionProviderId: 'Bad Id' }, { aiDefaultProviderId: null }, { reviewProviderId: '' }]) {
      expect((await save(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(settings.get()).toEqual(before);
    const saved = await save({
      aiDefaultProviderId: 'remote', reviewProviderId: null, captionProviderId: 'lm-studio',
      lmBaseUrl: 'http://ignored.example/v1', aiProvider: 'deepseek', captionCustomBaseUrl: 'https://ignored.example/v1',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toMatchObject({ aiDefaultProviderId: 'remote', reviewProviderId: null, captionProviderId: 'lm-studio' });
    expect(Object.keys(saved.json()).sort()).toEqual(Object.keys(SETTINGS).sort());
    expect(settings.get()).not.toHaveProperty('lmBaseUrl');
    expect(settings.get()).not.toHaveProperty('aiProvider');
    expect((await b.app.inject({ method: 'POST', url: '/settings', cookies: (await authed(b, { isAdmin: false, username: 'author' })).cookie, payload: { captionProviderId: 'remote' } })).statusCode).toBe(403);
    await b.app.close();
  });

  it('never returns a key from settings responses; only /ai-config and /credential carry one', async () => {
    const secrets = memorySecretsStore();
    await secrets.set('ai_provider_key:remote', 'fixture-key');
    const b = build({ secrets, settings: fakeStore(registry([remote('remote')], { reviewProviderId: 'remote' })) });
    const { cookie } = await authed(b);
    const page = await b.app.inject({ url: '/settings', cookies: cookie });
    expect(page.json().aiProviders).toEqual([
      { ...SETTINGS.aiProviders[0], hasApiKey: false }, { ...remote('remote'), hasApiKey: true },
    ]);
    expect(page.body).not.toContain('fixture-key');
    expect(page.headers['cache-control']).toBe('no-store');
    for (const res of [
      await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, payload: { aiModel: 'changed' } }),
      await injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/remote', cookies: cookie, payload: { name: 'Renamed' } }),
      await b.app.inject({ method: 'POST', url: '/ai-providers', cookies: cookie, payload: { name: 'Second', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-second' } }),
    ]) {
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).not.toContain('fixture-key');
      expect(res.body).not.toContain('fixture-second');
    }
    expect((await b.app.inject({ url: '/ai-config', cookies: cookie })).json().aiApiKey).toBe('fixture-key');
    expect((await b.app.inject({ url: '/ai-providers/remote/credential', cookies: cookie })).json().apiKey).toBe('fixture-key');
    await b.app.close();
  });

  it('never logs or returns raw secret failures; local captions stay available', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secrets = memorySecretsStore();
    secrets.get = async () => { throw new SecretsError('ai_secret_unavailable'); };
    secrets.set = async () => { throw new Error('DO-NOT-LEAK driver fixture'); };
    secrets.has = async () => { throw new Error('DO-NOT-LEAK row fixture'); };
    const settings = fakeStore(registry([remote('remote')], { reviewProviderId: 'remote' }));
    const b = build({ secrets, settings });
    try {
      const { cookie } = await authed(b);
      const before = settings.get();
      const page = await b.app.inject({ url: '/settings', cookies: cookie });
      expect(page.statusCode).toBe(503);
      expect(page.json().code).toBe('ai_secret_store_unavailable');
      const save = await injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/remote', cookies: cookie, payload: { apiKey: 'fixture', name: 'Changed' } });
      expect(save.statusCode).toBe(503);
      expect(save.body).not.toContain('DO-NOT-LEAK');
      expect(settings.get()).toEqual(before);
      const review = await b.app.inject({ url: '/ai-config', cookies: cookie });
      expect(review.statusCode).toBe(503);
      expect(review.json().code).toBe('ai_secret_unavailable');
      const caption = await b.app.inject({ url: '/ai-config?purpose=caption', cookies: cookie });
      expect(caption.statusCode).toBe(200);
      expect(caption.json()).toEqual({ ...LOCAL_CAPTION, captionApiKey: null });
      expect(caption.headers['cache-control']).toBe('no-store');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); await b.app.close(); }
  });

  it('resolves each use case to its own provider and key, keeping the consumer field sets unchanged', async () => {
    const secrets = memorySecretsStore();
    await secrets.set('ai_provider_key:review', 'fixture-review');
    await secrets.set('ai_provider_key:vision', 'fixture-vision');
    const settings = fakeStore(registry([
      remote('review', 'deepseek', 'https://api.deepseek.com/v1'), remote('vision', 'custom', 'https://vision.example/v1'),
    ], { aiDefaultProviderId: 'review', captionProviderId: 'vision' }));
    const b = build({ secrets, settings });
    const { cookie } = await authed(b, { isAdmin: false });
    const config = (query = '') => b.app.inject({ url: '/ai-config' + query, cookies: cookie });
    const review = {
      aiModel: SETTINGS.aiModel, reviewPrompt: SETTINGS.reviewPrompt, reviewTimeoutMs: SETTINGS.reviewTimeoutMs,
    };

    // Explicit caption assignment; review follows the default.
    const caption = await config('?purpose=caption');
    expect(caption.headers['cache-control']).toBe('no-store');
    expect(caption.json()).toEqual({
      ...LOCAL_CAPTION, captionProvider: 'custom', captionBaseUrl: 'https://vision.example/v1', captionApiKey: 'fixture-vision',
    });
    const full = await config();
    expect(full.json()).toEqual({
      ...LOCAL_CAPTION, captionProvider: 'custom', captionBaseUrl: 'https://vision.example/v1',
      aiProvider: 'deepseek', aiBaseUrl: 'https://api.deepseek.com/v1', ...review, hasAiApiKey: true, aiApiKey: 'fixture-review',
    });
    expect(full.body).not.toContain('fixture-vision');

    // Explicit local review; caption follows the (remote) default.
    settings.update({ reviewProviderId: 'lm-studio', captionProviderId: null });
    const get = vi.spyOn(secrets, 'get');
    expect((await config()).json()).toEqual({
      ...LOCAL_CAPTION, captionProvider: 'deepseek', captionBaseUrl: 'https://api.deepseek.com/v1',
      aiProvider: 'lm-studio', aiBaseUrl: 'http://localhost:1234/v1', ...review, hasAiApiKey: false, aiApiKey: null,
    });
    expect(get).not.toHaveBeenCalled();
    expect((await config('?purpose=caption')).json()).toMatchObject({ captionProvider: 'deepseek', captionApiKey: 'fixture-review' });
    expect(get).toHaveBeenCalledWith('ai_provider_key:review');

    // A remote provider without a stored key: null, never another provider's key.
    await secrets.delete('ai_provider_key:review');
    settings.update({ reviewProviderId: null });
    expect((await config('?purpose=caption')).json().captionApiKey).toBeNull();
    expect((await config()).json()).toMatchObject({ aiProvider: 'deepseek', hasAiApiKey: false, aiApiKey: null });

    secrets.get = async () => { throw new SecretsError('encryption_key_unconfigured'); };
    expect((await config()).json()).toEqual({ code: 'encryption_key_unconfigured', error: 'ENCRYPTION_KEY not configured in .env' });
    for (const query of ['?purpose=unknown', '?purpose=caption&purpose=review']) {
      expect((await config(query)).statusCode).toBe(400);
    }
    const anonymous = await b.app.inject({ url: '/ai-config?purpose=caption' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    await b.app.close();
  });

  it('a local photo provider never touches a throwing secrets store', async () => {
    const secrets = memorySecretsStore();
    secrets.get = async () => { throw new Error('DO-NOT-TOUCH'); };
    secrets.has = async () => { throw new Error('DO-NOT-TOUCH'); };
    const b = build({ secrets, settings: fakeStore(registry([remote('remote')], { aiDefaultProviderId: 'remote', captionProviderId: 'lm-studio' })) });
    const { cookie } = await authed(b, { isAdmin: false });
    const caption = await b.app.inject({ url: '/ai-config?purpose=caption', cookies: cookie });
    expect(caption.statusCode).toBe(200);
    expect(caption.json()).toEqual({ ...LOCAL_CAPTION, captionApiKey: null });
    const full = await b.app.inject({ url: '/ai-config', cookies: cookie });
    expect(full.statusCode).toBe(503);
    expect(full.body).not.toContain('DO-NOT-TOUCH');
    await b.app.close();
  });

  it('remote caption config waits for both key and destination to commit', async () => {
    const secrets = memorySecretsStore();
    const originalSet = secrets.set;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    secrets.set = async (key, value) => { entered.resolve(); await release.promise; await originalSet(key, value); };
    const b = build({ secrets, settings: fakeStore(registry([remote('vision', 'custom', 'https://vision.example/v1')], { captionProviderId: 'vision' })) });
    const { cookie } = await authed(b);
    const saving = injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/vision', cookies: cookie,
      payload: { apiKey: 'fixture-new', baseUrl: 'https://vision2.example/v1' } }).then((r) => r);
    await entered.promise;
    let resolved = false;
    const caption = b.app.inject({ url: '/ai-config?purpose=caption', cookies: cookie }).then((r) => { resolved = true; return r; });
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(resolved).toBe(false);
    release.resolve();
    expect((await saving).statusCode).toBe(200);
    expect((await caption).json()).toMatchObject({ captionBaseUrl: 'https://vision2.example/v1', captionApiKey: 'fixture-new' });
    await b.app.close();
  });

  it('keeps local captions responsive while full config waits for a credential mutation', async () => {
    const secrets = memorySecretsStore();
    const originalSet = secrets.set;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    secrets.set = async (key, value) => { entered.resolve(); await release.promise; await originalSet(key, value); };
    const b = build({ secrets, settings: fakeStore(registry([remote('remote', 'deepseek', 'https://api.deepseek.com/v1')], { reviewProviderId: 'remote' })) });
    const { cookie } = await authed(b);
    const saving = injectAuthoring(b.app, { method: 'PUT', url: '/ai-providers/remote', cookies: cookie, payload: { apiKey: 'fixture' } }).then((r) => r);
    await entered.promise;
    const config = b.app.inject({ url: '/ai-config', cookies: cookie }).then((r) => r);
    const caption = await b.app.inject({ url: '/ai-config?purpose=caption', cookies: cookie });
    expect(caption.statusCode).toBe(200);
    release.resolve();
    expect((await saving).statusCode).toBe(200);
    expect((await config).json()).toMatchObject({ aiProvider: 'deepseek', aiApiKey: 'fixture' });
    await b.app.close();
  });
});

describe('POST /settings (LM fields)', () => {
  it('admin can update LM fields', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmModel: 'my/vlm', captionMaxEdge: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lmModel: 'my/vlm', captionMaxEdge: 1024 });
  });

  it('400 on an assignment that names no provider', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { captionProviderId: 'gone' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 for a non-admin', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmModel: 'x' },
    });
    expect(res.statusCode).toBe(403);
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

describe('blog serving is DB-independent (#129)', () => {
  it('a cookie-bearing public request is served without a session lookup while Postgres is down', async () => {
    // The owner's admin cookie rides on every blog request of the same host.
    // Before #129 a global onRequest hook resolved it against Postgres, so a
    // DB outage 500'd the whole public site for exactly that browser.
    const down = memorySessionStore();
    down.find = async () => { throw new Error('pg: connection to db:5432 refused'); };
    await mkdir(join(dir, 'site', 'current', 'de'), { recursive: true });
    await writeFile(join(dir, 'site', 'current', 'de', 'index.html'), '<h1>de</h1>');
    await writeFile(join(dir, 'site', 'current', 'index.html'), '<!doctype html><html lang="de"><body>home</body></html>');
    const b = build({ sessions: down });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const publicRequests = [
        { url: '/de/', expected: 200 },
        { url: '/nope/', expected: 404 },                                        // blog 404 page
        { url: '/feed/', expected: 301 },                                        // legacy redirect
        { url: '/admin/index.html', expected: 200 },                             // admin shell, static
        { url: '/x-640.avif', expected: 404, host: 'img.simonswanderlust.com' }, // image host
      ];
      for (const { url, expected, host } of publicRequests) {
        const res = await b.app.inject({ method: 'GET', url, cookies: { sid: 'admin-cookie' }, ...(host ? { headers: { host } } : {}) });
        expect(res.statusCode, url).toBe(expected);
      }
      expect(spy).not.toHaveBeenCalled();
      // The CMS on the same server is honestly down: the session cannot be
      // checked, so these fail (sanitized), rather than pretending "logged out".
      for (const url of ['/auth/status', '/auth/me', '/posts']) {
        const res = await b.app.inject({ method: 'GET', url, cookies: { sid: 'admin-cookie' } });
        expect(res.statusCode, url).toBe(500);
        expect(res.json()).toEqual({ error: 'internal server error' });
        if (url === '/auth/me') expect(res.headers['cache-control']).toBe('no-store');
      }
      // Anonymous callers of the CMS surface never needed the store.
      expect((await b.app.inject({ method: 'GET', url: '/auth/status' })).json()).toMatchObject({ authenticated: false });
      expect((await b.app.inject({ method: 'GET', url: '/posts' })).statusCode).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('auth endpoints', () => {
  it.each([true, false])('GET /auth/me returns only the authenticated context, admin=%s', async (isAdmin) => {
    const b = build();
    const { user, cookie } = await authed(b, { isAdmin });
    const res = await b.app.inject({ url: '/auth/me', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toEqual({ authenticated: true, userId: user.id, username: user.username, isAdmin, needsSetup: false });
    // The public setup/login probe keeps its exact existing shape.
    expect((await b.app.inject({ url: '/auth/status', cookies: cookie })).json()).toEqual({
      authenticated: true, username: user.username, isAdmin, needsSetup: false,
    });
  });

  it('GET /auth/me refuses anonymous, invalid and revoked sessions without setup information', async () => {
    const b = build();
    for (const cookies of [undefined, { sid: 'unknown-session' }]) {
      const res = await b.app.inject({ url: '/auth/me', cookies });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await b.app.inject({ url: '/auth/status' })).json()).toEqual({ authenticated: false, needsSetup: true });
    const { cookie } = await authed(b);
    await b.app.inject({ method: 'POST', url: '/logout', cookies: cookie });
    const res = await b.app.inject({ url: '/auth/me', cookies: cookie });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await b.app.inject({ url: '/auth/status' })).json()).toEqual({ authenticated: false, needsSetup: false });
  });

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
      payload: { username: 'simon', password: 'password123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'simon', isAdmin: true });
    expect(res.headers['set-cookie']).toMatch(/sid=/);
    const again = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'x', password: 'password123456' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('POST /setup rejects passwords shorter than 12 characters (400)', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'simon', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/between 12 and 1024 characters/);
  });

  it('POST /login succeeds with correct creds, generic 401 otherwise', async () => {
    const b = build();
    await b.users.create({ username: 'simon', password: 'password123456', isAdmin: false });
    const ok = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'Simon', password: 'password123456' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/sid=/);
    const wrong = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'ghost', password: 'password123456' } });
    expect(unknown.statusCode).toBe(401);
    const oversized = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'a'.repeat(1025) } });
    expect(oversized.statusCode).toBe(401);
  });

  // Login attempts with a proxy-appended client address, so one test can play
  // several sources (an immediate trusted loopback peer preserves the RIGHTMOST entry).
  const loginFrom = (b: Built, ip: string, payload: Record<string, unknown>) => b.app.inject({
    method: 'POST', url: '/login',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload,
  });

  it('one address cannot lock an account out: 9 failures from A, then the owner logs in from B (#109)', async () => {
    // Production limits: 10 requests / IP and 100 failures / account. The old
    // 5-failure account lock let any unauthenticated client lock the admin
    // out every 15 minutes with 5 requests — this fails on that design.
    const b = build();
    await b.users.create({ username: 'simon', password: 'password123456', isAdmin: true });
    for (let i = 0; i < 9; i++) {
      expect((await loginFrom(b, '198.51.100.7', { username: 'simon', password: 'wrongpassword' })).statusCode).toBe(401);
    }
    const owner = await loginFrom(b, '203.0.113.9', { username: 'simon', password: 'password123456' });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['set-cookie']).toMatch(/sid=/);
  }, 30_000);

  it('failures spread over many addresses still exhaust the account budget (429, even with the right password)', async () => {
    // The per-IP limiter never sees a distributed guess; the account budget must.
    const b = build({ accountLimiter: accountLockoutLimiter({ max: 3 }) });
    await b.users.create({ username: 'simon', password: 'password123456', isAdmin: false });
    for (let i = 0; i < 3; i++) {
      expect((await loginFrom(b, `203.0.113.${i + 1}`, { username: 'simon', password: 'wrongpassword' })).statusCode).toBe(401);
    }
    const locked = await loginFrom(b, '203.0.113.99', { username: 'simon', password: 'password123456' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/account is temporarily locked/);
  });

  it('an account created before the 64-char cap still signs in and is still lockable (#109 review)', async () => {
    // The cap applies to NEW usernames only (#131 makes both stores' `create`
    // refuse one), so a long name can only exist as a row in an older
    // database. Model exactly that: a store whose lookup answers with the
    // legacy row. It must not become unreachable.
    const username = 'veteran-'.repeat(12); // 96 chars
    const legacy: User = { id: randomUUID(), username, passwordHash: hashPassword('password123456'), isAdmin: true, createdAt: new Date() };
    const inner = memoryUserStore();
    const users: UserStore = { ...inner, findByUsername: async (name) => (name.toLowerCase() === username ? legacy : inner.findByUsername(name)), findById: async (id) => (id === legacy.id ? legacy : inner.findById(id)) };
    const b = build({ users, accountLimiter: accountLockoutLimiter({ max: 2 }) });
    expect((await loginFrom(b, '203.0.113.1', { username, password: 'password123456' })).statusCode).toBe(200);
    expect((await loginFrom(b, '203.0.113.2', { username, password: 'wrongpassword' })).statusCode).toBe(401);
    expect((await loginFrom(b, '203.0.113.3', { username, password: 'wrongpassword' })).statusCode).toBe(401);
    expect((await loginFrom(b, '203.0.113.4', { username, password: 'password123456' })).statusCode).toBe(429);
  });

  it('POST /setup and POST /users reject a username outside the allow-list or longer than 64 characters (400)', async () => {
    const b = build();
    const setup = await b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: 'u'.repeat(65), password: 'password123456' } });
    expect(setup.statusCode).toBe(400);
    expect(setup.json().error).toMatch(/between 1 and 64 characters/);
    const markup = await b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: '<img src=x onerror=alert(1)>', password: 'password123456' } });
    expect(markup.statusCode).toBe(400);
    expect(markup.json().error).toMatch(/may only contain/);
    expect(await b.users.count()).toBe(0);
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    for (const username of ['u'.repeat(65), 'si mon', 'simon@example.com']) {
      const add = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username, password: 'password123456' } });
      expect(add.statusCode).toBe(400);
    }
    expect(await b.users.count()).toBe(1);
    const ok = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'co.author-2', password: 'password123456' } });
    expect(ok.statusCode).toBe(200);
  });

  it('GET /login serves a real form so Enter submits (keyboard-only sign-in)', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    // A bare input + a click handler on the button leaves Enter dead; the fields
    // must live in a <form> with a submit button and an intercepted submit event.
    expect(res.body).toMatch(/<form[^>]*id="login-form"/);
    expect(res.body).toMatch(/<button[^>]*type="submit"/);
    expect(res.body).toContain("$('login-form').addEventListener('submit'");
    expect(res.body).toContain('event.preventDefault()');
    expect(res.body).not.toContain("$('submit').addEventListener('click'");
    // …without losing the setup-vs-login mode or the ?next= return URL
    expect(res.body).toContain("needsSetup ? '/setup' : '/login'");
    expect(res.body).toContain('DraftGuard.safeNextPath(');
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
    await b.users.create({ username: 'simon', password: 'password123456', isAdmin: false });
    const login = () => b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(429); // 3rd attempt blocked
  });

  it('per-IP limiter keys on the proxy-appended address, not a client-supplied X-Forwarded-For entry', async () => {
    // Even when the client supplies a leftmost entry, only the immediate
    // allow-listed gateway is trusted; the rightmost client gets the bucket.
    const b = build({ trustProxy: GATEWAY_TRUST, loginLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    await b.users.create({ username: 'simon', password: 'password123456', isAdmin: false });
    const login = (xff: string) => b.app.inject({
      method: 'POST', url: '/login', remoteAddress: '172.18.0.1',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      payload: { username: 'simon', password: 'bad' },
    });
    expect((await login('10.0.0.1, 198.51.100.7')).statusCode).toBe(401);
    // Different leftmost entry, same rightmost: same bucket → limited.
    expect((await login('10.0.0.2, 198.51.100.7')).statusCode).toBe(429);
    // A different proxy-appended client gets its own bucket.
    expect((await login('10.0.0.3, 203.0.113.9')).statusCode).toBe(401);
  });

  it('ignores rotating forwarded addresses from a co-tenant container', async () => {
    const b = build({ trustProxy: GATEWAY_TRUST, loginLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    const login = (xff: string) => b.app.inject({
      method: 'POST', url: '/login', remoteAddress: '172.18.0.3',
      headers: { 'x-forwarded-for': xff },
      payload: { username: 'missing', password: 'wrongpassword' },
    });
    expect((await login('198.51.100.7')).statusCode).toBe(401);
    expect((await login('203.0.113.9')).statusCode).toBe(429);
  });

  it('stops after one hop even when the rightmost forwarded address is itself trusted', async () => {
    const b = build({ trustProxy: GATEWAY_TRUST, loginLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    const first = await b.app.inject({
      method: 'POST', url: '/login', remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9, 172.18.0.1' },
      payload: { username: 'missing', password: 'wrongpassword' },
    });
    expect(first.statusCode).toBe(401);
    const direct = await b.app.inject({
      method: 'POST', url: '/login', remoteAddress: '172.18.0.1',
      payload: { username: 'missing', password: 'wrongpassword' },
    });
    expect(direct.statusCode).toBe(429);
  });

  it.each([
    { peer: '172.18.0.1', proto: 'https', secure: true },
    { peer: '172.18.0.1', proto: undefined, secure: false },
    { peer: '172.18.0.3', proto: 'https', secure: false },
  ])('sets Secure on setup and login only for a trusted HTTPS proxy ($peer, $proto)', async ({ peer, proto, secure }) => {
    const b = build({ trustProxy: GATEWAY_TRUST });
    const payload = { username: 'proxy-admin', password: 'password123456' };
    for (const url of ['/setup', '/login']) {
      const response = await b.app.inject({
        method: 'POST', url, remoteAddress: peer,
        headers: proto ? { 'x-forwarded-proto': proto } : {},
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toMatch(/sid=/);
      expect(/;\s*Secure(?:;|$)/i.test(String(response.headers['set-cookie']))).toBe(secure);
    }
  });

  it('locked account is refused before password verification (no scrypt for a locked account)', async () => {
    // The stored hash is observed through a counting getter: verifyPassword can
    // only run if the handler read it, so zero reads on the locked attempt proves
    // the 429 fired before any scrypt work (#108).
    const inner = memoryUserStore();
    await inner.create({ username: 'simon', password: 'password123456', isAdmin: false });
    let hashReads = 0;
    const users: UserStore = {
      ...inner,
      async findByUsername(username) {
        const u = await inner.findByUsername(username);
        if (!u) return null;
        return { ...u, get passwordHash() { hashReads++; return u.passwordHash; } };
      },
    };
    const b = build({ users, accountLimiter: accountLockoutLimiter({ max: 5 }) });
    const login = () => b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    for (let i = 0; i < 5; i++) expect((await login()).statusCode).toBe(401);
    expect(hashReads).toBe(5);
    hashReads = 0;
    const locked = await login();
    expect(locked.statusCode).toBe(429);
    expect(hashReads).toBe(0);
  });

  it('serializes concurrent /setup so only one admin is created (no TOCTOU)', async () => {
    const b = build();
    const [a, c] = await Promise.all([
      b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: 'first', password: 'password123456' } }),
      b.app.inject({ method: 'POST', url: '/setup', headers: { 'content-type': 'application/json' }, payload: { username: 'second', password: 'password123456' } }),
    ]);
    const codes = [a.statusCode, c.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(await b.users.count()).toBe(1);
  });
});

describe('security headers', () => {
  // The admin headers are derived from the matched route (#130): every route
  // that is not one of the public static mounts gets them, so a new admin or
  // API route can no longer ship without them because a prefix list was not
  // updated. Before #130, /api/* was exactly that gap.
  const ADMIN_URLS = ['/auth/status', '/auth/me', '/api/cms/stats', '/api/categories', '/admin/', '/login', '/health', '/media', '/posts/no-such-post'];
  it.each(ADMIN_URLS)('%s carries nosniff + frame + referrer protection', async (url) => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url, cookies: cookie });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('the public blog, its 404 page, legacy redirects and the image host get nosniff only', async () => {
    await mkdir(join(dir, 'site', 'current', 'de'), { recursive: true });
    await writeFile(join(dir, 'site', 'current', 'de', 'index.html'), '<h1>de</h1>');
    await writeFile(join(dir, 'site', 'current', 'index.html'), '<!doctype html><html lang="de"><body>home</body></html>');
    await mkdir(join(dir, 'map'), { recursive: true });
    await writeFile(join(dir, 'map', 'tiles.pmtiles'), 'x');
    const b = build({ mapDir: join(dir, 'map') });
    const publicRequests = [
      { url: '/de/', expected: 200 },                                          // served release page
      { url: '/nope/', expected: 404 },                                        // blog 404 page (setNotFoundHandler)
      { url: '/feed/', expected: 301 },                                        // legacy WordPress redirect
      { url: '/map/tiles.pmtiles', expected: 200 },                            // basemap mount
      { url: '/x-640.avif', expected: 404, host: 'img.simonswanderlust.com' }, // image host miss
    ];
    for (const { url, expected, host } of publicRequests) {
      const res = await b.app.inject({ method: 'GET', url, ...(host ? { headers: { host } } : {}) });
      expect(res.statusCode, url).toBe(expected);
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBeUndefined();
      expect(res.headers['referrer-policy'], url).toBeUndefined();
    }
  });
});

describe('GET /api/cms/stats', () => {
  it('mediaCount is the whole library, not the first page (#130)', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    for (let i = 0; i < 61; i++) {
      await b.media.upsert({ key: `library/p${i}`, status: 'ready', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    }
    const res = await b.app.inject({ method: 'GET', url: '/api/cms/stats', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mediaCount: 61, totalPosts: 0 });
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
    const add = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'password123456', isAdmin: false } });
    expect(add.statusCode).toBe(200);
    const list = await b.app.inject({ method: 'GET', url: '/users', cookies: cookie });
    expect(list.json().map((u: { username: string }) => u.username)).toContain('bob');
    const bobId = list.json().find((u: { username: string; id: string }) => u.username === 'bob').id;
    expect((await b.app.inject({ method: 'DELETE', url: `/users/${bobId}`, cookies: cookie })).statusCode).toBe(200);
  });

  it('rejects deleting yourself and the last admin', async () => {
    const b = build();
    const me = await b.users.create({ username: 'admin', password: 'password123456', isAdmin: true });
    const token = await b.sessions.create(me.id, 60_000);
    const res = await b.app.inject({ method: 'DELETE', url: `/users/${me.id}`, cookies: { sid: token } });
    expect(res.statusCode).toBe(409);
  });

  it('POST /users 409 on duplicate username', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'password123456', isAdmin: false } });
    const dup = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'BOB', password: 'password123456', isAdmin: false } });
    expect(dup.statusCode).toBe(409);
  });
});

describe('POST /users/me/password (change password)', () => {
  const change = (b: Built, cookie: Record<string, string> | undefined, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/users/me/password', headers: { 'content-type': 'application/json' }, ...(cookie ? { cookies: cookie } : {}), payload });

  it('401 unauthenticated', async () => {
    const res = await change(build(), undefined, { currentPassword: 'password123456', newPassword: 'new-password-123' });
    expect(res.statusCode).toBe(401);
  });

  it('400 when a field is missing or empty', async () => {
    const b = build();
    const { cookie } = await authed(b);
    expect((await change(b, cookie, { newPassword: 'new-password-123' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'password123456', newPassword: '' })).statusCode).toBe(400);
    const short = await change(b, cookie, { currentPassword: 'password123456', newPassword: 'short' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/new password must be between 12 and 1024 characters/);
  });

  it('400 (not 401 — admin JS redirects on 401) on a wrong current password', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-password-123' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('current password is incorrect');
  });

  it('changes the password, invalidates other sessions, keeps the caller logged in', async () => {
    const b = build();
    const { user, cookie } = await authed(b); // password 'password123456'
    const otherToken = await b.sessions.create(user.id, 60_000);
    const res = await change(b, cookie, { currentPassword: 'password123456', newPassword: 'brand-new-password123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Old password no longer logs in; the new one does.
    const login = (password: string) =>
      b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: user.username, password } });
    expect((await login('password123456')).statusCode).toBe(401);
    expect((await login('brand-new-password123')).statusCode).toBe(200);
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
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-password-123' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-password-123' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-password-123' })).statusCode).toBe(429);
  });

  it('limitAuth runs before requireAuth: unauthenticated requests consume the limiter too', async () => {
    // First unauthenticated hit passes the limiter (consuming its one slot) and
    // fails auth with 401; the second is cut off by the limiter with 429. This
    // pins the preHandler order the brute-force defense relies on.
    const b = build({ loginLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    expect((await change(b, undefined, { currentPassword: 'x', newPassword: 'y' })).statusCode).toBe(401);
    expect((await change(b, undefined, { currentPassword: 'x', newPassword: 'y' })).statusCode).toBe(429);
  });

  it('locks the account after 5 wrong current passwords (429), independent of the per-IP limiter', async () => {
    // The per-IP bucket is wide open here, so only the per-account limiter can
    // produce the 429 — a hijacked session spread across many addresses is
    // still bounded (#108).
    const b = build({ loginLimiter: fixedWindowLimiter({ max: 100, windowMs: 60_000 }) });
    const { cookie } = await authed(b, { username: 'simon' });
    const wrong = { currentPassword: 'wrong', newPassword: 'new-password-123' };
    for (let i = 0; i < 5; i++) expect((await change(b, cookie, wrong)).statusCode).toBe(400);
    const sixth = await change(b, cookie, wrong);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too many failed attempts, please wait and try again');
    // Still locked for the CORRECT password while the lock holds.
    expect((await change(b, cookie, { currentPassword: 'password123456', newPassword: 'new-password-123' })).statusCode).toBe(429);
    // A second user is unaffected.
    const other = await authed(b, { username: 'bob' });
    expect((await change(b, other.cookie, { currentPassword: 'password123456', newPassword: 'new-password-123' })).statusCode).toBe(200);
  });
});

describe('POST /posts/bulk', () => {
  const sample = (slug: string) => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: `de-${slug}`, title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: `en-${slug}`, title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  const create = async (b: Built, cookie: { sid: string }, slug: string): Promise<string> => {
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample(slug) });
    return res.json().translationKey;
  };
  const bulk = async (b: Built, cookie: { sid: string } | undefined, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/posts/bulk', headers: { 'content-type': 'application/json' }, ...(cookie ? { cookies: cookie } : {}), payload: { ...(payload.action === 'publish' ? { baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() } : {}), ...payload } });

  it('is admin-only: 401 anonymous, 403 for a non-admin author', async () => {
    const b = build();
    const anonymous = await bulk(b, undefined, { action: 'publish', keys: ['x'] });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const forbidden = await bulk(b, cookie, { action: 'publish', keys: ['x'] });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['cache-control']).toBe('no-store');
  });

  it('rejects an unknown action, a non-array keys, an empty selection and an oversize batch', async () => {
    const b = build(); const { cookie } = await authed(b);
    expect((await bulk(b, cookie, { action: 'drop-table', keys: ['x'] })).statusCode).toBe(400);
    expect((await bulk(b, cookie, { action: 'publish', keys: 'x' })).statusCode).toBe(400);
    expect((await bulk(b, cookie, { action: 'publish', keys: [] })).statusCode).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `k${i}`);
    const tooMany = await bulk(b, cookie, { action: 'publish', keys: many });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/at most 100/);
  });

  it('publishes several posts with ONE rebuild and writes an MDX backup for each', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder, backupDir: join(dir, 'backup') });
    const { cookie } = await authed(b);
    const tks = [await create(b, cookie, 'a'), await create(b, cookie, 'b')];
    const res = await bulk(b, cookie, { action: 'publish', keys: tks });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'publish', succeeded: 2, failed: 0, build: { ok: true, release: 'r1' } });
    expect(s.calls.length).toBe(1); // one build for the whole batch, not one per post
    // exportPost must not be skipped on the bulk path.
    expect(existsSync(join(dir, 'backup', 'trips', 'de', 'de-a.mdx'))).toBe(true);
    expect(existsSync(join(dir, 'backup', 'trips', 'en', 'en-b.mdx'))).toBe(true);
    const list = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(list.every((p: { status: string }) => p.status === 'published')).toBe(true);
  });

  it('reports failures per post instead of aborting the batch', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const good = await create(b, cookie, 'a');
    const res = await bulk(b, cookie, { action: 'publish', keys: [good, 'does-not-exist'] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results).toContainEqual({ key: good, ok: true,
      updatedAt: (await b.posts.get(good))!.updatedAt.toISOString(),
      publication: { availability: 'available', status: 'published', requestedLocales: ['de', 'en'],
        committedLocales: ['de', 'en'], draftDiffers: false, live: { de: 'not-live', en: 'not-live' } } });
    expect(body.results).toContainEqual({ key: 'does-not-exist', ok: false, error: 'post not found',
      publication: { availability: 'missing' } });
    expect(s.calls.length).toBe(1); // one build was requested; only a manifest can prove inclusion
  });

  it('surfaces a validation failure per post without touching the others', async () => {
    const b = build(); const { cookie } = await authed(b);
    const ok = await create(b, cookie, 'a');
    const incomplete = sample('b'); incomplete.de.excerpt = '';
    const bad = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: incomplete })).json().translationKey;
    const body = (await bulk(b, cookie, { action: 'publish', keys: [ok, bad] })).json();
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((r: { key: string }) => r.key === bad).error).toMatch(/excerpt required/);
  });

  it('unpublish reports a draft as a per-post failure', async () => {
    const b = build(); const { cookie } = await authed(b);
    const tk = await create(b, cookie, 'a');
    const body = (await bulk(b, cookie, { action: 'unpublish', keys: [tk] })).json();
    expect(body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(body.results[0].error).toBe('post is not published');
  });

  it('deletes drafts WITHOUT rebuilding, but rebuilds when a deleted post was live', async () => {
    // Mirrors DELETE /posts/:tk's wasPublished rule: nothing that was on the
    // public site changed, so there is nothing to rebuild.
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const draft = await create(b, cookie, 'a');
    const dropDrafts = await bulk(b, cookie, { action: 'delete', keys: [draft] });
    expect(dropDrafts.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(dropDrafts.json().build).toBeUndefined();
    expect(s.calls.length).toBe(0);

    const live = await create(b, cookie, 'b');
    await b.app.inject({ method: 'POST', url: `/posts/${live}/publish`, cookies: cookie, payload: await publishBody(b.posts, live) });
    expect(s.calls.length).toBe(1); // the publish
    const dropLive = await bulk(b, cookie, { action: 'delete', keys: [live] });
    expect(dropLive.json()).toMatchObject({ succeeded: 1, build: { ok: true, release: 'r1' } });
    expect(s.calls.length).toBe(2);
  });

  it('de-duplicates repeated keys so a post is acted on (and reported) once', async () => {
    const b = build(); const { cookie } = await authed(b);
    const tk = await create(b, cookie, 'a');
    const body = (await bulk(b, cookie, { action: 'publish', keys: [tk, tk, tk] })).json();
    expect(body.results).toHaveLength(1);
    expect(body).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('a failed rebuild is surfaced but the store changes still land', async () => {
    const s = stubBuilder({ ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, 'a');
    const body = (await bulk(b, cookie, { action: 'publish', keys: [tk] })).json();
    expect(body).toMatchObject({ succeeded: 1, build: { ok: false, code: 'internal', error: buildFailureMessage('internal') } });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('published');
  });
});

describe('publish gate (encode status)', () => {
  // @ai-warning: this is the ONLY real check on the encode queue's `status`
  // invariant. Without it a post publishes, `astro build` succeeds, and the
  // live site shows broken <img> elements — the URL is already in the body and
  // the original is already on disk, so nothing else notices.
  const IMG = 'https://img.simonswanderlust.com';
  const pairUsing = (heroSrc: string, images: Record<string, unknown> = {}) => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'gate-de', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: heroSrc, width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images },
    en: { locale: 'en', slug: 'gate-en', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: heroSrc, width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images },
  });

  const create = async (b: Built, cookie: { sid: string }, payload: Record<string, unknown>) =>
    (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload })).json().translationKey;

  it.each(['processing', 'failed', 'missing', 'unknown'] as const)('blocks single and bulk publication of a %s title image', async (status) => {
    const b = build();
    try {
      const { cookie } = await authed(b);
      const key = 'trips/g/title';
      if (status !== 'unknown') await b.media.upsert({ key, status, width: 2400, height: 800, origBytes: 1,
        exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
      const p = pairUsing(`${IMG}/trips/g/hero`);
      const tk = await create(b, cookie, { ...p, de: { ...p.de,
        titleImage: { src: `${IMG}/${key}`, width: 2400, height: 800, alt: 'View' } } });
      const single = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
      expect(single.statusCode).toBe(409);
      expect(single.json().notReady).toContain(key);
      const bulk = await b.app.inject({ method: 'POST', url: '/posts/bulk', cookies: cookie, payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() } });
      expect(bulk.json().results[0].ok).toBe(false);
      expect((await b.posts.get(tk))?.status).toBe('draft');
    } finally { await b.app.close(); }
  });

  it('refuses a foreign title image before publication', async () => {
    const b = build();
    try {
      const { cookie } = await authed(b);
      const p = pairUsing(`${IMG}/trips/g/hero`);
      const titleImage = { src: 'https://img.simonswanderlust.com.attacker.test/title', width: 2400, height: 800, alt: 'View' };
      const tk = await create(b, cookie, { ...p, de: { ...p.de, titleImage } });
      const response = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
      expect(response.statusCode).toBe(409);
      expect(response.json().foreignImages).toEqual([titleImage.src]);
    } finally { await b.app.close(); }
  });

  it('protects a ready title image from deletion until neither draft nor live snapshot uses it', async () => {
    const b = build();
    try {
      const { cookie } = await authed(b);
      const key = 'trips/g/title';
      await b.media.upsert({ key, status: 'ready', width: 2400, height: 800, origBytes: 1,
        exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
      const p = pairUsing(`${IMG}/trips/g/hero`);
      const tk = await create(b, cookie, { ...p, de: { ...p.de,
        titleImage: { src: `${IMG}/${key}`, width: 2400, height: 800, alt: 'View' } } });
      const remove = () => b.app.inject({ method: 'DELETE', url: `/media/items/${key}`, cookies: cookie });
      expect((await remove()).statusCode).toBe(409);
      expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(200);
      const saved = (await b.posts.get(tk))!;
      delete saved.de.titleImage;
      await b.posts.upsertDraft(saved);
      expect((await remove()).statusCode).toBe(409);
      expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(200);
      expect((await remove()).statusCode).toBe(200);
    } finally { await b.app.close(); }
  });

  it('blocks publishing while a referenced photo is still processing', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'processing', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(409);
    expect(res.json().notReady).toEqual(['trips/g/hero']);
    // Nothing went live.
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('draft');
  });

  it('blocks on a failed encode too', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'failed', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(409);
  });

  it('allows publishing once every referenced photo is ready', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'ready', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(200);
  });

  it('does NOT block a URL with no media row — WP-imported and legacy files predate the library', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, pairUsing(`${IMG}/wp/legacy/photo`));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(200);
  });

  it('checks a gallery actually referenced in the body, not just the hero', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    await b.media.upsert({ key: 'trips/g/hero', status: 'ready', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    await b.media.upsert({ key: 'trips/g/gallery-a', status: 'processing', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    const p = pairUsing(`${IMG}/trips/g/hero`, {
      [`${IMG}/trips/g/gallery-a`]: { width: 3000, height: 2000 },
    });
    const tk = await create(b, cookie, { ...p, de: { ...p.de,
      bodyMarkdown: `\`\`\`gallery\n${IMG}/trips/g/gallery-a\n\`\`\`` } });
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(409);
    expect(res.json().notReady).toEqual(['trips/g/gallery-a']);
  });

  it('maps a hand-pasted variant URL back to its key, and ignores foreign origins', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    await b.media.upsert({ key: 'trips/g/hero', status: 'processing', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero-1280.jpeg`, {
      // A different origin is not ours to gate on.
      'https://elsewhere.example/photo': { width: 10, height: 10 },
    }));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(409);
    expect(res.json().notReady).toEqual(['trips/g/hero']);
  });

  it('applies to the bulk path as a per-post failure', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'processing', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    const res = await b.app.inject({
      method: 'POST', url: '/posts/bulk', headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() },
    });
    expect(res.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.json().results[0].error).toMatch(/still processing/);
  });

  it.each(['processing', 'failed', 'missing'] as const)('blocks actual %s Markdown/raw references in both publish paths without metadata', async (status) => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    try {
      const { cookie } = await authed(b);
      const key = 'trips/g/body';
      await b.media.upsert({ key, status, width: 1280, height: 960, origBytes: 1,
        exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
      for (const format of ['avif', 'webp', 'jpeg']) {
        for (const locale of ['de', 'en'] as const) {
          const src = `${IMG}/${key}-640.${format}`;
          for (const bodyMarkdown of [`![View](${src})`, `<img src="${src}">`,
            `<picture><source srcset="${src} 1x"><img src="${IMG}/legacy-640.webp"></picture>`]) {
            const p = pairUsing(`${IMG}/wp/legacy/hero`);
            const tk = await create(b, cookie, { ...p, [locale]: { ...p[locale], bodyMarkdown } });
            const single = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
            expect(single.statusCode).toBe(409);
            expect(single.json().notReady).toEqual([key]);
            const bulk = await b.app.inject({ method: 'POST', url: '/posts/bulk', cookies: cookie, payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() } });
            expect(bulk.json()).toMatchObject({ succeeded: 0, failed: 1 });
            expect((await b.posts.get(tk))?.status).toBe('draft');
            expect((await b.posts.usageRows()).filter(row => row.translationKey === tk && row.source === 'published')).toEqual([]);
            await b.posts.remove(tk);
          }
        }
      }
      expect(s.calls).toHaveLength(0);
    } finally { await b.app.close(); }
  });

  it.each(['single', 'bulk'] as const)('%s allows stale unused metadata and ready/legacy body references', async (mode) => {
    const b = build();
    try {
      const { cookie } = await authed(b);
      const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
      await b.media.upsert({ key: 'trips/g/stale', status: 'failed', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
      await b.media.upsert({ key: 'trips/g/ready', status: 'ready', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
      const p = pairUsing(`${IMG}/wp/legacy/hero`, { [`${IMG}/trips/g/stale`]: { width: 9, height: 9 } });
      const bodyMarkdown = `![Ready](${IMG}/trips/g/ready-9.webp)\n\n<img src="${IMG}/wp/legacy/body-640.jpeg">`;
      const tk = await create(b, cookie, { ...p, de: { ...p.de, bodyMarkdown } });
      const response = mode === 'single'
        ? await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })
        : await b.app.inject({ method: 'POST', url: '/posts/bulk', cookies: cookie, payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() } });
      expect(response.statusCode).toBe(200);
      if (mode === 'bulk') expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
      expect((await b.posts.get(tk))?.status).toBe('published');
      expect((await b.posts.usageRows()).find(row => row.translationKey === tk && row.source === 'published' && row.locale === 'de')?.bodyMarkdown).toBe(bodyMarkdown);
    } finally { await b.app.close(); }
  });
});

describe('alt-text audit (advisory, never a gate)', () => {
  // The WordPress import stores the post title as every hero's alt, so ~20
  // drafts are entirely undescribed. The audit must SAY so and must never
  // stand in the way — a gate here would strand the whole imported corpus.
  const IMG = 'https://img.simonswanderlust.com';
  const undescribedPair = {
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'GR', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: {
      locale: 'de', slug: 'rhodos', title: 'Rhodos', excerpt: 'e', country: 'Griechenland',
      heroImage: { src: `${IMG}/trips/rhodos/hero`, width: 9, height: 9, alt: 'Rhodos' },
      bodyMarkdown: `![Rhodos](${IMG}/trips/rhodos/b1)`,
      images: { [`${IMG}/trips/rhodos/b1`]: { width: 9, height: 9 } },
    },
    en: {
      locale: 'en', slug: 'rhodes', title: 'Rhodes', excerpt: 'e', country: 'Greece',
      heroImage: { src: `${IMG}/trips/rhodes/hero`, width: 9, height: 9, alt: 'rhodes' },
      bodyMarkdown: '## b', images: {},
    },
  };
  const create = async (b: Built, cookie: { sid: string }) =>
    (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: undescribedPair })).json().translationKey;

  it('publishes a post whose every photo is undescribed, and names them in the reply', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const tk = await create(b, cookie);
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ published: true, build: { ok: true, release: 'r1' } });
    expect(res.json().altAudit).toEqual({
      count: 3,
      images: [
        { locale: 'de', kind: 'hero', src: `${IMG}/trips/rhodos/hero`, reason: 'repeats-title' },
        { locale: 'de', kind: 'body', src: `${IMG}/trips/rhodos/b1`, reason: 'repeats-title' },
        { locale: 'en', kind: 'hero', src: `${IMG}/trips/rhodes/hero`, reason: 'repeats-title' },
      ],
    });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('published');
  });

  it('serves the same audit before publishing, to any authed author', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    const tk = await create(b, cookie);
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/alt-audit`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(3);
  });

  // 2026-10-19 gallery-library-metadata spec: a library gallery photo renders
  // with its CURRENT Media alt, so that — not the stale copy on the post — is
  // what the audit judges; a photo with no media row is judged by its copy.
  it('judges library gallery photos by their current Media alt, before and after publishing', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    await b.media.upsert({ key: 'trips/rhodos/g1', status: 'ready', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null,
      alt: { de: 'Fischerboote im Hafen', en: 'Fishing boats' } });
    const pair = {
      ...undescribedPair,
      de: {
        ...undescribedPair.de,
        heroImage: { ...undescribedPair.de.heroImage, alt: 'Altstadt bei Nacht' },
        bodyMarkdown: '```gallery\n' + `${IMG}/trips/rhodos/g1 | 30x20 | alt="Rhodos"\n` + `${IMG}/trips/rhodos/g2 | 30x20 | alt="Rhodos"\n` + '```',
        images: {},
      },
      en: { ...undescribedPair.en, heroImage: { ...undescribedPair.en.heroImage, alt: 'Old town at night' } },
    };
    const tk = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: pair })).json().translationKey;
    const expected = { count: 1, images: [{ locale: 'de', kind: 'gallery', src: `${IMG}/trips/rhodos/g2`, reason: 'repeats-title' }] };
    const before = await b.app.inject({ method: 'GET', url: `/posts/${tk}/alt-audit`, cookies: cookie });
    expect(before.json()).toEqual(expected);
    // Clearing the library alt is reported, even though the post copy is filled in.
    await b.media.patch('trips/rhodos/g1', { alt: { de: '' } });
    const cleared = await b.app.inject({ method: 'GET', url: `/posts/${tk}/alt-audit`, cookies: cookie });
    expect(cleared.json().images).toContainEqual({ locale: 'de', kind: 'gallery', src: `${IMG}/trips/rhodos/g1`, reason: 'empty' });
    await b.media.patch('trips/rhodos/g1', { alt: { de: 'Fischerboote im Hafen' } });
    const published = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(published.statusCode).toBe(200);
    expect(published.json().altAudit).toEqual(expected);
  });

  it('is silent for a post whose photos are described', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const described = {
      ...undescribedPair,
      de: { ...undescribedPair.de, heroImage: { ...undescribedPair.de.heroImage, alt: 'Fischerboote im Hafen von Lindos' }, bodyMarkdown: `![Ziegen auf der Küstenstraße](${IMG}/trips/rhodos/b1)` },
      en: { ...undescribedPair.en, heroImage: { ...undescribedPair.en.heroImage, alt: 'Fishing boats in Lindos harbour' } },
    };
    const tk = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: described })).json().translationKey;
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.json().altAudit).toEqual({ count: 0, images: [] });
  });
});

describe('publish gate (foreign images, #91)', () => {
  const IMG = 'https://img.simonswanderlust.com';
  const pairWithBody = (deBody: string, enBody = '## b') => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'fgn-de', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: `${IMG}/trips/g/hero`, width: 9, height: 9, alt: 'a' }, bodyMarkdown: deBody, images: {} },
    en: { locale: 'en', slug: 'fgn-en', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: `${IMG}/trips/g/hero`, width: 9, height: 9, alt: 'a' }, bodyMarkdown: enBody, images: {} },
  });
  const create = async (b: Built, cookie: { sid: string }, payload: Record<string, unknown>) =>
    (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload })).json().translationKey;

  it('409s with the count and examples while a body still hot-links another host, and publishes nothing', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const urls = Array.from({ length: 7 }, (_, i) => `https://old.example/wp-content/uploads/${i}.jpg`);
    const de = urls.map((u) => `![p](${u} "${u.split('/').pop()}")`).join('\n\n');
    const tk = await create(b, cookie, pairWithBody(de, '```gallery\nhttps://old.example/wp-content/uploads/g.jpg\n```'));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(409);
    expect(res.json().foreignImageCount).toBe(8);
    expect(res.json().foreignImages).toEqual(urls.slice(0, 5));
    expect(s.calls.length).toBe(0);
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('draft');
  });

  it('publishes once every body image is on the image host', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, pairWithBody(`![p](${IMG}/trips/g/a)\n\n\`\`\`gallery\n${IMG}/trips/g/b | 30x20\n\`\`\``));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) })).statusCode).toBe(200);
  });

  it('applies to the bulk path as a per-post failure', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, pairWithBody('![p](https://old.example/a.jpg)'));
    const res = await b.app.inject({
      method: 'POST', url: '/posts/bulk', headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() },
    });
    expect(res.json()).toMatchObject({ succeeded: 0, failed: 1 });
  });
});

describe('posts editor', () => {
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  async function installManifest(posts: PostStore, stamp: string) {
    const entries: ReleaseManifestV1['posts'] = [];
    for (const fact of await posts.publicationFacts()) {
      const pair = (await posts.get(fact.translationKey))!;
      for (const locale of fact.committedLocales) entries.push({
        translationKey: fact.translationKey, locale, slug: pair[locale].slug,
        digest: fact.rowDigest[locale]!, gallery: [],
      });
    }
    const root = join(dir, 'site');
    await mkdir(join(root, 'manifests'), { recursive: true });
    await mkdir(join(root, 'releases', stamp), { recursive: true });
    await writeFile(join(root, 'manifests', `${stamp}.json`), JSON.stringify({ schema: 1, stamp, posts: entries }));
    await symlink(join('releases', stamp), join(root, 'next'));
    await rename(join(root, 'next'), join(root, 'current'));
  }

  it('observes failed publish, matching rebuild, failed republish, failed unpublish and deletion against the actual current manifest', async () => {
    const failed = stubBuilder({ ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') });
    const b = build({ builder: failed.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const first = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ published: true, build: { ok: false },
      publication: { status: 'published', live: { de: 'not-live', en: 'not-live' }, draftDiffers: false } });
    await installManifest(b.posts, '1793000000000-1-0001');
    let read = await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json().publication.live).toEqual({ de: 'live', en: 'live' });
    const unchanged = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie, payload: sample() });
    expect(unchanged.json().publication.draftDiffers).toBe(false);
    await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie,
      payload: { ...sample(), de: { ...sample().de, bodyMarkdown: 'Changed saved body' } } });
    const second = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(second.json().publication).toMatchObject({ status: 'published', draftDiffers: false,
      live: { de: 'older-version-live', en: 'live' } });
    const unpublished = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(unpublished.json().publication.status).toBe('draft');
    expect(unpublished.json().publication.live.de).toBe('older-version-live');
    const summary = await b.app.inject({ method: 'GET', url: '/publication/summary', cookies: cookie });
    expect(summary.json()).toMatchObject({ availability: 'available', release: 'known', posts: { unpublishedStillLive: 1 } });
    const deleted = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(deleted.json().publication).toEqual({ availability: 'missing' });
    expect((await b.app.inject({ method: 'GET', url: '/publication/summary', cookies: cookie })).json().posts.deletedStillLive).toBe(1);
    read = await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie });
    expect(read.statusCode).toBe(404);
  });

  it('returns a concurrent unpublish observation without borrowing its token or changing the publish acknowledgement', async () => {
    const posts = memoryPostStore();
    let tk = '';
    let ownToken = '';
    let laterToken = '';
    const b = build({ posts, builder: {
      ...idleBuildState, hasRelease: () => false, quiesce: async () => {},
      build: async () => {
        ownToken = (await posts.get(tk))!.updatedAt.toISOString();
        laterToken = (await posts.unpublish(tk)).updatedAt.toISOString();
        return { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
      },
    } });
    const { cookie } = await authed(b);
    tk = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() })).json().translationKey;
    const response = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(posts, tk) });
    expect(response.json()).toMatchObject({ published: true, updatedAt: ownToken,
      publication: { status: 'draft', live: { de: 'not-live', en: 'not-live' } } });
    expect(response.json().updatedAt).not.toBe(laterToken);
  });

  it.each(['save', 'publish', 'unpublish', 'bulk-publish', 'bulk-unpublish', 'bulk-delete'] as const)(
    'keeps a committed %s successful with its action token when optional projection fails', async (action) => {
      const b = build(); const { cookie } = await authed(b);
      const tk = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() })).json().translationKey;
      if (action.includes('unpublish')) await b.posts.publish(tk, await publishTokens(b.posts, tk));
      const original = (await b.posts.get(tk))!.updatedAt.toISOString();
      vi.spyOn(b.posts, 'publicationFacts').mockRejectedValue(new Error('projection DB read failed'));
      const response = action === 'save'
        ? await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie,
            payload: { ...sample(), de: { ...sample().de, title: 'Acknowledged change' } } })
        : action.startsWith('bulk-')
          ? await b.app.inject({ method: 'POST', url: '/posts/bulk', cookies: cookie, payload: {
              action: action.slice(5), keys: [tk], baseLanguageUpdatedAt: (await b.posts.language.get()).updatedAt.toISOString() } })
          : await b.app.inject({ method: 'POST', url: `/posts/${tk}/${action}`, cookies: cookie,
              ...(action === 'publish' ? { payload: await publishBody(b.posts, tk) } : {}) });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const acknowledged = action.startsWith('bulk-') ? response.json().results[0] : response.json();
      expect(acknowledged.publication).toEqual({ availability: 'unavailable' });
      if (action === 'bulk-delete') {
        expect(acknowledged.ok).toBe(true);
        expect(await b.posts.get(tk)).toBeNull();
      } else {
        expect(acknowledged.updatedAt).not.toBe(original);
        expect(acknowledged.updatedAt).toBe((await b.posts.get(tk))!.updatedAt.toISOString());
      }
    });

  it('gives authors only enumerated post facts and refuses site-wide summary access', async () => {
    const b = build(); const { cookie } = await authed(b, { isAdmin: false });
    const saved = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() });
    const tk = saved.json().translationKey;
    await b.posts.publish(tk, await publishTokens(b.posts, tk));
    await installManifest(b.posts, '1793000000000-1-0001');
    const response = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()[0].publication).toEqual({ availability: 'available', status: 'published',
      requestedLocales: ['de', 'en'], committedLocales: ['de', 'en'], draftDiffers: false, live: { de: 'live', en: 'live' } });
    expect(response.body).not.toContain('digest');
    expect(response.body).not.toContain('attemptId');
    expect(response.body).not.toContain('1793000000000-1-0001');
    expect((await b.app.inject({ method: 'GET', url: '/publication/summary', cookies: cookie })).statusCode).toBe(403);
  });

  it.each(['de', 'en'] as const)('keeps %s primary translation coverage pending through rejection and distinguishes commit from live inclusion', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const b = build({ language, builder: stubBuilder({ ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') }).builder });
    const { cookie } = await authed(b);
    const input = sample();
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie,
      payload: { ...input, [secondary]: { ...input[secondary], omitted: true, slug: '' } } });
    const tk = created.json().translationKey;
    await b.posts.publish(tk, await publishTokens(b.posts, tk));
    await installManifest(b.posts, '1793000000000-1-0001');
    const incomplete = { ...input, [secondary]: { ...input[secondary], omitted: false, bodyMarkdown: '' } };
    const saved = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie, payload: incomplete });
    expect(saved.json().publication).toMatchObject({ status: 'published', draftDiffers: true,
      requestedLocales: ['de', 'en'], committedLocales: [primary], live: { [primary]: 'live', [secondary]: 'not-live' } });
    const refused = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(refused.statusCode).toBe(400);
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().publication.draftDiffers).toBe(true);
    await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie, payload: input });
    const committed = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(committed.json()).toMatchObject({ published: true, build: { ok: false }, publication: {
      status: 'published', draftDiffers: false, committedLocales: ['de', 'en'],
      live: { [primary]: 'live', [secondary]: 'not-live' },
    } });
    await installManifest(b.posts, '1793000000001-1-0002');
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()[0].publication.live).toEqual({ de: 'live', en: 'live' });
  });

  it('requires the strict 4KiB explicit publish body without a bodyless compatibility path', async () => {
    const b = build(); const { cookie } = await authed(b);
    const saved = await b.posts.upsertDraft({ ...sample(), status: 'draft', de: { ...sample().de, locale: 'de' }, en: { ...sample().en, locale: 'en' } });
    const url = `/posts/${saved.translationKey}/publish`;
    const tokens = await publishBody(b.posts, saved.translationKey);
    const bodies = [undefined, {}, { baseUpdatedAt: tokens.baseUpdatedAt }, { ...tokens, extra: true },
      { ...tokens, baseUpdatedAt: 'not-a-date' }, { ...tokens, baseRouteVersion: '' },
      { ...tokens, baseRouteVersion: 1 }, { baseUpdatedAt: tokens.baseUpdatedAt, baseRouteVersion: tokens.baseRouteVersion },
      { ...tokens, baseLanguageUpdatedAt: 'not-a-date' }, { ...tokens, baseLanguageUpdatedAt: '2026-10-27' }];
    for (const payload of bodies) {
      const response = await b.app.inject({ method: 'POST', url, cookies: cookie, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const oversized = await b.app.inject({ method: 'POST', url, cookies: cookie, payload: { ...tokens, padding: 'x'.repeat(4096) } });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['cache-control']).toBe('no-store');
    expect((await b.posts.get(saved.translationKey))!.status).toBe('draft');
  });

  it.each(['single', 'bulk'] as const)('%s refuses a text change committed between review and the publication lock', async (mode) => {
    const s = stubBuilder();
    const b = build({ builder: s.builder }); const { cookie } = await authed(b);
    const saved = await b.posts.upsertDraft({ ...sample(), status: 'draft',
      de: { ...sample().de, locale: 'de', heroImage: { ...sample().de.heroImage, src: 'https://img.simonswanderlust.com/photo' } },
      en: { ...sample().en, locale: 'en' } });
    const tokens = await publishBody(b.posts, saved.translationKey);
    const publish = b.posts.publish.bind(b.posts);
    vi.spyOn(b.posts, 'publish').mockImplementationOnce(async (...args) => {
      await b.posts.upsertDraft({ ...saved, de: { ...saved.de, bodyMarkdown: '![foreign](https://old.example/private.jpg)' } });
      return publish(...args);
    });
    const response = await b.app.inject(mode === 'single'
      ? { method: 'POST', url: `/posts/${saved.translationKey}/publish`, cookies: cookie, payload: tokens }
      : { method: 'POST', url: '/posts/bulk', cookies: cookie, payload: { action: 'publish', keys: [saved.translationKey], baseLanguageUpdatedAt: tokens.baseLanguageUpdatedAt } });
    if (mode === 'single') { expect(response.statusCode).toBe(409); expect(response.json().code).toBe('conflict'); }
    else expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect((await b.posts.get(saved.translationKey))!.status).toBe('draft');
    expect(s.calls).toHaveLength(0);
  });

  it.each(['single', 'bulk'] as const)('%s holds the reviewed pair stable while image gates run', async (mode) => {
    const s = stubBuilder();
    const b = build({ builder: s.builder }); const { cookie } = await authed(b);
    const saved = await b.posts.upsertDraft({ ...sample(), status: 'draft',
      de: { ...sample().de, locale: 'de', heroImage: { ...sample().de.heroImage, src: 'https://img.simonswanderlust.com/photo' } },
      en: { ...sample().en, locale: 'en' } });
    const tokens = await publishBody(b.posts, saved.translationKey);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(b.media, 'notReadyKeys').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return new Set<string>();
    });
    const request = b.app.inject(mode === 'single'
      ? { method: 'POST', url: `/posts/${saved.translationKey}/publish`, cookies: cookie, payload: tokens }
      : { method: 'POST', url: '/posts/bulk', cookies: cookie,
          payload: { action: 'publish', keys: [saved.translationKey], baseLanguageUpdatedAt: tokens.baseLanguageUpdatedAt } }).then(response => response);
    await entered.promise;
    let settled = false;
    const save = b.posts.upsertDraft({ ...saved, de: { ...saved.de, bodyMarkdown: '![foreign](https://old.example/private.jpg)' } })
      .then(value => { settled = true; return value; });
    try {
      // Give the queued writer a turn while the publication gate remains held.
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
      expect(settled).toBe(false);
    } finally { release.resolve(); }
    const [response, edited] = await Promise.all([request, save]);
    expect(response.statusCode).toBe(200);
    if (mode === 'single') expect(response.json().published).toBe(true);
    else expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
    // The later edit is only a working copy, not part of the committed snapshot.
    expect(edited.status).toBe('published');
    expect(edited.publication).toMatchObject({ availability: 'available', draftDiffers: true });
    expect(s.calls).toHaveLength(1);
    const retry = await b.app.inject({ method: 'POST', url: `/posts/${saved.translationKey}/publish`,
      cookies: cookie, payload: await publishBody(b.posts, saved.translationKey) });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe('foreign_images');
    expect(s.calls).toHaveLength(1);
  });

  it('returns the committed publish timestamp even when a draft save happens during its build', async () => {
    const posts = memoryPostStore();
    let committed: Date | undefined;
    let tk = '';
    const b = build({ posts, builder: {
      ...idleBuildState,
      hasRelease: () => true, quiesce: async () => {},
      build: async () => {
        const published = (await posts.get(tk))!;
        committed = published.updatedAt;
        await posts.upsertDraft({ ...published, de: { ...published.de, title: 'Later draft' } });
        return { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') };
      },
    } });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() });
    tk = created.json().translationKey;
    const response = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(posts, tk) });
    expect(response.statusCode).toBe(200);
    expect(response.json().updatedAt).toBe(committed!.toISOString());
    expect(response.json().build.ok).toBe(false);
    expect((await posts.get(tk))!.updatedAt.getTime()).toBeGreaterThan(committed!.getTime());
    expect((await posts.get(tk))!.publication).toMatchObject({ availability: 'available', draftDiffers: true });
  });

  it('GET /posts 401 without auth', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/posts' })).statusCode).toBe(401);
  });

  it('create → list → publish (triggers the builder)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.statusCode).toBe(200);
    const tk = created.json().translationKey;
    const list = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
    expect(list.json()).toHaveLength(1);
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ published: true, build: { ok: true, release: 'r1' } });
  });

  it('publish is admin-only: a non-admin author gets 403', async () => {
    const b = build();
    const anonymous = await b.app.inject({ method: 'POST', url: '/posts/x/publish', payload: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.statusCode).toBe(200); // authors may still create/edit drafts
    const tk = created.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(pub.statusCode).toBe(403);
    expect(pub.headers['cache-control']).toBe('no-store');
  });

  it('publish rejects an incomplete post (400)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const bad = sample(); bad.de.excerpt = '';
    const c = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: bad });
    const tk = c.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(pub.statusCode).toBe(400);
  });

  it('draft edits over a published post surface content differences until re-publish', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    let got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got).toMatchObject({ status: 'published', publication: { availability: 'available', draftDiffers: false } });

    const edited = { ...sample(), de: { ...sample().de, bodyMarkdown: '## edited' } };
    const put = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload: edited });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: 'published', publication: { availability: 'available', draftDiffers: true } });

    // The editor still gets the edited WORKING copy; the list carries the flag
    // for the posts page's "edited" badge.
    got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got.de.bodyMarkdown).toBe('## edited');
    expect(got.publication).toMatchObject({ availability: 'available', draftDiffers: true });
    const list = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(list[0]).toMatchObject({ status: 'published', publication: { availability: 'available', draftDiffers: true } });

    const repub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(repub.statusCode).toBe(200);
    got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got).toMatchObject({ status: 'published', publication: { availability: 'available', draftDiffers: false } });
  });

  it('delete and unpublish are admin-only (401 anonymous, 403 author)', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'DELETE', url: '/posts/x' })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'POST', url: '/posts/x/unpublish' })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'DELETE', url: '/posts/x', cookies: cookie })).statusCode).toBe(403);
    expect((await b.app.inject({ method: 'POST', url: '/posts/x/unpublish', cookies: cookie })).statusCode).toBe(403);
  });

  it('delete and unpublish 404 on an unknown translation key', async () => {
    const b = build(); const { cookie } = await authed(b);
    expect((await b.app.inject({ method: 'DELETE', url: '/posts/nope', cookies: cookie })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'POST', url: '/posts/nope/unpublish', cookies: cookie })).statusCode).toBe(404);
  });

  it('PUT /posts/:tk 404s on an unknown key instead of creating a post', async () => {
    const b = build(); const { cookie } = await authed(b);
    const put = await injectAuthoring(b.app, { method: 'PUT', url: '/posts/nope', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(put.statusCode).toBe(404);
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(0);
  });

  it('deleting a draft removes it without rebuilding the site', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, publication: { availability: 'missing' } });
    expect(s.calls.length).toBe(0); // a draft was never on the live site
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(0);
  });

  it('deleting a published post rebuilds the site and reports the outcome', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(s.calls.length).toBe(1); // publish built once
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, publication: { availability: 'missing' }, build: { ok: true, attemptId: 'r1', release: 'r1' } });
    expect(s.calls.length).toBe(2);
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).statusCode).toBe(404);
  });

  it('unpublish 409s on a draft', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(409);
    expect(un.json().error).toBe('post is not published');
    expect(s.calls.length).toBe(0);
  });

  it('unpublish flips a published post to draft and rebuilds', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const published = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(s.calls.length).toBe(1);
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(200);
    expect(un.json()).toEqual({ unpublished: true, previousUpdatedAt: published.json().updatedAt, updatedAt: expect.any(String),
      publication: { availability: 'available', status: 'draft', requestedLocales: ['de', 'en'], committedLocales: [],
        draftDiffers: false, live: { de: 'not-live', en: 'not-live' } },
      build: { ok: true, attemptId: 'r1', release: 'r1' } });
    expect(s.calls.length).toBe(2);
    const got = await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie });
    expect(got.json().status).toBe('draft');
  });

  it('reports the locked predecessor when another tab saves after the route preflight', async () => {
    const posts = memoryPostStore();
    const b = build({ posts, builder: stubBuilder().builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const published = await posts.publish(tk, await publishTokens(posts, tk));
    const get = posts.get.bind(posts);
    let precedingToken: Date | undefined;
    vi.spyOn(posts, 'get').mockImplementationOnce(async (key) => {
      const before = (await get(key))!;
      const saved = await posts.upsertDraft({
        ...before, de: { ...before.de, title: 'Saved between preflight and lock' },
      }, before.updatedAt);
      precedingToken = saved.updatedAt;
      return before;
    });
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(200);
    expect(un.json().previousUpdatedAt).toBe(precedingToken?.toISOString());
    expect(un.json().previousUpdatedAt).not.toBe(published.updatedAt.toISOString());
    const stale = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, cookies: cookie,
    payload: { ...sample(), updatedAt: published.updatedAt.toISOString() }, });
    expect(stale.statusCode).toBe(409);
    expect((await posts.get(tk))!.de.title).toBe('Saved between preflight and lock');
  });

  it('a failed rebuild is surfaced but the store change still lands (unpublish + delete)', async () => {
    const s = stubBuilder({ ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const published = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(200);
    expect(un.json()).toEqual({ unpublished: true, previousUpdatedAt: published.json().updatedAt, updatedAt: expect.any(String),
      publication: { availability: 'available', status: 'draft', requestedLocales: ['de', 'en'], committedLocales: [],
        draftDiffers: false, live: { de: 'not-live', en: 'not-live' } },
      build: { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') } });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('draft');
    // re-publish, then delete while the builder keeps failing: DB delete lands, outcome surfaced
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, publication: { availability: 'missing' }, build: { ok: false, attemptId: 'failed', code: 'internal', error: buildFailureMessage('internal') } });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).statusCode).toBe(404);
  });

  it('GET /posts summaries carry the hero, trip date, country and region for the list UI', async () => {
    const b = build(); const { cookie } = await authed(b);
    await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const [summary] = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(summary).toMatchObject({
      heroSrc: 'https://i/h', heroWidth: 9,
      date: '2024-10-03', country: 'X', region: 'europe',
    });
  });

  it('GET /posts/:tk includes updatedAt, and a PUT echoing it saves fine', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.json().updatedAt).toBeTruthy();
    const tk = created.json().translationKey;
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(typeof got.updatedAt).toBe('string');
    const put = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...sample(), de: { ...sample().de, title: 'T2' }, updatedAt: got.updatedAt }, });
    expect(put.statusCode).toBe(200);
    expect(put.json().de.title).toBe('T2');
  });

  it('PUT with a stale updatedAt → 409 code "conflict"; nothing is overwritten', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const put = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...sample(), de: { ...sample().de, bodyMarkdown: '## clobber' }, updatedAt: '2000-01-01T00:00:00.000Z' }, });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ code: 'conflict' });
    expect(put.json().error).toMatch(/modified/);
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got.de.bodyMarkdown).toBe('## b');
  });

  it('PUT with an unparsable updatedAt → 400; without one the check is skipped', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const bad = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...sample(), updatedAt: 'not-a-date' }, });
    expect(bad.statusCode).toBe(400);
    const none = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: sample(), });
    expect(none.statusCode).toBe(200);
  });

  // Issue #122 (Golden Rule 2): an imported draft carries the live WordPress
  // slug, so renaming a draft slug must be an explicit act, never a side effect.
  it('renaming a draft slug needs confirmSlugChange: 409 without it (nothing saved), 200 with it', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const put = (payload: Record<string, unknown>) => injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload });
    const renamed = { ...sample(), de: { ...sample().de, slug: 'renamed-de', bodyMarkdown: '## edited' } };
    const refused = await put(renamed);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'slug_change_unconfirmed' });
    expect(refused.json().error).toMatch(/DE slug from "de-s" to "renamed-de"/);
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got.de).toMatchObject({ slug: 'de-s', bodyMarkdown: '## b' });
    expect((await put({ ...renamed, confirmSlugChange: 'yes' })).statusCode).toBe(400);
    const ok = await put({ ...renamed, confirmSlugChange: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().de.slug).toBe('renamed-de');
    // an unchanged slug never asks
    expect((await put({ ...renamed })).statusCode).toBe(200);
  });

  it('filling in an unset EN slug on a DE-first draft needs no confirmation', async () => {
    const b = build(); const { cookie } = await authed(b);
    const deFirst = { ...sample(), en: { ...sample().en, slug: '', title: '' } };
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: deFirst });
    const tk = created.json().translationKey;
    const res = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(res.statusCode).toBe(200);
    expect(res.json().en.slug).toBe('en-s');
  });

  it('a second tab saving after another tab confirmed a rename gets "conflict", not a consent error', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const put = (payload: Record<string, unknown>) => injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload });
    expect((await put({ ...sample(), de: { ...sample().de, slug: 'renamed-de' }, confirmSlugChange: true })).statusCode).toBe(200);
    // tab B still holds the old slug and a pre-rename updatedAt: it needs the
    // reload offer ('conflict'), not a slug prompt it has no way to answer.
    const stale = await put({ ...sample(), de: { ...sample().de, bodyMarkdown: '## tab B' }, updatedAt: '2000-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('conflict');
  });

  it('duplicate-slug 409 carries its own code, distinguishable from a conflict', async () => {
    const b = build(); const { cookie } = await authed(b);
    await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const dup = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('duplicate_slug');
  });

  // Malformed requests must not become 500s or leave partially created drafts.
  it('rejects malformed post payloads without creating drafts', async () => {
    const b = build(); const { cookie } = await authed(b);
    const post = (payload: unknown) => injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: payload as Record<string, unknown> });
    const cases: unknown[] = [
      [],
      { shared: {}, en: {} },
      { shared: {}, de: { title: 42 }, en: {} },
      { shared: {}, de: { title: '' }, en: {} },
      { shared: { categories: 'a,b' }, de: { title: 'T' }, en: {} },
      { shared: { scheduledAt: 'junk' }, de: { title: 'T' }, en: {} },
      { shared: { countryCode: 'R' }, de: { title: 'T' }, en: {} },
      { shared: { region: 'mars' }, de: { title: 'T' }, en: {} },
      { shared: { date: '3.10.2024' }, de: { title: 'T' }, en: {} },
      { shared: { coordinates: { lat: 'x', lng: 1 } }, de: { title: 'T' }, en: {} },
    ];
    for (const payload of cases) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await b.posts.list()).toEqual([]);
  });

  it('a title-only draft (the documented minimum) saves and reloads with visible placeholders', async () => {
    const b = build(); const { cookie } = await authed(b);
    const res = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { shared: {}, de: { locale: 'de', title: 'Nur ein Titel' }, en: { locale: 'en' } } });
    expect(res.statusCode).toBe(200);
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${res.json().translationKey}`, cookies: cookie })).json();
    expect(got.shared).toMatchObject({ countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } });
    expect(got.shared.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(got.en).toMatchObject({ locale: 'en', slug: '', title: '', excerpt: '', bodyMarkdown: '', images: {} });
  });

  it('publish response includes the fresh updatedAt so the editor can re-sync', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().updatedAt).toBeTruthy();
    // Echoing the post-publish value must not false-conflict.
    const put = await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...sample(), status: 'published', updatedAt: pub.json().updatedAt }, });
    expect(put.statusCode).toBe(200);
  });

  it('a failed MDX backup leaves the publish live and is logged, not swallowed (#145)', async () => {
    // BACKUP_DIR under a regular file: exportPost's mkdir fails with ENOTDIR,
    // which is what a bare-dev default of /data/backup used to do silently.
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'x');
    const b = build({ backupDir: join(blocker, 'backup') });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
      expect(pub.statusCode).toBe(200);
      expect(pub.json().published).toBe(true);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(tk), expect.objectContaining({ code: 'ENOTDIR' }));
    } finally {
      spy.mockRestore();
    }
    const list = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(list[0].status).toBe('published');
  });
});

describe('post revisions endpoints', () => {
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('401 anonymous', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/posts/x/revisions' })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'GET', url: '/posts/x/revisions/y' })).statusCode).toBe(401);
  });

  it('404 for an unknown post', async () => {
    const b = build(); const { cookie } = await authed(b);
    expect((await b.app.inject({ method: 'GET', url: '/posts/nope/revisions', cookies: cookie })).statusCode).toBe(404);
  });

  it('lists the revision created by a second save and serves its full snapshot', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    let list = (await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions`, cookies: cookie })).json();
    expect(list).toEqual([]);
    await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
    payload: { ...sample(), de: { ...sample().de, title: 'T2', bodyMarkdown: '## new' } }, });
    list = (await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions`, cookies: cookie })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'T', status: 'draft' });
    expect(typeof list[0].savedAt).toBe('string');
    expect(list[0].snapshot).toBeUndefined(); // summaries stay light

    const rev = await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions/${list[0].id}`, cookies: cookie });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().snapshot.de.title).toBe('T');
    expect(rev.json().snapshot.de.bodyMarkdown).toBe('## b');
    expect(rev.json().snapshot.en.slug).toBe('en-s');

    const missing = await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions/00000000-0000-4000-8000-000000000000`, cookies: cookie });
    expect(missing.statusCode).toBe(404);
  });

  // #137: a deleted post's full-body snapshots must not stay readable by a
  // kept revision URL — the item route 404s like the list route, and the store
  // no longer holds them (asserted through the store, bypassing the route).
  it('a revision URL stops working once its post is deleted, on both the single and the bulk path', async () => {
    const b = build(); const { cookie } = await authed(b);
    const revOf = async (slug: string) => {
      const payload = { ...sample(), de: { ...sample().de, slug: `de-${slug}` }, en: { ...sample().en, slug: `en-${slug}` } };
      const tk = (await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload })).json().translationKey;
      await injectAuthoring(b.app, { method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { ...payload, de: { ...payload.de, title: 'T2' } } });
      const [rev] = (await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions`, cookies: cookie })).json();
      return { tk, id: rev.id as string };
    };
    const single = await revOf('single');
    const bulk = await revOf('bulk');
    expect((await b.app.inject({ method: 'GET', url: `/posts/${single.tk}/revisions/${single.id}`, cookies: cookie })).statusCode).toBe(200);

    expect((await b.app.inject({ method: 'DELETE', url: `/posts/${single.tk}`, cookies: cookie })).statusCode).toBe(200);
    expect((await b.app.inject({ method: 'GET', url: `/posts/${single.tk}/revisions/${single.id}`, cookies: cookie })).statusCode).toBe(404);
    expect(await b.posts.getRevision(single.tk, single.id)).toBeNull();

    const res = await b.app.inject({ method: 'POST', url: '/posts/bulk', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { action: 'delete', keys: [bulk.tk] } });
    expect(res.json()).toMatchObject({ succeeded: 1 });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${bulk.tk}/revisions/${bulk.id}`, cookies: cookie })).statusCode).toBe(404);
    expect(await b.posts.getRevision(bulk.tk, bulk.id)).toBeNull();
  });
});

describe('WordPress import', () => {
  // issue #97: admin-only, like every other surface that writes gigabytes under
  // /data or makes outbound fetches the server does not choose.
  it('401 without auth, 403 for a non-admin author', async () => {
    const b = build();
    const wxr = () => {
      const form = new FormData();
      form.append('file', readFileSync('test/fixtures/wxr-sample.xml', 'utf8'), { filename: 'export.xml', contentType: 'text/xml' });
      return form;
    };
    const anon = wxr();
    expect((await b.app.inject({ method: 'POST', url: '/import', headers: anon.getHeaders(), payload: anon })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const asAuthor = wxr();
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: asAuthor.getHeaders(), cookies: cookie, payload: asAuthor });
    expect(res.statusCode).toBe(403);
    // Rejected at the preHandler: nothing was imported for the author.
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(0);
  });

  // issue #92: the multi-minute part is a job. A 202 names it, GET /import/status
  // carries the live counters and then the same summary the old 200 did.
  it('imports the fixture export as drafts: 202, then the summary on /import/status', async () => {
    const b = build(); const { cookie } = await authed(b);
    const xml = readFileSync('test/fixtures/wxr-sample.xml', 'utf8');
    const form = new FormData();
    form.append('file', xml, { filename: 'export.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'running', planned: { groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 0, failed: 0 } } });
    const id = res.json().id as string;
    await b.importJobs.settle();
    const status = await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie });
    expect(status.statusCode).toBe(200);
    const job = status.json().job;
    expect(job).toMatchObject({ id, status: 'done', startedBy: 'simon', progress: { groups: { total: 1, done: 1 } } });
    expect(job.summary).toMatchObject({ imported: 1, updated: 0, skippedPublished: 0, rejected: 0, failed: 0 });
    expect(job.finishedAt).toBeTruthy();
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(1);
  });

  it('GET /import/status is admin-only and null before any import', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/import/status' })).statusCode).toBe(401);
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'GET', url: '/import/status', cookies: author.cookie })).statusCode).toBe(403);
    const admin = await authed(b);
    expect((await b.app.inject({ method: 'GET', url: '/import/status', cookies: admin.cookie })).json()).toEqual({ job: null });
  });

  it('400 on a non-WXR upload', async () => {
    const b = build(); const { cookie } = await authed(b);
    const form = new FormData();
    form.append('file', 'just text', { filename: 'x.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(400);
  });

  // issue #143: a truncated download passes the `<rss` / `wordpress.org/export`
  // sniff and used to reach the global handler as a 500 with a stack trace.
  it('400 on a WXR-looking file that is not well-formed XML', async () => {
    const b = build(); const { cookie } = await authed(b);
    const truncated = `<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><item><title><![CDATA[cut off`;
    const form = new FormData();
    form.append('file', truncated, { filename: 'export.xml', contentType: 'text/xml' });
    const res = await b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('export is not well-formed XML');
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

  // issue #100: a re-run of an export whose posts are all already published is
  // a job with `skippedPublished` — "nothing to do" is a success the author can
  // read, not the 400 the old `skipped === 0` check returned (a 400 cannot say
  // which posts were untouched and why).
  it('reports an all-published re-run as a job with skippedPublished, not a 400', async () => {
    const b = build(); const { cookie } = await authed(b);
    // Seed a published pair under the slugs `wxrWith` exports.
    const seed = {
      translationKey: '', status: 'draft',
      shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: { locale: 'de', slug: 'imp-de', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
      en: { locale: 'en', slug: 'imp-en', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    };
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: seed });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    const summary = await importAndWait(b, cookie, wxrWith());
    expect(summary).toMatchObject({ imported: 0, updated: 0, skippedPublished: 1, rejected: 0, failed: 0 });
  });

  // ---- issue #85 ----------------------------------------------------------

  const wxrWith = (...urls: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
${(['de', 'en'] as const).map((loc) => `  <item>
    <title>t ${loc}</title>
    <wp:post_name><![CDATA[imp-${loc}]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[${loc === 'de' ? urls.map((u) => `<img src="${u}" alt="a" />`).join('') : '<p>x</p>'}]]></content:encoded>
    <category domain="language" nicename="${loc}"><![CDATA[${loc}]]></category>
    <category domain="post_translations" nicename="impg"><![CDATA[impg]]></category>
  </item>`).join('\n')}
</channel>
</rss>`;

  const postImport = (b: Built, cookie: Record<string, string>, xmlBody: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', xmlBody, { filename: 'export.xml', contentType: 'text/xml' });
    return b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
  };

  /** Start an import, wait for the job, and return its summary from /import/status. */
  const importAndWait = async (b: Built, cookie: Record<string, string>, xmlBody: string): Promise<ImportSummary> => {
    const res = await postImport(b, cookie, xmlBody);
    expect(res.statusCode).toBe(202);
    await b.importJobs.settle();
    const job = (await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json().job;
    expect(job.status).toBe('done');
    return job.summary as ImportSummary;
  };

  // Every URL here is refused by safeFetch's SSRF guard, so it fails instantly
  // and non-retryably — no network, no backoff, just the pacing gate.
  const blocked = (n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1/p${i}.jpg`);

  it('reports how many images were actually hosted, so a partial import cannot look clean', async () => {
    const b = build(); const { cookie } = await authed(b);
    const summary = await importAndWait(b, cookie, wxrWith(...blocked(3)));
    expect(summary).toMatchObject({ imported: 1, images: { total: 3, hosted: 0, failed: 3 } });
  });

  it('does not leak the transport error behind a failed image', async () => {
    const b = build(); const { cookie } = await authed(b);
    const summary = await importAndWait(b, cookie, wxrWith(...blocked(1)));
    const warnings = summary.warnings.join(' ');
    expect(warnings).toMatch(/blocked address/);
    expect(warnings).not.toMatch(/ECONNREFUSED|refusing to fetch/);
  });

  const OK: ImportSummary = { imported: 1, updated: 0, skippedPublished: 0, skippedLocale: 0, rejected: 0, failed: 0, images: { total: 0, hosted: 0, failed: 0 }, warnings: [] };
  const PLANNED: ImportProgress = { groups: { total: 1, done: 0 }, images: { planned: 0, hosted: 0, failed: 0 } };
  /** A pre-flight stub: one group, whose run() is `run` (default: instant OK). */
  const prepared = (run: PreparedImport['run'] = async () => OK, groups = 1): PreparedImport => ({ groups, planned: PLANNED, run });

  it('threads pacing, the snapped image profile, resume index and work-lock into the importer', async () => {
    let seen: ImportDeps | null = null;
    const workLock = createWorkLock();
    const b = build({
      settings: fakeStore({
        ...SETTINGS, importDelayMs: 900, importRetries: 4,
        convertJpeg: false, webpQuality: 82, avifQuality: 62,
      }),
      prepareImport: async (_xml, deps) => { seen = deps; return prepared(); },
      workLock,
    });
    const { cookie } = await authed(b);
    await postImport(b, cookie, wxrWith(...blocked(1)));
    // Deterministic, unlike timing the real gate — and it pins `retries`, which
    // no observable route behaviour can reach (every network-free failure mode is
    // deliberately non-retryable).
    expect(seen!.delayMs).toBe(900);
    expect(seen!.retries).toBe(4);
    expect(seen!.encoding).toEqual({ convertJpeg: false, webpQuality: 82, avifQuality: 62 });
    expect(seen!.resume).toBeDefined();
    // issue #94: the free-space probe reads the volume the images land on.
    expect(seen!.diskSpace).toBeDefined();
    const space = await seen!.diskSpace!();
    expect(space.total).toBeGreaterThan(0);
    // issue #95: the SAME lock instance the builder and encode queue hold, never a new one.
    expect(seen!.lock).toBe(workLock);
  });

  // issue #94: same status /upload uses for the same condition; the sanitized
  // message reaches the client, the numbers stay on stdout. Pre-flight refusals
  // happen BEFORE a job exists (issue #92), so /import/status stays empty.
  it('maps a refused-for-space import to a 507 carrying the sanitized message, with no job started', async () => {
    const b = build({ prepareImport: async () => { throw new ImportInsufficientSpaceError('not enough free disk space for this import (1.0 GB available, about 13 GB required for 640 photos)', 640, 1024 ** 3); } });
    const { cookie } = await authed(b);
    const res = await postImport(b, cookie, wxrWith(...blocked(1)));
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toMatch(/not enough free disk space for this import/);
    expect((await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json()).toEqual({ job: null });
    // and the route is not wedged
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(507);
  });

  // Issue #126: a re-run merges by default; the destructive rebuild is opt-in.
  it('passes overwriteDrafts to the importer only when the form says so', async () => {
    const seen: boolean[] = [];
    const b = build({ prepareImport: async (_xml, deps) => { seen.push(deps.overwriteDrafts === true); return prepared(); } });
    const { cookie } = await authed(b);
    for (const fields of [undefined, { overwriteDrafts: 'true' }, { overwriteDrafts: 'on' }]) { // anything but the literal 'true' is off
      expect((await postImport(b, cookie, wxrWith(...blocked(1)), fields)).statusCode).toBe(202);
      await b.importJobs.settle();
    }
    expect(seen).toEqual([false, true, false]);
  });

  // @ai-warning Resumability makes "just run the import again" the documented
  // recovery path, so concurrency stops being hypothetical. Two runs would both
  // see a mostly-empty resume index and both fetch everything, hit the source
  // host at 2x the configured rate, and race storeVariantFiles' non-atomic
  // writes into a mixed variant set. The runner owns the rule (issue #92).
  it('refuses a second import while one is still running, and shows it running on /import/status', async () => {
    let release = (): void => {};
    let entered = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { entered = r; });
    const b = build({ prepareImport: async () => prepared(async () => { entered(); await gate; return OK; }) });
    const { cookie } = await authed(b);
    const first = await postImport(b, cookie, wxrWith(...blocked(1)));
    expect(first.statusCode).toBe(202);
    await reached; // the job is provably mid-flight — no sleeps, no flake
    const second = await postImport(b, cookie, wxrWith(...blocked(1)));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already running/i);
    const live = (await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json().job;
    expect(live).toMatchObject({ id: first.json().id, status: 'running', summary: null });
    release();
    await b.importJobs.settle();
    const done = (await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json().job;
    expect(done).toMatchObject({ id: first.json().id, status: 'done', summary: OK });
  });

  it('accepts another import once the first has finished', async () => {
    const b = build(); const { cookie } = await authed(b);
    await importAndWait(b, cookie, wxrWith(...blocked(1)));
    await importAndWait(b, cookie, wxrWith(...blocked(1)));
  });

  // A throwing run() is unexpected (per-group and per-image failures are
  // already caught into the summary), so the job records `failed` with a fixed
  // message — never the raw error — and the slot is freed for the next import.
  it('records an unexpected run failure as a failed job with a sanitized message, and frees the slot', async () => {
    let calls = 0;
    const b = build({ prepareImport: async () => prepared(async () => { calls++; throw new Error('boom: connect ECONNREFUSED 10.0.0.5:5432'); }) });
    const { cookie } = await authed(b);
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(202);
    await b.importJobs.settle();
    const job = (await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json().job;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/failed unexpectedly/);
    expect(job.error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(202);
    await b.importJobs.settle();
    expect(calls).toBe(2); // the second request got through, i.e. the slot was released
  });

  // issue #96: an export whose distinct-image count exceeds the cap is rejected
  // BEFORE any fetch. The route must map that to a 400 naming the count, not a
  // 500 — the author needs to see that the export is too large, not a crash.
  it('rejects an over-cap import with a 400 naming the count, not a 500', async () => {
    const b = build({ prepareImport: async () => { throw new ImportTooLargeError(40400, 20000); } });
    const { cookie } = await authed(b);
    const res = await postImport(b, cookie, wxrWith(...blocked(1)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/would re-host 40400 distinct images, which exceeds the cap of 20000/);
  });

  it('400s an export with no groups from the pre-flight, before any job exists', async () => {
    const b = build({ prepareImport: async () => prepared(async () => OK, 0) });
    const { cookie } = await authed(b);
    const res = await postImport(b, cookie, wxrWith(...blocked(1)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no importable posts found in export');
    expect((await b.app.inject({ method: 'GET', url: '/import/status', cookies: cookie })).json()).toEqual({ job: null });
  });

  // The route-level resume wiring, end to end: pre-host the photo the export
  // references, then import an export whose URL the SSRF guard would REFUSE.
  // A hit is therefore the only way this can report hosted:1.
  it('resumes a photo already on disk instead of downloading it again', async () => {
    const b = build(); const { cookie } = await authed(b);
    const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const fetchImpl = (async () => new Response(new Uint8Array(jpg))) as unknown as typeof fetch;
    await rehostImage('https://seed/p0.jpg', rehostKey('imp-de', 'http://127.0.0.1/p0.jpg'), 'a',
      { storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });

    const summary = await importAndWait(b, cookie, wxrWith('http://127.0.0.1/p0.jpg'));
    expect(summary).toMatchObject({ images: { total: 1, hosted: 1, failed: 0 } });
  });
});

describe('POST /rebuild and GET /health', () => {
  // Copied from the `posts editor` describe block's post-pair fixture, used
  // by the existing publish tests.
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('health is public and reports the DB as up — free disk space only to an admin session (#132)', async () => {
    const b = build();
    const anon = await b.app.inject({ method: 'GET', url: '/health' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toMatchObject({ ok: true, db: true });
    // Watching /data fill up is reconnaissance for a disk-exhaustion attempt.
    expect(anon.json()).not.toHaveProperty('disk');
    const author = await authed(b, { isAdmin: false, username: 'writer' });
    expect((await b.app.inject({ method: 'GET', url: '/health', cookies: author.cookie })).json()).not.toHaveProperty('disk');
    const admin = await authed(b, { isAdmin: true, username: 'admin' });
    const res = await b.app.inject({ method: 'GET', url: '/health', cookies: admin.cookie });
    expect(res.statusCode).toBe(200);
    // #73: the volume's headroom is visible to the operator before it becomes an outage.
    expect(res.json().disk.free).toBeGreaterThan(0);
    expect(res.json().disk.freeLabel).toMatch(/^\d+(\.\d)? [kMGT]?B$/);
  });

  it('low disk space does NOT by itself flip the container unhealthy', async () => {
    // @ai-warning: a low-space 503 would trigger a restart loop, which makes a
    // full disk strictly worse. Free space is reported, never a verdict.
    const res = await build().app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('reports whether a release exists, as information — a missing one is not a verdict', async () => {
    // #110: a fresh volume has no release for the first minutes and a persistent
    // build failure is healed by a publish, not by a container restart.
    const none = build({ builder: { ...idleBuildState, build: async () => ({ ok: true, attemptId: 'r', release: 'r' }), hasRelease: () => false, quiesce: async () => {} } });
    const res = await none.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, release: false });
    expect((await build().app.inject({ method: 'GET', url: '/health' })).json().release).toBe(true);
  });

  it('health returns 503 without error detail when the DB probe fails', async () => {
    // Also pin the no-per-poll-logging property: the compose healthcheck fires
    // every 10s, so a failing probe must not spam docker logs.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const b = build({ dbCheck: async () => { throw new Error('connection refused: internal detail'); } });
      const res = await b.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, db: false });
      expect(JSON.stringify(res.json())).not.toContain('internal detail');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rebuild is admin-only', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'POST', url: '/rebuild' })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false });
    expect((await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie })).statusCode).toBe(403);
  });

  it('rebuild triggers the builder and returns its outcome', async () => {
    const s = stubBuilder({ ok: true, attemptId: 'r9', release: 'r9' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, attemptId: 'r9', release: 'r9' });
    expect(s.calls.length).toBe(1);
  });

  it('publish reports a failed build without unpublishing', async () => {
    const s = stubBuilder({ ok: false, attemptId: 'failed', code: 'build_failed', error: buildFailureMessage('build_failed') });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie, payload: await publishBody(b.posts, tk) });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toEqual({ ok: false, attemptId: 'failed', code: 'build_failed', error: buildFailureMessage('build_failed') });
  });
});

describe('backup routes', () => {
  it('are admin-only', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    for (const [method, url] of [['GET', '/backups'], ['POST', '/backups'], ['GET', '/backups/db-20260703-120000.json.gz'], ['GET', '/backups/images-20260703-120000.tar']] as const) {
      expect((await b.app.inject({ method, url })).statusCode).toBe(401);
      expect((await b.app.inject({ method, url, cookies: cookie })).statusCode).toBe(403);
    }
  });

  it('lists state + files + image archives and runs a backup on demand', async () => {
    const b = build({ dbBackup: stubBackup().backup });
    const { cookie } = await authed(b);
    const run = await b.app.inject({ method: 'POST', url: '/backups', cookies: cookie });
    expect(run.statusCode).toBe(200);
    expect(run.json().lastSuccessAt).toBe('s');
    const list = await b.app.inject({ method: 'GET', url: '/backups', cookies: cookie });
    expect(list.json().files[0].name).toBe('db-20260703-120000.json.gz');
    expect(list.json().imageArchives[0].name).toBe('images-20260703-120000.tar');
  });

  it('answers 409 to a second run while one is in flight, and reports running', async () => {
    const b = build({ dbBackup: stubBackup('/tmp/none', true).backup });
    const { cookie } = await authed(b);
    const run = await b.app.inject({ method: 'POST', url: '/backups', cookies: cookie });
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toMatch(/already running/);
    const list = await b.app.inject({ method: 'GET', url: '/backups', cookies: cookie });
    expect(list.json().running).toBe(true);
  });

  it('downloads only well-formed backup filenames from the backup dir', async () => {
    const backupDir = join(dir, 'dbbackups');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'db-20260703-120000.json.gz'), 'gzbytes');
    await writeFile(join(backupDir, 'images-20260703-120000.tar'), 'tarbytes');
    const b = build({ dbBackup: { ...stubBackup(backupDir).backup, dir: backupDir } });
    const { cookie } = await authed(b);
    const ok = await b.app.inject({ method: 'GET', url: '/backups/db-20260703-120000.json.gz', cookies: cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/gzip');
    expect(ok.headers['content-disposition']).toContain('attachment');
    const tarOk = await b.app.inject({ method: 'GET', url: '/backups/images-20260703-120000.tar', cookies: cookie });
    expect(tarOk.statusCode).toBe(200);
    expect(tarOk.headers['content-type']).toBe('application/x-tar');
    expect(tarOk.headers['content-disposition']).toContain('attachment');
    for (const evil of ['..%2Fsettings.json', 'state.json', 'db-1.json.gz', 'images-1.tar', 'images-20260703-120000.tar.gz']) {
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
    const s = stubBuilder({ ok: true, attemptId: 'r7', release: 'r7' });
    const b = build({ builder: s.builder });
    const body = {
      de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    };
    expect((await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', payload: body })).statusCode).toBe(401);
    const nonAdmin = await authed(b, { isAdmin: false, username: 'author' });
    expect((await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: nonAdmin.cookie, payload: body })).statusCode).toBe(403);
    const admin = await authed(b);
    const res = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved.de.title).toBe('Über mich');
    expect(res.json().build).toEqual({ ok: true, attemptId: 'r7', release: 'r7' });
    expect(s.calls.length).toBe(1);
  });

  it('PUT /pages/:key rejects an unsafe key with 400', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/Bad_Key', cookies: cookie, payload: { de: { locale: 'de', title: '', bodyMarkdown: '', images: {} }, en: { locale: 'en', title: '', bodyMarkdown: '', images: {} } } });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /pages/:key with a stale updatedAt echo is a 409 conflict that rebuilds nothing (#141)', async () => {
    const s = stubBuilder({ ok: true, attemptId: 'r8', release: 'r8' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const body = (title: string) => ({
      de: { locale: 'de', title, bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    });
    const first = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: cookie, payload: body('v1') });
    expect(first.statusCode).toBe(200);
    const loaded = first.json().saved.updatedAt;
    expect(typeof loaded).toBe('string');
    // Tab A saves with the echo it loaded — accepted and the echo advances.
    const second = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: cookie, payload: { ...body('v2'), updatedAt: loaded } });
    expect(second.statusCode).toBe(200);
    expect(new Date(second.json().saved.updatedAt).getTime()).toBeGreaterThan(new Date(loaded).getTime());
    // Tab B still holds the old echo — refused, nothing written, no rebuild.
    const stale = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: cookie, payload: { ...body('v3'), updatedAt: loaded } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict' });
    expect((await b.pages.get('about')).de.title).toBe('v2');
    expect(s.calls.length).toBe(2);
    // Garbage echo → 400, not a silent skip of the check.
    const bad = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: cookie, payload: { ...body('v4'), updatedAt: 'yesterday' } });
    expect(bad.statusCode).toBe(400);
    // GET carries the echo the page needs.
    expect((await b.app.inject({ method: 'GET', url: '/pages/about', cookies: cookie })).json().updatedAt).toBe(second.json().saved.updatedAt);
  });

  it('page revisions: every overwrite is listed newest-first and restorable; unknown ids 404 (#141)', async () => {
    const b = build();
    const admin = await authed(b);
    const body = (title: string) => ({
      de: { locale: 'de', title, bodyMarkdown: 'Hallo ' + title, images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    });
    for (const t of ['v1', 'v2', 'v3']) {
      expect((await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: body(t) })).statusCode).toBe(200);
    }
    expect((await b.app.inject({ method: 'GET', url: '/pages/about/revisions' })).statusCode).toBe(401);
    // Read-only history is author-visible, like GET /pages/:key.
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const list = await b.app.inject({ method: 'GET', url: '/pages/about/revisions', cookies: author.cookie });
    expect(list.statusCode).toBe(200);
    // The first save of a key produces no revision; v1 and v2 were overwritten.
    expect(list.json().map((r: { title: string }) => r.title)).toEqual(['v2', 'v1']);
    const rev = await b.app.inject({ method: 'GET', url: `/pages/about/revisions/${list.json()[1].id}`, cookies: author.cookie });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().snapshot.de.bodyMarkdown).toBe('Hallo v1');
    expect((await b.app.inject({ method: 'GET', url: '/pages/about/revisions/not-a-uuid', cookies: author.cookie })).statusCode).toBe(404);
    for (const key of ['contact', 'other']) {
      expect((await b.app.inject({ method: 'GET', url: `/pages/${key}/revisions`, cookies: author.cookie })).statusCode).toBe(404);
      expect((await b.app.inject({ method: 'GET', url: `/pages/${key}/revisions/${list.json()[1].id}`, cookies: author.cookie })).statusCode).toBe(404);
    }
    const restored = await injectAuthoring(b.app, { method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: rev.json().snapshot });
    expect(restored.statusCode).toBe(200);
    expect((await b.pages.get('about')).de.bodyMarkdown).toBe('Hallo v1');
    const afterRestore = await b.app.inject({ method: 'GET', url: '/pages/about/revisions', cookies: author.cookie });
    expect(afterRestore.json().map((r: { title: string }) => r.title)).toEqual(['v3', 'v2', 'v1']);
  });
});

describe('GET /posts/:tk/preview', () => {
  const draft = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 } },
    de: { locale: 'de', slug: 'bukarest', title: 'Entwurf Bukarest', excerpt: 'e', country: 'Rumänien', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## Anreise', images: {} },
    en: { locale: 'en', slug: 'bucharest', title: 'Bucharest draft', excerpt: 'e', country: 'Romania', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## Arrival', images: {} },
  });

  it('401 without auth', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/posts/whatever/preview' });
    expect(res.statusCode).toBe(401);
  });

  it('renders a DRAFT as text/html for an authed non-admin author', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=de`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Entwurf Bukarest');
    expect(res.body).toContain('<h2 id="anreise">Anreise</h2>');
  });

  it('defaults to the DE locale and honors locale=en', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const de = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview`, cookies: cookie });
    expect(de.body).toContain('Entwurf Bukarest');
    const en = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=en`, cookies: cookie });
    expect(en.body).toContain('Bucharest draft');
  });

  it('404 for an unknown translation key', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url: '/posts/nope/preview', cookies: cookie });
    expect(res.statusCode).toBe(404);
  });

  it('400 for an unsupported locale', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=fr`, cookies: cookie });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the admin security headers (/posts prefix)', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=de`, cookies: cookie });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // Issue #124: author markup renders on the admin origin here, so the reply
  // carries a deny-by-default policy — only the app's own images and the
  // page's inline styles are allowed.
  it('sends a CSP that allows only base-origin images and inline styles', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=de`, cookies: cookie });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' https://img.simonswanderlust.com");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src');
    // Other admin JSON routes stay without one — the policy is preview-specific.
    const list = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
    expect(list.headers['content-security-policy']).toBeUndefined();
  });

  // 2026-10-19 gallery-library-metadata spec: the draft preview shows the
  // CURRENT Media alt/caption for library gallery photos, like the next build.
  describe('gallery descriptions follow the Media library', () => {
    const IMG = 'https://img.simonswanderlust.com';
    const lib = `${IMG}/trips/gal/lib`;
    const legacy = `${IMG}/trips/gal/legacy`;
    const withGallery = () => {
      const p = draft();
      p.de.bodyMarkdown = '```gallery\n'
        + `${lib} | 1600x1200 | alt="Kopie DE" | caption="Kopie Text DE"\n`
        + `${legacy} | 1600x1200 | alt="WordPress DE" | caption="WordPress Text DE"\n`
        + '```';
      p.en.bodyMarkdown = '```gallery\n' + `${lib} | 1600x1200 | alt="Copy EN" | caption="Copy text EN"\n` + '```';
      return p;
    };
    const seedLib = (media: MediaStore) => media.upsert({
      key: 'trips/gal/lib', status: 'ready', width: 1600, height: 1200, origBytes: 1, uploadedBy: 'simon',
      exif: { takenAt: null, camera: 'SECRET-CAM', lens: null, lat: 63.0759, lng: 10.3887 },
      title: 'Library title only', alt: { de: 'Bibliothek DE', en: 'Library EN' }, caption: { de: 'Text DE', en: 'Text EN' },
    });

    it('renders library text per locale, keeps a missing row\'s copy, and follows a Media patch without a post save', async () => {
      const b = build();
      const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
      await seedLib(b.media);
      const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: withGallery() });
      expect(created.statusCode).toBe(200);
      const tk = created.json().translationKey;
      const preview = async (locale: 'de' | 'en') =>
        (await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=${locale}`, cookies: cookie })).body;

      const de = await preview('de');
      expect(de).toContain('alt="Bibliothek DE"');
      expect(de).toContain('>Text DE</figcaption>');
      expect(de).not.toContain('Kopie');
      expect(de).toContain('alt="WordPress DE"'); // no media row → stored copy
      expect(de).toContain('WordPress Text DE');
      expect(de).toContain('alt="a"');             // hero alt is the post's own
      expect(de).not.toMatch(/Library title only|SECRET-CAM|63\.07|Library EN/);
      const en = await preview('en');
      expect(en).toContain('alt="Library EN"');
      expect(en).toContain('>Text EN</figcaption>');
      expect(en).not.toMatch(/Copy|Bibliothek DE/);

      // Blank the DE library fields in Media only — no post save in between.
      const patched = await b.app.inject({
        method: 'PATCH', url: '/media/items/trips/gal/lib', cookies: cookie,
        headers: { 'content-type': 'application/json' },
        payload: { conditional: { version: 1, patch: { alt: { de: '' }, caption: { de: '' } },
          expect: { alt: { de: 'Bibliothek DE' }, caption: { de: 'Text DE' } } } },
      });
      expect(patched.statusCode).toBe(200);
      const after = await preview('de');
      expect(after).not.toContain('Bibliothek DE');
      expect(after).not.toContain('>Text DE</figcaption>');
      expect(after).not.toContain('Kopie');          // a blank library field is not a fallback trigger
      expect(after).toContain('alt="WordPress DE"');
      expect(await preview('en')).toContain('alt="Library EN"');
      // Nothing was written back to the post.
      const stored = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
      expect(stored.de.images[lib]).toMatchObject({ alt: 'Kopie DE', caption: 'Kopie Text DE' });
    });

    it('answers a sanitized 500 when the media store fails, never stale copies or the raw error', async () => {
      const media = memoryMediaStore({ baseUrl: IMG });
      const failing: MediaStore = { ...media, descriptions: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } };
      const b = build({ media: failing });
      const { cookie } = await authed(b);
      const created = await injectAuthoring(b.app, { method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: withGallery() });
      const tk = created.json().translationKey;
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=de`, cookies: cookie });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ error: 'internal server error' });
        expect(res.body).not.toMatch(/Kopie|ECONNREFUSED|10\.0\.0\.5/);
        const audit = await b.app.inject({ method: 'GET', url: `/posts/${tk}/alt-audit`, cookies: cookie });
        expect(audit.statusCode).toBe(500);
        expect(audit.body).not.toContain('ECONNREFUSED');
      } finally { quiet.mockRestore(); }
    });
  });
});

describe('editor geocoding boundary', () => {
  it('requires a session, validates query text, and leaves disabled lookup available only as manual entry', async () => {
    const b = build({ settings: fakeStore({ ...SETTINGS, geocodingSearchUrl: '' }) });
    try {
      expect((await b.app.inject({ method: 'POST', url: '/geocode', payload: { query: 'Cancun' } })).statusCode).toBe(401);
      const { cookie } = await authed(b, { isAdmin: false });
      const invalid = await b.app.inject({ method: 'POST', url: '/geocode', cookies: cookie, payload: { query: { url: 'https://evil.example' } } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ code: 'invalid_query' });
      const disabled = await b.app.inject({ method: 'POST', url: '/geocode', cookies: cookie, payload: { query: 'Cancun' } });
      expect(disabled.statusCode).toBe(503);
      expect(disabled.json()).toEqual({ code: 'lookup_disabled' });
      expect(disabled.headers['cache-control']).toBe('no-store');
      expect((await b.app.inject({ method: 'POST', url: '/settings', cookies: cookie, payload: { geocodingSearchUrl: 'https://example.com/search' } })).statusCode).toBe(403);
    } finally { await b.app.close(); }
  });

  it('lets an admin switch or disable the persisted endpoint, but rejects unsafe configuration', async () => {
    const store = fakeStore();
    const b = build({ settings: store });
    try {
      const { cookie } = await authed(b);
      const change = (geocodingSearchUrl: string) => b.app.inject({
        method: 'POST', url: '/settings', cookies: cookie, payload: { geocodingSearchUrl },
      });
      expect((await change('https://geocode.example/search')).statusCode).toBe(200);
      expect(store.get().geocodingSearchUrl).toBe('https://geocode.example/search');
      expect((await change('http://geocode.example/search')).statusCode).toBe(400);
      expect(store.get().geocodingSearchUrl).toBe('https://geocode.example/search');
      expect((await change('')).statusCode).toBe(200);
      expect((await b.app.inject({ method: 'POST', url: '/geocode', cookies: cookie, payload: { query: 'Cancun' } })).statusCode).toBe(503);
    } finally { await b.app.close(); }
  });
});

describe('POST /settings/image-preview', () => {
  /** A JPEG with camera tags AND a GPS IFD (see pipeline.test.ts). */
  async function gpsJpeg(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: '#5a7' } })
      .withExif({
        IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
        IFD3: {
          GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
          GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
        },
      })
      .jpeg()
      .toBuffer();
  }

  async function preview(
    b: Pick<Built, 'app'>,
    cookie: { sid: string } | undefined,
    fields: { format?: string; quality?: string },
    img?: Buffer,
    extraFile?: Buffer,
  ) {
    const form = new FormData();
    if (fields.format !== undefined) form.append('format', fields.format);
    if (fields.quality !== undefined) form.append('quality', fields.quality);
    form.append('file', img ?? await gpsJpeg(400, 300), { filename: 'secret-place.jpg', contentType: 'image/jpeg' });
    if (extraFile) form.append('file', extraFile, { filename: 'b.jpg', contentType: 'image/jpeg' });
    return b.app.inject({
      method: 'POST', url: '/settings/image-preview',
      headers: form.getHeaders(), ...(cookie ? { cookies: cookie } : {}), payload: form,
    });
  }

  it('is admin-only: 401 anonymous, 403 author, 200 admin', async () => {
    const b = build();
    expect((await preview(b, undefined, { format: 'webp', quality: '75' })).statusCode).toBe(401);
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await preview(b, author.cookie, { format: 'webp', quality: '75' })).statusCode).toBe(403);
    const admin = await authed(b, { username: 'admin' });
    expect((await preview(b, admin.cookie, { format: 'webp', quality: '75' })).statusCode).toBe(200);
  });

  it('returns the encoded WebP at the largest standard width, with size headers and no-store', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await preview(b, cookie, { format: 'webp', quality: '60' }, await gpsJpeg(2400, 1200));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-preview-width']).toBe('1920');
    expect(res.headers['x-preview-height']).toBe('960');
    expect(res.headers['x-original-width']).toBe('2400');
    expect(res.headers['x-original-height']).toBe('1200');
    const meta = await sharp(res.rawPayload).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: 'webp', width: 1920, height: 960 });
  });

  it('returns AVIF at the intrinsic width when the photo is smaller, never upscaling', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await preview(b, cookie, { format: 'avif', quality: '55' }, await gpsJpeg(400, 300));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/avif');
    expect([res.headers['x-preview-width'], res.headers['x-preview-height']]).toEqual(['400', '300']);
    const meta = await sharp(res.rawPayload).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: 'heif', width: 400, height: 300 });
  });

  it('strips all EXIF, GPS included, and writes nothing to disk or the media library', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const before = await readdir(dir);
    for (const format of ['webp', 'avif']) {
      const res = await preview(b, cookie, { format, quality: '50' });
      expect(res.statusCode).toBe(200);
      expect((await sharp(res.rawPayload).metadata()).exif, `${format} carried EXIF`).toBeUndefined();
    }
    expect(await readdir(dir)).toEqual(before);
    expect((await b.media.list({})).items).toEqual([]);
  });

  it.each(['avif', 'svg'] as const)('decodes %s preview input without retaining metadata or writing media', async (source) => {
    const b = build();
    const { cookie } = await authed(b);
    const input = source === 'avif'
      ? await sharp(await gpsJpeg(300, 200)).withMetadata().avif().toBuffer()
      : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#5a7"/></svg>');
    if (source === 'avif') expect((await sharp(input).metadata()).exif).toBeDefined();
    const before = await readdir(dir);
    // Decoder selection follows bytes, not the caller's untrusted MIME label.
    const result = await preview(b, cookie, { format: 'webp', quality: '60' }, input);
    expect(result.statusCode).toBe(200);
    const meta = await sharp(result.rawPayload).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height, exif: meta.exif })
      .toEqual({ format: 'webp', width: 300, height: 200, exif: undefined });
    const pixel = await sharp(result.rawPayload).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    for (const [index, expected] of [85, 170, 119].entries()) {
      expect(Math.abs(pixel[index]! - expected)).toBeLessThan(25);
    }
    expect(await readdir(dir)).toEqual(before);
    expect((await b.media.list({})).items).toEqual([]);
  });

  it('accepts quality 1 and 100, and refuses anything else with a fixed message', async () => {
    const b = build();
    const { cookie } = await authed(b);
    for (const quality of ['1', '100']) {
      expect((await preview(b, cookie, { format: 'webp', quality })).statusCode).toBe(200);
    }
    for (const quality of ['0', '101', '50.5', '-5', 'abc', '']) {
      const res = await preview(b, cookie, { format: 'webp', quality });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Quality must be a whole number from 1 to 100.' });
    }
    for (const format of ['jpeg', 'WEBP', '']) {
      const res = await preview(b, cookie, { format, quality: '50' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Format must be webp or avif.' });
    }
  });

  it('400s an undecodable file without echoing anything about it', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await preview(b, cookie, { format: 'webp', quality: '75' }, Buffer.from('not an image at all'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Could not read that image.' });
  });

  it('413s a second file part, like /upload', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await preview(b, cookie, { format: 'webp', quality: '75' }, await gpsJpeg(100, 100), await gpsJpeg(100, 100));
    expect(res.statusCode).toBe(413);
  });

  it('waits on the shared work-lock and refuses a concurrent preview with 429', async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const real = createWorkLock();
    const workLock: WorkLock = {
      ...real,
      runShared: async (fn) => { reached.resolve(); await gate.promise; return real.runShared(fn); },
    };
    const b = build({ workLock });
    const { cookie } = await authed(b);
    const first = preview(b, cookie, { format: 'webp', quality: '75' });
    await reached.promise;
    const second = await preview(b, cookie, { format: 'webp', quality: '75' });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: 'A preview is already running. Try again in a moment.' });
    gate.resolve();
    expect((await first).statusCode).toBe(200);
    // The slot is released once the first finishes.
    expect((await preview(b, cookie, { format: 'webp', quality: '75' })).statusCode).toBe(200);
  });
});

describe('admin onboarding metadata boundary', () => {
  const initial: OnboardingState = {
    schemaVersion: 1, state: 'eligible', reason: 'fresh',
    evaluatedAt: '2026-10-27T12:00:00.000Z', dismissedAt: null, retiredAt: null,
  };
  const empty: OnboardingProgress = {
    identity: false, ready: false, processing: false, attention: false,
    story: false, published: false, newest: null, newestDraft: null,
  };
  it('requires admin for reads/actions before consulting state and does not issue cookies', async () => {
    const onboarding = memoryOnboardingStore({ state: initial, progress: () => empty });
    const read = vi.spyOn(onboarding, 'read');
    const act = vi.spyOn(onboarding, 'act');
    const b = build({ onboarding });
    try {
      for (const method of ['GET', 'POST'] as const) {
        const res = await b.app.inject({ method, url: '/onboarding', ...(method === 'POST' ? { payload: { action: 'dismiss' } } : {}) });
        expect(res.statusCode).toBe(401);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      const author = await authed(b, { isAdmin: false });
      for (const method of ['GET', 'POST'] as const) {
        const res = await b.app.inject({ method, url: '/onboarding', cookies: author.cookie, ...(method === 'POST' ? { payload: { action: 'dismiss' } } : {}) });
        expect(res.statusCode).toBe(403);
      }
      expect(read).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
    } finally { await b.app.close(); }
  });
  it('shares hide/show across admins, preserves auth status shape and has no content/account/build side effects', async () => {
    const progress = { ...empty, ready: true, story: true, published: true };
    const onboarding = memoryOnboardingStore({ state: initial, progress: () => progress });
    const builder = stubBuilder();
    const b = build({ onboarding, builder: builder.builder });
    try {
      const first = await authed(b, { username: 'first' });
      const second = await authed(b, { username: 'second' });
      const mutations = [
        vi.spyOn(b.users, 'create'), vi.spyOn(b.sessions, 'create'),
        vi.spyOn(b.posts, 'upsertDraft'), vi.spyOn(b.posts, 'publish'),
        vi.spyOn(b.pages, 'save'), vi.spyOn(b.media, 'upsert'),
      ];
      const post = (action: string) => b.app.inject({ method: 'POST', url: '/onboarding', cookies: first.cookie, payload: { action } });
      expect((await post('dismiss')).json()).toMatchObject({ status: 'dismissed', complete: true });
      expect((await b.app.inject({ url: '/onboarding', cookies: second.cookie })).json()).toMatchObject({ status: 'dismissed' });
      expect((await post('resume')).json()).toMatchObject({ status: 'open' });
      const finish = await post('finish');
      expect(finish.json()).toEqual({ status: 'retired' });
      expect(finish.headers['set-cookie']).toBeUndefined();
      expect((await post('resume')).statusCode).toBe(409);
      expect((await b.app.inject({ url: '/onboarding', cookies: second.cookie })).json()).toEqual({ status: 'retired' });
      const status = await b.app.inject({ url: '/auth/status', cookies: first.cookie });
      expect(status.json()).toEqual({ authenticated: true, username: 'first', isAdmin: true, needsSetup: false });
      expect(mutations.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect(builder.calls).toEqual([]);
    } finally { await b.app.close(); }
  });
  it('strictly rejects action shapes, enforces the body cap and rechecks completion', async () => {
    const b = build({ onboarding: memoryOnboardingStore({ state: initial, progress: () => empty }) });
    try {
      const { cookie } = await authed(b);
      for (const payload of [{}, [], { action: 'reset' }, { action: 'dismiss', extra: true }, { action: null }]) {
        const res = await b.app.inject({ method: 'POST', url: '/onboarding', cookies: cookie, payload });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_onboarding_action' });
      }
      const large = await b.app.inject({ method: 'POST', url: '/onboarding', cookies: cookie, payload: { action: 'x'.repeat(1025) } });
      expect(large.statusCode).toBe(413);
      const finish = await b.app.inject({ method: 'POST', url: '/onboarding', cookies: cookie, payload: { action: 'finish' } });
      expect(finish.statusCode).toBe(409);
      expect(finish.json()).toEqual({ error: 'onboarding_incomplete' });
    } finally { await b.app.close(); }
  });
  it('fails closed for absent state, DB failure and owner loss without borrowing the login limiter', async () => {
    const onboarding = memoryOnboardingStore({ state: null, progress: () => empty });
    const loginLimiter = { check: vi.fn(() => true) };
    let writable = true;
    const b = build({ onboarding, loginLimiter, isWritable: () => writable });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { cookie } = await authed(b);
      expect((await b.app.inject({ url: '/onboarding', cookies: cookie })).statusCode).toBe(500);
      vi.spyOn(onboarding, 'read').mockRejectedValue(new Error('private DB details'));
      const failed = await b.app.inject({ url: '/onboarding', cookies: cookie });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('private DB details');
      writable = false;
      const refused = await b.app.inject({ method: 'POST', url: '/onboarding', cookies: cookie, payload: { action: 'dismiss' } });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ error: 'storage_read_only' });
      expect(loginLimiter.check).not.toHaveBeenCalled();
    } finally { log.mockRestore(); await b.app.close(); }
  });
});

describe('write reconciliation HTTP trust boundaries (#305)', () => {
  const draft = () => ({
    translationKey: randomUUID(), shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: '', title: 'Draft', country: '', excerpt: '', bodyMarkdown: 'Local text', images: {} },
    en: { locale: 'en', slug: '', title: '', country: '', excerpt: '', bodyMarkdown: '', images: {} },
  });
  it('refuses missing identities and wrong captured owners before post/page mutation or rebuild', async () => {
    const builder = stubBuilder(); const b = build({ builder: builder.builder });
    const a = await authed(b, { username: 'owner-a' }); const other = await authed(b, { username: 'owner-b' });
    const saveId = randomUUID(); const input = draft();
    expect((await b.app.inject({ method: 'POST', url: '/posts', cookies: a.cookie, payload: input })).statusCode).toBe(400);
    const refused = await b.app.inject({ method: 'POST', url: '/posts', cookies: other.cookie,
      payload: { ...input, saveId, expectedOwnerId: a.user.id } });
    expect(refused.statusCode).toBe(403); expect(refused.json()).toMatchObject({ code: 'owner_changed' });
    expect(await b.posts.list()).toEqual([]);
    const page = await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: other.cookie,
      payload: { de: { title: 'Private A', bodyMarkdown: 'Do not write', images: {} }, en: {}, updatedAt: null, saveId, expectedOwnerId: a.user.id } });
    expect(page.statusCode).toBe(403); expect(await b.pages.keys()).toEqual([]); expect(builder.calls).toEqual([]);
    await b.app.close();
  });
  it('keeps a lost create recognizable, create-only and writer-private even with empty slugs', async () => {
    const b = build(); const a = await authed(b, { username: 'writer' }); const other = await authed(b, { username: 'reader' });
    const input = { ...draft(), saveId: randomUUID(), expectedOwnerId: a.user.id };
    const first = await b.app.inject({ method: 'POST', url: '/posts', cookies: a.cookie, payload: input });
    expect(first.statusCode).toBe(200);
    const repeated = await b.app.inject({ method: 'POST', url: '/posts', cookies: a.cookie, payload: input });
    expect(repeated.statusCode).toBe(409); expect(repeated.json()).toMatchObject({ code: 'already_exists' });
    const own = await b.app.inject({ url: `/posts/${input.translationKey}`, cookies: a.cookie });
    expect(own.json()).toMatchObject({ ownerUserId: a.user.id, lastSaveId: input.saveId, updatedAt: first.json().updatedAt, de: { title: 'Draft' } });
    expect(own.headers['cache-control']).toBe('no-store');
    const foreign = await b.app.inject({ url: `/posts/${input.translationKey}`, cookies: other.cookie });
    expect(foreign.json()).toMatchObject({ ownerUserId: other.user.id, lastSaveId: null });
    expect(await b.posts.list()).toHaveLength(1);
    await b.app.close();
  });
  it('rejects missing/mismatched upload identity without retaining originals or media', async () => {
    const b = build(); const a = await authed(b); const other = randomUUID();
    for (const expectedOwnerId of [undefined, other]) {
      const form = new FormData();
      form.append('file', await jpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
      if (expectedOwnerId) {
        form.append('expectedOwnerId', expectedOwnerId); form.append('uploadId', randomUUID()); form.append('retryGeneration', '0');
      }
      const result = await b.app.inject({ method: 'POST', url: '/upload', cookies: a.cookie, headers: form.getHeaders(), payload: form });
      expect(result.statusCode).toBe(expectedOwnerId ? 403 : 400);
    }
    expect((await b.media.list({})).total).toBe(0); expect(await readdir(dir)).toEqual([]);
    await b.app.close();
  });
  it('probes exactly selected keys outside listing pagination without private metadata', async () => {
    const b = build(); const a = await authed(b, { isAdmin: false });
    for (let i = 0; i < 205; i++) await b.media.upsert({ key: `photos/p${i}`, folder: i === 204 ? 'Moved' : '',
      width: 8, height: 6, origBytes: 20, status: 'ready', uploadedBy: a.user.id,
      exif: { takenAt: null, camera: 'Camera', lens: null, lat: 12, lng: 13 } });
    const result = await b.app.inject({ method: 'POST', url: '/media/lookup', cookies: a.cookie,
      payload: { keys: ['photos/p204', 'photos/deleted'] } });
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toEqual({ items: [{ key: 'photos/p204', folder: 'Moved' }, { key: 'photos/deleted', missing: true }] });
    for (const keys of [[], ['photos/p1', 'photos/p1'], ['../secret'], Array.from({ length: 101 }, (_, i) => `photos/p${i}`)]) {
      expect((await b.app.inject({ method: 'POST', url: '/media/lookup', cookies: a.cookie, payload: { keys } })).statusCode).toBe(400);
    }
    expect((await b.app.inject({ method: 'POST', url: '/media/lookup', payload: { keys: ['photos/p204'] } })).statusCode).toBe(401);
    await b.app.close();
  });
});
