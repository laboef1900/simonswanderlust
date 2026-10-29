import type { Locale } from '../i18n/ui.js';
import { aboutPath, homePath, mapPath, regionPath, regionsIndexPath, type Region } from './paths.js';
import { byLocale, liveRegions, pathOf, type Trip } from './trips.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';

export type PublicRoute =
  | { path: string; kind: 'home' | 'about' | 'map' | 'regions'; locale: Locale }
  | { path: string; kind: 'region'; locale: Locale; region: Region }
  | { path: string; kind: 'story'; locale: Locale; trip: Trip };

/** One inventory for static HTML generation; absent translations never receive routes. */
export function publicRoutes(trips: Trip[], language: SiteLanguage = siteLanguage()): PublicRoute[] {
  const routes: PublicRoute[] = [];
  for (const locale of language.locales) {
    routes.push(
      { path: homePath(locale, language), kind: 'home', locale },
      { path: aboutPath(locale, language), kind: 'about', locale },
      { path: mapPath(locale, language), kind: 'map', locale },
      { path: regionsIndexPath(locale, language), kind: 'regions', locale },
    );
    for (const region of liveRegions(trips, locale, undefined, language)) {
      routes.push({ path: regionPath(region, locale, language), kind: 'region', locale, region });
    }
    for (const trip of byLocale(trips, locale, language)) {
      routes.push({ path: pathOf(trip, language), kind: 'story', locale, trip });
    }
  }
  if (new Set(routes.map(({ path }) => path)).size !== routes.length) {
    throw new Error('Conflicting public routes');
  }
  return routes;
}
