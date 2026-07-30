import type { Loader } from 'astro/loaders';
import pg from 'pg';
import { transformBodyImages, type ImageDims } from './body-images.js';
import { imageOrigin, retargetImageOrigins } from './images.js';

interface PageRow {
  key: string; locale: 'de' | 'en'; title: string; body_markdown: string;
  images: Record<string, ImageDims> | null;
}

/**
 * Pure mapping: a DB row → the { id, data, body } a loader will parse/store.
 * `imageHost` re-points the page's own image URLs — same reasoning as
 * `rowToEntryInput` in postgres-loader.ts, and required for the same reason.
 */
export function rowToPageEntry(row: PageRow, imageHost: string) {
  const portable = retargetImageOrigins(
    { heroSrc: '', images: row.images ?? {}, body: row.body_markdown },
    imageHost,
  );
  return {
    id: `${row.key}/${row.locale}`,
    body: portable.body,
    images: portable.images,
    data: { title: row.title },
  };
}

export function postgresPagesLoader(): Loader {
  return {
    name: 'postgres-pages',
    load: async ({ store, parseData, renderMarkdown, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      // See postgres-loader.ts: the one origin a ```gallery fence may reference.
      const galleryOrigin = imageOrigin(process.env.PUBLIC_BASE_URL);
      const pool = new pg.Pool({ connectionString: url });
      try {
        store.clear();
        const { rows } = await pool.query<PageRow>(
          `SELECT key, locale, title, body_markdown, images FROM pages`,
        );
        for (const row of rows) {
          const input = rowToPageEntry(row, galleryOrigin);
          const data = await parseData({ id: input.id, data: input.data });
          const rendered = await renderMarkdown(input.body);
          rendered.html = transformBodyImages(rendered.html, input.images, galleryOrigin);
          store.set({ id: input.id, data, body: input.body, rendered });
        }
        logger.info(`postgres-pages: loaded ${rows.length} entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
