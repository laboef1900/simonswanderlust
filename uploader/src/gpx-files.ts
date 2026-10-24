import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { GpxError } from './gpx-errors.js';

export interface OriginalSource { translationKey: string; sourceId: string; sha256: string; bytes: number }
export interface StoredOriginal { pairHash: string; sourceId: string; mtimeMs: number }
export type OriginalInspection = { state: 'present' | 'missing' | 'corrupt' | 'unreadable' | 'oversized'; bytes?: Buffer; actualSha256?: string };
export const SOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
export const safePairHash = (tk: string): string => createHash('sha256').update(tk).digest('hex');
export const sourceDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const errno = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;
const PENDING_TEMP_RE = /^[0-9a-f]{64}\.gpx\.part-[0-9a-f]{32}$/;
const ORIGINAL_TEMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.gpx\.part-[0-9a-f]{32}$/;

export interface RouteFileGate {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  tryRunExclusive<T>(fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }>;
}
export interface GpxFiles {
  readonly root: string;
  readonly gate: RouteFileGate;
  assertRoot(): Promise<void>;
  inspectOriginal(source: OriginalSource): Promise<OriginalInspection>;
  writeOriginal(source: OriginalSource, bytes: Uint8Array): Promise<void>;
  /** Restore has already verified the manifest's actual digest; corruption stays corruption. */
  writeArchivedOriginal(identity: Pick<OriginalSource, 'translationKey' | 'sourceId'>, bytes: Uint8Array): Promise<void>;
  removeOriginal(source: OriginalSource): Promise<void>;
  removeStoredOriginal(source: Pick<StoredOriginal, 'pairHash' | 'sourceId'>): Promise<void>;
  writePending(id: string, bytes: Uint8Array): Promise<void>;
  readPending(id: string): Promise<Buffer>;
  removePending(id: string): Promise<void>;
  cleanupTemporaryFiles(kind: 'pending' | 'originals'): Promise<void>;
  listPending(): Promise<Array<{ id: string; bytes: number; mtimeMs: number; temporary?: boolean }>>;
  listOriginals(pairHash?: string): Promise<StoredOriginal[]>;
}

export function createRouteFileGate(): RouteFileGate {
  let held = false;
  const waiters: Array<() => void> = [];
  const release = () => { const next = waiters.shift(); if (next) next(); else held = false; };
  return {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      if (held) {
        const waiter = Promise.withResolvers<void>();
        waiters.push(waiter.resolve);
        await waiter.promise;
      } else held = true;
      try { return await fn(); } finally { release(); }
    },
    async tryRunExclusive<T>(fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
      if (held) return { acquired: false };
      held = true;
      try { return { acquired: true, value: await fn() }; } finally { release(); }
    },
  };
}

export function createGpxFiles({ storageDir, isWritable = () => true }: { storageDir: string; isWritable?: () => boolean }): GpxFiles {
  const root = resolve(dirname(storageDir), 'routes');
  const gate = createRouteFileGate();
  const writable = () => { if (!isWritable()) throw new GpxError('storage_read_only', 503); };
  async function directory(path: string, create: boolean): Promise<void> {
    const absolute = resolve(path);
    if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error('gpx_unsafe_path');
    // Check every ancestor, not only the final directory: O_NOFOLLOW protects the file only.
    const pieces = absolute.split(sep).filter(Boolean);
    let current: string = sep;
    for (const piece of pieces) {
      current = join(current, piece);
      let stat;
      try { stat = await lstat(current); } catch (error) {
        if (!create || !errno(error, 'ENOENT') || !(current === root || current.startsWith(root + sep))) throw error;
        writable();
        await mkdir(current, { mode: 0o700 }).catch((e: unknown) => { if (!errno(e, 'EEXIST')) throw e; });
        stat = await lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('gpx_unsafe_path');
      if (create && (current === root || current.startsWith(root + sep))) { writable(); await chmod(current, 0o700); }
    }
  }
  function originalPath(source: Pick<StoredOriginal, 'pairHash' | 'sourceId'>): string {
    if (!HASH_RE.test(source.pairHash) || !SOURCE_ID_RE.test(source.sourceId)) throw new Error('gpx_unsafe_path');
    return join(root, 'originals', source.pairHash, source.sourceId + '.gpx');
  }
  function pendingPath(id: string): string {
    if (!HASH_RE.test(id)) throw new Error('gpx_unsafe_path');
    return join(root, 'pending', id + '.gpx');
  }
  const sourcePath = (source: OriginalSource) => originalPath({ pairHash: safePairHash(source.translationKey), sourceId: source.sourceId });
  async function readBounded(path: string): Promise<Buffer> {
    await directory(dirname(path), false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('gpx_unsafe_file');
      if (stat.size > GPX_LIMITS.fileBytes) throw new Error('gpx_oversized');
      // Read at most cap+1 even if a concurrent external writer grows the file after stat.
      const bytes = Buffer.alloc(Math.min(stat.size + 1, GPX_LIMITS.fileBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > stat.size) throw new Error('gpx_oversized');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  async function atomicWrite(path: string, bytes: Uint8Array, allowEmpty = false): Promise<void> {
    writable();
    if ((!allowEmpty && !bytes.byteLength) || bytes.byteLength > GPX_LIMITS.fileBytes) throw new Error('gpx_file_size');
    await directory(dirname(path), true);
    // Generated identities are never reused; refuse an existing target, including symlinks.
    try { await lstat(path); throw new Error('gpx_file_exists'); } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
    const temp = path + '.part-' + randomBytes(16).toString('hex');
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      writable(); await rename(temp, path);
      const dir = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      await handle.close().catch(() => {});
      if (isWritable()) await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async function remove(path: string): Promise<void> {
    writable();
    try {
      await directory(dirname(path), false);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('gpx_unsafe_file');
      writable(); await unlink(path);
    } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
  }
  async function entries(path: string): Promise<string[]> {
    try { await directory(path, false); return await readdir(path); }
    catch (error) { if (errno(error, 'ENOENT')) return []; throw error; }
  }
  async function inventoryFile(path: string) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('gpx_unsafe_file');
    return stat;
  }
  function reportUnknownEntries(count: number): void {
    if (count) console.error('gpx_unknown_entries', { count: Math.min(count, 1000), capped: count >= 1000 });
  }
  return {
    root, gate,
    async inspectOriginal(source: OriginalSource): Promise<OriginalInspection> {
      const path = sourcePath(source);
      try {
        const bytes = await readBounded(path); const actualSha256 = sourceDigest(bytes);
        return { state: bytes.length === source.bytes && actualSha256 === source.sha256 ? 'present' : 'corrupt', bytes, actualSha256 };
      } catch (error) {
        if (errno(error, 'ENOENT')) return { state: 'missing' };
        if (error instanceof Error && error.message === 'gpx_oversized') return { state: 'oversized' };
        return { state: 'unreadable' };
      }
    },
    async assertRoot(): Promise<void> { await directory(root, true); },
    async writeOriginal(source: OriginalSource, bytes: Uint8Array): Promise<void> {
      if (source.bytes !== bytes.byteLength || source.sha256 !== sourceDigest(bytes)) throw new Error('gpx_source_mismatch');
      await atomicWrite(sourcePath(source), bytes);
    },
    async writeArchivedOriginal(identity, bytes): Promise<void> {
      await atomicWrite(originalPath({ pairHash: safePairHash(identity.translationKey), sourceId: identity.sourceId }), bytes, true);
    },
    removeOriginal: async (source: OriginalSource) => remove(sourcePath(source)),
    removeStoredOriginal: async (source: Pick<StoredOriginal, 'pairHash' | 'sourceId'>) => remove(originalPath(source)),
    writePending: async (id: string, bytes: Uint8Array) => atomicWrite(pendingPath(id), bytes),
    readPending: async (id: string) => readBounded(pendingPath(id)),
    removePending: async (id: string) => remove(pendingPath(id)),
    async cleanupTemporaryFiles(kind: 'pending' | 'originals'): Promise<void> {
      let unknown = 0;
      try {
        const directories = kind === 'pending' ? [join(root, 'pending')] : [];
        if (kind === 'originals') {
          for (const hash of await entries(join(root, 'originals'))) {
            if (!HASH_RE.test(hash)) { unknown++; continue; }
            directories.push(join(root, 'originals', hash));
          }
        }
        const pattern = kind === 'pending' ? PENDING_TEMP_RE : ORIGINAL_TEMP_RE;
        for (const path of directories) {
          for (const name of await entries(path)) {
            if (!pattern.test(name)) {
              const recognized = kind === 'pending' ? /^[0-9a-f]{64}\.gpx$/.test(name)
                : name.endsWith('.gpx') && SOURCE_ID_RE.test(name.slice(0, -4));
              if (!recognized) unknown++;
              continue;
            }
            const file = join(path, name);
            const stat = await inventoryFile(file);
            if (stat && Date.now() - stat.mtimeMs >= 60 * 60 * 1000) await remove(file);
          }
        }
      } finally { reportUnknownEntries(unknown); }
    },
    async listPending(): Promise<Array<{ id: string; bytes: number; mtimeMs: number; temporary?: boolean }>> {
      const result = [];
      let unknown = 0;
      try {
        for (const name of await entries(join(root, 'pending'))) {
          const temporary = PENDING_TEMP_RE.test(name);
          if (!temporary && !/^[0-9a-f]{64}\.gpx$/.test(name)) { unknown++; continue; }
          // Admission intentionally does not hold the gate: Attach/cancel/expiry
          // may remove a listed file before its stat without invalidating admission.
          const stat = await inventoryFile(join(root, 'pending', name));
          if (!stat) continue;
          result.push({ id: name.slice(0, 64), bytes: stat.size, mtimeMs: stat.mtimeMs, ...(temporary ? { temporary: true } : {}) });
        }
        return result;
      } finally { reportUnknownEntries(unknown); }
    },
    async listOriginals(onlyPairHash?: string): Promise<StoredOriginal[]> {
      const result: StoredOriginal[] = [];
      if (onlyPairHash !== undefined && !HASH_RE.test(onlyPairHash)) throw new Error('gpx_unsafe_path');
      let unknown = 0;
      try {
        const pairs = onlyPairHash === undefined ? await entries(join(root, 'originals')) : [onlyPairHash];
        for (const pairHash of pairs) {
          if (!HASH_RE.test(pairHash)) { unknown++; continue; }
          for (const name of await entries(join(root, 'originals', pairHash))) {
            if (ORIGINAL_TEMP_RE.test(name)) continue;
            const sourceId = name.slice(0, -4);
            if (!name.endsWith('.gpx') || !SOURCE_ID_RE.test(sourceId)) { unknown++; continue; }
            const stat = await inventoryFile(originalPath({ pairHash, sourceId }));
            if (!stat) continue;
            result.push({ pairHash, sourceId, mtimeMs: stat.mtimeMs });
          }
        }
        return result;
      } finally { reportUnknownEntries(unknown); }
    },
  };
}
