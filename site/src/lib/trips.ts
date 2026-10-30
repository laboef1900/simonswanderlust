import type { CollectionEntry } from 'astro:content';
import type { Locale, UIKey } from '../i18n/ui';
import { countLabel } from '../i18n/count';
import { regions, type Region } from './paths';

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

/**
 * Alt text for a trip's hero photo, or `''` when the stored alt would only
 * repeat text the surrounding markup already announces.
 *
 * @ai-note Every WordPress-imported post stores the post title as its hero
 * alt, and both places a hero appears (the home hero's entry heading, a story
 * card's `<h3>`) name the title right beside the image — so that alt was heard
 * twice. A hand-written description of the photograph is different content and
 * DOES reach the reader: `alt=""` was hardcoded on story cards, which threw
 * away the only photographic information a screen-reader user could have got
 * from a photography-led index.
 *
 * @ai-warning The comparison is case-INSENSITIVE, and that is a cross-tree
 * contract: `uploader/src/alt-audit.ts` applies the same rule to decide which
 * photos the editor warns an author about. Tightening this to `===` would have
 * the admin flagging a hero the site still describes (alt "RHODOS" on a post
 * titled "Rhodos"), and loosening it further would silently drop a real
 * description. The two trees have separate tsconfigs and cannot share the
 * type, so the only thing keeping them honest is this pair of comments and
 * their tests.
 */
export function heroAltOf(trip: Trip): string | undefined {
  const alt = trip.data.heroImage.alt.trim();
  return alt.toLowerCase() === trip.data.title.trim().toLowerCase() ? '' : undefined;
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
 * @ai-note `region` doubles as the continent axis (the Zod enum is `regions`
 * in paths.ts), and countries are counted by `countryCode` so spelling
 * differences between locales cannot inflate them.
 */
export function tripStats(trips: Trip[]): TripStats {
  return {
    trips: trips.length,
    countries: new Set(trips.map((t) => t.data.countryCode)).size,
    continents: new Set(trips.map((t) => t.data.region)).size,
  };
}

/**
 * Story count per region for one locale's set, for the region chips.
 *
 * @ai-note Every region gets a key, including zero-count ones, so a caller
 * indexing by any `Region` reads an honest 0 rather than `undefined`.
 */
export function regionCounts(trips: Trip[]): Record<Region, number> {
  const counts = Object.fromEntries(regions.map((r) => [r, 0])) as Record<Region, number>;
  for (const trip of trips) {
    const region = trip.data.region as Region;
    if (region in counts) counts[region] += 1;
  }
  return counts;
}

/**
 * The regions that have a page in `locale`, in display order: those with at
 * least one published story there. `keep` (the region whose page is being
 * rendered) is always included.
 *
 * @ai-warning This is the ONE rule for "which region pages exist". The region
 * routes' `getStaticPaths`, the destination links and the hreflang alternates
 * all read it, so a region that is linked is always a region that is built —
 * and a region without stories never becomes a thin, empty public page.
 * @ai-context docs/superpowers/specs/2026-10-19-new-regions-design.md §2
 */
export function liveRegions(trips: Trip[], locale: Locale, keep?: Region): Region[] {
  const counts = regionCounts(trips.filter((t) => localeOf(t) === locale));
  return regions.filter((region) => region === keep || counts[region] > 0);
}

/** "20 REISEN · 10 LÄNDER · 3 KONTINENTE" — the expedition-log stat line. */
export function statsLine(stats: TripStats, t: (key: UIKey) => string): string {
  return [
    `${stats.trips} ${countLabel(stats.trips, t('stats.trip'), t('stats.trips'))}`,
    `${stats.countries} ${countLabel(stats.countries, t('stats.country'), t('stats.countries'))}`,
    `${stats.continents} ${countLabel(stats.continents, t('stats.continent'), t('stats.continents'))}`,
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
