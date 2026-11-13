import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { deleteMedia, imageUsage, imageUsageBatch, listVariantFiles, VARIANT_FILE_RE } from '../src/media-files.js';
import type { PostUsageRow } from '../src/posts.js';
import type { PagePair } from '../src/pages.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgmedia-'));
});

async function put(rel: string, data: Buffer | string = 'x'): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, data);
}

describe('VARIANT_FILE_RE', () => {
  it('matches the {key}-{width}.{fmt} contract only', () => {
    expect(VARIANT_FILE_RE.test('hero-640.webp')).toBe(true);
    expect(VARIANT_FILE_RE.test('hero-1280.avif')).toBe(true);
    expect(VARIANT_FILE_RE.test('hero-1280.jpeg')).toBe(true);
    expect(VARIANT_FILE_RE.test('hero.webp')).toBe(false);
    expect(VARIANT_FILE_RE.test('hero-640.jpg')).toBe(false);
    expect(VARIANT_FILE_RE.test('notes.txt')).toBe(false);
  });
});

const SRC = 'https://img.example/trips/x/hero';

// Both locale rows of one post, as PostStore.usageRows() would report them.
function post(over: {
  tk?: string; title?: string; heroSrc?: string; body?: string; images?: Record<string, { width: number; height: number }>;
  source?: PostUsageRow['source'];
}): PostUsageRow[] {
  return (['de', 'en'] as const).map((locale) => ({
    translationKey: over.tk ?? 'p1',
    locale,
    source: over.source ?? 'working',
    title: over.title ?? 'Titel',
    heroImage: { src: over.heroSrc ?? 'https://img.example/other/hero', width: 9, height: 9, alt: 'a' },
    bodyMarkdown: over.body ?? '## body',
    images: over.images ?? {},
  }));
}

function page(over: { key?: string; title?: string; body?: string; images?: Record<string, { width: number; height: number }> }): PagePair {
  const locale = (loc: 'de' | 'en') => ({
    locale: loc,
    title: over.title ?? 'About',
    bodyMarkdown: over.body ?? '',
    images: over.images ?? {},
  });
  return { key: over.key ?? 'about', de: locale('de'), en: locale('en') };
}

describe('imageUsage', () => {
  it('finds heroImage.src usage by exact match', () => {
    const refs = imageUsage(SRC, post({ tk: 'p1', title: 'Trip', heroSrc: SRC }), []);
    expect(refs).toEqual([{ kind: 'post', key: 'p1', title: 'Trip', published: false, working: true }]);
  });

  // #115: the snapshot rows are what the blog serves. A photo only the
  // published version still renders is reported as `published` and not
  // `working`, so the caller can say "republish first" instead of "remove
  // the reference" (the draft already did that).
  it('flags usage that survives only in the published snapshot', () => {
    const rows = [
      ...post({ tk: 'p1', title: 'Trip', heroSrc: 'https://img.example/other/new' }),
      ...post({ tk: 'p1', title: 'Trip', heroSrc: SRC, source: 'published' }),
    ];
    expect(imageUsage(SRC, rows, [])).toEqual([{ kind: 'post', key: 'p1', title: 'Trip', published: true, working: false }]);
    // Both copies referencing it: one ref, both flags — still one post.
    const both = [...post({ tk: 'p1', heroSrc: SRC }), ...post({ tk: 'p1', heroSrc: SRC, source: 'published' })];
    expect(imageUsage(SRC, both, [])).toEqual([expect.objectContaining({ key: 'p1', published: true, working: true })]);
  });

  it('counts a direct variant URL pasted as heroImage.src (copy-image-address)', () => {
    const refs = imageUsage(SRC, post({ heroSrc: `${SRC}-1280.webp` }), []);
    expect(refs).toHaveLength(1);
    // Prefix keys still don't match: hero vs hero2 / hero-2.
    expect(imageUsage(SRC, post({ heroSrc: `${SRC}2` }), [])).toHaveLength(0);
    expect(imageUsage(SRC, post({ heroSrc: `${SRC}-2` }), [])).toHaveLength(0);
  });

  it('finds usage via the images map keys, including direct variant URLs', () => {
    expect(imageUsage(SRC, post({ images: { [SRC]: { width: 1, height: 1 } } }), [])).toHaveLength(1);
    expect(imageUsage(SRC, post({ images: { [`${SRC}-640.webp`]: { width: 1, height: 1 } } }), [])).toHaveLength(1);
    expect(imageUsage(SRC, post({ images: { [`${SRC}-2`]: { width: 1, height: 1 } } }), [])).toHaveLength(0);
  });

  it('finds usage inside body markdown, but not prefix keys', () => {
    expect(imageUsage(SRC, post({ body: `![a](${SRC})` }), [])).toHaveLength(1);
    // hero2 and hero-2 are different keys — no false positive.
    expect(imageUsage(SRC, post({ body: `![a](${SRC}2)` }), [])).toHaveLength(0);
    expect(imageUsage(SRC, post({ body: `![a](${SRC}-2)` }), [])).toHaveLength(0);
  });

  it('counts a hand-written direct variant URL as usage', () => {
    expect(imageUsage(SRC, post({ body: `<img src="${SRC}-640.webp">` }), [])).toHaveLength(1);
    expect(imageUsage(SRC, post({ body: `<img src="${SRC}-640.jpeg">` }), [])).toHaveLength(1);
  });

  it('finds page usage too', () => {
    const refs = imageUsage(SRC, [], [page({ key: 'about', title: 'Über mich', body: `![x](${SRC})` })]);
    expect(refs).toEqual([{ kind: 'page', key: 'about', title: 'Über mich', published: true, working: true }]);
  });

  it('reports each post once even when both locales use the image', () => {
    expect(imageUsage(SRC, post({ tk: 'p9', heroSrc: SRC, body: `see ${SRC}` }), [])).toHaveLength(1);
  });

  it('sees usage in a stranded single-locale row', () => {
    // A crash between upsertDraft's two locale INSERTs leaves one row; the
    // row-based corpus must still report it (get() would return null).
    const deOnly = post({ tk: 'half', title: 'Halb', heroSrc: SRC }).slice(0, 1);
    expect(imageUsage(SRC, deOnly, [])).toEqual([{ kind: 'post', key: 'half', title: 'Halb', published: false, working: true }]);
  });

  it('returns [] when nothing references the src', () => {
    expect(imageUsage(SRC, post({}), [page({})])).toEqual([]);
  });
});

describe('deleteMedia', () => {
  it('stops deleting files as soon as the storage guard latches read-only', async () => {
    await put('photo-640.avif');
    await put('photo-640.webp');
    await expect(deleteMedia(dir, 'photo', {
      isWritable: () => readdirSync(dir).length === 2,
    })).rejects.toMatchObject({ code: 'storage_read_only' });
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('removes exactly the key\'s variant files, leaving prefix siblings alone', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-640.avif');
    await put('trips/x/hero-1280.webp');
    await put('trips/x/hero-1280.jpeg');
    await put('trips/x/hero-2-640.webp');
    await put('trips/x/notes.txt');
    const removed = await deleteMedia(dir, 'trips/x/hero');
    expect(removed).toBe(4);
    const left = await readdir(join(dir, 'trips/x'));
    expect(left.sort()).toEqual(['hero-2-640.webp', 'notes.txt']);
  });

  it('returns 0 for an unknown key and for a missing directory', async () => {
    await put('trips/x/hero-640.webp');
    expect(await deleteMedia(dir, 'trips/x/ghost')).toBe(0);
    expect(await deleteMedia(dir, 'nowhere/at/all')).toBe(0);
  });

  it('rejects unsafe keys (path traversal)', async () => {
    for (const bad of ['../evil', 'a//b', 'trips/../../etc/x', 'Evil', '/abs']) {
      await expect(deleteMedia(dir, bad)).rejects.toThrow(/key/i);
    }
  });

  it('refuses a trailing-slash key, which would otherwise delete the sibling key\'s files', async () => {
    await put('trips/x-640.webp');
    await put('trips/x-orig.jpg');
    await expect(deleteMedia(dir, 'trips/x/')).rejects.toThrow(/trailing slash/);
    expect((await readdir(join(dir, 'trips'))).sort()).toEqual(['x-640.webp', 'x-orig.jpg']);
  });
});

// #570: the Versions list. The disk is the authoritative source for which
// variant files exist, so these run against real files with real headers.
describe('listVariantFiles', () => {
  /** A real image whose pixel size is unrelated to the width in its file name. */
  const image = (format: 'avif' | 'webp' | 'jpeg', width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } } })
      .toFormat(format, format === 'avif' ? { effort: 0 } : {}).toBuffer();

  it('lists a modern set by width, then AVIF before WebP, with header height and file size', async () => {
    const files = {
      'hero-1280.webp': await image('webp', 128, 80),
      'hero-640.webp': await image('webp', 64, 40),
      'hero-1280.avif': await image('avif', 128, 80),
      'hero-640.avif': await image('avif', 64, 40),
    };
    for (const [name, bytes] of Object.entries(files)) await put(`trips/x/${name}`, bytes);
    // The private original, a temp from an interrupted write and an unrelated file are never variants.
    await put('trips/x/hero-orig.jpg', await image('jpeg', 300, 200));
    await put('trips/x/hero-640.webp.part-1a2b3c4d', 'partial');
    await put('trips/x/notes.txt');
    expect(await listVariantFiles(dir, 'trips/x/hero')).toEqual([
      { format: 'avif', width: 640, height: 40, bytes: files['hero-640.avif'].length },
      { format: 'webp', width: 640, height: 40, bytes: files['hero-640.webp'].length },
      { format: 'avif', width: 1280, height: 80, bytes: files['hero-1280.avif'].length },
      { format: 'webp', width: 1280, height: 80, bytes: files['hero-1280.webp'].length },
    ]);
  });

  it('lists a JPEG-only set, and orders AVIF, WebP, JPEG within one width', async () => {
    const jpeg = await image('jpeg', 64, 48);
    await put('library/2026/jpeg-640.jpeg', jpeg);
    await put('library/2026/jpeg-800.jpeg', jpeg);
    expect(await listVariantFiles(dir, 'library/2026/jpeg')).toEqual([
      { format: 'jpeg', width: 640, height: 48, bytes: jpeg.length },
      { format: 'jpeg', width: 800, height: 48, bytes: jpeg.length },
    ]);
    for (const format of ['jpeg', 'webp', 'avif'] as const) await put(`mixed-640.${format}`, await image(format, 64, 48));
    expect((await listVariantFiles(dir, 'mixed')).map((file) => file.format)).toEqual(['avif', 'webp', 'jpeg']);
  });

  it('lists exactly what exists for a partial set, and null height for a file it cannot read', async () => {
    const webp = await image('webp', 64, 40);
    await put('trips/x/hero-640.webp', webp);       // the encoder died after one file
    await put('trips/x/hero-1280.avif', 'truncated'); // present, but not an image
    expect(await listVariantFiles(dir, 'trips/x/hero')).toEqual([
      { format: 'webp', width: 640, height: 40, bytes: webp.length },
      { format: 'avif', width: 1280, height: null, bytes: 'truncated'.length },
    ]);
  });

  it('matches the exact base, never a sibling key sharing the prefix', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-b-640.webp');
    await put('trips/x/hero-2-640.webp');
    await put('trips/x/hero-640-640.webp');
    const widths = async (key: string) => (await listVariantFiles(dir, key)).map((file) => file.width);
    expect(await widths('trips/x/hero')).toEqual([640]);
    expect(await widths('trips/x/hero-b')).toEqual([640]);
    expect(await widths('trips/x/hero-640')).toEqual([640]);
    expect(await widths('trips/x/her')).toEqual([]);
  });

  it('leaves out a name whose width does not round-trip into the public URL', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-0640.webp');
    await put(`trips/x/hero-${'9'.repeat(25)}.webp`);
    expect((await listVariantFiles(dir, 'trips/x/hero')).map((file) => file.width)).toEqual([640]);
  });

  it('takes regular files only: a symlinked variant and a directory are skipped, never followed', async () => {
    await put('trips/x/hero-640.webp', await image('webp', 64, 40));
    // A full-size private file elsewhere, reachable only through the link.
    await put('private/secret-orig.jpg', await image('jpeg', 300, 200));
    await symlink(join(dir, 'private/secret-orig.jpg'), join(dir, 'trips/x/hero-1280.webp'));
    await mkdir(join(dir, 'trips/x/hero-1920.avif'));
    expect((await readdir(join(dir, 'trips/x'))).sort()).toEqual(['hero-1280.webp', 'hero-1920.avif', 'hero-640.webp']);
    expect((await listVariantFiles(dir, 'trips/x/hero')).map((file) => [file.format, file.width])).toEqual([['webp', 640]]);
  });

  it('rejects an unsafe key before any path is built or read', async () => {
    // `<dir>/file` is a regular file: a readdir reaching it would fail with
    // ENOTDIR, and one reaching `<dir>/outside` would find a variant. The
    // guard's own error proves neither path was ever touched.
    await put('file');
    await put('outside/hero-640.webp', await image('webp', 64, 40));
    const storage = join(dir, 'storage');
    await mkdir(storage);
    for (const bad of ['../file/hero', '../outside/hero', 'a//b', 'trips/../../etc/x', 'Evil', '/abs', 'a.b', 'k'.repeat(201), 'file/']) {
      await expect(listVariantFiles(storage, bad)).rejects.toThrow(/^unsafe storage key/);
    }
  });

  it('answers an empty list for a missing directory and for a key with no files', async () => {
    await put('trips/x/hero-640.webp');
    expect(await listVariantFiles(dir, 'nowhere/at/all')).toEqual([]);
    expect(await listVariantFiles(dir, 'trips/x/ghost')).toEqual([]);
    expect(await listVariantFiles(join(dir, 'no-such-storage'), 'hero')).toEqual([]);
  });

  it('throws every other storage error for the caller to report as unavailable', async () => {
    await put('trips'); // the key's directory is a file
    await expect(listVariantFiles(dir, 'trips/x/hero')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('imageUsageBatch', () => {
  it('matches imageUsage across posts, pages, variant suffixes, and boundary-adjacent keys', () => {
    const base = 'https://img.example';
    const posts: PostUsageRow[] = [
      {
        translationKey: 'tk-1', locale: 'de', source: 'working', title: 'One',
        heroImage: { src: `${base}/trips/a/hero`, width: 800, height: 600, alt: '' },
        bodyMarkdown: `Inline ![x](${base}/trips/a/inline-640.webp) and sibling ${base}/trips/a/hero-2`,
        images: {},
      },
      {
        translationKey: 'tk-1', locale: 'de', source: 'published', title: 'One',
        heroImage: { src: `${base}/trips/a/hero`, width: 800, height: 600, alt: '' },
        bodyMarkdown: 'No inline anymore',
        images: {},
      },
    ];
    const pages = [{
      key: 'about',
      de: { locale: 'de' as const, title: 'Über mich', bodyMarkdown: `![About](${base}/about/me)`, images: {} },
      en: { locale: 'en' as const, title: 'About', bodyMarkdown: '', images: {} },
    }];
    const srcs = [
      `${base}/trips/a/hero`,
      `${base}/trips/a/hero-2`,
      `${base}/trips/a/inline`,
      `${base}/trips/a/her`,
      `${base}/about/me`,
    ];
    const batch = imageUsageBatch(srcs, posts, pages);
    for (const src of srcs) {
      expect(batch.get(src), src).toEqual(imageUsage(src, posts, pages));
    }
  });
});
