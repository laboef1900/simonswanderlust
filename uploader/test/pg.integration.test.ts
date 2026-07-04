import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore, UserExistsError } from '../src/users.js';
import { pgSessionStore } from '../src/sessions.js';
import { pgPostStore } from '../src/posts.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('postgres stores (integration)', () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM sessions'); await pool.query('DELETE FROM users');
    // The 'about' page seed is asserted verbatim below. Other integration suites
    // (pages.integration, backup.integration) intentionally mutate the same
    // key/locale rows against a shared scratch DB, so re-wipe + re-seed here to
    // make this suite's assertion independent of sibling test file ordering.
    await pool.query(`DELETE FROM pages WHERE key = 'about'`);
    await ensureSchema(pool);
  });
  afterAll(async () => { await pool.end(); });

  it('round-trips a user and enforces unique username', async () => {
    const users = pgUserStore(pool);
    const u = await users.create({ username: 'Simon', password: 'pw', isAdmin: true });
    expect((await users.findByUsername('simon'))?.id).toBe(u.id);
    await expect(users.create({ username: 'simon', password: 'x', isAdmin: false })).rejects.toBeInstanceOf(UserExistsError);
  });

  it('creates and finds a session, and expires it', async () => {
    const users = pgUserStore(pool);
    const sessions = pgSessionStore(pool);
    const u = await users.create({ username: `u${Date.now()}`, password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    expect((await sessions.find(token))?.userId).toBe(u.id);
    const expired = await sessions.create(u.id, -1);
    expect(await sessions.find(expired)).toBeNull();
  });

  it('creates and seeds the pages table (About)', async () => {
    const { rows } = await pool.query(
      `SELECT locale, title, body_markdown FROM pages WHERE key='about' ORDER BY locale`,
    );
    expect(rows.map((r) => r.locale)).toEqual(['de', 'en']);
    const de = rows.find((r) => r.locale === 'de');
    expect(de.title).toBe('Über mich');
    expect(de.body_markdown).toContain('Leidenschaft');
  });
});

maybe('pgPostStore (integration)', () => {
  it('round-trips a pair, publishes, and enforces slug immutability', async () => {
    const pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    const store = pgPostStore(pool);
    const stops = [{ name: 'Athen', lat: 37.98, lng: 23.73 }, { name: 'Rhodos', lat: 36.43, lng: 28.22 }];
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 }, stops },
      de: { locale: 'de' as const, slug: 'de-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
      en: { locale: 'en' as const, slug: 'en-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    };
    const created = await store.upsertDraft(base);
    expect((await store.get(created.translationKey))?.de.slug).toBe('de-slug');
    // stops survive the jsonb round-trip (writeLocale → rowShared)
    expect((await store.get(created.translationKey))?.shared.stops).toEqual(stops);
    await store.publish(created.translationKey);
    expect((await store.get(created.translationKey))?.status).toBe('published');
    expect((await store.get(created.translationKey))?.shared.stops).toEqual(stops);
    await expect(store.upsertDraft({ ...created, status: 'published', de: { ...base.de, slug: 'renamed' } })).rejects.toThrow();
    await pool.end();
  });
});
