import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGpxFiles, createRouteFileGate, safePairHash, sourceDigest, type OriginalSource } from '../src/gpx-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(lstat).mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-files-'));
  roots.push(root);
  const bytes = Buffer.from('<synthetic-private-source/>');
  const source: OriginalSource = { translationKey: 'synthetic/../pair', sourceId: randomUUID(), sha256: sourceDigest(bytes), bytes: bytes.length };
  const files = createGpxFiles({ storageDir: join(root, 'images') });
  return { root, bytes, source, files, path: join(files.root, 'originals', safePairHash(source.translationKey), source.sourceId + '.gpx') };
}

describe('private GPX originals', () => {
  it('uses private hashed paths, exact original bytes, restrictive modes and non-overwriting publication', async () => {
    const { root, bytes, source, files, path } = await fixture();
    await files.writeOriginal(source, bytes);
    expect(files.root).toBe(join(root, 'routes'));
    expect((await stat(files.root)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await files.inspectOriginal(source)).toEqual({ state: 'present', bytes, actualSha256: source.sha256 });
    await expect(files.writeOriginal(source, bytes)).rejects.toThrow('gpx_file_exists');
    expect(await files.listOriginals()).toEqual([{ pairHash: safePairHash(source.translationKey), sourceId: source.sourceId, mtimeMs: expect.any(Number) }]);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('distinguishes bounded corruption, missing and oversized originals without trusting bytes', async () => {
    const { bytes, source, files, path } = await fixture();
    expect((await files.inspectOriginal(source)).state).toBe('missing');
    await files.writeOriginal(source, bytes);
    const corrupt = Buffer.from('changed');
    await writeFile(path, corrupt);
    expect(await files.inspectOriginal(source)).toEqual({ state: 'corrupt', bytes: corrupt, actualSha256: sourceDigest(corrupt) });
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await files.inspectOriginal(source)).toEqual({ state: 'oversized' });
    await files.removeOriginal(source);
    expect((await files.inspectOriginal(source)).state).toBe('missing');
  });

  it('restores archived empty corruption without treating it as a valid original', async () => {
    const { source, files } = await fixture();
    const empty = Buffer.alloc(0);
    await files.writeArchivedOriginal(source, empty);
    expect(await files.inspectOriginal(source)).toEqual({ state: 'corrupt', bytes: empty, actualSha256: sourceDigest(empty) });
    await expect(files.writeArchivedOriginal(source, empty)).rejects.toThrow('gpx_file_exists');
  });

  it('refuses symlink files and directories rather than reading or erasing their targets', async () => {
    const { root, bytes, source, files, path } = await fixture();
    await files.writeOriginal(source, bytes);
    const target = join(root, 'outside.gpx'); await writeFile(target, 'outside');
    await rm(path); await symlink(target, path);
    expect((await files.inspectOriginal(source)).state).toBe('unreadable');
    await expect(files.removeOriginal(source)).rejects.toThrow('gpx_unsafe_file');
    expect(await readFile(target, 'utf8')).toBe('outside');
    await rm(join(files.root, 'originals'), { recursive: true });
    await symlink(root, join(files.root, 'originals'));
    await expect(files.writeOriginal(source, bytes)).rejects.toThrow('gpx_unsafe_path');
  });

  it('guards pending IDs and refuses all mutation after ownership loss', async () => {
    const { root, bytes } = await fixture();
    let writable = true;
    const files = createGpxFiles({ storageDir: join(root, 'images'), isWritable: () => writable });
    const id = randomBytes(32).toString('hex');
    await files.writePending(id, bytes);
    await expect(files.readPending('../outside')).rejects.toThrow('gpx_unsafe_path');
    writable = false;
    await expect(files.removePending(id)).rejects.toThrow('storage_read_only');
    expect(await files.readPending(id)).toEqual(bytes);
  });

  it('counts crash-left staging bytes until guarded grace-period cleanup succeeds', async () => {
    const { files, bytes } = await fixture();
    const id = randomBytes(32).toString('hex');
    await files.writePending(id, bytes);
    const temp = join(files.root, 'pending', randomBytes(32).toString('hex') + '.gpx.part-' + randomBytes(16).toString('hex'));
    await writeFile(temp, bytes, { mode: 0o600 });
    expect(await files.listPending()).toHaveLength(2);
    await files.cleanupTemporaryFiles('pending');
    expect(await files.listPending()).toHaveLength(2);
    const past = new Date(Date.now() - 3_600_001);
    await utimes(temp, past, past);
    await files.cleanupTemporaryFiles('pending');
    expect(await files.listPending()).toHaveLength(1);
    expect(await files.readPending(id)).toEqual(bytes);
  });

  it.each(['pending', 'originals'] as const)('ignores and reports unexpected %s entries without exposing or deleting them', async (kind) => {
    const { files, bytes, source, path } = await fixture();
    const id = randomBytes(32).toString('hex');
    if (kind === 'pending') await files.writePending(id, bytes);
    else await files.writeOriginal(source, bytes);
    const directory = kind === 'pending' ? join(files.root, kind) : join(files.root, kind, safePairHash(source.translationKey));
    const stray = join(directory, '.DS_Store');
    const privateName = join(directory, 'private-location-1.2345\n6.7890');
    await writeFile(stray, 'private metadata');
    await mkdir(privateName);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = () => kind === 'pending' ? files.listPending() : files.listOriginals();
    expect(await list()).toHaveLength(1);
    expect(report.mock.calls).toEqual([['gpx_unknown_entries', { count: 2, capped: false }]]);
    report.mockClear();
    const temporary = kind === 'pending'
      ? join(directory, id + '.gpx.part-' + randomBytes(16).toString('hex'))
      : path + '.part-' + randomBytes(16).toString('hex');
    await writeFile(temporary, bytes);
    const past = new Date(Date.now() - 3_600_001);
    await utimes(temporary, past, past);
    await files.cleanupTemporaryFiles(kind);
    expect(report.mock.calls).toEqual([['gpx_unknown_entries', { count: 2, capped: false }]]);
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(stray, 'utf8')).toBe('private metadata');
    expect((await stat(privateName)).isDirectory()).toBe(true);
    expect(await list()).toHaveLength(1);
  });

  it('skips unexpected pair-directory names without following or deleting them', async () => {
    const { files, bytes, source, root } = await fixture();
    await files.writeOriginal(source, bytes);
    const stray = join(files.root, 'originals', '.DS_Store');
    await symlink(root, stray);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await files.listOriginals()).toHaveLength(1);
    await files.cleanupTemporaryFiles('originals');
    expect(report.mock.calls).toEqual(Array(2).fill(['gpx_unknown_entries', { count: 1, capped: false }]));
    expect((await lstat(stray)).isSymbolicLink()).toBe(true);
  });

  it('caps unexpected-entry reporting at one sanitized aggregate per inventory', async () => {
    const { files, bytes } = await fixture();
    await files.writePending(randomBytes(32).toString('hex'), bytes);
    for (let index = 0; index < 1001; index++) {
      await writeFile(join(files.root, 'pending', `unexpected-${index}`), '');
    }
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await files.listPending()).toHaveLength(1);
    expect(report.mock.calls).toEqual([['gpx_unknown_entries', { count: 1000, capped: true }]]);
    expect(await readFile(join(files.root, 'pending', 'unexpected-1000'), 'utf8')).toBe('');
  });

  it('refuses recognized pair-directory symlinks instead of following them', async () => {
    const { files, bytes, source, root } = await fixture();
    await files.writeOriginal(source, bytes);
    const pair = join(files.root, 'originals', safePairHash(source.translationKey));
    await rm(pair, { recursive: true });
    await symlink(root, pair);
    await expect(files.listOriginals()).rejects.toThrow('gpx_unsafe_path');
    await expect(files.cleanupTemporaryFiles('originals')).rejects.toThrow('gpx_unsafe_path');
    expect((await lstat(pair)).isSymbolicLink()).toBe(true);
  });

  it.each(['pending', 'originals', 'pending-temp', 'originals-temp'] as const)(
    'tolerates a listed %s file disappearing before stat', async (kind) => {
      const { files, bytes, source, path } = await fixture();
      const id = randomBytes(32).toString('hex');
      const pending = kind.startsWith('pending');
      if (pending) await files.writePending(id, bytes);
      else await files.writeOriginal(source, bytes);
      let target = pending ? join(files.root, 'pending', id + '.gpx') : path;
      const temporary = kind.endsWith('-temp');
      if (temporary) {
        target += '.part-' + randomBytes(16).toString('hex');
        await writeFile(target, bytes);
      }
      const actual = await vi.importActual<typeof FileSystem>('node:fs/promises');
      let removed = false;
      vi.mocked(lstat).mockImplementation(async (...args) => {
        if (args[0] === target && !removed) { removed = true; await rm(target); }
        return actual.lstat(...args);
      });
      if (temporary) await files.cleanupTemporaryFiles(pending ? 'pending' : 'originals');
      else expect(await (pending ? files.listPending() : files.listOriginals())).toEqual([]);
      expect(removed).toBe(true);
    },
  );

  it.each(['pending', 'originals'] as const)('tolerates a listed %s directory disappearing before traversal', async (kind) => {
    const { files, bytes, source } = await fixture();
    const id = randomBytes(32).toString('hex');
    if (kind === 'pending') await files.writePending(id, bytes);
    else await files.writeOriginal(source, bytes);
    const target = kind === 'pending' ? join(files.root, kind) : join(files.root, kind, safePairHash(source.translationKey));
    const actual = await vi.importActual<typeof FileSystem>('node:fs/promises');
    let removed = false;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === target && !removed) { removed = true; await rm(target, { recursive: true }); }
      return actual.lstat(...args);
    });
    expect(await (kind === 'pending' ? files.listPending() : files.listOriginals())).toEqual([]);
    expect(removed).toBe(true);
  });

  it.each(['pending', 'originals'] as const)('still refuses unsafe recognized %s entries and access failures', async (kind) => {
    const { files, bytes, source, path, root } = await fixture();
    const id = randomBytes(32).toString('hex');
    if (kind === 'pending') await files.writePending(id, bytes);
    else await files.writeOriginal(source, bytes);
    const target = kind === 'pending' ? join(files.root, kind, id + '.gpx') : path;
    const list = () => kind === 'pending' ? files.listPending() : files.listOriginals();
    const outside = join(root, 'outside');
    await writeFile(outside, bytes);
    await rm(target);
    await symlink(outside, target);
    await expect(list()).rejects.toThrow('gpx_unsafe_file');
    await rm(target);
    await link(outside, target);
    await expect(list()).rejects.toThrow('gpx_unsafe_file');
    await rm(target);
    await mkdir(target);
    await expect(list()).rejects.toThrow('gpx_unsafe_file');
    await rm(target, { recursive: true });
    await writeFile(target, bytes);
    const actual = await vi.importActual<typeof FileSystem>('node:fs/promises');
    const denied = Object.assign(new Error('synthetic access refusal'), { code: 'EACCES' });
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === target) throw denied;
      return actual.lstat(...args);
    });
    await expect(list()).rejects.toBe(denied);
    expect(await readFile(outside)).toEqual(bytes);
  });

  it('nonwaiting cleanup skips a busy gate without queuing behind capture', async () => {
    const gate = createRouteFileGate();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const capture = gate.runExclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    expect(await gate.tryRunExclusive(async () => 'must not run')).toEqual({ acquired: false });
    release.resolve(); await capture;
    expect(await gate.tryRunExclusive(async () => 'ready')).toEqual({ acquired: true, value: 'ready' });
  });
});
