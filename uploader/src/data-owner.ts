import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { acquireStorageOwner, StorageReadOnlyError, type StorageOwner } from './storage-owner.js';

interface NativeLock { tryLock(fd: number): boolean }
// The descriptor is strongly owned here, never by a GC finalizer or helper process.
// DB loss deliberately does NOT close it: already-issued filesystem I/O can outlive PG.
export async function acquireDataOwner(
  databaseUrl: string,
  options: { role: 'app' | 'restore'; storageDir: string },
): Promise<StorageOwner> {
  let fd: number | undefined;
  let owner: StorageOwner | undefined;
  let closed = false;
  const controller = new AbortController();
  try {
    const dataDir = resolve(dirname(options.storageDir));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (lstatSync(dataDir).isSymbolicLink()) throw new StorageReadOnlyError();
    const path = join(realpathSync(dataDir), '.storage-owner.lock');
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const inode = fstatSync(fd);
    if (!inode.isFile() || inode.nlink !== 1 || inode.uid !== process.getuid?.() || (inode.mode & 0o077) !== 0) throw new StorageReadOnlyError();
    const native: NativeLock = createRequire(import.meta.url)('../native/owned-flock.node');
    if (native.tryLock(fd) !== true) throw new StorageReadOnlyError();
    // Acquisition order is universal: filesystem first, PG second, then admission.
    owner = await acquireStorageOwner(databaseUrl, { role: options.role });
    const pgOwner = owner;
    const latch = () => { if (!controller.signal.aborted) controller.abort(new StorageReadOnlyError()); };
    pgOwner.signal.addEventListener('abort', latch, { once: true });
    if (pgOwner.signal.aborted) latch();
    function isWritable(): boolean {
      if (closed || controller.signal.aborted || !pgOwner.isWritable()) return false;
      try {
        const current = lstatSync(path);
        if (current.dev !== inode.dev || current.ino !== inode.ino || current.nlink !== 1 || !current.isFile()) latch();
      } catch { latch(); }
      return !controller.signal.aborted;
    }
    function assertWritable(): void { if (!isWritable()) throw new StorageReadOnlyError(); }
    assertWritable();
    return {
      applicationName: pgOwner.applicationName,
      signal: controller.signal,
      isWritable,
      assertWritable,
      async assertNoAppSessions() {
        assertWritable();
        await pgOwner.assertNoAppSessions();
        assertWritable();
      },
      async close() {
        if (closed) return;
        // Callers MUST quiesce all admitted work before this explicit release.
        // If PG close is uncertain, retain the native descriptor until process exit.
        await pgOwner.close();
        closed = true;
        if (fd !== undefined) { closeSync(fd); fd = undefined; }
      },
    };
  } catch {
    if (owner) await owner.close().catch(() => {});
    if (fd !== undefined) closeSync(fd);
    throw new StorageReadOnlyError();
  }
}
