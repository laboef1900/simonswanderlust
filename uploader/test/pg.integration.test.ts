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
      de: { locale: 'de' as const, slug: 'de-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />', images: {} },
      en: { locale: 'en' as const, slug: 'en-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    };
    const created = await store.upsertDraft(base);
    const fetched = await store.get(created.translationKey);
    expect(fetched?.de.slug).toBe('de-slug');
    // pasted <BodyImage> tags are normalized to markdown images in the stored row
    expect(fetched?.de.bodyMarkdown).toBe('## b\n\n![Gasse](https://img/x/y)');
    expect(fetched?.de.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
    // stops survive the jsonb round-trip (writeLocale → rowShared)
    expect(fetched?.shared.stops).toEqual(stops);
    await store.publish(created.translationKey);
    expect((await store.get(created.translationKey))?.status).toBe('published');
    expect((await store.get(created.translationKey))?.shared.stops).toEqual(stops);
    await expect(store.upsertDraft({ ...created, status: 'published', de: { ...base.de, slug: 'renamed' } })).rejects.toThrow();
    // writeLocale normalizes an empty stops array to NULL, so it reads back as absent (not [])
    await store.upsertDraft({ ...created, shared: { ...created.shared, stops: [] } });
    expect((await store.get(created.translationKey))?.shared.stops).toBeUndefined();
    await pool.end();
  });

  it('publish snapshots the working copy; later draft saves leave the snapshot untouched', async () => {
    const pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    const store = pgPostStore(pool);
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: { locale: 'de' as const, slug: 'snap-de', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## live', images: {} },
      en: { locale: 'en' as const, slug: 'snap-en', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## live', images: {} },
    };
    const created = await store.upsertDraft(base);
    const tk = created.translationKey;
    expect(created.hasUnpublishedChanges).toBe(false); // drafts have nothing published to diverge from

    await store.publish(tk);
    const snapshotDe = async () => (await pool.query(
      `SELECT published_snapshot AS s, published_at AS p FROM posts WHERE translation_key=$1 AND locale='de'`, [tk],
    )).rows[0];
    let row = await snapshotDe();
    expect(row.p).toBeInstanceOf(Date);
    expect(row.s.body_markdown).toBe('## live');
    expect(row.s.date).toBe('2024-10-03'); // jsonb round-trip keeps the calendar date as text
    expect(row.s.slug).toBe('snap-de');
    expect(row.s.hero_image).toEqual(base.de.heroImage);
    expect((await store.get(tk))?.hasUnpublishedChanges).toBe(false);

    // Draft save over the published post: working copy changes, snapshot must not.
    await store.upsertDraft({ ...created, de: { ...base.de, bodyMarkdown: '## edited' } });
    const got = await store.get(tk);
    expect(got?.status).toBe('published');
    expect(got?.de.bodyMarkdown).toBe('## edited');
    expect(got?.hasUnpublishedChanges).toBe(true);
    expect((await store.list()).find((s) => s.translationKey === tk)?.hasUnpublishedChanges).toBe(true);
    row = await snapshotDe();
    expect(row.s.body_markdown).toBe('## live');

    // Re-publish promotes the newest working copy and clears the flag.
    await store.publish(tk);
    row = await snapshotDe();
    expect(row.s.body_markdown).toBe('## edited');
    expect((await store.get(tk))?.hasUnpublishedChanges).toBe(false);
    await pool.end();
  });

  it('ensureSchema backfills published_snapshot for pre-migration published rows, idempotently', async () => {
    const pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    // Simulate a row published before the published_snapshot column existed.
    await pool.query(
      `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
         excerpt, hero_image, coordinates, body_markdown, status)
       VALUES (gen_random_uuid(), 'legacy-tk', 'de', 'legacy-de', 'T', '2024-10-03', 'X', 'RO', 'europe',
         'e', '{"src":"https://i/h","width":10,"height":10,"alt":"a"}', '{"lat":1,"lng":2}', '## legacy', 'published')`,
    );
    await ensureSchema(pool);
    const first = (await pool.query(
      `SELECT published_snapshot AS s, published_at AS p, updated_at AS u FROM posts WHERE slug='legacy-de'`,
    )).rows[0];
    expect(first.s.body_markdown).toBe('## legacy');
    expect(first.s.date).toBe('2024-10-03');
    expect(first.p.getTime()).toBe(first.u.getTime()); // backfilled published_at := updated_at

    // A later working-copy edit + another ensureSchema run must NOT re-backfill.
    await pool.query(`UPDATE posts SET body_markdown='## edited after backfill' WHERE slug='legacy-de'`);
    await ensureSchema(pool);
    const second = (await pool.query(
      `SELECT published_snapshot AS s, published_at AS p FROM posts WHERE slug='legacy-de'`,
    )).rows[0];
    expect(second.s.body_markdown).toBe('## legacy');
    expect(second.p.getTime()).toBe(first.p.getTime());
    await pool.end();
  });
});
