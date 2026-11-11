import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { hasExposureColumns } from '../src/exif-backfill.js';
import { emptyMediaExif } from '../src/exif.js';
import { pgMediaStore, type MediaStore, type NewMediaItem } from '../src/media-store.js';
import { runCli } from './run-cli.js';

const url = process.env.TEST_DATABASE_URL;
const EXPOSURE_COLUMNS = ['focal_length', 'focal_length_35mm', 'f_number', 'iso', 'exposure_time'];

/**
 * The `backfill-exif` CLI (#570) spawned exactly as production runs it, against
 * real Postgres in a schema of its own: the conditional UPDATE, the schema
 * check and the exit codes only exist there.
 */
describe.skipIf(!url)('backfill-exif CLI (Postgres)', () => {
  let admin: DbPool;
  let pool: DbPool;
  let store: MediaStore;
  let schema: string;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => { admin = new pg.Pool({ connectionString: url }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    schema = `backfill570_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: scoped.toString() });
    store = pgMediaStore(pool, { baseUrl: 'https://img.example' });
    dir = await realpath(await mkdtemp(join(tmpdir(), 'backfill-cli-')));
    env = { ...process.env, DATABASE_URL: scoped.toString(), STORAGE_DIR: dir };
  });
  afterEach(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(dir, { recursive: true, force: true });
  });

  async function put(rel: string, data: Buffer | string): Promise<void> {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), data);
  }
  /** A camera original: exposure settings beside the camera, lens, capture time and GPS. */
  const original = (): Promise<Buffer> =>
    sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 90, g: 120, b: 150 } } })
      .withExif({
        IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
        IFD2: {
          DateTimeOriginal: '2026:07:04 18:23:11', LensModel: 'SUMMILUX 1:1.7/28 ASPH.',
          ExposureTime: '1/250', FNumber: '28/10', ISOSpeedRatings: '400', FocalLength: '28/1', FocalLengthIn35mmFilm: '35',
        },
        IFD3: {
          GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
          GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
        },
      })
      .jpeg().toBuffer();
  const add = (key: string, over: Partial<NewMediaItem> = {}) =>
    store.upsert({ key, status: 'ready', width: 800, height: 600, origBytes: 10, exif: emptyMediaExif(), uploadedBy: null, ...over });
  const rows = async () => (await pool.query('SELECT * FROM media ORDER BY key')).rows;
  const filled = { focal_length: 28, focal_length_35mm: 35, f_number: 2.8, iso: 400, exposure_time: 0.004 };

  it('hasExposureColumns answers for the current schema only, and needs all five', async () => {
    // Another schema of the same database holds a fully migrated table throughout.
    const other = `${schema}_other`;
    await admin.query(`CREATE SCHEMA ${other}`);
    const elsewhere = new pg.Pool({ connectionString: url, options: `-c search_path=${other}` });
    try {
      await ensureSchema(elsewhere);
      expect(await hasExposureColumns(elsewhere)).toBe(true);
      expect(await hasExposureColumns(pool)).toBe(false); // no media table here yet
      await ensureSchema(pool);
      expect(await hasExposureColumns(pool)).toBe(true);
      await pool.query('ALTER TABLE media DROP COLUMN iso');
      expect(await hasExposureColumns(pool)).toBe(false);
      expect(await hasExposureColumns(elsewhere)).toBe(true);
    } finally {
      await elsewhere.end();
      await admin.query(`DROP SCHEMA ${other} CASCADE`);
    }
  }, 30_000);

  it('refuses a schema the upgraded app has not migrated: exit 1, nothing read or written', async () => {
    await ensureSchema(pool);
    await pool.query(`ALTER TABLE media ${EXPOSURE_COLUMNS.map((column) => `DROP COLUMN ${column}`).join(', ')}`);
    await pool.query(`INSERT INTO media (key, status, width, height) VALUES ('library/2025/a', 'ready', 800, 600)`);
    await put('library/2025/a-orig.jpg', await original());
    const before = await rows();

    const run = await runCli(['backfill-exif'], env);
    expect(run.code).toBe(1);
    expect(run.stderr.trim()).toBe('Start the upgraded app once (it migrates the schema), then re-run backfill-exif.');
    expect(run.stdout).toBe('');
    expect(await rows()).toEqual(before);
  }, 30_000);

  it('fills the five columns from the originals, touches no other column, and is idempotent (exit 0)', async () => {
    await ensureSchema(pool);
    // The stored row disagrees with its original on camera, lens, capture time and GPS.
    await add('library/2025/a', {
      folder: 'Island', title: 'Sunrise', alt: { de: 'DE', en: 'EN' }, tags: ['dawn'],
      exif: { ...emptyMediaExif(), takenAt: new Date('2020-01-01T00:00:00Z'), camera: 'Stored camera', lens: 'Stored lens', lat: 1.5, lng: 2.5 },
    });
    await store.setStatus('library/2025/a', 'failed', 'encode_failed');
    await put('library/2025/a-orig.jpg', await original());
    // A legacy import: variants only. Missing originals are normal and do not fail the run.
    await add('legacy/wp/photo');
    await put('legacy/wp/photo-640.webp', 'variant');
    const before = await rows();

    const first = await runCli(['backfill-exif'], env);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split('\n')).toEqual([
      'backfill-exif: skipped legacy/wp/photo: missing-original',
      'backfill-exif: scanned 2, updated 1, unchanged 0, missing original 1, ambiguous original 0, unreadable 0, invalid key 0',
    ]);
    const after = await rows();
    expect(after).toEqual(before.map((row) => (row.key === 'library/2025/a' ? { ...row, ...filled } : row)));

    const second = await runCli(['backfill-exif'], env);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('scanned 2, updated 0, unchanged 1, missing original 1,');
    expect(await rows()).toEqual(after);
    // Nothing the originals carry besides the five numbers reached the output.
    for (const leak of [dir, '-orig.', 'Leica', 'SUMMILUX', '63.07', '10.38', '0.004', '2.8', '400']) {
      expect(first.stdout + second.stdout).not.toContain(leak);
    }
  }, 60_000);

  it('exits 2 when a key was unreadable, ambiguous or unsafe, after finishing the rest', async () => {
    await ensureSchema(pool);
    await add('library/2025/fine');
    await put('library/2025/fine-orig.jpg', await original());
    await add('library/2025/broken');
    await put('library/2025/broken-orig.jpg', 'not an image');
    await add('library/2025/twice');
    await put('library/2025/twice-orig.jpg', await original());
    await put('library/2025/twice-orig.png', await original());
    // A row only a hand edit or a crafted dump can produce: its key is never echoed.
    await pool.query(`INSERT INTO media (key, status, width, height) VALUES ('../Outside/Secret', 'ready', 800, 600)`);

    const run = await runCli(['backfill-exif'], env);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split('\n')).toEqual([
      'backfill-exif: skipped library/2025/broken: unreadable',
      'backfill-exif: skipped library/2025/twice: ambiguous-original',
      'backfill-exif: scanned 4, updated 1, unchanged 0, missing original 0, ambiguous original 1, unreadable 1, invalid key 1',
    ]);
    expect(run.stdout).not.toContain('Secret');
    expect((await pool.query(`SELECT iso FROM media WHERE key = 'library/2025/fine'`)).rows).toEqual([{ iso: 400 }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM media WHERE iso IS NOT NULL`)).rows).toEqual([{ n: 1 }]);
  }, 30_000);
});
