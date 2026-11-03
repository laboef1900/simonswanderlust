import type { Locale } from '../i18n/ui';
import type { Region } from './paths';
import { byLocale, pathOf, type Trip } from './trips';
import type { PublicTrack } from './public-track';
import type { PublicStopRoute } from './public-stop-route';

export interface PinFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { title: string; href: string; country: string; region: Region };
}
export interface PinCollection { type: 'FeatureCollection'; features: PinFeature[] }
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

export function tripPins(trips: Trip[], locale: Locale): PinCollection {
  return { type: 'FeatureCollection', features: byLocale(trips, locale).map(pinOf) };
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
