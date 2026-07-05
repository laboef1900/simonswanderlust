import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore, verifyPassword, UserExistsError } from '../src/users.js';
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

  it('setPassword round-trips (new verifies, old does not) and throws for an unknown id', async () => {
    const users = pgUserStore(pool);
    const u = await users.create({ username: `pw${Date.now()}`, password: 'old-pw', isAdmin: false });
    await users.setPassword(u.id, 'new-pw');
    const after = await users.findByUsername(u.username);
    expect(verifyPassword('new-pw', after!.passwordHash)).toBe(true);
    expect(verifyPassword('old-pw', after!.passwordHash)).toBe(false);
    await expect(users.setPassword(randomUUID(), 'x')).rejects.toThrow('user not found');
  });

  it('destroyAllForUser removes only that user\'s sessions', async () => {
    const users = pgUserStore(pool);
    const sessions = pgSessionStore(pool);
    const u1 = await users.create({ username: `da1-${Date.now()}`, password: 'pw', isAdmin: false });
    const u2 = await users.create({ username: `da2-${Date.now()}`, password: 'pw', isAdmin: false });
    const t1a = await sessions.create(u1.id, 60_000);
    const t1b = await sessions.create(u1.id, 60_000);
    const t2 = await sessions.create(u2.id, 60_000);
    await sessions.destroyAllForUser(u1.id);
    expect(await sessions.find(t1a)).toBeNull();
    expect(await sessions.find(t1b)).toBeNull();
    expect((await sessions.find(t2))?.userId).toBe(u2.id);
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
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: { locale: 'de' as const, slug: 'de-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
      en: { locale: 'en' as const, slug: 'en-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    };
    const created = await store.upsertDraft(base);
    expect((await store.get(created.translationKey))?.de.slug).toBe('de-slug');
    await store.publish(created.translationKey);
    expect((await store.get(created.translationKey))?.status).toBe('published');
    await expect(store.upsertDraft({ ...created, status: 'published', de: { ...base.de, slug: 'renamed' } })).rejects.toThrow();
    await pool.end();
  });
});
