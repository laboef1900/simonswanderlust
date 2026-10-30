import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { memoryLanguageStore } from '../src/language.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryNavigationStore, pgNavigationStore } from '../src/navigation.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';

describe('navigation single-document contract', () => {
  it('keeps snapshots detached, serializes competing writers and invalidates an editor token on page deletion', async () => {
    const language = memoryLanguageStore();
    const row = { config: structuredClone(DEFAULT_NAVIGATION), updatedAt: new Date(0) };
    const navigation = memoryNavigationStore(language, row);
    const pages = memoryPageStore(language, { navigation: row });
    const page = await pages.save({ key: 'contact', de: { locale: 'de', slug: 'kontakt', title: 'Contact', bodyMarkdown: 'Text', images: {} } });
    const state = await navigation.get();
    state.config.header.length = 0;
    expect((await navigation.get()).config.header).toEqual(DEFAULT_NAVIGATION.header);
    const config = { ...DEFAULT_NAVIGATION, footer: [{ kind: 'page' as const, target: 'contact' as const }] };
    const writes = await Promise.allSettled([navigation.save(config, state.updatedAt.toISOString()), navigation.save(config, state.updatedAt.toISOString())]);
    expect(writes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const beforeDelete = await navigation.get();
    await pages.remove('contact', page.updatedAt!);
    expect((await navigation.get()).config.footer).toEqual([]);
    await expect(navigation.save(config, beforeDelete.updatedAt.toISOString())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retains prepared inactive fields but validates active href/label pairs against the locked mode', async () => {
    const language = memoryLanguageStore({ primary: 'de', locales: ['de'] });
    const navigation = memoryNavigationStore(language);
    const config = { ...DEFAULT_NAVIGATION, legal: [{ kind: 'external', href: { de: 'https://example.org/', en: 'https://example.org/en/' }, label: { de: 'Source' } }] };
    const saved = await navigation.save(config, (await navigation.get()).updatedAt.toISOString());
    expect(saved.config.legal[0]).toEqual(config.legal[0]);
    await expect(navigation.save({ ...DEFAULT_NAVIGATION, header: [{ kind: 'path', href: { de: '/karte/' } }] }, saved.updatedAt.toISOString())).rejects.toMatchObject({ code: 'invalid_navigation' });
    expect(await navigation.get()).toEqual(saved);
  });
});

const database = process.env.TEST_DATABASE_URL;
(database ? describe : describe.skip)('Postgres navigation transaction', () => {
  it('reads current language under the first row lock and commits only one optimistic writer', async () => {
    const schema = 'navigation_' + randomUUID().replaceAll('-', '');
    const owner = new pg.Pool({ connectionString: database });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(database!); scoped.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: scoped.toString() });
    try {
      await ensureSchema(pool);
      await pool.query("UPDATE site_language SET enabled_locales=ARRAY['de'] WHERE id=true");
      const store = pgNavigationStore(pool); const original = await store.get();
      const writers = await Promise.allSettled([store.save(DEFAULT_NAVIGATION, original.updatedAt.toISOString()), store.save(DEFAULT_NAVIGATION, original.updatedAt.toISOString())]);
      expect(writers.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const current = await store.get(); expect(current.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
      // Holding the language row blocks save before it may observe/edit site_nav.
      const gate = await pool.connect();
      try {
        await gate.query('BEGIN'); await gate.query('SELECT id FROM site_language WHERE id=true FOR UPDATE');
        const pending = store.save({ ...DEFAULT_NAVIGATION, legal: [{ kind: 'external', href: { de: 'https://example.org/', en: 'https://example.org/en/' }, label: { de: 'Source' } }] }, current.updatedAt.toISOString());
        // A nav-row NOWAIT succeeds while the other writer is waiting for language.
        await gate.query('SELECT id FROM site_nav WHERE id=1 FOR UPDATE NOWAIT');
        await gate.query("UPDATE site_language SET enabled_locales=ARRAY['de','en'] WHERE id=true");
        await gate.query('COMMIT');
        await expect(pending).rejects.toMatchObject({ code: 'invalid_navigation' });
      } finally { await gate.query('ROLLBACK'); gate.release(); }
      expect((await store.get()).config).toEqual(current.config);
      expect((await store.get()).updatedAt).toEqual(current.updatedAt);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
});
