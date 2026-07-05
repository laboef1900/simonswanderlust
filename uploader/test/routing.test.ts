import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import type { SiteBuilder } from '../src/build.js';
import type { DbBackup } from '../src/backup.js';

const IMG = 'img.simonswanderlust.com';
const MAIN = 'simonswanderlust.com';

const SETTINGS: Settings = defaultSettings();
const fakeStore = (): SettingsStore => {
  let cur = { ...SETTINGS };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
};

let dir: string;
let siteDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routing-'));
  siteDir = join(dir, 'site');
});

/** Lay down a fake release and point current at it. */
async function release(name: string, files: Record<string, string>) {
  const releaseDir = join(siteDir, 'releases', name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(releaseDir, rel, '..'), { recursive: true });
    await writeFile(join(releaseDir, rel), content);
  }
  await rm(join(siteDir, 'current'), { force: true });
  await symlink(releaseDir, join(siteDir, 'current'));
}

function stubBackup(backupDir: string): DbBackup {
  let state = {};
  return {
    dir: backupDir,
    runNow: async () => { state = { lastAttemptAt: 'a', lastSuccessAt: 's' }; return { ...state }; },
    list: () => [{ name: 'db-20260703-120000.json.gz', size: 3 }],
    state: () => ({ ...state }),
  };
}

function build(extra: Partial<ServerConfig> = {}) {
  const hasRelease = () => existsSync(join(siteDir, 'current'));
  const builder: SiteBuilder = { build: async () => ({ ok: true, release: 'r' }), hasRelease };
  const backupDir = join(dir, 'backup');
  return buildServer({
    storageDir: join(dir, 'images'), baseUrl: `https://${IMG}`, imgHost: IMG,
    siteDir, mapDir: join(dir, 'map'),
    users: memoryUserStore(), sessions: memorySessionStore(), posts: memoryPostStore(),
    pages: memoryPageStore(),
    settings: fakeStore(), builder, backupDir, dbBackup: stubBackup(backupDir),
    ...extra,
  });
}

describe('host routing', () => {
  it('serves an image variant on the img host, 404s it on the main host', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'k-640.webp'), 'img-bytes');
    await release('r1', { 'index.html': '<h1>blog</h1>', '404.html': 'not here' });
    const app = build();
    const onImg = await app.inject({ method: 'GET', url: '/k-640.webp', headers: { host: IMG } });
    expect(onImg.statusCode).toBe(200);
    expect(onImg.headers['cache-control']).toContain('immutable');
    const onMain = await app.inject({ method: 'GET', url: '/k-640.webp', headers: { host: MAIN } });
    expect(onMain.statusCode).toBe(404);
  });

  it('serves the blog homepage at / on the main host (no /admin/ redirect)', async () => {
    await release('r1', { 'index.html': '<h1>blog</h1>', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('blog');
  });

  it('301-redirects a directory URL missing its trailing slash', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf', 'rumaenien/index.html': 'trip' });
    const app = build();
    const r = await app.inject({ method: 'GET', url: '/rumaenien', headers: { host: MAIN } });
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/rumaenien/');
    const ok = await app.inject({ method: 'GET', url: '/rumaenien/', headers: { host: MAIN } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('trip');
  });

  it('serves 404.html with status 404 for unknown blog paths', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'custom not found' });
    const res = await build().inject({ method: 'GET', url: '/nope/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('custom not found');
  });

  it('returns 503 with Retry-After before the first release exists', async () => {
    const res = await build().inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('serves new content after the current symlink flips (atomic release)', async () => {
    await release('r1', { 'index.html': 'v1', '404.html': 'nf' });
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } })).body).toBe('v1');
    await release('r2', { 'index.html': 'v2', '404.html': 'nf' });
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } })).body).toBe('v2');
  });

  it('scopes admin headers: /health gets X-Frame-Options, blog pages do not', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    const admin = await app.inject({ method: 'GET', url: '/health', headers: { host: MAIN } });
    expect(admin.headers['x-frame-options']).toBe('DENY');
    const blog = await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(blog.headers['x-frame-options']).toBeUndefined();
    expect(blog.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('legacy WordPress redirects', () => {
  it('301s the /feed/ family to /rss.xml on the main host', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    for (const url of ['/feed/', '/feed', '/comments/feed/', '/feed/atom/', '/feed/rss2/']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: MAIN } });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/rss.xml');
    }
  });

  it('301s /en/feed/ to /en/rss.xml', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/en/feed/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/en/rss.xml');
  });

  it('strips the query string before matching (/feed/?withoutcomments=1)', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({
      method: 'GET', url: '/feed/?withoutcomments=1', headers: { host: MAIN },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/rss.xml');
  });

  it('301s category archives to their region pages', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    const de = await app.inject({ method: 'GET', url: '/category/europa/', headers: { host: MAIN } });
    expect(de.statusCode).toBe(301);
    expect(de.headers.location).toBe('/reiseziele/europa/');
    const en = await app.inject({ method: 'GET', url: '/en/category/europe/', headers: { host: MAIN } });
    expect(en.statusCode).toBe(301);
    expect(en.headers.location).toBe('/en/destinations/europe/');
  });

  it('answers HEAD requests with the 301 too (feed readers probe with HEAD)', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'HEAD', url: '/feed/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/rss.xml');
  });

  it('does not redirect on the img host (plain 404 preserved)', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/feed/', headers: { host: IMG } });
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('lets unknown archives fall through to 404.html', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'custom not found' });
    const res = await build().inject({ method: 'GET', url: '/category/asien/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('custom not found');
  });

  it('redirects even before the first release exists (no 503 for legacy URLs)', async () => {
    const res = await build().inject({ method: 'GET', url: '/feed/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/rss.xml');
  });

  it('never shadows a real static file: a released feed/index.html wins over the 301', async () => {
    // The redirect lives in setNotFoundHandler, which only runs after
    // @fastify/static misses — this pins that precedence.
    await release('r1', { 'index.html': 'home', '404.html': 'nf', 'feed/index.html': 'static feed' });
    const res = await build().inject({ method: 'GET', url: '/feed/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('static feed');
  });
});

describe('/map/ assets', () => {
  it('serves .pmtiles with octet-stream MIME and supports range requests', async () => {
    await mkdir(join(dir, 'map'), { recursive: true });
    await writeFile(join(dir, 'map', 'basemap.pmtiles'), 'PMTILESDATA');
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    const full = await app.inject({ method: 'GET', url: '/map/basemap.pmtiles', headers: { host: MAIN } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('application/octet-stream');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({
      method: 'GET', url: '/map/basemap.pmtiles',
      headers: { host: MAIN, range: 'bytes=0-3' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('PMTI');
  });

  it('applies the pmtiles MIME override even with a query string', async () => {
    await mkdir(join(dir, 'map'), { recursive: true });
    await writeFile(join(dir, 'map', 'basemap.pmtiles'), 'PMTILESDATA');
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/map/basemap.pmtiles?v=1', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('serves glyph .pbf with the protobuf MIME type', async () => {
    await mkdir(join(dir, 'map', 'fonts'), { recursive: true });
    await writeFile(join(dir, 'map', 'fonts', '0-255.pbf'), 'PBF');
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/map/fonts/0-255.pbf', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-protobuf');
  });
});
