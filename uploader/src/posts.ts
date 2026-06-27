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
export interface PostSummary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: 'draft' | 'published'; updatedAt: Date;
}
export class PostError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<PostPair | null>;
  upsertDraft(pair: PostPair): Promise<PostPair>;
  publish(translationKey: string): Promise<void>;
}

interface Stored extends PostPair { updatedAt: Date }

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
 * Fill the NOT-NULL columns the editor can omit on a partial draft save
 * (`coordinates`, `heroImage`) so a draft can never write NULL (Postgres 23502).
 * The placeholders match the WordPress-import defaults and still fail
 * `validateForPublish` until the author completes them.
 */
function draftWithDefaults(pair: PostPair): PostPair {
  const fillLocale = (l: PostLocale): PostLocale => ({
    ...l,
    heroImage: l.heroImage ?? PLACEHOLDER_HERO,
    images: l.images ?? {},
  });
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
        .map((p) => ({ translationKey: p.translationKey, titleDe: p.de.title, slugDe: p.de.slug, slugEn: p.en.slug, status: p.status, updatedAt: p.updatedAt }));
    },
    async get(tk) {
      const p = byKey.get(tk);
      return p ? structuredClone({ translationKey: p.translationKey, status: p.status, shared: p.shared, de: p.de, en: p.en }) : null;
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
      const stored: Stored = { ...structuredClone(pair), translationKey: key, status: existing?.status ?? 'draft', updatedAt: new Date() };
      byKey.set(key, stored);
      return { translationKey: key, status: stored.status, shared: stored.shared, de: stored.de, en: stored.en };
    },
    async publish(tk) {
      const p = byKey.get(tk);
      if (!p) throw new PostError('post not found');
      p.status = 'published';
      p.updatedAt = new Date();
    },
  };
}

import type { DbPool } from './db.js';

interface PostRow {
  translation_key: string; locale: Locale; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: HeroImage; coordinates: { lat: number; lng: number };
  stops: PostShared['stops'] | null; route: string | null; key_facts: Record<string, string> | null;
  body_markdown: string; images: Record<string, ImageDims>; status: 'draft' | 'published'; updated_at: Date;
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
      }));
    },
    async get(tk) {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts WHERE translation_key = $1`, [tk]);
      const de = rows.find((r) => r.locale === 'de'); const en = rows.find((r) => r.locale === 'en');
      if (!de || !en) return null;
      return { translationKey: tk, status: de.status, shared: rowShared(de), de: rowLocale(de), en: rowLocale(en) };
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
      const res = await pool.query(`UPDATE posts SET status='published', updated_at=now() WHERE translation_key=$1`, [tk]);
      if (res.rowCount === 0) throw new PostError('post not found');
    },
  };
}
