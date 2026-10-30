import { randomUUID } from 'node:crypto';
import { heroImageError, imageMarkdown, imagesMapError, normalizeGalleryFences, rewriteOutsideGalleries, type ImageMeta } from './body-content.js';
import { lockPostPair, touchPostPair } from './post-pair-lock.js';
import { safePairHash, type GpxFiles } from './gpx-files.js';
import { enqueueRouteCleanup } from './gpx-store.js';
import { validatePublicTrack, type PublicTrack } from '../public/gpx-public-track.js';
import type { PrivateGeometry } from '../public/gpx-geometry.js';
import type { PublicTrackWorker } from './gpx-public-worker.js';
import { GpxError } from './gpx-errors.js';
import { publishedTrackOf, type PublishedTrackRow } from './published-track.js';

export type Locale = 'de' | 'en';
/**
 * @ai-warning `focus` is declared independently in the site tree as
 * `RemoteHeroImage.focus` (`site/src/lib/images.ts`) and in the Zod schema
 * (`site/src/content.config.ts`) — three declarations of one shape across two
 * tsconfigs, the same trap `ImageMeta`/`ImageDims` documents. It is optional,
 * so widening one side alone keeps both `tsc` and `astro check` green while
 * the author's focal point is silently dropped on save. The shape is
 * validated at the store chokepoint by `heroImageError`.
 */
export interface HeroImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  format?: 'jpeg';
  focus?: { x: number; y: number };
}
/**
 * Intrinsic dimensions plus the optional gallery alt/caption — see
 * `body-content.ts`, the single source of truth for the shape. Kept as a local
 * alias because `ImageDims` is the name the rest of the uploader already uses.
 */
export type ImageDims = ImageMeta;
// Only these two exist: the `posts.status` CHECK admits nothing else, and
// `upsertDraft` ignores the payload's status (Publish is a separate admin-only
// route). Scheduling/archiving was never built — see #121 for what building it
// would take. `shared.scheduledAt` below is a stored-but-unconsumed column kept
// for dump compatibility (backup.ts v4); no UI writes it.
export type PostStatus = 'draft' | 'published';
export interface PostLocale {
  locale: Locale; slug: string; title: string; excerpt: string; country: string;
  heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims>;
  titleImage?: HeroImage;
  keyFacts?: Record<string, string>;
}
export interface PostShared {
  date: string; countryCode: string; region: string;
  coordinates: { lat: number; lng: number };
  stops?: { name: string; lat: number; lng: number }[]; route?: string;
  categories?: string[];
  tags?: string[];
  scheduledAt?: string | null;
  /**
   * "Use as homepage cover": the homepage renders the NEWEST flagged published
   * story and falls back to the newest story overall when nothing is flagged.
   * @ai-note SHARED, not per-locale (issue #87's rule): a cover choice is not
   * translatable, so `upsertDraft` writes the same value to BOTH locale rows.
   * @ai-note Deliberately NOT unique — any number of posts may carry it, so
   * setting it on one post never writes to another (no cross-post mutation, no
   * race); "newest wins" resolves the ambiguity at render time.
   * @ai-warning Optional on the way IN only, exactly like `categories`/`tags`:
   * an older client and the WXR importer (wp-import.ts) build a `shared`
   * without it. `draftWithDefaults` normalizes absent → false, and both stores
   * always return a real boolean, so no reader has to handle undefined.
   */
  featured?: boolean;
  /**
   * Per-post comments toggle (comments spec, phase 1). SHARED: written to both
   * locale rows. Optional on the way in; `draftWithDefaults` normalizes an
   * absent value to true (the site-wide `settings.commentsEnabled`, default
   * false, is the real off switch).
   */
  commentsEnabled?: boolean;
}
export interface PostPair {
  translationKey: string; status: PostStatus;
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
  id: string; savedAt: Date; titleDe: string; status: PostStatus;
}
export interface PostRevision extends RevisionSummary { snapshot: RevisionSnapshot }

/** How many revisions upsertDraft keeps per translation_key (oldest pruned first). */
export const REVISION_CAP = 20;
export interface PostSummary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: PostStatus; updatedAt: Date; hasUnpublishedChanges: boolean;
  /** EN-completeness hint for the write-DE-first workflow (true when the EN body is non-blank). */
  hasEnBody: boolean;
  /**
   * Hero base URL, intrinsic width and optional JPEG-only marker for the list
   * thumbnail. Omitted format means the existing AVIF + WebP pair; the client
   * picks the smallest generated width without ever inventing another format.
   * @ai-warning `heroSrc` is `''` for a draft that has no hero yet — there are
   * TWO independent sources of that placeholder (`PLACEHOLDER_HERO` here and a
   * separate one in `wp-import.ts`), so the UI must render a placeholder cell
   * rather than emitting a variant URL. Width and format come from untyped
   * jsonb and must be treated as hints.
   */
  heroSrc: string; heroWidth: number; heroFormat?: 'jpeg';
  /** Shared trip metadata, for the list's filters and sort. */
  date: string; country: string; region: string;
  categories: string[];
  tags: string[];
  scheduledAt: string | null;
}
/**
 * One stored locale row's image-referencing fields — the corpus for media
 * usage scans. A published post contributes TWO rows per locale: its working
 * copy and its `published_snapshot`, which is what the blog is built from.
 */
export interface PostUsageRow {
  translationKey: string;
  /** Which locale's row this is. Carried explicitly so the media library's
   *  alt-text harvest can file German alt on the DE row and English on the EN
   *  row — inferring it from row order or title would collide whenever both
   *  locales share a title. */
  locale: Locale;
  /**
   * `working`: the editable columns. `published`: derived from the published
   * snapshot of a `status = 'published'` row — exactly the set the site loader
   * builds from, so a reference here is one the live site serves (or would
   * serve on the next rebuild) even after the working copy dropped it (#115).
   */
  source: 'working' | 'published';
  title: string;
  heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims>;
  titleImage?: HeroImage;
}
export class PostError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export interface PublishTokens { baseUpdatedAt: Date; baseRouteVersion: string | null }
export interface PublishState { pair: StoredPostPair; routeVersion: string | null }

/** Publish uses exact reviewed tokens, not save's older-than comparison. */
export function assertPublishTokens(state: PublishState, tokens: PublishTokens): void {
  if (!(tokens?.baseUpdatedAt instanceof Date)
    || tokens.baseUpdatedAt.getTime() !== state.pair.updatedAt.getTime()
    || tokens.baseRouteVersion !== state.routeVersion) {
    throw new PostError('post or route changed since review; reload before publishing', 'conflict');
  }
}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<StoredPostPair | null>;
  getPublishState(translationKey: string): Promise<PublishState | null>;
  getPublishedTrack(translationKey: string): Promise<PublicTrack | undefined>;
  /**
   * Create or overwrite the working copy. When `baseUpdatedAt` is given (the
   * `updatedAt` the editor loaded), the save is rejected with PostError code
   * 'conflict' if the stored pair was modified since — optimistic concurrency.
   * Omitting it skips the check (new posts, WP importer). Every overwrite of
   * an existing pair first snapshots the pre-save state into the revisions.
   */
  upsertDraft(pair: PostPair, baseUpdatedAt?: Date): Promise<StoredPostPair>;
  publish(translationKey: string, tokens: PublishTokens): Promise<{ updatedAt: Date }>;
  /** Flip a pair back to draft (the "emergency brake" — the live site drops it on the next build). */
  unpublish(translationKey: string): Promise<{ previousUpdatedAt: Date; updatedAt: Date }>;
  /** Hard-delete both locale rows, freeing their slugs for reuse. */
  remove(translationKey: string): Promise<void>;
  /**
   * Every stored locale row, regardless of locale pairing, plus a
   * `source: 'published'` row per locale for each published snapshot.
   * Image-usage scans must use this instead of list()+get(): pgPostStore.get()
   * returns null for a key with only one locale row. Legacy pre-#106 data or
   * manual database repair can still contain such a stranded row even though
   * current upsertDraft writes both locales atomically, and its image
   * references must still count as usage. The snapshot rows guard what the
   * blog serves: a draft save that swaps a photo out must not make the old one
   * deletable while the published version still renders it (#115).
   */
  usageRows(): Promise<PostUsageRow[]>;
  /** Revision summaries for a post, newest first (at most REVISION_CAP). */
  listRevisions(translationKey: string): Promise<RevisionSummary[]>;
  /** One full revision snapshot, or null for an unknown (or malformed) id. */
  getRevision(translationKey: string, id: string): Promise<PostRevision | null>;
  listCategories?(): Promise<{ name: string; count: number }[]>;
  listTags?(): Promise<{ name: string; count: number }[]>;
  getCmsStats?(): Promise<{
    totalPosts: number;
    draftPosts: number;
    publishedPosts: number;
    totalCategories: number;
    totalTags: number;
  }>;
}

/**
 * Optimistic-concurrency check: throw 'conflict' when the stored pair changed
 * after the state the caller loaded.
 * @ai-warning Compare in JS on Dates only — never SQL-side. Postgres stores
 * timestamptz at µs precision but node-postgres parses it to a ms-precision JS
 * Date, so both sides here went through the SAME truncation; a SQL comparison
 * against the echoed value would false-conflict on every innocent save.
 */
export function assertNotStale(storedUpdatedAt: Date, baseUpdatedAt: Date | undefined): void {
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
/** ASCII grammar makes characters equal bytes; leave four bytes for `.mdx`. */
export const MAX_SLUG_BYTES = 251;
/** db.ts `REGIONS` (which the posts CHECK is built from), widened so untrusted strings can be tested against it. */
const REGION_KEYS: readonly string[] = REGIONS;

/** True for a slug safe to use in a URL and as a storage path segment. */
export function isSafeSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_BYTES && SLUG_RE.test(slug);
}

export function checkSlug(slug: string, locale: Locale): void {
  if (typeof slug !== 'string') throw new PostError(`${locale}.slug must be a string`);
  const bytes = Buffer.byteLength(slug, 'utf8');
  if (bytes > MAX_SLUG_BYTES) {
    throw new PostError(`${locale}.slug must be at most ${MAX_SLUG_BYTES} ASCII bytes (received ${bytes})`);
  }
  if (!isSafeSlug(slug)) throw new PostError(`${locale}.slug invalid slug (lowercase a-z, 0-9, hyphen)`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Optional string field: absent is fine, anything else must be a string. */
function optString(o: Record<string, unknown>, field: string, path: string): void {
  if (o[field] !== undefined && typeof o[field] !== 'string') throw new PostError(`${path}.${field} must be a string`);
}

function optStringArray(o: Record<string, unknown>, field: string, path: string): void {
  const v = o[field];
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new PostError(`${path}.${field} must be an array of strings`);
}

/**
 * Payload-shape validation at the HTTP boundary (issue #120). `req.body` is
 * untrusted JSON: a missing `de`, a non-string title, an array body, a string
 * where `text[]` is bound or `scheduledAt: 'junk'` all used to surface as a
 * TypeError or a pg 22P02/22007 → sanitized 500. Every rejection here is a
 * PostError naming the field, which the route maps to 400. Only SHAPE is
 * checked — completeness (excerpt, hero, body, real slugs…) is
 * validateForPublish's job, so a title-only draft passes.
 *
 * @ai-note An empty slug means "not set yet" — the write-DE-first workflow
 * saves a draft with no EN title and therefore no EN slug (issue #119). It is
 * exempt from the format check here AND from the duplicate check in both
 * stores (plus the partial unique index in db.ts); validateForPublish still
 * demands a real slug per locale.
 */
export function validateDraft(pair: unknown): asserts pair is PostPair {
  if (!isPlainObject(pair)) throw new PostError('post payload must be an object');
  if (pair.confirmSlugChange !== undefined && typeof pair.confirmSlugChange !== 'boolean') throw new PostError('confirmSlugChange must be a boolean');
  const shared = pair.shared;
  if (!isPlainObject(shared)) throw new PostError('shared must be an object');
  if (shared.date !== undefined && shared.date !== '') {
    if (typeof shared.date !== 'string' || !DATE_RE.test(shared.date) || Number.isNaN(Date.parse(shared.date))) {
      throw new PostError('shared.date must be YYYY-MM-DD');
    }
  }
  if (shared.countryCode !== undefined && shared.countryCode !== '') {
    if (typeof shared.countryCode !== 'string' || !COUNTRY_CODE_RE.test(shared.countryCode)) throw new PostError('shared.countryCode must be 2 letters');
  }
  if (shared.region !== undefined && shared.region !== '') {
    if (typeof shared.region !== 'string' || !REGION_KEYS.includes(shared.region)) throw new PostError(`shared.region must be one of ${REGIONS.join(', ')}`);
  }
  if (shared.coordinates !== undefined) {
    const c = shared.coordinates;
    if (!isPlainObject(c) || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) throw new PostError('shared.coordinates must be { lat, lng } numbers');
  }
  if (shared.stops !== undefined && !Array.isArray(shared.stops)) throw new PostError('shared.stops must be an array');
  optString(shared, 'route', 'shared');
  optStringArray(shared, 'categories', 'shared');
  optStringArray(shared, 'tags', 'shared');
  if (shared.scheduledAt !== undefined && shared.scheduledAt !== null && shared.scheduledAt !== '') {
    if (typeof shared.scheduledAt !== 'string' || Number.isNaN(Date.parse(shared.scheduledAt))) throw new PostError('shared.scheduledAt must be an ISO date-time or null');
  }
  // Rejected, never coerced: a truthy string ('false', 'off') from a hand-made
  // payload must not silently promote a post to the homepage cover.
  if (shared.featured !== undefined && typeof shared.featured !== 'boolean') throw new PostError('shared.featured must be a boolean');
  if (shared.commentsEnabled !== undefined && typeof shared.commentsEnabled !== 'boolean') throw new PostError('shared.commentsEnabled must be a boolean');
  for (const locale of ['de', 'en'] as Locale[]) {
    const l = pair[locale];
    if (!isPlainObject(l)) throw new PostError(`${locale} must be an object`);
    for (const f of ['slug', 'title', 'excerpt', 'country', 'bodyMarkdown']) optString(l, f, locale);
    if (l.heroImage !== undefined && !isPlainObject(l.heroImage)) throw new PostError(`${locale}.heroImage must be an object`);
    if (l.titleImage !== undefined && !isPlainObject(l.titleImage)) throw new PostError(`${locale}.titleImage must be an object`);
    if (l.images !== undefined && !isPlainObject(l.images)) throw new PostError(`${locale}.images must be an object`);
    if (l.keyFacts !== undefined && (!isPlainObject(l.keyFacts) || Object.values(l.keyFacts).some((v) => typeof v !== 'string'))) {
      throw new PostError(`${locale}.keyFacts must be an object of strings`);
    }
    const slug = l.slug ?? '';
    if (slug !== '') checkSlug(slug as string, locale);
    if (locale === 'de' && !(typeof l.title === 'string' && l.title.trim())) throw new PostError('a German title is required to start a draft');
  }
}

function validateLocale(p: PostLocale): void {
  checkSlug(p.slug, p.locale);
  if (!p.title.trim()) throw new PostError(`${p.locale}: title required`);
  if (!p.excerpt.trim()) throw new PostError(`${p.locale}: excerpt required`);
  if (!p.country.trim()) throw new PostError(`${p.locale}: country required`);
  if (!p.bodyMarkdown.trim()) throw new PostError(`${p.locale}: body required`);
  if (!p.heroImage) throw new PostError(`${p.locale}: heroImage required`);
  validatePublishedImage(p.heroImage, `${p.locale}: heroImage`);
  if (p.titleImage !== undefined) validatePublishedImage(p.titleImage, `${p.locale}: titleImage`);
}

function validatePublishedImage(h: HeroImage, field: string, requireAlt = true): void {
  try { new URL(h.src); } catch { throw new PostError(`${field}.src must be a URL`); }
  if (!Number.isInteger(h.width) || h.width <= 0 || !Number.isInteger(h.height) || h.height <= 0) {
    throw new PostError(`${field} needs positive integer width/height`);
  }
  if (requireAlt && !h.alt.trim()) throw new PostError(`${field}.alt required`);
}

/**
 * Synchronous structural validation only. Full publication eligibility also
 * requires the async rendered-body and image-readiness gates in server.ts.
 */
export function validateForPublish(pair: PostPair): void {
  const s = pair.shared;
  if (s.countryCode.length !== 2) throw new PostError('countryCode must be 2 letters');
  if (!REGION_KEYS.includes(s.region)) throw new PostError(`region must be one of ${REGIONS.join(', ')}`);
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
  if (!s.date.trim()) throw new PostError('date required');
  validateLocale(pair.de);
  validateLocale(pair.en);
}

const PLACEHOLDER_HERO: HeroImage = { src: '', width: 0, height: 0, alt: '' };
// The same placeholders wp-import.ts writes for an imported draft (issue #120).
const PLACEHOLDER_COUNTRY_CODE = 'XX';
const PLACEHOLDER_REGION = 'europe';

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
export async function normalizeBodyImages(
  bodyMarkdown: string,
  images: Record<string, ImageDims>,
): Promise<{ bodyMarkdown: string; images: Record<string, ImageDims> }> {
  // Gallery fences first: a ```gallery line may carry `| WxH | alt="…"`
  // metadata that belongs in the images map (see body-content.ts). Its output
  // contains no <BodyImage> tags, so the two passes are independent.
  const gal = await normalizeGalleryFences(bodyMarkdown, images);
  bodyMarkdown = gal.bodyMarkdown;
  const merged: Record<string, ImageDims> = { ...gal.images };
  // Attrs are consumed in disjoint chunks — "quoted", {braced}, or any char that opens
  // neither and isn't '>' — so a '>' or '/>' inside a quoted value can't terminate the tag.
  // Only outside gallery fences: a gallery line's text (a gallery-local caption above
  // all) is content, never a tag to convert.
  const tagRe = /<BodyImage\s+((?:"[^"]*"|\{[^}]*\}|[^>"{])*?)\/>/g;
  const normalized = await rewriteOutsideGalleries(bodyMarkdown, (text) => text.replace(tagRe, (match, attrs: string) => {
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
    const format = get('format');
    if (format !== undefined && format !== 'jpeg') return match;
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
      merged[src] = {
        ...merged[src],
        width,
        height,
        ...(format === 'jpeg' ? { format } : {}),
      };
    }
    return imageMarkdown(alt, src);
  }));
  return { bodyMarkdown: normalized, images: merged };
}

/**
 * Fill the NOT-NULL / CHECKed columns a partial draft save can omit
 * (`date`, `countryCode`, `region`, `coordinates`, `heroImage`, the locale
 * strings) so a draft can never hit Postgres 23502/23514 (issue #120: the
 * documented minimum draft is a DE title alone, and the editor omits the
 * shared fields while blank). The placeholders match the WordPress-import
 * defaults (`wp-import.ts`) and show up in the editor on reload, where the
 * author replaces them; `validateForPublish` only rejects the post for what
 * it still lacks (excerpt, hero, body, EN slug …), not for `XX`/`europe`
 * themselves — same as an imported draft.
 * Also normalizes pasted `<BodyImage …/>` tags and ```gallery fences, and
 * validates the `images` map — this is the single chokepoint shared by
 * memoryPostStore and pgPostStore (and the WP importer via upsertDraft).
 * @ai-warning The validation MUST live here, not in `validateDraft`: the WXR
 * importer calls `upsertDraft` directly (wp-import.ts) and never runs
 * `validateDraft`, so validation placed there alone would leave every imported
 * post's `images` map unchecked. See body-content.ts `imagesMapError` for why
 * an unchecked map is an XSS vector rather than a tidiness problem.
 */
async function draftWithDefaults(pair: PostPair): Promise<PostPair> {
  // The locale is passed in rather than read off `l`: a partial draft payload
  // can omit `locale` at runtime despite the TS type, and the error message
  // must still name which side failed.
  const fillLocale = async (l: PostLocale, locale: Locale): Promise<PostLocale> => {
    if ((l.slug ?? '') !== '') checkSlug(l.slug, locale);
    const err = imagesMapError(l.images) ?? heroImageError(l.heroImage);
    if (err) throw new PostError(`${locale}: ${err}`);
    const titleError = heroImageError(l.titleImage);
    if (titleError) throw new PostError(`${locale}: ${titleError.replaceAll('heroImage', 'titleImage')}`);
    if (l.titleImage !== undefined) {
      // Unlike the required hero's legacy draft placeholder, an optional banner
      // is either a complete selection or absent. Alt text can be authored later.
      validatePublishedImage(l.titleImage, `${locale}: titleImage`, false);
      const url = new URL(l.titleImage.src);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new PostError(`${locale}: titleImage.src must be an HTTP(S) image base URL without credentials, query or fragment`);
      }
    }
    const filled: PostLocale = {
      ...l,
      locale,
      slug: l.slug ?? '', title: l.title ?? '', excerpt: l.excerpt ?? '', country: l.country ?? '',
      heroImage: l.heroImage ?? PLACEHOLDER_HERO,
      bodyMarkdown: l.bodyMarkdown ?? '',
      images: l.images ?? {},
    };
    const n = await normalizeBodyImages(filled.bodyMarkdown, filled.images);
    return { ...filled, bodyMarkdown: n.bodyMarkdown, images: n.images };
  };
  const s = pair.shared;
  return {
    ...pair,
    shared: {
      ...s,
      date: s.date || new Date().toISOString().slice(0, 10),
      countryCode: s.countryCode || PLACEHOLDER_COUNTRY_CODE,
      region: s.region || PLACEHOLDER_REGION,
      coordinates: s.coordinates ?? { lat: 0, lng: 0 },
      // Absent = not the cover. Normalized here, the one chokepoint both
      // stores and the WXR importer pass through, so every stored pair carries
      // a real boolean and `featured boolean NOT NULL` is never bound undefined.
      featured: s.featured ?? false,
      // Absent = enabled per post; the site-wide setting is the default-off gate.
      commentsEnabled: s.commentsEnabled ?? true,
    },
    de: await fillLocale(pair.de, 'de'),
    en: await fillLocale(pair.en, 'en'),
  };
}

/**
 * Delete-with-post hook for the memory store. pgPostStore deletes a post's
 * comments inside its own transaction; the memory store has no table to reach,
 * so a comment store (or anything with `removeByTranslationKey`) can be linked
 * in to keep the two stores' semantics identical in server tests.
 */
export interface MemoryPostStoreOptions {
  comments?: { removeByTranslationKey(translationKey: string): Promise<unknown> | unknown };
}

export function memoryPostStore(opts: MemoryPostStoreOptions = {}): PostStore {
  const byKey = new Map<string, Stored>();
  // Revisions per translation_key, oldest first (append order) — mirrors the
  // pg store's post_revisions table so server tests exercise the same semantics.
  const revisionsByKey = new Map<string, PostRevision[]>();
  const slugTaken = (locale: Locale, slug: string, exceptKey: string) =>
    slug !== '' && [...byKey.values()].some((p) => p.translationKey !== exceptKey && p[locale].slug === slug);
  const mutations = new Map<string, Promise<unknown>>();
  async function withPair<T>(key: string, mutate: () => T | Promise<T>): Promise<T> {
    const previous = mutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(mutate);
    mutations.set(key, current);
    try { return await current; }
    finally { if (mutations.get(key) === current) mutations.delete(key); }
  }
  const nextTime = (previous?: Date) => new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));

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
            ...(hero?.format === 'jpeg' ? { heroFormat: hero.format } : {}),
            // DE-led with an EN fallback, same precedent as the hero above — a
            // pair may have only the EN row's country filled in.
            date: p.shared.date ?? '', country: p.de.country || p.en.country || '', region: p.shared.region ?? '',
            categories: p.shared.categories ?? [],
            tags: p.shared.tags ?? [],
            scheduledAt: p.shared.scheduledAt ?? null,
          };
        });
    },
    async get(tk) {
      const p = byKey.get(tk);
      return p ? structuredClone({ translationKey: p.translationKey, status: p.status, shared: p.shared, de: p.de, en: p.en, hasUnpublishedChanges: p.hasUnpublishedChanges, updatedAt: p.updatedAt }) : null;
    },
    async getPublishState(tk) {
      const pair = await this.get(tk);
      return pair ? { pair, routeVersion: null } : null;
    },
    async getPublishedTrack() { return undefined; },
    async usageRows() {
      return [...byKey.values()].flatMap((p) => {
        const sources: { source: PostUsageRow['source']; from: Pick<PostPair, 'de' | 'en'> }[] = [{ source: 'working', from: p }];
        if (p.status === 'published' && p.publishedSnapshot) sources.push({ source: 'published', from: p.publishedSnapshot });
        return sources.flatMap(({ source, from }) => (['de', 'en'] as const).map((loc) => structuredClone({
          translationKey: p.translationKey, locale: loc, source, title: from[loc].title,
          heroImage: from[loc].heroImage, bodyMarkdown: from[loc].bodyMarkdown, images: from[loc].images,
          ...(from[loc].titleImage ? { titleImage: from[loc].titleImage } : {}),
        })));
      });
    },
    async upsertDraft(pair, baseUpdatedAt) {
      const key = pair.translationKey || randomUUID();
      return withPair(key, async () => {
        // Reserve save order before asynchronous analysis; a later Publish must
        // not overtake this edit. Both locales still normalize before any write.
        pair = await draftWithDefaults(pair);
        const existing = byKey.get(key);
        if (!existing && baseUpdatedAt) throw new PostError('post not found', 'not_found');
        if (existing) assertNotStale(existing.updatedAt, baseUpdatedAt);
        for (const locale of ['de', 'en'] as Locale[]) {
          if (slugTaken(locale, pair[locale].slug, key)) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`, 'duplicate_slug');
          if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) {
            throw new PostError('cannot change the slug of a published post', 'slug_locked');
          }
        }
        if (existing) {
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
          ...structuredClone(pair), translationKey: key, status, updatedAt: nextTime(existing?.updatedAt),
          // A route lives outside this object; a text revision cannot restore it.
          publishedAt: existing?.publishedAt, publishedSnapshot: existing?.publishedSnapshot,
          hasUnpublishedChanges: status === 'published',
        };
        byKey.set(key, stored);
        return structuredClone(stored);
      });
    },
    async publish(tk, tokens) {
      const state = await this.getPublishState(tk);
      if (!state) throw new PostError('post not found', 'not_found');
      assertPublishTokens(state, tokens);
      return withPair(tk, () => {
        const p = byKey.get(tk);
        if (!p) throw new PostError('post not found', 'not_found');
        assertPublishTokens({ pair: p, routeVersion: null }, tokens);
        p.status = 'published';
        p.publishedSnapshot = structuredClone({ shared: p.shared, de: p.de, en: p.en });
        p.publishedAt = nextTime(p.updatedAt);
        p.updatedAt = p.publishedAt;
        p.hasUnpublishedChanges = false;
        return { updatedAt: new Date(p.updatedAt) };
      });
    },
    async unpublish(tk) {
      return withPair(tk, () => {
        const p = byKey.get(tk);
        if (!p) throw new PostError('post not found');
        const previousUpdatedAt = new Date(p.updatedAt);
        p.status = 'draft';
        p.updatedAt = nextTime(p.updatedAt);
        return { previousUpdatedAt, updatedAt: new Date(p.updatedAt) };
      });
    },
    async remove(tk) {
      return withPair(tk, async () => {
        if (!byKey.has(tk)) throw new PostError('post not found');
        await opts.comments?.removeByTranslationKey(tk);
        byKey.delete(tk);
        revisionsByKey.delete(tk);
      });
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
    async listCategories() {
      const counts = new Map<string, number>();
      for (const p of byKey.values()) {
        for (const cat of p.shared.categories ?? []) {
          counts.set(cat, (counts.get(cat) ?? 0) + 1);
        }
      }
      return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
    async listTags() {
      const counts = new Map<string, number>();
      for (const p of byKey.values()) {
        for (const tag of p.shared.tags ?? []) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
    async getCmsStats() {
      let draft = 0, published = 0;
      const cats = new Set<string>();
      const tags = new Set<string>();
      for (const p of byKey.values()) {
        if (p.status === 'published') published++; else draft++;
        (p.shared.categories ?? []).forEach((c) => cats.add(c));
        (p.shared.tags ?? []).forEach((t) => tags.add(t));
      }
      return {
        totalPosts: byKey.size,
        draftPosts: draft,
        publishedPosts: published,
        totalCategories: cats.size,
        totalTags: tags.size,
      };
    },
  };
}

import { POST_SNAPSHOT_SQL, REGIONS, type DbClient, type DbPool } from './db.js';

interface PostRow {
  translation_key: string; locale: Locale; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: HeroImage; coordinates: { lat: number; lng: number };
  title_image: HeroImage | null;
  stops: PostShared['stops'] | null; route: string | null; key_facts: Record<string, string> | null;
  body_markdown: string; images: Record<string, ImageDims>; status: PostStatus; updated_at: Date;
  published_at: Date | null;
  categories: string[] | null;
  tags: string[] | null;
  scheduled_at: Date | string | null;
  featured: boolean;
  comments_enabled: boolean;
}

interface PostListRow {
  translation_key: string; locale: Locale; slug: string; title: string;
  status: PostStatus; updated_at: Date; published_at: Date | null;
  hero_image: HeroImage | null; date: Date | string; country: string; region: string;
  has_body: boolean;
  categories: string[] | null;
  tags: string[] | null;
  scheduled_at: Date | string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a published row's working copy was saved after its last publish. */
function rowHasUnpublishedChanges(
  r: Pick<PostRow, 'status' | 'published_at' | 'updated_at'> | undefined,
): boolean {
  return !!r && r.status === 'published' && r.published_at !== null && r.updated_at.getTime() > r.published_at.getTime();
}

function dateText(date: Date | string | null | undefined): string {
  if (date instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return date ? String(date).slice(0, 10) : '';
}

function rowLocale(r: PostRow): PostLocale {
  return { locale: r.locale, slug: r.slug, title: r.title, excerpt: r.excerpt, country: r.country, heroImage: r.hero_image, ...(r.title_image ? { titleImage: r.title_image } : {}), bodyMarkdown: r.body_markdown, images: r.images ?? {}, ...(r.key_facts ? { keyFacts: r.key_facts } : {}) };
}
function rowShared(r: PostRow): PostShared {
  const d = dateText(r.date);
  return {
    date: d, countryCode: r.country_code, region: r.region, coordinates: r.coordinates,
    ...(r.stops ? { stops: r.stops } : {}), ...(r.route ? { route: r.route } : {}),
    categories: r.categories ?? [],
    tags: r.tags ?? [],
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
    // NOT NULL DEFAULT false in the schema, so both locale rows always answer
    // with the same real boolean — no `?? false` fallback to hide a bad write.
    featured: r.featured,
    commentsEnabled: r.comments_enabled,
  };
}

/** The pg unique-violation raised by posts_locale_slug_idx — the race-safe slug backstop. */
function isSlugCollision(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === '23505' && err.constraint === 'posts_locale_slug_idx';
}

/**
 * The parameter row shared by insertLocale and updateLocale. Everything read
 * off `shared` (date, countryCode, region, coordinates, stops, route,
 * categories, tags, scheduledAt, featured) is therefore written IDENTICALLY to
 * the DE and the EN row — that is what "shared field" means here, and what
 * issue #87 fixed by moving `country`/`keyFacts` OUT of it.
 */
function localeParams(tk: string, status: string, shared: PostShared, p: PostLocale): unknown[] {
  return [tk, p.locale, p.slug, p.title, shared.date, p.country, shared.countryCode, shared.region,
    p.excerpt, JSON.stringify(p.heroImage), JSON.stringify(shared.coordinates),
    shared.stops?.length ? JSON.stringify(shared.stops) : null, shared.route ?? null, p.keyFacts ? JSON.stringify(p.keyFacts) : null,
    p.bodyMarkdown, JSON.stringify(p.images), status,
    shared.categories ?? [], shared.tags ?? [], shared.scheduledAt ? new Date(shared.scheduledAt) : null,
    shared.featured ?? false, shared.commentsEnabled ?? true, p.titleImage ? JSON.stringify(p.titleImage) : null];
}

async function readPostPair(client: DbPool | DbClient, tk: string, lock = false): Promise<StoredPostPair | null> {
  const { rows } = await client.query<PostRow>(
    `SELECT * FROM posts WHERE translation_key=$1 ORDER BY locale${lock ? ' FOR UPDATE' : ''}`, [tk],
  );
  return postPairFromRows(tk, rows);
}

function postPairFromRows(tk: string, rows: PostRow[]): StoredPostPair | null {
  const de = rows.find((row) => row.locale === 'de');
  const en = rows.find((row) => row.locale === 'en');
  if (!de || !en) return null;
  return {
    translationKey: tk, status: de.status, shared: rowShared(de), de: rowLocale(de), en: rowLocale(en),
    hasUnpublishedChanges: rowHasUnpublishedChanges(de) || rowHasUnpublishedChanges(en),
    updatedAt: new Date(Math.max(de.updated_at.getTime(), en.updated_at.getTime())),
  };
}

/** One statement sees both locales and the route version at the same MVCC snapshot. */
async function readPublishState(client: DbPool | DbClient, tk: string, geometry = false) {
  const { rows } = await client.query<PostRow & { route_version: string | null; route_geometry?: PrivateGeometry | null }>(
    `SELECT p.*, r.version AS route_version${geometry ? ', r.geometry AS route_geometry' : ''}
       FROM posts p LEFT JOIN post_routes r USING (translation_key)
      WHERE p.translation_key=$1 ORDER BY p.locale`, [tk],
  );
  const pair = postPairFromRows(tk, rows);
  const row = rows[0];
  return pair && row ? { pair, routeVersion: row.route_version, geometry: row.route_geometry ?? null } : null;
}

interface PgPostStoreOptions {
  routeFiles?: GpxFiles;
  isWritable?: () => boolean;
  publicTrackWorker?: PublicTrackWorker;
}

export function pgPostStore(pool: DbPool, options: PgPostStoreOptions = {}): PostStore {
  const writable = () => {
    if (options.isWritable && !options.isWritable()) throw new PostError('Storage is read-only; restart the app after database recovery.', 'storage_read_only');
  };
  // Plain INSERT: a (locale, slug) collision surfaces as 23505 from
  // posts_locale_slug_idx and is mapped to duplicate_slug by the caller — never
  // ON CONFLICT DO UPDATE, which re-assigned another pair's row (issue #106).
  async function insertLocale(client: DbClient, tk: string, status: string, shared: PostShared, p: PostLocale) {
    await client.query(
      `INSERT INTO posts (translation_key, locale, slug, title, date, country, country_code, region,
         excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status,
         categories, tags, scheduled_at, featured, comments_enabled, title_image, id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now())`,
      [...localeParams(tk, status, shared, p), randomUUID()],
    );
  }
  // Writes by identity — (translation_key, locale) — so a slug rename updates
  // the row in place instead of leaving the old-slug row behind. Never sets
  // translation_key.
  async function updateLocale(client: DbClient, tk: string, status: string, shared: PostShared, p: PostLocale) {
    const res = await client.query(
      `UPDATE posts SET slug=$3, title=$4, date=$5, country=$6, country_code=$7, region=$8, excerpt=$9,
         hero_image=$10, coordinates=$11, stops=$12, route=$13, key_facts=$14, body_markdown=$15, images=$16,
         status=$17, categories=$18, tags=$19, scheduled_at=$20, featured=$21, comments_enabled=$22, title_image=$23
       WHERE translation_key=$1 AND locale=$2`,
      localeParams(tk, status, shared, p),
    );
    // The pair vanished between get() and this write (e.g. DELETE /posts/:tk).
    if (res.rowCount !== 1) throw new PostError('post not found');
  }
  return {
    async list() {
      const { rows } = await pool.query<PostListRow>(
        `SELECT translation_key, locale, slug, title, status, updated_at, published_at,
                hero_image, date, country, region, btrim(body_markdown) <> '' AS has_body,
                categories, tags, scheduled_at
           FROM posts ORDER BY updated_at DESC`,
      );
      const byKey = new Map<string, { de?: PostListRow; en?: PostListRow }>();
      for (const r of rows) { const e = byKey.get(r.translation_key) ?? {}; e[r.locale] = r; byKey.set(r.translation_key, e); }
      return [...byKey.entries()].map(([tk, e]) => {
        const hero = e.de?.hero_image?.src ? e.de.hero_image : e.en?.hero_image;
        const shared = e.de ?? e.en;
        return {
          translationKey: tk, titleDe: e.de?.title ?? '', slugDe: e.de?.slug ?? '', slugEn: e.en?.slug ?? '',
          status: (e.de?.status ?? e.en?.status ?? 'draft') as PostStatus,
          updatedAt: new Date(Math.max(e.de?.updated_at?.getTime() ?? 0, e.en?.updated_at?.getTime() ?? 0)),
          hasUnpublishedChanges: rowHasUnpublishedChanges(e.de) || rowHasUnpublishedChanges(e.en),
          hasEnBody: Boolean(e.en?.has_body),
          heroSrc: hero?.src ?? '', heroWidth: hero?.width ?? 0,
          ...(hero?.format === 'jpeg' ? { heroFormat: hero.format } : {}),
          date: dateText(shared?.date), country: e.de?.country || e.en?.country || '', region: shared?.region ?? '',
          categories: shared?.categories ?? [],
          tags: shared?.tags ?? [],
          scheduledAt: shared?.scheduled_at ? new Date(shared.scheduled_at).toISOString() : null,
        };
      });
    },
    get: (tk) => readPostPair(pool, tk),
    async getPublishState(tk) {
      const state = await readPublishState(pool, tk);
      return state ? { pair: state.pair, routeVersion: state.routeVersion } : null;
    },
    async getPublishedTrack(tk) {
      const { rows } = await pool.query<PublishedTrackRow>(
        'SELECT locale, published_snapshot FROM posts WHERE translation_key=$1 ORDER BY locale', [tk],
      );
      try { return publishedTrackOf(rows); }
      catch { throw new PostError('invalid published route snapshots', 'invalid_published_track'); }
    },
    async usageRows() {
      // The second SELECT mirrors the site loader's filter (postgres-loader.ts:
      // `status = 'published' AND published_snapshot IS NOT NULL`) so the
      // snapshot rows are exactly what the blog serves. Working rows sort
      // first per locale so the alt harvest prefers the editable copy.
      const { rows } = await pool.query<Pick<PostRow, 'translation_key' | 'locale' | 'title' | 'hero_image' | 'title_image' | 'body_markdown' | 'images'> & { source: PostUsageRow['source'] }>(
        `SELECT translation_key, locale, title, hero_image, title_image, body_markdown, images, 'working' AS source FROM posts
         UNION ALL
         SELECT translation_key, locale, published_snapshot->>'title', published_snapshot->'hero_image',
                published_snapshot->'title_image', published_snapshot->>'body_markdown', published_snapshot->'images', 'published'
           FROM posts WHERE status = 'published' AND published_snapshot IS NOT NULL
         ORDER BY translation_key, locale, source DESC`,
      );
      return rows.map((r) => ({
        translationKey: r.translation_key, locale: r.locale, source: r.source, title: r.title ?? '',
        heroImage: r.hero_image, bodyMarkdown: r.body_markdown ?? '', images: r.images ?? {},
        ...(r.title_image ? { titleImage: r.title_image } : {}),
      }));
    },
    async upsertDraft(pair, baseUpdatedAt) {
      pair = await draftWithDefaults(pair);
      const tk = pair.translationKey || randomUUID();
      writable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockPostPair(client, tk);
        const existing = await readPostPair(client, tk, true);
        if (!existing && baseUpdatedAt) throw new PostError('post not found', 'not_found');
        if (existing) assertNotStale(existing.updatedAt, baseUpdatedAt);
        const status = existing?.status ?? 'draft';
        for (const locale of ['de', 'en'] as Locale[]) {
          const slug = pair[locale].slug;
          if (slug !== '') {
            const { rows } = await client.query<{ translation_key: string }>(`SELECT translation_key FROM posts WHERE locale=$1 AND slug=$2`, [locale, slug]);
            if (rows[0] && rows[0].translation_key !== tk) throw new PostError(`slug "${slug}" already in use for ${locale}`, 'duplicate_slug');
          }
          if (existing && existing.status === 'published' && existing[locale].slug !== slug) throw new PostError('cannot change the slug of a published post', 'slug_locked');
        }
        if (existing) {
          await client.query(
            `INSERT INTO post_revisions (id, translation_key, snapshot) VALUES ($1, $2, $3)`,
            [randomUUID(), tk, JSON.stringify({ status: existing.status, shared: existing.shared, de: existing.de, en: existing.en })],
          );
          await client.query(
            `DELETE FROM post_revisions
              WHERE translation_key = $1 AND id NOT IN (
                SELECT id FROM post_revisions WHERE translation_key = $1
                 ORDER BY saved_at DESC, id DESC LIMIT $2)`,
            [tk, REVISION_CAP],
          );
          await updateLocale(client, tk, status, pair.shared, { ...pair.de, locale: 'de' });
          await updateLocale(client, tk, status, pair.shared, { ...pair.en, locale: 'en' });
        } else {
          await insertLocale(client, tk, status, pair.shared, { ...pair.de, locale: 'de' });
          await insertLocale(client, tk, status, pair.shared, { ...pair.en, locale: 'en' });
        }
        await touchPostPair(client, tk);
        // Return this save's token, not a later writer's post-COMMIT read.
        const saved = await readPostPair(client, tk);
        if (!saved) throw new PostError('failed to save post');
        writable();
        await client.query('COMMIT');
        return saved;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (isSlugCollision(e)) throw new PostError('slug already in use', 'duplicate_slug');
        throw e;
      } finally { client.release(); }
    },
    async publish(tk, tokens) {
      writable();
      const state = await readPublishState(pool, tk, true);
      if (!state) throw new PostError('post not found', 'not_found');
      assertPublishTokens(state, tokens);
      let track: PublicTrack | undefined;
      if (state.geometry !== null) {
        if (!options.publicTrackWorker) throw new GpxError('gpx_unavailable', 503);
        track = validatePublicTrack((await options.publicTrackWorker.transform(state.geometry)).track);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockPostPair(client, tk);
        const pair = await readPostPair(client, tk, true);
        if (!pair) throw new PostError('post not found', 'not_found');
        const route = await client.query<{ version: string }>(
          'SELECT version FROM post_routes WHERE translation_key=$1 FOR UPDATE', [tk],
        );
        assertPublishTokens({ pair, routeVersion: route.rows[0]?.version ?? null }, tokens);
        const updatedAt = await touchPostPair(client, tk);
        // This merge exists ONLY at explicit Publish; legacy backfills stay route-free.
        await client.query(
          `UPDATE posts SET status='published',
             published_snapshot=${POST_SNAPSHOT_SQL} || $3::jsonb, published_at=$2
           WHERE translation_key=$1`,
          [tk, updatedAt, JSON.stringify(track ? { track } : {})],
        );
        writable();
        await client.query('COMMIT');
        return { updatedAt };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async unpublish(tk) {
      writable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockPostPair(client, tk);
        const pair = await readPostPair(client, tk, true);
        if (!pair) throw new PostError('post not found');
        const updatedAt = await touchPostPair(client, tk);
        await client.query(`UPDATE posts SET status='draft' WHERE translation_key=$1`, [tk]);
        writable();
        await client.query('COMMIT');
        return { previousUpdatedAt: pair.updatedAt, updatedAt };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async remove(tk) {
      const remove = async () => {
        writable();
        const pairHash = safePairHash(tk);
        const leftovers = options.routeFiles
          ? await options.routeFiles.listOriginals(pairHash)
          : [];
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await lockPostPair(client, tk);
          const rows = await client.query('SELECT locale FROM posts WHERE translation_key=$1 ORDER BY locale FOR UPDATE', [tk]);
          if (rows.rowCount === 0) throw new PostError('post not found', 'not_found');
          const sources = await client.query<{ source_id: string }>('DELETE FROM post_routes WHERE translation_key=$1 RETURNING source_id', [tk]);
          await enqueueRouteCleanup(client, [
            ...leftovers,
            ...sources.rows.map((row) => ({ sourceId: row.source_id, pairHash })),
          ]);
          await client.query('DELETE FROM posts WHERE translation_key=$1', [tk]);
          await client.query('DELETE FROM post_revisions WHERE translation_key=$1', [tk]);
          await client.query('DELETE FROM comments WHERE translation_key=$1', [tk]);
          writable();
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
      };
      if (options.routeFiles) await options.routeFiles.gate.runExclusive(remove);
      else await remove();
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
      return { id: r.id, savedAt: r.saved_at, titleDe: r.snapshot.de.title, status: r.snapshot.status as PostStatus, snapshot: r.snapshot };
    },
    async listCategories() {
      const { rows } = await pool.query<{ category: string; count: string }>(
        `SELECT unnest(categories) AS category, COUNT(DISTINCT translation_key) AS count
           FROM posts WHERE categories <> '{}' GROUP BY category ORDER BY count DESC, category ASC`,
      );
      return rows.map((r) => ({ name: r.category, count: parseInt(r.count, 10) }));
    },
    async listTags() {
      const { rows } = await pool.query<{ tag: string; count: string }>(
        `SELECT unnest(tags) AS tag, COUNT(DISTINCT translation_key) AS count
           FROM posts WHERE tags <> '{}' GROUP BY tag ORDER BY count DESC, tag ASC`,
      );
      return rows.map((r) => ({ name: r.tag, count: parseInt(r.count, 10) }));
    },
    async getCmsStats() {
      const { rows: postStats } = await pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(DISTINCT translation_key) AS count FROM posts GROUP BY status`,
      );
      let total = 0, draft = 0, published = 0;
      for (const r of postStats) {
        const cnt = parseInt(r.count, 10);
        total += cnt;
        if (r.status === 'published') published += cnt; else draft += cnt;
      }
      const { rows: catCount } = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT cat) FROM (SELECT unnest(categories) AS cat FROM posts) sub`,
      );
      const { rows: tagCount } = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT tag) FROM (SELECT unnest(tags) AS tag FROM posts) sub`,
      );
      return {
        totalPosts: total,
        draftPosts: draft,
        publishedPosts: published,
        totalCategories: parseInt(catCount[0]?.count ?? '0', 10),
        totalTags: parseInt(tagCount[0]?.count ?? '0', 10),
      };
    },
  };
}
