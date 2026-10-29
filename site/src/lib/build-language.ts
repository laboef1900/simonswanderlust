import type pg from 'pg';
import { loaderPool, withLoaderSnapshot } from './loader-pool.js';
import { languageSchema, parseLanguageSnapshot, type SiteLanguage } from './site-language.js';

export async function readDatabaseLanguage(client: pg.PoolClient): Promise<SiteLanguage> {
  const { rows } = await client.query<{ primary_locale: unknown; enabled_locales: unknown }>(
    'SELECT primary_locale, enabled_locales FROM site_language WHERE id = true',
  );
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new Error('Site language is not initialized');
  return languageSchema.parse({ primary: row.primary_locale, locales: row.enabled_locales });
}

/** Reject a config/content race, including standalone development without an exported snapshot. */
export async function assertLoaderLanguage(client: pg.PoolClient, expected: SiteLanguage): Promise<void> {
  const actual = await readDatabaseLanguage(client);
  if (actual.primary !== expected.primary || actual.locales.length !== expected.locales.length
    || actual.locales.some((locale) => !expected.locales.includes(locale))) {
    throw new Error('Site language changed since configuration; restart the build or development server');
  }
}

/** The internal handoff and standalone Astro both read the same PostgreSQL truth. */
export async function resolveBuildLanguage(databaseUrl: string | undefined): Promise<SiteLanguage> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to resolve the site language');
  const supplied = process.env.SITE_LANGUAGE_JSON;
  const captured = supplied === undefined ? undefined : parseLanguageSnapshot(supplied);
  const pool = loaderPool(databaseUrl);
  try {
    const language = await withLoaderSnapshot(pool, readDatabaseLanguage);
    if (captured && JSON.stringify(captured) !== JSON.stringify(language)) {
      throw new Error('Build language does not match the database snapshot');
    }
    return language;
  } finally {
    await pool.end();
  }
}
