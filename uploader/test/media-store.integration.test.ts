import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgMediaStore, MediaStoreError, type MediaStore } from '../src/media-store.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const BASE = 'https://img.simonswanderlust.com';
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

/**
 * @ai-warning pgMediaStore is covered ONLY here, and this suite is
 * `describe.skip` without TEST_DATABASE_URL — exactly the coverage asymmetry
 * that lets a pg-only regression pass a default `npm test`. Set the variable
 * when touching media-store.ts.
 */
maybe('pgMediaStore (integration)', () => {
  let pool: DbPool;
  let store: MediaStore;

  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
    store = pgMediaStore(pool, { baseUrl: BASE });
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM media');
    await pool.query('DELETE FROM media_folders');
  });

  const add = (key: string, over: Record<string, unknown> = {}) =>
    store.upsert({ key, status: 'ready', width: 800, height: 600, origBytes: 10, exif: noExif, uploadedBy: null, ...over });

  it('round-trips every column, including tags and EXIF', async () => {
    const saved = await add('library/2025/a', {
      folder: 'Island', title: 'Sunrise', tags: ['dawn', 'sea'],
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' },
      exif: { takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'LEICA Q2', lens: 'Summilux', lat: 63.0759, lng: 10.3887 },
    });
    expect(saved).toMatchObject({
      key: 'library/2025/a', folder: 'Island', title: 'Sunrise',
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' },
      tags: ['dawn', 'sea'], width: 800, height: 600, status: 'ready',
      src: `${BASE}/library/2025/a`, thumbSrc: `${BASE}/library/2025/a-640.webp`,
    });
    expect(saved.exif.lat).toBeCloseTo(63.0759, 4);
    // @ai-warning: EXIF wall-clock is stored as if UTC — read with getUTC*.
    expect(saved.exif.takenAt?.getUTCHours()).toBe(18);
    // bigint arrives as a string from node-postgres; it must be a number here.
    expect(typeof saved.origBytes).toBe('number');
  });

  it('upserting a folder creates its ancestor rows', async () => {
    await add('k', { folder: 'a/b/c' });
    expect(await store.folders()).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('filters, sorts, paginates and reports the unpaginated total', async () => {
    await add('k1', { folder: 'Island', title: 'Alpha', tags: ['dawn'] });
    await add('k2', { folder: 'Island/Sued', title: 'Beta' });
    await add('k3', { folder: '', title: 'Gamma', status: 'failed' });
    expect((await store.list({ folder: 'Island' })).items.map((i) => i.key)).toEqual(['k1']);
    expect((await store.list({ folder: 'Island', recursive: true })).items.map((i) => i.key).sort()).toEqual(['k1', 'k2']);
    expect((await store.list({ status: 'failed' })).items.map((i) => i.key)).toEqual(['k3']);
    expect((await store.list({ tag: 'dawn' })).items.map((i) => i.key)).toEqual(['k1']);
    expect((await store.list({ q: 'bet' })).items.map((i) => i.key)).toEqual(['k2']);
    const page = await store.list({ sort: 'title', order: 'asc', page: 2, pageSize: 1 });
    expect(page.items.map((i) => i.title)).toEqual(['Beta']);
    expect(page.total).toBe(3);
  });

  it('an unknown sort falls back instead of reaching SQL', async () => {
    await add('k1');
    // A raw value here would be a SQL-injection point: sort/order are
    // identifiers pg cannot parameterize.
    await expect(store.list({ sort: 'key; DROP TABLE media' as never })).resolves.toMatchObject({ total: 1 });
    const still = await pool.query('SELECT count(*)::int AS n FROM media');
    expect(still.rows[0].n).toBe(1);
  });

  it('escapes ILIKE wildcards in the search term', async () => {
    await add('k1', { title: 'a_b' });
    await add('k2', { title: 'axb' });
    // With an unescaped `_` this would also match 'axb'.
    expect((await store.list({ q: 'a_b' })).items.map((i) => i.key)).toEqual(['k1']);
  });

  it('caps tag count and length server-side (a GIN index stores one entry per element)', async () => {
    const saved = await add('k', { tags: [...Array.from({ length: 50 }, (_, i) => `t${i}`), 'x'.repeat(80)] });
    expect(saved.tags.length).toBeLessThanOrEqual(30);
    expect(saved.tags.every((t) => t.length <= 40)).toBe(true);
  });

  it('re-upserting keeps existing text a caller omitted', async () => {
    await add('k', { title: 'Kept', alt: { de: 'DE', en: '' } });
    const again = await add('k', { status: 'processing' });
    expect(again).toMatchObject({ title: 'Kept', alt: { de: 'DE', en: '' }, status: 'processing' });
  });

  it('notReadyKeys returns only non-ready keys and ignores unknown ones', async () => {
    await add('ready-key');
    await add('busy-key', { status: 'processing' });
    const out = await store.notReadyKeys(['ready-key', 'busy-key', 'never-uploaded']);
    expect([...out]).toEqual(['busy-key']);
  });

  // The query encodeQueue.recover() re-seeds the backlog from.
  it('lists processing rows oldest-first for queue recovery', async () => {
    await add('new', { status: 'processing' });
    await pool.query(`UPDATE media SET uploaded_at = now() - interval '1 day' WHERE key = 'new'`);
    await add('newer', { status: 'processing' });
    await add('done', { status: 'ready' });
    const { items } = await store.list({ status: 'processing', sort: 'uploaded', order: 'asc' });
    expect(items.map((i) => i.key)).toEqual(['new', 'newer']);
  });

  it('renames a folder subtree by exact match plus prefix, never a same-prefix sibling', async () => {
    await add('k1', { folder: 'Iceland' });
    await add('k2', { folder: 'Iceland/South' });
    await add('k3', { folder: 'Iceland 2024' });
    expect(await store.renameFolder('Iceland', 'Island')).toBe(2);
    expect((await store.get('k1'))?.folder).toBe('Island');
    expect((await store.get('k2'))?.folder).toBe('Island/South');
    expect((await store.get('k3'))?.folder).toBe('Iceland 2024');
    const folders = await store.folders();
    expect(folders).toContain('Island');
    expect(folders).toContain('Island/South');
    expect(folders).not.toContain('Iceland');
  });

  // @ai-warning: with `WHERE folder LIKE $1 || '/%'` a folder literally named
  // `%` would move the ENTIRE library. starts_with() plus the segment regex is
  // the defence; this asserts both hold.
  it('a folder named "%" cannot mass-move the library', async () => {
    await add('k1', { folder: 'Iceland' });
    await add('k2', { folder: 'Norway' });
    await expect(store.createFolder('%')).rejects.toThrow(MediaStoreError);
    await expect(store.renameFolder('%', 'everything')).rejects.toThrow(MediaStoreError);
    expect((await store.get('k1'))?.folder).toBe('Iceland');
    expect((await store.get('k2'))?.folder).toBe('Norway');
  });

  it('409s on a rename onto an existing folder and refuses to nest one in itself', async () => {
    await store.createFolder('a');
    await store.createFolder('b');
    await expect(store.renameFolder('a', 'b')).rejects.toMatchObject({ code: 'exists' });
    await expect(store.renameFolder('a', 'a/child')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to delete a non-empty folder', async () => {
    await add('k1', { folder: 'Full' });
    await expect(store.deleteFolder('Full')).rejects.toMatchObject({ code: 'not_empty' });
    await store.createFolder('Parent/Child');
    await expect(store.deleteFolder('Parent')).rejects.toMatchObject({ code: 'not_empty' });
    await store.deleteFolder('Parent/Child');
    expect(await store.folders()).not.toContain('Parent/Child');
  });

  it('patch updates only the supplied fields and 404s for an unknown key', async () => {
    await add('k', { title: 'Before', alt: { de: 'DE', en: 'EN' } });
    const patched = await store.patch('k', { caption: { de: 'Tag 3' } });
    expect(patched).toMatchObject({ title: 'Before', alt: { de: 'DE', en: 'EN' }, caption: { de: 'Tag 3', en: '' } });
    await expect(store.patch('ghost', { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('move relocates many keys at once', async () => {
    await add('k1'); await add('k2');
    expect(await store.move(['k1', 'k2', 'ghost'], 'Island')).toBe(2);
    expect((await store.get('k1'))?.folder).toBe('Island');
  });

  it('setVariantBytes and setStatus persist, and leaving failed clears the error', async () => {
    await add('k', { status: 'processing' });
    await store.setVariantBytes('k', 4242);
    await store.setStatus('k', 'failed', 'encode_failed');
    expect(await store.get('k')).toMatchObject({ variantBytes: 4242, status: 'failed', error: 'encode_failed' });
    await store.setStatus('k', 'ready');
    expect(await store.get('k')).toMatchObject({ status: 'ready', error: null });
  });

  it('uploaded_by is nulled rather than blocking a user delete', async () => {
    // The FK is ON DELETE SET NULL — a photo must outlive the account that
    // uploaded it.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`,
      [`uploader-${Date.now()}`],
    );
    const userId = rows[0]!.id;
    await add('k', { uploadedBy: userId });
    expect((await store.get('k'))?.uploadedBy).toBe(userId);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    expect((await store.get('k'))?.uploadedBy).toBeNull();
  });
});
