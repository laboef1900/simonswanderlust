import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureSchema } from '../src/db.js';
import { pgPostStore } from '../src/posts.js';
import { identityFromRow, pgSiteIdentityStore, seedSiteIdentity, type IdentityRow } from '../src/site-identity.js';
import { LEGACY_IDENTITY } from '../src/site-identity-legacy.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('site identity Postgres singleton', () => {
  const schema = `identity_${randomUUID().replaceAll('-', '')}`;
  let owner: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    // Only this suite's isolated schema is cleared; never the shared fixture database.
    await pool.query('DELETE FROM site_identity_assets');
    await pool.query('DELETE FROM site_identity');
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM users');
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  it('seeds neutral once and never rebrands after the install gains a user', async () => {
    await seedSiteIdentity(pool);
    expect((await pgSiteIdentityStore(pool)).get()).toEqual({ revision: 1, savedAt: null, seedSource: 'neutral', identity: neutralIdentity() });
    await pool.query("INSERT INTO users(id,username,password_hash,is_admin) VALUES($1,'fixture','fixture',true)", [randomUUID()]);
    await seedSiteIdentity(pool);
    expect((await pgSiteIdentityStore(pool)).get().identity).toEqual(neutralIdentity());
  });
  it.each(['user', 'post'])('uses exact legacy values when %s evidence predates the first seed', async (evidence) => {
    if (evidence === 'user') {
      await pool.query("INSERT INTO users(id,username,password_hash,is_admin) VALUES($1,'fixture','fixture',true)", [randomUUID()]);
    } else {
      const loc = (locale: 'de' | 'en') => ({ locale, slug: `identity-${locale}`, title: 'T', excerpt: 'e', country: 'X', heroImage: { src: 'https://img.example/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## Body', images: {} });
      await pgPostStore(pool).upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-10-27', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: loc('de'), en: loc('en') });
    }
    await seedSiteIdentity(pool);
    const store = await pgSiteIdentityStore(pool);
    expect(store.get()).toEqual({ revision: 1, savedAt: null, seedSource: 'legacy', identity: LEGACY_IDENTITY });
    await seedSiteIdentity(pool);
    expect(store.get().revision).toBe(1);
  });
  it('commits one concurrent writer, rejects a stale writer, retains canonical, and refreshes detached cache', async () => {
    await seedSiteIdentity(pool, { bootstrapBlogOrigin: 'https://BLOG.example:443/' });
    const store = await pgSiteIdentityStore(pool);
    const edit = store.get().identity;
    const results = await Promise.allSettled([store.update(1, { ...edit, siteName: 'First' }), store.update(1, { ...edit, siteName: 'Second' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'identity_conflict' } });
    const row = (await pool.query<IdentityRow>('SELECT * FROM site_identity')).rows[0]!;
    expect(identityFromRow(row)).toEqual(store.get().identity);
    expect(row.revision).toBe(2);
    expect(row.saved_at).not.toBeNull();
    expect(row.canonical_origin).toBe('https://blog.example');
    const cached = store.get();
    cached.identity.siteName = 'Mutated outside';
    cached.identity.tagline.en = 'Mutated outside';
    expect(store.get().identity.siteName).not.toBe('Mutated outside');
    expect(store.get().identity.tagline).toEqual({});
    await expect(store.update(2, { ...edit, tagline: { en: 42 } })).rejects.toMatchObject({ code: 'invalid_identity' });
    expect((await pool.query('SELECT revision FROM site_identity')).rows[0].revision).toBe(2);
  });
  it('persists normalized canonical updates and clearing without changing language', async () => {
    await seedSiteIdentity(pool);
    const store = await pgSiteIdentityStore(pool);
    const language = (await pool.query('SELECT * FROM site_language')).rows;
    await store.update(1, { ...store.get().identity, canonicalOrigin: 'https://BÜCHER.example:443/' });
    expect((await pgSiteIdentityStore(pool)).get().identity.canonicalOrigin).toBe('https://xn--bcher-kva.example');
    await store.update(2, { ...store.get().identity, canonicalOrigin: null });
    expect((await pgSiteIdentityStore(pool)).get().identity.canonicalOrigin).toBeNull();
    expect((await pool.query('SELECT * FROM site_language')).rows).toEqual(language);
  });
  it('ignores invalid bootstrap origin without logging it and fails loading corrupt retained maps', async () => {
    const logs: string[] = [];
    await seedSiteIdentity(pool, { bootstrapBlogOrigin: 'private-invalid-input', log: (message) => logs.push(message) });
    expect(logs).toEqual(['identity: ignoring invalid bootstrapBlogOrigin.']);
    expect((await pgSiteIdentityStore(pool)).get().identity.canonicalOrigin).toBeNull();
    await pool.query(`UPDATE site_identity SET localized = '{"tagline":{"en":42}}'::jsonb`);
    await expect(pgSiteIdentityStore(pool)).rejects.toMatchObject({ code: 'invalid_identity', field: 'tagline.en' });
  });
});
