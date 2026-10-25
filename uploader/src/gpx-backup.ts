import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Header } from 'tar';
import { GPX_LIMITS, validateGeometry, type PrivateGeometry } from '../public/gpx-geometry.js';
import { safePairHash, sourceDigest, SOURCE_ID_RE, type GpxFiles, type OriginalSource } from './gpx-files.js';
import { diskSpace, UPLOAD_HEADROOM_BYTES } from './disk.js';

export const ROUTE_ARCHIVE_RE = /^routes-\d{8}-\d{6}-[0-9a-f]{32}\.tar$/;
const SHA_RE = /^[0-9a-f]{64}$/;
export class RouteBackupError extends Error {
  constructor(message = 'Invalid private route recovery set.') { super(message); }
}
export interface RouteDumpRow {
  translation_key: string; version: string; geometry: PrivateGeometry | null;
  source_id: string; source_sha256: string; source_bytes: number; updated_at: string;
}
export interface RouteArchiveEntry {
  pairHash: string; sourceId: string; expectedBytes: number; expectedSha256: string;
  state: 'present' | 'missing' | 'corrupt' | 'unreadable' | 'oversized';
  archivedBytes?: number; archivedSha256?: string;
}
export interface RouteArchiveManifest {
  version: 1; name: string; sha256: string; bytes: number; originals: RouteArchiveEntry[];
}
export interface RouteRecoverySummary {
  status: 'complete' | 'degraded'; present: number; missing: number; corrupt: number; unreadable: number; oversized: number;
}
const rowKeys = ['translation_key', 'version', 'geometry', 'source_id', 'source_sha256', 'source_bytes', 'updated_at'];
const entryKeys = ['pairHash', 'sourceId', 'expectedBytes', 'expectedSha256', 'state', 'archivedBytes', 'archivedSha256'];
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
function boundedSize(value: unknown, empty = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (empty ? 0 : 1) && value <= GPX_LIMITS.fileBytes;
}

/** Closed route rows and complete two-locale parent identities, independent of SQL. */
export function validateRouteDumpRows(value: unknown, posts: readonly Record<string, unknown>[]): asserts value is RouteDumpRow[] {
  if (!Array.isArray(value)) throw new RouteBackupError();
  const locales = new Map<string, string[]>();
  for (const post of posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) throw new RouteBackupError();
    if (typeof post.translation_key !== 'string' || typeof post.locale !== 'string') continue;
    const found = locales.get(post.translation_key);
    if (found) found.push(post.locale);
    else locales.set(post.translation_key, [post.locale]);
  }
  const pairs = new Set<string>();
  const sources = new Set<string>();
  for (const row of value) {
    if (!object(row, rowKeys) || Object.keys(row).length !== rowKeys.length
      || typeof row.translation_key !== 'string' || !row.translation_key || row.translation_key.includes('\0')
      || typeof row.version !== 'string' || !SOURCE_ID_RE.test(row.version)
      || typeof row.source_id !== 'string' || !SOURCE_ID_RE.test(row.source_id)
      || typeof row.source_sha256 !== 'string' || !SHA_RE.test(row.source_sha256)
      || !boundedSize(row.source_bytes) || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))
      || pairs.has(row.translation_key) || sources.has(row.source_id)) throw new RouteBackupError();
    if (new Date(row.updated_at).toISOString() !== row.updated_at) throw new RouteBackupError();
    const parent = locales.get(row.translation_key);
    if (parent?.length !== 2 || !parent.includes('de') || !parent.includes('en')) throw new RouteBackupError('A private route has no complete post pair.');
    try { if (row.geometry !== null) validateGeometry(row.geometry); }
    catch { throw new RouteBackupError('Invalid private route geometry in recovery set.'); }
    pairs.add(row.translation_key); sources.add(row.source_id);
  }
}

export function validateRouteManifest(value: unknown, rows: readonly RouteDumpRow[]): asserts value is RouteArchiveManifest {
  if (!object(value, ['version', 'name', 'sha256', 'bytes', 'originals']) || Object.keys(value).length !== 5
    || value.version !== 1 || typeof value.name !== 'string' || !ROUTE_ARCHIVE_RE.test(value.name)
    || typeof value.sha256 !== 'string' || !SHA_RE.test(value.sha256)
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1024
    || !Array.isArray(value.originals) || value.originals.length !== rows.length) throw new RouteBackupError();
  const expected = new Map(rows.map((row) => [row.source_id, row]));
  const seen = new Set<string>();
  let archiveBytes = 1024;
  for (const entry of value.originals) {
    if (!object(entry, entryKeys) || typeof entry.sourceId !== 'string' || !SOURCE_ID_RE.test(entry.sourceId)
      || seen.has(entry.sourceId) || typeof entry.pairHash !== 'string' || !SHA_RE.test(entry.pairHash)
      || typeof entry.expectedSha256 !== 'string' || !SHA_RE.test(entry.expectedSha256) || !boundedSize(entry.expectedBytes)) throw new RouteBackupError();
    const row = expected.get(entry.sourceId);
    if (!row || entry.pairHash !== safePairHash(row.translation_key) || entry.expectedBytes !== row.source_bytes
      || entry.expectedSha256 !== row.source_sha256) throw new RouteBackupError();
    if (entry.state === 'present' || entry.state === 'corrupt') {
      if (Object.keys(entry).length !== 7 || !boundedSize(entry.archivedBytes, true)
        || typeof entry.archivedSha256 !== 'string' || !SHA_RE.test(entry.archivedSha256)) throw new RouteBackupError();
      const same = entry.archivedBytes === entry.expectedBytes && entry.archivedSha256 === entry.expectedSha256;
      if ((entry.state === 'present') !== same) throw new RouteBackupError();
      archiveBytes += 512 + Math.ceil(entry.archivedBytes / 512) * 512;
    } else if (!['missing', 'unreadable', 'oversized'].includes(String(entry.state)) || Object.keys(entry).length !== 5) {
      throw new RouteBackupError();
    }
    seen.add(entry.sourceId);
  }
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes !== value.bytes) throw new RouteBackupError();
}

export function routeRecoverySummary(manifest: RouteArchiveManifest | undefined): RouteRecoverySummary {
  const summary: RouteRecoverySummary = { status: 'complete', present: 0, missing: 0, corrupt: 0, unreadable: 0, oversized: 0 };
  for (const entry of manifest?.originals ?? []) {
    summary[entry.state]++;
    if (entry.state !== 'present') summary.status = 'degraded';
  }
  return summary;
}

/** Caller holds the route-file gate and the dump's REPEATABLE READ snapshot.
 * Header is the existing tar package's USTAR encoder. Only regular generated
 * names are written; no source file is copied to another staging directory. */
export async function createRouteArchive(files: GpxFiles, dir: string, rows: readonly RouteDumpRow[], now: Date, isWritable: () => boolean = () => true): Promise<RouteArchiveManifest | undefined> {
  const writable = () => { if (!isWritable()) throw new RouteBackupError('storage_read_only'); };
  writable();
  if (rows.length === 0) return undefined;
  await files.assertRoot();
  writable();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const estimate = 1024 + rows.reduce((sum, row) => sum + 512 + Math.ceil(row.source_bytes / 512) * 512, 0);
  if ((await diskSpace(dir)).free < UPLOAD_HEADROOM_BYTES + estimate) throw new RouteBackupError('Not enough space for the private route recovery archive.');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `routes-${stamp}-${randomBytes(16).toString('hex')}.tar`;
  const temporary = join(dir, `${name}.${process.pid}.tmp`);
  const final = join(dir, name);
  writable();
  const handle = await open(temporary, 'wx', 0o600);
  const digest = createHash('sha256');
  const zero = Buffer.alloc(1024);
  const headerBytes = Buffer.alloc(512);
  const originals: RouteArchiveEntry[] = [];
  let size = 0;
  let published = false;
  const write = async (bytes: Uint8Array) => {
    writable();
    await handle.writeFile(bytes);
    digest.update(bytes); size += bytes.byteLength;
  };
  try {
    for (const row of rows) {
      const source = { translationKey: row.translation_key, sourceId: row.source_id, sha256: row.source_sha256, bytes: row.source_bytes };
      const inspected = await files.inspectOriginal(source);
      const entry: RouteArchiveEntry = {
        pairHash: safePairHash(row.translation_key), sourceId: row.source_id,
        expectedBytes: row.source_bytes, expectedSha256: row.source_sha256, state: inspected.state,
      };
      if (inspected.state === 'present' || inspected.state === 'corrupt') {
        const bytes = inspected.bytes;
        if (!bytes || !inspected.actualSha256) throw new RouteBackupError();
        entry.archivedBytes = bytes.length; entry.archivedSha256 = inspected.actualSha256;
        if ((await diskSpace(dir)).free < UPLOAD_HEADROOM_BYTES + bytes.length + 2048) throw new RouteBackupError('Not enough space for the private route recovery archive.');
        headerBytes.fill(0);
        const header = new Header({ path: `${entry.pairHash}/${entry.sourceId}.gpx`, type: 'File', size: bytes.length, mode: 0o600, uid: 0, gid: 0, mtime: new Date(0) });
        if (header.encode(headerBytes)) throw new RouteBackupError('Cannot encode private route archive entry.');
        await write(headerBytes); await write(bytes);
        const padding = (512 - bytes.length % 512) % 512;
        if (padding) await write(zero.subarray(0, padding));
      }
      originals.push(entry);
    }
    await write(zero);
    await handle.sync();
    await handle.close();
    const manifest: RouteArchiveManifest = { version: 1, name, sha256: digest.digest('hex'), bytes: size, originals };
    validateRouteManifest(manifest, rows);
    writable();
    await link(temporary, final); // no clobber, even across processes
    published = true;
    const directory = await open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return manifest;
  } catch (error) {
    await handle.close().catch(() => {});
    if (published && isWritable()) await unlink(final).catch(() => {});
    if (error instanceof RouteBackupError) throw error;
    throw new RouteBackupError('Private route recovery archive could not be written.');
  } finally { if (isWritable()) await unlink(temporary).catch(() => {}); }
}

export interface StagedRouteRestore { rows: RouteDumpRow[]; discard(): Promise<void> }

/** Stage verified originals under fresh identities, never overwrite live files. */
export async function stageRouteRestore(files: GpxFiles, dumpPath: string, manifest: RouteArchiveManifest | undefined, originalRows: readonly RouteDumpRow[]): Promise<StagedRouteRestore> {
  const rows = originalRows.map((row) => ({ ...row, source_id: randomUUID(), version: randomUUID() }));
  const created: OriginalSource[] = [];
  const discard = async () => {
    for (const source of created) await files.removeOriginal(source).catch(() => {});
  };
  if (rows.length === 0) return { rows, discard };
  if (!manifest) throw new RouteBackupError('Private route archive is required.');
  validateRouteManifest(manifest, originalRows);
  const replacements = new Map(originalRows.map((row, i) => [row.source_id, rows[i]!]));
  try {
    await files.assertRoot();
    const required = manifest.originals.reduce((sum, entry) => sum + (entry.archivedBytes ?? 0) + 4096, UPLOAD_HEADROOM_BYTES);
    if ((await diskSpace(files.root)).free < required) throw new RouteBackupError('Not enough space to stage private route originals.');
    await verifyRouteArchive(dumpPath, manifest, originalRows, async (entry, bytes) => {
      const row = replacements.get(entry.sourceId)!;
      await files.writeArchivedOriginal({ translationKey: row.translation_key, sourceId: row.source_id }, bytes);
      created.push({ translationKey: row.translation_key, sourceId: row.source_id, sha256: row.source_sha256, bytes: row.source_bytes });
    });
    return { rows, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

/** The deliberately narrow archive we write: regular USTAR files only.
 * Header handles decoding/checksums; no extraction API ever sees a path.
 * Exact sizes reject compression, metadata headers, extra members and tails.
 * At most one <=5 MiB original is buffered. The CLI also uses this without a
 * staging callback to verify its undo set before any destructive SQL. */
export async function verifyRouteArchive(
  dumpPath: string, manifest: RouteArchiveManifest | undefined, rows: readonly RouteDumpRow[],
  onOriginal?: (entry: RouteArchiveEntry, bytes: Buffer) => Promise<void>,
): Promise<void> {
  if (rows.length === 0) {
    if (manifest !== undefined) throw new RouteBackupError();
    return;
  }
  if (!manifest) throw new RouteBackupError('Private route archive is required.');
  validateRouteManifest(manifest, rows);
  const expected = new Map(manifest.originals.filter((entry) => entry.state === 'present' || entry.state === 'corrupt')
    .map((entry) => [`${entry.pairHash}/${entry.sourceId}.gpx`, entry]));
  const handle = await open(join(dirname(dumpPath), manifest.name), constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let offset = 0;
  async function read(size: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(size);
    let used = 0;
    while (used < size) {
      const result = await handle.read(bytes, used, size - used, offset + used);
      if (result.bytesRead === 0) throw new RouteBackupError('Truncated private route archive.');
      used += result.bytesRead;
    }
    offset += size; hash.update(bytes); return bytes;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== manifest.bytes) throw new RouteBackupError();
    const seen = new Set<string>();
    while (offset < stat.size - 1024) {
      const header = new Header(await read(512));
      const entry = header.path ? expected.get(header.path) : undefined;
      if (!header.cksumValid || header.nullBlock || header.type !== 'File' || header.linkpath
        || !entry || seen.has(entry.sourceId) || header.size !== entry.archivedBytes) throw new RouteBackupError();
      const bytes = await read(entry.archivedBytes!);
      if (sourceDigest(bytes) !== entry.archivedSha256) throw new RouteBackupError('Private route archive entry digest mismatch.');
      const padding = (512 - bytes.length % 512) % 512;
      if (padding && (await read(padding)).some((byte) => byte !== 0)) throw new RouteBackupError();
      await onOriginal?.(entry, bytes);
      seen.add(entry.sourceId);
    }
    if (offset !== stat.size - 1024 || (await read(1024)).some((byte) => byte !== 0)
      || seen.size !== expected.size || hash.digest('hex') !== manifest.sha256) throw new RouteBackupError('Private route archive digest mismatch.');
  } catch (error) {
    if (error instanceof RouteBackupError) throw error;
    throw new RouteBackupError('Private route recovery archive could not be restored.');
  } finally { await handle.close(); }
}
