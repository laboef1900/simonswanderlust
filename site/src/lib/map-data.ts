import type { Locale } from '../i18n/ui';
import type { Region } from './paths';
import { byLocale, pathOf, type Trip } from './trips';

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
export interface TripGeometry { pin: PinFeature; stops: StopFeature[] }

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
  const stops: StopFeature[] = (trip.data.stops ?? []).map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { name: s.name },
  }));
  return { pin: pinOf(trip), stops };
}
