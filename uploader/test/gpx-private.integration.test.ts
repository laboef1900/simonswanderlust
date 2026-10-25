import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { createAuthn } from '../src/authn.js';
import { pgUserStore } from '../src/users.js';
import { pgSessionStore } from '../src/sessions.js';
import { createGpxFiles, safePairHash, type GpxFiles } from '../src/gpx-files.js';
import { createGpxWorker } from '../src/gpx-worker.js';
import { createGpxService, type GpxService, type ImportPreview, type RouteMutation } from '../src/gpx-service.js';
import { registerGpxRoutes } from '../src/gpx-routes.js';
import { pgGpxStore } from '../src/gpx-store.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const xml = Buffer.from('<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2.001"/><trkpt lat="1.002" lon="2.002"/></trkseg></trk><wpt lat="4" lon="5"><name>Synthetic waypoint</name></wpt></gpx>');
const selection = { startPoints: 0, endPoints: 0, removedSegments: [] };
interface Fixture { app: FastifyInstance; service: GpxService; files: GpxFiles; tk: string; token: string; root: string; pins: Set<string>; manifests: { readable: boolean }; author: { sid: string }; other: { sid: string } }

maybe('private GPX API and real PostgreSQL transactions', () => {
  let owner: DbPool; let pool: DbPool;
  const schema = 'gpx_' + randomUUID().replaceAll('-', '');
  const fixtures: Fixture[] = [];
  let authorId: string; let otherId: string;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
    const users = pgUserStore(pool);
    authorId = (await users.create({ username: 'gpx-author', password: 'synthetic-password', isAdmin: false })).id;
    otherId = (await users.create({ username: 'gpx-other', password: 'synthetic-password', isAdmin: false })).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const f of fixtures.splice(0)) { await f.app.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
    await pool.query('DROP TRIGGER IF EXISTS gpx_reject_commit ON post_routes');
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
  async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-private-'));
    const files = createGpxFiles({ storageDir: join(root, 'images') });
    const pins = new Set<string>();
    const manifests = { readable: true };
    const service = createGpxService({ pool, files, worker: createGpxWorker(), backupDir: join(root, 'backup'),
      readManifestPins: async () => { if (!manifests.readable) throw new Error('synthetic unreadable manifest'); return pins; } });
    const slug = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${slug}`, title: 'Synthetic story', excerpt: '', country: 'Test', heroImage: { src: '', width: 1, height: 1, alt: '' }, bodyMarkdown: 'Synthetic text only', images: {} });
    const pair = await pgPostStore(pool).upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    const users = pgUserStore(pool); const sessions = pgSessionStore(pool);
    const app = Fastify({ logger: false, trustProxy: 1 });
    await app.register(cookie); await app.register(multipart);
    app.decorateRequest('authUser', null);
    registerGpxRoutes(app, { gpx: service, requireAuth: createAuthn(users, sessions).requireAuth });
    const result = { app, service, files, tk: pair.translationKey, token: pair.updatedAt.toISOString(), root, pins, manifests,
      author: { sid: await sessions.create(authorId, 60_000) }, other: { sid: await sessions.create(otherId, 60_000) } };
    fixtures.push(result); return result;
  }
  async function upload(f: Fixture): Promise<ImportPreview> {
    const boundary = 'synthetic-boundary';
    const response = await f.app.inject({ method: 'POST', url: '/gpx/imports', cookies: f.author,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: 'http://localhost' },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.gpx"\r\nContent-Type: application/octet-stream\r\n\r\n`), xml, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    return response.json<ImportPreview>();
  }
  async function attach(f: Fixture, preview: ImportPreview, version: string | null = null, token = f.token, confirmReplace = false) {
    return f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.author,
      payload: { importId: preview.importId, baseVersion: version, baseUpdatedAt: token, selection, confirmReplace } });
  }

  it('authenticates all eight endpoints before parsing, and confines malformed framework errors', async () => {
    const f = await fixture();
    const endpoints = [['POST', '/gpx/imports'], ['DELETE', '/gpx/imports/unknown'], ['GET', `/posts/${f.tk}/route`], ['GET', `/posts/${f.tk}/route/original`], ['POST', `/posts/${f.tk}/route/import`], ['PUT', `/posts/${f.tk}/route`], ['DELETE', `/posts/${f.tk}/route`]] as const;
    for (const [method, path] of endpoints) {
      const result = await f.app.inject({ method, url: path });
      expect(result.statusCode).toBe(401); expect(result.headers['cache-control']).toBe('no-store');
    }
    const malformed = await f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.author, headers: { 'content-type': 'application/json' }, payload: '{"PRIVATE_LOCATION_SECRET":' });
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain('PRIVATE_LOCATION_SECRET');
    expect(malformed.headers['cache-control']).toBe('no-store');
    const oversized = await f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.author, payload: { secret: 'x'.repeat(65 * 1024) } });
    expect(oversized.statusCode).toBe(413);
    const foreign = await f.app.inject({ method: 'DELETE', url: '/gpx/imports/unknown', cookies: f.author, headers: { origin: 'https://blog.test.attacker.test' } });
    expect(foreign.statusCode).toBe(403);
  });

  it('binds mutation Origin to the admin request authority, not the image origin or forwarded host', async () => {
    const f = await fixture();
    for (const headers of [
      { host: 'localhost:80', origin: 'http://localhost' },
      { host: 'journal.test:443', origin: 'https://journal.test', 'x-forwarded-proto': 'https' },
    ]) {
      const result = await f.app.inject({ method: 'DELETE', url: '/gpx/imports/unknown', cookies: f.author, headers });
      expect(result.statusCode, result.body).toBe(204);
    }
    for (const origin of ['https://blog.test', 'https://journal.test.attacker.test', 'null', 'https://journal.test/path']) {
      const result = await f.app.inject({ method: 'DELETE', url: '/gpx/imports/unknown', cookies: f.author,
        headers: { host: 'journal.test', 'x-forwarded-proto': 'https', origin } });
      expect(result.statusCode).toBe(403);
    }
    const spoofed = await f.app.inject({ method: 'DELETE', url: '/gpx/imports/unknown', cookies: f.author,
      headers: { host: 'journal.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test', origin: 'https://attacker.test' } });
    expect(spoofed.statusCode).toBe(403);
    const malformedHost = await f.app.inject({ method: 'DELETE', url: '/gpx/imports/unknown', cookies: f.author,
      headers: { host: 'a b', origin: 'http://localhost' } });
    expect(malformedHost.statusCode).toBe(403);
    // light-my-request supplies localhost for an empty Host; use a real HTTP
    // request to cover Node's missing-Host rejection instead of testing the shim.
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const missingHost = Promise.withResolvers<number>();
    const request = httpRequest(address + '/gpx/imports/unknown', { method: 'DELETE', setHost: false,
      headers: { cookie: `sid=${f.author.sid}`, origin: address } }, (response) => {
      response.resume();
      response.once('end', () => missingHost.resolve(response.statusCode!));
    });
    request.once('error', missingHost.reject);
    request.end();
    expect(await missingHost.promise).toBe(400);
  });

  it('admits a real HTTP upload after asynchronous inventory and stages its validated original', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const listPending = f.files.listPending.bind(f.files);
    vi.spyOn(f.files, 'listPending').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return listPending();
    });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const boundary = 'delayed-admission-boundary';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.gpx"\r\n\r\n`), xml, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const completed = Promise.withResolvers<{ status: number; body: string }>();
    const sent = Promise.withResolvers<void>();
    const request = httpRequest(address + '/gpx/imports', { method: 'POST', headers: {
      cookie: `sid=${f.author.sid}`, 'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length), origin: address,
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', completed.reject);
      response.on('end', () => completed.resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', completed.reject);
    request.once('finish', () => sent.resolve());
    request.end(payload);
    await Promise.all([entered.promise, sent.promise]);
    release.resolve();
    const response = await completed.promise;
    expect(response.status, response.body).toBe(201);
    const preview = JSON.parse(response.body) as ImportPreview;
    expect(preview.geometry.segments[0]?.points).toHaveLength(3);
    expect(await f.files.listPending()).toHaveLength(1);
    const attached = await attach(f, preview);
    expect(attached.statusCode, attached.body).toBe(200);
    expect(await f.service.original(f.tk)).toEqual(xml);
  });

  it('stages privately for its author, attaches explicitly, bumps BOTH locale tokens and retains original after detach', async () => {
    const f = await fixture(); const preview = await upload(f);
    const read = await f.app.inject({ url: `/posts/${f.tk}/route`, cookies: f.other });
    expect(read.json()).toEqual({ version: null, geometry: null, originalAvailable: false, sourceBytes: null });
    expect((await f.app.inject({ method: 'DELETE', url: `/gpx/imports/${preview.importId}`, cookies: f.other })).statusCode).toBe(204);
    const foreignAttach = await f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.other, payload: { importId: preview.importId, baseVersion: null, baseUpdatedAt: f.token, selection, confirmReplace: false } });
    expect(foreignAttach.statusCode).toBe(404);
    const response = await attach(f, preview); expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<RouteMutation>();
    expect(saved.geometry?.segments[0]?.points).toHaveLength(3);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(f.token));
    const timestamps = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM posts WHERE translation_key=$1 ORDER BY locale', [f.tk]);
    expect(timestamps.rows.map((row) => row.updated_at.toISOString())).toEqual([saved.updatedAt, saved.updatedAt]);
    const ordinary = await pgPostStore(pool).get(f.tk);
    expect(JSON.stringify(ordinary)).not.toContain('segments');
    expect((await pool.query('SELECT 1 FROM post_revisions WHERE translation_key=$1', [f.tk])).rows).toHaveLength(0);
    expect(response.body).not.toContain('sourceId'); expect(response.body).not.toContain('sha256'); expect(response.body).not.toContain(f.root);
    const detach = await f.app.inject({ method: 'DELETE', url: `/posts/${f.tk}/route`, cookies: f.other, payload: { baseVersion: saved.version, baseUpdatedAt: saved.updatedAt, confirmDetach: true } });
    expect(detach.statusCode).toBe(200); expect(detach.json().geometry).toBeNull(); expect(detach.json().version).not.toBe(saved.version);
    const download = await f.app.inject({ url: `/posts/${f.tk}/route/original`, cookies: f.other });
    expect(download.rawPayload).toEqual(xml); expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toBe('attachment; filename="route.gpx"'); expect(download.headers['x-content-type-options']).toBe('nosniff');
    const recovered = await f.app.inject({ method: 'POST', url: `/posts/${f.tk}/route/import`, cookies: f.other });
    expect(recovered.statusCode).toBe(201); expect(recovered.json().geometry).toEqual(saved.geometry);
    expect((await f.service.get(f.tk)).geometry).toBeNull();
  });

  it('rejects stale form or route tokens and unconfirmed replacement without losing its staged preview', async () => {
    const f = await fixture(); const first = await attach(f, await upload(f)); const current = first.json<RouteMutation>();
    const replacement = await upload(f);
    expect((await attach(f, replacement, current.version, f.token, true)).statusCode).toBe(409);
    expect((await attach(f, replacement, null, current.updatedAt, true)).statusCode).toBe(409);
    expect((await attach(f, replacement, current.version, current.updatedAt, false)).statusCode).toBe(409);
    expect((await f.files.listPending()).length).toBe(1);
    const before = await pgGpxStore(pool).get(f.tk); f.pins.add(before!.source.sourceId);
    const unlink = vi.spyOn(f.files, 'removeStoredOriginal').mockRejectedValueOnce(new Error('private filesystem path'));
    const replaced = await attach(f, replacement, current.version, current.updatedAt, true);
    expect(replaced.statusCode).toBe(200); expect(replaced.json().cleanupPending).toBe(true);
    expect((await pool.query('SELECT 1 FROM route_cleanup WHERE source_id=$1', [before!.source.sourceId])).rowCount).toBe(1);
    unlink.mockRestore(); await f.service.reconcile();
    expect((await f.files.inspectOriginal(before!.source)).state).toBe('missing');
    expect((await pool.query('SELECT 1 FROM route_cleanup WHERE source_id=$1', [before!.source.sourceId])).rowCount).toBe(0);
  });

  it('preserves files and preview on an unconfirmed COMMIT outcome and resolves state by read', async () => {
    const f = await fixture(); const saved = (await attach(f, await upload(f))).json<RouteMutation>();
    const preview = await upload(f);
    await pool.query(`CREATE OR REPLACE FUNCTION reject_gpx_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER gpx_reject_commit AFTER INSERT OR UPDATE ON post_routes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_gpx_commit()`);
    const response = await attach(f, preview, saved.version, saved.updatedAt, true);
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'gpx_outcome_unknown' });
    expect((await f.files.listOriginals()).filter((source) => source.pairHash === safePairHash(f.tk))).toHaveLength(2);
    expect(await f.files.listPending()).toHaveLength(1);
    expect((await f.service.get(f.tk)).version).toBe(saved.version);
  });

  it('enforces physical staging quotas, exact expiry and cancellation without a backup gate queue', async () => {
    const f = await fixture(); const first = await upload(f); await upload(f);
    await expect(f.service.importBytes(authorId, xml)).rejects.toMatchObject({ code: 'gpx_quota' });
    const time = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(time + 60 * 60 * 1000 + 1);
    await expect(f.service.attach(authorId, f.tk, { importId: first.importId, baseVersion: null, baseUpdatedAt: f.token, selection, confirmReplace: false })).rejects.toMatchObject({ code: 'gpx_import_unavailable' });
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const capture = f.files.gate.runExclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    expect(await f.service.reconcile()).toEqual({ skipped: true, cleanupPending: true });
    expect(await f.files.listPending()).toHaveLength(2);
    release.resolve(); await capture; await f.service.reconcile();
    expect(await f.files.listPending()).toHaveLength(0);
  });

  it('refuses re-import immediately during backup capture without occupying upload admission', async () => {
    const f = await fixture();
    const preview = await f.service.importBytes(authorId, xml);
    await f.service.attach(authorId, f.tk, { importId: preview.importId, baseVersion: null, baseUpdatedAt: f.token, selection, confirmReplace: false });
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const capture = f.files.gate.runExclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const gateAttempted = Promise.withResolvers<void>();
    let attempts = 0;
    const noteAttempt = () => { if (++attempts === 2) gateAttempted.resolve(); };
    const run = f.files.gate.runExclusive.bind(f.files.gate);
    const tryRun = f.files.gate.tryRunExclusive.bind(f.files.gate);
    vi.spyOn(f.files.gate, 'runExclusive').mockImplementation(<T>(fn: () => Promise<T>) => { noteAttempt(); return run(fn); });
    vi.spyOn(f.files.gate, 'tryRunExclusive').mockImplementation(<T>(fn: () => Promise<T>) => { noteAttempt(); return tryRun(fn); });
    const attempted = f.service.reimport(authorId, f.tk).then(
      (value) => ({ value }), (error: unknown) => ({ error }));
    await gateAttempted.promise;
    // Drain the already-enqueued admission continuation, not a guessed clock delay.
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    try {
      const uploaded = await f.service.importBytes(authorId, xml);
      expect(uploaded.geometry.segments[0]?.points).toEqual([
        { lat: 1, lng: 2 }, { lat: 1.001, lng: 2.001 }, { lat: 1.002, lng: 2.002 },
      ]);
      expect(await attempted).toMatchObject({ error: { code: 'gpx_busy' } });
    } finally {
      release.resolve(); await capture;
      await attempted;
    }
  });

  it('missing or corrupt original does not discard saved geometry and cannot be downloaded or reparsed', async () => {
    const f = await fixture(); await attach(f, await upload(f)); const row = await pgGpxStore(pool).get(f.tk);
    await writeFile(join(f.files.root, 'originals', safePairHash(f.tk), row!.source.sourceId + '.gpx'), 'corrupt private bytes');
    const state = await f.service.get(f.tk); expect(state.geometry).not.toBeNull(); expect(state.originalAvailable).toBe(false);
    await expect(f.service.original(f.tk)).rejects.toMatchObject({ code: 'gpx_original_unavailable' });
    await expect(f.service.reimport(authorId, f.tk)).rejects.toMatchObject({ code: 'gpx_original_unavailable' });
  });

  it('deletes orphan route rows transactionally and never exposes deleted post originals', async () => {
    const f = await fixture(); await attach(f, await upload(f)); const row = await pgGpxStore(pool).get(f.tk);
    await pool.query('DELETE FROM posts WHERE translation_key=$1', [f.tk]);
    await expect(f.service.original(f.tk)).rejects.toMatchObject({ code: 'gpx_post_not_found' });
    await f.service.reconcile();
    expect((await pool.query('SELECT 1 FROM post_routes WHERE translation_key=$1', [f.tk])).rows).toHaveLength(0);
    expect((await f.files.inspectOriginal(row!.source)).state).toBe('missing');
  });

  it('reparses and trims the staged source rather than accepting client geometry', async () => {
    const f = await fixture(); const preview = await upload(f);
    const body = { importId: preview.importId, baseVersion: null, baseUpdatedAt: f.token, selection: { ...selection, startPoints: 1 }, confirmReplace: false };
    const rejected = await f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.author, payload: { ...body, geometry: preview.geometry } });
    expect(rejected.statusCode).toBe(400);
    const saved = await f.app.inject({ method: 'PUT', url: `/posts/${f.tk}/route`, cookies: f.author, payload: body });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<RouteMutation>().geometry?.segments[0]?.points).toEqual(preview.geometry.segments[0]!.points.slice(1));
    expect(await f.service.original(f.tk)).toEqual(xml);
  });

  it('reports blocked manifest cleanup while still expiring staging and obeying explicit removal intents', async () => {
    const f = await fixture(); await attach(f, await upload(f));
    const current = (await pgGpxStore(pool).get(f.tk))!;
    const orphan = { ...current.source, sourceId: randomUUID() };
    const explicitlyRetired = { ...current.source, sourceId: randomUUID() };
    await f.files.writeOriginal(orphan, xml); await f.files.writeOriginal(explicitlyRetired, xml);
    await upload(f);
    await pool.query('INSERT INTO route_cleanup (source_id,pair_hash,requested_at) VALUES ($1,$2,clock_timestamp())', [explicitlyRetired.sourceId, safePairHash(f.tk)]);
    const time = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(time + 60 * 60 * 1000 + 1);
    f.manifests.readable = false;
    await f.service.reconcile();
    expect(f.service.orphanCleanup()).toEqual({ status: 'blocked', reason: 'manifest_unreadable', deferredOriginals: null });
    expect(await f.files.listPending()).toHaveLength(0);
    expect((await f.files.inspectOriginal(orphan)).state).toBe('present');
    expect((await f.files.inspectOriginal(explicitlyRetired)).state).toBe('missing');
    f.manifests.readable = true; f.pins.add(orphan.sourceId);
    await f.service.reconcile();
    expect(f.service.orphanCleanup()).toEqual({ status: 'ready', reason: null, deferredOriginals: 1 });
    f.pins.clear(); await f.service.reconcile();
    expect((await f.files.inspectOriginal(orphan)).state).toBe('missing');
    expect((await f.files.inspectOriginal(current.source)).state).toBe('present');
  });

  it('does not erase unreferenced originals while reference checks are unavailable', async () => {
    const f = await fixture(); await attach(f, await upload(f));
    const current = (await pgGpxStore(pool).get(f.tk))!;
    const orphan = { ...current.source, sourceId: randomUUID() };
    await f.files.writeOriginal(orphan, xml);
    const time = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(time + 60 * 60 * 1000 + 1);
    const query = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('synthetic DB outage'));
    await expect(f.service.reconcile()).rejects.toThrow('synthetic DB outage');
    query.mockRestore();
    expect((await f.files.inspectOriginal(orphan)).state).toBe('present');
  });

  it('reports failed cancellation honestly and counts retained bytes until a successful retry', async () => {
    const f = await fixture(); const first = await upload(f); await upload(f);
    const removal = vi.spyOn(f.files, 'removePending').mockRejectedValue(new Error('synthetic unlink refusal'));
    await expect(f.service.cancel(authorId, first.importId)).rejects.toMatchObject({ code: 'gpx_cleanup_pending' });
    await expect(f.service.attach(authorId, f.tk, { importId: first.importId, baseVersion: null, baseUpdatedAt: f.token, selection, confirmReplace: false })).rejects.toMatchObject({ code: 'gpx_import_unavailable' });
    await expect(f.service.importBytes(authorId, xml)).rejects.toMatchObject({ code: 'gpx_quota' });
    expect(await f.files.listPending()).toHaveLength(2);
    removal.mockRestore(); await f.service.cancel(authorId, first.importId);
    await f.service.cancel(authorId, first.importId);
    expect(await f.files.listPending()).toHaveLength(1);
  });

  it('does not reinterpret session-store failure as anonymous access or echo private failure details', async () => {
    const f = await fixture();
    const query = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'));
    const response = await f.app.inject({ url: `/posts/${f.tk}/route`, cookies: f.author });
    query.mockRestore();
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'gpx_unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
