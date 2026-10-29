import { seedSiteIdentity } from '../src/site-identity.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { publishTokens } from './publish-tokens.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { createDbBackup, createRouteManifestPinReader, dumpDatabase, readDump } from '../src/backup.js';
import { ensureSchema, type DbPool } from '../src/db.js';
import { createEncodeQueue, type EncodeQueue } from '../src/encode-queue.js';
import { createGpxFiles, safePairHash, type GpxFiles, type OriginalSource } from '../src/gpx-files.js';
import { createGpxService, type GpxService } from '../src/gpx-service.js';
import { pgGpxStore } from '../src/gpx-store.js';
import { createGpxWorker } from '../src/gpx-worker.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memoryPageStore } from '../src/pages.js';
import { pgPostStore, type PostLocale, type PostStore } from '../src/posts.js';
import { memorySecretsStore } from '../src/secrets.js';
import { buildServer, type AppServer } from '../src/server.js';
import { pgSessionStore } from '../src/sessions.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { pgUserStore } from '../src/users.js';
import { createWorkLock } from '../src/work-lock.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const xml = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><metadata><name>PRIVATE_DELETE_SOURCE</name></metadata><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2.001"/></trkseg></trk></gpx>');
const selection = { startPoints: 0, endPoints: 0, removedSegments: [] };
type DeleteMode = 'single' | 'bulk';

maybe('private GPX post deletion and durable cleanup', () => {
  let observer: DbPool;
  let pool: DbPool;
  let schema: string;
  let root: string;
  let backupDir: string;
  let app: AppServer;
  let service: GpxService;
  let files: GpxFiles;
  let posts: PostStore;
  let publicTrackWorker: PublicTrackWorker;
  let queue: EncodeQueue;
  let authorId: string;
  let cookies: { sid: string };
  let writable: boolean;
  const build = vi.fn(async () => ({ ok: true as const, release: 'synthetic' }));

  function start() {
    files = createGpxFiles({ storageDir: join(root, 'images'), isWritable: () => writable });
    publicTrackWorker = createPublicTrackWorker();
    posts = pgPostStore(pool, { routeFiles: files, isWritable: () => writable, publicTrackWorker });
    service = createGpxService({ pool, files, worker: createGpxWorker(), backupDir,
      isWritable: () => writable, readManifestPins: createRouteManifestPinReader(backupDir) });
    const media = memoryMediaStore({ baseUrl: 'https://images.test' });
    queue = createEncodeQueue({ store: media, storageDir: join(root, 'images'), lock: createWorkLock() });
    app = buildServer({
      trustProxy: TEST_TRUST,
      storageDir: join(root, 'images'), baseUrl: 'https://images.test', imgHost: 'images.test',
      siteDir: join(root, 'site'), backupDir,
      users: pgUserStore(pool), sessions: pgSessionStore(pool), posts,
      pages: memoryPageStore(), media, encodeQueue: queue, secrets: memorySecretsStore(),
      settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
      builder: { build, hasRelease: () => true, quiesce: async () => {} },
      dbBackup: createDbBackup({ db: pool, dir: backupDir, retention: () => 10, routeFiles: files }),
      dbCheck: async () => { await pool.query('SELECT 1'); }, gpx: service, isWritable: () => writable,
    });
  }

  beforeEach(async () => {
    schema = 'gpx_delete_' + randomUUID().replaceAll('-', '');
    observer = new pg.Pool({ connectionString: url });
    await observer.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
    await seedSiteIdentity(pool);
    root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-delete-'));
    backupDir = join(root, 'backup', 'db');
    for (const dir of ['images', 'site', 'backup/db']) await mkdir(join(root, dir), { recursive: true });
    authorId = (await pgUserStore(pool).create({ username: 'synthetic-admin', password: 'synthetic-password', isAdmin: true })).id;
    cookies = { sid: await pgSessionStore(pool).create(authorId, 60_000) };
    writable = true;
    build.mockClear();
    start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await service?.close();
    await publicTrackWorker?.close();
    await queue?.quiesce();
    await pool?.end();
    if (observer) { await observer.query(`DROP SCHEMA ${schema} CASCADE`); await observer.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const slug = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${slug}`, title: 'Synthetic story', excerpt: 'Synthetic excerpt', country: 'Test', heroImage: { src: 'https://images.test/hero', width: 100, height: 100, alt: 'Landscape' }, bodyMarkdown: 'Synthetic text', images: {} });
    const pair = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    const tk = pair.translationKey;
    const preview = await service.importBytes(authorId, xml);
    await service.attach(authorId, tk, { importId: preview.importId, baseVersion: null, baseUpdatedAt: pair.updatedAt.toISOString(), selection, confirmReplace: false });
    const current = (await posts.get(tk))!;
    await posts.upsertDraft({ ...current, de: { ...current.de, title: 'Revised synthetic story' } });
    await pool.query('INSERT INTO comments (id, translation_key, locale, name, body) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), tk, 'de', 'Synthetic reader', 'Synthetic comment']);
    const record = (await pgGpxStore(pool).get(tk))!;
    // A safely named file with no committed pointer models an unknown-COMMIT
    // candidate; deletion must enqueue it, not wait for the one-hour orphan age.
    const leftover: OriginalSource = { ...record.source, sourceId: randomUUID() };
    await files.writeOriginal(leftover, xml);
    return { tk, record, leftover };
  }

  function remove(mode: DeleteMode, keys: string[]) {
    return mode === 'single'
      ? app.inject({ method: 'DELETE', url: `/posts/${keys[0]}`, cookies })
      : app.inject({ method: 'POST', url: '/posts/bulk', cookies, payload: { action: 'delete', keys } });
  }

  async function unavailable(tk: string) {
    const inspect = vi.spyOn(files, 'inspectOriginal');
    try {
      for (const [method, suffix] of [['GET', ''], ['GET', '/original'], ['POST', '/import']] as const) {
        const response = await app.inject({ method, url: `/posts/${tk}/route${suffix}`, cookies });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('PRIVATE_DELETE_SOURCE');
      }
      expect(inspect).not.toHaveBeenCalled();
    } finally { inspect.mockRestore(); }
  }

  it.each<DeleteMode>(['single', 'bulk'])('%s deletion commits current and leftover intents, overrides damaged-source pins and retries after restart', async mode => {
    const targets = [await seed()];
    if (mode === 'bulk') targets.push(await seed());
    const survivor = await seed();
    const survivorBefore = await posts.get(survivor.tk);
    for (const { record } of targets) {
      await truncate(join(files.root, 'originals', safePairHash(record.source.translationKey), `${record.source.sourceId}.gpx`), GPX_LIMITS.fileBytes + 1);
      expect((await files.inspectOriginal(record.source)).state).toBe('oversized');
    }
    const dumpName = await dumpDatabase(pool, backupDir, new Date(), { routeFiles: files });
    const dump = readDump(join(backupDir, dumpName));
    const backupBefore = await readdir(backupDir);
    const pins = await createRouteManifestPinReader(backupDir)();
    for (const { record } of targets) {
      expect(pins.has(record.source.sourceId)).toBe(true);
      expect(dump.routeArchive?.originals).toContainEqual(expect.objectContaining({ sourceId: record.source.sourceId, state: 'oversized' }));
    }
    const unlink = vi.spyOn(files, 'removeStoredOriginal').mockRejectedValue(new Error('synthetic private unlink failure'));
    const response = await remove(mode, targets.map(({ tk }) => tk));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject(mode === 'single'
      ? { deleted: true, cleanupPending: true }
      : { action: 'delete', succeeded: targets.length, failed: 0, cleanupPending: true, results: targets.map(({ tk }) => ({ key: tk, ok: true })) });
    expect(response.body).not.toContain('synthetic private unlink failure');
    expect(build).not.toHaveBeenCalled();
    const expectedIntents = targets.flatMap(({ tk, record, leftover }) => [record.source, leftover].map(source => ({ source_id: source.sourceId, pair_hash: safePairHash(tk) }))).sort((a, b) => a.source_id.localeCompare(b.source_id));
    expect((await pool.query('SELECT source_id, pair_hash FROM route_cleanup ORDER BY source_id')).rows).toEqual(expectedIntents);
    for (const { tk, record, leftover } of targets) {
      for (const table of ['posts', 'post_routes', 'post_revisions', 'comments']) {
        expect((await pool.query(`SELECT 1 FROM ${table} WHERE translation_key=$1`, [tk])).rowCount).toBe(0);
      }
      expect((await files.listOriginals(safePairHash(tk))).map(source => source.sourceId).sort()).toEqual([record.source.sourceId, leftover.sourceId].sort());
      await unavailable(tk);
    }
    unlink.mockRestore();
    await app.close(); await service.close(); await queue.quiesce();
    // Recreate the service, files, worker, manifest reader and post store: only
    // persisted cleanup intents can authorize immediate removal after restart.
    start();
    expect(await service.reconcile()).toEqual({ skipped: false, cleanupPending: false });
    expect((await pool.query('SELECT 1 FROM route_cleanup')).rowCount).toBe(0);
    for (const { tk, record, leftover } of targets) {
      expect(await files.listOriginals(safePairHash(tk))).toEqual([]);
      expect((await files.inspectOriginal(record.source)).state).toBe('missing');
      expect((await files.inspectOriginal(leftover)).state).toBe('missing');
      await unavailable(tk);
    }
    expect(await posts.get(survivor.tk)).toEqual(survivorBefore);
    expect(await service.original(survivor.tk)).toEqual(xml);
    expect((await files.inspectOriginal(survivor.leftover)).state).toBe('present');
    expect(await readdir(backupDir)).toEqual(backupBefore);
  });

  it.each<DeleteMode>(['single', 'bulk'])('%s deletion rolls back post, route and cleanup intents together when commit fails', async mode => {
    const { tk, record, leftover } = await seed();
    const before = await posts.get(tk);
    const revisions = await posts.listRevisions(tk);
    const comments = (await pool.query('SELECT * FROM comments WHERE translation_key=$1', [tk])).rows;
    expect(revisions.length).toBeGreaterThan(0);
    await pool.query(`CREATE FUNCTION reject_delete_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup commit failure'; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_delete_commit AFTER INSERT ON route_cleanup DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_delete_commit()`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await remove(mode, [tk]);
    expect(response.statusCode).toBe(mode === 'single' ? 500 : 200);
    if (mode === 'bulk') expect(response.json()).toMatchObject({ succeeded: 0, failed: 1, results: [{ key: tk, ok: false, error: 'internal error' }] });
    expect(response.body).not.toContain('synthetic cleanup commit failure');
    expect(response.json().cleanupPending).toBeUndefined();
    log.mockRestore();
    expect(await posts.get(tk)).toEqual(before);
    expect(await pgGpxStore(pool).get(tk)).toEqual(record);
    expect(await posts.listRevisions(tk)).toEqual(revisions);
    expect((await pool.query('SELECT * FROM comments WHERE translation_key=$1', [tk])).rows).toEqual(comments);
    expect((await pool.query('SELECT 1 FROM route_cleanup')).rowCount).toBe(0);
    expect(await service.original(tk)).toEqual(xml);
    expect((await files.inspectOriginal(leftover)).state).toBe('present');
    expect(build).not.toHaveBeenCalled();
  });

  it('returns storage_read_only 503 when unpublish loses ownership after HTTP admission, without changing the published pair', async () => {
    const { tk, record } = await seed();
    await posts.publish(tk, await publishTokens(posts, tk));
    const before = await posts.get(tk);
    const get = posts.get.bind(posts);
    vi.spyOn(posts, 'get').mockImplementationOnce(async key => {
      const pair = await get(key);
      // The handler has passed admission and read a real published pair. The
      // real PG store must still refuse the write when ownership then latches.
      writable = false;
      return pair;
    });
    const response = await app.inject({ method: 'POST', url: `/posts/${tk}/unpublish`, cookies });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ error: 'storage_read_only' });
    expect(await get(tk)).toEqual(before);
    expect(await pgGpxStore(pool).get(tk)).toEqual(record);
    expect(build).not.toHaveBeenCalled();
  });
});
