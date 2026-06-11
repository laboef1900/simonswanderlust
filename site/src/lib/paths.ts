import type { Locale } from '../i18n/ui';

export const regions = ['europe', 'north-america', 'south-america'] as const;
export type Region = (typeof regions)[number];

/** Live WordPress slugs — preserved exactly (SEO requirement, see spec §4). */
export const regionSlugs: Record<Region, Record<Locale, string>> = {
  europe: { de: 'europa', en: 'europe' },
  'north-america': { de: 'nordamerika', en: 'north-america' },
  'south-america': { de: 'suedamerika', en: 'south-america' },
};

export function homePath(locale: Locale): string {
  return locale === 'en' ? '/en/' : '/';
}

export function aboutPath(locale: Locale): string {
  return locale === 'en' ? '/en/about-me/' : '/uber-mich/';
}

export function regionsIndexPath(locale: Locale): string {
  return locale === 'en' ? '/en/destinations/' : '/reiseziele/';
}

export function regionPath(region: Region, locale: Locale): string {
  return regionsIndexPath(locale) + regionSlugs[region][locale] + '/';
}
