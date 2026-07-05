import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPageStore } from '../src/pages.js';

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
});
