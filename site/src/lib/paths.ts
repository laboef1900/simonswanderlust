// Explicit .js extension so this module also resolves under NodeNext (the
// uploader's tests import `regions` cross-tree to pin db.ts REGIONS to it).
import type { Locale } from '../i18n/ui.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';
import { routeWords, wordsFor } from './route-words.js';

/**
 * The closed region set, in display order (continents, roughly west-east then
 * south). The content schema's Zod enum is derived from this tuple.
 * @ai-context docs/superpowers/specs/2026-10-19-new-regions-design.md
 */
export const regions = [
  'europe',
  'asia',
  'africa',
  'north-america',
  'south-america',
  'oceania',
  'antarctica',
] as const;
export type Region = (typeof regions)[number];

/**
 * Region page slugs per locale.
 * @ai-warning `europe`, `north-america` and `south-america` are the live
 * WordPress slugs — preserved exactly (SEO requirement, Golden Rule 2). The
 * other four were added 2026-10-19 with no WordPress counterpart (and no legacy
 * redirect); now that they are public URLs they must not change either.
 * Slugs are per locale and mode-independent; only localePrefix varies with
 * the primary locale (owner-approved #283, 2026-10-27).
 */
export const regionSlugs: Record<Region, Record<Locale, string>> = {
  europe: { de: 'europa', en: 'europe' },
  asia: { de: 'asien', en: 'asia' },
  africa: { de: 'afrika', en: 'africa' },
  'north-america': { de: 'nordamerika', en: 'north-america' },
  'south-america': { de: 'suedamerika', en: 'south-america' },
  oceania: { de: 'ozeanien', en: 'oceania' },
  antarctica: { de: 'antarktis', en: 'antarctica' },
};

/** @ai-warning Primary at root, secondary at /<locale>/. DE-primary keeps every live WP URL. */
export function localePrefix(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  if (!language.locales.includes(locale)) throw new Error('Locale is not enabled');
  return locale === language.primary ? '' : `/${locale}`;
}

export function homePath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/`;
}

export function aboutPath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/${wordsFor(locale, language.primary).about}/`;
}

export function mapPath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/${wordsFor(locale, language.primary).map}/`;
}

export function regionsIndexPath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/${wordsFor(locale, language.primary).regions}/`;
}

export function regionPath(region: Region, locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return regionsIndexPath(locale, language) + regionSlugs[region][locale] + '/';
}

export function rssPath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/rss.xml`;
}

export function storyPath(slug: string, locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/${slug}/`;
}

export const journeyBases: Record<Locale, string> = { de: routeWords.de.journeys, en: routeWords.en.journeys };

export function journeysIndexPath(locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${localePrefix(locale, language)}/${journeyBases[locale]}/`;
}

export function journeyPath(slug: string, locale: Locale, language: SiteLanguage = siteLanguage()): string {
  return `${journeysIndexPath(locale, language)}${slug}/`;
}
