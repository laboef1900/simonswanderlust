import type { Loader } from 'astro/loaders';
import { loaderPool, withLoaderSnapshot } from './loader-pool.js';
import { foreignBodyImageSources, transformBodyImages, type ImageDims } from './body-images.js';
import { imageOrigin, retargetImageOrigins } from './images.js';
import { siteLanguage } from './site-language.js';
import { assertLoaderLanguage } from './build-language.js';
import { PAGE_KINDS } from './page-kinds.js';
import { pageDataSchema, publishedPageRows } from './page-content.js';

interface PageRow {
  key: string; locale: 'de' | 'en'; slug: string; title: string; body_markdown: string;
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
    data: pageDataSchema.parse({ key: row.key, locale: row.locale, slug: row.slug, title: row.title }),
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
      const pool = loaderPool(url);
      const language = siteLanguage();
      try {
        store.clear();
        const { rows } = await withLoaderSnapshot(pool, async (client) => {
          await assertLoaderLanguage(client, language);
          return client.query(
            'SELECT key, locale, slug, status, title, body_markdown, images FROM pages WHERE status = $1 AND key = ANY($2::text[]) AND locale = ANY($3::text[])',
            ['published', Object.keys(PAGE_KINDS), language.locales],
          );
        });
        const enabledRows = publishedPageRows(rows, language.locales);
        for (const row of enabledRows) {
          // Analyze the original, sanitized body before portability rewrites or image resolution.
          const rendered = await renderMarkdown(row.body_markdown);
          if (foreignBodyImageSources(rendered.html, galleryOrigin).length) {
            throw new Error(`Unsafe published page images: ${row.key}/${row.locale}`);
          }
          const input = rowToPageEntry(row, galleryOrigin);
          const data = await parseData({ id: input.id, data: input.data });
          if (input.body !== row.body_markdown) Object.assign(rendered, await renderMarkdown(input.body));
          rendered.html = transformBodyImages(rendered.html, input.images, galleryOrigin);
          store.set({ id: input.id, data, body: input.body, rendered });
        }
        logger.info(`postgres-pages: loaded ${enabledRows.length} entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
