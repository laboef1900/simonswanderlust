import type { Loader } from 'astro/loaders';
import { loaderPool, withLoaderSnapshot } from './loader-pool.js';
import { STORY_BODY_SIZES, bodyImageUses, transformBodyImagesWithUses, type GalleryUse, type ImageDims } from './body-images.js';
import { imageOrigin, retargetImageOrigins, type RemoteHeroImage } from './images.js';
import { siteLanguage } from './site-language.js';
import { assertLoaderLanguage } from './build-language.js';
import { PUBLISHED_SNAPSHOT_DIGEST_SQL, writeReleaseManifest, type ReleaseManifestV1 } from './publication-manifest.js';

export interface PostRow {
  translation_key: string; locale: 'de' | 'en'; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: RemoteHeroImage;
  title_image?: RemoteHeroImage | null;
  coordinates: { lat: number; lng: number };
  stops: { name: string; lat: number; lng: number }[] | null; route: string | null;
  key_facts: Record<string, string> | null; body_markdown: string; images: Record<string, ImageDims>;
  // Only published_snapshot.track, never the attached working route.
  track?: unknown;
  /**
   * "Use as homepage cover" (uploader `PostShared.featured`, column
   * `featured boolean NOT NULL DEFAULT false`). Optional here because a
   * snapshot written before the column existed simply has no key.
   */
  featured?: boolean;
}

interface MediaDescriptionRow {
  key: string;
  alt_de: string; alt_en: string;
  caption_de: string; caption_en: string;
}

/**
 * pg parses a `date` column to a LOCAL-midnight JS Date; the published-snapshot
 * jsonb carries 'YYYY-MM-DD' text instead (see POST_SNAPSHOT_SQL in
 * uploader/src/db.ts). Parse that text to the same local midnight — a bare
 * `new Date('YYYY-MM-DD')` would be UTC midnight, which `dateLabel`
 * (format.ts, toLocaleDateString without an explicit timeZone) renders as the
 * previous day/month on build machines west of UTC.
 */
function parseRowDate(date: Date | string): Date {
  if (date instanceof Date) return date;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(date);
}

/**
 * Pure mapping: a DB row → the { id, data, body } a loader will parse/store.
 *
 * `imageHost` re-points the row's own image URLs (see `retargetImageOrigins`),
 * so content imported against one origin renders against whichever origin this
 * build is configured for. Deliberately REQUIRED rather than defaulted: a
 * default would silently rewrite a caller's URLs to a hardcoded host, and this
 * mapping feeds the gallery allow-list.
 */
export function rowToEntryInput(row: PostRow, imageHost: string) {
  const portable = retargetImageOrigins(
    { heroSrc: row.hero_image?.src ?? '', titleSrc: row.title_image?.src, images: row.images ?? {}, body: row.body_markdown },
    imageHost,
  );
  return {
    id: `${row.locale}/${row.slug}`,
    body: portable.body,
    images: portable.images,
    data: {
      title: row.title,
      date: parseRowDate(row.date),
      country: row.country,
      countryCode: row.country_code,
      region: row.region,
      translationKey: row.translation_key,
      excerpt: row.excerpt,
      heroImage: { ...row.hero_image, src: portable.heroSrc },
      ...(row.title_image ? { titleImage: { ...row.title_image, src: portable.titleSrc! } } : {}),
      coordinates: row.coordinates,
      ...(row.stops ? { stops: row.stops } : {}),
      ...(row.route ? { route: row.route } : {}),
      ...(row.track !== undefined ? { track: row.track } : {}),
      ...(row.key_facts ? { keyFacts: row.key_facts } : {}),
      // Emitted only when true: the Zod field is `.optional()` and NOT
      // defaulted, so a false/absent flag must produce no key at all — that is
      // what keeps every pre-existing entry valid. Not unique either: several
      // entries may carry it and the homepage takes the newest.
      ...(row.featured ? { featured: true as const } : {}),
    },
  };
}

export interface ClassifiedRow {
  gallery: GalleryUse[];
  inline: string[];
  heroImage: RemoteHeroImage;
  titleImage?: RemoteHeroImage;
}

/**
 * Classify a fresh working or published row through the loader's own retargeting
 * and Markdown path. Occurrences stay ordered and repeated; callers count exact
 * gallery identities and base/variant inline URLs for the media item of interest.
 * Never cache this by published digest: working copies can change independently.
 */
export async function classifyRow(
  row: PostRow,
  imageOrigin: string,
  renderMarkdown: (body: string) => Promise<string>,
): Promise<ClassifiedRow> {
  const input = rowToEntryInput(row, imageOrigin);
  const uses = bodyImageUses(await renderMarkdown(input.body), input.images, imageOrigin);
  return {
    ...uses,
    heroImage: input.data.heroImage,
    ...(input.data.titleImage ? { titleImage: input.data.titleImage } : {}),
  };
}

export function postgresTripsLoader(): Loader {
  return {
    name: 'postgres-trips',
    load: async ({ store, parseData, renderMarkdown, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      // The one origin a ```gallery fence may reference. Read here (the build
      // runs in Node, same as DATABASE_URL above) and passed down explicitly,
      // so transformBodyImages stays pure and env-free for the uploader's
      // draft preview.
      // Standalone dev / CI builds without PUBLIC_BASE_URL use localhost:3000.
      // Production supplies its independent image origin; canonical blog-domain
      // changes never retarget these images.
      const galleryOrigin = imageOrigin(process.env.PUBLIC_BASE_URL);
      const pool = loaderPool(url);
      const language = siteLanguage();
      try {
        store.clear();
        // @ai-warning: article content still comes ONLY from published snapshots,
        // never working columns (#20). Current library gallery descriptions are
        // the sole approved exception; they do not mutate the stored snapshot.
        const { rows, media } = await withLoaderSnapshot(pool, async (client) => {
          await assertLoaderLanguage(client, language);
          const { rows } = await client.query<{ published_snapshot: PostRow; row_digest: string }>(
            `SELECT published_snapshot, ${PUBLISHED_SNAPSHOT_DIGEST_SQL} AS row_digest
               FROM posts WHERE status = 'published' AND published_snapshot IS NOT NULL`,
          );
          const { rows: media } = await client.query<MediaDescriptionRow>(
            'SELECT key, alt_de, alt_en, caption_de, caption_en FROM media',
          );
          return { rows, media };
        });
        const enabledRows = rows.filter(({ published_snapshot: row }) => language.locales.includes(row.locale));
        if (enabledRows.length !== rows.length) logger.info(`postgres-trips: excluded ${rows.length - enabledRows.length} disabled-locale entries`);
        const descriptions = {
          de: new Map<string, { alt: string; caption: string }>(),
          en: new Map<string, { alt: string; caption: string }>(),
        };
        for (const photo of media) {
          const src = `${galleryOrigin}/${photo.key}`;
          descriptions.de.set(src, { alt: photo.alt_de, caption: photo.caption_de });
          descriptions.en.set(src, { alt: photo.alt_en, caption: photo.caption_en });
        }
        const manifestPosts: ReleaseManifestV1['posts'] = [];
        for (const { published_snapshot: row, row_digest } of enabledRows) {
          const input = rowToEntryInput(row, galleryOrigin);
          const data = await parseData({ id: input.id, data: input.data });
          const rendered = await renderMarkdown(input.body);
          const transformed = await transformBodyImagesWithUses(rendered.html, input.images, galleryOrigin, { locale: row.locale, inlineSizes: STORY_BODY_SIZES }, descriptions[row.locale]);
          rendered.html = transformed.html;
          store.set({ id: input.id, data, body: input.body, rendered });
          manifestPosts.push({
            translationKey: row.translation_key, locale: row.locale, slug: row.slug, digest: row_digest,
            gallery: transformed.gallery.map(({ src, alt, caption }) => ({ src, alt, caption })),
          });
        }
        await writeReleaseManifest(manifestPosts, undefined, (message) => logger.warn(message));
        logger.info(`postgres-trips: loaded ${enabledRows.length} published entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
