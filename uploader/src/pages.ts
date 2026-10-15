import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import { imagesMapError, normalizeGalleryFences, type ImageMeta } from './body-content.js';
import { REVISION_CAP } from './posts.js';

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
export interface PageRevisionSummary { id: string; savedAt: Date; titleDe: string }
export interface PageRevision extends PageRevisionSummary { snapshot: PageRevisionSnapshot }

export class PageError extends Error {
  code?: 'conflict';
  constructor(message: string, code?: 'conflict') { super(message); this.code = code; }
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

export interface PageStore {
  get(key: string): Promise<StoredPagePair>;
  /**
   * Create or overwrite a page. When `baseUpdatedAt` is given (the `updatedAt`
   * the editor loaded), the save is rejected with PageError code 'conflict'
   * if the stored pair was modified since — optimistic concurrency (#141).
   * Every overwrite of an existing page first snapshots the pre-save pair
   * into the revisions (newest REVISION_CAP kept).
   */
  save(pair: PagePair, baseUpdatedAt?: Date): Promise<StoredPagePair>;
  /** All page keys that have ever been saved (either locale), sorted. */
  keys(): Promise<string[]>;
  /** Revision summaries for a page, newest first (at most REVISION_CAP). */
  listRevisions(key: string): Promise<PageRevisionSummary[]>;
  /** One full revision snapshot, or null for an unknown (or malformed) id. */
  getRevision(key: string, id: string): Promise<PageRevision | null>;
}

export function memoryPageStore(): PageStore {
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
    async save(pair, baseUpdatedAt) {
      validatePagePair(pair);
      const existing = await this.get(pair.key);
      assertPageNotStale(existing.updatedAt, baseUpdatedAt);
      const normalized = pageWithDefaults(pair);
      if (existing.updatedAt) {
        const revs = revisionsByKey.get(pair.key) ?? [];
        revs.push({ id: randomUUID(), savedAt: new Date(), titleDe: existing.de.title, snapshot: { de: existing.de, en: existing.en } });
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
    },
    async keys() {
      // Stored keys are `${key}:${locale}` and page keys cannot contain ':'.
      const all = [...byKeyLocale.keys()].map((k) => k.split(':', 1)[0] ?? k);
      return [...new Set(all)].sort();
    },
    async listRevisions(key) {
      return (revisionsByKey.get(key) ?? [])
        .map(({ id, savedAt, titleDe }) => ({ id, savedAt, titleDe }))
        .reverse(); // newest first
    },
    async getRevision(key, id) {
      const rev = (revisionsByKey.get(key) ?? []).find((r) => r.id === id);
      return rev ? structuredClone(rev) : null;
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
    async save(pair, baseUpdatedAt) {
      validatePagePair(pair);
      const existing = await this.get(pair.key);
      // Same residual as posts.upsertDraft: the read → stale-check is not
      // serialized against a racing save, so two saves inside one ms can both
      // pass; the loser's state is still in its revision.
      assertPageNotStale(existing.updatedAt, baseUpdatedAt);
      const normalized = pageWithDefaults(pair);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (existing.updatedAt) {
          await client.query(
            `INSERT INTO page_revisions (id, key, snapshot) VALUES ($1, $2, $3)`,
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
        for (const locale of ['de', 'en'] as Locale[]) {
          const c = normalized[locale];
          await client.query(
            `INSERT INTO pages (key, locale, title, body_markdown, images, updated_at)
             VALUES ($1,$2,$3,$4,$5::jsonb, now())
             ON CONFLICT (key, locale) DO UPDATE SET
               title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=now()`,
            [pair.key, locale, c.title, c.bodyMarkdown, JSON.stringify(c.images ?? {})],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return this.get(pair.key);
    },
    async keys() {
      const { rows } = await pool.query<{ key: string }>(`SELECT DISTINCT key FROM pages ORDER BY key`);
      return rows.map((r) => r.key);
    },
    async listRevisions(key) {
      // Summary fields only — bodies can be large.
      const { rows } = await pool.query<{ id: string; saved_at: Date; title_de: string | null }>(
        `SELECT id, saved_at, snapshot->'de'->>'title' AS title_de
           FROM page_revisions WHERE key = $1 ORDER BY saved_at DESC, id DESC`,
        [key],
      );
      return rows.map((r) => ({ id: r.id, savedAt: r.saved_at, titleDe: r.title_de ?? '' }));
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
      return r ? { id: r.id, savedAt: r.saved_at, titleDe: r.snapshot.de?.title ?? '', snapshot: r.snapshot } : null;
    },
  };
}
