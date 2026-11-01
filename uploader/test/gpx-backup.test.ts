import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbBackup, createRouteManifestPinReader, listBackups, listRouteArchives, pruneBackups, readDump, sweepOrphanRouteArchives, type Connectable, type Dump } from '../src/backup.js';
import { createRouteArchive, routeRecoverySummary, verifyRouteArchive, type RouteArchiveManifest, type RouteDumpRow } from '../src/gpx-backup.js';
import { createGpxFiles, safePairHash, sourceDigest, type GpxFiles } from '../src/gpx-files.js';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { identityDumpRow } from './site-identity-fixture.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';

const original = Buffer.from('<gpx><trk><trkseg><trkpt lat="1.123456789" lon="2.987654321"/></trkseg></trk></gpx>');
const now = new Date('2026-10-24T12:34:56.789Z');

// These are recovery-boundary fixtures, not parser fixtures: original bytes are
// opaque, and a retained original can legitimately have been damaged on disk.
function route(): RouteDumpRow {
  return { translation_key: randomUUID(), version: randomUUID(), geometry: null,
    source_id: randomUUID(), source_sha256: sourceDigest(original), source_bytes: original.length, updated_at: now.toISOString() };
}
function source(row: RouteDumpRow) {
  return { translationKey: row.translation_key, sourceId: row.source_id, sha256: row.source_sha256, bytes: row.source_bytes };
}
function dump(rows: RouteDumpRow[], routeArchive?: RouteArchiveManifest): Dump {
  return { version: 10, createdAt: now.toISOString(), tables: { users: [],
    posts: rows.flatMap((row) => ['de', 'en'].map((locale) => ({ translation_key: row.translation_key, locale }))),
    post_routes: rows }, ...(routeArchive ? { routeArchive } : {}) };
}
function database(rows: RouteDumpRow[]): Connectable {
  const query = async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ present: true, journeys: true, locales: true, members: true }]
    : sql.includes('FROM site_language') ? [{
      id: true, primary_locale: 'de', enabled_locales: ['de', 'en'], locked_at: null, updated_at: now.toISOString(),
    }]
    : sql.includes('FROM site_nav') ? [{ id: 1, config: DEFAULT_NAVIGATION, updated_at: now.toISOString() }]
    : sql.includes('FROM post_routes') ? rows.map((row) => ({ ...row }))
    : sql.includes('FROM site_identity ORDER') ? [identityDumpRow()]
    : sql.includes('FROM posts') ? dump(rows).tables.posts.map((row) => ({
      ...row, status: 'draft', omitted: false, published_at: null, published_snapshot: null,
    })) : [] });
  return { query, connect: async () => ({ query, release() {} }) };
}

let root: string;
let files: GpxFiles;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-backup-unit-'));
  files = createGpxFiles({ storageDir: join(root, 'images') });
  dir = join(root, 'backups');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function saveDump(name: string, value: Dump): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, gzipSync(JSON.stringify(value)));
  return path;
}
async function recoverySet() {
  const row = route();
  await files.writeOriginal(source(row), original);
  const manifest = (await createRouteArchive(files, dir, [row], now))!;
  const path = await saveDump('db-20261024-123456.json.gz', dump([row], manifest));
  return { row, manifest, path };
}

describe('private route recovery archives and retained-manifest pins', () => {
  it('clears the previous recovery claim during a failed new dump and restores it after a successful retry', async () => {
    const row = route();
    await files.writeOriginal(source(row), original);
    const db = database([row]);
    const backup = createDbBackup({ db, dir, routeFiles: files, retention: () => 5 });
    const successful = await backup.runNow();
    expect(successful.lastError).toBeUndefined();
    expect(successful.routeRecovery).toEqual({ status: 'complete', present: 1, missing: 0, corrupt: 0, unreadable: 0, oversized: 0 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const connect = vi.spyOn(db, 'connect').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic database unavailable');
    });
    const failedAttempt = backup.runNow();
    await entered.promise;
    const during = backup.state();
    release.resolve();
    const failed = await failedAttempt;
    expect(during.routeRecovery).toBeUndefined();
    expect(failed.lastError).toBe('synthetic database unavailable');
    expect(failed.lastSuccessAt).toBe(successful.lastSuccessAt);
    expect(failed.routeRecovery).toBeUndefined();
    expect(backup.state().routeRecovery).toBeUndefined();
    expect(backup.list()).toHaveLength(1);
    expect(backup.listRouteArchives()).toHaveLength(1);
    connect.mockRestore();
    const retried = await backup.runNow();
    expect(retried.lastError).toBeUndefined();
    expect(retried.routeRecovery).toEqual(successful.routeRecovery);
    expect(backup.state().routeRecovery).toEqual(successful.routeRecovery);
    expect(backup.list()).toHaveLength(2);
  });

  it.each(['complete', 'degraded'] as const)('preserves this run’s %s recovery evidence when later retention fails', async (status) => {
    const row = route();
    await files.writeOriginal(source(row), original);
    if (status === 'degraded') await files.removeOriginal(source(row));
    const backup = createDbBackup({
      db: database([row]), dir, routeFiles: files,
      retention: () => { throw new Error('synthetic retention failure'); },
    });
    const result = await backup.runNow();
    expect(result.lastError).toBe('prune failed: synthetic retention failure');
    expect(result.lastSuccessAt).toBeTruthy();
    expect(result.routeRecovery).toEqual({
      status, present: status === 'complete' ? 1 : 0, missing: status === 'degraded' ? 1 : 0,
      corrupt: 0, unreadable: 0, oversized: 0,
    });
    expect(backup.state().routeRecovery).toEqual(result.routeRecovery);
    const saved = backup.list();
    expect(saved).toHaveLength(1);
    const path = join(dir, saved[0]!.name);
    const manifest = readDump(path).routeArchive!;
    await verifyRouteArchive(path, manifest, [row]);
  });

  it('retains completed recovery evidence when ownership is lost immediately after dump publication', async () => {
    const row = route();
    await files.writeOriginal(source(row), original);
    let writable = true;
    const gate = files.gate.runExclusive.bind(files.gate);
    files.gate.runExclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
      const result = await gate(fn);
      writable = false;
      return result;
    };
    const backup = createDbBackup({ db: database([row]), dir, routeFiles: files, retention: () => 5, isWritable: () => writable });
    const result = await backup.runNow();
    expect(result.lastError).toBe('storage_read_only');
    expect(result.lastSuccessAt).toBeTruthy();
    expect(result.routeRecovery).toEqual({ status: 'complete', present: 1, missing: 0, corrupt: 0, unreadable: 0, oversized: 0 });
    const path = join(dir, backup.list()[0]!.name);
    await verifyRouteArchive(path, readDump(path).routeArchive!, [row]);
  });

  it('preserves bounded corrupt and empty bytes, omits unavailable bytes, and pins only unarchived salvageable sources', async () => {
    const rows = Array.from({ length: 6 }, route);
    for (const row of rows) await files.writeOriginal(source(row), original);
    const pathOf = (row: RouteDumpRow) => join(files.root, 'originals', safePairHash(row.translation_key), `${row.source_id}.gpx`);
    const damaged = Buffer.from('bounded damaged private source');
    await writeFile(pathOf(rows[1]!), damaged);
    await writeFile(pathOf(rows[2]!), Buffer.alloc(0));
    await rm(pathOf(rows[3]!));
    await writeFile(pathOf(rows[5]!), Buffer.alloc(GPX_LIMITS.fileBytes + 1));
    const inspect = files.inspectOriginal.bind(files);
    vi.spyOn(files, 'inspectOriginal').mockImplementation((value) => value.sourceId === rows[4]!.source_id
      ? Promise.resolve({ state: 'unreadable' }) : inspect(value));
    const manifest = (await createRouteArchive(files, dir, rows, now))!;
    const path = await saveDump('db-20261024-123456.json.gz', dump(rows, manifest));
    expect(readDump(path).routeArchive).toEqual(manifest);
    expect(manifest.originals.map((entry) => entry.state)).toEqual(['present', 'corrupt', 'corrupt', 'missing', 'unreadable', 'oversized']);
    expect(routeRecoverySummary(manifest)).toEqual({ status: 'degraded', present: 1, corrupt: 2, missing: 1, unreadable: 1, oversized: 1 });
    const recovered = new Map<string, Buffer>();
    await verifyRouteArchive(path, manifest, rows, async (entry, bytes) => { recovered.set(entry.sourceId, bytes); });
    expect([...recovered.keys()]).toEqual(rows.slice(0, 3).map((row) => row.source_id));
    expect(recovered.get(rows[0]!.source_id)).toEqual(original);
    expect(recovered.get(rows[1]!.source_id)).toEqual(damaged);
    expect(recovered.get(rows[2]!.source_id)).toEqual(Buffer.alloc(0));
    expect(await createRouteManifestPinReader(dir)()).toEqual(new Set([rows[4]!.source_id, rows[5]!.source_id]));
  });

  it.each(['payload', 'truncated', 'hash', 'unsafe-path', 'symlink-member', 'extra-member', 'nonzero-tail'] as const)(
    'rejects a %s archive even when attacker-controlled outer metadata is recomputed', async (kind) => {
      const { row, manifest, path } = await recoverySet();
      let bytes = await readFile(join(dir, manifest.name));
      if (kind === 'payload') bytes[512] = bytes[512]! ^ 1;
      if (kind === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
      if (kind === 'hash') manifest.sha256 = '0'.repeat(64);
      if (kind === 'unsafe-path' || kind === 'symlink-member') {
        const header = new Header({ path: kind === 'unsafe-path' ? '../escape.gpx' : `${safePairHash(row.translation_key)}/${row.source_id}.gpx`,
          type: kind === 'symlink-member' ? 'SymbolicLink' : 'File', linkpath: kind === 'symlink-member' ? '../escape.gpx' : '',
          size: original.length, mode: 0o600 });
        bytes.fill(0, 0, 512); header.encode(bytes);
      }
      if (kind === 'extra-member') {
        const header = Buffer.alloc(512);
        new Header({ path: 'unexpected.gpx', type: 'File', size: 0, mode: 0o600 }).encode(header);
        bytes = Buffer.concat([bytes.subarray(0, -1024), header, Buffer.alloc(1024)]);
      }
      if (kind === 'nonzero-tail') bytes[bytes.length - 1] = 1;
      if (kind !== 'hash') manifest.sha256 = sourceDigest(bytes);
      await writeFile(join(dir, manifest.name), bytes);
      await expect(verifyRouteArchive(path, manifest, [row])).rejects.toThrow();
      expect((await files.inspectOriginal(source(row))).bytes).toEqual(original);
    },
  );

  it('rejects an archive replaced by a symlink rather than following it', async () => {
    const { row, manifest, path } = await recoverySet();
    const archive = join(dir, manifest.name);
    const outside = join(root, 'outside.tar');
    await writeFile(outside, await readFile(archive));
    await rm(archive); await symlink(outside, archive);
    await expect(verifyRouteArchive(path, manifest, [row])).rejects.toThrow();
    expect(await readFile(outside)).toHaveLength(manifest.bytes);
  });

  it.each(['pairHash', 'sourceId', 'expectedSha256', 'expectedBytes'] as const)(
    'rejects manifest %s that does not identify the dumped original', async (field) => {
      const { manifest, path } = await recoverySet();
      const value = readDump(path);
      const entry = manifest.originals[0]!;
      if (field === 'sourceId') entry.sourceId = randomUUID();
      else if (field === 'expectedBytes') entry.expectedBytes++;
      else entry[field] = '0'.repeat(64);
      value.routeArchive = manifest;
      await saveDump('db-20261024-123456.json.gz', value);
      expect(() => readDump(path)).toThrow();
    },
  );

  it('retains shared archives until the last referring dump expires, then releases cached pins', async () => {
    const row = route(); await files.writeOriginal(source(row), original);
    const inspect = vi.spyOn(files, 'inspectOriginal').mockResolvedValue({ state: 'unreadable' });
    const manifest = (await createRouteArchive(files, dir, [row], now))!;
    const value = dump([row], manifest);
    await saveDump('db-20261024-123456.json.gz', value);
    await saveDump('db-20261024-123457.json.gz', value);
    const pins = createRouteManifestPinReader(dir);
    expect(await pins()).toEqual(new Set([row.source_id]));
    expect(pruneBackups(dir, 1)).toEqual(['db-20261024-123456.json.gz']);
    expect(listRouteArchives(dir).map((entry) => entry.name)).toEqual([manifest.name]);
    expect(await pins()).toEqual(new Set([row.source_id]));
    inspect.mockRestore();
    const complete = (await createRouteArchive(files, dir, [row], new Date(now.getTime() + 2000)))!;
    await saveDump('db-20261024-123458.json.gz', dump([row], complete));
    pruneBackups(dir, 1);
    expect(listRouteArchives(dir).map((entry) => entry.name)).toEqual([complete.name]);
    expect(await pins()).toEqual(new Set());
  });

  it('advertises only completed recovery sets and expires only old unreferenced archives', async () => {
    const { row, manifest } = await recoverySet();
    const orphan = (await createRouteArchive(files, dir, [row], now))!;
    const fresh = (await createRouteArchive(files, dir, [row], now))!;
    const clock = new Date();
    const old = new Date(clock.getTime() - 3_600_001);
    await utimes(join(dir, manifest.name), old, old);
    await utimes(join(dir, orphan.name), old, old);
    await utimes(join(dir, fresh.name), clock, clock);
    expect(listRouteArchives(dir).map((entry) => entry.name)).toEqual([manifest.name]);
    expect(sweepOrphanRouteArchives(dir, clock.getTime())).toEqual([orphan.name]);
    expect(await readFile(join(dir, manifest.name))).toHaveLength(manifest.bytes);
    expect(await readFile(join(dir, fresh.name))).toHaveLength(fresh.bytes);
    await expect(readFile(join(dir, orphan.name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves incomplete archives when a retained dump cannot be read', async () => {
    const { row, path } = await recoverySet();
    const orphan = (await createRouteArchive(files, dir, [row], now))!;
    const clock = new Date();
    const old = new Date(clock.getTime() - 3_600_001);
    await utimes(join(dir, orphan.name), old, old);
    await writeFile(path, 'damaged private dump');
    expect(() => sweepOrphanRouteArchives(dir, clock.getTime())).toThrow();
    expect(listRouteArchives(dir)).toEqual([]);
    expect(await readFile(join(dir, orphan.name))).toHaveLength(orphan.bytes);
  });

  it('fails closed on a changed cached manifest without pruning any recovery artifacts', async () => {
    const { manifest, path } = await recoverySet();
    const pins = createRouteManifestPinReader(dir);
    expect(await pins()).toEqual(new Set());
    await writeFile(path, 'not a gzip recovery set');
    await expect(pins()).rejects.toThrow();
    expect(() => pruneBackups(dir, 0)).toThrow();
    expect(listBackups(dir)).toHaveLength(1);
    expect(await readFile(join(dir, manifest.name))).toHaveLength(manifest.bytes);
  });
});
