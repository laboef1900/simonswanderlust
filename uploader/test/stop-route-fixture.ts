import { normalizeStopRoutingFields, type RouteStop, type StoredStopRoute } from '../public/stop-route.js';
import { stopRouteFingerprintSync } from '../src/stop-route-fingerprint.js';

const round = (value: number) => Math.round(value * 10000) / 10000 || 0;

/** A valid stored route for these stops: one straight run per leg, fresh fingerprint. */
export function storedRouteFor(stops: RouteStop[], computedAt = '2026-11-03T10:00:00.000Z'): StoredStopRoute {
  const normalized = normalizeStopRoutingFields(stops) as RouteStop[];
  const legs = normalized.slice(1).map(() => ({ profile: 'straight' as const, kind: 'straight' as const }));
  return {
    version: 1,
    fingerprint: stopRouteFingerprintSync(normalized),
    computedAt,
    legs,
    route: {
      version: 1,
      runs: normalized.slice(1).map((stop, index) => ({
        kind: 'straight' as const,
        coordinates: [[round(normalized[index]!.lng), round(normalized[index]!.lat)], [round(stop.lng), round(stop.lat)]] as [number, number][],
      })),
    },
  };
}

export const ROUTE_STOPS: RouteStop[] = [
  { name: 'Athens', lat: 37.9838, lng: 23.7275 },
  { name: 'Megara', lat: 37.9961, lng: 23.3439, via: true },
  { name: 'Corinth', lat: 37.9407, lng: 22.9322, profile: 'bike' },
  { name: 'Patras', lat: 38.2466, lng: 21.7346 },
];
