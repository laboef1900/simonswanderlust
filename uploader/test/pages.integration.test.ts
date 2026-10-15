import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPageStore, type PagePair } from '../src/pages.js';
import { REVISION_CAP } from '../src/posts.js';

const about = (title: string): PagePair => ({
  key: 'about',
  de: { locale: 'de', title, bodyMarkdown: 'DE ' + title, images: {} },
  en: { locale: 'en', title: 'EN', bodyMarkdown: 'EN body', images: {} },
});

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('pgPageStore (Postgres)', () => {
  let pool: DbPool;
  beforeAll(async () => { pool = createPool(url as string); await ensureSchema(pool); });
  afterAll(async () => { await pool.end(); });

  it('saves and reads back both locales with images', async () => {
    const store = pgPageStore(pool);
    await store.save({
      key: 'about',
      de: { locale: 'de', title: 'DE', bodyMarkdown: '![a](https://img/x)\nDE body', images: { 'https://img/x': { width: 800, height: 600 } } },
      en: { locale: 'en', title: 'EN', bodyMarkdown: 'EN body', images: {} },
    });
    const p = await store.get('about');
    expect(p.de.title).toBe('DE');
    expect(p.de.images['https://img/x']).toEqual({ width: 800, height: 600 });
    expect(p.en.bodyMarkdown).toBe('EN body');
  });

  it('keys() lists every saved key exactly once', async () => {
    const store = pgPageStore(pool);
    // Save a second key to prove keys() is neither hardcoded nor duplicated
    // per locale row, then clean it up: backup.integration asserts exact
    // `pages` row counts against this shared database (integration files run
    // sequentially — fileParallelism: false in vitest.config.ts — so the
    // finally-cleanup is ordered before that suite reads the table).
    try {
      await store.save({
        key: 'imprint',
        de: { locale: 'de', title: 'Impressum', bodyMarkdown: 'x', images: {} },
        en: { locale: 'en', title: 'Imprint', bodyMarkdown: 'x', images: {} },
      });
      const keys = await store.keys();
      expect(keys).toContain('about');
      expect(keys.filter((k) => k === 'imprint')).toEqual(['imprint']);
    } finally {
      await pool.query(`DELETE FROM pages WHERE key = 'imprint'`);
    }
  });

  it('optimistic concurrency: a stale updatedAt echo is refused with code conflict and writes nothing (#141)', async () => {
    const store = pgPageStore(pool);
    const v1 = await store.save(about('occ-1'));
    expect(v1.updatedAt).toBeInstanceOf(Date);
    const v2 = await store.save(about('occ-2'), v1.updatedAt!);
    expect(v2.updatedAt!.getTime()).toBeGreaterThan(v1.updatedAt!.getTime());
    await expect(store.save(about('lost'), v1.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    const stored = await store.get('about');
    expect(stored.de.title).toBe('occ-2');
    expect(stored.updatedAt).toEqual(v2.updatedAt);
  });

  it('every overwrite snapshots the previous pair into page_revisions, newest first, capped (#141)', async () => {
    const store = pgPageStore(pool);
    await pool.query(`DELETE FROM page_revisions WHERE key = 'about'`);
    const before = (await store.get('about')).de.title;
    for (let i = 1; i <= REVISION_CAP + 1; i++) await store.save(about(`rev-${i}`));
    const revs = await store.listRevisions('about');
    expect(revs).toHaveLength(REVISION_CAP);
    expect(revs[0]!.titleDe).toBe(`rev-${REVISION_CAP}`);
    // The oldest survivor is rev-1 (the pre-loop state was pruned).
    expect(revs.map((r) => r.titleDe)).not.toContain(before);
    expect(revs[REVISION_CAP - 1]!.titleDe).toBe('rev-1');
    const full = await store.getRevision('about', revs[0]!.id);
    expect(full!.snapshot.de.bodyMarkdown).toBe(`DE rev-${REVISION_CAP}`);
    expect(full!.snapshot.en.bodyMarkdown).toBe('EN body');
    // Malformed id → null (no 22P02), unknown uuid → null.
    expect(await store.getRevision('about', 'not-a-uuid')).toBeNull();
    expect(await store.getRevision('about', '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
