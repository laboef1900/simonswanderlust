import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, ensureSchema, REGIONS, type DbPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

// Spec 2026-10-19-new-regions-design.md §4: databases created before the four
// new regions carry a three-value region CHECK that `CREATE TABLE IF NOT
// EXISTS` never revisits. ensureSchema must widen it in place — every existing
// row untouched — and leave an up-to-date check alone on the next boot.
maybe('posts region CHECK migration (integration)', () => {
  let pool: DbPool;
  const TK = 'region-mig-';

  const regionChecks = async () => (await pool.query<{ oid: string; conname: string; def: string }>(
    `SELECT oid::text AS oid, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%region%'
      ORDER BY conname`,
  )).rows;

  const insert = (key: string, region: string) => pool.query(
    `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region, excerpt, hero_image, coordinates, body_markdown)
     VALUES ($1, $2, 'de', $2, 'T', '2024-10-03', 'X', 'RO', $3, 'e', '{}', '{}', 'b')`,
    [randomUUID(), TK + key, region],
  );

  /** Rewind to the pre-2026-10-19 schema: the three-value check, under `name`. */
  const rewind = async (name: string) => {
    for (const { conname } of await regionChecks()) await pool.query(`ALTER TABLE posts DROP CONSTRAINT "${conname}"`);
    await pool.query(`ALTER TABLE posts ADD CONSTRAINT "${name}" CHECK (region IN ('europe','north-america','south-america'))`);
  };

  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM posts WHERE translation_key LIKE $1', [TK + '%']);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM posts WHERE translation_key LIKE $1', [TK + '%']);
    // Leave the shared scratch database on the current check for later suites.
    await ensureSchema(pool);
    await pool.end();
  });

  it('widens the old three-value check, keeps existing rows intact, and is a no-op on the next boot', async () => {
    await rewind('posts_region_check');
    await insert('old', 'south-america');
    await expect(insert('asia', 'asia')).rejects.toMatchObject({ code: '23514' });
    const before = (await pool.query('SELECT * FROM posts WHERE translation_key = $1', [TK + 'old'])).rows;

    await ensureSchema(pool);

    const checks = await regionChecks();
    expect(checks.map((c) => c.conname)).toEqual(['posts_region_check']);
    for (const region of REGIONS) expect(checks[0]!.def).toContain(`'${region}'`);
    for (const region of ['asia', 'africa', 'oceania', 'antarctica']) await insert(region, region);
    await expect(insert('atlantis', 'atlantis')).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('SELECT * FROM posts WHERE translation_key = $1', [TK + 'old'])).rows).toEqual(before);

    // Same constraint row (oid) after another boot: not dropped and re-added.
    await ensureSchema(pool);
    expect(await regionChecks()).toEqual(checks);
  });

  it('replaces a region check found under another name instead of leaving it beside the new one', async () => {
    await rewind('legacy_region_ck');
    await insert('old', 'europe');

    await ensureSchema(pool);

    expect((await regionChecks()).map((c) => c.conname)).toEqual(['posts_region_check']);
    await insert('oceania', 'oceania');
    expect((await pool.query('SELECT region FROM posts WHERE translation_key = $1', [TK + 'old'])).rows).toEqual([{ region: 'europe' }]);
  });
});
