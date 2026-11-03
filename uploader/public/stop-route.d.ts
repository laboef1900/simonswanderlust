export type RoutedProfile = 'car' | 'bike' | 'foot';
export type LegProfile = RoutedProfile | 'straight';
export type LegFallback = 'no_route' | 'provider_error';
export type RunKind = 'road' | 'straight';

/**
 * One stored stop row. `via` and `profile` are present only when they differ
 * from the default (`via: true`; `profile` other than `car`). `profile` on
 * stop i governs the leg i → i+1 and is never stored on the last stop.
 */
export interface RouteStop {
  name: string;
  lat: number;
  lng: number;
  via?: true;
  profile?: Exclude<LegProfile, 'car'>;
}

/** Public projection copied into published_snapshot.stop_route. */
export interface PublicStopRoute {
  version: 1;
  /** 1..100 runs, <= 2000 vertices total, <= 64 KiB compact JSON. */
  runs: { kind: RunKind; coordinates: [number, number][] }[];
}

export interface StopRouteLeg {
  profile: LegProfile;
  kind: RunKind;
  /** Present only on a routed-profile leg that fell back to a straight line. */
  fallback?: LegFallback;
}

/** Private stored route: posts.stop_route, identical on both rows of a pair. */
export interface StoredStopRoute {
  version: 1;
  /** sha256 hex of stopRouteBasis(stops) at calculation time. */
  fingerprint: string;
  /** ISO 8601 UTC with milliseconds. */
  computedAt: string;
  /** One entry per leg (stops.length - 1), in stop order. */
  legs: StopRouteLeg[];
  route: PublicStopRoute;
}

export class StopRouteError extends Error {
  readonly code: string;
  readonly index?: number;
  constructor(code: string, index?: number);
}

export const ROUTED_PROFILES: readonly RoutedProfile[];
export const LEG_PROFILES: readonly LegProfile[];
export const DEFAULT_LEG_PROFILE: 'car';
export const LEG_FALLBACKS: readonly LegFallback[];
export const RUN_KINDS: readonly RunKind[];
export const STOP_ROUTE_LIMITS: Readonly<{ stops: 25; runs: 100; vertices: 2000; bytes: 65536 }>;

export function normalizeStopRoutingFields(stops: unknown): unknown;
export function validateRouteStops(stops: unknown): RouteStop[];
export function legProfile(stops: readonly { profile?: string }[], index: number): LegProfile;
export function stopRouteBasis(stops: readonly { lat: number; lng: number; via?: boolean; profile?: string }[]): string;
export function stopRouteFingerprint(stops: readonly { lat: number; lng: number; via?: boolean; profile?: string }[]): Promise<string>;
export function validatePublicStopRoute(value: unknown): PublicStopRoute;
export function validateStoredStopRoute(value: unknown): StoredStopRoute;
