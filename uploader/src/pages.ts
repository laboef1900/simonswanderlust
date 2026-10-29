import { randomUUID } from 'node:crypto';
import type { DbClient, DbPool } from './db.js';
import { imagesMapError, normalizeGalleryFences, type ImageMeta } from './body-content.js';
import { REVISION_CAP } from './posts.js';
import { memoryLanguageStore, readLanguage, type LanguageStore, type LanguageState, type LanguageLocale } from './language.js';

export type Locale = 'de' | 'en';
/** See `body-content.ts` — the single source of truth for this shape. */
export type ImageDims = ImageMeta;
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims> }
export interface PagePair { key: string; de: PageContent; en: PageContent }
/**
 * A pair as read back from a store: `updatedAt` is the newer of the two locale
 * rows (null for a key never saved) and is echoed by the About editor on save
 * for optimistic concurrency (issue #141) — the same contract posts have.
 */
export interface StoredPagePair extends PagePair { updatedAt: Date | null }
/** Pre-save snapshot in the PUT-payload shape, so a restore round-trips through the editor. */
export type PageRevisionSnapshot = Pick<PagePair, 'de' | 'en'>;
export interface PageRevisionSummary { id: string; savedAt: Date; title: string }
export interface PageRevision extends PageRevisionSummary { snapshot: PageRevisionSnapshot }

type PageErrorCode = 'conflict' | 'invalid_page' | 'images_not_ready';

export class PageError extends Error {
  code?: PageErrorCode;
  constructor(message: string, code?: PageErrorCode) { super(message); this.code = code; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Optimistic-concurrency check shared by both stores. Compared in JS, not in
 * SQL, so the memory store and the pg store agree to the millisecond.
 */
function assertPageNotStale(storedUpdatedAt: Date | null, baseUpdatedAt: Date | undefined): void {
  if (storedUpdatedAt && baseUpdatedAt && storedUpdatedAt.getTime() > baseUpdatedAt.getTime()) {
    throw new PageError('page was modified since you opened it', 'conflict');
  }
}

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

export type PageUpdate = Pick<PagePair, 'key'> & Partial<Pick<PagePair, 'de' | 'en'>>;
export interface PageSaveOptions {
  prepareLocale?: LanguageLocale;
  validate?: (pair: PagePair, language: LanguageState, client?: DbClient) => Promise<void>;
}
function mergePageUpdate(update: PageUpdate, existing: StoredPagePair, language: LanguageState, options: PageSaveOptions): PagePair {
  const preparing = options.prepareLocale;
  if (preparing && (language.locales.includes(preparing) || update[language.primary] !== undefined)) {
    throw new PageError('Preparation edits only the inactive language.', 'invalid_page');
  }
  const pair = { key: update.key, de: existing.de, en: existing.en };
  for (const locale of ['de', 'en'] as const) {
    if (update[locale] !== undefined && (locale === preparing || (!preparing && language.locales.includes(locale)))) pair[locale] = update[locale]!;
  }
  validatePagePair(pair);
  return pageWithDefaults(pair);
}

export interface PageStore {
  get(key: string): Promise<StoredPagePair>;
  /**
   * Create or overwrite a page. When `baseUpdatedAt` is given (the `updatedAt`
   * the editor loaded), the save is rejected with PageError code 'conflict'
   * if the stored pair was modified since — optimistic concurrency (#141).
   * Every overwrite of an existing page first snapshots the pre-save pair
   * into the revisions (newest REVISION_CAP kept).
   */
  save(pair: PageUpdate, baseUpdatedAt?: Date, options?: PageSaveOptions): Promise<StoredPagePair>;
  /** All page keys that have ever been saved (either locale), sorted. */
  keys(): Promise<string[]>;
  /** Revision summaries for a page, newest first (at most REVISION_CAP). */
  listRevisions(key: string): Promise<PageRevisionSummary[]>;
  /** One full revision snapshot, or null for an unknown (or malformed) id. */
  getRevision(key: string, id: string): Promise<PageRevision | null>;
}

export function memoryPageStore(language: LanguageStore = memoryLanguageStore()): PageStore {
  const byKeyLocale = new Map<string, PageContent>();
  const updatedAtByKey = new Map<string, Date>();
  // Oldest first (append order) — mirrors the pg store's page_revisions table.
  const revisionsByKey = new Map<string, PageRevision[]>();
  return {
    async get(key) {
      return {
        key,
        de: structuredClone(byKeyLocale.get(`${key}:de`) ?? emptyContent('de')),
        en: structuredClone(byKeyLocale.get(`${key}:en`) ?? emptyContent('en')),
        updatedAt: updatedAtByKey.get(key) ?? null,
      };
    },
    async save(pair, baseUpdatedAt, options = {}) {
      return language.runExclusive(async (mode) => {
      const existing = await this.get(pair.key);
      if (options.prepareLocale && existing.updatedAt && !baseUpdatedAt) throw new PageError('Reload the page before preparing a translation.', 'conflict');
      assertPageNotStale(existing.updatedAt, baseUpdatedAt);
      const normalized = mergePageUpdate(pair, existing, mode, options);
      await options.validate?.(normalized, mode);
      if (existing.updatedAt) {
        const revs = revisionsByKey.get(pair.key) ?? [];
        revs.push({ id: randomUUID(), savedAt: new Date(), title: existing[mode.primary].title, snapshot: { de: existing.de, en: existing.en } });
        if (revs.length > REVISION_CAP) revs.splice(0, revs.length - REVISION_CAP);
        revisionsByKey.set(pair.key, revs);
      }
      for (const locale of ['de', 'en'] as Locale[]) {
        byKeyLocale.set(`${pair.key}:${locale}`, structuredClone({ ...normalized[locale], locale }));
      }
      // Strictly later than any echo that passed the check, even within one
      // tick — the pg store gets the same guarantee from now() in a later
      // transaction.
      const prev = existing.updatedAt?.getTime() ?? 0;
      updatedAtByKey.set(pair.key, new Date(Math.max(Date.now(), prev + 1)));
      return this.get(pair.key);
      });
    },
    async keys() {
      // Stored keys are `${key}:${locale}` and page keys cannot contain ':'.
      const all = [...byKeyLocale.keys()].map((k) => k.split(':', 1)[0] ?? k);
      return [...new Set(all)].sort();
    },
    async listRevisions(key) {
      const mode = await language.get();
      return (revisionsByKey.get(key) ?? [])
        .map(({ id, savedAt, snapshot }) => ({ id, savedAt, title: snapshot[mode.primary].title }))
        .reverse(); // newest first
    },
    async getRevision(key, id) {
      const rev = (revisionsByKey.get(key) ?? []).find((r) => r.id === id);
      const mode = await language.get();
      return rev ? structuredClone({ ...rev, title: rev.snapshot[mode.primary].title }) : null;
    },
  };
}

interface PageRow { key: string; locale: Locale; title: string; body_markdown: string; images: Record<string, ImageDims> | null; updated_at: Date }
function rowToContent(r: PageRow): PageContent {
  return { locale: r.locale, title: r.title, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}

export function pgPageStore(pool: DbPool): PageStore {
  return {
    async get(key) {
      const { rows } = await pool.query<PageRow>(
        `SELECT key, locale, title, body_markdown, images, updated_at FROM pages WHERE key = $1`, [key],
      );
      const de = rows.find((r) => r.locale === 'de');
      const en = rows.find((r) => r.locale === 'en');
      const updatedAt = rows.length ? new Date(Math.max(...rows.map((r) => r.updated_at.getTime()))) : null;
      return { key, de: de ? rowToContent(de) : emptyContent('de'), en: en ? rowToContent(en) : emptyContent('en'), updatedAt };
    },
    async save(pair, baseUpdatedAt, options = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const mode = await readLanguage(client, true);
        const { rows } = await client.query<PageRow>('SELECT key,locale,title,body_markdown,images,updated_at FROM pages WHERE key=$1 FOR UPDATE', [pair.key]);
        const existing: StoredPagePair = {
          key: pair.key,
          de: rows.find((row) => row.locale === 'de') ? rowToContent(rows.find((row) => row.locale === 'de')!) : emptyContent('de'),
          en: rows.find((row) => row.locale === 'en') ? rowToContent(rows.find((row) => row.locale === 'en')!) : emptyContent('en'),
          updatedAt: rows.length ? new Date(Math.max(...rows.map((row) => row.updated_at.getTime()))) : null,
        };
        if (options.prepareLocale && existing.updatedAt && !baseUpdatedAt) throw new PageError('Reload the page before preparing a translation.', 'conflict');
        assertPageNotStale(existing.updatedAt, baseUpdatedAt);
        const normalized = mergePageUpdate(pair, existing, mode, options);
        await options.validate?.(normalized, mode, client);
        if (existing.updatedAt) {
          await client.query(
            `INSERT INTO page_revisions (id, key, snapshot, saved_at) VALUES ($1, $2, $3, clock_timestamp())`,
            [randomUUID(), pair.key, JSON.stringify({ de: existing.de, en: existing.en })],
          );
          await client.query(
            `DELETE FROM page_revisions
              WHERE key = $1 AND id NOT IN (
                SELECT id FROM page_revisions WHERE key = $1
                 ORDER BY saved_at DESC, id DESC LIMIT $2)`,
            [pair.key, REVISION_CAP],
          );
        }
        const timestamp = await client.query<{ updated_at: Date }>(
          `SELECT GREATEST(date_trunc('milliseconds',clock_timestamp()),$1::timestamptz+interval '1 millisecond') AS updated_at`,
          [existing.updatedAt],
        );
        for (const locale of ['de', 'en'] as Locale[]) {
          const c = normalized[locale];
          await client.query(
            `INSERT INTO pages (key, locale, title, body_markdown, images, updated_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)
             ON CONFLICT (key, locale) DO UPDATE SET
               title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=EXCLUDED.updated_at`,
            [pair.key, locale, c.title, c.bodyMarkdown, JSON.stringify(c.images ?? {}), timestamp.rows[0]!.updated_at],
          );
        }
        await client.query('COMMIT');
        // The acknowledgement belongs to this commit, not a later writer's read.
        // A post-commit lookup failure must not turn a saved page into a 500.
        return { ...normalized, updatedAt: timestamp.rows[0]!.updated_at };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async keys() {
      const { rows } = await pool.query<{ key: string }>(`SELECT DISTINCT key FROM pages ORDER BY key`);
      return rows.map((r) => r.key);
    },
    async listRevisions(key) {
      // Summary fields only — bodies can be large.
      const { rows } = await pool.query<{ id: string; saved_at: Date; title: string | null }>(
        `SELECT r.id, r.saved_at, r.snapshot->l.primary_locale->>'title' AS title
           FROM page_revisions r CROSS JOIN site_language l WHERE r.key = $1 AND l.id=true ORDER BY r.saved_at DESC, r.id DESC`,
        [key],
      );
      return rows.map((r) => ({ id: r.id, savedAt: r.saved_at, title: r.title ?? '' }));
    },
    async getRevision(key, id) {
      // A malformed uuid parameter would raise 22P02 (a logged 500) instead of
      // the 404 the route wants.
      if (!UUID_RE.test(id)) return null;
      const { rows } = await pool.query<{ id: string; saved_at: Date; snapshot: PageRevisionSnapshot }>(
        `SELECT id, saved_at, snapshot FROM page_revisions WHERE key = $1 AND id = $2`,
        [key, id],
      );
      const r = rows[0];
      const mode = await readLanguage(pool);
      return r ? { id: r.id, savedAt: r.saved_at, title: r.snapshot[mode.primary]?.title ?? '', snapshot: r.snapshot } : null;
    },
  };
}
