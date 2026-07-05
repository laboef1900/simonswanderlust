import { randomUUID } from 'node:crypto';

export type Locale = 'de' | 'en';
export interface HeroImage { src: string; width: number; height: number; alt: string }
export interface ImageDims { width: number; height: number }
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
 * published snapshot until the next Publish; see issue #20).
 */
export interface StoredPostPair extends PostPair { hasUnpublishedChanges: boolean }
export interface PostSummary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: 'draft' | 'published'; updatedAt: Date; hasUnpublishedChanges: boolean;
}
export class PostError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<StoredPostPair | null>;
  upsertDraft(pair: PostPair): Promise<StoredPostPair>;
  publish(translationKey: string): Promise<void>;
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
  const merged: Record<string, ImageDims> = { ...images };
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
 * Also normalizes pasted `<BodyImage …/>` tags — this is the single chokepoint
 * shared by memoryPostStore and pgPostStore (and the WP importer via upsertDraft).
 */
function draftWithDefaults(pair: PostPair): PostPair {
  const fillLocale = (l: PostLocale): PostLocale => {
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
    de: fillLocale(pair.de),
    en: fillLocale(pair.en),
  };
}

export function memoryPostStore(): PostStore {
  const byKey = new Map<string, Stored>();
  const slugTaken = (locale: Locale, slug: string, exceptKey: string) =>
    [...byKey.values()].some((p) => p.translationKey !== exceptKey && p[locale].slug === slug);

  return {
    async list() {
      return [...byKey.values()]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((p) => ({ translationKey: p.translationKey, titleDe: p.de.title, slugDe: p.de.slug, slugEn: p.en.slug, status: p.status, updatedAt: p.updatedAt, hasUnpublishedChanges: p.hasUnpublishedChanges }));
    },
    async get(tk) {
      const p = byKey.get(tk);
      return p ? structuredClone({ translationKey: p.translationKey, status: p.status, shared: p.shared, de: p.de, en: p.en, hasUnpublishedChanges: p.hasUnpublishedChanges }) : null;
    },
    async upsertDraft(pair) {
      pair = draftWithDefaults(pair);
      const key = pair.translationKey || randomUUID();
      const existing = byKey.get(key);
      for (const locale of ['de', 'en'] as Locale[]) {
        if (slugTaken(locale, pair[locale].slug, key)) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`, 'duplicate_slug');
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) {
          throw new PostError('cannot change the slug of a published post', 'slug_locked');
        }
      }
      const status = existing?.status ?? 'draft';
      const stored: Stored = {
        ...structuredClone(pair), translationKey: key, status, updatedAt: new Date(),
        // Preserve the published snapshot — a draft save must never touch what is live.
        publishedAt: existing?.publishedAt, publishedSnapshot: existing?.publishedSnapshot,
        hasUnpublishedChanges: status === 'published',
      };
      byKey.set(key, stored);
      return { translationKey: key, status: stored.status, shared: stored.shared, de: stored.de, en: stored.en, hasUnpublishedChanges: stored.hasUnpublishedChanges };
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

/** True when a published row's working copy was saved after its last publish. */
function rowHasUnpublishedChanges(r: PostRow | undefined): boolean {
  return !!r && r.status === 'published' && r.published_at !== null && r.updated_at.getTime() > r.published_at.getTime();
}

function rowLocale(r: PostRow): PostLocale {
  return { locale: r.locale, slug: r.slug, title: r.title, excerpt: r.excerpt, heroImage: r.hero_image, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}
function rowShared(r: PostRow): PostShared {
  const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
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
       shared.stops ? JSON.stringify(shared.stops) : null, shared.route ?? null, shared.keyFacts ? JSON.stringify(shared.keyFacts) : null,
       p.bodyMarkdown, JSON.stringify(p.images), status],
    );
  }
  return {
    async list() {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts ORDER BY updated_at DESC`);
      const byKey = new Map<string, { de?: PostRow; en?: PostRow }>();
      for (const r of rows) { const e = byKey.get(r.translation_key) ?? {}; e[r.locale] = r; byKey.set(r.translation_key, e); }
      return [...byKey.entries()].map(([tk, e]) => ({
        translationKey: tk, titleDe: e.de?.title ?? '', slugDe: e.de?.slug ?? '', slugEn: e.en?.slug ?? '',
        status: (e.de?.status ?? e.en?.status ?? 'draft') as 'draft' | 'published',
        updatedAt: new Date(Math.max(e.de?.updated_at?.getTime() ?? 0, e.en?.updated_at?.getTime() ?? 0)),
        hasUnpublishedChanges: rowHasUnpublishedChanges(e.de) || rowHasUnpublishedChanges(e.en),
      }));
    },
    async get(tk) {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts WHERE translation_key = $1`, [tk]);
      const de = rows.find((r) => r.locale === 'de'); const en = rows.find((r) => r.locale === 'en');
      if (!de || !en) return null;
      return {
        translationKey: tk, status: de.status, shared: rowShared(de), de: rowLocale(de), en: rowLocale(en),
        hasUnpublishedChanges: rowHasUnpublishedChanges(de) || rowHasUnpublishedChanges(en),
      };
    },
    async upsertDraft(pair) {
      pair = draftWithDefaults(pair);
      const tk = pair.translationKey || randomUUID();
      const existing = await this.get(tk);
      for (const locale of ['de', 'en'] as Locale[]) {
        const { rows } = await pool.query<{ translation_key: string }>(`SELECT translation_key FROM posts WHERE locale=$1 AND slug=$2`, [locale, pair[locale].slug]);
        if (rows[0] && rows[0].translation_key !== tk) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`, 'duplicate_slug');
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) throw new PostError('cannot change the slug of a published post', 'slug_locked');
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
  };
}
