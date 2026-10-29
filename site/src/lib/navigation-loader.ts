import type { Loader } from 'astro/loaders';
import { z } from 'astro/zod';
import { DEFAULT_NAVIGATION, validateNavigation } from './navigation.js';
import { loaderPool, withLoaderSnapshot } from './loader-pool.js';
import { assertLoaderLanguage } from './build-language.js';
import { siteLanguage } from './site-language.js';

/** The exact save validator is also the Zod build refinement; no looser render parser. */
export const navigationSchema = z.unknown().transform((value, context) => {
  try { return validateNavigation(value); } catch {
    context.addIssue({ code: 'custom', message: 'Invalid site navigation document' });
    return z.NEVER;
  }
});

export function postgresNavigationLoader(): Loader {
  return {
    name: 'postgres-nav',
    load: async ({ store, parseData, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build navigation from Postgres');
      const pool = loaderPool(url);
      try {
        const config = await withLoaderSnapshot(pool, async (client) => {
          await assertLoaderLanguage(client, siteLanguage());
          // Older standalone development databases may predate the table. This is not
          // a catch-all: permission, snapshot, connection and malformed-data errors fail.
          const table = await client.query<{ present: string | null }>("SELECT to_regclass('site_nav')::text AS present");
          if (!table.rows[0]?.present) return DEFAULT_NAVIGATION;
          const { rows } = await client.query<{ config: unknown }>('SELECT config FROM site_nav WHERE id = 1');
          return rows.length ? rows[0]!.config : DEFAULT_NAVIGATION;
        });
        const data = await parseData({ id: 'site', data: { ...navigationSchema.parse(config) } });
        store.clear();
        store.set({ id: 'site', data });
        logger.info('postgres-nav: loaded navigation');
      } finally { await pool.end(); }
    },
  };
}
