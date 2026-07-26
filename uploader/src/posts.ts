import { randomUUID } from 'node:crypto';
import { imagesMapError, normalizeGalleryFences, type ImageMeta } from './body-content.js';

export type Locale = 'de' | 'en';
export interface HeroImage { src: string; width: number; height: number; alt: string }
/**
 * Intrinsic dimensions plus the optional gallery alt/caption — see
 * `body-content.ts`, the single source of truth for the shape. Kept as a local
 * alias because `ImageDims` is the name the rest of the uploader already uses.
 */
export type ImageDims = ImageMeta;
export interface PostLocale {
  locale: Locale; slug: string; title: string; excerpt: string;
  heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims>;
}
export interface PostShared {
  date: string; country: string; countryCode: string; region: string;
  coordinates: { lat: number; lng: number };
  stops?: { name: string; lat: number; lng: number }[]; route?: string;
  keyFacts?: Record<string, string>;
}
export interface PostPair {
  translationKey: string; status: 'draft' | 'published';
  shared: PostShared; de: PostLocale; en: PostLocale;
}
/**
 * A stored pair as returned by get()/upsertDraft(): the WORKING copy (what the
 * editor edits) plus `hasUnpublishedChanges` — true when a published post has
 * draft edits saved after its last Publish (the live site keeps serving the
 * published snapshot until the next Publish; see issue #20) — and `updatedAt`,
 * which the editor echoes back on save for optimistic concurrency (issue #28).
 */
export interface StoredPostPair extends PostPair { hasUnpublishedChanges: boolean; updatedAt: Date }
/** Whole-pair snapshot of the working copy just BEFORE a save overwrote it (issue #28). */
export type RevisionSnapshot = Pick<PostPair, 'status' | 'shared' | 'de' | 'en'>;
export interface RevisionSummary {
  id: string; savedAt: Date; titleDe: string; status: 'draft' | 'published';
}
export interface PostRevision extends RevisionSummary { snapshot: RevisionSnapshot }

/** How many revisions upsertDraft keeps per translation_key (oldest pruned first). */
export const REVISION_CAP = 20;
export interface PostSummary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: 'draft' | 'published'; updatedAt: Date; hasUnpublishedChanges: boolean;
  /** EN-completeness hint for the write-DE-first workflow (true when the EN body is non-blank). */
  hasEnBody: boolean;
  /**
   * Hero base URL and its INTRINSIC width, for the list thumbnail. Both are
   * needed: `src` carries no width/format suffix and `variantWidths()` never
   * upscales, so a hero narrower than 640px has no `-640.webp` — only
   * `-<intrinsicWidth>.webp`. The client picks `min(640, heroWidth)`.
   * @ai-warning `heroSrc` is `''` for a draft that has no hero yet — there are
   * TWO independent sources of that placeholder (`PLACEHOLDER_HERO` here and a
   * separate one in `wp-import.ts`), so the UI must render a placeholder cell
   * rather than emitting `<img src="-640.webp">`. `heroWidth` comes from
   * untyped jsonb and nothing verifies it, so treat it as a hint.
   */
  heroSrc: string; heroWidth: number;
  /** Shared trip metadata, for the list's filters and sort. */
  date: string; country: string; region: string;
}
/** One stored locale row's image-referencing fields — the corpus for media usage scans. */
export interface PostUsageRow {
  translationKey: string; title: string;
  heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims>;
}
export class PostError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<StoredPostPair | null>;
  /**
   * Create or overwrite the working copy. When `baseUpdatedAt` is given (the
   * `updatedAt` the editor loaded), the save is rejected with PostError code
   * 'conflict' if the stored pair was modified since — optimistic concurrency.
   * Omitting it skips the check (new posts, WP importer). Every overwrite of
   * an existing pair first snapshots the pre-save state into the revisions.
   */
  upsertDraft(pair: PostPair, baseUpdatedAt?: Date): Promise<StoredPostPair>;
  publish(translationKey: string): Promise<void>;
  /** Flip a pair back to draft (the "emergency brake" — the live site drops it on the next build). */
  unpublish(translationKey: string): Promise<void>;
  /** Hard-delete both locale rows, freeing their slugs for reuse. */
  remove(translationKey: string): Promise<void>;
  /**
   * Every stored locale row, regardless of locale pairing. Image-usage scans
   * must use this instead of list()+get(): pgPostStore.get() returns null for
   * a key with only one locale row (upsertDraft writes de and en as two
   * non-transactional INSERTs, so a crash in between strands one), and such a
   * row's image references must still count as usage.
   */
  usageRows(): Promise<PostUsageRow[]>;
  /** Revision summaries for a post, newest first (at most REVISION_CAP). */
  listRevisions(translationKey: string): Promise<RevisionSummary[]>;
  /** One full revision snapshot, or null for an unknown (or malformed) id. */
  getRevision(translationKey: string, id: string): Promise<PostRevision | null>;
}

/**
 * Optimistic-concurrency check: throw 'conflict' when the stored pair changed
 * after the state the caller loaded.
 * @ai-warning Compare in JS on Dates only — never SQL-side. Postgres stores
 * timestamptz at µs precision but node-postgres parses it to a ms-precision JS
 * Date, so both sides here went through the SAME truncation; a SQL comparison
 * against the echoed value would false-conflict on every innocent save.
 */
function assertNotStale(storedUpdatedAt: Date, baseUpdatedAt: Date | undefined): void {
  if (baseUpdatedAt && storedUpdatedAt.getTime() > baseUpdatedAt.getTime()) {
    throw new PostError('post was modified since you opened it', 'conflict');
  }
}

interface Stored extends PostPair {
  updatedAt: Date;
  publishedAt?: Date;
  // Deep-cloned copy of { shared, de, en } as of the last publish() — mirrors
  // the pg store's published_snapshot column so both stores share semantics.
  publishedSnapshot?: Pick<PostPair, 'shared' | 'de' | 'en'>;
  // Explicit flag (instead of comparing updatedAt > publishedAt like the pg
  // store) because Date's millisecond resolution makes a publish-then-save
  // within the same tick indistinguishable in-process.
  hasUnpublishedChanges: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REGIONS = ['europe', 'north-america', 'south-america'];

/** True for a slug safe to use in a URL and as a storage path segment. */
export function isSafeSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function checkSlug(slug: string): void {
  if (!isSafeSlug(slug)) throw new PostError(`invalid slug "${slug}" (lowercase a-z, 0-9, hyphen)`);
}

export function validateDraft(pair: PostPair): void {
  if (!pair.de.title.trim()) throw new PostError('a German title is required to start a draft');
  for (const locale of ['de', 'en'] as Locale[]) {
    if (pair[locale].slug) checkSlug(pair[locale].slug);
  }
}

function validateLocale(p: PostLocale): void {
  checkSlug(p.slug);
  if (!p.title.trim()) throw new PostError(`${p.locale}: title required`);
  if (!p.excerpt.trim()) throw new PostError(`${p.locale}: excerpt required`);
  if (!p.bodyMarkdown.trim()) throw new PostError(`${p.locale}: body required`);
  if (!p.heroImage) throw new PostError(`${p.locale}: heroImage required`);
  const h = p.heroImage;
  try { new URL(h.src); } catch { throw new PostError(`${p.locale}: heroImage.src must be a URL`); }
  if (!Number.isInteger(h.width) || h.width <= 0 || !Number.isInteger(h.height) || h.height <= 0) {
    throw new PostError(`${p.locale}: heroImage needs positive integer width/height`);
  }
  if (!h.alt.trim()) throw new PostError(`${p.locale}: heroImage.alt required`);
}

export function validateForPublish(pair: PostPair): void {
  const s = pair.shared;
  if (s.countryCode.length !== 2) throw new PostError('countryCode must be 2 letters');
  if (!REGIONS.includes(s.region)) throw new PostError(`region must be one of ${REGIONS.join(', ')}`);
  if (typeof s.coordinates?.lat !== 'number' || typeof s.coordinates?.lng !== 'number') {
    throw new PostError('coordinates must be numbers');
  }
  if (!Number.isFinite(s.coordinates.lat) || s.coordinates.lat < -90 || s.coordinates.lat > 90) {
    throw new PostError('coordinates.lat must be between -90 and 90');
  }
  if (!Number.isFinite(s.coordinates.lng) || s.coordinates.lng < -180 || s.coordinates.lng > 180) {
    throw new PostError('coordinates.lng must be between -180 and 180');
  }
  // stops arrive from an unvalidated request body; check the shape here so a bad
  // waypoint fails publish with a clear message instead of inside the Astro build.
  if (s.stops !== undefined) {
    if (!Array.isArray(s.stops)) throw new PostError('stops must be an array');
    s.stops.forEach((stop, i) => {
      if (!stop || typeof stop !== 'object') throw new PostError(`stops[${i}] must be an object`);
      if (typeof stop.name !== 'string' || !stop.name.trim()) {
        throw new PostError(`stops[${i}].name must be a non-empty string`);
      }
      if (typeof stop.lat !== 'number' || !Number.isFinite(stop.lat) || stop.lat < -90 || stop.lat > 90) {
        throw new PostError(`stops[${i}].lat must be between -90 and 90`);
      }
      if (typeof stop.lng !== 'number' || !Number.isFinite(stop.lng) || stop.lng < -180 || stop.lng > 180) {
        throw new PostError(`stops[${i}].lng must be between -180 and 180`);
      }
    });
  }
  if (!s.country.trim()) throw new PostError('country required');
  if (!s.date.trim()) throw new PostError('date required');
  validateLocale(pair.de);
  validateLocale(pair.en);
}

const PLACEHOLDER_HERO: HeroImage = { src: '', width: 0, height: 0, alt: '' };

/**
 * Save-time normalization: convert pasted `<BodyImage src="…" width={…} height={…} alt="…" />`
 * tags (the MDX-export format — see export.ts bodyToMdx, its exact inverse) into markdown
 * images `![alt](src)`, merging their width/height into the locale's images map. Without
 * this the render pipeline silently strips the unknown `bodyimage` element (rehype-sanitize),
 * so MDX-backup bodies and old paste-ready snippets would publish with the photos missing.
 * Plain-markdown bodies pass through byte-identical, so re-saving is idempotent.
 * Accepted shape: a self-closing tag with `name="value"` or `name={value}` attrs
 * (export.ts is the only producer of the format). Quoted/braced attr values may span `>`,
 * `/>`, and newlines — multiline tags are accepted — and tags inside markdown code fences
 * are NOT exempt. Alt entities (`&quot; &lt; &gt; &amp;`) are decoded, the inverse of
 * export.ts escaping. Malformed tags (missing `src`, unclosed quote/brace, non-self-closing
 * `<BodyImage></BodyImage>`) are left untouched — never truncated.
 * @ai-context site/scripts/migrate-stub-posts.mjs mdxBodyToMarkdown — the original untyped
 * regex; this version is additionally quote/brace-aware so alt text containing '>' (legacy
 * exports escaped only '"') converts instead of surviving to be sanitizer-stripped.
 */
export function normalizeBodyImages(
  bodyMarkdown: string,
  images: Record<string, ImageDims>,
): { bodyMarkdown: string; images: Record<string, ImageDims> } {
  // Gallery fences first: a ```gallery line may carry `| WxH | alt="…"`
  // metadata that belongs in the images map (see body-content.ts). Its output
  // contains no <BodyImage> tags, so the two passes are independent.
  const gal = normalizeGalleryFences(bodyMarkdown, images);
  bodyMarkdown = gal.bodyMarkdown;
  const merged: Record<string, ImageDims> = { ...gal.images };
  // Attrs are consumed in disjoint chunks — "quoted", {braced}, or any char that opens
  // neither and isn't '>' — so a '>' or '/>' inside a quoted value can't terminate the tag.
  const tagRe = /<BodyImage\s+((?:"[^"]*"|\{[^}]*\}|[^>"{])*?)\/>/g;
  const normalized = bodyMarkdown.replace(tagRe, (match, attrs: string) => {
    const get = (name: string): string | undefined => {
      const quoted = attrs.match(new RegExp(`${name}="([^"]*)"`));
      if (quoted?.[1] !== undefined) return quoted[1];
      const braced = attrs.match(new RegExp(`${name}=\\{([^}]*)\\}`));
      return braced?.[1] !== undefined ? braced[1].trim() : undefined;
    };
    const src = get('src');
    if (!src) return match;
    const alt = (get('alt') ?? '') // inverse of export.ts escaping; &amp; last
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const width = Number(get('width'));
    const height = Number(get('height'));
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
      merged[src] = { width, height };
    }
    return `![${alt}](${src})`;
  });
  return { bodyMarkdown: normalized, images: merged };
}

/**
 * Fill the NOT-NULL columns the editor can omit on a partial draft save
 * (`coordinates`, `heroImage`) so a draft can never write NULL (Postgres 23502).
 * The placeholders match the WordPress-import defaults and still fail
 * `validateForPublish` until the author completes them.
 * Also normalizes pasted `<BodyImage …/>` tags and ```gallery fences, and
 * validates the `images` map — this is the single chokepoint shared by
 * memoryPostStore and pgPostStore (and the WP importer via upsertDraft).
 * @ai-warning The validation MUST live here, not in `validateDraft`: the WXR
 * importer calls `upsertDraft` directly (wp-import.ts) and never runs
 * `validateDraft`, so validation placed there alone would leave every imported
 * post's `images` map unchecked. See body-content.ts `imagesMapError` for why
 * an unchecked map is an XSS vector rather than a tidiness problem.
 */
function draftWithDefaults(pair: PostPair): PostPair {
  // The locale is passed in rather than read off `l`: a partial draft payload
  // can omit `locale` at runtime despite the TS type, and the error message
  // must still name which side failed.
  const fillLocale = (l: PostLocale, locale: Locale): PostLocale => {
    const err = imagesMapError(l.images);
    if (err) throw new PostError(`${locale}: ${err}`);
    const filled: PostLocale = {
      ...l,
      heroImage: l.heroImage ?? PLACEHOLDER_HERO,
      images: l.images ?? {},
    };
    // Partial draft payloads can omit bodyMarkdown at runtime despite the TS type.
    if (typeof filled.bodyMarkdown !== 'string') return filled;
    const n = normalizeBodyImages(filled.bodyMarkdown, filled.images);
    return { ...filled, bodyMarkdown: n.bodyMarkdown, images: n.images };
  };
  return {
    ...pair,
    shared: { ...pair.shared, coordinates: pair.shared.coordinates ?? { lat: 0, lng: 0 } },
    de: fillLocale(pair.de, 'de'),
    en: fillLocale(pair.en, 'en'),
  };
}

export function memoryPostStore(): PostStore {
  const byKey = new Map<string, Stored>();
  // Revisions per translation_key, oldest first (append order) — mirrors the
  // pg store's post_revisions table so server tests exercise the same semantics.
  const revisionsByKey = new Map<string, PostRevision[]>();
  const slugTaken = (locale: Locale, slug: string, exceptKey: string) =>
    [...byKey.values()].some((p) => p.translationKey !== exceptKey && p[locale].slug === slug);

  return {
    async list() {
      return [...byKey.values()]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((p) => {
          // DE hero with an EN fallback: the list is DE-led (titleDe), but a
          // pair may have only the EN hero filled in.
          const hero = p.de.heroImage?.src ? p.de.heroImage : p.en.heroImage;
          return {
            translationKey: p.translationKey, titleDe: p.de.title, slugDe: p.de.slug, slugEn: p.en.slug,
            status: p.status, updatedAt: p.updatedAt, hasUnpublishedChanges: p.hasUnpublishedChanges,
            hasEnBody: Boolean(p.en.bodyMarkdown && p.en.bodyMarkdown.trim()),
            heroSrc: hero?.src ?? '', heroWidth: hero?.width ?? 0,
            date: p.shared.date ?? '', country: p.shared.country ?? '', region: p.shared.region ?? '',
          };
        });
    },
    async get(tk) {
      const p = byKey.get(tk);
      return p ? structuredClone({ translationKey: p.translationKey, status: p.status, shared: p.shared, de: p.de, en: p.en, hasUnpublishedChanges: p.hasUnpublishedChanges, updatedAt: p.updatedAt }) : null;
    },
    async usageRows() {
      return [...byKey.values()].flatMap((p) => (['de', 'en'] as const).map((loc) => structuredClone({
        translationKey: p.translationKey, title: p[loc].title,
        heroImage: p[loc].heroImage, bodyMarkdown: p[loc].bodyMarkdown, images: p[loc].images,
      })));
    },
    async upsertDraft(pair, baseUpdatedAt) {
      pair = draftWithDefaults(pair);
      const key = pair.translationKey || randomUUID();
      const existing = byKey.get(key);
      if (existing) assertNotStale(existing.updatedAt, baseUpdatedAt);
      for (const locale of ['de', 'en'] as Locale[]) {
        if (slugTaken(locale, pair[locale].slug, key)) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`, 'duplicate_slug');
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) {
          throw new PostError('cannot change the slug of a published post', 'slug_locked');
        }
      }
      if (existing) {
        // Snapshot the pre-save working copy so the overwrite is recoverable.
        const revs = revisionsByKey.get(key) ?? [];
        revs.push({
          id: randomUUID(), savedAt: new Date(), titleDe: existing.de.title, status: existing.status,
          snapshot: structuredClone({ status: existing.status, shared: existing.shared, de: existing.de, en: existing.en }),
        });
        if (revs.length > REVISION_CAP) revs.splice(0, revs.length - REVISION_CAP);
        revisionsByKey.set(key, revs);
      }
      const status = existing?.status ?? 'draft';
      const stored: Stored = {
        ...structuredClone(pair), translationKey: key, status, updatedAt: new Date(),
        // Preserve the published snapshot — a draft save must never touch what is live.
        publishedAt: existing?.publishedAt, publishedSnapshot: existing?.publishedSnapshot,
        hasUnpublishedChanges: status === 'published',
      };
      byKey.set(key, stored);
      return { translationKey: key, status: stored.status, shared: stored.shared, de: stored.de, en: stored.en, hasUnpublishedChanges: stored.hasUnpublishedChanges, updatedAt: stored.updatedAt };
    },
    async publish(tk) {
      const p = byKey.get(tk);
      if (!p) throw new PostError('post not found');
      p.status = 'published';
      p.publishedSnapshot = structuredClone({ shared: p.shared, de: p.de, en: p.en });
      p.publishedAt = new Date();
      p.updatedAt = p.publishedAt;
      p.hasUnpublishedChanges = false;
    },
    async unpublish(tk) {
      const p = byKey.get(tk);
      if (!p) throw new PostError('post not found');
      p.status = 'draft';
      p.updatedAt = new Date();
    },
    async remove(tk) {
      if (!byKey.delete(tk)) throw new PostError('post not found');
    },
    async listRevisions(tk) {
      return (revisionsByKey.get(tk) ?? [])
        .map(({ id, savedAt, titleDe, status }) => ({ id, savedAt, titleDe, status }))
        .reverse(); // newest first
    },
    async getRevision(tk, id) {
      const rev = (revisionsByKey.get(tk) ?? []).find((r) => r.id === id);
      return rev ? structuredClone(rev) : null;
    },
  };
}

import { POST_SNAPSHOT_SQL, type DbPool } from './db.js';

interface PostRow {
  translation_key: string; locale: Locale; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: HeroImage; coordinates: { lat: number; lng: number };
  stops: PostShared['stops'] | null; route: string | null; key_facts: Record<string, string> | null;
  body_markdown: string; images: Record<string, ImageDims>; status: 'draft' | 'published'; updated_at: Date;
  published_at: Date | null;
}

/**
 * The columns `list()` actually needs. Deliberately NOT `SELECT *`: that also
 * pulls `body_markdown`, `images` and `published_snapshot` (a full jsonb copy
 * of the whole post) for every row, purely to build a summary — the real cost
 * behind the "when should filtering move server-side?" question the admin list
 * documents. `has_en_body` is therefore computed in SQL, since dropping the
 * bodies means it can no longer be derived in TS.
 */
interface PostListRow {
  translation_key: string; locale: Locale; slug: string; title: string;
  status: 'draft' | 'published'; updated_at: Date; published_at: Date | null;
  hero_image: HeroImage | null; date: Date | string; country: string; region: string;
  has_body: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a published row's working copy was saved after its last publish. */
function rowHasUnpublishedChanges(
  r: Pick<PostRow, 'status' | 'published_at' | 'updated_at'> | undefined,
): boolean {
  return !!r && r.status === 'published' && r.published_at !== null && r.updated_at.getTime() > r.published_at.getTime();
}

/**
 * `date` arrives as a pg Date (or as text from a published snapshot) —
 * normalize to YYYY-MM-DD.
 *
 * @ai-warning Format from the LOCAL date components, never via
 * `toISOString()`. node-postgres parses a `date` column to **local** midnight,
 * so on any deployment east of UTC (the production host is Europe/Zurich)
 * `toISOString()` reports the *previous* day — `2024-10-03` came back as
 * `2024-10-02`, and because the editor saves what it loaded, every re-save
 * walked the trip date back another day. The published site was never affected
 * (POST_SNAPSHOT_SQL formats the date with `to_char` in SQL), which is why this
 * survived unnoticed. `site/src/lib/postgres-loader.ts` documents the same
 * local-midnight behaviour from the parsing side.
 */
function dateText(date: Date | string | null | undefined): string {
  if (date instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return date ? String(date).slice(0, 10) : '';
}

function rowLocale(r: PostRow): PostLocale {
  return { locale: r.locale, slug: r.slug, title: r.title, excerpt: r.excerpt, heroImage: r.hero_image, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}
function rowShared(r: PostRow): PostShared {
  const d = dateText(r.date);
  return { date: d, country: r.country, countryCode: r.country_code, region: r.region, coordinates: r.coordinates, ...(r.stops ? { stops: r.stops } : {}), ...(r.route ? { route: r.route } : {}), ...(r.key_facts ? { keyFacts: r.key_facts } : {}) };
}

export function pgPostStore(pool: DbPool): PostStore {
  async function writeLocale(tk: string, status: string, shared: PostShared, p: PostLocale) {
    await pool.query(
      `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
         excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (locale, slug) DO UPDATE SET
         translation_key=EXCLUDED.translation_key, title=EXCLUDED.title, date=EXCLUDED.date, country=EXCLUDED.country,
         country_code=EXCLUDED.country_code, region=EXCLUDED.region, excerpt=EXCLUDED.excerpt, hero_image=EXCLUDED.hero_image,
         coordinates=EXCLUDED.coordinates, stops=EXCLUDED.stops, route=EXCLUDED.route, key_facts=EXCLUDED.key_facts,
         body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=now()`,
      [randomUUID(), tk, p.locale, p.slug, p.title, shared.date, shared.country, shared.countryCode, shared.region,
       p.excerpt, JSON.stringify(p.heroImage), JSON.stringify(shared.coordinates),
       shared.stops?.length ? JSON.stringify(shared.stops) : null, shared.route ?? null, shared.keyFacts ? JSON.stringify(shared.keyFacts) : null,
       p.bodyMarkdown, JSON.stringify(p.images), status],
    );
  }
  return {
    async list() {
      const { rows } = await pool.query<PostListRow>(
        `SELECT translation_key, locale, slug, title, status, updated_at, published_at,
                hero_image, date, country, region, btrim(body_markdown) <> '' AS has_body
           FROM posts ORDER BY updated_at DESC`,
      );
      const byKey = new Map<string, { de?: PostListRow; en?: PostListRow }>();
      for (const r of rows) { const e = byKey.get(r.translation_key) ?? {}; e[r.locale] = r; byKey.set(r.translation_key, e); }
      return [...byKey.entries()].map(([tk, e]) => {
        // DE hero with an EN fallback (the list is DE-led, but a pair can have
        // only the EN row's hero filled in — or only one locale row at all).
        const hero = e.de?.hero_image?.src ? e.de.hero_image : e.en?.hero_image;
        const shared = e.de ?? e.en;
        return {
          translationKey: tk, titleDe: e.de?.title ?? '', slugDe: e.de?.slug ?? '', slugEn: e.en?.slug ?? '',
          status: (e.de?.status ?? e.en?.status ?? 'draft') as 'draft' | 'published',
          updatedAt: new Date(Math.max(e.de?.updated_at?.getTime() ?? 0, e.en?.updated_at?.getTime() ?? 0)),
          hasUnpublishedChanges: rowHasUnpublishedChanges(e.de) || rowHasUnpublishedChanges(e.en),
          hasEnBody: Boolean(e.en?.has_body),
          heroSrc: hero?.src ?? '', heroWidth: hero?.width ?? 0,
          date: dateText(shared?.date), country: shared?.country ?? '', region: shared?.region ?? '',
        };
      });
    },
    async get(tk) {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts WHERE translation_key = $1`, [tk]);
      const de = rows.find((r) => r.locale === 'de'); const en = rows.find((r) => r.locale === 'en');
      if (!de || !en) return null;
      return {
        translationKey: tk, status: de.status, shared: rowShared(de), de: rowLocale(de), en: rowLocale(en),
        hasUnpublishedChanges: rowHasUnpublishedChanges(de) || rowHasUnpublishedChanges(en),
        // Max of both rows: writeLocale runs two statements with independent
        // now() values, so de/en updated_at can differ by a tick.
        updatedAt: new Date(Math.max(de.updated_at.getTime(), en.updated_at.getTime())),
      };
    },
    async usageRows() {
      const { rows } = await pool.query<Pick<PostRow, 'translation_key' | 'title' | 'hero_image' | 'body_markdown' | 'images'>>(
        `SELECT translation_key, title, hero_image, body_markdown, images FROM posts ORDER BY translation_key, locale`,
      );
      return rows.map((r) => ({
        translationKey: r.translation_key, title: r.title,
        heroImage: r.hero_image, bodyMarkdown: r.body_markdown, images: r.images ?? {},
      }));
    },
    async upsertDraft(pair, baseUpdatedAt) {
      pair = draftWithDefaults(pair);
      const tk = pair.translationKey || randomUUID();
      const existing = await this.get(tk);
      // @ai-note The read → check → snapshot → write sequence below is NOT
      // transactional: two saves racing within the same ms window can both
      // pass this check (single-process deployment; the losing state is still
      // recoverable via its revision). A hard guarantee would need
      // SELECT ... FOR UPDATE in one transaction — keep the timestamp compare
      // in JS if that ever happens (see assertNotStale's @ai-warning).
      if (existing) assertNotStale(existing.updatedAt, baseUpdatedAt);
      for (const locale of ['de', 'en'] as Locale[]) {
        const { rows } = await pool.query<{ translation_key: string }>(`SELECT translation_key FROM posts WHERE locale=$1 AND slug=$2`, [locale, pair[locale].slug]);
        if (rows[0] && rows[0].translation_key !== tk) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`, 'duplicate_slug');
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) throw new PostError('cannot change the slug of a published post', 'slug_locked');
      }
      if (existing) {
        // Snapshot the pre-save working copy so the overwrite is recoverable,
        // then prune to the newest REVISION_CAP per post.
        await pool.query(
          `INSERT INTO post_revisions (id, translation_key, snapshot) VALUES ($1, $2, $3)`,
          [randomUUID(), tk, JSON.stringify({ status: existing.status, shared: existing.shared, de: existing.de, en: existing.en })],
        );
        await pool.query(
          `DELETE FROM post_revisions
            WHERE translation_key = $1 AND id NOT IN (
              SELECT id FROM post_revisions WHERE translation_key = $1
               ORDER BY saved_at DESC, id DESC LIMIT $2)`,
          [tk, REVISION_CAP],
        );
      }
      const status = existing?.status ?? 'draft';
      await writeLocale(tk, status, pair.shared, { ...pair.de, locale: 'de' });
      await writeLocale(tk, status, pair.shared, { ...pair.en, locale: 'en' });
      const saved = await this.get(tk);
      if (!saved) throw new PostError('failed to save post');
      return saved;
    },
    async publish(tk) {
      // Copy the working columns into published_snapshot in the same UPDATE —
      // the snapshot (not the working row) is what the site loader builds from,
      // so later draft saves cannot leak live (issue #20). published_at and
      // updated_at are stamped with the same now(), making
      // `updated_at > published_at` (= hasUnpublishedChanges) false until the
      // next draft save bumps updated_at.
      const res = await pool.query(
        `UPDATE posts SET status='published', published_snapshot=${POST_SNAPSHOT_SQL}, published_at=now(), updated_at=now() WHERE translation_key=$1`,
        [tk],
      );
      if (res.rowCount === 0) throw new PostError('post not found');
    },
    async unpublish(tk) {
      const res = await pool.query(`UPDATE posts SET status='draft', updated_at=now() WHERE translation_key=$1`, [tk]);
      if (res.rowCount === 0) throw new PostError('post not found');
    },
    async remove(tk) {
      // One statement deletes both locale rows atomically and frees their slugs.
      const res = await pool.query(`DELETE FROM posts WHERE translation_key=$1`, [tk]);
      if (res.rowCount === 0) throw new PostError('post not found');
    },
    async listRevisions(tk) {
      // Pull only the summary fields out of the jsonb — bodies can be large.
      const { rows } = await pool.query<{ id: string; saved_at: Date; title_de: string | null; status: string }>(
        `SELECT id, saved_at, snapshot->'de'->>'title' AS title_de, snapshot->>'status' AS status
           FROM post_revisions WHERE translation_key = $1 ORDER BY saved_at DESC, id DESC`,
        [tk],
      );
      return rows.map((r) => ({
        id: r.id, savedAt: r.saved_at, titleDe: r.title_de ?? '',
        status: r.status === 'published' ? 'published' as const : 'draft' as const,
      }));
    },
    async getRevision(tk, id) {
      // Reject non-UUID ids before querying: a malformed uuid parameter raises
      // Postgres 22P02 (a logged 500) instead of the 404 the route wants.
      if (!UUID_RE.test(id)) return null;
      const { rows } = await pool.query<{ id: string; saved_at: Date; snapshot: RevisionSnapshot }>(
        `SELECT id, saved_at, snapshot FROM post_revisions WHERE translation_key = $1 AND id = $2`,
        [tk, id],
      );
      const r = rows[0];
      if (!r) return null;
      return { id: r.id, savedAt: r.saved_at, titleDe: r.snapshot.de.title, status: r.snapshot.status, snapshot: r.snapshot };
    },
  };
}
