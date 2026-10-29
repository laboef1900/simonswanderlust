import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { pgGpxStore } from '../src/gpx-store.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { lockPostPair } from '../src/post-pair-lock.js';
import type { PrivateGeometry } from '../public/gpx-geometry.js';
import { publishTokens } from './publish-tokens.js';
import type { PublicTrackCounts } from '../public/gpx-public-track.js';

import { buildServer } from '../src/server.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPageStore } from '../src/pages.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { createDbBackup } from '../src/backup.js';
import { pgLanguageStore, type LanguageConfig } from '../src/language.js';
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const geometry = (offset = 0): PrivateGeometry => ({ version: 1, segments: [
  { points: [{ lng: 23.456789 + offset, lat: 12.345678, elevation: 321, time: '2026-01-01T00:00:00.000Z' }, { lng: 23.457789 + offset, lat: 12.346678 }] },
  { points: [{ lng: 24.123456 + offset, lat: 13.234567 }, { lng: 24.124456 + offset, lat: 13.235567 }] },
] });
const expected = (offset = 0) => ({ version: 1, type: 'MultiLineString', coordinates: [
  [[23.4568 + offset, 12.3457], [23.4578 + offset, 12.3467]],
  [[24.1235 + offset, 13.2346], [24.1245 + offset, 13.2356]],
] });

maybe('explicit GPX publication snapshots (real PostgreSQL and admin worker)', () => {
  const schema = `gpx_publish_${randomUUID().replaceAll('-', '')}`;
  let owner: DbPool;
  let pool: DbPool;
  let worker: PublicTrackWorker;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
    worker = createPublicTrackWorker();
  });
  afterAll(async () => {
    await worker?.close();
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
  async function fixture(publicTrackWorker = worker) {
    const posts = pgPostStore(pool, { publicTrackWorker });
    const routes = pgGpxStore(pool);
    const id = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${id}`, title: 'Synthetic story', country: 'Test', excerpt: 'Synthetic excerpt', heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Synthetic' }, bodyMarkdown: 'Synthetic text', images: {} });
    const pair = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    const tk = pair.translationKey;
    const source = { translationKey: tk, sourceId: randomUUID(), sha256: 'a'.repeat(64), bytes: 100 };
    async function attach(value: PrivateGeometry) {
      const tokens = await publishTokens(posts, tk);
      return routes.attach(tk, { baseVersion: tokens.baseRouteVersion, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() }, value, source, true);
    }
    async function snapshots() {
      return (await pool.query<{ locale: string; published_snapshot: unknown; published_at: Date }>('SELECT locale,published_snapshot,published_at FROM posts WHERE translation_key=$1 ORDER BY locale', [tk])).rows;
    }
    return { posts, routes, pair, tk, attach, snapshots };
  }

  it('publishes A identically in DE/EN; draft B/rebuild reads keep A; publishes B; detach/rebuild reads keep B until explicit routeless publish', async () => {
    const f = await fixture();
    expect((await f.posts.getPublishedTrack(f.tk)).track).toBeUndefined();
    await f.attach(geometry());
    expect((await f.posts.getPublishedTrack(f.tk)).track).toBeUndefined();
    const first = await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    expect(first.updatedAt).toEqual((await f.posts.get(f.tk))!.updatedAt);
    expect((await f.posts.getPublishedTrack(f.tk)).track).toEqual(expected());
    const a = await f.snapshots();
    for (const row of a) expect(row.published_snapshot).toMatchObject({ track: expected() });
    expect(JSON.stringify(a)).not.toMatch(/elevation|2026-01-01T00:00:00.000Z|23.456789|source_id/);
    await f.attach(geometry(1));
    await f.posts.upsertDraft({ ...(await f.posts.get(f.tk))!, de: { ...f.pair.de, title: 'Draft B' } });
    await ensureSchema(pool); // boot/backfill must not promote draft geometry
    expect(await f.snapshots()).toEqual(a);
    expect((await f.posts.getPublishedTrack(f.tk)).track).toEqual(expected());
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    expect((await f.posts.getPublishedTrack(f.tk)).track).toEqual(expected(1));
    const b = await f.snapshots();
    const tokens = await publishTokens(f.posts, f.tk);
    await f.routes.detach(f.tk, { baseVersion: tokens.baseRouteVersion, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() });
    await ensureSchema(pool);
    expect(await f.snapshots()).toEqual(b);
    expect((await f.posts.getPublishedTrack(f.tk)).track).toEqual(expected(1));
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    expect((await f.posts.getPublishedTrack(f.tk)).track).toBeUndefined();
    for (const row of await f.snapshots()) expect(row.published_snapshot).not.toHaveProperty('track');
  });

  it('refuses exact-token mismatches including future times, stale route versions and absent tokens without changing either snapshot', async () => {
    const f = await fixture(); await f.attach(geometry());
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    const before = await f.snapshots();
    const tokens = await publishTokens(f.posts, f.tk);
    for (const invalid of [
      { ...tokens, baseUpdatedAt: new Date(tokens.baseUpdatedAt.getTime() + 1) },
      { ...tokens, baseUpdatedAt: new Date(tokens.baseUpdatedAt.getTime() - 1) },
      { ...tokens, baseRouteVersion: null }, { ...tokens, baseRouteVersion: randomUUID() },
    ]) await expect(f.posts.publish(f.tk, invalid)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.snapshots()).toEqual(before);
  });

  it.each(['text', 'route'] as const)('runs transform outside the transaction and rejects a concurrent %s edit under the pair lock', async (change) => {
    const transformed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const transforming: PublicTrackWorker = {
      close: async () => {},
      transform: async (...args) => {
        const result = await worker.transform(...args);
        transformed.resolve(); await resume.promise; return result;
      },
    };
    const f = await fixture(transforming); await f.attach(geometry());
    const tokens = await publishTokens(f.posts, f.tk);
    const publishing = f.posts.publish(f.tk, tokens);
    const outcome = publishing.catch(error => error as unknown);
    await Promise.race([transformed.promise, publishing.then(() => { throw new Error('Publish completed before the concurrency barrier'); })]);
    try {
      // This lock is acquired while the worker is held: no publish transaction owns it.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='1000ms'");
        await lockPostPair(client, f.tk);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      if (change === 'text') await f.posts.upsertDraft({ ...f.pair, de: { ...f.pair.de, title: 'Concurrent edit' } });
      else await f.attach(geometry(1));
    } finally { resume.resolve(); }
    expect(await outcome).toMatchObject({ code: 'conflict' });
    for (const row of await f.snapshots()) expect(row.published_snapshot).toBeNull();
  });

  it('refuses a legacy complex over-cap private attachment without replacing either existing public snapshot', async () => {
    const f = await fixture(); await f.attach(geometry());
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    const before = await f.snapshots();
    // Twenty-one independent zigzag runs keep 2,100 corners after 25m RDP.
    const complex: PrivateGeometry = { version: 1, segments: Array.from({ length: 21 }, (_, run) => ({ points: Array.from({ length: 100 }, (_, i) => ({ lng: 10 + i * 0.001, lat: 20 + run * 0.1 + (i % 2) * 0.01 })) })) };
    await f.attach(complex); // private-store boundary represents an existing #313 route
    await expect(f.posts.publish(f.tk, await publishTokens(f.posts, f.tk))).rejects.toMatchObject({ code: 'track_public_limit' });
    expect(await f.snapshots()).toEqual(before);
  });

  it.each(['missing', 'different', 'null', 'private', 'third ordinate'] as const)('rejects %s locale artifacts without falling back to the attached draft', async (corruption) => {
    const f = await fixture(); await f.attach(geometry());
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    if (corruption === 'missing') await pool.query("UPDATE posts SET published_snapshot=published_snapshot-'track' WHERE translation_key=$1 AND locale='en'", [f.tk]);
    else {
      const track = corruption === 'different' ? expected(1) : corruption === 'null' ? null : corruption === 'private' ? { ...expected(), source: 'PRIVATE' } : { version: 1, type: 'MultiLineString', coordinates: [[[1, 2, 3], [2, 3, 4]]] };
      await pool.query("UPDATE posts SET published_snapshot=jsonb_set(published_snapshot,'{track}',$2::jsonb) WHERE translation_key=$1 AND locale='en'", [f.tk, JSON.stringify(track)]);
    }
    await expect(f.posts.getPublishedTrack(f.tk)).rejects.toMatchObject({ code: 'invalid_published_track' });
  });

  it('rolls back both locale snapshots and their timestamps when a locale update fails', async () => {
    const f = await fixture(); await f.attach(geometry());
    await f.posts.publish(f.tk, await publishTokens(f.posts, f.tk));
    await f.attach(geometry(1));
    const before = await f.snapshots();
    const tokens = await publishTokens(f.posts, f.tk);
    await pool.query(`CREATE FUNCTION refuse_public_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.locale='en' AND NEW.published_snapshot IS DISTINCT FROM OLD.published_snapshot THEN
          RAISE EXCEPTION 'synthetic snapshot failure';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query('CREATE TRIGGER refuse_public_snapshot BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION refuse_public_snapshot()');
    try {
      await expect(f.posts.publish(f.tk, tokens)).rejects.toThrow('synthetic snapshot failure');
      expect(await f.snapshots()).toEqual(before);
      expect(await publishTokens(f.posts, f.tk)).toEqual(tokens);
    } finally {
      await pool.query('DROP TRIGGER refuse_public_snapshot ON posts');
      await pool.query('DROP FUNCTION refuse_public_snapshot()');
    }
    await f.posts.publish(f.tk, tokens);
    expect((await f.posts.getPublishedTrack(f.tk)).track).toEqual(expected(1));
  });

  it('returns pair, language and route token without private geometry from coherent publish-state reads', async () => {
    const f = await fixture(); const route = await f.attach(geometry());
    const state = await f.posts.getPublishState(f.tk);
    expect(Object.keys(state!).sort()).toEqual(['language', 'pair', 'routeVersion']);
    expect(state!.routeVersion).toBe(route.version);
    expect(state!.pair.updatedAt).toEqual(route.updatedAt);
    expect(JSON.stringify(state)).not.toMatch(/segments|elevation|sourceId|23.456789/);
  });
});

maybe('GPX publish HTTP bulk and failed-build boundary (real PostgreSQL)', () => {
  it.each<LanguageConfig>([
    { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
    { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  ])('publishes and backs up primary-only tracks through bulk/single/Export all: $primary/$locales', async language => {
    const schema = `gpx_publish_http_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const root = await mkdtemp(join(tmpdir(), 'gpx-publish-http-'));
    const worker = createPublicTrackWorker();
    let active = 0; let maximum = 0; let transformed = 0;
    const measured: PublicTrackWorker = {
      close: () => worker.close(),
      transform: async (...args) => {
        active++; maximum = Math.max(maximum, active); transformed++;
        try { return await worker.transform(...args); } finally { active--; }
      },
    };
    const posts = pgPostStore(pool, { publicTrackWorker: measured });
    const routes = pgGpxStore(pool);
    const media = memoryMediaStore({ baseUrl: 'https://images.test' });
    const queue = createEncodeQueue({ store: media, storageDir: join(root, 'images'), lock: createWorkLock() });
    const users = memoryUserStore(); const sessions = memorySessionStore();
    let failBuild = true; let buildCount = 0;
    const keys: string[] = [];
    const builtTracks: unknown[] = [];
    const app = buildServer({
      storageDir: join(root, 'images'), siteDir: join(root, 'site'), backupDir: join(root, 'mdx'),
      baseUrl: 'https://images.test', imgHost: 'images.test', users, sessions, posts,
      language: pgLanguageStore(pool),
      pages: memoryPageStore(), media, encodeQueue: queue, secrets: memorySecretsStore(),
      settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
      dbBackup: createDbBackup({ db: pool, dir: join(root, 'backup'), retention: () => 10 }),
      dbCheck: async () => { await pool.query('SELECT 1'); },
      builder: {
        hasRelease: () => true, quiesce: async () => {},
        build: async () => {
          buildCount++;
          if (failBuild) return { ok: false, error: 'synthetic build failure' };
          builtTracks.push(...await Promise.all(keys.map(async (tk) => (await posts.getPublishedTrack(tk)).track)));
          return { ok: true, release: 'synthetic' };
        },
      },
    });
    try {
      await ensureSchema(pool);
      await pool.query('UPDATE site_language SET primary_locale=$1,enabled_locales=$2::text[]', [language.primary, language.locales]);
      await mkdir(join(root, 'images'), { recursive: true });
      const admin = await users.create({ username: 'synthetic-admin', password: 'synthetic-password', isAdmin: true });
      const cookies = { sid: await sessions.create(admin.id, 60_000) };
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${id}`, omitted: locale !== language.primary, title: 'Synthetic', country: 'Test', excerpt: 'Synthetic excerpt', heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Synthetic' }, bodyMarkdown: 'Synthetic text', images: {} });
        const pair = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
        keys.push(pair.translationKey);
        await routes.attach(pair.translationKey, { baseVersion: null, baseUpdatedAt: pair.updatedAt.toISOString() }, geometry(i),
          { translationKey: pair.translationKey, sourceId: randomUUID(), sha256: 'a'.repeat(64), bytes: 100 }, false);
      }
      const baseLanguageUpdatedAt = (await pgLanguageStore(pool).get()).updatedAt.toISOString();
      const response = await app.inject({ method: 'POST', url: '/posts/bulk', cookies, payload: { action: 'publish', keys, baseLanguageUpdatedAt } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 2, failed: 0, build: { ok: false } });
      expect({ maximum, transformed, buildCount }).toEqual({ maximum: 1, transformed: 2, buildCount: 1 });
      expect(builtTracks).toEqual([]);
      for (const [i, tk] of keys.entries()) expect((await posts.getPublishedTrack(tk)).track).toEqual(expected(i));
      for (const [index, tk] of keys.entries()) {
        const pair = (await posts.get(tk))!;
        const text = await readFile(join(root, 'mdx', 'trips', language.primary, `${pair[language.primary].slug}.mdx`), 'utf8');
        const trackLine = /^track: (.+)$/m.exec(text);
        expect(trackLine).not.toBeNull();
        // PostgreSQL JSONB reorders object keys. The contract is the complete
        // public geometry (including segment boundaries), not its JSON spelling.
        expect(JSON.parse(trackLine![1]!)).toEqual(expected(index));
        expect(text).not.toMatch(/elevation|sourceId|source_id|sha256|12\.345678|23\.456789/);
        const secondary = language.primary === 'de' ? 'en' : 'de';
        await expect(readFile(join(root, 'mdx', 'trips', secondary, `${pair[secondary].slug}.mdx`))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      failBuild = false;
      expect((await app.inject({ method: 'POST', url: '/rebuild', cookies })).json().ok).toBe(true);
      expect(builtTracks).toEqual([expected(), expected(1)]);
      expect(transformed).toBe(2); // rebuild consumes snapshots; it never transforms working routes
      const tk = keys[0]!;
      const tokens = await publishTokens(posts, tk);
      const complex: PrivateGeometry = { version: 1, segments: Array.from({ length: 21 }, (_, run) => ({
        points: Array.from({ length: 100 }, (_, i) => ({ lng: 10 + i * 0.001, lat: 20 + run * 0.1 + (i % 2) * 0.01 })),
      })) };
      await routes.attach(tk, { baseVersion: tokens.baseRouteVersion, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() }, complex,
        { translationKey: tk, sourceId: randomUUID(), sha256: 'b'.repeat(64), bytes: 100 }, true);
      const changed = await publishTokens(posts, tk);
      const refused = await app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies,
        payload: { baseUpdatedAt: changed.baseUpdatedAt.toISOString(), baseRouteVersion: changed.baseRouteVersion, baseLanguageUpdatedAt } });
      expect(refused.statusCode).toBe(422);
      expect(refused.headers['cache-control']).toBe('no-store');
      expect(refused.json()).toEqual({
        error: 'track_public_limit', code: 'track_public_limit',
        counts: { retainedRuns: expect.any(Number), vertices: 2001, bytes: expect.any(Number) },
      });
      const counts = refused.json<{ counts: PublicTrackCounts }>().counts;
      expect(counts.retainedRuns).toBeGreaterThan(0);
      expect(counts.retainedRuns).toBeLessThanOrEqual(101);
      expect(counts.bytes).toBeGreaterThan(0);
      expect(counts.bytes).toBeLessThanOrEqual(65_537);
      const bulkRefusal = await app.inject({ method: 'POST', url: '/posts/bulk', cookies, payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt } });
      expect(bulkRefusal.json()).toMatchObject({ succeeded: 0, failed: 1,
        results: [{ key: tk, ok: false, code: 'track_public_limit', counts: refused.json().counts }] });
      expect((await posts.getPublishedTrack(tk)).track).toEqual(expected());
      expect(buildCount).toBe(2); // Neither refusal switches a release or starts a build.
      // An ordinary single Publish and Export all use the same validated artifact.
      const secondKey = keys[1]!;
      const secondTokens = await publishTokens(posts, secondKey);
      const single = await app.inject({ method: 'POST', url: `/posts/${secondKey}/publish`, cookies,
        payload: { baseUpdatedAt: secondTokens.baseUpdatedAt.toISOString(), baseRouteVersion: secondTokens.baseRouteVersion, baseLanguageUpdatedAt } });
      expect(single.statusCode).toBe(200);
      const pair = (await posts.get(secondKey))!;
      const singleExport = await readFile(join(root, 'mdx', 'trips', language.primary, `${pair[language.primary].slug}.mdx`), 'utf8');
      const singleTrack = /^track: (.+)$/m.exec(singleExport);
      expect(singleTrack).not.toBeNull();
      expect(JSON.parse(singleTrack![1]!)).toEqual(expected(1));
      const exported = await app.inject({ method: 'POST', url: '/export', cookies });
      expect(exported.statusCode).toBe(200);
      expect(exported.json()).toMatchObject({ count: 2 });
      for (const [index, key] of keys.entries()) {
        const exportedPair = (await posts.get(key))!;
        const text = await readFile(join(root, 'mdx', 'trips', language.primary, `${exportedPair[language.primary].slug}.mdx`), 'utf8');
        const exportedTrack = /^track: (.+)$/m.exec(text);
        expect(exportedTrack).not.toBeNull();
        expect(JSON.parse(exportedTrack![1]!)).toEqual(expected(index));
        expect(text).not.toMatch(/elevation|sourceId|source_id|sha256|12\.345678|23\.456789/);
      }
    } finally {
      await app.close(); await queue.quiesce(); await worker.close(); await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
