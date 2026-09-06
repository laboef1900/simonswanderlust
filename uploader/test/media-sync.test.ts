import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createMediaSync, createReconciler, harvestAlt, isCompleteSet, walkStorageKeys } from '../src/media-sync.js';
import { FORMATS, variantWidths } from '../src/variants.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
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
/** The complete contract for an intrinsic width — every `variantWidths` width in every format. */
async function writeSet(key: string, intrinsicWidth: number, opts: { skip?: string[] } = {}) {
  for (const w of variantWidths(intrinsicWidth)) {
    for (const f of FORMATS) {
      if (opts.skip?.includes(`${w}.${f}`)) continue;
      await writeVariant(key, w, f);
    }
  }
}
/** An UNREADABLE original — what a crashed upload's truncated file looks like to sharp. */
async function writeOriginal(key: string, bytes = 'x'.repeat(50)) {
  const abs = join(dir, `${key}-orig.jpg`);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, bytes);
}
async function writeJpegOriginal(key: string, width: number) {
  const abs = join(dir, `${key}-orig.jpg`);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, await sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: '#321' } }).jpeg().toBuffer());
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
    await writeVariant('trips/a/hero', 640, 'avif');
    await writeOriginal('trips/a/hero');
    await writeOriginal('library/2025/crashed');
    const keys = await walkStorageKeys(dir);
    expect([...keys.keys()].sort()).toEqual(['library/2025/crashed', 'trips/a/hero']);
    const hero = keys.get('trips/a/hero');
    expect([...hero!.variants].sort()).toEqual(['640.avif', '640.webp']);
    expect(hero).toMatchObject({ largestVariant: 'trips/a/hero-640.webp', original: 'trips/a/hero-orig.jpg' });
    expect(keys.get('library/2025/crashed')).toMatchObject({ variants: new Set(), largestVariant: null, origBytes: 50 });
  });

  it('ignores storage.ts temp files, so a crashed write never becomes a key', async () => {
    await mkdir(join(dir, 'trips/a'), { recursive: true });
    await writeFile(join(dir, 'trips/a/hero-1280.webp.part-0a1b2c3d'), 'partial');
    await writeFile(join(dir, 'trips/a/hero-orig.jpg.part-0a1b2c3d'), 'partial');
    expect((await walkStorageKeys(dir)).size).toBe(0);
  });

  it('picks the widest variant (webp on a tie) to probe a key with no original', async () => {
    await writeVariant('wp/legacy', 640, 'avif');
    await writeVariant('wp/legacy', 1280, 'avif');
    await writeVariant('wp/legacy', 1280, 'webp');
    expect((await walkStorageKeys(dir)).get('wp/legacy')?.largestVariant).toBe('wp/legacy-1280.webp');
  });

  it('returns empty for a missing storage dir instead of throwing', async () => {
    expect((await walkStorageKeys(join(dir, 'nope'))).size).toBe(0);
  });
});

describe('isCompleteSet', () => {
  const full = (w: number) => new Set(variantWidths(w).flatMap((x) => FORMATS.map((f) => `${x}.${f}`)));
  it('requires every prescribed width in every format', () => {
    expect(isCompleteSet(full(1920), 1920)).toBe(true);
    expect(isCompleteSet(full(800), 800)).toBe(true);   // [640, 800] — the intrinsic width itself is a variant
    const short = full(1920); short.delete('1920.avif');
    expect(isCompleteSet(short, 1920)).toBe(false);
    expect(isCompleteSet(full(1280), 1920)).toBe(false); // top-truncated
  });
  it('never accepts an unknown width', () => {
    expect(isCompleteSet(full(640), 0)).toBe(false);
    expect(isCompleteSet(full(640), NaN)).toBe(false);
  });
});

describe('harvestAlt', () => {
  const row = (over: Partial<PostUsageRow>): PostUsageRow => ({
    translationKey: 'p1', locale: 'de', source: 'working', title: 'T',
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
  it('backfills a row for every key on disk, probing real dimensions from the original', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('trips/a/hero', 800);
    await writeJpegOriginal('trips/a/hero', 800);
    const report = await sync(store).run();
    expect(report).toMatchObject({ scanned: 1, inserted: 1, demoted: 0 });
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'ready', width: 800, height: 600 });
  });

  it('marks an originals-only key as processing, not ready — with the original\'s real dimensions', async () => {
    // It has no variants — declaring it ready would let it be published with
    // broken <img> elements, which is exactly what the publish gate prevents.
    // Dims come from the original (the encode path never writes them), so a
    // recovered crashed upload no longer ends up `ready` at 0×0.
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeJpegOriginal('library/2025/crashed', 800);
    await writeOriginal('library/2025/truncated'); // unreadable: still processing, dims unknown
    await sync(store).run();
    expect(await store.get('library/2025/crashed')).toMatchObject({ status: 'processing', width: 800, height: 600 });
    expect(await store.get('library/2025/truncated')).toMatchObject({ status: 'processing', width: 0, height: 0 });
  });

  // #118: one stray variant is not a photo. The srcset asks for every width
  // in variantWidths(intrinsic) × FORMATS; anything less 404s on the live blog.
  it('inserts a partial set as processing when the original exists (re-encode heals it)', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeJpegOriginal('trips/a/hero', 800);
    await writeVariant('trips/a/hero', 640, 'avif'); // crash after the first file
    await sync(store).run();
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'processing', width: 800 });
  });

  // @ai-warning: variants are written in ascending width, so a crash truncates
  // the TOP widths — and {640, 1280} is byte-for-byte a complete set for a
  // 1280-wide photo. Only the original knows the set should reach 1920.
  it('derives the expected set from the original, not the largest surviving variant', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeJpegOriginal('trips/a/hero', 1920);
    await writeSet('trips/a/hero', 1280); // looks complete for 1280
    await sync(store).run();
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'processing', width: 1920 });
  });

  it('inserts a partial set with no original as missing (nothing can re-encode it)', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('wp/legacy', 1280, { skip: ['1280.avif'] });
    await sync(store).run();
    expect(await store.get('wp/legacy')).toMatchObject({ status: 'missing', width: 1280 });
  });

  it('accepts a legacy key with no original when the set is complete for its widest variant', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('wp/legacy', 1280);
    await sync(store).run();
    expect(await store.get('wp/legacy')).toMatchObject({ status: 'ready', width: 1280, height: 960 });
  });

  it('demotes a ready row whose set lost files, and leaves a complete one alone', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('trips/a/hero', 800); await writeJpegOriginal('trips/a/hero', 800);
    await writeSet('trips/b/hero', 800); await writeJpegOriginal('trips/b/hero', 800);
    await writeSet('wp/legacy', 640);
    for (const key of ['trips/a/hero', 'trips/b/hero', 'wp/legacy']) {
      await store.upsert({ key, status: 'ready', width: key === 'wp/legacy' ? 640 : 800, height: 6, origBytes: 0, exif: noExif, uploadedBy: null, title: 'Keep' });
    }
    await rm(join(dir, 'trips/b/hero-800.avif'));   // partial restore lost one file
    await rm(join(dir, 'wp/legacy-640.webp'));
    const report = await sync(store).run();
    expect(report).toMatchObject({ inserted: 0, markedMissing: 0, demoted: 2 });
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'ready' });
    expect(await store.get('trips/b/hero')).toMatchObject({ status: 'processing', title: 'Keep' }); // has an original
    expect(await store.get('wp/legacy')).toMatchObject({ status: 'missing', title: 'Keep' });       // has none
  });

  it('keeps a ready row whose recorded width is stale but whose set is complete for its real width', async () => {
    // A pre-#118 backfill of a crashed upload recorded 0×0; the encode then
    // wrote the full set. The srcset never asks for `-0.webp`, so nothing 404s.
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('trips/a/hero', 800); await writeJpegOriginal('trips/a/hero', 800);
    await store.upsert({ key: 'trips/a/hero', status: 'ready', width: 0, height: 0, origBytes: 0, exif: noExif, uploadedBy: null });
    const report = await sync(store).run();
    expect(report.demoted).toBe(0);
    expect(await store.get('trips/a/hero')).toMatchObject({ status: 'ready' });
  });

  it('harvests alt text for a backfilled key', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('trips/a/hero', 640);
    const src = `${BASE}/trips/a/hero`;
    const report = await sync(store, [{
      translationKey: 'p1', locale: 'de', source: 'working', title: 'T',
      heroImage: { src, width: 1, height: 1, alt: 'Altstadt' }, bodyMarkdown: '', images: {},
    }]).run();
    expect(report.altHarvested).toBe(1);
    expect((await store.get('trips/a/hero'))?.alt).toEqual({ de: 'Altstadt', en: '' });
  });

  it('leaves an existing row alone (never clobbers author-entered metadata)', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeSet('trips/a/hero', 640);
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

  // @ai-warning: the prune used to read ONE page of ready rows, and list()
  // caps pageSize at MAX_PAGE_SIZE (200) — so past 200 photos it silently
  // stopped sweeping and still reported success. Naive pagination is no better:
  // marking a row `missing` drops it out of the `status = 'ready'` filter, so
  // every mutation shifts the rows under the next OFFSET and skips one. This
  // needs MORE than one page and MORE missing rows than fit in a page to fail
  // against either bug.
  it('marks every vanished row missing, past the pageSize cap', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const total = 450; // > 2 × MAX_PAGE_SIZE
    for (let i = 0; i < total; i++) {
      const key = `library/2025/photo-${String(i).padStart(3, '0')}`;
      await store.upsert({ key, status: 'ready', width: 8, height: 6, origBytes: 0, exif: noExif, uploadedBy: null });
    }
    // One survivor with real files on disk; everything else has vanished.
    await writeSet('library/2025/photo-123', 640);

    const report = await sync(store).run();
    expect(report.markedMissing).toBe(total - 1);
    expect(await store.get('library/2025/photo-123')).toMatchObject({ status: 'ready' });
    for (const i of [0, 199, 200, 201, 399, 449]) {
      const key = `library/2025/photo-${String(i).padStart(3, '0')}`;
      expect(await store.get(key)).toMatchObject({ key, status: 'missing' });
    }
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
    await writeSet('trips/a/hero', 640);
    const s = createMediaSync({
      store, storageDir: dir, baseUrl: BASE,
      corpus: async () => { throw new Error('db down'); },
      log: () => {},
    });
    await expect(s.run()).resolves.toMatchObject({ inserted: 1, altHarvested: 0 });
  });
});

describe('createReconciler', () => {
  // The #117 scenario: an upload crashed after storeOriginal and before the
  // row was written (or the DB was restored from an older dump). A rescan
  // that only backfills the row as `processing` strands it — nothing
  // enqueues it, /media/retry skips `processing`, and the publish gate blocks
  // every post referencing it until the next restart.
  it('enqueues an originals-only key discovered by the rescan', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await writeOriginal('library/2025/crashed');
    const encoded: string[] = [];
    const queue = createEncodeQueue({
      store, storageDir: dir, lock: createWorkLock(),
      encodeOne: async (key) => { encoded.push(key); return { bytes: 1 }; },
      log: () => {}, error: () => {},
    });
    const report = await createReconciler({ sync: sync(store), queue }).run();
    expect(report).toMatchObject({ scanned: 1, inserted: 1, recovered: 1 });
    await queue.drain();
    expect(encoded).toEqual(['library/2025/crashed']);
    expect(await store.get('library/2025/crashed')).toMatchObject({ status: 'ready' });
  });

  it('still runs recovery when the sync fails, then re-throws the sync error', async () => {
    let recovered = 0;
    const r = createReconciler({
      sync: { run: async () => { throw new Error('storage unreadable'); } },
      queue: { recover: async () => { recovered++; return 3; } },
    });
    await expect(r.run()).rejects.toThrow('storage unreadable');
    expect(recovered).toBe(1);
  });
});
