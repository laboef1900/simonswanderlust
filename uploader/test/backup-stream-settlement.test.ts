import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { extract } from 'tar';
import type * as FsModule from 'node:fs';
import type * as TarModule from 'tar';
import type * as DiskModule from '../src/disk.js';
import { archiveImages, createDbBackup, readState, type Connectable } from '../src/backup.js';
import { identityDumpRow } from './site-identity-fixture.js';

// Only I/O scheduling/faults are substituted: real Pack, WriteStream, files and extraction.
const hooks = vi.hoisted(() => ({
  destination: undefined as ((path: FsModule.PathLike, fs: typeof FsModule) => FsModule.WriteStream) | undefined,
  beforeTar: undefined as (() => Promise<void>) | undefined,
  packError: undefined as ((error: unknown) => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FsModule>();
  return { ...fs, createWriteStream: (path: FsModule.PathLike) => hooks.destination?.(path, fs) ?? fs.createWriteStream(path) };
});
vi.mock('tar', async (original) => {
  const tar = await original<typeof TarModule>();
  return { ...tar, Pack: class extends tar.Pack {
    constructor(options: ConstructorParameters<typeof tar.Pack>[0]) {
      super(options);
      this.on('error', (error) => hooks.packError?.(error));
    }
  } };
});
vi.mock('../src/disk.js', async (original) => ({
  ...await original<typeof DiskModule>(),
  diskSpace: async () => {
    await hooks.beforeTar?.();
    return { free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 };
  },
}));

const query = async (sql: string) => ({
  rows: sql.includes('to_regclass') ? [{ present: true, journeys: true, locales: true, members: true }]
    : sql.includes('FROM site_language') ? [{
      id: true, primary_locale: 'de', enabled_locales: ['de', 'en'],
      locked_at: null, updated_at: '2026-10-27T12:00:00.000Z',
    }]
      : sql.includes('FROM site_nav') ? [{ id: 1, config: { version: 1, header: [], footer: [], legal: [] }, updated_at: '2026-10-27T12:00:00.000Z' }]
      : sql.includes('FROM site_identity ORDER') ? [identityDumpRow()] : [],
});
const db: Connectable = { query, connect: async () => ({ query, release() {} }) };
let root: string;
let storage: string;
let backups: string;
const bytes = Buffer.from('synthetic archive settlement fixture');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-settlement-'));
  storage = join(root, 'images');
  backups = join(root, 'backups');
  await mkdir(storage);
  await mkdir(backups);
  await writeFile(join(storage, 'seed-orig.jpeg'), bytes);
});
afterEach(async () => {
  hooks.destination = undefined;
  hooks.beforeTar = undefined;
  hooks.packError = undefined;
  await rm(root, { recursive: true, force: true });
});
async function assertExtracts(name: string) {
  const restored = join(root, 'restored');
  await mkdir(restored, { recursive: true });
  await extract({ file: join(backups, name), cwd: restored, strict: true });
  expect(await readFile(join(restored, 'seed-orig.jpeg'))).toEqual(bytes);
}
async function assertNoTemps() {
  expect((await readdir(backups)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
}

describe('image archive writer settlement (#430)', () => {
  it('waits for delayed open AND close after a real pack error, preserving the original error and prior archive', async () => {
    const prior = await archiveImages(storage, backups, 0);
    const priorBytes = await readFile(join(backups, prior.name!));
    const opening = Promise.withResolvers<void>();
    const allowOpen = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    const packFailed = Promise.withResolvers<unknown>();
    hooks.packError = packFailed.resolve;
    hooks.beforeTar = () => rm(join(storage, 'seed-orig.jpeg'));
    hooks.destination = (path, fs) => fs.createWriteStream(path, { fs: {
      open(file, flags, mode, callback) {
        opening.resolve();
        void allowOpen.promise.then(() => fs.open(file, flags, mode, callback));
      },
      write: fs.write,
      close(fd, callback) {
        closing.resolve();
        void allowClose.promise.then(() => fs.close(fd, callback));
      },
    } });
    let settled = false;
    const outcome = archiveImages(storage, backups, 0).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await opening.promise;
      const error = await packFailed.promise;
      expect(error).toMatchObject({ code: 'ENOENT' });
      await setImmediate();
      expect(settled).toBe(false);
      allowOpen.resolve();
      await closing.promise;
      expect(settled).toBe(false);
      expect((await readdir(backups)).some((name) => name.endsWith('.tmp'))).toBe(true);
      allowClose.resolve();
      expect(await outcome).toBe(error);
      await assertNoTemps();
      expect(await readFile(join(backups, prior.name!))).toEqual(priorBytes);
      hooks.beforeTar = undefined;
      hooks.destination = undefined;
      await writeFile(join(storage, 'seed-orig.jpeg'), bytes);
      await assertExtracts((await archiveImages(storage, backups, 0)).name!);
    } finally {
      allowOpen.resolve();
      allowClose.resolve();
      await outcome;
    }
  });

  it.each(['open', 'write', 'close'] as const)('settles a destination %s failure before cleanup, then retries with a readable tar', async (phase) => {
    const failure = Object.assign(new Error(`synthetic ${phase} failure`), { code: phase === 'open' ? 'EACCES' : 'EIO' });
    let closed = false;
    hooks.destination = (path, fs) => {
      const destination = fs.createWriteStream(path, { fs: {
        open(file, flags, mode, callback) {
          if (phase === 'open') callback(failure, -1);
          else fs.open(file, flags, mode, callback);
        },
        write(fd, buffer, offset, length, position, callback) {
          if (phase === 'write') callback(failure, 0, buffer);
          else fs.write(fd, buffer, offset, length, position, callback);
        },
        close(fd, callback) {
          fs.close(fd, (error) => callback(error ?? (phase === 'close' ? failure : null)));
        },
      } });
      destination.once('close', () => { closed = true; });
      return destination;
    };
    await expect(archiveImages(storage, backups, 0)).rejects.toBe(failure);
    expect(closed).toBe(true);
    await assertNoTemps();
    hooks.destination = undefined;
    await assertExtracts((await archiveImages(storage, backups, 0)).name!);
  });

  it('keeps quiescence pending through an admitted write and close after lease cancellation, without activation or cutoff advancement', async () => {
    const controller = new AbortController();
    const service = createDbBackup({ db, dir: backups, storageDir: storage, retention: () => 5, signal: controller.signal });
    const initial = await service.runNow();
    expect(initial.lastError).toBeUndefined();
    const prior = service.listImageArchives()[0]!;
    const priorBytes = await readFile(join(backups, prior.name));
    await writeFile(join(storage, 'new-orig.jpeg'), bytes);
    const writing = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    hooks.destination = (path, fs) => fs.createWriteStream(path, { fs: {
      open: fs.open,
      write(fd, buffer, offset, length, position, callback) {
        writing.resolve();
        void allowWrite.promise.then(() => fs.write(fd, buffer, offset, length, position, callback));
      },
      close(fd, callback) {
        closing.resolve();
        void allowClose.promise.then(() => fs.close(fd, callback));
      },
    } });
    const run = service.runNow();
    let quiesced = false;
    let quiescence: Promise<void> | undefined;
    try {
      await writing.promise;
      controller.abort(new Error('synthetic lease loss'));
      quiescence = service.quiesce().then(() => { quiesced = true; });
      await setImmediate();
      expect(service.running()).toBe(true);
      expect(quiesced).toBe(false);
      allowWrite.resolve();
      await closing.promise;
      expect(quiesced).toBe(false);
      allowClose.resolve();
      const failed = await run;
      await quiescence;
      expect(failed.lastError).toContain('synthetic lease loss');
      expect(failed.lastImagesArchiveAt).toBe(initial.lastImagesArchiveAt);
      expect(readState(backups).lastImagesArchiveAt).toBe(initial.lastImagesArchiveAt);
      expect(readState(backups).imagesCutoffSource).toBe(initial.imagesCutoffSource);
      expect(service.listImageArchives().map(({ name }) => name)).toEqual([prior.name]);
      expect(await readFile(join(backups, prior.name))).toEqual(priorBytes);
      await assertNoTemps();
      expect(service.running()).toBe(false);
    } finally {
      allowWrite.resolve();
      allowClose.resolve();
      await run;
      await quiescence;
    }
  });
});
