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
