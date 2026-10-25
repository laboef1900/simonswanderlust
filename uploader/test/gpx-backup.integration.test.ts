import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { Header } from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { createRouteManifestPinReader, dumpDatabase, readDump, restoreDatabase } from '../src/backup.js';
import { verifyRouteArchive, type RouteDumpRow } from '../src/gpx-backup.js';
import { createGpxFiles, safePairHash, sourceDigest, type GpxFiles } from '../src/gpx-files.js';
import { GPX_LIMITS, type PrivateGeometry } from '../public/gpx-geometry.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const now = new Date('2026-10-24T12:34:56.789Z');
const geometry: PrivateGeometry = { version: 1, segments: [{ points: [
  { lat: 1.123456789, lng: 2.987654321, elevation: -12.345678, time: '2026-10-24T12:34:56.123Z' },
  { lat: 1.123987654, lng: 2.987123456, elevation: 123.456789, time: '2026-10-24T12:35:57.987Z' },
] }] };
const original = Buffer.from('<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg><trkpt lat="1.123456789" lon="2.987654321"><ele>-12.345678</ele><time>2026-10-24T12:34:56.123Z</time></trkpt><trkpt lat="1.123987654" lon="2.987123456"><ele>123.456789</ele><time>2026-10-24T12:35:57.987Z</time></trkpt></trkseg></trk></gpx>');
const source = (row: RouteDumpRow) => ({ translationKey: row.translation_key, sourceId: row.source_id, sha256: row.source_sha256, bytes: row.source_bytes });

afterEach(() => vi.restoreAllMocks());

maybe('private v10 recovery with isolated PostgreSQL state', () => {
  let owner: DbPool;
  let pool: DbPool;
  let root: string;
  let dir: string;
  let files: GpxFiles;
  const schema = 'gpx_backup_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    // All destructive SQL is restricted by this pool's unique search_path.
    await pool.query('DELETE FROM comments');
    await pool.query('DELETE FROM post_routes');
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM route_cleanup');
    root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-backup-pg-'));
    files = createGpxFiles({ storageDir: join(root, 'images') });
    dir = join(root, 'backups');
  });
  afterEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS reject_restore_commit ON post_routes');
    await pool.query('DROP TRIGGER IF EXISTS observe_restore_delete ON posts');
    await pool.query('DROP TRIGGER IF EXISTS observe_restore_delete ON comments');
    await pool.query('DROP SEQUENCE IF EXISTS restore_delete_seen');
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  async function seed(detached = false): Promise<RouteDumpRow> {
    const slug = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${slug}`, title: 'Synthetic recovery story',
      excerpt: '', country: 'Test', heroImage: { src: '', width: 1, height: 1, alt: '' }, bodyMarkdown: 'Synthetic body', images: {} });
    const pair = await pgPostStore(pool).upsertDraft({ translationKey: '', status: 'draft',
      shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    const row: RouteDumpRow = { translation_key: pair.translationKey, version: randomUUID(), geometry: detached ? null : geometry,
      source_id: randomUUID(), source_sha256: sourceDigest(original), source_bytes: original.length, updated_at: now.toISOString() };
    await files.writeOriginal(source(row), original);
    await pool.query(`INSERT INTO post_routes (translation_key,version,geometry,source_id,source_sha256,source_bytes,updated_at)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`, [row.translation_key, row.version, row.geometry === null ? null : JSON.stringify(row.geometry), row.source_id, row.source_sha256, row.source_bytes, row.updated_at]);
    return row;
  }
  async function current(): Promise<RouteDumpRow[]> {
    const result = await pool.query<Omit<RouteDumpRow, 'updated_at'> & { updated_at: Date }>('SELECT * FROM post_routes ORDER BY translation_key');
    return result.rows.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() }));
  }
  async function capture() {
    const path = join(dir, await dumpDatabase(pool, dir, now, { routeFiles: files }));
    return { path, dump: readDump(path) };
  }
  const pathOf = (row: RouteDumpRow) => join(files.root, 'originals', safePairHash(row.translation_key), `${row.source_id}.gpx`);

  it('round-trips precise private geometry and detached originals with fresh identities while preserving cleanup intents', async () => {
    const attached = await seed(); const detached = await seed(true);
    await pool.query('INSERT INTO route_cleanup (source_id,pair_hash,requested_at) VALUES ($1,$2,$3)',
      [attached.source_id, safePairHash(attached.translation_key), now]);
    const cleanupBefore = (await pool.query('SELECT * FROM route_cleanup')).rows;
    const { path, dump } = await capture();
    expect(dump.version).toBe(10);
    expect(dump.tables.post_routes).toEqual(await current());
    expect(dump.tables).not.toHaveProperty('route_cleanup');
    expect(dump.tables).not.toHaveProperty('post_revisions');
    await verifyRouteArchive(path, dump.routeArchive, dump.tables.post_routes!);
    await pool.query('UPDATE post_routes SET geometry = NULL');
    await pool.query("UPDATE posts SET body_markdown='changed since backup'");
    const counts = await restoreDatabase(pool, path, { routeFiles: files });
    expect(counts.routes).toBe(2); expect(counts.posts).toBe(4);
    for (const previous of [attached, detached]) {
      const restored = (await current()).find((row) => row.translation_key === previous.translation_key)!;
      expect(restored).toMatchObject({ geometry: previous.geometry, updated_at: previous.updated_at,
        source_sha256: previous.source_sha256, source_bytes: previous.source_bytes });
      expect(restored.source_id).not.toBe(previous.source_id);
      expect(restored.version).not.toBe(previous.version);
      expect((await files.inspectOriginal(source(restored))).bytes).toEqual(original);
      expect((await files.inspectOriginal(source(previous))).bytes).toEqual(original);
    }
    expect((await pool.query('SELECT body_markdown FROM posts')).rows.every((row) => row.body_markdown === 'Synthetic body')).toBe(true);
    expect((await pool.query('SELECT * FROM route_cleanup')).rows).toEqual(cleanupBefore);
    expect(await files.listOriginals()).toHaveLength(4);
  });

  it('restores declared damage without inventing original bytes or discarding precise geometry', async () => {
    const states = ['corrupt', 'empty', 'missing', 'unreadable', 'oversized'] as const;
    const rows: RouteDumpRow[] = [];
    for (const state of states) {
      const row = await seed(); rows.push(row);
      if (state === 'corrupt') await writeFile(pathOf(row), 'damaged private bytes');
      if (state === 'empty') await writeFile(pathOf(row), Buffer.alloc(0));
      if (state === 'missing') await rm(pathOf(row));
      if (state === 'oversized') await writeFile(pathOf(row), Buffer.alloc(GPX_LIMITS.fileBytes + 1));
    }
    const inspect = files.inspectOriginal.bind(files);
    const inspection = vi.spyOn(files, 'inspectOriginal').mockImplementation((value) => value.sourceId === rows[3]!.source_id
      ? Promise.resolve({ state: 'unreadable' }) : inspect(value));
    const { path, dump } = await capture();
    inspection.mockRestore();
    await verifyRouteArchive(path, dump.routeArchive, dump.tables.post_routes!);
    expect(await createRouteManifestPinReader(dir)()).toEqual(new Set([rows[3]!.source_id, rows[4]!.source_id]));
    expect((await restoreDatabase(pool, path, { routeFiles: files })).routes).toBe(5);
    const restored = await current();
    for (const [index, before] of rows.entries()) {
      const after = restored.find((row) => row.translation_key === before.translation_key)!;
      expect(after.geometry).toEqual(geometry);
      expect(after.source_id).not.toBe(before.source_id);
      const inspected = await files.inspectOriginal(source(after));
      expect(inspected.state).toBe(index < 2 ? 'corrupt' : 'missing');
      if (index < 2) expect(inspected.bytes).toEqual(index === 0 ? Buffer.from('damaged private bytes') : Buffer.alloc(0));
    }
    // Restoration must not erase salvageable local bytes that were not archived.
    expect(await readFile(pathOf(rows[3]!))).toEqual(original);
    expect(await readFile(pathOf(rows[4]!))).toHaveLength(GPX_LIMITS.fileBytes + 1);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('restores v%i with empty route state rather than reusing current routes', async (version) => {
    const previous = await seed();
    const { path, dump } = await capture();
    dump.version = version; delete dump.tables.post_routes; delete dump.routeArchive;
    await writeFile(path, gzipSync(JSON.stringify(dump)));
    expect(readDump(path).version).toBe(version);
    expect((await restoreDatabase(pool, path, { routeFiles: files })).routes).toBe(0);
    expect(await current()).toEqual([]);
    expect((await pgPostStore(pool).get(previous.translation_key))?.de.bodyMarkdown).toBe('Synthetic body');
    expect((await files.inspectOriginal(source(previous))).bytes).toEqual(original);
    expect((await pool.query('SELECT published_snapshot FROM posts')).rows.every((row) => row.published_snapshot === null)).toBe(true);
  });

  it.each(['tampered', 'truncated', 'unsafe', 'manifest-identity'] as const)(
    'rejects %s recovery before destructive SQL or overwriting a live original', async (kind) => {
      const row = await seed(); const { path, dump } = await capture();
      const manifest = dump.routeArchive!;
      const archive = join(dir, manifest.name);
      let bytes = await readFile(archive);
      if (kind === 'tampered') bytes[512] = bytes[512]! ^ 1;
      if (kind === 'truncated') bytes = bytes.subarray(0, -512);
      if (kind === 'unsafe') {
        bytes.fill(0, 0, 512);
        new Header({ path: '../outside.gpx', type: 'File', size: original.length, mode: 0o600 }).encode(bytes);
        manifest.sha256 = sourceDigest(bytes);
      }
      if (kind === 'manifest-identity') manifest.originals[0]!.pairHash = '0'.repeat(64);
      await writeFile(archive, bytes); await writeFile(path, gzipSync(JSON.stringify(dump)));
      // Sequence increments survive rollback: unchanged rows alone would miss a
      // destructive transaction that was wrongly started before archive validation.
      await pool.query('CREATE SEQUENCE restore_delete_seen');
      await pool.query(`CREATE OR REPLACE FUNCTION observe_restore_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('restore_delete_seen'); RETURN OLD; END $$`);
      await pool.query('CREATE TRIGGER observe_restore_delete BEFORE DELETE ON posts FOR EACH ROW EXECUTE FUNCTION observe_restore_delete()');
      await pool.query('CREATE TRIGGER observe_restore_delete BEFORE DELETE ON comments FOR EACH STATEMENT EXECUTE FUNCTION observe_restore_delete()');
      await expect(restoreDatabase(pool, path, { routeFiles: files })).rejects.toThrow();
      expect((await pool.query('SELECT is_called FROM restore_delete_seen')).rows[0]!.is_called).toBe(false);
      expect(await current()).toEqual([row]);
      expect(await readFile(pathOf(row))).toEqual(original);
      expect(await files.listOriginals()).toHaveLength(1);
      await expect(readFile(join(root, 'outside.gpx'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rolls back a definite pre-COMMIT failure and discards only staged originals', async () => {
    const row = await seed(); const { path } = await capture();
    let checks = 0;
    await expect(restoreDatabase(pool, path, { routeFiles: files, assertOwner: async () => {
      if (++checks === 2) throw new Error('synthetic ownership refusal before COMMIT');
    } })).rejects.toThrow();
    expect(checks).toBe(2);
    expect(await current()).toEqual([row]);
    expect(await files.listOriginals()).toHaveLength(1);
    expect((await files.inspectOriginal(source(row))).bytes).toEqual(original);
  });

  it('retains old and staged originals when PostgreSQL refuses a deferred COMMIT', async () => {
    const row = await seed(); const { path } = await capture();
    await pool.query(`CREATE OR REPLACE FUNCTION reject_restore_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic deferred restore failure'; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_restore_commit AFTER INSERT ON post_routes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_restore_commit()`);
    await expect(restoreDatabase(pool, path, { routeFiles: files })).rejects.toThrow();
    expect(await current()).toEqual([row]);
    const originals = await files.listOriginals(); expect(originals).toHaveLength(2);
    for (const entry of originals) expect(await readFile(join(files.root, 'originals', entry.pairHash, `${entry.sourceId}.gpx`))).toEqual(original);
  });

  it.each([false, true])('preserves both file sets after lost COMMIT acknowledgement (recovery query unavailable: %s)', async (unavailable) => {
    const row = await seed(); const { path } = await capture();
    let commitAcknowledgementLost = false;
    // Only the transport acknowledgement is faulted. Every transaction statement,
    // including COMMIT, still executes against this suite's real PostgreSQL schema.
    const faultPool = new Proxy(pool, { get(target, key) {
      if (key === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, property) {
          if (property === 'query') return async (sql: string, params?: unknown[]) => {
            const result = await connection.query(sql, params);
            if (sql === 'COMMIT') { commitAcknowledgementLost = true; throw new Error('synthetic lost COMMIT acknowledgement'); }
            return result;
          };
          const value: unknown = Reflect.get(connection, property);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      if (key === 'query' && unavailable && commitAcknowledgementLost) return async () => { throw new Error('synthetic recovery connection unavailable'); };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = restoreDatabase(faultPool, path, { routeFiles: files });
    if (unavailable) await expect(result).rejects.toThrow();
    else expect((await result).routes).toBe(1);
    expect(commitAcknowledgementLost).toBe(true);
    const restored = (await current())[0]!;
    expect(restored.source_id).not.toBe(row.source_id); expect(restored.geometry).toEqual(geometry);
    expect((await files.inspectOriginal(source(row))).bytes).toEqual(original);
    expect((await files.inspectOriginal(source(restored))).bytes).toEqual(original);
    expect(await files.listOriginals()).toHaveLength(2);
  });

  it('holds the file-mutation gate until snapshot and archive capture complete', async () => {
    const row = await seed();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const inspect = files.inspectOriginal.bind(files);
    vi.spyOn(files, 'inspectOriginal').mockImplementationOnce(async (value) => {
      entered.resolve(); await release.promise; return inspect(value);
    });
    const backup = capture();
    await entered.promise;
    let removed = false;
    const mutation = files.gate.runExclusive(async () => { await files.removeOriginal(source(row)); removed = true; });
    try {
      expect(await files.gate.tryRunExclusive(async () => 'must not enter')).toEqual({ acquired: false });
      expect(removed).toBe(false);
    } finally { release.resolve(); }
    const { path, dump } = await backup;
    await mutation; expect(removed).toBe(true);
    const archived: Buffer[] = [];
    await verifyRouteArchive(path, dump.routeArchive, dump.tables.post_routes!, async (_entry, bytes) => { archived.push(bytes); });
    expect(archived).toEqual([original]);
    expect((await files.inspectOriginal(source(row))).state).toBe('missing');
  });
});
