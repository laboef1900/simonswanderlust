import { describe, expect, it } from 'vitest';
import {
  assertSafeFolder, folderAncestry, libraryKey, likePattern, memoryMediaStore, MediaStoreError,
  normalizeTags, pageSizeOf, redactForNonAdmin, sortColumn, thumbWidth,
  MAX_PAGE_SIZE, type MediaStore,
} from '../src/media-store.js';

const BASE = 'https://img.simonswanderlust.com';
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

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
  it('drops GPS and uploadedBy but keeps camera metadata', () => {
    const item = {
      key: 'k', src: 's', thumbSrc: null, folder: '', title: '',
      alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [],
      width: 1, height: 1, origBytes: 0, variantBytes: 0,
      status: 'ready' as const, error: null,
      exif: { takenAt: null, camera: 'Leica Q2', lens: 'Summilux', lat: 63.4, lng: 10.4 },
      uploadedAt: new Date(), uploadedBy: 'u1',
    };
    const out = redactForNonAdmin(item);
    expect(out.exif).toMatchObject({ lat: null, lng: null, camera: 'Leica Q2', lens: 'Summilux' });
    expect(out.uploadedBy).toBeNull();
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

  it('patch edits metadata and 404s for an unknown key', async () => {
    const s = store();
    await add(s, 'k');
    const patched = await s.patch('k', { title: 'T', caption: { de: 'C' }, tags: ['a'] });
    expect(patched).toMatchObject({ title: 'T', caption: { de: 'C', en: '' }, tags: ['a'] });
    await expect(s.patch('ghost', { title: 'x' })).rejects.toThrow(MediaStoreError);
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

  it('setStatus clears the error when leaving failed', async () => {
    const s = store();
    await add(s, 'k');
    await s.setStatus('k', 'failed', 'decode_failed');
    expect((await s.get('k'))?.error).toBe('decode_failed');
    await s.setStatus('k', 'ready');
    expect((await s.get('k'))?.error).toBeNull();
  });

  it('claimNextProcessing returns the oldest processing row, or null', async () => {
    const s = store();
    expect(await s.claimNextProcessing()).toBeNull();
    await add(s, 'k1', { status: 'processing' });
    expect((await s.claimNextProcessing())?.key).toBe('k1');
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
