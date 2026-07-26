import type { CollectionEntry } from 'astro:content';
import type { Locale, UIKey } from '../i18n/ui';

export type Trip = CollectionEntry<'trips'>;

export function localeOf(trip: Trip): Locale {
  // Two-locale design: 'en/' prefix → EN, everything else → DE.
  // If a third locale is ever added, update this function and the Locale union first.
  return trip.id.startsWith('en/') ? 'en' : 'de';
}

/** Strips the leading locale segment from a glob-loader entry id (e.g. 'de/slug' → 'slug'). */
export function slugOf(trip: Trip): string {
  return trip.id.replace(/^(de|en)\//, '');
}

/** URL of a story — DE at root, EN under /en/ (live WP structure). */
export function pathOf(trip: Trip): string {
  const slug = slugOf(trip);
  return localeOf(trip) === 'en' ? `/en/${slug}/` : `/${slug}/`;
}

export function byLocale(trips: Trip[], locale: Locale): Trip[] {
  return trips
    .filter((t) => localeOf(t) === locale)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function translationOf(trip: Trip, all: Trip[]): Trip | undefined {
  return all.find(
    (t) => t.data.translationKey === trip.data.translationKey && localeOf(t) !== localeOf(trip),
  );
}

export interface TripStats {
  trips: number;
  countries: number;
  continents: number;
}

/**
 * Headline counts for a set of trips (pass one locale's set — the DE and EN
 * sets mirror each other, so counting both would double every number).
 *
 * @ai-warning These were once hardcoded ("20 REISEN · 10 LÄNDER · 3 KONTINENTE")
 * and went stale the moment a post was published. Always derive them here.
 * @ai-note `region` doubles as the continent axis (the Zod enum is
 * europe / north-america / south-america), and countries are counted by
 * `countryCode` so spelling differences between locales cannot inflate them.
 */
export function tripStats(trips: Trip[]): TripStats {
  return {
    trips: trips.length,
    countries: new Set(trips.map((t) => t.data.countryCode)).size,
    continents: new Set(trips.map((t) => t.data.region)).size,
  };
}

/** "20 REISEN · 10 LÄNDER · 3 KONTINENTE" — the expedition-log stat line. */
export function statsLine(stats: TripStats, t: (key: UIKey) => string): string {
  return [
    `${stats.trips} ${t('stats.trips')}`,
    `${stats.countries} ${t('stats.countries')}`,
    `${stats.continents} ${t('stats.continents')}`,
  ].join(' · ');
}

/** 1-based chronological number (oldest = 1) of a trip within its locale's set. */
export function entryNumberOf(trip: Trip, all: Trip[]): number {
  const siblings = byLocale(all, localeOf(trip));
  const idx = siblings.findIndex((t) => t.id === trip.id);
  // Guard: if trip isn't in the pool (caller passed a filtered subset), N°00 signals the bug.
  if (idx === -1) return 0;
  return siblings.length - idx;
}
