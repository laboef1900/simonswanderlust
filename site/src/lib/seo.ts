import type { Root, RootContent } from 'hast';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { largestVariant } from './images.js';
import type { Locale } from '../i18n/ui.js';
import { identity } from './build-identity.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';

export type Alternates = Record<Locale, string>;

/** Fixed pages have counterparts only in bilingual installations. */
export function localeAlternates(path: (locale: Locale, language: SiteLanguage) => string, language: SiteLanguage = siteLanguage()): Alternates | undefined {
  return language.locales.length === 2 ? { de: path('de', language), en: path('en', language) } : undefined;
}

const htmlParser = unified().use(rehypeParse, { fragment: true });
const nonProseTags: Record<string, true> = {
  figure: true,
  picture: true,
  img: true,
  pre: true,
  script: true,
  style: true,
};

/** First rendered paragraphs before image decoration, excluding media/captions and code. */
export function proseDescription(html: string, fallback: string): string {
  const parts: string[] = [];
  function collect(node: Root | RootContent, inParagraph = false): void {
    if (node.type === 'text') {
      if (inParagraph) parts.push(node.value);
      return;
    }
    if (node.type !== 'root' && node.type !== 'element') return;
    if (node.type === 'element') {
      const classes = node.properties.className;
      if (nonProseTags[node.tagName] === true || (Array.isArray(classes) && classes.includes('jgal'))) return;
      if (node.tagName === 'br' && inParagraph) parts.push(' ');
      inParagraph ||= node.tagName === 'p';
    }
    for (const child of node.children) collect(child, inParagraph);
    if (node.type === 'element' && node.tagName === 'p') parts.push(' ');
  }
  collect(htmlParser.parse(html));
  const plain = parts.join('').replace(/\s+/g, ' ').trim();
  if (plain.length <= 150) return plain || fallback;
  const boundary = plain.lastIndexOf(' ', 150);
  return boundary > 0 ? plain.slice(0, boundary) : fallback;
}

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
