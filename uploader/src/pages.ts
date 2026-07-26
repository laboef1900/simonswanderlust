import type { DbPool } from './db.js';
import { imagesMapError, normalizeGalleryFences, type ImageMeta } from './body-content.js';

export type Locale = 'de' | 'en';
/** See `body-content.ts` — the single source of truth for this shape. */
export type ImageDims = ImageMeta;
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims> }
export interface PagePair { key: string; de: PageContent; en: PageContent }

export class PageError extends Error {}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
export function isSafePageKey(key: string): boolean { return KEY_RE.test(key); }

function emptyContent(locale: Locale): PageContent {
  return { locale, title: '', bodyMarkdown: '', images: {} };
}

export function validatePagePair(pair: PagePair): void {
  if (!isSafePageKey(pair.key)) throw new PageError(`invalid page key "${pair.key}" (lowercase a-z, 0-9, hyphen)`);
  for (const locale of ['de', 'en'] as Locale[]) {
    if (pair[locale].locale !== locale) throw new PageError(`locale field mismatch for ${locale}`);
    // Same control as posts: `images` is author-supplied jsonb that reaches
    // the render boundary — see body-content.ts `imagesMapError`.
    const err = imagesMapError(pair[locale].images);
    if (err) throw new PageError(`${locale}: ${err}`);
  }
}

/**
 * Save-time normalization, mirroring `draftWithDefaults` for posts: lift
 * ```gallery per-line metadata into the `images` map so a page body stores the
 * canonical bare-URL fence. Runs inside `save()` in BOTH stores (after
 * `validatePagePair`), so it is the single chokepoint for page writes.
 */
function pageWithDefaults(pair: PagePair): PagePair {
  const fill = (c: PageContent): PageContent => {
    const images = c.images ?? {};
    if (typeof c.bodyMarkdown !== 'string') return { ...c, images };
    const n = normalizeGalleryFences(c.bodyMarkdown, images);
    return { ...c, bodyMarkdown: n.bodyMarkdown, images: n.images };
  };
  return { ...pair, de: fill(pair.de), en: fill(pair.en) };
}

export interface PageStore {
  get(key: string): Promise<PagePair>;
  save(pair: PagePair): Promise<PagePair>;
  /** All page keys that have ever been saved (either locale), sorted. */
  keys(): Promise<string[]>;
}

export function memoryPageStore(): PageStore {
  const byKeyLocale = new Map<string, PageContent>();
  return {
    async get(key) {
      return {
        key,
        de: structuredClone(byKeyLocale.get(`${key}:de`) ?? emptyContent('de')),
        en: structuredClone(byKeyLocale.get(`${key}:en`) ?? emptyContent('en')),
      };
    },
    async save(pair) {
      validatePagePair(pair);
      const normalized = pageWithDefaults(pair);
      for (const locale of ['de', 'en'] as Locale[]) {
        byKeyLocale.set(`${pair.key}:${locale}`, structuredClone({ ...normalized[locale], locale }));
      }
      return this.get(pair.key);
    },
    async keys() {
      // Stored keys are `${key}:${locale}` and page keys cannot contain ':'.
      const all = [...byKeyLocale.keys()].map((k) => k.split(':', 1)[0] ?? k);
      return [...new Set(all)].sort();
    },
  };
}

interface PageRow { key: string; locale: Locale; title: string; body_markdown: string; images: Record<string, ImageDims> | null }
function rowToContent(r: PageRow): PageContent {
  return { locale: r.locale, title: r.title, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}

export function pgPageStore(pool: DbPool): PageStore {
  return {
    async get(key) {
      const { rows } = await pool.query<PageRow>(
        `SELECT key, locale, title, body_markdown, images FROM pages WHERE key = $1`, [key],
      );
      const de = rows.find((r) => r.locale === 'de');
      const en = rows.find((r) => r.locale === 'en');
      return { key, de: de ? rowToContent(de) : emptyContent('de'), en: en ? rowToContent(en) : emptyContent('en') };
    },
    async save(pair) {
      validatePagePair(pair);
      const normalized = pageWithDefaults(pair);
      for (const locale of ['de', 'en'] as Locale[]) {
        const c = normalized[locale];
        await pool.query(
          `INSERT INTO pages (key, locale, title, body_markdown, images, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb, now())
           ON CONFLICT (key, locale) DO UPDATE SET
             title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=now()`,
          [pair.key, locale, c.title, c.bodyMarkdown, JSON.stringify(c.images ?? {})],
        );
      }
      return this.get(pair.key);
    },
    async keys() {
      const { rows } = await pool.query<{ key: string }>(`SELECT DISTINCT key FROM pages ORDER BY key`);
      return rows.map((r) => r.key);
    },
  };
}
