import type { CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n/ui';

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
