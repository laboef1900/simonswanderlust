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

  it('keys() lists saved page keys', async () => {
    // Assert against 'about' (seeded by ensureSchema and saved above) rather than
    // inserting a new key: other integration suites (backup) share this database
    // and assert exact `pages` row counts.
    const store = pgPageStore(pool);
    expect(await store.keys()).toContain('about');
  });
});
