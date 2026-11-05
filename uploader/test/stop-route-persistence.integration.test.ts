import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale, type PostStore } from '../src/posts.js';
import { pgGpxStore } from '../src/gpx-store.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { dumpDatabase, readDump, restoreDatabase } from '../src/backup.js';
import { seedSiteIdentity } from '../src/site-identity.js';
import type { RouteStop, StoredStopRoute } from '../public/stop-route.js';
import { publishTokens } from './publish-tokens.js';
import { ROUTE_STOPS, storedRouteFor } from './stop-route-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
/** Only the fields the tamper cases touch; the file was just written by dumpDatabase. */
interface DumpCopy { version: number; tables: { posts: { stop_route: StoredStopRoute | null; published_snapshot: Record<string, unknown> }[] } }

maybe('stop routes in PostgreSQL: Publish, GPX precedence, backup (#513)', () => {
  const schema = `stop_route_${randomUUID().replaceAll('-', '')}`;
  let owner: DbPool;
  let pool: DbPool;
  let worker: PublicTrackWorker;
  let posts: PostStore;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
    await seedSiteIdentity(pool);
    worker = createPublicTrackWorker();
    posts = pgPostStore(pool, { publicTrackWorker: worker });
  });
  afterAll(async () => {
    await worker?.close();
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  async function story(stops: RouteStop[] = ROUTE_STOPS) {
    const id = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${id}`, title: 'Route story', country: 'Greece', excerpt: 'Excerpt', heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Hero' }, bodyMarkdown: 'Text', images: {} });
    const pair = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'GR', region: 'europe', coordinates: { lat: 38, lng: 23 }, stops }, de: locale('de'), en: locale('en') });
    return pair.translationKey;
  }
  const rows = async (tk: string) => (await pool.query<{ locale: string; stop_route: unknown; published_snapshot: Record<string, unknown> | null; updated_at: Date }>(
    'SELECT locale, stop_route, published_snapshot, updated_at FROM posts WHERE translation_key=$1 ORDER BY locale', [tk])).rows;
  const setStops = async (tk: string, stops: RouteStop[]) => {
    const current = (await posts.get(tk))!;
    await posts.upsertDraft({ ...current, shared: { ...current.shared, stops } }, current.updatedAt);
  };

  it('lists the countries bundled routing must cover: stories with two or more stops, never the placeholder', async () => {
    const make = async (countryCode: string, stops: RouteStop[] | undefined) => {
      const id = randomUUID();
      const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${id}`, title: 'Country story', country: 'X', excerpt: 'Excerpt', heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Hero' }, bodyMarkdown: 'Text', images: {} });
      await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode, region: 'europe', coordinates: { lat: 38, lng: 23 }, ...(stops ? { stops } : {}) }, de: locale('de'), en: locale('en') });
    };
    const before = await posts.routingCountries();
    await make('cr', ROUTE_STOPS);
    await make('MX', ROUTE_STOPS.slice(0, 2));
    await make('DK', ROUTE_STOPS.slice(0, 1));
    await make('NL', undefined);
    await make('XX', ROUTE_STOPS);
    const after = await posts.routingCountries();
    expect(after.filter((code) => !before.includes(code))).toEqual(['CR', 'MX']);
    expect(after).not.toContain('XX');
  });

  it('stores on both rows without touching updated_at, publishes only while fresh, and tracks draftDiffers', async () => {
    const tk = await story();
    const before = await rows(tk);
    const route = storedRouteFor(ROUTE_STOPS);
    await posts.saveStopRoute(tk, route);
    const after = await rows(tk);
    expect(after.map((row) => row.stop_route)).toEqual([route, route]);
    expect(after.map((row) => row.updated_at)).toEqual(before.map((row) => row.updated_at));
    expect(await posts.getStopRoute(tk)).toEqual(route);

    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('published');
    for (const row of await rows(tk)) expect(row.published_snapshot?.stop_route).toEqual(route.route);
    expect((await posts.get(tk))!.publication).toMatchObject({ draftDiffers: false });
    expect((await posts.getPublishedTrack(tk)).stopRoute).toEqual(route.route);

    await setStops(tk, ROUTE_STOPS.map((stop, i) => i === 3 ? { ...stop, lng: stop.lng + 0.5 } : stop));
    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('stale');
    for (const row of await rows(tk)) expect(row.published_snapshot).not.toHaveProperty('stop_route');
    expect((await posts.get(tk))!.publication).toMatchObject({ draftDiffers: false });

    const recalculated = storedRouteFor((await posts.get(tk))!.shared.stops!, '2026-11-03T11:00:00.000Z');
    await posts.saveStopRoute(tk, recalculated);
    expect((await posts.get(tk))!.publication).toMatchObject({ draftDiffers: true });
    expect((await posts.list()).find((summary) => summary.translationKey === tk)?.publication).toMatchObject({ draftDiffers: true });
    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('published');
    for (const row of await rows(tk)) expect(row.published_snapshot?.stop_route).toEqual(recalculated.route);
  });

  it('refuses invalid routes and unknown pairs without changing the stored value', async () => {
    const tk = await story();
    const route = storedRouteFor(ROUTE_STOPS);
    await posts.saveStopRoute(tk, route);
    await expect(posts.saveStopRoute(tk, { ...route, legs: [] })).rejects.toMatchObject({ code: 'invalid_stop_route' });
    await expect(posts.saveStopRoute(randomUUID(), route)).rejects.toMatchObject({ code: 'not_found' });
    await expect(posts.getStopRoute(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    expect((await rows(tk)).map((row) => row.stop_route)).toEqual([route, route]);
    // A DE/EN mismatch (manual repair gone wrong) is never published.
    await pool.query("UPDATE posts SET stop_route=NULL WHERE translation_key=$1 AND locale='en'", [tk]);
    expect(await posts.getStopRoute(tk)).toBeNull();
    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('stale');
  });

  it('lets a published GPX track win and reveals the stop route after detaching', async () => {
    const tk = await story();
    await posts.saveStopRoute(tk, storedRouteFor(ROUTE_STOPS));
    const routes = pgGpxStore(pool);
    const source = { translationKey: tk, sourceId: randomUUID(), sha256: 'a'.repeat(64), bytes: 100 };
    let tokens = await publishTokens(posts, tk);
    await routes.attach(tk, { baseVersion: tokens.baseRouteVersion, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() },
      { version: 1, segments: [{ points: [{ lng: 23.1, lat: 37.1 }, { lng: 23.2, lat: 37.2 }] }] }, source, true);
    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('superseded');
    for (const row of await rows(tk)) {
      expect(row.published_snapshot).toHaveProperty('track');
      expect(row.published_snapshot).not.toHaveProperty('stop_route');
    }
    expect((await posts.get(tk))!.publication).toMatchObject({ draftDiffers: false });
    tokens = await publishTokens(posts, tk);
    await routes.detach(tk, { baseVersion: tokens.baseRouteVersion, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() });
    expect((await posts.get(tk))!.publication).toMatchObject({ draftDiffers: true });
    expect((await posts.publish(tk, await publishTokens(posts, tk))).stopRoute).toBe('published');
    for (const row of await rows(tk)) {
      expect(row.published_snapshot).not.toHaveProperty('track');
      expect(row.published_snapshot?.stop_route).toEqual(storedRouteFor(ROUTE_STOPS).route);
    }
  });

  it('round-trips stop_route, via/profile stops and the published projection through a v15 dump, and refuses tampering before any write', async () => {
    await pool.query('DELETE FROM post_routes');
    await pool.query('DELETE FROM posts');
    const tk = await story();
    const route = storedRouteFor(ROUTE_STOPS);
    await posts.saveStopRoute(tk, route);
    await posts.publish(tk, await publishTokens(posts, tk));
    const before = await rows(tk);
    const dir = await mkdtemp(join(tmpdir(), 'stop-route-backup-'));
    const file = join(dir, await dumpDatabase(pool, dir));
    const dump = readDump(file);
    expect(dump.version).toBe(15);
    expect(dump.tables.posts.map((post) => post.stop_route)).toEqual([route, route]);

    await pool.query('DELETE FROM posts');
    await restoreDatabase(pool, file);
    const restored = await rows(tk);
    expect(restored.map((row) => [row.stop_route, row.published_snapshot])).toEqual(before.map((row) => [row.stop_route, row.published_snapshot]));
    expect((await posts.get(tk))!.shared.stops).toEqual(ROUTE_STOPS);

    const raw: DumpCopy = JSON.parse(gunzipSync(await readFile(file)).toString('utf8'));
    const tampered = async (name: string, mutate: (copy: DumpCopy) => void) => {
      const copy = structuredClone(raw);
      mutate(copy);
      const path = join(dir, name);
      await writeFile(path, gzipSync(JSON.stringify(copy)));
      return path;
    };
    const cases = [
      await tampered('db-20260101-000001.json.gz', (copy) => { copy.tables.posts[1]!.stop_route = null; }),
      await tampered('db-20260101-000002.json.gz', (copy) => { for (const post of copy.tables.posts) post.stop_route!.legs = []; }),
      await tampered('db-20260101-000003.json.gz', (copy) => {
        for (const post of copy.tables.posts) post.published_snapshot.track = { version: 1, type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]]] };
      }),
      await tampered('db-20260101-000004.json.gz', (copy) => { copy.version = 14; }),
    ];
    for (const path of cases) {
      await expect(restoreDatabase(pool, path)).rejects.toThrow(/Invalid stop routes in backup|Invalid public route snapshots/);
      expect((await rows(tk)).map((row) => row.stop_route)).toEqual([route, route]);
    }
  });

  // A route calculated for 4 stops stays stored when a later draft save removes a
  // stop or clears them all. That is stale data, not corruption: every backup,
  // and the pre-restore undo dump, must still capture it.
  it('captures and restores a stale stored route whose stop count changed after Calculate', async () => {
    const route = storedRouteFor(ROUTE_STOPS);
    const removed = await story();
    await posts.saveStopRoute(removed, route);
    await setStops(removed, ROUTE_STOPS.slice(0, 3));
    const cleared = await story();
    await posts.saveStopRoute(cleared, route);
    await setStops(cleared, []);
    const before = [...await rows(removed), ...await rows(cleared)];

    const dir = await mkdtemp(join(tmpdir(), 'stop-route-stale-backup-'));
    const file = join(dir, await dumpDatabase(pool, dir));
    await pool.query('DELETE FROM posts');
    await restoreDatabase(pool, file);
    const restored = [...await rows(removed), ...await rows(cleared)];
    expect(restored.map((row) => row.stop_route)).toEqual(before.map((row) => row.stop_route));
    expect(restored.map((row) => row.stop_route)).toEqual([route, route, route, route]);
    expect((await posts.publish(removed, await publishTokens(posts, removed))).stopRoute).toBe('stale');
  });
});
