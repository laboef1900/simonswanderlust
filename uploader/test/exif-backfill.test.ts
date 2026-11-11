import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { backfillExif, type ExifBackfillReport } from '../src/exif-backfill.js';
import { emptyExposure, emptyMediaExif, type MediaExposure } from '../src/exif.js';
import { memoryMediaStore, type MediaStore, type NewMediaItem } from '../src/media-store.js';

// Pass-through, so the directory listings the backfill makes can be counted
// (the per-run cache is a stated cost bound, not an implementation detail).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const BASE = 'https://img.example';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exif-backfill-'));
  vi.mocked(readdir).mockClear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(rel: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), data);
}

/**
 * An original as a camera wrote it: camera, lens, capture time and GPS beside
 * the exposure settings — everything the backfill must read past.
 */
function original(iso = 400): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 90, g: 120, b: 150 } } })
    .withExif({
      IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD2: {
        DateTimeOriginal: '2026:07:04 18:23:11', LensModel: 'SUMMILUX 1:1.7/28 ASPH.',
        ExposureTime: '1/250', FNumber: '28/10', ISOSpeedRatings: String(iso), FocalLength: '28/1', FocalLengthIn35mmFilm: '35',
      },
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
        GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
      },
    })
    .jpeg().toBuffer();
}
const exposureOf = (iso = 400): MediaExposure => ({ focalLength: 28, focalLength35mm: 35, fNumber: 2.8, iso, exposureTime: 0.004 });

const add = (store: MediaStore, key: string, over: Partial<NewMediaItem> = {}) =>
  store.upsert({ key, status: 'ready', width: 800, height: 600, origBytes: 10, exif: emptyMediaExif(), uploadedBy: null, ...over });

/**
 * Exactly what the backfill is allowed to use. It is typed against these two
 * methods, so handing it nothing else makes "writes no other column" a fact:
 * any other store call would be a TypeError here.
 */
function narrow(store: MediaStore, writes: [string, MediaExposure][] = []): Pick<MediaStore, 'allKeys' | 'setExposure'> {
  return {
    allKeys: () => store.allKeys(),
    setExposure: (key, exposure) => { writes.push([key, exposure]); return store.setExposure(key, exposure); },
  };
}

const counts = (over: Partial<ExifBackfillReport>): ExifBackfillReport => ({
  scanned: 0, updated: 0, unchanged: 0, missingOriginal: 0, ambiguousOriginal: 0, unreadable: 0, invalidKey: 0, ...over,
});

/** Every line the backfill may ever log: a safe key with a fixed reason, or the counts. */
const LOG_LINE = /^backfill-exif: (?:skipped [a-z0-9][a-z0-9/_-]*: (?:missing-original|ambiguous-original|unreadable)|scanned \d+, updated \d+, unchanged \d+, missing original \d+, ambiguous original \d+, unreadable \d+, invalid key \d+)$/;

describe('backfillExif', () => {
  it('fills the exposure settings from each original and reports what it did', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await add(store, 'library/2025/a');
    await put('library/2025/a-orig.jpg', await original(400));
    await add(store, 'library/2025/b');
    await put('library/2025/b-orig.jpg', await original(100));
    // Already holding what its original says (an upload made after #570).
    await add(store, 'library/2025/current', { exif: { ...emptyMediaExif(), ...exposureOf(800) } });
    await put('library/2025/current-orig.jpg', await original(800));
    // An original with no EXIF at all: nothing to store, and nothing stored before.
    await add(store, 'trips/x/plain');
    await put('trips/x/plain-orig.png', await sharp({ create: { width: 8, height: 8, channels: 3, background: '#345' } }).png().toBuffer());
    // A key at the storage root.
    await add(store, 'rootkey');
    await put('rootkey-orig.jpg', await original(200));

    const logs: string[] = [];
    const report = await backfillExif(narrow(store), dir, (message) => logs.push(message));
    expect(report).toEqual(counts({ scanned: 5, updated: 3, unchanged: 2 }));
    expect((await store.get('library/2025/a'))?.exif).toEqual({ ...emptyMediaExif(), ...exposureOf(400) });
    expect((await store.get('library/2025/b'))?.exif).toEqual({ ...emptyMediaExif(), ...exposureOf(100) });
    expect((await store.get('library/2025/current'))?.exif).toEqual({ ...emptyMediaExif(), ...exposureOf(800) });
    expect((await store.get('trips/x/plain'))?.exif).toEqual(emptyMediaExif());
    expect((await store.get('rootkey'))?.exif).toEqual({ ...emptyMediaExif(), ...exposureOf(200) });
    expect(logs).toEqual(['backfill-exif: scanned 5, updated 3, unchanged 2, missing original 0, ambiguous original 0, unreadable 0, invalid key 0']);
  });

  it('is idempotent: a second run reports updated 0 and changes nothing', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    for (const [key, iso] of [['library/2025/a', 400], ['library/2025/b', 100]] as const) {
      await add(store, key);
      await put(`${key}-orig.jpg`, await original(iso));
    }
    expect(await backfillExif(narrow(store), dir, () => {})).toEqual(counts({ scanned: 2, updated: 2 }));
    const after = [await store.get('library/2025/a'), await store.get('library/2025/b')];
    expect(await backfillExif(narrow(store), dir, () => {})).toEqual(counts({ scanned: 2, unchanged: 2 }));
    expect([await store.get('library/2025/a'), await store.get('library/2025/b')]).toEqual(after);
  });

  // The original is the camera's truth, but the row is the author's: a photo
  // whose stored camera, lens, capture time or GPS differ (edited, redacted,
  // imported) must keep them. Only the five exposure fields may move.
  it('passes on only the five exposure fields, leaving a row that disagrees with its original untouched elsewhere', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await add(store, 'library/2025/a', {
      folder: 'Island', title: 'Sunrise', alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' }, tags: ['dawn'],
      uploadedBy: 'user-1',
      exif: { ...emptyMediaExif(), takenAt: new Date('2020-01-01T00:00:00Z'), camera: 'Stored camera', lens: 'Stored lens', lat: 1.5, lng: 2.5 },
    });
    await store.setStatus('library/2025/a', 'failed', 'encode_failed');
    await store.setVariantBytes('library/2025/a', 4242);
    await put('library/2025/a-orig.jpg', await original());
    const before = await store.get('library/2025/a');

    const writes: [string, MediaExposure][] = [];
    expect(await backfillExif(narrow(store, writes), dir, () => {})).toEqual(counts({ scanned: 1, updated: 1 }));
    // Exactly one write, carrying exactly the five fields — no camera, lens, date or coordinate.
    expect(writes).toEqual([['library/2025/a', exposureOf()]]);
    expect(Object.keys(writes[0]![1]).sort()).toEqual(Object.keys(emptyExposure()).sort());
    const after = await store.get('library/2025/a');
    expect(after?.exif).toEqual({ ...before?.exif, ...exposureOf() });
    expect({ ...after, exif: { ...after?.exif, ...emptyExposure() } }).toEqual(before);
  });

  it('counts and names missing, ambiguous and unreadable originals, and carries on', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const seeded = { ...emptyMediaExif(), iso: 64 }; // proves a skipped row is left as it is
    // Missing: variants only (a legacy import), a directory that does not exist,
    // a sibling's original, an "original" that is a directory, and a symlink —
    // never followed, so the file it points at is not this key's original.
    await add(store, 'legacy/wp/photo', { exif: seeded });
    await put('legacy/wp/photo-640.webp', 'variant');
    await add(store, 'nowhere/at/all');
    await add(store, 'legacy/wp/hero');
    await put('legacy/wp/hero-b-orig.jpg', await original());
    await add(store, 'legacy/wp/folder');
    await mkdir(join(dir, 'legacy/wp/folder-orig.jpg'));
    await add(store, 'legacy/wp/linked');
    await put('elsewhere/real-orig.jpg', await original());
    await symlink(join(dir, 'elsewhere/real-orig.jpg'), join(dir, 'legacy/wp/linked-orig.jpg'));
    // Ambiguous: two originals for one key — skipped rather than guessed.
    await add(store, 'library/2025/twice', { exif: seeded });
    await put('library/2025/twice-orig.jpg', await original(100));
    await put('library/2025/twice-orig.png', await original(200));
    // Unreadable: bytes that are not an image, and a directory that cannot be listed.
    await add(store, 'library/2025/broken', { exif: seeded });
    await put('library/2025/broken-orig.jpg', 'not an image');
    await add(store, 'blocked/x/hero');
    await put('blocked', 'a file where the directory should be');
    // And one healthy photo among them.
    await add(store, 'library/2025/fine');
    await put('library/2025/fine-orig.jpg', await original());

    const logs: string[] = [];
    const report = await backfillExif(narrow(store), dir, (message) => logs.push(message));
    expect(report).toEqual(counts({ scanned: 9, updated: 1, missingOriginal: 5, ambiguousOriginal: 1, unreadable: 2 }));
    expect(logs).toEqual([
      'backfill-exif: skipped blocked/x/hero: unreadable',
      'backfill-exif: skipped legacy/wp/folder: missing-original',
      'backfill-exif: skipped legacy/wp/hero: missing-original',
      'backfill-exif: skipped legacy/wp/linked: missing-original',
      'backfill-exif: skipped legacy/wp/photo: missing-original',
      'backfill-exif: skipped library/2025/broken: unreadable',
      'backfill-exif: skipped library/2025/twice: ambiguous-original',
      'backfill-exif: skipped nowhere/at/all: missing-original',
      'backfill-exif: scanned 9, updated 1, unchanged 0, missing original 5, ambiguous original 1, unreadable 2, invalid key 0',
    ]);
    expect((await store.get('library/2025/fine'))?.exif).toEqual({ ...emptyMediaExif(), ...exposureOf() });
    for (const key of ['legacy/wp/photo', 'library/2025/twice', 'library/2025/broken']) {
      expect((await store.get(key))?.exif).toEqual(seeded);
    }
    for (const key of ['legacy/wp/hero', 'legacy/wp/linked', 'legacy/wp/folder', 'blocked/x/hero', 'nowhere/at/all']) {
      expect((await store.get(key))?.exif).toEqual(emptyMediaExif());
    }
  });

  it('counts an unsafe stored key without echoing it or reading anything for it', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const storage = join(dir, 'storage');
    await mkdir(storage);
    // A readable original sits exactly where the traversing key points.
    await put('outside/secret-orig.jpg', await original());
    const unsafe = ['../outside/secret', 'Evil', 'a.b', `long/${'k'.repeat(5000)}`];
    for (const key of unsafe) await add(store, key);

    const logs: string[] = [];
    const writes: [string, MediaExposure][] = [];
    const report = await backfillExif(narrow(store, writes), storage, (message) => logs.push(message));
    expect(report).toEqual(counts({ scanned: 4, invalidKey: 4 }));
    expect(writes).toEqual([]);
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    // Counted, never named: not one of the keys reaches the log, whatever its size.
    expect(logs).toEqual(['backfill-exif: scanned 4, updated 0, unchanged 0, missing original 0, ambiguous original 0, unreadable 0, invalid key 4']);
    for (const key of unsafe) expect((await store.get(key))?.exif).toEqual(emptyMediaExif());
  });

  it('lists each directory once per run, however many keys share it', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    for (let i = 0; i < 6; i++) {
      await add(store, `library/2025/photo-${i}`);
      if (i % 2 === 0) await put(`library/2025/photo-${i}-orig.jpg`, await original(100 + i));
    }
    await add(store, 'library/2024/old');
    await add(store, 'gone/a');
    await add(store, 'gone/b');
    vi.mocked(readdir).mockClear();
    const report = await backfillExif(narrow(store), dir, () => {});
    expect(report).toEqual(counts({ scanned: 9, updated: 3, missingOriginal: 6 }));
    const listed = vi.mocked(readdir).mock.calls.map(([path]) => String(path)).sort();
    // Also for a directory that does not exist: its absence is remembered too.
    expect(listed).toEqual([join(dir, 'gone'), join(dir, 'library/2024'), join(dir, 'library/2025')]);
    // A new run reads the disk again: the cache does not outlive the run.
    await put('library/2025/photo-1-orig.jpg', await original(101));
    expect(await backfillExif(narrow(store), dir, () => {})).toEqual(counts({ scanned: 9, updated: 1, unchanged: 3, missingOriginal: 5 }));
  });

  // Each row is one independent write, so a run that dies half-way (a dropped
  // connection, ^C) leaves finished rows correct and the rest as they were.
  it('converges when an interrupted run is repeated', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const keys = ['library/2025/a', 'library/2025/b', 'library/2025/c', 'library/2025/d'];
    for (const [i, key] of keys.entries()) {
      await add(store, key);
      await put(`${key}-orig.jpg`, await original(100 * (i + 1)));
    }
    let writes = 0;
    const dying: Pick<MediaStore, 'allKeys' | 'setExposure'> = {
      allKeys: () => store.allKeys(),
      setExposure: async (key, exposure) => {
        if (++writes === 3) throw new Error('connection terminated unexpectedly');
        return store.setExposure(key, exposure);
      },
    };
    const logs: string[] = [];
    await expect(backfillExif(dying, dir, (message) => logs.push(message))).rejects.toThrow('connection terminated unexpectedly');
    expect(logs).toEqual([]); // no counts line for a run that did not finish
    const isoOf = async () => Promise.all(keys.map(async (key) => (await store.get(key))?.exif.iso));
    expect(await isoOf()).toEqual([100, 200, null, null]);

    expect(await backfillExif(narrow(store), dir, () => {})).toEqual(counts({ scanned: 4, updated: 2, unchanged: 2 }));
    expect(await isoOf()).toEqual([100, 200, 300, 400]);
    expect(await backfillExif(narrow(store), dir, () => {})).toEqual(counts({ scanned: 4, unchanged: 4 }));
  });

  // The originals are private and carry GPS. Whatever happens to a file, a log
  // line is a storage key with a fixed reason, or the counts.
  it('logs keys, fixed reasons and counts only: no metadata value, coordinate, path or libvips message', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await add(store, 'library/2025/fine');
    await put('library/2025/fine-orig.jpg', await original());
    await add(store, 'library/2025/broken');
    await put('library/2025/broken-orig.jpg', 'not an image');
    await add(store, 'library/2025/twice');
    await put('library/2025/twice-orig.jpg', await original());
    await put('library/2025/twice-orig.jpeg', await original());
    await add(store, 'library/2025/legacy');
    await add(store, 'blocked/x/hero');
    await put('blocked', 'file');
    await add(store, 'Evil-63.0759');

    const logs: string[] = [];
    await backfillExif(narrow(store), dir, (message) => logs.push(message));
    expect(logs).toHaveLength(5);
    for (const line of logs) expect(line).toMatch(LOG_LINE);
    const text = logs.join('\n');
    for (const leak of [
      dir, tmpdir(), '-orig.', '.jpg', '.jpeg',                  // filesystem paths and file names
      'Leica', 'LEICA', 'SUMMILUX', '2026', '18:23',             // camera, lens, capture time
      '63.07', '10.38', '3312', '1944', 'Evil',                  // coordinates, and the unsafe key
      '0.004', '2.8', '400', '1/250', '28',                      // exposure values
      'Input file', 'unsupported image format', 'Vips', 'ENOTDIR', 'ENOENT', // libvips and fs errors
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});
