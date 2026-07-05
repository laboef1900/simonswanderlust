import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore, UserExistsError } from '../src/users.js';
import { pgSessionStore } from '../src/sessions.js';
import { pgPostStore, PostError, REVISION_CAP } from '../src/posts.js';

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

maybe('pgPostStore revisions + optimistic concurrency (integration)', () => {
  let pool: DbPool;
  const base = (slug: string, title = 'T') => ({
    translationKey: '', status: 'draft' as const,
    shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de' as const, slug: `${slug}-de`, title, excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en' as const, slug: `${slug}-en`, title, excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });
  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM post_revisions');
    await pool.query('DELETE FROM posts');
  });
  afterAll(async () => { await pool.end(); });

  it('snapshots the pre-save pair on overwrite; echoing get().updatedAt never false-conflicts', async () => {
    const store = pgPostStore(pool);
    const created = await store.upsertDraft(base('rev'));
    const tk = created.translationKey;
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(await store.listRevisions(tk)).toHaveLength(0);

    // Round-trip guard for the timestamptz µs-vs-ms precision trap: the exact
    // Date handed out by get() must be accepted as fresh.
    const fresh = await store.get(tk);
    const saved = await store.upsertDraft({ ...created, de: { ...created.de, title: 'T2' } }, fresh!.updatedAt);
    expect(saved.de.title).toBe('T2');

    const revs = await store.listRevisions(tk);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ titleDe: 'T', status: 'draft' });
    expect(revs[0]!.savedAt).toBeInstanceOf(Date);
    const rev = await store.getRevision(tk, revs[0]!.id);
    expect(rev?.snapshot.de.title).toBe('T');
    expect(rev?.snapshot.de.bodyMarkdown).toBe('## b');
    // The snapshot stores the pre-save working copy VERBATIM — including the
    // date exactly as get() serialized it (asserting a literal here would be
    // timezone-dependent: node-postgres parses `date` columns at local midnight).
    expect(rev?.snapshot.shared).toEqual(fresh!.shared);
    // ... and the row is physically in post_revisions.
    const { rows } = await pool.query(`SELECT snapshot FROM post_revisions WHERE translation_key=$1`, [tk]);
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot.de.title).toBe('T');
  });

  it('rejects a stale baseUpdatedAt with code "conflict" and leaves the row untouched', async () => {
    const store = pgPostStore(pool);
    const created = await store.upsertDraft(base('conf'));
    const tk = created.translationKey;
    const stale = new Date(Date.now() - 3_600_000);
    const attempt = store.upsertDraft({ ...created, de: { ...created.de, title: 'clobber' } }, stale);
    await expect(attempt).rejects.toBeInstanceOf(PostError);
    await expect(store.upsertDraft({ ...created, de: { ...created.de, title: 'clobber' } }, stale))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await store.get(tk))?.de.title).toBe('T');
    expect(await store.listRevisions(tk)).toHaveLength(0); // rejected saves snapshot nothing
  });

  it('getRevision returns null for malformed (no 22P02) and unknown ids', async () => {
    const store = pgPostStore(pool);
    const created = await store.upsertDraft(base('ids'));
    await expect(store.getRevision(created.translationKey, 'not-a-uuid')).resolves.toBeNull();
    await expect(store.getRevision(created.translationKey, randomUUID())).resolves.toBeNull();
  });

  it('prunes the history to the newest REVISION_CAP snapshots', async () => {
    const store = pgPostStore(pool);
    let cur = await store.upsertDraft(base('cap', 'v1'));
    const tk = cur.translationKey;
    for (let i = 2; i <= REVISION_CAP + 6; i++) {
      cur = await store.upsertDraft({ ...cur, de: { ...cur.de, title: `v${i}` } });
    }
    const revs = await store.listRevisions(tk);
    expect(revs).toHaveLength(REVISION_CAP);
    expect(revs[0]!.titleDe).toBe(`v${REVISION_CAP + 5}`);
    expect(revs.some((r) => r.titleDe === 'v5')).toBe(false); // oldest pruned
    const count = await pool.query(`SELECT count(*)::int AS n FROM post_revisions WHERE translation_key=$1`, [tk]);
    expect(count.rows[0].n).toBe(REVISION_CAP);
  });
});
