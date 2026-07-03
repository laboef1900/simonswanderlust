import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type ServerConfig } from '../src/server.js';
import { validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import type { SiteBuilder } from '../src/build.js';

const IMG = 'img.simonswanderlust.com';
const MAIN = 'simonswanderlust.com';

const SETTINGS: Settings = {
  lmBaseUrl: 'http://lm:1234/v1', lmModel: 'm', captionTimeoutMs: 60000,
  captionMaxEdge: 768, captionPrompt: 'P', backupSchedule: 'off', backupRetention: 14,
};
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

function build(extra: Partial<ServerConfig> = {}) {
  const hasRelease = () => existsSync(join(siteDir, 'current'));
  const builder: SiteBuilder = { build: async () => ({ ok: true, release: 'r' }), hasRelease };
  return buildServer({
    storageDir: join(dir, 'images'), baseUrl: `https://${IMG}`, imgHost: IMG,
    siteDir, mapDir: join(dir, 'map'),
    users: memoryUserStore(), sessions: memorySessionStore(), posts: memoryPostStore(),
    settings: fakeStore(), builder, backupDir: join(dir, 'backup'),
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
