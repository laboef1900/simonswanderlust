import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createMediaSync, harvestAlt, walkStorageKeys } from '../src/media-sync.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import type { PostUsageRow } from '../src/posts.js';

const BASE = 'https://img.example.com';
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mediasync-')); });

async function writeVariant(key: string, width: number, format: 'webp' | 'avif' = 'webp') {
  const abs = join(dir, `${key}-${width}.${format}`);
  await mkdir(join(abs, '..'), { recursive: true });
  const img = sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: '#123' } });
  await writeFile(abs, format === 'webp' ? await img.webp().toBuffer() : await img.avif().toBuffer());
}
async function writeOriginal(key: string, bytes = 'x'.repeat(50)) {
  const abs = join(dir, `${key}-orig.jpg`);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, bytes);
}

const sync = (store: MediaStore, posts: PostUsageRow[] = []) => createMediaSync({
  store, storageDir: dir, baseUrl: BASE,
  corpus: async () => ({ posts, pages: [] }),
  log: () => {},
});

describe('walkStorageKeys', () => {
  // @ai-warning: this must NOT reuse listMedia, which matches variants only —
  // a crashed upload has written just `${key}-orig.<ext>`, which is exactly
  // the case the backfill most needs to find.
  it('discovers an originals-only key (a crashed upload) as well as variant keys', async () => {
    await writeVariant('trips/a/hero', 640);
    await writeOriginal('trips/a/hero');
    await writeOriginal('library/2025/crashed');
    const keys = await walkStorageKeys(dir);
    expect([...keys.keys()].sort()).toEqual(['library/2025/crashed', 'trips/a/hero']);
    expect(keys.get('trips/a/hero')).toMatchObject({ hasVariants: true });
    expect(keys.get('library/2025/crashed')).toMatchObject({ hasVariants: false, origBytes: 50 });
  });

  it('returns empty for a missing storage dir instead of throwing', async () => {
    expect((await walkStorageKeys(join(dir, 'nope'))).size).toBe(0);
  });
});

describe('harvestAlt', () => {
  const row = (over: Partial<PostUsageRow>): PostUsageRow => ({
    translationKey: 'p1', locale: 'de', title: 'T',
    heroImage: { src: 'https://img.example.com/other', width: 1, height: 1, alt: '' },
    bodyMarkdown: '', images: {}, ...over,
  });

  it('files hero alt under the referencing row\'s own locale', () => {
    const src = `${BASE}/trips/a/hero`;
    const out = harvestAlt(src, [
      row({ locale: 'de', heroImage: { src, width: 1, height: 1, alt: 'Altstadt' } }),
      row({ locale: 'en', heroImage: { src, width: 1, height: 1, alt: 'Old town' } }),
    ]);
    expect(out).toEqual({ de: 'Altstadt', en: 'Old town' });
  });

  it('harvests body-image alt from the ![alt](src) form', () => {
    const src = `${BASE}/trips/a/pic`;
    expect(harvestAlt(src, [row({ locale: 'en', bodyMarkdown: `text ![A gate](${src}) more` })]))
      .toEqual({ de: '', en: 'A gate' });
  });

  // @ai-warning: exact URL matches only. A mis-attribution would silently
  // poison the library and then denormalize into every future post.
  it('is exact-match only — a prefix or variant URL does not count', () => {
    const src = `${BASE}/trips/a/hero`;
    expect(harvestAlt(src, [
      row({ bodyMarkdown: `![Wrong](${src}-2)` }),
      row({ bodyMarkdown: `![Also wrong](${src}-640.webp)` }),
      row({ heroImage: { src: `${src}x`, width: 1, height: 1, alt: 'Nope' } }),
    ])).toEqual({ de: '', en: '' });
  });

  it('does not mix locales when both rows share a title', () => {
    // The regression that motivated carrying `locale` on PostUsageRow.
    const src = `${BASE}/trips/a/hero`;
    const out = harvestAlt(src, [
      row({ locale: 'de', title: 'Same', heroImage: { src, width: 1, height: 1, alt: 'Deutsch' } }),
      row({ locale: 'en', title: 'Same', heroImage: { src, width: 1, height: 1, alt: 'English' } }),
    ]);
    expect(out).toEqual({ de: 'Deutsch', en: 'English' });
  });
});

describe('createMediaSync', () => {
  it('backfills a row for every key on disk, probing real dimensions', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeVariant('trips/a/hero', 640);
    await writeOriginal('trips/a/hero');
    const report = await sync(store).run();
    expect(report).toMatchObject({ scanned: 1, inserted: 1 });
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'ready', width: 640, height: 480 });
  });

  it('marks an originals-only key as processing, not ready', async () => {
    // It has no variants — declaring it ready would let it be published with
    // broken <img> elements, which is exactly what the publish gate prevents.
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeOriginal('library/2025/crashed');
    await sync(store).run();
    expect(await store.get('library/2025/crashed')).toMatchObject({ status: 'processing', width: 0, height: 0 });
  });

  it('harvests alt text for a backfilled key', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeVariant('trips/a/hero', 640);
    const src = `${BASE}/trips/a/hero`;
    const report = await sync(store, [{
      translationKey: 'p1', locale: 'de', title: 'T',
      heroImage: { src, width: 1, height: 1, alt: 'Altstadt' }, bodyMarkdown: '', images: {},
    }]).run();
    expect(report.altHarvested).toBe(1);
    expect((await store.get('trips/a/hero'))?.alt).toEqual({ de: 'Altstadt', en: '' });
  });

  it('leaves an existing row alone (never clobbers author-entered metadata)', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeVariant('trips/a/hero', 640);
    await store.upsert({ key: 'trips/a/hero', status: 'ready', width: 640, height: 480, origBytes: 0, exif: noExif, uploadedBy: null, title: 'Mine' });
    const report = await sync(store).run();
    expect(report.inserted).toBe(0);
    expect((await store.get('trips/a/hero'))?.title).toBe('Mine');
  });

  it('marks a row whose files vanished as missing, never deleting it', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await store.upsert({ key: 'trips/gone/hero', status: 'ready', width: 8, height: 6, origBytes: 0, exif: noExif, uploadedBy: null, title: 'Keep me' });
    const report = await sync(store).run();
    expect(report.markedMissing).toBe(1);
    // The metadata is the only thing left worth keeping.
    expect(await store.get('trips/gone/hero')).toMatchObject({ status: 'missing', title: 'Keep me' });
  });

  // @ai-warning: an upload in flight has a row but not yet a full file set.
  it('skips non-ready rows when pruning, so an in-flight upload is not marked missing', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await store.upsert({ key: 'library/2025/uploading', status: 'processing', width: 8, height: 6, origBytes: 0, exif: noExif, uploadedBy: null });
    const report = await sync(store).run();
    expect(report.markedMissing).toBe(0);
    expect(await store.get('library/2025/uploading')).toMatchObject({ status: 'processing' });
  });

  it('degrades gracefully when the content corpus cannot be loaded', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeVariant('trips/a/hero', 640);
    const s = createMediaSync({
      store, storageDir: dir, baseUrl: BASE,
      corpus: async () => { throw new Error('db down'); },
      log: () => {},
    });
    await expect(s.run()).resolves.toMatchObject({ inserted: 1, altHarvested: 0 });
  });
});
