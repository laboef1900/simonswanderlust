import type { LanguageConfig, LanguageLocale } from './language.js';
import { regionSlugs, type Region } from '../../site/src/lib/paths.js';
export type PublicPathKind = 'home' | 'story' | 'about' | 'map' | 'regions' | 'region' | 'rss';
export function publicPath(language: LanguageConfig, locale: LanguageLocale, kind: PublicPathKind, slug?: string): string {
  if (!language.locales.includes(locale)) throw new Error('Locale is not enabled');
  const prefix = locale === language.primary ? '' : `/${locale}`;
  const words = locale === 'de' ? { about: 'uber-mich', map: 'karte', regions: 'reiseziele' }
    : { about: 'about-me', map: prefix ? 'map' : 'travel-map', regions: 'destinations' };
  if (kind === 'home') return `${prefix}/`;
  if (kind === 'rss') return `${prefix}/rss.xml`;
  if (kind === 'story') {
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Invalid public slug');
    return `${prefix}/${slug}/`;
  }
  if (kind === 'region') {
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Invalid region slug');
    return `${prefix}/${words.regions}/${slug}/`;
  }
  return `${prefix}/${words[kind]}/`;
}
export interface PublicUrlRow { locale: LanguageLocale; slug: string; status: string; published_snapshot: unknown | null }
/** The uploader's URL mirror, not a working-content projection. */
export function publicUrlSet(language: LanguageConfig, rows: readonly PublicUrlRow[]): string[] {
  const paths = new Set(['/404.html', '/sitemap-index.xml', '/sitemap-0.xml']);
  for (const locale of language.locales) {
    for (const kind of ['home', 'about', 'map', 'regions', 'rss'] as const) paths.add(publicPath(language, locale, kind));
  }
  for (const row of rows) {
    if (language.locales.includes(row.locale) && row.status === 'published' && row.published_snapshot !== null) {
      paths.add(publicPath(language, row.locale, 'story', row.slug));
      const snapshot = row.published_snapshot;
      if (snapshot && typeof snapshot === 'object' && 'region' in snapshot && typeof snapshot.region === 'string'
        && Object.hasOwn(regionSlugs, snapshot.region)) {
        paths.add(publicPath(language, row.locale, 'region', regionSlugs[snapshot.region as Region][row.locale]));
      }
    }
  }
  return [...paths].sort();
}
