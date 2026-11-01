import type { CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n/ui.js';
import { journeyPath } from './paths.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';
import { localeOf, type Trip } from './trips.js';

export type Journey = CollectionEntry<'journeys'>;
export interface LiveJourney { entry: Journey; locale: Locale; path: string; members: Trip[] }
export interface JourneyPosition { journey: LiveJourney; index: number }

/** The only public membership projection: the supplied trips are published snapshots. */
export function liveJourneys(journeys: Journey[], trips: Trip[], locale: Locale, language: SiteLanguage = siteLanguage()): LiveJourney[] {
  if (!language.locales.includes(locale)) return [];
  const published = new Map(trips.filter((trip) => localeOf(trip) === locale).map((trip) => [trip.data.translationKey, trip]));
  return journeys.filter((entry) => entry.id.startsWith(`${locale}/`)).flatMap((entry) => {
    const members = entry.data.members.flatMap((key) => {
      const trip = published.get(key);
      return trip ? [trip] : [];
    });
    return members.length ? [{ entry, locale, path: journeyPath(entry.id.slice(3), locale, language), members }] : [];
  });
}

/** Corrupt duplicate claims keep both lists, but must never choose an arbitrary strip. */
export function journeyPositions(journeys: LiveJourney[], snapshots: Journey[], warn: (message: string) => void = console.warn): Map<string, JourneyPosition> {
  const positions = new Map<string, JourneyPosition>();
  const claims = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entry of snapshots) for (const key of entry.data.members) {
    const owner = claims.get(key);
    if (owner !== undefined && owner !== entry.data.journeyId) ambiguous.add(key);
    else claims.set(key, entry.data.journeyId);
  }
  if (ambiguous.size) warn('Published journey snapshots contain duplicate story claims; ambiguous journey strips omitted.');
  for (const journey of journeys) for (const [index, member] of journey.members.entries()) {
    if (!ambiguous.has(member.data.translationKey)) positions.set(member.id, { journey, index });
  }
  return positions;
}

export function journeyAlternates(journey: LiveJourney, journeys: Journey[], trips: Trip[], language: SiteLanguage = siteLanguage()): { de: string; en: string } | undefined {
  const paths: Partial<Record<Locale, string>> = {};
  for (const locale of language.locales) {
    const other = liveJourneys(journeys, trips, locale, language).find((candidate) => candidate.entry.data.journeyId === journey.entry.data.journeyId);
    if (other) paths[locale] = other.path;
  }
  return paths.de && paths.en ? { de: paths.de, en: paths.en } : undefined;
}
