import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BackupState, DbBackup } from '../src/backup.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';
import { memoryUserStore, type UserStore } from '../src/users.js';
import { memorySessionStore, type SessionStore } from '../src/sessions.js';
import { memoryPostStore, type PostStore } from '../src/posts.js';
import { memoryPageStore, type PageStore } from '../src/pages.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import { BacklogFullError, createEncodeQueue, type EncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { fixedWindowLimiter } from '../src/rate-limit.js';
import type { SiteBuilder, BuildOutcome } from '../src/build.js';

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

function stubBuilder(outcome: BuildOutcome = { ok: true, release: 'r1' }) {
  const calls: number[] = [];
  return {
    calls,
    builder: {
      build: async () => { calls.push(1); return outcome; },
      hasRelease: () => true,
    } satisfies SiteBuilder,
  };
}

function stubBackup(dir = '/tmp/none') {
  let state: BackupState = {};
  const backup: DbBackup = {
    dir,
    runNow: async () => { state = { lastAttemptAt: 'a', lastSuccessAt: 's' }; return { ...state }; },
    list: () => [{ name: 'db-20260703-120000.json.gz', size: 3 }],
    listImageArchives: () => [{ name: 'images-20260703-120000.tar', size: 7 }],
    state: () => ({ ...state }),
  };
  return { backup };
}

/**
 * An encode queue that records what was enqueued instead of running sharp —
 * the real encoder is covered in encode-queue.test.ts, and a 19s-per-frame
 * pipeline has no place in the route suite.
 */
function stubQueue(opts: { full?: boolean } = {}) {
  const enqueued: string[] = [];
  const queue: EncodeQueue = {
    enqueue: (key) => {
      if (opts.full) throw new BacklogFullError();
      enqueued.push(key);
    },
    recover: async () => 0,
    drain: async () => {},
    stats: () => ({ pending: enqueued.length, running: 0 }),
  };
  return { enqueued, queue };
}

interface Built {
  app: ReturnType<typeof buildServer>; users: UserStore; sessions: SessionStore;
  posts: PostStore; media: MediaStore; enqueued: string[];
}
function build(extra: Partial<ServerConfig> = {}): Built {
  const users = (extra.users as UserStore) ?? memoryUserStore();
  const sessions = (extra.sessions as SessionStore) ?? memorySessionStore();
  const posts = (extra.posts as PostStore) ?? memoryPostStore();
  const media = (extra.media as MediaStore) ?? memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' });
  const q = stubQueue();
  const encodeQueue = (extra.encodeQueue as EncodeQueue) ?? q.queue;
  const built = buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings: fakeStore(),
    posts, media, encodeQueue,
    imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'),
    builder: (extra.builder as SiteBuilder) ?? stubBuilder().builder,
    backupDir: dir + '/backup',
    dbBackup: (extra.dbBackup as DbBackup) ?? stubBackup().backup,
    pages: (extra.pages as PageStore) ?? memoryPageStore(),
    dbCheck: async () => {},
    ...extra,
  });
  return { app: built, users, sessions, posts, media, enqueued: q.enqueued };
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
  return { ...b, media, settle: () => queue.drain() };
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
  return b.app.inject({
    method: 'POST', url: '/upload',
    headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
  });
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
    expect((await b.app.inject({ method: 'GET', url: `/${key}-640.webp`, headers: img })).statusCode).toBe(200);
    // ...but the full-resolution original is not downloadable.
    expect((await b.app.inject({ method: 'GET', url: `/${key}-orig.jpg`, headers: img })).statusCode).toBe(404);
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

  it('derives a storage key from the filename when the client sends none', async () => {
    // Bulk library upload has no post slug, and KEY_RE is lowercase-only — a
    // Leica's L1002345.JPG would otherwise be a 400.
    const b = build();
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { filename: 'L1002345.JPG' });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toMatch(/^library\/\d{4}\/l1002345-[0-9a-f]{8}$/);
  });

  it('429s when the encode backlog is full', async () => {
    const b = build({ encodeQueue: stubQueue({ full: true }).queue });
    const { cookie } = await authed(b);
    const res = await upload(b, cookie, { key: 'trips/full/hero' });
    expect(res.statusCode).toBe(429);
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
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
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
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    expect(created.statusCode).toBe(200);
    const res = await b.app.inject({ method: 'GET', url: '/media', cookies: cookie });
    expect(res.json().items[0].usedIn).toEqual([
      { kind: 'post', key: created.json().translationKey, title: 'Mediennutzer' },
    ]);
  });

  it('PATCH /media/items/* edits metadata and is author-accessible', async () => {
    const b = buildEncoding();
    const author = await authed(b, { isAdmin: false, username: 'author' });
    const { storedKey } = await put(b, author.cookie, 'trips/edit/hero');
    const res = await b.app.inject({
      method: 'PATCH', url: `/media/items/${storedKey}`, cookies: author.cookie,
      headers: { 'content-type': 'application/json' },
      payload: { title: 'Sonnenaufgang', alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3' }, tags: ['island', 'island', ' '] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Sonnenaufgang', alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3' },
      tags: ['island'],
    });
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
    await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
    const res = await b.app.inject({ method: 'DELETE', url: `/media/items/${storedKey}`, cookies: cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().usedIn).toHaveLength(1);
    expect(existsSync(join(dir, `${storedKey}-640.webp`))).toBe(true);
  });

  it('DELETE /media/items/* still 409s for a stranded single-locale row (get() → null)', async () => {
    const b = buildEncoding();
    const { cookie } = await authed(b);
    const { src, storedKey } = await put(b, cookie, 'trips/stranded/hero');
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draftUsing(src) });
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
      { kind: 'post', key: created.json().translationKey, title: 'Mediennutzer' },
    ]);
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

  it('POST /media/rescan is admin-only', async () => {
    const b = build({ mediaSync: { run: async () => ({ scanned: 1, inserted: 0, altHarvested: 0, markedMissing: 0 }) } });
    const author = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'POST', url: '/media/rescan', cookies: author.cookie })).statusCode).toBe(403);
    const admin = await authed(b, { username: 'boss' });
    const res = await b.app.inject({ method: 'POST', url: '/media/rescan', cookies: admin.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scanned: 1 });
  });

  it('the whole /media surface carries the admin security headers', async () => {
    // '/media' must be in ADMIN_PREFIXES or the new API silently loses
    // X-Frame-Options and Referrer-Policy.
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url: '/media', cookies: cookie });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('buildServer config', () => {
  it('boots with a relative storageDir (resolves it to absolute)', async () => {
    const rel = relative(process.cwd(), dir);
    const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', users: memoryUserStore(), sessions: memorySessionStore(), settings: fakeStore(), posts: memoryPostStore(), pages: memoryPageStore(), media: memoryMediaStore({ baseUrl: 'https://img.simonswanderlust.com' }), encodeQueue: stubQueue().queue, imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'), builder: stubBuilder().builder, backupDir: dir + '/backup', dbBackup: stubBackup().backup, dbCheck: async () => {} });
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
    expect(res.json()).toEqual(SETTINGS);
  });

  it('POST /settings is admin-only: 403 for authors', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { backupSchedule: 'daily' },
    });
    expect(res.statusCode).toBe(403);
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
      lmBaseUrl: 'http://localhost:1234/v1',
      lmModel: 'qwen/qwen3-vl-4b',
      captionTimeoutMs: 60000,
      captionMaxEdge: 768,
    });
    expect(body.captionPrompt).toBeTruthy();
    expect(body).not.toHaveProperty('backupSchedule');
    expect(body).not.toHaveProperty('backupRetention');
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

  it('400 on an invalid lmBaseUrl', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmBaseUrl: 'not a url' },
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

describe('POST /users/me/password (change password)', () => {
  const change = (b: Built, cookie: Record<string, string> | undefined, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/users/me/password', headers: { 'content-type': 'application/json' }, ...(cookie ? { cookies: cookie } : {}), payload });

  it('401 unauthenticated', async () => {
    const res = await change(build(), undefined, { currentPassword: 'pw', newPassword: 'new-pw' });
    expect(res.statusCode).toBe(401);
  });

  it('400 when a field is missing or empty', async () => {
    const b = build();
    const { cookie } = await authed(b);
    expect((await change(b, cookie, { newPassword: 'new-pw' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'pw', newPassword: '' })).statusCode).toBe(400);
  });

  it('400 (not 401 — admin JS redirects on 401) on a wrong current password', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await change(b, cookie, { currentPassword: 'wrong', newPassword: 'new-pw' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('current password is incorrect');
  });

  it('changes the password, invalidates other sessions, keeps the caller logged in', async () => {
    const b = build();
    const { user, cookie } = await authed(b); // password 'pw'
    const otherToken = await b.sessions.create(user.id, 60_000);
    const res = await change(b, cookie, { currentPassword: 'pw', newPassword: 'brand-new' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Old password no longer logs in; the new one does.
    const login = (password: string) =>
      b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: user.username, password } });
    expect((await login('pw')).statusCode).toBe(401);
    expect((await login('brand-new')).statusCode).toBe(200);
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
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(400);
    expect((await change(b, cookie, { currentPassword: 'wrong', newPassword: 'x' })).statusCode).toBe(429);
  });

  it('limitAuth runs before requireAuth: unauthenticated requests consume the limiter too', async () => {
    // First unauthenticated hit passes the limiter (consuming its one slot) and
    // fails auth with 401; the second is cut off by the limiter with 429. This
    // pins the preHandler order the brute-force defense relies on.
    const b = build({ loginLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    expect((await change(b, undefined, { currentPassword: 'x', newPassword: 'y' })).statusCode).toBe(401);
    expect((await change(b, undefined, { currentPassword: 'x', newPassword: 'y' })).statusCode).toBe(429);
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
    const res = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample(slug) });
    return res.json().translationKey;
  };
  const bulk = async (b: Built, cookie: { sid: string } | undefined, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/posts/bulk', headers: { 'content-type': 'application/json' }, ...(cookie ? { cookies: cookie } : {}), payload });

  it('is admin-only: 401 anonymous, 403 for a non-admin author', async () => {
    const b = build();
    expect((await bulk(b, undefined, { action: 'publish', keys: ['x'] })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    expect((await bulk(b, cookie, { action: 'publish', keys: ['x'] })).statusCode).toBe(403);
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
    expect(body.results).toContainEqual({ key: good, ok: true });
    expect(body.results).toContainEqual({ key: 'does-not-exist', ok: false, error: 'post not found' });
    expect(s.calls.length).toBe(1); // the successful one still went live
  });

  it('surfaces a validation failure per post without touching the others', async () => {
    const b = build(); const { cookie } = await authed(b);
    const ok = await create(b, cookie, 'a');
    const incomplete = sample('b'); incomplete.de.excerpt = '';
    const bad = (await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: incomplete })).json().translationKey;
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
    await b.app.inject({ method: 'POST', url: `/posts/${live}/publish`, cookies: cookie });
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
    const s = stubBuilder({ ok: false, error: 'a build is already running' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, 'a');
    const body = (await bulk(b, cookie, { action: 'publish', keys: [tk] })).json();
    expect(body).toMatchObject({ succeeded: 1, build: { ok: false, error: 'a build is already running' } });
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
    (await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload })).json().translationKey;

  it('blocks publishing while a referenced photo is still processing', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'processing', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
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
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie })).statusCode).toBe(409);
  });

  it('allows publishing once every referenced photo is ready', async () => {
    const b = build();
    const { cookie } = await authed(b);
    await b.media.upsert({ key: 'trips/g/hero', status: 'ready', width: 9, height: 9, origBytes: 1, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie })).statusCode).toBe(200);
  });

  it('does NOT block a URL with no media row — WP-imported and legacy files predate the library', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const tk = await create(b, cookie, pairUsing(`${IMG}/wp/legacy/photo`));
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie })).statusCode).toBe(200);
  });

  it('checks gallery/body images from the images map, not just the hero', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    await b.media.upsert({ key: 'trips/g/hero', status: 'ready', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    await b.media.upsert({ key: 'trips/g/gallery-a', status: 'processing', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero`, {
      [`${IMG}/trips/g/gallery-a`]: { width: 3000, height: 2000 },
    }));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().notReady).toEqual(['trips/g/gallery-a']);
  });

  it('maps a hand-pasted variant URL back to its key, and ignores foreign origins', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
    await b.media.upsert({ key: 'trips/g/hero', status: 'processing', width: 9, height: 9, origBytes: 1, exif, uploadedBy: null });
    const tk = await create(b, cookie, pairUsing(`${IMG}/trips/g/hero-1280.webp`, {
      // A different origin is not ours to gate on.
      'https://elsewhere.example/photo': { width: 10, height: 10 },
    }));
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
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
      payload: { action: 'publish', keys: [tk] },
    });
    expect(res.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.json().results[0].error).toMatch(/still processing/);
  });
});

describe('posts editor', () => {
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
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

  it('draft edits over a published post surface hasUnpublishedChanges until re-publish', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    let got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got).toMatchObject({ status: 'published', hasUnpublishedChanges: false });

    const edited = { ...sample(), de: { ...sample().de, bodyMarkdown: '## edited' } };
    const put = await b.app.inject({ method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie, payload: edited });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: 'published', hasUnpublishedChanges: true });

    // The editor still gets the edited WORKING copy; the list carries the flag
    // for the posts page's "edited" badge.
    got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got.de.bodyMarkdown).toBe('## edited');
    expect(got.hasUnpublishedChanges).toBe(true);
    const list = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(list[0]).toMatchObject({ status: 'published', hasUnpublishedChanges: true });

    const repub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(repub.statusCode).toBe(200);
    got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got).toMatchObject({ status: 'published', hasUnpublishedChanges: false });
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

  it('deleting a draft removes it without rebuilding the site', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect(s.calls.length).toBe(0); // a draft was never on the live site
    expect((await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json()).toHaveLength(0);
  });

  it('deleting a published post rebuilds the site and reports the outcome', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(s.calls.length).toBe(1); // publish built once
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, build: { ok: true, release: 'r1' } });
    expect(s.calls.length).toBe(2);
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).statusCode).toBe(404);
  });

  it('unpublish 409s on a draft', async () => {
    const s = stubBuilder();
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(s.calls.length).toBe(1);
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(200);
    expect(un.json()).toEqual({ unpublished: true, build: { ok: true, release: 'r1' } });
    expect(s.calls.length).toBe(2);
    const got = await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie });
    expect(got.json().status).toBe('draft');
  });

  it('a failed rebuild is surfaced but the store change still lands (unpublish + delete)', async () => {
    const s = stubBuilder({ ok: false, error: 'a build is already running' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    const un = await b.app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies: cookie });
    expect(un.statusCode).toBe(200);
    expect(un.json()).toEqual({ unpublished: true, build: { ok: false, error: 'a build is already running' } });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json().status).toBe('draft');
    // re-publish, then delete while the builder keeps failing: DB delete lands, outcome surfaced
    await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    const del = await b.app.inject({ method: 'DELETE', url: `/posts/${tk}`, cookies: cookie });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, build: { ok: false, error: 'a build is already running' } });
    expect((await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).statusCode).toBe(404);
  });

  it('GET /posts summaries carry the hero, trip date, country and region for the list UI', async () => {
    const b = build(); const { cookie } = await authed(b);
    await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const [summary] = (await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie })).json();
    expect(summary).toMatchObject({
      heroSrc: 'https://i/h', heroWidth: 9,
      date: '2024-10-03', country: 'X', region: 'europe',
    });
  });

  it('GET /posts/:tk includes updatedAt, and a PUT echoing it saves fine', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.json().updatedAt).toBeTruthy();
    const tk = created.json().translationKey;
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(typeof got.updatedAt).toBe('string');
    const put = await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { ...sample(), de: { ...sample().de, title: 'T2' }, updatedAt: got.updatedAt },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().de.title).toBe('T2');
  });

  it('PUT with a stale updatedAt → 409 code "conflict"; nothing is overwritten', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const put = await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { ...sample(), de: { ...sample().de, bodyMarkdown: '## clobber' }, updatedAt: '2000-01-01T00:00:00.000Z' },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ code: 'conflict' });
    expect(put.json().error).toMatch(/modified/);
    const got = (await b.app.inject({ method: 'GET', url: `/posts/${tk}`, cookies: cookie })).json();
    expect(got.de.bodyMarkdown).toBe('## b');
  });

  it('PUT with an unparsable updatedAt → 400; without one the check is skipped', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const bad = await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { ...sample(), updatedAt: 'not-a-date' },
    });
    expect(bad.statusCode).toBe(400);
    const none = await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: sample(),
    });
    expect(none.statusCode).toBe(200);
  });

  it('duplicate-slug 409 carries its own code, distinguishable from a conflict', async () => {
    const b = build(); const { cookie } = await authed(b);
    await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const dup = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('duplicate_slug');
  });

  it('publish response includes the fresh updatedAt so the editor can re-sync', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().updatedAt).toBeTruthy();
    // Echoing the post-publish value must not false-conflict.
    const put = await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { ...sample(), status: 'published', updatedAt: pub.json().updatedAt },
    });
    expect(put.statusCode).toBe(200);
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    let list = (await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions`, cookies: cookie })).json();
    expect(list).toEqual([]);
    await b.app.inject({
      method: 'PUT', url: `/posts/${tk}`, headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { ...sample(), de: { ...sample().de, title: 'T2', bodyMarkdown: '## new' } },
    });
    list = (await b.app.inject({ method: 'GET', url: `/posts/${tk}/revisions`, cookies: cookie })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ titleDe: 'T', status: 'draft' });
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

  const postImport = (b: Built, cookie: Record<string, string>, xmlBody: string) => {
    const form = new FormData();
    form.append('file', xmlBody, { filename: 'export.xml', contentType: 'text/xml' });
    return b.app.inject({ method: 'POST', url: '/import', headers: { ...form.getHeaders() }, cookies: cookie, payload: form });
  };

  // Every URL here is refused by safeFetch's SSRF guard, so it fails instantly
  // and non-retryably — no network, no backoff, just the pacing gate.
  const blocked = (n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1/p${i}.jpg`);

  it('reports how many images were actually hosted, so a partial import cannot look clean', async () => {
    const b = build(); const { cookie } = await authed(b);
    const res = await postImport(b, cookie, wxrWith(...blocked(3)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imported: 1, images: { total: 3, hosted: 0, failed: 3 } });
  });

  it('does not leak the transport error behind a failed image', async () => {
    const b = build(); const { cookie } = await authed(b);
    const res = await postImport(b, cookie, wxrWith(...blocked(1)));
    const warnings = (res.json().warnings as string[]).join(' ');
    expect(warnings).toMatch(/blocked address/);
    expect(warnings).not.toMatch(/ECONNREFUSED|refusing to fetch/);
  });

  it('paces fetches using the configured delay', async () => {
    const b = build({ settings: fakeStore({ ...SETTINGS, importDelayMs: 200 }) });
    const { cookie } = await authed(b);
    const started = Date.now();
    await postImport(b, cookie, wxrWith(...blocked(3)));
    // 3 images ⇒ 2 gate waits. Proves the route threads the setting through
    // rather than using importWxr's inert default of 0.
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  // @ai-warning Resumability makes "just run the import again" the documented
  // recovery path, so concurrency stops being hypothetical. Two runs would both
  // see a mostly-empty resume index and both fetch everything, hit the source
  // host at 2x the configured rate, and race storeVariantFiles' non-atomic
  // writes into a mixed variant set. Not work-lock — one flag and a 409.
  it('refuses a second import while one is still running', async () => {
    const b = build({ settings: fakeStore({ ...SETTINGS, importDelayMs: 600 }) });
    const { cookie } = await authed(b);
    const first = postImport(b, cookie, wxrWith(...blocked(3)));
    await new Promise((r) => { setTimeout(r, 50); });
    const second = await postImport(b, cookie, wxrWith(...blocked(3)));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already running/i);
    expect((await first).statusCode).toBe(200);
  });

  it('accepts another import once the first has finished', async () => {
    const b = build(); const { cookie } = await authed(b);
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(200);
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(200);
  });

  it('releases the single-flight flag even when the import throws', async () => {
    const posts = memoryPostStore();
    posts.upsertDraft = async () => { throw new Error('boom'); };
    const b = build({ posts }); const { cookie } = await authed(b);
    // The per-group catch turns this into skipped:1 rather than a 500...
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(200);
    // ...and either way the next import must not be locked out.
    expect((await postImport(b, cookie, wxrWith(...blocked(1)))).statusCode).toBe(200);
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

  it('health is public and reports the DB as up, plus free disk space', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: true });
    // #73: the volume's headroom is visible before it becomes an outage.
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
    const s = stubBuilder({ ok: true, release: 'r9' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, release: 'r9' });
    expect(s.calls.length).toBe(1);
  });

  it('publish reports a failed build without unpublishing', async () => {
    const s = stubBuilder({ ok: false, error: 'astro build exited 1' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toEqual({ ok: false, error: 'astro build exited 1' });
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
    const s = stubBuilder({ ok: true, release: 'r7' });
    const b = build({ builder: s.builder });
    const body = {
      de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    };
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', payload: body })).statusCode).toBe(401);
    const nonAdmin = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: nonAdmin.cookie, payload: body })).statusCode).toBe(403);
    const admin = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved.de.title).toBe('Über mich');
    expect(res.json().build).toEqual({ ok: true, release: 'r7' });
    expect(s.calls.length).toBe(1);
  });

  it('PUT /pages/:key rejects an unsafe key with 400', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/Bad_Key', cookies: cookie, payload: { de: { locale: 'de', title: '', bodyMarkdown: '', images: {} }, en: { locale: 'en', title: '', bodyMarkdown: '', images: {} } } });
    expect(res.statusCode).toBe(400);
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
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
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=fr`, cookies: cookie });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the admin security headers (/posts prefix)', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: draft() });
    const tk = created.json().translationKey;
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/preview?locale=de`, cookies: cookie });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
