import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseManifestReader, publishReleaseManifest, sweepReleaseManifests } from '../src/release-manifest.js';
import { isReleaseManifest, readReleaseManifest, RELEASE_MANIFEST_MAX_BYTES, writeReleaseManifest, type ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';

const faults = vi.hoisted(() => ({
  link: undefined as (() => void) | undefined,
  open: undefined as (() => Promise<void> | void) | undefined,
  mutation: undefined as (() => void) | undefined,
  links: 0,
  opens: 0,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    readlink: async (...args: Parameters<typeof fs.readlink>) => { faults.links++; faults.link?.(); return fs.readlink(...args); },
    open: async (...args: Parameters<typeof fs.open>) => { faults.opens++; await faults.open?.(); return fs.open(...args); },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => { faults.mutation?.(); return fs.mkdir(...args); },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => { faults.mutation?.(); return fs.writeFile(...args); },
    rename: async (...args: Parameters<typeof fs.rename>) => { faults.mutation?.(); return fs.rename(...args); },
    rm: async (...args: Parameters<typeof fs.rm>) => { faults.mutation?.(); return fs.rm(...args); },
  };
});
const disk = await vi.importActual<typeof FileSystem>('node:fs/promises');
const a = '1793280607605-1-0000';
const b = '1793280607606-1-0001';
let root: string;
const manifest = (stamp = a): ReleaseManifestV1 => ({
  schema: 1, stamp,
  posts: [{ translationKey: 'story', locale: 'de', slug: 'story', digest: 'a'.repeat(64), gallery: [
    { src: 'https://images.example/story/photo', alt: '', caption: null },
    { src: 'https://images.example/story/photo', alt: 'Repeated', caption: '' },
  ] }],
});
async function install(stamp = a, content = JSON.stringify(manifest(stamp))) {
  await disk.mkdir(join(root, 'releases', stamp), { recursive: true });
  await disk.writeFile(join(root, 'manifests', `${stamp}.json`), content);
  await disk.symlink(join('releases', stamp), join(root, 'next'));
  await disk.rename(join(root, 'next'), join(root, 'current'));
}
beforeEach(async () => {
  root = await disk.mkdtemp(join(tmpdir(), 'release-manifest-'));
  await disk.mkdir(join(root, 'manifests'));
  faults.links = 0;
  faults.opens = 0;
});
afterEach(async () => {
  faults.link = undefined;
  faults.open = undefined;
  faults.mutation = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await disk.rm(root, { recursive: true, force: true });
});

describe('strict release manifests', () => {
  it('accepts exact public fields, repeated gallery occurrences, and empty strings', () => {
    expect(isReleaseManifest(manifest(), a)).toBe(true);
  });
  it.each([
    { schema: 2 }, { stamp: b }, { extra: true }, { posts: null },
    { posts: [{ ...manifest().posts[0], digest: 'z'.repeat(64) }] },
    { posts: [{ ...manifest().posts[0], locale: 'fr' }] },
    { posts: [{ ...manifest().posts[0], slug: 10 }] },
    { posts: [{ ...manifest().posts[0], gallery: [{ src: 'url', alt: false, caption: null }] }] },
    { posts: [{ ...manifest().posts[0], gallery: [{ src: 'url', alt: '', caption: 5 }] }] },
    { posts: [{ ...manifest().posts[0], gallery: [{ src: 'url', alt: '', caption: null, extra: true }] }] },
    { posts: [manifest().posts[0], manifest().posts[0]] },
  ])('rejects malformed or ambiguous records: %j', (patch) => {
    expect(isReleaseManifest({ ...manifest(), ...patch }, a)).toBe(false);
  });
  it('enforces the actual byte cap while accepting exactly 8 MiB', async () => {
    const path = join(root, 'manifest.json');
    const json = JSON.stringify(manifest());
    await disk.writeFile(path, json + ' '.repeat(RELEASE_MANIFEST_MAX_BYTES - Buffer.byteLength(json)));
    expect(await readReleaseManifest(path, a)).toEqual(manifest());
    await disk.appendFile(path, ' ');
    await expect(readReleaseManifest(path, a)).rejects.toThrow('Invalid release manifest');
  });
  it('writes optional loader output and derives the exact stamp from its path', async () => {
    const path = join(root, 'scratch', `${a}.manifest.json`);
    await writeReleaseManifest(manifest().posts, path);
    expect(await readReleaseManifest(path, a)).toEqual(manifest());
    expect(await disk.readdir(join(root, 'scratch'))).toEqual([`${a}.manifest.json`]);
  });
  it('does nothing without the build variable and contains serialization/write/diagnostic failures', async () => {
    vi.stubEnv('SITE_RELEASE_MANIFEST', '');
    const warn = vi.fn(() => { throw new Error('log sink'); });
    faults.mutation = () => { throw new Error('filesystem unavailable'); };
    await expect(writeReleaseManifest(manifest().posts, undefined, warn)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    await expect(writeReleaseManifest(manifest().posts, join(root, `${a}.manifest.json`), warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Release publication manifest unavailable; rendered site is unchanged.');
  });
  it('removes stale loader output when replacement exceeds the cap', async () => {
    const path = join(root, `${a}.manifest.json`);
    await writeReleaseManifest(manifest().posts, path);
    const posts = manifest().posts;
    posts[0]!.gallery[0]!.alt = 'ä'.repeat(RELEASE_MANIFEST_MAX_BYTES / 2);
    await expect(writeReleaseManifest(posts, path, () => {})).resolves.toBeUndefined();
    await expect(disk.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('request-time release observations', () => {
  it('distinguishes confirmed absence, failed inspection and legacy releases', async () => {
    const reader = createReleaseManifestReader(root);
    expect(await reader.read()).toEqual({ release: 'none' });
    faults.link = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(await reader.read()).toEqual({ release: 'unknown' });
    faults.link = undefined;
    await install();
    await disk.rm(join(root, 'manifests', `${a}.json`));
    expect(await reader.read()).toEqual({ release: 'unknown' });
    await disk.writeFile(join(root, 'manifests', `${a}.json`), JSON.stringify(manifest()));
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
  });
  it.each(['{broken', JSON.stringify(manifest(b)), ' '.repeat(RELEASE_MANIFEST_MAX_BYTES + 1)])('does not cache invalid observations', async (content) => {
    await install(a, content);
    const reader = createReleaseManifestReader(root);
    expect(await reader.read()).toEqual({ release: 'unknown' });
    await disk.writeFile(join(root, 'manifests', `${a}.json`), JSON.stringify(manifest()));
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
  });
  it('inspects current every request, caches one exact stamp, and reloads rollback', async () => {
    await install();
    const reader = createReleaseManifestReader(root);
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
    expect(faults.links).toBe(2);
    expect(faults.opens).toBe(1);
    await install(b);
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest(b) });
    await install(a);
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
    expect(faults.opens).toBe(3);
    faults.link = () => { throw Object.assign(new Error('unreadable'), { code: 'EIO' }); };
    expect(await reader.read()).toEqual({ release: 'unknown' });
  });
  it('rereads the link only once when a just-observed file disappears', async () => {
    await install();
    faults.open = async () => {
      faults.open = undefined;
      await disk.rm(join(root, 'manifests', `${a}.json`));
      await install(b);
    };
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'known', manifest: manifest(b) });
    expect(faults.links).toBe(2);
    expect(faults.opens).toBe(2);
  });
  it('bounds unresolved missing-file retries and confirms absence on the second observation', async () => {
    await install();
    await disk.rm(join(root, 'manifests', `${a}.json`));
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'unknown' });
    expect(faults.links).toBe(2);
    faults.open = async () => { await disk.rm(join(root, 'current'), { force: true }); };
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'none' });
  });
  it('permits a just-observed older release and corrects it on next read, including restart', async () => {
    await install();
    faults.open = async () => { faults.open = undefined; await install(b); };
    const reader = createReleaseManifestReader(root);
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest() });
    expect(await reader.read()).toEqual({ release: 'known', manifest: manifest(b) });
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'known', manifest: manifest(b) });
  });
  it('rejects a same-basename symlink outside releases without opening a manifest', async () => {
    await disk.symlink(join(root, 'outside', a), join(root, 'current'));
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'unknown' });
    expect(faults.opens).toBe(0);
  });
});

describe('storage ownership', () => {
  it('admits no manifest mutation when ownership is already lost', async () => {
    await install();
    const source = join(root, `${b}.manifest.json`);
    await writeReleaseManifest(manifest(b).posts, source);
    await disk.writeFile(join(root, 'manifests', '1-1-0000.json'), '{}');
    const mutation = vi.fn();
    faults.mutation = mutation;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishReleaseManifest(source, root, b, { isWritable: () => false });
    await sweepReleaseManifests(root, { isWritable: () => false });
    expect(mutation).not.toHaveBeenCalled();
    expect(await createReleaseManifestReader(root).read()).toEqual({ release: 'known', manifest: manifest() });
  });
  it('stops after an admitted manifest mkdir loses ownership', async () => {
    const source = join(root, `${a}.manifest.json`);
    await writeReleaseManifest(manifest().posts, source);
    let writable = true;
    const mutation = vi.fn(() => { writable = false; });
    faults.mutation = mutation;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishReleaseManifest(source, root, a, { isWritable: () => writable });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(await disk.readdir(join(root, 'manifests'))).toEqual([]);
  });
});
