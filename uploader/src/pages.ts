import { randomUUID } from 'node:crypto';
import type { DbPool, DbClient } from './db.js';
import { imagesMapError, normalizeGalleryFences, type ImageMeta } from './body-content.js';
import { REVISION_CAP, isSafeSlug, type SaveReceipt, type SaveRead } from './posts.js';
import { memoryLanguageStore, readLanguage, LanguageError, type LanguageStore, type LanguageState, type LanguageConfig, type LanguageLocale, type LanguageBlocker } from './language.js';
import { isPageKind, PAGE_KINDS } from '../../site/src/lib/page-kinds.js';
import { namespaceOf, reservation } from '../../site/src/lib/reserved-routes.js';
import { DEFAULT_NAVIGATION, validateNavigation, pageNavReferences, withoutPageNavigation, type Navigation, type PageNavReference } from '../../site/src/lib/navigation.js';
import { lockContentNamespaces, registerMemoryClaims, memorySlugOwner, memoryStoryBodies } from './content-namespace.js';
import { analyzeBodyContent } from './publish-gate.js';
import { publicPath } from './public-paths.js';
import type { GalleryWarning } from '../public/gallery-photo-line.js';

export type Locale = 'de' | 'en';
export type ImageDims = ImageMeta;
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims>; slug?: string; publishedAt?: Date | null }
export interface PagePair { key: string; de: PageContent; en: PageContent }
export interface StoredPagePair extends PagePair { status: 'draft' | 'published'; updatedAt: Date | null }
/** Transient diagnostics from the submitted bodies, excluded from get/revisions. */
export interface SavedPagePair extends StoredPagePair { galleryWarnings: GalleryWarning[] }
export type PageRevisionSnapshot = Pick<PagePair, 'de' | 'en'>;
export interface PageRevisionSummary { id: string; savedAt: Date; title: string }
export interface PageRevision extends PageRevisionSummary { snapshot: PageRevisionSnapshot }
export type PageErrorCode = 'conflict' | 'invalid_page' | 'images_not_ready' | 'foreign_images' | 'unknown_page_kind' | 'reserved_slug' | 'page_slug_locked' | 'page_fixed' | 'not_found';
export class PageError extends Error {
  constructor(message: string, public readonly code: PageErrorCode = 'invalid_page',
    public readonly owner?: { type: string; name: string }, public readonly locale?: Locale, public readonly foreignImages?: string[]) { super(message); }
}
const LOCALES = ['de', 'en'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSafePageKey(key: string): boolean { return /^[a-z0-9][a-z0-9-]*$/.test(key); }
function emptyContent(locale: Locale): PageContent { return { locale, title: '', bodyMarkdown: '', images: {}, slug: '', publishedAt: null }; }
function emptyPair(key: string): StoredPagePair { return { key, de: emptyContent('de'), en: emptyContent('en'), status: key === 'about' ? 'published' : 'draft', updatedAt: null }; }
function assertPageNotStale(stored: Date | null, base?: Date): void {
  if (stored && base && stored.getTime() !== base.getTime()) throw new PageError('page was modified since you opened it', 'conflict');
}
export function validatePagePair(pair: PagePair): void {
  if (!isSafePageKey(pair.key)) throw new PageError('Invalid page key.');
  if (!isPageKind(pair.key)) throw new PageError('Unknown page kind.', 'unknown_page_kind');
  for (const locale of LOCALES) {
    const row = pair[locale];
    if (!row || row.locale !== locale || typeof row.title !== 'string' || typeof row.bodyMarkdown !== 'string'
      || (row.slug !== undefined && typeof row.slug !== 'string')) throw new PageError(`Invalid ${locale} page fields.`);
    const error = imagesMapError(row.images);
    if (error) throw new PageError(`${locale}: ${error}`);
    const slug = row.slug ?? '';
    if (pair.key === 'about' && slug) throw new PageError('About uses its fixed URL.', 'page_slug_locked');
    if (slug && !isSafeSlug(slug)) throw new PageError(`${locale}: invalid slug.`);
  }
}
export type PageUpdate = Pick<PagePair, 'key'> & Partial<Pick<PagePair, 'de' | 'en'>>;
export interface PageSaveOptions {
  prepareLocale?: LanguageLocale;
  receipt?: SaveReceipt;
  /** An explicit null base cannot overwrite a concurrently created page. */
  expectAbsent?: boolean;
  validate?: (pair: StoredPagePair, language: LanguageConfig, client?: DbClient) => Promise<void>;
}
export interface PageRemoval {
  key: string; titles: Record<Locale, string>; paths: string[]; revisions: number;
  navigation: PageNavReference[]; bodyReferences: number; updatedAt: Date | null; published: boolean;
}
export interface PageStore {
  configureImageOrigin(origin: string): void;
  get(key: string): Promise<StoredPagePair>;
  getForSave(key: string, ownerUserId: string): Promise<SaveRead<StoredPagePair>>;
  save(pair: PageUpdate, baseUpdatedAt?: Date, options?: PageSaveOptions): Promise<SavedPagePair>;
  publish(key: string, baseUpdatedAt?: Date, options?: PageSaveOptions): Promise<StoredPagePair>;
  unpublish(key: string, baseUpdatedAt?: Date): Promise<StoredPagePair>;
  removalInfo(key: string): Promise<PageRemoval>;
  remove(key: string, baseUpdatedAt?: Date): Promise<PageRemoval>;
  keys(): Promise<string[]>;
  listRevisions(key: string): Promise<PageRevisionSummary[]>;
  getRevision(key: string, id: string): Promise<PageRevision | null>;
  /** Called within LanguageStore.update's language-first transaction, never opens a second transaction. */
  prepareActivation(candidate: LanguageConfig, client?: DbClient, validate?: PageSaveOptions['validate']): Promise<void | (() => void)>;
}
function assignedPagePaths(pair: StoredPagePair, mode: LanguageConfig): string[] {
  if (!isPageKind(pair.key)) return [];
  return mode.locales.flatMap((locale) => pair.key === 'about' ? [publicPath(mode, locale, 'about')]
    : pair[locale].slug ? [publicPath(mode, locale, 'story', pair[locale].slug)] : []);
}
export function pagePaths(pair: StoredPagePair, mode: LanguageConfig): string[] {
  return pair.status === 'published' ? assignedPagePaths(pair, mode) : [];
}
async function mergePageUpdate(update: PageUpdate, existing: StoredPagePair, mode: LanguageConfig, options: PageSaveOptions): Promise<{ pair: StoredPagePair; galleryWarnings: GalleryWarning[] }> {
  const preparing = options.prepareLocale;
  if (preparing && (mode.locales.includes(preparing) || update[mode.primary] !== undefined)) throw new PageError('Preparation edits only the inactive language.');
  const pair = structuredClone(existing);
  for (const locale of LOCALES) {
    if (update[locale] !== undefined && (locale === preparing || (!preparing && mode.locales.includes(locale)))) {
      pair[locale] = { ...update[locale]!, slug: update[locale]!.slug ?? existing[locale].slug ?? '', publishedAt: existing[locale].publishedAt ?? null };
    }
  }
  validatePagePair(pair);
  // Save-time normalization, mirroring `draftWithDefaults` for posts: lift ```gallery
  // per-line metadata into `images`. The warnings describe the submitted bodies only.
  const galleryWarnings: GalleryWarning[] = [];
  for (const locale of LOCALES) {
    const row = pair[locale];
    if (existing[locale].publishedAt && row.slug !== existing[locale].slug) throw new PageError(`${locale}: a previously published page URL cannot change.`, 'page_slug_locked');
    const normalized = await normalizeGalleryFences(row.bodyMarkdown, row.images);
    galleryWarnings.push(...normalized.galleryWarnings.map((warning) => ({ ...warning, locale })));
    pair[locale] = { ...row, bodyMarkdown: normalized.bodyMarkdown, images: normalized.images };
  }
  return { pair, galleryWarnings };
}
/** Completeness exception applies only to About; image analysis is never exempt. */
export async function validatePublishedPage(pair: StoredPagePair, mode: LanguageConfig, imageOrigin: string): Promise<void> {
  validatePagePair(pair);
  for (const locale of mode.locales) {
    const row = pair[locale];
    if (pair.key !== 'about' && (!row.title.trim() || !row.bodyMarkdown.trim() || !row.slug)) throw new PageError(`${locale}: title, body and slug are required to publish.`, 'invalid_page', undefined, locale);
    const analyzed = await analyzeBodyContent(row.bodyMarkdown, row.images, imageOrigin, locale);
    if (analyzed.foreign.length) throw new PageError('Replace foreign body images with hosted photos before publishing.', 'foreign_images', undefined, locale, analyzed.foreign);
  }
}
function staticClaims(pair: StoredPagePair, mode: LanguageConfig): void {
  for (const locale of LOCALES) {
    const slug = pair[locale].slug ?? '';
    const owner = slug ? reservation(namespaceOf(locale, mode), slug, mode) : null;
    if (owner) throw new PageError(`${locale}: slug is reserved by ${owner.pageKind ?? owner.segment}.`, 'reserved_slug', { type: owner.pageKind ? 'page' : owner.owner, name: owner.pageKind ?? owner.segment }, locale);
  }
}
function stamp(pair: StoredPagePair, mode: LanguageConfig): void {
  if (pair.status === 'published') for (const locale of mode.locales) pair[locale].publishedAt ??= new Date();
  pair.updatedAt = new Date(Math.max(Date.now(), (pair.updatedAt?.getTime() ?? 0) + 1));
}
function removal(pair: StoredPagePair, mode: LanguageConfig, config: Navigation, revisions: number, bodies: readonly string[]): PageRemoval {
  const paths = pagePaths(pair, mode);
  // Unpublishing retains slug claims and inbound body links, but removes live paths.
  const referencedPaths = pair.status === 'published' ? paths : assignedPagePaths(pair, mode);
  return { key: pair.key, titles: { de: pair.de.title, en: pair.en.title }, paths, revisions,
    navigation: pageNavReferences(config, pair.key), bodyReferences: bodies.filter((body) => referencedPaths.some((path) => body.includes(path))).length,
    updatedAt: pair.updatedAt, published: pair.status === 'published' };
}
function fixed(key: string): void { if (key === 'about') throw new PageError('About cannot be deleted or unpublished.', 'page_fixed'); }
function requireExisting(pair: StoredPagePair): void { if (!pair.updatedAt) throw new PageError('Page not found.', 'not_found'); }
function blocker(key: string, error: unknown, mode: LanguageConfig): LanguageBlocker[] {
  if (!(error instanceof PageError)) throw error;
  return [{ key, locale: error.locale ?? mode.primary, field: error.code === 'foreign_images' || error.code === 'images_not_ready' ? 'images' : 'content', reason: error.message }];
}
export interface MemoryPageOptions { imageOrigin?: string; navigation?: { config: Navigation; updatedAt: Date }; storyBodies?: () => Promise<string[]> }
export function memoryPageStore(language: LanguageStore = memoryLanguageStore(), options: MemoryPageOptions = {}): PageStore {
  const pairs = new Map<string, StoredPagePair>();
  const receipts = new Map<string, SaveReceipt>();
  const revisions = new Map<string, PageRevision[]>();
  const nav = options.navigation ?? { config: structuredClone(DEFAULT_NAVIGATION), updatedAt: new Date(0) };
  let origin = options.imageOrigin ?? 'https://unconfigured.invalid';
  registerMemoryClaims(language, function* () { for (const pair of pairs.values()) for (const locale of LOCALES) yield { type: 'page' as const, name: pair.key, locale, slug: pair[locale].slug ?? '' }; });
  async function validate(pair: StoredPagePair, mode: LanguageConfig, extra?: PageSaveOptions['validate']): Promise<void> {
    staticClaims(pair, mode);
    for (const locale of LOCALES) {
      const claim = memorySlugOwner(language, locale, pair[locale].slug ?? '', 'page', pair.key)
        ?? memorySlugOwner(language, locale, pair[locale].slug ?? '', 'story');
      if (claim) throw new PageError(`${locale}: slug belongs to ${claim.type} ${claim.name}.`, 'reserved_slug', { type: claim.type, name: claim.name });
    }
    if (pair.status === 'published') { await validatePublishedPage(pair, mode, origin); await extra?.(pair, mode); }
  }
  async function mutate(key: string, base: Date | undefined, action: 'save' | 'publish' | 'unpublish', update?: PageUpdate, opts: PageSaveOptions = {}): Promise<SavedPagePair> {
    // The language queue serializes every memory mutation: read, stale check and
    // write cannot interleave with another save (#344).
    const receipt = action === 'save' && opts.receipt ? { ...opts.receipt } : undefined;
    return language.runExclusive(async (mode) => {
      const existing = await store.get(key);
      if (base && !existing.updatedAt) throw new PageError('Page not found.', 'not_found');
      if (action !== 'save') requireExisting(existing);
      if (action === 'unpublish') fixed(key);
      if (opts.prepareLocale && existing.updatedAt && !base) throw new PageError('Reload before preparing a translation.', 'conflict');
      if (opts.expectAbsent && existing.updatedAt) throw new PageError('The page was created since it was loaded.', 'conflict');
      assertPageNotStale(existing.updatedAt, base);
      const { pair, galleryWarnings } = await mergePageUpdate(update ?? { key }, existing, mode, opts);
      if (action !== 'save') pair.status = action === 'publish' ? 'published' : 'draft';
      // Unpublish is containment for a recovered collision or invalid live body.
      if (action !== 'unpublish') await validate(pair, mode, opts.validate);
      if (existing.updatedAt) {
        const list = revisions.get(key) ?? [];
        list.push({ id: randomUUID(), savedAt: new Date(), title: existing[mode.primary].title, snapshot: { de: existing.de, en: existing.en } });
        revisions.set(key, list.slice(-REVISION_CAP));
      }
      stamp(pair, mode); pairs.set(key, structuredClone(pair));
      if (receipt) receipts.set(key, receipt); else receipts.delete(key);
      return { ...structuredClone(pair), galleryWarnings };
    });
  }
  const store: PageStore = {
    configureImageOrigin(value) { origin = new URL(value).origin; },
    async get(key) { return structuredClone(pairs.get(key) ?? emptyPair(key)); },
    async getForSave(key, ownerUserId) {
      const content = structuredClone(pairs.get(key) ?? emptyPair(key));
      const receipt = receipts.get(key);
      return { content, ownerUserId, lastSaveId: receipt?.ownerUserId === ownerUserId ? receipt.saveId : null };
    },
    save: (pair, base, opts) => mutate(pair.key, base, 'save', pair, opts),
    publish: (key, base, opts) => mutate(key, base, 'publish', undefined, opts),
    unpublish: (key, base) => mutate(key, base, 'unpublish'),
    async keys() { return [...pairs.keys()].sort(); },
    async removalInfo(key) {
      const pair = await store.get(key); requireExisting(pair);
      return removal(pair, await language.get(), nav.config, revisions.get(key)?.length ?? 0,
        [...pairs.values()].filter((p) => p.key !== key).flatMap((p) => [p.de.bodyMarkdown, p.en.bodyMarkdown]).concat(await options.storyBodies?.() ?? memoryStoryBodies(language)));
    },
    async remove(key, base) {
      return language.runExclusive(async () => {
        fixed(key); const info = await store.removalInfo(key); assertPageNotStale(info.updatedAt, base);
        pairs.delete(key); receipts.delete(key); revisions.delete(key); nav.config = withoutPageNavigation(nav.config, key); nav.updatedAt = new Date(Math.max(Date.now(), nav.updatedAt.getTime() + 1)); return info;
      });
    },
    async listRevisions(key) {
      if (!pairs.has(key)) return [];
      const mode = await language.get();
      return (revisions.get(key) ?? []).map(({ id, savedAt, snapshot }) => ({ id, savedAt, title: snapshot[mode.primary].title })).reverse();
    },
    async getRevision(key, id) {
      if (!pairs.has(key)) return null;
      const rev = revisions.get(key)?.find((r) => r.id === id); const mode = await language.get();
      return rev ? structuredClone({ ...rev, title: rev.snapshot[mode.primary].title }) : null;
    },
    async prepareActivation(mode, _client, extra) {
      const blockers: LanguageBlocker[] = []; const candidates: StoredPagePair[] = [];
      for (const pair of pairs.values()) if (isPageKind(pair.key) && pair.status === 'published') {
        try { await validate(pair, mode, extra); candidates.push(structuredClone(pair)); }
        catch (error) { blockers.push(...blocker(pair.key, error, mode)); }
      }
      if (blockers.length) throw new LanguageError('Prepare page translations before activating this language.', 'language_pages_incomplete', blockers);
      // LanguageStore invokes this only after every transition handler has accepted.
      return () => { for (const pair of candidates) { stamp(pair, mode); pairs.set(pair.key, pair); receipts.delete(pair.key); } };
    },
  };
  return store;
}
export interface PageRow { key: string; locale: Locale; title: string; body_markdown: string; images: Record<string, ImageDims> | null; slug: string; status: 'draft' | 'published'; published_at: Date | null; updated_at: Date }
export function pagePairFromRows(key: string, rows: PageRow[]): StoredPagePair {
  const pair = emptyPair(key);
  for (const row of rows) pair[row.locale] = { locale: row.locale, title: row.title, bodyMarkdown: row.body_markdown, images: row.images ?? {}, slug: row.slug, publishedAt: row.published_at };
  if (rows.length) { pair.updatedAt = new Date(Math.max(...rows.map((r) => r.updated_at.getTime()))); pair.status = rows[0]!.status; }
  return pair;
}
async function readPage(client: DbPool | DbClient, key: string, lock = false): Promise<StoredPagePair> {
  const { rows } = await client.query<PageRow>(`SELECT * FROM pages WHERE key=$1 ORDER BY locale${lock ? ' FOR UPDATE' : ''}`, [key]);
  return pagePairFromRows(key, rows);
}
async function pgClaims(client: DbClient, pair: StoredPagePair, mode: LanguageConfig): Promise<void> {
  staticClaims(pair, mode);
  for (const locale of LOCALES) {
    const slug = pair[locale].slug;
    if (!slug) continue;
    const { rows } = await client.query<{ type: string; name: string }>(
      `SELECT 'story' AS type, translation_key AS name FROM posts WHERE locale=$1 AND (slug=$2 OR published_snapshot->>'slug'=$2)
       UNION ALL SELECT 'page', key FROM pages WHERE locale=$1 AND slug=$2 AND key<>$3 LIMIT 1`, [locale, slug, pair.key]);
    if (rows[0]) throw new PageError(`${locale}: slug belongs to ${rows[0].type} ${rows[0].name}.`, 'reserved_slug', rows[0], locale);
  }
}
export function pgPageStore(pool: DbPool, options: { imageOrigin?: string } = {}): PageStore {
  let origin = options.imageOrigin ?? 'https://unconfigured.invalid';
  async function transaction<T>(fn: (client: DbClient, mode: LanguageState) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const mode = await readLanguage(client, true); const result = await fn(client, mode); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function mutate(key: string, base: Date | undefined, action: 'save' | 'publish' | 'unpublish', update?: PageUpdate, opts: PageSaveOptions = {}): Promise<SavedPagePair> {
    const receipt = action === 'save' && opts.receipt ? { ...opts.receipt } : undefined;
    return transaction(async (client, mode) => {
      // @ai-warning (#344) `transaction` already holds the language row FOR UPDATE, so
      // every page mutation is serialized before this read. Row locks alone cannot
      // serialize two creations of a never-saved key (no row to lock); keep the
      // language lock ahead of the read, or both would pass the check and the later
      // write would erase the earlier one without a revision.
      const existing = await readPage(client, key, true);
      if (base && !existing.updatedAt) throw new PageError('Page not found.', 'not_found');
      await lockContentNamespaces(client);
      if (action !== 'save') requireExisting(existing);
      if (action === 'unpublish') fixed(key);
      if (opts.prepareLocale && existing.updatedAt && !base) throw new PageError('Reload before preparing a translation.', 'conflict');
      if (opts.expectAbsent && existing.updatedAt) throw new PageError('The page was created since it was loaded.', 'conflict');
      assertPageNotStale(existing.updatedAt, base);
      const { pair, galleryWarnings } = await mergePageUpdate(update ?? { key }, existing, mode, opts);
      if (action !== 'save') pair.status = action === 'publish' ? 'published' : 'draft';
      if (action !== 'unpublish') await pgClaims(client, pair, mode);
      if (pair.status === 'published') { await validatePublishedPage(pair, mode, origin); await opts.validate?.(pair, mode, client); }
      if (existing.updatedAt) {
        await client.query('INSERT INTO page_revisions(id,key,snapshot,saved_at) VALUES($1,$2,$3,clock_timestamp())', [randomUUID(), key, JSON.stringify({ de: existing.de, en: existing.en })]);
        await client.query('DELETE FROM page_revisions WHERE key=$1 AND id NOT IN (SELECT id FROM page_revisions WHERE key=$1 ORDER BY saved_at DESC,id DESC LIMIT $2)', [key, REVISION_CAP]);
      }
      stamp(pair, mode);
      for (const locale of LOCALES) {
        const row = pair[locale];
        await client.query(`INSERT INTO pages(key,locale,title,body_markdown,images,slug,status,published_at,updated_at,last_save_id,last_save_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(key,locale) DO UPDATE SET title=EXCLUDED.title,body_markdown=EXCLUDED.body_markdown,images=EXCLUDED.images,
          slug=EXCLUDED.slug,status=EXCLUDED.status,published_at=EXCLUDED.published_at,updated_at=EXCLUDED.updated_at,
          last_save_id=EXCLUDED.last_save_id,last_save_by=EXCLUDED.last_save_by`,
        [key, locale, row.title, row.bodyMarkdown, JSON.stringify(row.images), row.slug ?? '', pair.status, row.publishedAt, pair.updatedAt,
          receipt?.saveId ?? null, receipt?.ownerUserId ?? null]);
      }
      return { ...pair, galleryWarnings };
    });
  }
  async function info(client: DbPool | DbClient, key: string, mode: LanguageConfig): Promise<PageRemoval> {
    const pair = await readPage(client, key); requireExisting(pair);
    const nav = await client.query<{ config: Navigation }>('SELECT config FROM site_nav WHERE id=1');
    const revs = await client.query<{ count: string }>('SELECT count(*) FROM page_revisions WHERE key=$1', [key]);
    const bodies = await client.query<{ body: string }>(`SELECT body_markdown AS body FROM posts UNION ALL SELECT published_snapshot->>'body_markdown' FROM posts WHERE published_snapshot IS NOT NULL UNION ALL SELECT body_markdown FROM pages WHERE key<>$1`, [key]);
    return removal(pair, mode, validateNavigation(nav.rows[0]?.config), Number(revs.rows[0]!.count), bodies.rows.map((r) => r.body ?? ''));
  }
  const store: PageStore = {
    configureImageOrigin(value) { origin = new URL(value).origin; },
    get: (key) => readPage(pool, key),
    async getForSave(key, ownerUserId) {
      const { rows } = await pool.query<PageRow & { last_save_id: string | null; last_save_by: string | null }>(
        'SELECT * FROM pages WHERE key=$1 ORDER BY locale', [key]);
      const receipt = rows[0];
      const lastSaveId = receipt?.last_save_by === ownerUserId
        && rows.every(row => row.last_save_by === ownerUserId && row.last_save_id === receipt.last_save_id)
        ? receipt.last_save_id : null;
      return { content: pagePairFromRows(key, rows), ownerUserId, lastSaveId };
    },
    save: (pair, base, opts) => mutate(pair.key, base, 'save', pair, opts),
    publish: (key, base, opts) => mutate(key, base, 'publish', undefined, opts),
    unpublish: (key, base) => mutate(key, base, 'unpublish'),
    async keys() { return (await pool.query<{ key: string }>('SELECT DISTINCT key FROM pages ORDER BY key')).rows.map((r) => r.key); },
    async removalInfo(key) { return transaction((client, mode) => info(client, key, mode)); },
    async remove(key, base) {
      return transaction(async (client, mode) => {
        fixed(key); await readPage(client, key, true); await lockContentNamespaces(client);
        const result = await info(client, key, mode); assertPageNotStale(result.updatedAt, base);
        const nav = await client.query<{ config: Navigation }>('SELECT config FROM site_nav WHERE id=1 FOR UPDATE');
        await client.query('DELETE FROM pages WHERE key=$1', [key]);
        await client.query('DELETE FROM page_revisions WHERE key=$1', [key]);
        await client.query("UPDATE site_nav SET config=$1,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 millisecond') WHERE id=1", [JSON.stringify(withoutPageNavigation(validateNavigation(nav.rows[0]?.config), key))]);
        return result;
      });
    },
    async listRevisions(key) {
      const { rows } = await pool.query<{ id: string; saved_at: Date; title: string }>(`SELECT r.id,r.saved_at,r.snapshot->l.primary_locale->>'title' AS title FROM page_revisions r CROSS JOIN site_language l
        WHERE r.key=$1 AND l.id=true AND EXISTS(SELECT 1 FROM pages WHERE key=r.key) ORDER BY r.saved_at DESC,r.id DESC`, [key]);
      return rows.map((r) => ({ id: r.id, savedAt: r.saved_at, title: r.title ?? '' }));
    },
    async getRevision(key, id) {
      if (!UUID_RE.test(id)) return null;
      const { rows } = await pool.query<{ id: string; saved_at: Date; snapshot: PageRevisionSnapshot; title: string }>(`SELECT r.id,r.saved_at,r.snapshot,r.snapshot->l.primary_locale->>'title' AS title FROM page_revisions r CROSS JOIN site_language l
        WHERE r.key=$1 AND r.id=$2 AND l.id=true AND EXISTS(SELECT 1 FROM pages WHERE key=r.key)`, [key, id]);
      const row = rows[0]; return row ? { id: row.id, savedAt: row.saved_at, snapshot: row.snapshot, title: row.title ?? '' } : null;
    },
    async prepareActivation(mode, client, extra) {
      if (!client) throw new Error('Page activation requires the language transaction.');
      const rows = (await client.query<PageRow>("SELECT * FROM pages WHERE status='published' ORDER BY key,locale FOR UPDATE")).rows;
      await lockContentNamespaces(client);
      const blockers: LanguageBlocker[] = [];
      for (const key of new Set(rows.map((row) => row.key))) if (isPageKind(key)) {
        const pair = pagePairFromRows(key, rows.filter((r) => r.key === key));
        try { await pgClaims(client, pair, mode); await validatePublishedPage(pair, mode, origin); await extra?.(pair, mode, client); }
        catch (error) { blockers.push(...blocker(key, error, mode)); }
      }
      if (blockers.length) throw new LanguageError('Prepare page translations before activating this language.', 'language_pages_incomplete', blockers);
      const changed = await client.query<{ key: string }>(`UPDATE pages SET published_at=COALESCE(published_at,clock_timestamp()),
        updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 millisecond') WHERE status='published' AND key=ANY($1::text[]) AND locale=ANY($2::text[]) AND published_at IS NULL RETURNING key`, [Object.keys(PAGE_KINDS), mode.locales]);
      if (changed.rows.length) await client.query('UPDATE pages SET last_save_id=NULL,last_save_by=NULL WHERE key=ANY($1::text[])',
        [[...new Set(changed.rows.map(row => row.key))]]);
    },
  };
  return store;
}
