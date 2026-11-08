import type { Locale } from '../i18n/ui';
import type { Region } from './paths';
import { byLocale, entryNumberOf, heroAltOf, pathOf, type Trip } from './trips';
import { focusPercent, smallestVariant } from './images';
import type { PublicTrack } from './public-track';
import type { PublicStopRoute } from './public-stop-route';

export interface PinFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { title: string; href: string; country: string; region: Region };
}
/** Thumbnail for the overview map's popup: smallest variant, decorative alt when it only repeats the title. */
export interface PinPhoto { src: string; width: number; height: number; alt: string; position?: string }
/** An overview-map pin: travel-log entry number (oldest = 1, as `entryNumberOf`) plus its photo. */
export interface OverviewPinFeature extends PinFeature {
  properties: PinFeature['properties'] & { number: number; photo: PinPhoto };
}
export interface PinCollection { type: 'FeatureCollection'; features: OverviewPinFeature[] }
export interface StopFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { name: string };
}
/** At most one line: a published GPX `track` always wins over a `stopRoute` (#513). */
export interface TripGeometry { pin: PinFeature; stops: StopFeature[]; track?: PublicTrack; stopRoute?: PublicStopRoute }

function pinOf(trip: Trip): PinFeature {
  const { lat, lng } = trip.data.coordinates;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { title: trip.data.title, href: pathOf(trip), country: trip.data.country, region: trip.data.region as Region },
  };
}

function overviewPinOf(trip: Trip, all: Trip[]): OverviewPinFeature {
  const pin = pinOf(trip);
  const hero = trip.data.heroImage;
  const position = focusPercent(hero);
  return {
    ...pin,
    properties: {
      ...pin.properties,
      number: entryNumberOf(trip, all),
      photo: {
        src: smallestVariant(hero),
        width: hero.width,
        height: hero.height,
        // The popup sets the title right beside the photo (same rule as story cards).
        alt: heroAltOf(trip) ?? hero.alt,
        ...(position ? { position } : {}),
      },
    },
  };
}

export function tripPins(trips: Trip[], locale: Locale): PinCollection {
  return { type: 'FeatureCollection', features: byLocale(trips, locale).map((trip) => overviewPinOf(trip, trips)) };
}

export function tripGeometry(trip: Trip): TripGeometry {
  // @ai-note Via points shape the stop route only. Dropping them HERE keeps their
  // names out of pins, the stop list and the serialized `data-geometry` alike.
  const stops: StopFeature[] = (trip.data.stops ?? []).filter((s) => s.via !== true).map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { name: s.name },
  }));
  const line = trip.data.track ? { track: trip.data.track } : trip.data.stopRoute ? { stopRoute: trip.data.stopRoute } : {};
  return { pin: pinOf(trip), stops, ...line };
}
