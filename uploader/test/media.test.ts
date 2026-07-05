import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { listMedia, deleteMedia, imageUsage, VARIANT_FILE_RE } from '../src/media.js';
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

async function webp(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#345' } }).webp().toBuffer();
}

describe('VARIANT_FILE_RE', () => {
  it('matches the {key}-{width}.{fmt} contract only', () => {
    expect(VARIANT_FILE_RE.test('hero-640.webp')).toBe(true);
    expect(VARIANT_FILE_RE.test('hero-1280.avif')).toBe(true);
    expect(VARIANT_FILE_RE.test('hero.webp')).toBe(false);
    expect(VARIANT_FILE_RE.test('hero-640.jpg')).toBe(false);
    expect(VARIANT_FILE_RE.test('notes.txt')).toBe(false);
  });
});

describe('listMedia', () => {
  it('groups variant files by key, including nested keys, ignoring non-variant files', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-640.avif');
    await put('trips/x/hero-1280.webp');
    await put('trips/x/hero-1280.avif');
    await put('standalone-800.webp');
    await put('trips/x/notes.txt');
    await put('trips/x/plain.webp'); // no width suffix — not a variant
    const items = await listMedia(dir);
    expect(items.map((i) => i.key)).toEqual(['standalone', 'trips/x/hero']);
    const hero = items.find((i) => i.key === 'trips/x/hero')!;
    expect(hero.files).toEqual([
      'trips/x/hero-640.avif',
      'trips/x/hero-640.webp',
      'trips/x/hero-1280.avif',
      'trips/x/hero-1280.webp',
    ]);
    expect(hero.widths).toEqual([640, 1280]);
  });

  it('keeps sibling keys sharing a prefix separate (hero vs hero-2)', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-2-640.webp');
    const items = await listMedia(dir);
    expect(items.map((i) => i.key).sort()).toEqual(['trips/x/hero', 'trips/x/hero-2']);
  });

  it('uses the smallest webp as thumbnail and probes dims from the largest webp', async () => {
    // Small image (no 640 variant exists — variantWidths never upscales).
    await put('pic-300.webp', await webp(300, 200));
    const items = await listMedia(dir);
    expect(items).toHaveLength(1);
    expect(items[0]!.thumbFile).toBe('pic-300.webp');
    expect(items[0]!.width).toBe(300);
    expect(items[0]!.height).toBe(200);
  });

  it('picks the smallest webp among several and reads dims from the largest', async () => {
    await put('pic-640.webp', await webp(640, 480));
    await put('pic-1000.webp', await webp(1000, 750));
    await put('pic-640.avif');
    const items = await listMedia(dir);
    expect(items[0]!.thumbFile).toBe('pic-640.webp');
    expect(items[0]!.width).toBe(1000);
    expect(items[0]!.height).toBe(750);
  });

  it('reports null dims when the file is unreadable and null thumb without a webp', async () => {
    await put('junk-640.webp', 'not a real webp');
    await put('avifonly-640.avif');
    const items = await listMedia(dir);
    const junk = items.find((i) => i.key === 'junk')!;
    expect(junk.width).toBeNull();
    expect(junk.height).toBeNull();
    const avifonly = items.find((i) => i.key === 'avifonly')!;
    expect(avifonly.thumbFile).toBeNull();
    expect(avifonly.width).toBeNull();
  });

  it('returns [] for a storage dir that does not exist yet', async () => {
    expect(await listMedia(join(dir, 'nope'))).toEqual([]);
  });
});

const SRC = 'https://img.example/trips/x/hero';

// Both locale rows of one post, as PostStore.usageRows() would report them.
function post(over: {
  tk?: string; title?: string; heroSrc?: string; body?: string; images?: Record<string, { width: number; height: number }>;
}): PostUsageRow[] {
  return (['de', 'en'] as const).map(() => ({
    translationKey: over.tk ?? 'p1',
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
    expect(refs).toEqual([{ kind: 'post', key: 'p1', title: 'Trip' }]);
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
  });

  it('finds page usage too', () => {
    const refs = imageUsage(SRC, [], [page({ key: 'about', title: 'Über mich', body: `![x](${SRC})` })]);
    expect(refs).toEqual([{ kind: 'page', key: 'about', title: 'Über mich' }]);
  });

  it('reports each post once even when both locales use the image', () => {
    expect(imageUsage(SRC, post({ tk: 'p9', heroSrc: SRC, body: `see ${SRC}` }), [])).toHaveLength(1);
  });

  it('sees usage in a stranded single-locale row', () => {
    // A crash between upsertDraft's two locale INSERTs leaves one row; the
    // row-based corpus must still report it (get() would return null).
    const deOnly = post({ tk: 'half', title: 'Halb', heroSrc: SRC }).slice(0, 1);
    expect(imageUsage(SRC, deOnly, [])).toEqual([{ kind: 'post', key: 'half', title: 'Halb' }]);
  });

  it('returns [] when nothing references the src', () => {
    expect(imageUsage(SRC, post({}), [page({})])).toEqual([]);
  });
});

describe('deleteMedia', () => {
  it('removes exactly the key\'s variant files, leaving prefix siblings alone', async () => {
    await put('trips/x/hero-640.webp');
    await put('trips/x/hero-640.avif');
    await put('trips/x/hero-1280.webp');
    await put('trips/x/hero-2-640.webp');
    await put('trips/x/notes.txt');
    const removed = await deleteMedia(dir, 'trips/x/hero');
    expect(removed).toBe(3);
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
});
