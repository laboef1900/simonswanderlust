import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGpxFiles, createRouteFileGate, safePairHash, sourceDigest, type OriginalSource } from '../src/gpx-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
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
