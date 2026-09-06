import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteMedia, imageUsage, VARIANT_FILE_RE } from '../src/media-files.js';
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
