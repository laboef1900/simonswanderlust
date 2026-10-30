import type { Loader } from 'astro/loaders';
import { loaderPool, withLoaderSnapshot } from './loader-pool.js';
import { assertLoaderLanguage } from './build-language.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';
import { imageOrigin, retargetImageOrigins } from './images.js';
import { parseJourneySnapshot } from './journey-snapshot.js';

export interface JourneyRow { id: string; published_snapshot: unknown }

export function journeyEntries(row: JourneyRow, language: SiteLanguage, imageHost: string) {
  const snapshot = parseJourneySnapshot(row.published_snapshot);
  return language.locales.flatMap((locale) => {
    const content = snapshot.locales[locale];
    if (!content) return [];
    const { heroSrc } = retargetImageOrigins({ heroSrc: content.heroImage.src, images: {}, body: '' }, imageHost);
    return [{ id: `${locale}/${content.slug}`, data: {
      journeyId: row.id, title: content.title, intro: content.intro,
      heroImage: { ...content.heroImage, src: heroSrc }, members: snapshot.members,
    } }];
  });
}

export function postgresJourneysLoader(): Loader {
  return {
    name: 'postgres-journeys',
    load: async ({ store, parseData, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      const pool = loaderPool(url);
      const language = siteLanguage();
      try {
        const entries = await withLoaderSnapshot(pool, async (client) => {
          await assertLoaderLanguage(client, language);
          // @ai-warning Snapshot only: never join working memberships/locales or post_routes.
          const { rows } = await client.query<JourneyRow>(
            "SELECT id, published_snapshot FROM journeys WHERE status = 'published' AND published_snapshot IS NOT NULL",
          );
          return rows.flatMap((row) => journeyEntries(row, language, imageOrigin(process.env.PUBLIC_BASE_URL)));
        });
        store.clear();
        const ids = new Set<string>();
        for (const entry of entries) {
          if (ids.has(entry.id)) throw new Error('Conflicting published journey paths');
          ids.add(entry.id);
          store.set({ id: entry.id, data: await parseData(entry) });
        }
        logger.info(`postgres-journeys: loaded ${entries.length} published locale entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
