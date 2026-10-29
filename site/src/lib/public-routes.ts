import type { Locale } from '../i18n/ui.js';
import { aboutPath, homePath, mapPath, regionPath, regionsIndexPath, type Region } from './paths.js';
import { byLocale, liveRegions, pathOf, type Trip } from './trips.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';
import { journeysIndexPath } from './paths.js';
import { liveJourneys, journeyPositions, type Journey, type LiveJourney, type JourneyPosition } from './journeys.js';

export type PublicRoute =
  | { path: string; kind: 'home' | 'about' | 'map' | 'regions'; locale: Locale }
  | { path: string; kind: 'region'; locale: Locale; region: Region }
  | { path: string; kind: 'journeys'; locale: Locale; journeys: LiveJourney[] }
  | { path: string; kind: 'journey'; locale: Locale; journey: LiveJourney }
  | { path: string; kind: 'story'; locale: Locale; trip: Trip; journeyPosition?: JourneyPosition };

/** One inventory for static HTML generation; absent translations never receive routes. */
export function publicRoutes(trips: Trip[], language: SiteLanguage = siteLanguage(), journeys: Journey[] = []): PublicRoute[] {
  const routes: PublicRoute[] = [];
  for (const locale of language.locales) {
    const live = liveJourneys(journeys, trips, locale, language);
    const positions = journeyPositions(live, journeys);
    if (live.length) routes.push({ path: journeysIndexPath(locale, language), kind: 'journeys', locale, journeys: live });
    for (const journey of live) routes.push({ path: journey.path, kind: 'journey', locale, journey });
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
      routes.push({ path: pathOf(trip, language), kind: 'story', locale, trip,
        ...(positions.has(trip.id) ? { journeyPosition: positions.get(trip.id)! } : {}) });
    }
  }
  if (new Set(routes.map(({ path }) => path)).size !== routes.length) {
    throw new Error('Conflicting public routes');
  }
  return routes;
}
