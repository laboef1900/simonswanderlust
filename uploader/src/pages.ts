import type { DbPool } from './db.js';

export type Locale = 'de' | 'en';
export interface ImageDims { width: number; height: number }
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
  }
}

export interface PageStore {
  get(key: string): Promise<PagePair>;
  save(pair: PagePair): Promise<PagePair>;
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
      for (const locale of ['de', 'en'] as Locale[]) {
        byKeyLocale.set(`${pair.key}:${locale}`, structuredClone({ ...pair[locale], locale }));
      }
      return this.get(pair.key);
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
      for (const locale of ['de', 'en'] as Locale[]) {
        const c = pair[locale];
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
  };
}
