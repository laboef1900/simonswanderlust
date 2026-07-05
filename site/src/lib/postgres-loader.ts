import type { Loader } from 'astro/loaders';
import pg from 'pg';
import { transformBodyImages, type ImageDims } from './body-images.js';

interface PostRow {
  translation_key: string; locale: 'de' | 'en'; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: { src: string; width: number; height: number; alt: string };
  coordinates: { lat: number; lng: number };
  stops: { name: string; lat: number; lng: number }[] | null; route: string | null;
  key_facts: Record<string, string> | null; body_markdown: string; images: Record<string, ImageDims>;
}

/** Pure mapping: a DB row → the { id, data, body } a loader will parse/store. */
export function rowToEntryInput(row: PostRow) {
  return {
    id: `${row.locale}/${row.slug}`,
    body: row.body_markdown,
    images: row.images ?? {},
    data: {
      title: row.title,
      date: row.date instanceof Date ? row.date : new Date(row.date),
      country: row.country,
      countryCode: row.country_code,
      region: row.region,
      translationKey: row.translation_key,
      excerpt: row.excerpt,
      heroImage: row.hero_image,
      coordinates: row.coordinates,
      ...(row.stops ? { stops: row.stops } : {}),
      ...(row.route ? { route: row.route } : {}),
      ...(row.key_facts ? { keyFacts: row.key_facts } : {}),
    },
  };
}

export function postgresTripsLoader(): Loader {
  return {
    name: 'postgres-trips',
    load: async ({ store, parseData, renderMarkdown, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      const pool = new pg.Pool({ connectionString: url });
      try {
        store.clear();
        // @ai-warning: build ONLY from the published snapshot (written by the
        // uploader's publish action — see uploader/src/db.ts POST_SNAPSHOT_SQL),
        // never from the working columns: a draft save over a published post
        // must not go live on an unrelated rebuild (issue #20). The snapshot's
        // keys mirror PostRow; `date` arrives as a 'YYYY-MM-DD' string, which
        // rowToEntryInput already handles.
        const { rows } = await pool.query<{ published_snapshot: PostRow }>(
          `SELECT published_snapshot
             FROM posts WHERE status = 'published' AND published_snapshot IS NOT NULL`,
        );
        for (const { published_snapshot: row } of rows) {
          const input = rowToEntryInput(row);
          const data = await parseData({ id: input.id, data: input.data });
          const rendered = await renderMarkdown(input.body);
          rendered.html = transformBodyImages(rendered.html, input.images);
          store.set({ id: input.id, data, body: input.body, rendered });
        }
        logger.info(`postgres-trips: loaded ${rows.length} published entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
