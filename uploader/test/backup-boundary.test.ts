import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { extract, list } from 'tar';
import { archiveImages, createDbBackup, readState, writeState, type Connectable } from '../src/backup.js';
import { storeOriginal } from '../src/storage.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createMediaSync, createReconciler, isCompleteSet, walkStorageKeys } from '../src/media-sync.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createWorkLock } from '../src/work-lock.js';
import type * as DiskModule from '../src/disk.js';
import { identityDumpRow } from './site-identity-fixture.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';
import type * as FsModule from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';

// Pause at existing I/O seams; tar, rename, stored bytes and re-encoding remain real.
const hooks = vi.hoisted(() => ({
  beforeTar: undefined as (() => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string) => Promise<void>) | undefined,
  markerStatFails: false,
  markerCleanupFails: false,
}));
vi.mock('../src/disk.js', async (original) => ({
  ...await original<typeof DiskModule>(),
  diskSpace: async () => {
    await hooks.beforeTar?.();
    return { free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 };
  },
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromisesModule>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (from.includes('.part-')) await hooks.beforeRename?.(from);
      return fs.rename(from, to);
    },
  };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FsModule>();
  return {
    ...fs,
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      if (hooks.markerStatFails) throw new Error('marker stat failed');
      return fs.fstatSync(...args);
    },
    unlinkSync: (path: string) => {
      if (hooks.markerCleanupFails && path.includes('.archive-boundary-')) throw new Error('marker cleanup failed');
      return fs.unlinkSync(path);
    },
  };
});

const db: Connectable = {
  query: async () => ({ rows: [] }),
  connect: async () => ({
    query: async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ present: true }]
      : sql.includes('FROM site_language') ? [{
        id: true, primary_locale: 'de', enabled_locales: ['de', 'en'],
        locked_at: null, updated_at: '2026-10-27T12:00:00.000Z',
      }]
      : sql.includes('FROM site_nav') ? [{
        id: 1, config: DEFAULT_NAVIGATION, updated_at: '2026-10-27T12:00:00.000Z',
      }]
      : sql.includes('FROM site_identity ORDER') ? [identityDumpRow()] : [] }),
    release() {},
  }),
};
let root: string;
let storage: string;
let backups: string;
const final = 'trips/boundary/photo-orig.jpeg';
const temp = `${final}.part-1234abcd`;
const key = 'trips/boundary/photo';
const baseUrl = 'https://images.example.test';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'backup-boundary-'));
  storage = join(root, 'images');
  backups = join(root, 'backups');
  await mkdir(join(storage, 'trips/boundary'), { recursive: true });
  await mkdir(backups);
});
afterEach(async () => {
  hooks.beforeTar = undefined;
  hooks.beforeRename = undefined;
  hooks.markerStatFails = false;
  hooks.markerCleanupFails = false;
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function entries(name: string | null): Promise<string[]> {
  expect(name).not.toBeNull();
  const names: string[] = [];
  await list({ file: join(backups, name!), onReadEntry: (entry) => { names.push(entry.path); } });
  return names.sort();
}
async function pendingOriginal(): Promise<Buffer> {
  const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  await writeFile(join(storage, temp), bytes);
  await utimes(join(storage, temp), 1, 1);
  await writeFile(join(storage, 'seed-orig.jpeg'), bytes);
  return bytes;
}
function backup() {
  return createDbBackup({ db, dir: backups, storageDir: storage, retention: () => 5 });
}

async function proveRecovery(names: string[], original: Buffer) {
  const restored = join(root, 'restored');
  await mkdir(restored);
  for (const name of names.sort()) await extract({ file: join(backups, name), cwd: restored, strict: true });
  expect(await readFile(join(restored, final))).toEqual(original);
  expect((await walkStorageKeys(restored)).get(key)?.original).toBe(final);
  expect((await readdir(restored, { recursive: true })).some((name) => name.includes('.part-'))).toBe(false);
  const store = memoryMediaStore({ baseUrl });
  const queue = createEncodeQueue({ store, storageDir: restored, lock: createWorkLock(), log: () => {} });
  try {
    const sync = createMediaSync({ store, storageDir: restored, baseUrl, corpus: async () => ({ posts: [], pages: [] }), log: () => {} });
    const report = await createReconciler({ sync, queue }).run();
    expect(report.recovered).toBeGreaterThanOrEqual(1);
    await queue.idle();
    expect(await store.get(key)).toMatchObject({ status: 'ready', width: 16, height: 12 });
    const found = (await walkStorageKeys(restored)).get(key)!;
    expect(isCompleteSet(found.variants, 16)).toBe(true);
    for (const variant of found.variants) {
      const decoded = await sharp(join(restored, `${key}-${variant}`)).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info).toMatchObject({ width: 16, height: 12 });
    }
  } finally {
    await queue.quiesce();
  }
}

describe('image archive publication boundary (#335)', () => {
  it('captures a temp published after a successful archive under its final name and really restores/re-encodes it', async () => {
    const bytes = await pendingOriginal();
    const first = await archiveImages(storage, backups, 0);
    expect(await entries(first.name)).toEqual(['seed-orig.jpeg']);
    expect(await readFile(join(storage, temp))).toEqual(bytes); // present throughout successful tar
    await rename(join(storage, temp), join(storage, final));
    const published = await stat(join(storage, final));
    expect(published.mtimeMs).toBe(1000);
    expect(published.ctimeMs).toBeGreaterThanOrEqual(Date.parse(first.boundary!));
    const second = await archiveImages(storage, backups, Date.parse(first.boundary!));
    expect(await entries(second.name)).toContain(final);
    await proveRecovery([first.name!, second.name!], bytes);
  });

  it('does not archive an actual storeOriginal writer paused immediately before publication', async () => {
    const entered = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    hooks.beforeRename = async (from) => { entered.resolve(from); await finish.promise; };
    const bytes = await pendingOriginal();
    await rm(join(storage, temp));
    const writer = storeOriginal(key, bytes, 'jpeg', { storageDir: storage });
    const temporary = await entered.promise;
    await utimes(temporary, 1, 1);
    let first;
    try {
      first = await archiveImages(storage, backups, 0);
      expect(await entries(first.name)).toEqual(['seed-orig.jpeg']);
    } finally {
      finish.resolve();
      await writer;
    }
    const second = await archiveImages(storage, backups, Date.parse(first.boundary!));
    expect(await entries(second.name)).toContain(final);
  });

  it('captures publication after selection and before tar opens in the later increment', async () => {
    await pendingOriginal();
    hooks.beforeTar = async () => { hooks.beforeTar = undefined; await rename(join(storage, temp), join(storage, final)); };
    const first = await archiveImages(storage, backups, 0);
    expect(await entries(first.name)).toEqual(['seed-orig.jpeg']);
    const second = await archiveImages(storage, backups, Date.parse(first.boundary!));
    expect(await entries(second.name)).toContain(final);
  });

  it('uses the filesystem clock even when userspace is ahead and includes an equal ctime', async () => {
    await pendingOriginal();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    const first = await archiveImages(storage, backups, 0);
    expect(Date.parse(first.boundary!)).toBeLessThan(Date.now());
    await rename(join(storage, temp), join(storage, final));
    const published = await stat(join(storage, final));
    expect(published.ctimeMs).toBeGreaterThanOrEqual(Date.parse(first.boundary!));
    const second = await archiveImages(storage, backups, published.ctimeMs);
    expect(await entries(second.name)).toContain(final); // equality, not just newer
  });

  it('rejects a real selected file disappearing before tar opens and removes its unfinished output', async () => {
    await pendingOriginal();
    hooks.beforeTar = async () => { await rm(join(storage, 'seed-orig.jpeg')); };
    await expect(archiveImages(storage, backups, 0)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(backups)).toEqual([]);
  });

  it('keeps cutoff/provenance on tar failure and captures the returned final on retry', async () => {
    const bytes = await pendingOriginal();
    const service = backup();
    const initial = await service.runNow();
    expect(initial.imagesCutoffSource).toBe('filesystem-v1');
    await rename(join(storage, temp), join(storage, final));
    hooks.beforeTar = async () => { hooks.beforeTar = undefined; await rm(join(storage, final)); };
    const failed = await service.runNow();
    expect(failed.lastError).toContain('images archive failed');
    expect(failed.lastImagesArchiveAt).toBe(initial.lastImagesArchiveAt);
    expect(failed.imagesCutoffSource).toBe(initial.imagesCutoffSource);
    expect(service.listImageArchives()).toHaveLength(1);
    expect((await readdir(backups)).some((name) => name.endsWith('.tmp'))).toBe(false);
    await storeOriginal(key, bytes, 'jpeg', { storageDir: storage });
    const retried = await service.runNow();
    expect(retried.lastError).toBeUndefined();
    expect(await entries(service.listImageArchives()[0]!.name)).toContain(final);
  });

  it.each(['missing', 'corrupt', 'legacy', 'invalid'] as const)('full-captures with %s provenance despite future collision-bumped names', async (stateKind) => {
    await pendingOriginal();
    const future = new Date('2099-01-01T00:00:00Z');
    const first = await archiveImages(storage, backups, 0, future);
    const second = await archiveImages(storage, backups, 0, future);
    expect(first.name).toBe('images-20990101-000000.tar');
    expect(second.name).toBe('images-20990101-000001.tar');
    await rename(join(storage, temp), join(storage, final));
    if (stateKind === 'corrupt') await writeFile(join(backups, 'state.json'), '{broken');
    if (stateKind === 'legacy') writeState(backups, { lastImagesArchiveAt: future.toISOString() });
    if (stateKind === 'invalid') await writeFile(join(backups, 'state.json'), JSON.stringify({ lastImagesArchiveAt: future.toISOString(), imagesCutoffSource: 'guessed' }));
    const service = backup();
    const result = await service.runNow();
    expect(result.lastError).toBeUndefined();
    expect(result.imagesCutoffSource).toBe('filesystem-v1');
    const added = service.listImageArchives().find(({ name }) => name !== first.name && name !== second.name)!;
    expect(await entries(added.name)).toEqual(['seed-orig.jpeg', final]);
    expect(await entries(first.name)).toEqual(['seed-orig.jpeg']); // never clobber history
    expect(readState(backups).lastImagesArchiveAt).toBe(result.lastImagesArchiveAt);
  });

  it('keeps trusted cutoff unchanged when the source disappears', async () => {
    await pendingOriginal();
    const service = backup();
    const before = await service.runNow();
    await rename(storage, `${storage}-offline`);
    const after = await service.runNow();
    expect(after.lastImagesArchiveAt).toBe(before.lastImagesArchiveAt);
    expect(after.imagesCutoffSource).toBe(before.imagesCutoffSource);
  });

  it('fails marker stat with cleanup and ignores a leftover marker after cleanup failure', async () => {
    await pendingOriginal();
    hooks.markerStatFails = true;
    await expect(archiveImages(storage, backups, 0)).rejects.toThrow('marker stat failed');
    expect((await readdir(storage)).some((name) => name.startsWith('.archive-boundary-'))).toBe(false);
    hooks.markerStatFails = false;
    hooks.markerCleanupFails = true;
    await expect(archiveImages(storage, backups, 0)).rejects.toThrow('marker cleanup failed');
    const markers = (await readdir(storage)).filter((name) => name.startsWith('.archive-boundary-'));
    expect(markers).toHaveLength(1);
    hooks.markerCleanupFails = false;
    const result = await archiveImages(storage, backups, 0);
    expect(await entries(result.name)).toEqual(['seed-orig.jpeg']);
    expect((await walkStorageKeys(storage)).has(markers[0]!)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('fails without advancing a trusted cutoff on a read-only images source', async () => {
    await pendingOriginal();
    const service = backup();
    const initial = await service.runNow();
    await chmod(storage, 0o555);
    try {
      const failed = await service.runNow();
      expect(failed.lastError).toMatch(/images archive failed:.*EACCES/);
      expect(failed.lastImagesArchiveAt).toBe(initial.lastImagesArchiveAt);
      expect(failed.imagesCutoffSource).toBe(initial.imagesCutoffSource);
    } finally {
      await chmod(storage, 0o755);
    }
  });

  it('does not publish a tar or advance state after cancellation during capture', async () => {
    await pendingOriginal();
    const controller = new AbortController();
    const service = createDbBackup({ db, dir: backups, storageDir: storage, retention: () => 5, signal: controller.signal });
    const initial = await service.runNow();
    await rename(join(storage, temp), join(storage, final));
    hooks.beforeTar = async () => { controller.abort(); };
    const failed = await service.runNow();
    expect(failed.lastError).toContain('images archive failed');
    expect(failed.lastImagesArchiveAt).toBe(initial.lastImagesArchiveAt);
    expect(service.listImageArchives()).toHaveLength(1);
    expect((await readdir(backups)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
