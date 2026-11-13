import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { buildServer, type AppServer } from '../src/server.js';
import type { BackupState, DbBackup } from '../src/backup.js';
import type { SiteBuilder } from '../src/build.js';
import type { EncodeQueue } from '../src/encode-queue.js';
import { emptyMediaExif } from '../src/exif.js';
import { memoryMediaStore, type MediaStore, type NewMediaItem } from '../src/media-store.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryPostStore } from '../src/posts.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memorySessionStore } from '../src/sessions.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { idleBuildState } from './build-fixture.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';

// GET /media is what the Media page and the picker list from. Besides the page
// itself it answers `altMissing` — the number of ready photos in the same view
// that still have no alt text — and accepts `alt=missing` as a filter. This
// suite builds the server with memory stores only, like server.test.ts.
const noExif = emptyMediaExif();
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'media-routes-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function settingsStore(): SettingsStore {
  let current: Settings = { ...defaultSettings() };
  return { get: () => ({ ...current }), update: (patch) => { current = validate({ ...current, ...patch }); return { ...current }; } };
}

const builder: SiteBuilder = {
  ...idleBuildState,
  build: async () => ({ ok: true, attemptId: 'r1', release: 'r1' }),
  hasRelease: () => true,
  quiesce: async () => {},
};

const backup: DbBackup = {
  dir: '/tmp/none',
  runNow: async (): Promise<BackupState> => ({}),
  running: () => false,
  sweepTempFiles: () => [],
  list: () => [],
  listImageArchives: () => [],
  listRouteArchives: () => [],
  quiesce: async () => {},
  state: () => ({}),
};

const encodeQueue: EncodeQueue = {
  withAdmission: (_key, operation) => operation(),
  enqueue: () => {},
  isActive: () => false,
  availableCapacity: () => 100,
  onCapacity: () => () => {},
  recover: async () => 0,
  drain: async () => {},
  quiesce: async () => {},
  idle: async () => {},
  stats: () => ({ pending: 0, running: 0 }),
};

interface Built {
  app: AppServer;
  media: MediaStore;
  cookie: { sid: string };
  /** A non-admin session: sees every photo, but never GPS or the uploader. */
  author: { sid: string };
}

async function build(): Promise<Built> {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const posts = memoryPostStore();
  const media = memoryMediaStore({ baseUrl: 'https://img.example' });
  const app = buildServer({
    trustProxy: TEST_TRUST,
    storageDir: dir, baseUrl: 'https://img.example',
    users, sessions, settings: settingsStore(), secrets: memorySecretsStore(),
    posts, pages: memoryPageStore(posts.language), media, encodeQueue,
    imgHost: 'img.example', siteDir: join(dir, 'site'),
    builder, backupDir: join(dir, 'backup'), dbBackup: backup, dbCheck: async () => {},
  });
  const user = await users.create({ username: 'simon', password: 'password123456', isAdmin: true });
  const cookie = { sid: await sessions.create(user.id, 60_000) };
  const writer = await users.create({ username: 'author', password: 'password123456', isAdmin: false });
  const author = { sid: await sessions.create(writer.id, 60_000) };
  return { app, media, cookie, author };
}

const photo = (media: MediaStore, key: string, over: Partial<NewMediaItem> = {}) =>
  media.upsert({ key, status: 'ready', width: 800, height: 600, origBytes: 10, exif: noExif, uploadedBy: null, ...over });

async function list(built: Built, query = '') {
  const res = await built.app.inject({ method: 'GET', url: '/media' + query, cookies: built.cookie });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { total: number; altMissing: number; items: { key: string }[] };
  return { total: body.total, altMissing: body.altMissing, keys: body.items.map((item) => item.key).sort() };
}

describe('GET /media alt text', () => {
  it('counts the ready photos of the view without alt text and filters on alt=missing', async () => {
    const b = await build();
    try {
      await photo(b.media, 'none', { folder: 'Trips' });
      await photo(b.media, 'blank', { folder: 'Trips/North', alt: { de: ' ', en: '' } });
      await photo(b.media, 'de-only', { folder: 'Trips', alt: { de: 'Fjord', en: '' } });
      await photo(b.media, 'elsewhere', { folder: 'Other' });
      await photo(b.media, 'encoding', { folder: 'Trips', status: 'processing' });

      const all = await list(b);
      expect(all.total).toBe(5);
      expect(all.altMissing).toBe(3); // none, blank, elsewhere — not the one still encoding

      const missing = await list(b, '?alt=missing');
      expect(missing.keys).toEqual(['blank', 'elsewhere', 'encoding', 'none']);
      expect(missing.altMissing).toBe(3);

      const readyMissing = await list(b, '?alt=missing&status=ready');
      expect(readyMissing.keys).toEqual(['blank', 'elsewhere', 'none']);

      // The count follows the view's folder, subfolders and search.
      expect((await list(b, '?folder=Trips&recursive=1')).altMissing).toBe(2);
      expect((await list(b, '?folder=Trips')).altMissing).toBe(1);
      expect((await list(b, '?q=elsewhere')).altMissing).toBe(1);
      // A status filter that excludes ready photos has nothing to count.
      expect((await list(b, '?status=processing')).altMissing).toBe(0);
      expect((await list(b, '?status=failed')).altMissing).toBe(0);
    } finally { await b.app.close(); }
  });

  it('ignores any alt value other than missing', async () => {
    const b = await build();
    try {
      await photo(b.media, 'none');
      await photo(b.media, 'described', { alt: { de: 'Fjord', en: 'Fjord' } });
      const ignored = await list(b, '?alt=present');
      expect(ignored.keys).toEqual(['described', 'none']);
      expect(ignored.altMissing).toBe(1);
    } finally { await b.app.close(); }
  });
});

// #570. The details panel reads one photo through GET /media/items/*: the
// exposure settings, the fullscreen viewer's URL and — only when it asks —
// the variant files that exist on disk.
describe('GET /media/items/* details (#570)', () => {
  const exposure = { focalLength: 4.3, focalLength35mm: 24, fNumber: 1.8, iso: 125, exposureTime: 1 / 500 };
  const exif = { takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'Pixel 9', lens: 'Main', lat: 63.0759, lng: 10.3887, ...exposure };
  const item = (b: Built, key: string, cookies: { sid: string }, query = '') =>
    b.app.inject({ method: 'GET', url: `/media/items/${key}${query}`, cookies });
  /** A real image whose header height differs from the width in its file name. */
  const image = (format: 'avif' | 'webp' | 'jpeg', height: number): Promise<Buffer> =>
    sharp({ create: { width: 64, height, channels: 3, background: { r: 40, g: 80, b: 120 } } })
      .toFormat(format, format === 'avif' ? { effort: 0 } : {}).toBuffer();
  async function put(rel: string, data: Buffer | string = 'x'): Promise<number> {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), data);
    return Buffer.byteLength(data);
  }

  // @ai-warning The privilege boundary of #570: the five exposure numbers are
  // camera settings without location, so authors see them; GPS and the
  // uploader stay admin-only. Asserted on the wire, per route.
  it('shows the exposure settings to authors and admins, and GPS and the uploader to admins only', async () => {
    const b = await build();
    try {
      await photo(b.media, 'library/2026/geo', { exif, uploadedBy: 'user-1' });
      const wire = { takenAt: '2026-07-04T18:23:11.000Z', camera: 'Pixel 9', lens: 'Main', ...exposure };
      const patch = (cookies: { sid: string }, title: string, expected: string) => b.app.inject({
        method: 'PATCH', url: '/media/items/library/2026/geo', cookies,
        payload: { conditional: { version: 1, patch: { title }, expect: { title: expected } } },
      });
      const asAuthor = [
        (await item(b, 'library/2026/geo', b.author)).json(),
        (await b.app.inject({ method: 'GET', url: '/media', cookies: b.author })).json().items[0],
        (await patch(b.author, 'By the author', '')).json(),
      ];
      for (const body of asAuthor) {
        expect(body.exif).toEqual({ ...wire, lat: null, lng: null });
        expect(body.uploadedBy).toBeNull();
      }
      const asAdmin = [
        (await item(b, 'library/2026/geo', b.cookie)).json(),
        (await b.app.inject({ method: 'GET', url: '/media', cookies: b.cookie })).json().items[0],
        (await patch(b.cookie, 'By the admin', 'By the author')).json(),
      ];
      for (const body of asAdmin) {
        expect(body.exif).toEqual({ ...wire, lat: 63.0759, lng: 10.3887 });
        expect(body.uploadedBy).toBe('user-1');
      }
      // A 409 hands back the current row: redacted the same way.
      const stale = await patch(b.author, 'Too late', 'By the author');
      expect(stale.statusCode).toBe(409);
      expect(stale.json().current.exif).toEqual({ ...wire, lat: null, lng: null });
      expect(stale.json().current.uploadedBy).toBeNull();
    } finally { await b.app.close(); }
  });

  it('derives fullSrc beside thumbSrc: the intrinsic-width variant, once the photo is ready', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x/hero', { width: 3000, height: 2000 });
      await photo(b.media, 'trips/x/jpeg', { width: 3000, height: 2000, format: 'jpeg', encoding: { convertJpeg: false } });
      await photo(b.media, 'trips/x/encoding', { width: 3000, height: 2000, status: 'processing' });
      await photo(b.media, 'trips/x/unknown', { width: 0, height: 0 });
      const expected: Record<string, string | null> = {
        'trips/x/hero': 'https://img.example/trips/x/hero-3000.webp',
        'trips/x/jpeg': 'https://img.example/trips/x/jpeg-3000.jpeg',
        'trips/x/encoding': null,
        'trips/x/unknown': null,
      };
      for (const cookies of [b.cookie, b.author]) {
        for (const [key, fullSrc] of Object.entries(expected)) {
          expect((await item(b, key, cookies)).json().fullSrc).toBe(fullSrc);
        }
        const listed = (await b.app.inject({ method: 'GET', url: '/media', cookies })).json().items as { key: string; fullSrc: string | null }[];
        expect(Object.fromEntries(listed.map((entry) => [entry.key, entry.fullSrc]))).toEqual(expected);
      }
    } finally { await b.app.close(); }
  });

  it('lists the variant files on disk with ?versions=1, identically for authors and admins', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x/hero', { width: 800, height: 500 });
      const bytes = {
        'avif-640': await put('trips/x/hero-640.avif', await image('avif', 40)),
        'webp-640': await put('trips/x/hero-640.webp', await image('webp', 40)),
        'avif-800': await put('trips/x/hero-800.avif', await image('avif', 50)),
        'webp-800': await put('trips/x/hero-800.webp', await image('webp', 50)),
      };
      // Never listed: the private original and a sibling key sharing the prefix.
      await put('trips/x/hero-orig.jpg', await image('jpeg', 50));
      await put('trips/x/hero-b-640.webp', await image('webp', 40));
      const src = 'https://img.example/trips/x/hero';
      const versions = {
        availability: 'available',
        items: [
          { format: 'avif', width: 640, height: 40, bytes: bytes['avif-640'], src: `${src}-640.avif` },
          { format: 'webp', width: 640, height: 40, bytes: bytes['webp-640'], src: `${src}-640.webp` },
          { format: 'avif', width: 800, height: 50, bytes: bytes['avif-800'], src: `${src}-800.avif` },
          { format: 'webp', width: 800, height: 50, bytes: bytes['webp-800'], src: `${src}-800.webp` },
        ],
      };
      for (const cookies of [b.cookie, b.author]) {
        const res = await item(b, 'trips/x/hero', cookies, '?versions=1');
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json().versions).toEqual(versions);
        // The rest of the detail response is what it was.
        expect(res.json()).toMatchObject({ key: 'trips/x/hero', src, fullSrc: `${src}-800.webp`, impact: { availability: 'available' } });
      }
    } finally { await b.app.close(); }
  });

  it('lists exactly what exists: a JPEG-only set, a partial set, and nothing at all', async () => {
    const b = await build();
    try {
      await photo(b.media, 'library/2026/jpeg', { format: 'jpeg', encoding: { convertJpeg: false } });
      const jpeg = await put('library/2026/jpeg-800.jpeg', await image('jpeg', 50));
      await photo(b.media, 'library/2026/partial', { status: 'failed' });
      const partial = await put('library/2026/partial-640.webp', 'truncated');
      await photo(b.media, 'library/2026/gone', { status: 'missing' });
      await photo(b.media, 'elsewhere/no-directory');
      const versions = async (key: string) => (await item(b, key, b.author, '?versions=1')).json().versions;
      expect(await versions('library/2026/jpeg')).toEqual({ availability: 'available', items: [
        { format: 'jpeg', width: 800, height: 50, bytes: jpeg, src: 'https://img.example/library/2026/jpeg-800.jpeg' },
      ] });
      // A file that is not a readable image still exists: listed, height unknown.
      expect(await versions('library/2026/partial')).toEqual({ availability: 'available', items: [
        { format: 'webp', width: 640, height: null, bytes: partial, src: 'https://img.example/library/2026/partial-640.webp' },
      ] });
      expect(await versions('library/2026/gone')).toEqual({ availability: 'available', items: [] });
      expect(await versions('elsewhere/no-directory')).toEqual({ availability: 'available', items: [] });
    } finally { await b.app.close(); }
  });

  it('adds versions only to this GET and only when asked', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x/hero');
      await put('trips/x/hero-640.webp', await image('webp', 40));
      for (const query of ['', '?versions=0', '?versions=true', '?versions=', '?versions=1&versions=1', '?version=1']) {
        const res = await item(b, 'trips/x/hero', b.cookie, query);
        expect(res.statusCode).toBe(200);
        expect(res.json()).not.toHaveProperty('versions');
      }
      const listed = (await b.app.inject({ method: 'GET', url: '/media?versions=1', cookies: b.cookie })).json();
      expect(listed.items).toHaveLength(1);
      expect(listed).not.toHaveProperty('versions');
      expect(listed.items[0]).not.toHaveProperty('versions');
      expect((await item(b, 'trips/x/ghost', b.cookie, '?versions=1')).statusCode).toBe(404);
    } finally { await b.app.close(); }
  });

  it('PATCH never carries versions, with or without the parameter', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x/hero');
      await put('trips/x/hero-640.webp', await image('webp', 40));
      let title = '';
      for (const query of ['', '?versions=1']) {
        const res = await b.app.inject({
          method: 'PATCH', url: `/media/items/trips/x/hero${query}`, cookies: b.cookie,
          payload: { conditional: { version: 1, patch: { title: `Title ${query}` }, expect: { title } } },
        });
        title = `Title ${query}`;
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ title, conditionalVersion: 1, fullSrc: 'https://img.example/trips/x/hero-800.webp' });
        expect(res.json()).not.toHaveProperty('versions');
      }
      const conflict = await b.app.inject({
        method: 'PATCH', url: '/media/items/trips/x/hero?versions=1', cookies: b.cookie,
        payload: { conditional: { version: 1, patch: { title: 'Stale' }, expect: { title: '' } } },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().current).not.toHaveProperty('versions');
    } finally { await b.app.close(); }
  });

  // The encoding poll GETs exactly the processing keys every few seconds and
  // their file set is still being written: the directory is not read for them.
  it('answers processing for a photo still encoding, without reading the disk', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x/hero', { status: 'processing' });
      // `trips` is a regular file: any read of the key's directory would fail
      // with ENOTDIR and surface as `unavailable`.
      await put('trips');
      expect((await item(b, 'trips/x/hero', b.cookie, '?versions=1')).json().versions).toEqual({ availability: 'processing' });
      // The same photo once it is no longer processing: now the read happens.
      await b.media.setStatus('trips/x/hero', 'failed', 'encode_failed');
      expect((await item(b, 'trips/x/hero', b.cookie, '?versions=1')).json().versions).toEqual({ availability: 'unavailable' });
    } finally { await b.app.close(); }
  });

  it('answers unavailable for an unsafe stored key or a storage error, keeping the response and never logging the path', async () => {
    const b = await build();
    // Ready first: plugin start-up logs warnings of its own, unrelated to this route.
    await b.app.ready();
    // The app runs with `logger: false`, so the route logs through console (stdout).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // A row can be hand-edited or restored from a dump: its key is re-checked
      // before any path is built. None of these passes assertSafeKey
      // (`blocked/y/` would otherwise resolve to the sibling key `blocked/y`).
      await photo(b.media, 'Evil');
      await photo(b.media, 'a.b');
      await photo(b.media, 'blocked/y/');
      // And a safe key whose directory cannot be read (ENOTDIR, not ENOENT).
      await photo(b.media, 'blocked/x/hero', { title: 'Still here' });
      await put('blocked');
      for (const key of ['Evil', 'a.b', 'blocked/y/', 'blocked/x/hero']) {
        const res = await item(b, key, b.author, '?versions=1');
        expect(res.statusCode).toBe(200);
        expect(res.json().versions).toEqual({ availability: 'unavailable' });
        expect(res.json()).toMatchObject({ key, status: 'ready', impact: { availability: 'available' } });
      }
      // One fixed line per failure: not the key, not the directory, not the error.
      expect(warn.mock.calls).toEqual(Array.from({ length: 4 }, () => ['Media versions unavailable']));
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); log.mockRestore(); await b.app.close(); }
  });
});

describe('DELETE /media/items/* key guard', () => {
  // `trips/x/` used to pass the key guard: the usage check then looked for
  // `…/trips/x/`, which no post references, while deleteMedia resolved it to
  // the sibling key `trips/x` and removed that photo's files and original
  // (file survival is pinned on deleteMedia itself in media-files.test.ts).
  it('refuses a trailing-slash key with 400 before the usage check', async () => {
    const b = await build();
    try {
      await photo(b.media, 'trips/x');
      const res = await b.app.inject({ method: 'DELETE', url: '/media/items/trips/x/', cookies: b.cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/trailing slash/);
    } finally { await b.app.close(); }
  });
});

describe('backend hardening and query optimization regressions', () => {
  it('POST /media/retry validates keys array, rejects > 100 keys, and deduplicates', async () => {
    const b = await build();
    try {
      const badType = await b.app.inject({ method: 'POST', url: '/media/retry', cookies: b.cookie, payload: { keys: 'not-an-array' } });
      expect(badType.statusCode).toBe(400);
      expect(badType.headers['cache-control']).toBe('no-store');

      const tooMany = await b.app.inject({
        method: 'POST', url: '/media/retry', cookies: b.cookie,
        payload: { keys: Array.from({ length: 101 }, (_, i) => `trips/x/${i}`) },
      });
      expect(tooMany.statusCode).toBe(400);

      await photo(b.media, 'trips/x/failed', { status: 'failed' });
      await b.media.setStatus('trips/x/failed', 'failed', 'encode_failed');
      const deduped = await b.app.inject({
        method: 'POST', url: '/media/retry', cookies: b.cookie,
        payload: { keys: ['trips/x/failed', 'trips/x/failed', ''] },
      });
      expect(deduped.statusCode).toBe(200);
      expect(deduped.json()).toEqual({ ok: true, queued: 1 });
    } finally { await b.app.close(); }
  });

  it('sets Cache-Control: no-store on authenticated API reads and 401/403 refusals', async () => {
    const b = await build();
    try {
      for (const [url, cookies] of [
        ['/auth/status', undefined],
        ['/users', undefined],
        ['/users', b.author],
        ['/media', undefined],
        ['/media', b.author],
        ['/media/queue', b.author],
        ['/backups', b.author],
        ['/import/status', b.author],
        ['/admin/waypoint-copy.js', undefined],
        ['/admin/stop-route-copy.js', undefined],
      ] as const) {
        const res = await b.app.inject({ method: 'GET', url, cookies });
        expect(res.headers['cache-control'], url).toBe('no-store');
      }
    } finally { await b.app.close(); }
  });
});
