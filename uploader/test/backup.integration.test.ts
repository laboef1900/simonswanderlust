process.env.TZ = 'Europe/Berlin';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore } from '../src/users.js';
import { pgPostStore } from '../src/posts.js';
import { pgSessionStore } from '../src/sessions.js';
import { dumpDatabase, restoreDatabase } from '../src/backup.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('backup round-trip (Postgres)', () => {
  let pool: DbPool;
  let dir: string;
  beforeAll(async () => {
    pool = createPool(url as string);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM users');
    dir = await mkdtemp(join(tmpdir(), 'bk-int-'));
  });
  afterAll(async () => { await pool.end(); });

  it('dump -> wipe -> restore reproduces users and posts and kills sessions', async () => {
    const users = pgUserStore(pool);
    const posts = pgPostStore(pool);
    const sessions = pgSessionStore(pool);
    const u = await users.create({ username: 'simon', password: 'pw', isAdmin: true });
    await sessions.create(u.id, 60_000);
    // Minimal valid draft pair — same fixture shape as the `base` fixture in
    // pg.integration.test.ts (PostPair requires both locales).
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2026-01-01', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 45, lng: 25 } },
      de: { locale: 'de' as const, slug: 'test-reise', title: 'Test', excerpt: 'x', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en' as const, slug: 'test-trip', title: 'Test', excerpt: 'x', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hello', images: {} },
    };
    const createdPair = await posts.upsertDraft(base);
    // Publish, then save a draft edit: the dump must carry BOTH the working
    // copy and the published snapshot (issue #20), or a restore would lose the
    // published/working separation. (Built from `base`, not the round-tripped
    // pair: with TZ=Europe/Berlin, rowShared's Date→string conversion shifts
    // the calendar date west, and re-saving it would poison the date column —
    // a pre-existing quirk this test deliberately keeps out of its scope.)
    await posts.publish(createdPair.translationKey);
    await posts.upsertDraft({ ...base, translationKey: createdPair.translationKey, de: { ...base.de, bodyMarkdown: 'Hallo v2' } });
    await pool.query(`INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','de','T','Body')
      ON CONFLICT (key,locale) DO UPDATE SET title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown`);

    const file = join(dir, await dumpDatabase(pool, dir));
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM pages');
    // Prove the pages are actually gone before restore, so the post-restore
    // assertion below can only pass if restoreDatabase truly re-inserts them.
    expect((await pool.query(`SELECT count(*) AS n FROM pages`)).rows[0].n).toBe('0');

    const counts = await restoreDatabase(pool, file);
    expect(counts.users).toBe(1);
    expect(counts.posts).toBe(2); // one row per locale (de + en) for the single translation pair
    // ensureSchema seeds About for both locales; we overwrote about/de to 'T' and
    // left the seeded about/en, so the dump carried — and restore re-inserts — 2 pages.
    expect(counts.pages).toBe(2);
    const back = await users.findByUsername('simon');
    expect(back?.isAdmin).toBe(true);
    expect((await pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n).toBe('0');
    const list = await posts.list();
    expect(list.length).toBe(1);
    const pg = (await pool.query(`SELECT title, body_markdown FROM pages WHERE key='about' AND locale='de'`)).rows[0];
    expect(pg.title).toBe('T');

    // Date fidelity: with TZ=Europe/Berlin, a naive `SELECT *` would parse the
    // `date` column as local midnight and JSON.stringify would shift it a day
    // west in UTC, so the restored row would carry the wrong calendar date.
    const dateText = (await pool.query("SELECT to_char(date,'YYYY-MM-DD') AS d FROM posts LIMIT 1")).rows[0].d;
    expect(dateText).toBe(base.shared.date);

    // Published-snapshot fidelity: the restored row keeps the draft edit as the
    // working copy AND the pre-edit content as the live snapshot.
    const de = (await pool.query(
      `SELECT body_markdown AS work, published_snapshot->>'body_markdown' AS live, published_at AS p
         FROM posts WHERE locale='de'`,
    )).rows[0] as { work: string; live: string; p: Date };
    expect(de.work).toBe('Hallo v2');
    expect(de.live).toBe('Hallo');
    expect(de.p).toBeInstanceOf(Date);
  });

  it('rejects an unsupported dump version without touching data', async () => {
    // hand-craft a version-3 dump (still unsupported: only v1 and v2 are handled)
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const bad = join(dir, 'db-20260101-000000.json.gz');
    writeFileSync(bad, gzipSync(JSON.stringify({ version: 3, tables: { users: [], posts: [] } })));
    await expect(restoreDatabase(pool, bad)).rejects.toThrow(/unsupported dump version/);
    expect((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe('1');
  });

  it('restores a v1 dump (no pages) without wiping existing pages', async () => {
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    await pool.query(`INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','en','keep','me')
      ON CONFLICT (key,locale) DO UPDATE SET title='keep', body_markdown='me'`);
    const v1 = join(dir, 'db-20250101-000000.json.gz');
    writeFileSync(v1, gzipSync(JSON.stringify({ version: 1, tables: { users: [], posts: [] } })));
    await restoreDatabase(pool, v1);
    const kept = (await pool.query(`SELECT title FROM pages WHERE key='about' AND locale='en'`)).rows[0];
    expect(kept.title).toBe('keep');
  });

  it('backfills published_snapshot when restoring a pre-snapshot dump, in the same transaction', async () => {
    // A dump taken BEFORE issue #20 (v2, but no published_snapshot/published_at
    // keys): its published rows must become loader-visible right after the
    // restore — the documented flow is restore → POST /rebuild with no app
    // restart, so restoreDatabase itself must run the backfill, not ensureSchema.
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const oldPost = (locale: 'de' | 'en', slug: string, status: 'draft' | 'published', body: string) => ({
      id: randomUUID(), translation_key: 'legacy-pair', locale, slug, title: 'Legacy', date: '2025-06-01',
      country: 'Peru', country_code: 'PE', region: 'south-america', excerpt: 'x',
      hero_image: { src: 'https://img.example/h', width: 100, height: 50, alt: 'a' },
      coordinates: { lat: -12, lng: -77 }, stops: null, route: null, key_facts: null,
      body_markdown: body, images: {}, status,
      created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-02T10:00:00.000Z',
    });
    const posts = [
      oldPost('de', 'legacy-reise', 'published', 'Live DE'),
      oldPost('en', 'legacy-trip', 'published', 'Live EN'),
      { ...oldPost('de', 'entwurf', 'draft', 'Draft body'), translation_key: 'legacy-draft' },
    ];
    const pre = join(dir, 'db-20260601-000000.json.gz');
    writeFileSync(pre, gzipSync(JSON.stringify({ version: 2, tables: { users: [], posts } })));

    await restoreDatabase(pool, pre);
    // Published rows are immediately visible to the site loader's query…
    const visible = await pool.query(
      `SELECT slug, published_snapshot->>'body_markdown' AS live, published_at
         FROM posts WHERE status='published' AND published_snapshot IS NOT NULL ORDER BY slug`,
    );
    expect(visible.rows.map((r) => [r.slug, r.live])).toEqual([
      ['legacy-reise', 'Live DE'],
      ['legacy-trip', 'Live EN'],
    ]);
    for (const r of visible.rows) expect(r.published_at).toBeInstanceOf(Date);
    // …while the draft row stays snapshot-less.
    const draft = (await pool.query(
      `SELECT published_snapshot, published_at FROM posts WHERE slug='entwurf'`,
    )).rows[0];
    expect(draft.published_snapshot).toBeNull();
    expect(draft.published_at).toBeNull();
  });
});
