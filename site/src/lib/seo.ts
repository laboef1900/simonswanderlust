import type { Locale } from '../i18n/ui';

// @ai-note: schema.org structured data, not user-visible UI copy — deliberately
// not a ui.ts key (same author for both locales; keeps i18n churn out of SEO).
const AUTHOR_NAME = 'Simon';

export interface SeoImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export interface BlogPostingInput {
  title: string;
  /** Publication date as an ISO 8601 string (e.g. `date.toISOString()`). */
  dateIso: string;
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
  author: { '@type': 'Person'; name: string };
  mainEntityOfPage: string;
}

/** BlogPosting structured data for a story page (rendered as inline JSON-LD). */
export function blogPostingJsonLd(input: BlogPostingInput): BlogPostingJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title,
    datePublished: input.dateIso,
    description: input.excerpt,
    inLanguage: input.locale,
    image: {
      '@type': 'ImageObject',
      url: input.image.src,
      width: input.image.width,
      height: input.image.height,
    },
    author: { '@type': 'Person', name: AUTHOR_NAME },
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
