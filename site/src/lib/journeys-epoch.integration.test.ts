import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresJourneysLoader } from './journeys-loader';
import { postgresTripsLoader } from './postgres-loader';
import { readDatabaseLanguage } from './build-language';
import { loaderPool, withLoaderSnapshot } from './loader-pool';
import { hero } from '../../test/journey-fixtures';
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('real exported journey/story/language epoch', () => {
  it('sees one epoch across a committed member, journey and language mutation; expired imports release', async () => {
    const schema = `journey_epoch_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: databaseUrl });
    const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
    let pool: pg.Pool | undefined;
    let exporter: pg.PoolClient | undefined;
    try {
      await owner.query(`CREATE SCHEMA ${schema}`);
      pool = loaderPool(url.href);
      await pool.query(`CREATE TABLE site_language (id boolean PRIMARY KEY, primary_locale text, enabled_locales text[]);
        INSERT INTO site_language VALUES (true, 'de', ARRAY['de','en']);
        CREATE TABLE journeys (id uuid PRIMARY KEY, status text, published_snapshot jsonb);
        CREATE TABLE posts (status text, published_snapshot jsonb);
        CREATE TABLE media (key text, alt_de text, alt_en text, caption_de text, caption_en text);`);
      const snapshot = { version: 1, members: ['a'], locales: { de: { slug: 'old', title: 'Old journey', intro: 'Old intro', heroImage: hero } } };
      await pool.query('INSERT INTO journeys VALUES ($1, $2, $3)', [randomUUID(), 'published', snapshot]);
      await pool.query('INSERT INTO posts VALUES ($1, $2)', ['published', {
        translation_key: 'a', locale: 'de', slug: 'old-story', title: 'Old story', date: '2024-01-01',
        country: 'Country', country_code: 'DE', region: 'europe', excerpt: 'Old excerpt', hero_image: hero,
        coordinates: { lat: 1, lng: 2 }, body_markdown: 'Old body', images: {},
      }]);
      exporter = await pool.connect();
      await exporter.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const epoch = (await exporter.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]!.snapshot;
      // The exported snapshot is the barrier: the writer commits before any loader starts.
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("UPDATE site_language SET primary_locale='en', enabled_locales=ARRAY['en']");
        await writer.query("UPDATE posts SET status='draft', published_snapshot=published_snapshot || '{\"title\":\"NEW PRIVATE STORY\"}'::jsonb");
        await writer.query('UPDATE journeys SET published_snapshot=$1', [{ ...snapshot, members: [], locales: { en: { ...snapshot.locales.de, title: 'NEW PRIVATE JOURNEY' } } }]);
        await writer.query('COMMIT');
      } finally { writer.release(); }
      vi.stubEnv('DATABASE_URL', url.href);
      vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de","en"]}');
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', epoch);
      const read = async (loader: Loader) => {
        const entries: { id: string; data: Record<string, unknown> }[] = [];
        await loader.load({ store: { clear() {}, set(entry: { id: string; data: Record<string, unknown> }) { entries.push(entry); } },
          parseData: async ({ data }: { data: unknown }) => data,
          renderMarkdown: async (body: string) => ({ html: `<p>${body}</p>`, metadata: {} }), logger: { info() {} },
        } as unknown as Parameters<Loader['load']>[0]);
        return entries;
      };
      const [journeys, trips, language] = await Promise.all([
        read(postgresJourneysLoader()), read(postgresTripsLoader()), withLoaderSnapshot(pool, readDatabaseLanguage, epoch),
      ]);
      expect(journeys.map((entry) => [entry.id, entry.data.title, entry.data.members])).toEqual([['de/old', 'Old journey', ['a']]]);
      expect(trips.map((entry) => [entry.id, entry.data.title])).toEqual([['de/old-story', 'Old story']]);
      expect(language).toEqual({ primary: 'de', locales: ['de', 'en'] });
      await exporter.query('ROLLBACK'); exporter.release(); exporter = undefined;
      await expect(withLoaderSnapshot(pool, readDatabaseLanguage, epoch)).rejects.toThrow();
      expect(pool.idleCount).toBe(pool.totalCount);
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', undefined);
      expect(await withLoaderSnapshot(pool, readDatabaseLanguage, undefined)).toEqual({ primary: 'en', locales: ['en'] });
    } finally {
      vi.unstubAllEnvs();
      if (exporter) { await exporter.query('ROLLBACK'); exporter.release(); }
      await pool?.end();
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await owner.end();
    }
  });
});
