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
export class PostError extends Error {}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<PostPair | null>;
  upsertDraft(pair: PostPair): Promise<PostPair>;
  publish(translationKey: string): Promise<void>;
}

interface Stored extends PostPair { updatedAt: Date }

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REGIONS = ['europe', 'north-america', 'south-america'];

function checkSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new PostError(`invalid slug "${slug}" (lowercase a-z, 0-9, hyphen)`);
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
  if (!s.country.trim()) throw new PostError('country required');
  if (!s.date.trim()) throw new PostError('date required');
  validateLocale(pair.de);
  validateLocale(pair.en);
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
      const key = pair.translationKey || randomUUID();
      const existing = byKey.get(key);
      for (const locale of ['de', 'en'] as Locale[]) {
        if (slugTaken(locale, pair[locale].slug, key)) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`);
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) {
          throw new PostError('cannot change the slug of a published post');
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
