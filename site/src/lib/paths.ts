// Explicit .js extension so this module also resolves under NodeNext (the
// uploader's tests import `regions` cross-tree to pin db.ts REGIONS to it).
import type { Locale } from '../i18n/ui.js';

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

export function homePath(locale: Locale): string {
  return locale === 'en' ? '/en/' : '/';
}

export function aboutPath(locale: Locale): string {
  return locale === 'en' ? '/en/about-me/' : '/uber-mich/';
}

export function mapPath(locale: Locale): string {
  return locale === 'en' ? '/en/map/' : '/karte/';
}

export function regionsIndexPath(locale: Locale): string {
  return locale === 'en' ? '/en/destinations/' : '/reiseziele/';
}

export function regionPath(region: Region, locale: Locale): string {
  return regionsIndexPath(locale) + regionSlugs[region][locale] + '/';
}
