import { describe, expect, it } from 'vitest';
import {
  assertSafeFolder, folderAncestry, libraryKey, likePattern, memoryMediaStore, MediaStoreError,
  normalizeTags, pageSizeOf, redactForNonAdmin, sortColumn, thumbWidth,
  MAX_PAGE_SIZE, type MediaStore,
} from '../src/media-store.js';
import { emptyExposure, emptyMediaExif } from '../src/exif.js';

const BASE = 'https://img.simonswanderlust.com';
const noExif = emptyMediaExif();

function store(): MediaStore {
  return memoryMediaStore({ baseUrl: BASE });
}
const add = (s: MediaStore, key: string, over: Record<string, unknown> = {}) =>
  s.upsert({ key, status: 'ready', width: 800, height: 600, origBytes: 10, exif: noExif, uploadedBy: null, ...over });

describe('assertSafeFolder', () => {
  it('accepts human folder names including non-ASCII', () => {
    for (const p of ['', 'Island', 'Patagonien Süd', 'Iceland 2024', 'a/b/c', 'trip_1', 'v.2']) {
      expect(() => assertSafeFolder(p)).not.toThrow();
    }
  });

  // @ai-warning: `%` is a SQL LIKE wildcard — a folder literally named `%`
  // would make a LIKE-based subtree move rewrite the ENTIRE library.
  it('rejects %, traversal, control chars, markup and over-deep nesting', () => {
    for (const p of ['%', 'a%b', '..', 'a/../b', '/leading', 'trailing/', 'a//b',
      'a‮b', 'a​b', '<b>', 'a?b', 'a#b', 'a/b/c/d/e/f/g']) {
      expect(() => assertSafeFolder(p)).toThrow(MediaStoreError);
    }
  });

  it('allows `_` — it is an ordinary folder character and never reaches a LIKE pattern', () => {
    // Subtree matching uses starts_with(), and free-text search escapes its own
    // wildcards. If that ever changes, `_` has to be excluded here.
    expect(() => assertSafeFolder('trip_1')).not.toThrow();
  });

  it('rejects a non-NFC path and an over-long one', () => {
    expect(() => assertSafeFolder('Á'.repeat(3))).toThrow(/NFC/);
    expect(() => assertSafeFolder('a'.repeat(201))).toThrow(/too long/);
  });
});

describe('query-parameter safety', () => {
  // sort/order are SQL identifiers and keywords, which pg cannot parameterize,
  // and the TS union is erased at runtime while the value arrives from a query
  // string — so they must go through an allow-list map.
  it('maps a known sort and falls back for anything else (never reaching SQL)', () => {
    expect(sortColumn('taken')).toBe('taken_at');
    expect(sortColumn('title')).toBe('title');
    expect(sortColumn('key')).toBe('key');
    for (const bad of ['uploaded_at; DROP TABLE media', 'constructor', 'toString', '', undefined, 42]) {
      expect(sortColumn(bad)).toBe('uploaded_at');
    }
  });

  it('caps pageSize — an unbounded LIMIT materializes the table per request', () => {
    expect(pageSizeOf(10)).toBe(10);
    expect(pageSizeOf(10_000)).toBe(MAX_PAGE_SIZE);
    expect(pageSizeOf(0)).toBe(50);
    expect(pageSizeOf('abc')).toBe(50);
    expect(pageSizeOf(-5)).toBe(50);
  });

  it('escapes ILIKE wildcards so a bare _ or % is not a wildcard', () => {
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('tags', () => {
  it('trims, de-duplicates and caps count and length', () => {
    expect(normalizeTags([' island ', 'island', '', '  '])).toEqual(['island']);
    expect(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(30);
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(40);
    expect(normalizeTags('nope')).toEqual([]);
    expect(normalizeTags([1, null, 'ok'])).toEqual(['ok']);
  });
});

describe('thumbWidth', () => {
  // variantWidths() never upscales, so a photo narrower than 640 has no -640.
  it('picks 640 at or above 640 and the intrinsic width below it', () => {
    expect(thumbWidth(3000)).toBe(640);
    expect(thumbWidth(640)).toBe(640);
    expect(thumbWidth(500)).toBe(500);
  });
  it('returns null for an unknown width', () => {
    expect(thumbWidth(0)).toBeNull();
    expect(thumbWidth(-1)).toBeNull();
    expect(thumbWidth(1.5)).toBeNull();
  });
});

describe('folderAncestry', () => {
  it('lists every ancestor root-first', () => {
    expect(folderAncestry('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(folderAncestry('')).toEqual([]);
  });
});

describe('libraryKey', () => {
  it('slugifies a camera filename that KEY_RE would otherwise reject', () => {
    expect(libraryKey('L1002345.JPG', new Date('2025-06-01T00:00:00Z'))).toBe('library/2025/l1002345');
    expect(libraryKey('Ålesund Fjord.jpeg', new Date('2025-06-01T00:00:00Z'))).toBe('library/2025/alesund-fjord');
  });
  it('falls back to "photo" when nothing survives slugification', () => {
    expect(libraryKey('☃☃☃.jpg', new Date('2024-01-01T00:00:00Z'))).toBe('library/2024/photo');
    expect(libraryKey('', new Date('2024-01-01T00:00:00Z'))).toBe('library/2024/photo');
  });
});

describe('redactForNonAdmin', () => {
  it('drops GPS and uploadedBy but keeps camera metadata and the exposure settings', () => {
    const exposure = { focalLength: 28, focalLength35mm: 28, fNumber: 1.7, iso: 200, exposureTime: 0.004 };
    const item = {
      key: 'k', src: 's', thumbSrc: null, fullSrc: 'https://img.example/k-1.webp', folder: '', title: '',
      alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [],
      width: 1, height: 1, origBytes: 0, variantBytes: 0,
      status: 'ready' as const, error: null,
      exif: { takenAt: null, camera: 'Leica Q2', lens: 'Summilux', lat: 63.4, lng: 10.4, ...exposure },
      uploadedAt: new Date(), uploadedBy: 'u1',
    };
    const out = redactForNonAdmin(item);
    // #570: the exposure settings carry no location, so authors keep them.
    expect(out.exif).toEqual({ takenAt: null, camera: 'Leica Q2', lens: 'Summilux', lat: null, lng: null, ...exposure });
    expect(out.uploadedBy).toBeNull();
    expect(out.fullSrc).toBe(item.fullSrc);
    expect(item.exif.lat).toBe(63.4); // input untouched
  });
});

describe('memoryMediaStore', () => {
  it('derives src and thumbSrc, and withholds thumbSrc until ready', async () => {
    const s = store();
    const processing = await add(s, 'library/2025/a', { status: 'processing' });
    expect(processing.src).toBe(`${BASE}/library/2025/a`);
    // A photo still encoding has no variant files — offering a URL that 404s
    // would just show broken images in the grid.
    expect(processing.thumbSrc).toBeNull();
    await s.setStatus('library/2025/a', 'ready');
    expect((await s.get('library/2025/a'))?.thumbSrc).toBe(`${BASE}/library/2025/a-640.webp`);
  });

  it('derives JPEG thumbnails and preserves the snapped encoding profile', async () => {
    const s = store();
    await add(s, 'library/2026/jpeg', {
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 81, avifQuality: 61 },
    });
    expect(await s.get('library/2026/jpeg')).toMatchObject({
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 81, avifQuality: 61 },
      thumbSrc: `${BASE}/library/2026/jpeg-640.jpeg`,
    });
    const modern = await add(s, 'library/2026/modern');
    expect(modern).not.toHaveProperty('format');
    expect(modern).not.toHaveProperty('encoding');
    expect(modern.thumbSrc).toBe(`${BASE}/library/2026/modern-640.webp`);
  });

  // #570: what the fullscreen viewer shows. variantWidths() always appends the
  // intrinsic width, so `-${width}` is the largest variant that exists.
  it('derives fullSrc as the intrinsic-width variant, per status and format', async () => {
    const s = store();
    for (const status of ['processing', 'failed', 'missing'] as const) {
      expect((await add(s, `not-ready-${status}`, { status, width: 3000 })).fullSrc).toBeNull();
    }
    expect((await add(s, 'library/2026/wide', { width: 3000, height: 2000 })).fullSrc)
      .toBe(`${BASE}/library/2026/wide-3000.webp`);
    expect((await add(s, 'library/2026/jpeg', { width: 3000, format: 'jpeg', encoding: { convertJpeg: false } })).fullSrc)
      .toBe(`${BASE}/library/2026/jpeg-3000.jpeg`);
    // Narrower than the smallest standard width: one file is both thumbnail and full size.
    const small = await add(s, 'small', { width: 500 });
    expect(small.fullSrc).toBe(`${BASE}/small-500.webp`);
    expect(small.thumbSrc).toBe(small.fullSrc);
    // Unknown width (an unreadable probe): no URL, like thumbSrc — never `-0.webp`.
    expect(await add(s, 'unknown', { width: 0, height: 0 })).toMatchObject({ fullSrc: null, thumbSrc: null });
    // It appears with the status change, on get and in listings alike.
    await s.setStatus('not-ready-processing', 'ready');
    expect((await s.get('not-ready-processing'))?.fullSrc).toBe(`${BASE}/not-ready-processing-3000.webp`);
    const listed = (await s.list({ q: 'not-ready' })).items.map((i) => [i.key, i.fullSrc]);
    expect(listed.sort()).toEqual([
      ['not-ready-failed', null], ['not-ready-missing', null],
      ['not-ready-processing', `${BASE}/not-ready-processing-3000.webp`],
    ]);
  });

  describe('exposure settings (#570)', () => {
    const exposure = { focalLength: 4.3, focalLength35mm: 24, fNumber: 1.8, iso: 125, exposureTime: 1 / 500 };

    it('round-trips the five numbers through upsert, get and list', async () => {
      const s = store();
      const saved = await add(s, 'k', { exif: { ...emptyMediaExif(), camera: 'Pixel', ...exposure } });
      expect(saved.exif).toEqual({ ...emptyMediaExif(), camera: 'Pixel', ...exposure });
      expect((await s.get('k'))?.exif).toEqual(saved.exif);
      expect((await s.list({})).items[0]?.exif).toEqual(saved.exif);
      expect((await add(s, 'bare')).exif).toEqual(emptyMediaExif());
    });

    // pg's ON CONFLICT takes EXCLUDED.* for these, like taken_at: the incoming
    // row wins, including when it carries nothing.
    it('a re-upsert takes the incoming exposure values, matching the pg ON CONFLICT rule', async () => {
      const s = store();
      await add(s, 'k', { exif: { ...emptyMediaExif(), ...exposure } });
      expect((await add(s, 'k', { exif: { ...emptyMediaExif(), iso: 800 } })).exif).toEqual({ ...emptyMediaExif(), iso: 800 });
      expect((await add(s, 'k')).exif).toEqual(emptyMediaExif());
    });

    // The store is the write point: a caller handing over a malformed number
    // must not be able to store it (Postgres `double precision` accepts NaN).
    it('normalizes NaN, infinite, out-of-range and fractional-integer values on upsert', async () => {
      const s = store();
      const saved = await add(s, 'k', {
        exif: {
          ...emptyMediaExif(), lens: 'kept',
          focalLength: Number.NaN, focalLength35mm: 10_001, fNumber: Number.POSITIVE_INFINITY, iso: 0, exposureTime: -1,
        },
      });
      expect(saved.exif).toEqual({ ...emptyMediaExif(), lens: 'kept' });
      const rounded = await add(s, 'rounded', { exif: { ...emptyMediaExif(), focalLength35mm: 23.6, iso: 100.4 } });
      expect(rounded.exif).toMatchObject({ focalLength35mm: 24, iso: 100 });
      // A caller that omits the fields altogether (a JS caller, an old fixture) stores nulls.
      const partial = await add(s, 'partial', { exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null } });
      expect(partial.exif).toEqual(emptyMediaExif());
    });

    it('setExposure writes only the five fields and reports whether a stored value changed', async () => {
      const s = store();
      await add(s, 'k', {
        folder: 'Island', title: 'Sunrise', alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' }, tags: ['dawn'],
        uploadedBy: 'u1',
        exif: { ...emptyMediaExif(), takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'LEICA Q2', lens: 'Summilux', lat: 63.4, lng: 10.4 },
      });
      await s.setStatus('k', 'failed', 'encode_failed');
      await s.setVariantBytes('k', 4242);
      const before = await s.get('k');

      expect(await s.setExposure('k', exposure)).toBe(true);
      const after = await s.get('k');
      expect(after?.exif).toEqual({ ...before?.exif, ...exposure });
      // Nothing else moved: not the status, the text, the camera or the GPS.
      expect({ ...after, exif: { ...after?.exif, ...emptyExposure() } }).toEqual(before);

      // An identical second write is a no-op — what makes the backfill idempotent.
      expect(await s.setExposure('k', { ...exposure })).toBe(false);
      // One changed field is a change; so is clearing a value.
      expect(await s.setExposure('k', { ...exposure, iso: 200 })).toBe(true);
      expect(await s.setExposure('k', { ...exposure, iso: null })).toBe(true);
      expect(await s.setExposure('k', { ...exposure, iso: null })).toBe(false);
      expect((await s.get('k'))?.exif).toEqual({ ...before?.exif, ...exposure, iso: null });
      // All-null onto all-null changes nothing either.
      await add(s, 'bare');
      expect(await s.setExposure('bare', emptyExposure())).toBe(false);
    });

    it('setExposure normalizes what it is given, and compares after normalizing', async () => {
      const s = store();
      await add(s, 'k');
      expect(await s.setExposure('k', {
        focalLength: Number.NaN, focalLength35mm: 23.6, fNumber: 513, iso: 100.4, exposureTime: Number.POSITIVE_INFINITY,
      })).toBe(true);
      expect((await s.get('k'))?.exif).toEqual({ ...emptyMediaExif(), focalLength35mm: 24, iso: 100 });
      // Different raw input, same stored values: unchanged.
      expect(await s.setExposure('k', { focalLength: 0, focalLength35mm: 24.2, fNumber: null, iso: 99.6, exposureTime: 0 })).toBe(false);
      // Nothing storable arrives for a row that has nothing: unchanged, never NaN in the row.
      await add(s, 'bare');
      expect(await s.setExposure('bare', { ...emptyExposure(), fNumber: Number.NaN })).toBe(false);
      expect((await s.get('bare'))?.exif).toEqual(emptyMediaExif());
    });

    it('setExposure resolves false for an unknown key and creates nothing', async () => {
      const s = store();
      expect(await s.setExposure('ghost', exposure)).toBe(false);
      expect(await s.get('ghost')).toBeNull();
      expect(await s.allKeys()).toEqual([]);
    });
  });

  it('does not leak mutable encoding objects through upsert or get', async () => {
    const s = store();
    const encoding = { convertJpeg: false, webpQuality: 80, avifQuality: 60 };
    await add(s, 'profile-clone', { format: 'jpeg', encoding });
    encoding.webpQuality = 1;
    const first = await s.get('profile-clone');
    expect(first?.encoding?.webpQuality).toBe(80);
    if (first?.encoding) first.encoding.webpQuality = 2;
    expect((await s.get('profile-clone'))?.encoding?.webpQuality).toBe(80);
  });

  it('rejects malformed persisted format/profile values at the memory-store boundary', async () => {
    const s = store();
    await expect(add(s, 'bad-format', { format: 'webp' })).rejects.toThrow(/format/);
    await expect(add(s, 'missing-profile', { format: 'jpeg' })).rejects.toThrow(/persisted conversion profile/);
    await expect(add(s, 'bad-profile', { encoding: { webpQuality: 0 } })).rejects.toThrow(/encoding profile/);
  });

  it('filters by folder, status, tag and free text', async () => {
    const s = store();
    await add(s, 'k1', { folder: 'Island', title: 'Sunrise', tags: ['dawn'] });
    await add(s, 'k2', { folder: 'Island/Sued', title: 'Pass' });
    await add(s, 'k3', { folder: '', status: 'failed' });
    expect((await s.list({ folder: 'Island' })).items.map((i) => i.key)).toEqual(['k1']);
    expect((await s.list({ folder: 'Island', recursive: true })).items.map((i) => i.key).sort()).toEqual(['k1', 'k2']);
    expect((await s.list({ status: 'failed' })).items.map((i) => i.key)).toEqual(['k3']);
    expect((await s.list({ tag: 'dawn' })).items.map((i) => i.key)).toEqual(['k1']);
    expect((await s.list({ q: 'sunris' })).items.map((i) => i.key)).toEqual(['k1']);
  });

  it('alt: missing keeps only photos whose alt text is blank in both languages', async () => {
    const s = store();
    await add(s, 'none');
    // Whitespace-only text describes nothing: it counts as missing.
    await add(s, 'blank', { alt: { de: '  ', en: ' ' } });
    await add(s, 'de-only', { alt: { de: 'Fjord im Morgenlicht', en: '' } });
    await add(s, 'en-only', { alt: { de: '', en: 'Fjord at dawn' } });
    await add(s, 'both', { alt: { de: 'Fjord', en: 'Fjord' } });
    await add(s, 'encoding', { status: 'processing' });
    expect((await s.list({ alt: 'missing' })).items.map((i) => i.key).sort()).toEqual(['blank', 'encoding', 'none']);
    // Combined with the other filters, the way GET /media counts ready photos.
    expect((await s.list({ alt: 'missing', status: 'ready' })).total).toBe(2);
    expect((await s.list({ alt: 'missing', q: 'blank' })).items.map((i) => i.key)).toEqual(['blank']);
    expect((await s.list({})).total).toBe(6);
  });

  it('paginates and reports the unpaginated total', async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await add(s, `k${i}`);
    const page = await s.list({ page: 2, pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('sorts by the allow-listed column and falls back for an unknown one', async () => {
    const s = store();
    await add(s, 'b', { title: 'Beta' });
    await add(s, 'a', { title: 'Alpha' });
    expect((await s.list({ sort: 'title', order: 'asc' })).items.map((i) => i.title)).toEqual(['Alpha', 'Beta']);
    expect((await s.list({ sort: 'key', order: 'asc' })).items.map((i) => i.key)).toEqual(['a', 'b']);
    // Unknown sort must not throw or reach SQL — it falls back to 'uploaded'.
    await expect(s.list({ sort: 'nonsense' as never })).resolves.toBeDefined();
  });

  it('upsert keeps existing text when a re-upload omits it', async () => {
    const s = store();
    await add(s, 'k', { title: 'Kept', alt: { de: 'DE', en: 'EN' } });
    const again = await add(s, 'k', { status: 'processing' });
    expect(again).toMatchObject({ title: 'Kept', alt: { de: 'DE', en: 'EN' }, status: 'processing' });
  });

  // @ai-warning: pgMediaStore's ON CONFLICT clause keeps stored text when the
  // INCOMING value is empty (`CASE WHEN EXCLUDED.title = '' THEN media.title`),
  // not when it is absent. A memory store written with `?? existing` agrees on
  // the omitted case above and disagrees here — and since most unit tests run
  // against the memory store, that divergence would pass CI unnoticed.
  it('upsert keeps existing text when a re-upload sends it EMPTY, matching the pg ON CONFLICT rule', async () => {
    const s = store();
    await add(s, 'k', { title: 'Kept', alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' }, tags: ['t'] });
    const again = await add(s, 'k', { title: '', alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [] });
    expect(again).toMatchObject({
      title: 'Kept', alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' }, tags: ['t'],
    });
  });

  it('upsert still takes a non-empty replacement, and always takes status/dimensions', async () => {
    const s = store();
    await add(s, 'k', { title: 'Old', tags: ['a'] });
    const again = await add(s, 'k', { title: 'New', tags: ['b'], status: 'failed', width: 10, height: 20 });
    expect(again).toMatchObject({ title: 'New', tags: ['b'], status: 'failed', width: 10, height: 20 });
  });

  // pg's ON CONFLICT clause never lists uploaded_by, so the first uploader
  // stays — even after the users FK has nulled it. The memory store used to
  // let a re-upload claim the row (#135).
  it('upsert keeps the first uploader, matching the pg ON CONFLICT rule', async () => {
    const s = store();
    await add(s, 'k', { uploadedBy: 'first' });
    expect((await add(s, 'k', { uploadedBy: 'second' })).uploadedBy).toBe('first');
    await add(s, 'nulled', { uploadedBy: null });
    expect((await add(s, 'nulled', { uploadedBy: 'later' })).uploadedBy).toBeNull();
  });

  it('patch edits metadata and 404s for an unknown key', async () => {
    const s = store();
    await add(s, 'k');
    const patched = await s.patch('k', { title: 'T', caption: { de: 'C' }, tags: ['a'] });
    expect(patched).toMatchObject({ title: 'T', caption: { de: 'C', en: '' }, tags: ['a'] });
    await expect(s.patch('ghost', { title: 'x' })).rejects.toThrow(MediaStoreError);
  });

  // Postgres `text` rejects a NUL byte; before #133 this was a 500 only the
  // pg store could produce, so the unit suite never saw it.
  it('strips NUL and other control/format characters from title, alt and caption', async () => {
    const s = store();
    await add(s, 'k', { title: 'a\u0000b', alt: { de: 'x\u202Ey', en: 'p\u200Dq' }, caption: { de: 'c\u001Fd', en: 'ok' } });
    expect(await s.get('k')).toMatchObject({ title: 'ab', alt: { de: 'xy', en: 'pq' }, caption: { de: 'cd', en: 'ok' } });
    const patched = await s.patch('k', { title: 'n\u0000\u007Fu' });
    expect(patched.title).toBe('nu');
  });

  it('notReadyKeys returns only non-ready keys and ignores unknown ones', async () => {
    // Unknown keys must NOT block publishing — WordPress-imported and legacy
    // files predate the library and exist on disk perfectly well.
    const s = store();
    await add(s, 'ready-key');
    await add(s, 'busy-key', { status: 'processing' });
    await add(s, 'bad-key', { status: 'failed' });
    const out = await s.notReadyKeys(['ready-key', 'busy-key', 'bad-key', 'never-heard-of-it']);
    expect([...out].sort()).toEqual(['bad-key', 'busy-key']);
  });

  it('descriptions returns only localized alt/caption for known keys, blanks included', async () => {
    const s = store();
    await add(s, 'lib', { title: 'Label', alt: { de: 'A', en: 'B' }, caption: { de: 'C', en: '' } });
    await add(s, 'bare');
    const out = await s.descriptions(['lib', 'bare', 'never-heard-of-it']);
    expect([...out]).toEqual([
      ['lib', { alt: { de: 'A', en: 'B' }, caption: { de: 'C', en: '' } }],
      ['bare', { alt: { de: '', en: '' }, caption: { de: '', en: '' } }],
    ]);
    expect((await s.descriptions([])).size).toBe(0);
  });

  it('setStatus clears the error when leaving failed', async () => {
    const s = store();
    await add(s, 'k');
    await s.setStatus('k', 'failed', 'decode_failed');
    expect((await s.get('k'))?.error).toBe('decode_failed');
    await s.setStatus('k', 'ready');
    expect((await s.get('k'))?.error).toBeNull();
  });

  // #348: the rollback of a refused enqueue must never undo a settled row.
  it('setStatusIfProcessing writes only while the row is still processing', async () => {
    const s = store();
    await add(s, 'k', { status: 'processing' });
    expect(await s.setStatusIfProcessing('k', 'failed', 'queue_full')).toBe(true);
    expect(await s.get('k')).toMatchObject({ status: 'failed', error: 'queue_full' });
    expect(await s.setStatusIfProcessing('k', 'missing')).toBe(false);
    await s.setStatus('k', 'ready');
    expect(await s.setStatusIfProcessing('k', 'failed', 'queue_full')).toBe(false);
    expect(await s.get('k')).toMatchObject({ status: 'ready', error: null });
    expect(await s.setStatusIfProcessing('ghost', 'failed', 'queue_full')).toBe(false);
  });

  // This is the query encodeQueue.recover() re-seeds the backlog from — the
  // only reader of `status = 'processing'`, since claimNextProcessing() (which
  // duplicated it, unused, on both stores) was removed.
  it('lists processing rows oldest-first for queue recovery', async () => {
    const s = store();
    expect((await s.list({ status: 'processing' })).items).toEqual([]);
    await add(s, 'k1', { status: 'processing' });
    await add(s, 'k2', { status: 'ready' });
    const { items, total } = await s.list({ status: 'processing', sort: 'uploaded', order: 'asc' });
    expect(items.map((i) => i.key)).toEqual(['k1']);
    expect(total).toBe(1);
  });
});

describe('memoryMediaStore — folders', () => {
  it('creates a folder and its ancestors', async () => {
    const s = store();
    await s.createFolder('a/b/c');
    expect(await s.folders()).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('renames exact-match plus subtree, never a same-prefix sibling', async () => {
    const s = store();
    await add(s, 'k1', { folder: 'Iceland' });
    await add(s, 'k2', { folder: 'Iceland/South' });
    await add(s, 'k3', { folder: 'Iceland 2024' });   // NOT a child
    const moved = await s.renameFolder('Iceland', 'Island');
    expect(moved).toBe(2);
    expect((await s.get('k1'))?.folder).toBe('Island');
    expect((await s.get('k2'))?.folder).toBe('Island/South');
    expect((await s.get('k3'))?.folder).toBe('Iceland 2024');
  });

  // @ai-warning: the regression this guards. With a LIKE-based subtree match,
  // a folder literally named `%` moves the ENTIRE library on rename.
  it('a folder named "%" cannot mass-move the library — it is rejected outright', async () => {
    const s = store();
    await add(s, 'k1', { folder: 'Iceland' });
    await expect(s.renameFolder('%', 'x')).rejects.toThrow(MediaStoreError);
    await expect(s.createFolder('%')).rejects.toThrow(MediaStoreError);
    expect((await s.get('k1'))?.folder).toBe('Iceland');
  });

  it('409s on renaming onto an existing folder, and refuses to nest a folder in itself', async () => {
    const s = store();
    await s.createFolder('a');
    await s.createFolder('b');
    await expect(s.renameFolder('a', 'b')).rejects.toMatchObject({ code: 'exists' });
    await expect(s.renameFolder('a', 'a/child')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to delete a non-empty folder (photos or child folders)', async () => {
    const s = store();
    await add(s, 'k1', { folder: 'Full' });
    await expect(s.deleteFolder('Full')).rejects.toMatchObject({ code: 'not_empty' });
    await s.createFolder('Parent/Child');
    await expect(s.deleteFolder('Parent')).rejects.toMatchObject({ code: 'not_empty' });
    await s.deleteFolder('Parent/Child');
    expect(await s.folders()).not.toContain('Parent/Child');
  });

  it('move() relocates many keys at once and rejects an unsafe target', async () => {
    const s = store();
    await add(s, 'k1'); await add(s, 'k2');
    expect(await s.move(['k1', 'k2', 'ghost'], 'Island')).toBe(2);
    expect((await s.get('k1'))?.folder).toBe('Island');
    await expect(s.move(['k1'], '../evil')).rejects.toThrow(MediaStoreError);
  });
});
