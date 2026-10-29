import { largestVariant } from './images.js';

import type { Locale } from '../i18n/ui';

import { identity } from './build-identity';
import { siteLanguage, type SiteLanguage } from './site-language';

export type Alternates = Record<Locale, string>;

/** Fixed pages have counterparts only in bilingual installations. */
export function localeAlternates(path: (locale: Locale, language: SiteLanguage) => string, language: SiteLanguage = siteLanguage()): Alternates | undefined {
  return language.locales.length === 2 ? { de: path('de', language), en: path('en', language) } : undefined;
}

/**
 * Production origin — fallback base URL when `Astro.site` is unset.
 * Single source of truth; mirrors `site` in astro.config.mjs.
 */
export const PROD_SITE = new URL('https://simonswanderlust.com');

/**
 * Formats a Date as a date-only ISO 8601 string (YYYY-MM-DD) from its LOCAL
 * calendar components.
 *
 * @ai-warning `posts.date` is a Postgres `date` column that node-pg parses as
 * local-midnight on the build host, so `toISOString()` shifts it to the
 * previous UTC day on any UTC+x builder. schema.org accepts a plain date for
 * `datePublished`; emitting local Y-M-D keeps the output timezone-proof.
 */
export function isoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface SeoImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  format?: 'jpeg';
}

export interface BlogPostingInput {
  title: string;
  /** Publication date; serialized date-only via `isoDate()` (see its warning). */
  date: Date;
  excerpt: string;
  locale: Locale;
  /** Hero image; `src` is an absolute URL per the trips Zod schema. */
  image: SeoImage;
  /** Absolute canonical URL of the story page. */
  url: string;
}

export interface BlogPostingJsonLd {
  '@context': 'https://schema.org';
  '@type': 'BlogPosting';
  headline: string;
  datePublished: string;
  description: string;
  inLanguage: Locale;
  image: { '@type': 'ImageObject'; url: string; width: number; height: number };
  author?: { '@type': 'Person'; name: string };
  mainEntityOfPage: string;
}

/** BlogPosting structured data for a story page (rendered as inline JSON-LD). */
export function blogPostingJsonLd(input: BlogPostingInput): BlogPostingJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title,
    datePublished: isoDate(input.date),
    description: input.excerpt,
    inLanguage: input.locale,
    image: {
      '@type': 'ImageObject',
      url: largestVariant(input.image),
      width: input.image.width,
      height: input.image.height,
    },
    ...(identity.authorName ? { author: { '@type': 'Person' as const, name: identity.authorName } } : {}),
    mainEntityOfPage: input.url,
  };
}

/**
 * Serializes an object for an inline `<script type="application/ld+json" set:html={…}>`.
 *
 * @ai-warning Titles/excerpts are CMS-authored: with plain JSON.stringify a
 * `</script>` in content would terminate the script element (XSS). Escaping
 * every `<` as the JSON escape `\u003c` neutralizes `</script>` and `<!--`
 * while staying valid JSON — keep this whenever JSON is injected via set:html.
 */
export function serializeJsonLd(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
