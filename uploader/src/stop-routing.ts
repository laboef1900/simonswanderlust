import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { safeFetch, type LookupFn } from './safe-fetch.js';
import { isInternalRoutingOrigin, routingEndpointUsable } from './routing-origins.js';
import { normalizeCanonicalOrigin } from '../../site/src/lib/site-identity.js';
import { simplifyRun } from '../public/gpx-public-track.js';
import {
  ROUTED_PROFILES, STOP_ROUTE_LIMITS, legProfile, validateStoredStopRoute,
  type LegFallback, type PublicStopRoute, type RouteStop, type RoutedProfile, type RunKind, type StopRouteLeg, type StoredStopRoute,
} from '../public/stop-route.js';
import { stopRouteFingerprintSync } from './stop-route-fingerprint.js';

// @ai-context docs/superpowers/specs/2026-11-03-issue-513-stop-routing-design.md ("Calculate")
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** ≥ 1.1 s between outbound requests, app-wide (FOSSGIS policy: at most one request per second). */
export const ROUTING_SPACING_MS = 1100;
export const ROUTING_LEG_TIMEOUT_MS = 10_000;
/** Legs not started within this budget fall back to `provider_error`. */
export const ROUTING_BUDGET_MS = 60_000;
export const ROUTING_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Farthest OSRM may move a stop onto its road graph. Without a bound OSRM
 * snaps ANY coordinate to the nearest covered road, however far: stops outside
 * the extract came back as a 0 m "road" at the extract's edge, or as a road leg
 * ending in another country. Beyond this radius OSRM answers NoSegment, which
 * becomes a flagged straight `no_route` leg.
 */
export const ROUTING_SNAP_RADIUS_METRES = 5000;
const MAX_PROVIDER_POSITIONS = 100_000;
const FIRST_TOLERANCE_METRES = 25;
/** ~26,000 km: every run is down to its endpoints long before this. */
const MAX_TOLERANCE_METRES = 25 * 2 ** 20;
/** The `{profile}` URL segment documents intent only: osrm-routed serves the graph it was built with. */
const SEGMENT: Record<RoutedProfile, string> = { car: 'driving', bike: 'cycling', foot: 'walking' };

export type StopRoutingErrorCode = 'stop_route_busy' | 'stop_route_profile_unavailable' | 'stop_route_failed'
  | 'stop_route_empty' | 'stop_route_too_complex';

export class StopRoutingError extends Error {
  constructor(readonly code: StopRoutingErrorCode, readonly status: number, readonly profiles?: RoutedProfile[]) {
    super(code);
  }
}

export interface StopRouter {
  /** Which routed profiles have a configured endpoint. */
  profiles(): Record<RoutedProfile, boolean>;
  /**
   * Why `calculate(stops)` would refuse right now (an unavailable profile, or a
   * calculation already in flight), or null. Starts nothing, so a caller can
   * answer these refusals before spending a rate-limit slot.
   */
  refusal(stops: readonly RouteStop[]): StopRoutingError | null;
  /** Route validated, normalized stops in order. Never stores; the caller persists the result. */
  calculate(stops: readonly RouteStop[]): Promise<StoredStopRoute>;
}

export interface StopRouterOptions {
  endpoints: () => Record<RoutedProfile, string>;
  canonicalOrigin?: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  request?: typeof safeFetch;
  /** Transport under safeFetch; tests inject it together with `lookup`. */
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  /** ROUTING_INTERNAL_ORIGINS: the only origins reachable over plain HTTP or on a private network. */
  internalOrigins?: ReadonlySet<string>;
}

type Position = [number, number];
interface LegLine { kind: RunKind; points: Position[] }
type LegOutcome = { kind: 'road'; points: Position[] } | { kind: 'straight'; fallback?: LegFallback };

/** Provider geometry is untrusted: a LineString of 2..100,000 finite, in-range [lng, lat] pairs. */
function providerLine(data: unknown): Position[] | 'no_route' | null {
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  if (data.code === 'NoRoute' || data.code === 'NoSegment') return 'no_route';
  if (data.code !== 'Ok' || !('routes' in data) || !Array.isArray(data.routes)) return null;
  const route: unknown = data.routes[0];
  if (typeof route !== 'object' || route === null || !('geometry' in route)) return null;
  const geometry: unknown = route.geometry;
  if (typeof geometry !== 'object' || geometry === null || !('type' in geometry) || geometry.type !== 'LineString'
    || !('coordinates' in geometry)) return null;
  const coordinates: unknown = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > MAX_PROVIDER_POSITIONS) return null;
  const points: Position[] = [];
  for (const position of coordinates) {
    if (!Array.isArray(position) || position.length < 2) return null;
    const [lng, lat] = position;
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)
      || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    points.push([lng, lat]);
  }
  return points;
}

/** Split where consecutive points jump more than 180° of longitude, inserting interpolated ±180 boundary vertices. */
export function splitAntimeridian(points: readonly Position[]): Position[][] {
  const runs: Position[][] = [];
  let run: Position[] = [];
  for (const point of points) {
    const previous = run[run.length - 1];
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      const east = previous[0] > 0; // crossing +180 eastwards into negative longitudes
      const shifted = point[0] + (east ? 360 : -360);
      const edge = east ? 180 : -180;
      const t = (edge - previous[0]) / (shifted - previous[0]);
      const lat = previous[1] + t * (point[1] - previous[1]);
      run.push([edge, lat]);
      runs.push(run);
      run = [[-edge, lat]];
    }
    run.push(point);
  }
  runs.push(run);
  return runs;
}

/** Bounds Douglas–Peucker work (worst case quadratic) for pathological provider lines. */
const MAX_PIECE_POINTS = 10_000;

function thin(points: readonly Position[]): Position[] {
  if (points.length <= MAX_PIECE_POINTS) return [...points];
  const stride = Math.ceil(points.length / MAX_PIECE_POINTS);
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
}

function project(lines: readonly LegLine[]): PublicStopRoute | 'empty' | 'too_complex' {
  let pieces = lines.flatMap((line) => splitAntimeridian(line.points).map((points) => ({ kind: line.kind, points: thin(points) })));
  let survived = false;
  for (let tolerance = FIRST_TOLERANCE_METRES; tolerance <= MAX_TOLERANCE_METRES; tolerance *= 2) {
    // Progressive: each pass simplifies the previous pass's output, so widening stays cheap.
    pieces = pieces
      .map((piece) => ({ kind: piece.kind, points: simplifyRun(piece.points.map(([lng, lat]) => ({ lng, lat })), tolerance) }))
      .filter((piece) => piece.points.length >= 2);
    const runs: PublicStopRoute['runs'] = [];
    for (const piece of pieces) {
      const previous = runs[runs.length - 1];
      const last = previous?.coordinates[previous.coordinates.length - 1];
      const first = piece.points[0]!;
      // Consecutive same-kind legs meeting at one snapped point form one continuous line.
      if (previous && previous.kind === piece.kind && last && last[0] === first[0] && last[1] === first[1]) {
        previous.coordinates.push(...piece.points.slice(1));
      } else {
        runs.push({ kind: piece.kind, coordinates: [...piece.points] });
      }
    }
    if (!runs.length) return survived ? 'too_complex' : 'empty';
    survived = true;
    const vertices = runs.reduce((count, run) => count + run.coordinates.length, 0);
    const route: PublicStopRoute = { version: 1, runs };
    if (runs.length <= STOP_ROUTE_LIMITS.runs && vertices <= STOP_ROUTE_LIMITS.vertices
      && JSON.stringify(route).length <= STOP_ROUTE_LIMITS.bytes) return route;
  }
  return survived ? 'too_complex' : 'empty';
}

/** One instance per app: request spacing and single flight are shared by every user and tab. */
export function createStopRouter({
  endpoints,
  canonicalOrigin = () => null,
  now = Date.now,
  sleep = (ms) => delay(ms),
  request = safeFetch,
  fetchImpl = fetch,
  lookup,
  internalOrigins = new Set<string>(),
}: StopRouterOptions): StopRouter {
  let nextStart = 0;
  let busy = false;
  // A hand-edited or stale plain-HTTP URL whose origin is not listed counts as unconfigured.
  const configured = () => {
    const urls = endpoints();
    return Object.fromEntries(ROUTED_PROFILES.map((profile) => [profile, routingEndpointUsable(urls[profile], internalOrigins)])) as Record<RoutedProfile, boolean>;
  };

  async function routeLeg(profile: RoutedProfile, from: RouteStop, to: RouteStop, deadline: number): Promise<LegOutcome> {
    const base = endpoints()[profile].replace(/\/+$/, '');
    // The ≥ 1.1 s pacing honours public-service usage policies (FOSSGIS). An
    // operator-listed internal server (the bundled compose OSRM) is the
    // operator's own; single flight and the budget still bound it.
    if (!isInternalRoutingOrigin(base, internalOrigins)) {
      const wait = nextStart - now();
      if (now() + Math.max(0, wait) >= deadline) return { kind: 'straight', fallback: 'provider_error' };
      if (wait > 0) await sleep(wait);
      nextStart = now() + ROUTING_SPACING_MS;
    } else if (now() >= deadline) {
      return { kind: 'straight', fallback: 'provider_error' };
    }
    const coordinate = (stop: RouteStop) => `${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`;
    const target = `${base}/route/v1/${SEGMENT[profile]}/${coordinate(from)};${coordinate(to)}`
      + `?overview=full&geometries=geojson&alternatives=false&steps=false&radiuses=${ROUTING_SNAP_RADIUS_METRES};${ROUTING_SNAP_RADIUS_METRES}`;
    const origin = normalizeCanonicalOrigin(canonicalOrigin());
    try {
      const response = await request(target, {
        timeoutMs: Math.min(ROUTING_LEG_TIMEOUT_MS, Math.max(1, deadline - now())),
        maxBytes: ROUTING_MAX_BYTES,
        maxRedirects: 0,
        ...(lookup ? { lookup } : {}),
        allowedInternalOrigins: internalOrigins,
        // @ai-note OSRM reports NoRoute/NoSegment as HTTP 400 with a JSON `code`.
        // Only 400 is relabelled, so the body still streams through safeFetch's
        // byte cap and the parsed `code` (never the status) decides the outcome.
        fetchImpl: async (input, init) => {
          const res = await fetchImpl(input, {
            ...init,
            headers: { ...init?.headers, 'User-Agent': `SimonsWanderlust/${version} (${origin ? `+${origin}; ` : ''}editor stop routing)` },
          });
          return res.status === 400 ? new Response(res.body, { status: 200, headers: res.headers }) : res;
        },
      });
      const line = providerLine(JSON.parse(response.buffer.toString('utf8')));
      if (line === 'no_route') return { kind: 'straight', fallback: 'no_route' };
      return line ? { kind: 'road', points: line } : { kind: 'straight', fallback: 'provider_error' };
    } catch {
      // Never log: safeFetch messages embed the request URL, i.e. draft coordinates.
      return { kind: 'straight', fallback: 'provider_error' };
    }
  }

  function refusal(stops: readonly RouteStop[]): StopRoutingError | null {
    const available = configured();
    const missing = [...new Set(stops.slice(0, -1).map((_, index) => legProfile(stops, index)))]
      .filter((profile): profile is RoutedProfile => profile !== 'straight' && !available[profile]);
    if (missing.length) return new StopRoutingError('stop_route_profile_unavailable', 409, missing);
    return busy ? new StopRoutingError('stop_route_busy', 429) : null;
  }

  return {
    profiles: configured,
    refusal,
    async calculate(stops) {
      const refused = refusal(stops);
      if (refused) throw refused;
      busy = true;
      try {
        const deadline = now() + ROUTING_BUDGET_MS;
        const legs: StopRouteLeg[] = [];
        const lines: LegLine[] = [];
        for (let index = 0; index < stops.length - 1; index++) {
          const from = stops[index]!, to = stops[index + 1]!;
          const profile = legProfile(stops, index);
          const outcome = profile === 'straight' ? { kind: 'straight' as const } : await routeLeg(profile, from, to, deadline);
          if (outcome.kind === 'road') {
            legs.push({ profile, kind: 'road' });
            lines.push({ kind: 'road', points: outcome.points });
          } else {
            legs.push({ profile, kind: 'straight', ...(outcome.fallback ? { fallback: outcome.fallback } : {}) });
            lines.push({ kind: 'straight', points: [[from.lng, from.lat], [to.lng, to.lat]] });
          }
        }
        // No leg reached a working provider: unreachable, not unroutable. Store nothing.
        if (!legs.some((leg) => leg.kind === 'road') && legs.some((leg) => leg.fallback === 'provider_error')) {
          throw new StopRoutingError('stop_route_failed', 502);
        }
        const route = project(lines);
        if (route === 'empty') throw new StopRoutingError('stop_route_empty', 422);
        if (route === 'too_complex') throw new StopRoutingError('stop_route_too_complex', 422);
        return validateStoredStopRoute({
          version: 1, fingerprint: stopRouteFingerprintSync(stops), computedAt: new Date(now()).toISOString(), legs, route,
        });
      } finally {
        busy = false;
      }
    },
  };
}
