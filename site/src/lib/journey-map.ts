import type { LiveJourney } from './journeys.js';
import { pathOf } from './trips.js';

export interface JourneyGeometry {
  pins: { number: number; title: string; href: string; coordinates: [number, number] }[];
  tracks: { type: 'FeatureCollection'; features: {
    type: 'Feature'; properties: Record<string, never>;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }[] };
}

/** @ai-warning §9 of the approved journeys spec: never join pins, runs or stories.
 * Only published GPX runs are lines; stops and private route sources are not inputs. */
export function journeyGeometry(journey: LiveJourney): JourneyGeometry {
  return {
    pins: journey.members.map((trip, index) => ({
      number: index + 1, title: trip.data.title, href: pathOf(trip),
      coordinates: [trip.data.coordinates.lng, trip.data.coordinates.lat] as [number, number],
    })),
    tracks: {
      type: 'FeatureCollection' as const,
      features: journey.members.flatMap((trip) => (trip.data.track?.coordinates ?? []).map((coordinates) => ({
        type: 'Feature' as const, properties: {},
        geometry: { type: 'LineString' as const, coordinates },
      }))),
    },
  };
}
