import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { emptyExposure, emptyMediaExif } from '../src/exif.js';
import { pgMediaStore, MediaStoreError, type MediaStore } from '../src/media-store.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const BASE = 'https://img.simonswanderlust.com';
const noExif = emptyMediaExif();
const EXPOSURE_COLUMNS = ['focal_length', 'focal_length_35mm', 'f_number', 'iso', 'exposure_time'];

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


  it('atomically admits one of two concurrent same-field conditional writers', async () => {
    await add('conditional');
    const attempts = await Promise.allSettled(['First', 'Second'].map((title) => store.patchConditional('conditional', {
      version: 1, patch: { title, folder: title + '/Child', alt: { de: title } },
      expect: { title: '', folder: '', alt: { de: '' } },
    })));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const saved = await store.get('conditional');
    expect(saved?.folder).toBe(saved?.title + '/Child');
    expect(saved?.alt.de).toBe(saved?.title);
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
      reason: { code: 'media_changed', current: { title: saved?.title, folder: saved?.folder } },
    });
    expect(await store.folders()).toEqual([saved?.title, saved?.title + '/Child']);
  });

  it('concurrent independent locale edits survive and canonical expectations match persisted values', async () => {
    await add('conditional', { title: 'ab', tags: ['sea'] });
    await Promise.all([
      store.patchConditional('conditional', { version: 1, patch: { alt: { de: 'DE' } }, expect: { alt: { de: '' } } }),
      store.patchConditional('conditional', { version: 1, patch: { alt: { en: 'EN' } }, expect: { alt: { en: '' } } }),
    ]);
    const saved = await store.patchConditional('conditional', {
      version: 1, patch: { title: 'c\u0000d', tags: ['next', 'next'], caption: { de: 'x'.repeat(1005) } },
      expect: { title: 'a\u0000b', tags: [' sea ', 'sea'], caption: { de: '' } },
    });
    expect(saved).toMatchObject({ title: 'cd', tags: ['next'], alt: { de: 'DE', en: 'EN' }, caption: { de: 'x'.repeat(1000) } });
    await expect(store.patchConditional('missing', {
      version: 1, patch: { title: 'new', folder: 'Absent' }, expect: { title: '', folder: '' },
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.folders()).toEqual([]);
  });

  it('conditional folder creation rolls the media update and all ancestors back on failure', async () => {
    await add('conditional');
    let inserts = 0;
    const failing = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return Object.assign(Object.create(client), {
          async query(text: string, values?: unknown[]) {
            if (text.includes('INSERT INTO media_folders') && ++inserts === 2) throw new Error('folder write failed');
            return client.query(text, values);
          },
        });
      },
    } as unknown as DbPool;
    await expect(pgMediaStore(failing, { baseUrl: BASE }).patchConditional('conditional', {
      version: 1, patch: { title: 'new', folder: 'Parent/Child' }, expect: { title: '', folder: '' },
    })).rejects.toThrow('folder write failed');
    expect(inserts).toBe(2);
    expect(await store.get('conditional')).toMatchObject({ title: '', folder: '' });
    expect(await store.folders()).toEqual([]);
  });

  it('returns its own committed row and description delta even when another writer lands before the acknowledgement', async () => {
    await add('conditional');
    let intervened = false;
    const racing = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return Object.assign(Object.create(client), {
          async query(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            if (!intervened && text === 'COMMIT') {
              intervened = true;
              await store.patch('conditional', { title: 'later', caption: { de: 'later', en: 'later EN' } });
            }
            return result;
          },
        });
      },
    } as unknown as DbPool;
    const saved = await pgMediaStore(racing, { baseUrl: BASE }).patchConditional('conditional', {
      version: 1, patch: { title: 'mine', caption: { de: 'mine' } }, expect: { title: '', caption: { de: '' } },
    });
    expect(intervened).toBe(true);
    expect(saved.title).toBe('mine');
    expect(saved.caption).toEqual({ de: 'mine', en: '' });
    expect(saved.changedDescriptions).toEqual({ de: { alt: false, caption: true }, en: { alt: false, caption: false } });
    expect((await store.get('conditional'))?.caption).toEqual({ de: 'later', en: 'later EN' });
  });

  it('compares normalized values for no-op and reverted description writes', async () => {
    await add('conditional', { alt: { de: 'same' } });
    const unchanged = await store.patchConditional('conditional', {
      version: 1, patch: { alt: { de: 'sa\u0000me' } }, expect: { alt: { de: 'same' } },
    });
    expect(unchanged.changedDescriptions).toEqual({ de: { alt: false, caption: false }, en: { alt: false, caption: false } });
    await store.patchConditional('conditional', { version: 1, patch: { alt: { de: 'new' } }, expect: { alt: { de: 'same' } } });
    const reverted = await store.patchConditional('conditional', { version: 1, patch: { alt: { de: 'same' } }, expect: { alt: { de: 'new' } } });
    expect(reverted.changedDescriptions).toEqual({ de: { alt: true, caption: false }, en: { alt: false, caption: false } });
  });

  it('does not manufacture a successful delta when COMMIT acknowledgement is lost', async () => {
    await add('conditional');
    const uncertain = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return Object.assign(Object.create(client), {
          async query(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            if (text === 'COMMIT') throw new Error('commit acknowledgement lost');
            return result;
          },
        });
      },
    } as unknown as DbPool;
    await expect(pgMediaStore(uncertain, { baseUrl: BASE }).patchConditional('conditional', {
      version: 1, patch: { caption: { de: 'committed' } }, expect: { caption: { de: '' } },
    })).rejects.toThrow('commit acknowledgement lost');
    expect((await store.get('conditional'))?.caption.de).toBe('committed');
  });
  it('round-trips every column, including tags and EXIF', async () => {
    const saved = await add('library/2025/a', {
      folder: 'Island', title: 'Sunrise', tags: ['dawn', 'sea'],
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' },
      exif: {
        takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'LEICA Q2', lens: 'Summilux', lat: 63.0759, lng: 10.3887,
        focalLength: 28, focalLength35mm: 35, fNumber: 1.7, iso: 200, exposureTime: 0.004,
      },
    });
    expect(saved).toMatchObject({
      key: 'library/2025/a', folder: 'Island', title: 'Sunrise',
      alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' },
      tags: ['dawn', 'sea'], width: 800, height: 600, status: 'ready',
      src: `${BASE}/library/2025/a`, thumbSrc: `${BASE}/library/2025/a-640.webp`,
      fullSrc: `${BASE}/library/2025/a-800.webp`,
    });
    // #570: five distinct values, so a column bound to the wrong parameter cannot pass.
    expect(saved.exif).toMatchObject({ focalLength: 28, focalLength35mm: 35, fNumber: 1.7, iso: 200, exposureTime: 0.004 });
    expect((await store.get('library/2025/a'))?.exif).toEqual(saved.exif);
    expect((await store.list({})).items[0]?.exif).toEqual(saved.exif);
    expect(saved.exif.lat).toBeCloseTo(63.0759, 4);
    // @ai-warning: EXIF wall-clock is stored as if UTC — read with getUTC*.
    expect(saved.exif.takenAt?.getUTCHours()).toBe(18);
    // bigint arrives as a string from node-postgres; it must be a number here.
    expect(typeof saved.origBytes).toBe('number');
  });

  it('round-trips JPEG format and the immutable encoding snapshot', async () => {
    const saved = await add('library/2026/jpeg', {
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 82, avifQuality: 62 },
    });
    expect(saved).toMatchObject({
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 82, avifQuality: 62 },
      thumbSrc: `${BASE}/library/2026/jpeg-640.jpeg`,
      fullSrc: `${BASE}/library/2026/jpeg-800.jpeg`,
    });
    expect(await store.get('library/2026/jpeg')).toMatchObject({
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 82, avifQuality: 62 },
    });
  });

  // #570: the fullscreen viewer's URL — the intrinsic-width variant, only once ready.
  it('derives fullSrc from the stored width, status and format', async () => {
    expect((await add('wide', { width: 3000, height: 2000 })).fullSrc).toBe(`${BASE}/wide-3000.webp`);
    expect((await add('small', { width: 500 })).fullSrc).toBe(`${BASE}/small-500.webp`);
    expect((await add('unknown', { width: 0, height: 0 })).fullSrc).toBeNull();
    for (const status of ['processing', 'failed', 'missing'] as const) {
      expect((await add(`not-ready-${status}`, { status, width: 3000 })).fullSrc).toBeNull();
    }
    await store.setStatus('not-ready-processing', 'ready');
    expect((await store.get('not-ready-processing'))?.fullSrc).toBe(`${BASE}/not-ready-processing-3000.webp`);
  });

  describe('exposure columns (#570)', () => {
    const exposure = { focalLength: 4.3, focalLength35mm: 24, fNumber: 1.8, iso: 125, exposureTime: 1 / 500 };
    /** The five columns exactly as Postgres holds them — a stored NaN would read back as NaN, not null. */
    const stored = async (key: string) => (await pool.query(
      `SELECT focal_length, focal_length_35mm, f_number, iso, exposure_time FROM media WHERE key = $1`, [key],
    )).rows[0];
    const nulls = { focal_length: null, focal_length_35mm: null, f_number: null, iso: null, exposure_time: null };

    it('round-trips both ends of every accepted range exactly', async () => {
      const extremes = {
        low: { focalLength: 0.5, focalLength35mm: 1, fNumber: 0.5, iso: 1, exposureTime: Number.MIN_VALUE },
        high: { focalLength: 5000, focalLength35mm: 10_000, fNumber: 512, iso: 10_000_000, exposureTime: 86_400 },
        typical: exposure,
      };
      for (const [key, values] of Object.entries(extremes)) {
        const saved = await add(key, { exif: { ...emptyMediaExif(), ...values } });
        // toEqual, not toBeCloseTo: a double survives the text round-trip bit for bit.
        expect(saved.exif).toEqual({ ...emptyMediaExif(), ...values });
        expect((await store.get(key))?.exif).toEqual(saved.exif);
        expect(await stored(key)).toEqual({
          focal_length: values.focalLength, focal_length_35mm: values.focalLength35mm, f_number: values.fNumber,
          iso: values.iso, exposure_time: values.exposureTime,
        });
      }
      expect((await add('bare')).exif).toEqual(emptyMediaExif());
      expect(await stored('bare')).toEqual(nulls);
    });

    // ON CONFLICT takes EXCLUDED.* for these, like taken_at — the rule the memory store mirrors.
    it('a re-upsert takes the incoming exposure values', async () => {
      await add('k', { exif: { ...emptyMediaExif(), ...exposure } });
      expect((await add('k', { exif: { ...emptyMediaExif(), iso: 800 } })).exif).toEqual({ ...emptyMediaExif(), iso: 800 });
      expect((await add('k')).exif).toEqual(emptyMediaExif());
    });

    // @ai-warning The control this exists for: `double precision` ACCEPTS NaN
    // and there is no CHECK, so only the store's write-point normalization
    // keeps a malformed number out — and a raw 100.4 would fail the integer cast.
    it('upsert never stores NaN, an out-of-range value or a fractional integer', async () => {
      await add('bad', {
        exif: {
          ...emptyMediaExif(), lens: 'kept',
          focalLength: Number.NaN, focalLength35mm: 10_001, fNumber: Number.POSITIVE_INFINITY, iso: 0, exposureTime: -1,
        },
      });
      expect(await stored('bad')).toEqual(nulls);
      expect((await store.get('bad'))?.exif).toEqual({ ...emptyMediaExif(), lens: 'kept' });
      const rounded = await add('rounded', { exif: { ...emptyMediaExif(), focalLength35mm: 23.6, iso: 100.4 } });
      expect(rounded.exif).toMatchObject({ focalLength35mm: 24, iso: 100 });
      expect(await stored('rounded')).toEqual({ ...nulls, focal_length_35mm: 24, iso: 100 });
      // Postgres really would have taken the NaN: this is not a no-op guard.
      await pool.query(`UPDATE media SET f_number = 'NaN' WHERE key = 'bad'`);
      expect((await stored('bad')).f_number).toBeNaN();
    });

    it('setExposure never stores NaN, an out-of-range value or a fractional integer', async () => {
      await add('k');
      expect(await store.setExposure('k', {
        focalLength: Number.NaN, focalLength35mm: 10_001, fNumber: Number.POSITIVE_INFINITY, iso: 0, exposureTime: -1,
      })).toBe(false); // nothing storable, and the row had nothing
      expect(await stored('k')).toEqual(nulls);
      expect(await store.setExposure('k', {
        focalLength: Number.NaN, focalLength35mm: 23.6, fNumber: 513, iso: 100.4, exposureTime: Number.POSITIVE_INFINITY,
      })).toBe(true);
      expect(await stored('k')).toEqual({ ...nulls, focal_length_35mm: 24, iso: 100 });
      // Different raw input, same stored values: compared after normalizing.
      expect(await store.setExposure('k', { focalLength: 0, focalLength35mm: 24.2, fNumber: null, iso: 99.6, exposureTime: 0 })).toBe(false);
    });

    it('setExposure writes only the five columns and reports whether a stored value changed', async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`,
        [`exposure-${randomUUID()}`],
      );
      const userId = rows[0]!.id;
      try {
        await add('k', {
          folder: 'Island', title: 'Sunrise', alt: { de: 'DE', en: 'EN' }, caption: { de: 'CD', en: 'CE' }, tags: ['dawn'],
          uploadedBy: userId, format: 'jpeg', encoding: { convertJpeg: false, webpQuality: 82, avifQuality: 62 },
          exif: { ...emptyMediaExif(), takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'LEICA Q2', lens: 'Summilux', lat: 63.0759, lng: 10.3887 },
        });
        await store.setStatus('k', 'failed', 'encode_failed');
        await store.setVariantBytes('k', 4242);
        const row = async () => (await pool.query(`SELECT * FROM media WHERE key = 'k'`)).rows[0];
        const before = await row();
        expect(Object.keys(before).filter((column) => EXPOSURE_COLUMNS.includes(column)).sort()).toEqual([...EXPOSURE_COLUMNS].sort());

        expect(await store.setExposure('k', exposure)).toBe(true);
        const after = await row();
        // Every other column is byte-for-byte what it was: status, error, text, camera, GPS, uploader, timestamps.
        expect(after).toEqual({
          ...before, focal_length: 4.3, focal_length_35mm: 24, f_number: 1.8, iso: 125, exposure_time: 1 / 500,
        });

        // An identical second write matches no row — the backfill's idempotence.
        expect(await store.setExposure('k', { ...exposure })).toBe(false);
        expect(await row()).toEqual(after);
        // The comparison is NULL-safe in both directions.
        expect(await store.setExposure('k', { ...exposure, iso: null })).toBe(true);
        expect(await store.setExposure('k', { ...exposure, iso: null })).toBe(false);
        expect(await store.setExposure('k', { ...exposure, iso: 125 })).toBe(true);
        expect(await row()).toEqual(after);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await add('bare');
      expect(await store.setExposure('bare', emptyExposure())).toBe(false); // NULLs onto NULLs
      expect(await store.setExposure('ghost', exposure)).toBe(false);
      expect(await store.get('ghost')).toBeNull();
    });

    // Simulates an install from before #570 by dropping the columns from a
    // populated table, in a schema of its own so the shared one is untouched.
    it('the migration adds five nullable columns to a pre-#570 table, idempotently, without rewriting rows', async () => {
      const schema = `media570_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE SCHEMA ${schema}`);
      const scoped = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
      const definitions = async () => (await scoped.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'media' AND column_name = ANY($1::text[])
          ORDER BY column_name`, [EXPOSURE_COLUMNS],
      )).rows;
      try {
        await ensureSchema(scoped);
        const fresh = await definitions();
        expect(fresh).toEqual([
          { column_name: 'exposure_time', data_type: 'double precision', is_nullable: 'YES', column_default: null },
          { column_name: 'f_number', data_type: 'double precision', is_nullable: 'YES', column_default: null },
          { column_name: 'focal_length', data_type: 'double precision', is_nullable: 'YES', column_default: null },
          { column_name: 'focal_length_35mm', data_type: 'integer', is_nullable: 'YES', column_default: null },
          { column_name: 'iso', data_type: 'integer', is_nullable: 'YES', column_default: null },
        ]);

        await scoped.query(`ALTER TABLE media ${EXPOSURE_COLUMNS.map((column) => `DROP COLUMN ${column}`).join(', ')}`);
        expect(await definitions()).toEqual([]);
        await scoped.query(
          `INSERT INTO media (key, title, status, width, height, orig_bytes, camera, lens, lat, lng)
           VALUES ('legacy/photo', 'Kept', 'ready', 800, 600, 10, 'LEICA Q2', 'Summilux', 63.0759, 10.3887)`,
        );
        const before = (await scoped.query('SELECT * FROM media')).rows;

        await ensureSchema(scoped);
        await ensureSchema(scoped); // it runs on every boot
        // The migrated table matches a fresh install's: same types, nullable, no default.
        expect(await definitions()).toEqual(fresh);
        // No backfill and no rewrite: the old row is intact and simply reads NULL.
        expect((await scoped.query('SELECT * FROM media')).rows).toEqual(
          before.map((row) => ({ ...row, focal_length: null, focal_length_35mm: null, f_number: null, iso: null, exposure_time: null })),
        );
        // No CHECK guards the new columns (the bounds live at the write points).
        const checks = (await scoped.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid = to_regclass('media') AND contype = 'c'`,
        )).rows.map((check) => check.definition);
        expect(checks.filter((definition) => EXPOSURE_COLUMNS.some((column) => definition.includes(column)))).toEqual([]);

        const migrated = pgMediaStore(scoped, { baseUrl: BASE });
        expect((await migrated.get('legacy/photo'))?.exif).toMatchObject({ camera: 'LEICA Q2', lat: 63.0759, ...emptyExposure() });
        expect(await migrated.setExposure('legacy/photo', exposure)).toBe(true);
        expect((await migrated.get('legacy/photo'))?.exif).toMatchObject({ camera: 'LEICA Q2', ...exposure });
      } finally {
        await scoped.end();
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    }, 30_000);
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

  it('alt: missing matches blank alt text in both locales through the SQL pattern, never a filled one', async () => {
    await add('none');
    await add('blank', { alt: { de: '  ', en: ' ' } });
    await add('de-only', { alt: { de: 'Fjord im Morgenlicht', en: '' } });
    await add('both', { alt: { de: 'Fjord', en: 'Fjord' } });
    await add('encoding', { status: 'processing' });
    expect((await store.list({ alt: 'missing' })).items.map((i) => i.key).sort()).toEqual(['blank', 'encoding', 'none']);
    expect((await store.list({ alt: 'missing', status: 'ready' })).total).toBe(2);
    expect((await store.list({ alt: 'missing', q: 'blank' })).items.map((i) => i.key)).toEqual(['blank']);
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

  it('descriptions reads only alt/caption of known keys in one query, blanks included', async () => {
    await add('lib', { title: 'Label', alt: { de: 'A', en: 'B' }, caption: { de: 'C', en: '' } });
    await add('bare');
    const out = await store.descriptions(['lib', 'bare', 'never-uploaded']);
    expect(out.get('lib')).toEqual({ alt: { de: 'A', en: 'B' }, caption: { de: 'C', en: '' } });
    expect(out.get('bare')).toEqual({ alt: { de: '', en: '' }, caption: { de: '', en: '' } });
    expect(out.has('never-uploaded')).toBe(false);
    expect((await store.descriptions([])).size).toBe(0);
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

  // Before #133 the rename was four pool queries: a folder created between the
  // `media` rewrite and the `media_folders` rewrite left every moved row in a
  // folder the tree never listed. Inject exactly that race on a wrapped
  // client and assert the media rows roll back with the failed tree rewrite.
  it('rename is one transaction: a tree rewrite that fails undoes the media rewrite', async () => {
    await add('k1', { folder: 'a' });
    let injected = false;
    const racing = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return Object.assign(Object.create(client), {
          async query(text: string, values?: unknown[]) {
            if (!injected && text.includes('UPDATE media_folders')) {
              injected = true;
              await pool.query(`INSERT INTO media_folders (path) VALUES ('b')`); // another connection, autocommitted
            }
            return client.query(text, values);
          },
        });
      },
    } as unknown as DbPool;
    const raced = pgMediaStore(racing, { baseUrl: BASE });
    await expect(raced.renameFolder('a', 'b')).rejects.toMatchObject({ code: '23505' });
    expect(injected).toBe(true);
    expect((await store.get('k1'))?.folder).toBe('a');
    expect(await store.folders()).toEqual(['a', 'b']);
  });

  it('strips a NUL that Postgres text would otherwise reject with a 500', async () => {
    const saved = await add('k', { title: 'a\u0000b', alt: { de: 'x\u0000', en: '' } });
    expect(saved).toMatchObject({ title: 'ab', alt: { de: 'x', en: '' } });
    expect((await store.patch('k', { caption: { en: '\u0000c' } })).caption.en).toBe('c');
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

  // #348: the rollback of a refused enqueue must never undo a settled row.
  it('setStatusIfProcessing writes only while the row is still processing', async () => {
    await add('k', { status: 'processing' });
    expect(await store.setStatusIfProcessing('k', 'failed', 'queue_full')).toBe(true);
    expect(await store.get('k')).toMatchObject({ status: 'failed', error: 'queue_full' });
    expect(await store.setStatusIfProcessing('k', 'missing')).toBe(false);
    await store.setStatus('k', 'ready');
    expect(await store.setStatusIfProcessing('k', 'failed', 'queue_full')).toBe(false);
    expect(await store.get('k')).toMatchObject({ status: 'ready', error: null });
    expect(await store.setStatusIfProcessing('ghost', 'failed', 'queue_full')).toBe(false);
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

  // The rule the memory store mirrors (#135): ON CONFLICT never lists
  // uploaded_by, so a re-upload by another account does not claim the row.
  it('re-upserting keeps the first uploader', async () => {
    const mk = async (name: string) => (await pool.query<{ id: string }>(
      `INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`, [name],
    )).rows[0]!.id;
    const first = await mk(`first-${Date.now()}`);
    const second = await mk(`second-${Date.now()}`);
    try {
      await add('k', { uploadedBy: first });
      expect((await add('k', { uploadedBy: second })).uploadedBy).toBe(first);
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[first, second]]);
    }
  });
});
