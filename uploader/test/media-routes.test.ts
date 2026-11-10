import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type AppServer } from '../src/server.js';
import type { BackupState, DbBackup } from '../src/backup.js';
import type { SiteBuilder } from '../src/build.js';
import type { EncodeQueue } from '../src/encode-queue.js';
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
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
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
  return { app, media, cookie };
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
