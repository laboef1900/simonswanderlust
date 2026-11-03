// Shared stop-route contract (#513). Runs unchanged in Node (uploader) and in
// the admin browser, like gpx-public-track.js. The site mirrors the public
// shape in site/src/lib/public-stop-route.ts (Zod); fixtures pin both.
// @ai-context docs/superpowers/specs/2026-11-03-issue-513-stop-routing-design.md

/** Profiles that need a configured OSRM endpoint, in Settings order. */
export const ROUTED_PROFILES = Object.freeze(/** @type {const} */ (['car', 'bike', 'foot']));
/** Every per-leg travel profile. `straight` never makes a network request. */
export const LEG_PROFILES = Object.freeze(/** @type {const} */ (['car', 'bike', 'foot', 'straight']));
/** The default leg profile; stored as an absent `profile` key. */
export const DEFAULT_LEG_PROFILE = 'car';
export const LEG_FALLBACKS = Object.freeze(/** @type {const} */ (['no_route', 'provider_error']));
export const RUN_KINDS = Object.freeze(/** @type {const} */ (['road', 'straight']));
/**
 * `stops` bounds one calculation (stops - 1 legs, paced at ~1 request/s);
 * the remaining limits are exactly the public GPX track limits.
 */
export const STOP_ROUTE_LIMITS = Object.freeze({ stops: 25, runs: 100, vertices: 2000, bytes: 65536 });

export class StopRouteError extends Error {
  /** @param {string} code @param {number} [index] */
  constructor(code, index) {
    super(code);
    this.name = 'StopRouteError';
    this.code = code;
    if (index !== undefined) this.index = index;
  }
}

const fail = (code, index) => { throw new StopRouteError(code, index); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const denseArray = (value) => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1;
const keysExactly = (value, required, optional = []) => {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
};
const round4 = (value) => Math.round(value * 10000) / 10000 || 0;
const encoder = new TextEncoder();

/**
 * Normalize the additive routing fields of one stop row without judging its
 * name or coordinates (drafts may hold incomplete rows; Publish validates them).
 * `via: false` and `profile: 'car'` collapse to absent keys, and the last row's
 * profile is dropped: it has no outgoing leg. Other keys pass through unchanged
 * (legacy rows were never key-checked; the public schema strips extras).
 * @param {unknown} stops
 * @returns {unknown}
 */
export function normalizeStopRoutingFields(stops) {
  if (!Array.isArray(stops)) return stops;
  return stops.map((stop, index) => {
    if (!plain(stop)) return stop;
    const { via, profile, ...rest } = stop;
    if (via !== undefined && typeof via !== 'boolean') fail('stop_via_invalid', index);
    if (profile !== undefined && !LEG_PROFILES.includes(profile)) fail('stop_profile_invalid', index);
    const out = { ...rest };
    if (via === true) out.via = true;
    if (profile !== undefined && profile !== DEFAULT_LEG_PROFILE && index < stops.length - 1) out.profile = profile;
    return out;
  });
}

/**
 * Strict stop validation: the existing Publish rules (non-empty name, lat/lng
 * in range) plus the routing fields. Via rows are validated exactly like stops.
 * @param {unknown} stops
 * @returns {import('./stop-route.js').RouteStop[]}
 */
export function validateRouteStops(stops) {
  if (!denseArray(stops)) fail('stops_invalid');
  const normalized = /** @type {any[]} */ (normalizeStopRoutingFields(stops));
  normalized.forEach((stop, index) => {
    if (!plain(stop)) fail('stop_invalid', index);
    if (typeof stop.name !== 'string' || !stop.name.trim()) fail('stop_name_invalid', index);
    if (typeof stop.lat !== 'number' || !Number.isFinite(stop.lat) || stop.lat < -90 || stop.lat > 90) fail('stop_lat_invalid', index);
    if (typeof stop.lng !== 'number' || !Number.isFinite(stop.lng) || stop.lng < -180 || stop.lng > 180) fail('stop_lng_invalid', index);
  });
  return normalized;
}

/** Profile of leg `index` → `index + 1`; absent means car. */
export function legProfile(stops, index) {
  return stops[index]?.profile ?? DEFAULT_LEG_PROFILE;
}

/**
 * Canonical, name-free basis of a route: ordered (lat, lng, via, leg profile).
 * Renaming a stop does not change geometry, so names are excluded on purpose.
 * The caller passes stops that went through normalizeStopRoutingFields.
 * @param {readonly {lat: number, lng: number, via?: boolean, profile?: string}[]} stops
 */
export function stopRouteBasis(stops) {
  return 'stop-route-v1:' + JSON.stringify(stops.map((stop, index) => [
    stop.lat, stop.lng, stop.via === true,
    index === stops.length - 1 ? null : (stop.profile ?? DEFAULT_LEG_PROFILE),
  ]));
}

/** SHA-256 hex of the basis. Async because browsers only expose SubtleCrypto. */
export async function stopRouteFingerprint(stops) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(stopRouteBasis(stops)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validatePosition(position) {
  if (!denseArray(position) || position.length !== 2) fail('stop_route_public_limit');
  for (let axis = 0; axis < 2; axis++) {
    const number = position[axis];
    if (typeof number !== 'number' || !Number.isFinite(number) || Object.is(number, -0)
      || Math.abs(number) > (axis === 0 ? 180 : 90) || round4(number) !== number) fail('stop_route_public_limit');
  }
}

/**
 * Strict public boundary: returns the original value, never repairs or strips.
 * Same limits as the public GPX track, but its own shape and snapshot key so a
 * stop route can never be mistaken for (or summarized as) a GPX track.
 * @param {unknown} value
 * @returns {import('./stop-route.js').PublicStopRoute}
 */
export function validatePublicStopRoute(value) {
  if (!plain(value) || !keysExactly(value, ['version', 'runs']) || value.version !== 1 || !denseArray(value.runs)) {
    fail('stop_route_public_limit');
  }
  const runs = value.runs;
  if (runs.length < 1 || runs.length > STOP_ROUTE_LIMITS.runs) fail('stop_route_public_limit');
  let vertices = 0;
  for (const run of runs) {
    if (!plain(run) || !keysExactly(run, ['kind', 'coordinates']) || !RUN_KINDS.includes(run.kind)
      || !denseArray(run.coordinates) || run.coordinates.length < 2) fail('stop_route_public_limit');
    vertices += run.coordinates.length;
    if (vertices > STOP_ROUTE_LIMITS.vertices) fail('stop_route_public_limit');
    let previous;
    for (const position of run.coordinates) {
      validatePosition(position);
      if (previous && ((previous[0] === position[0] && previous[1] === position[1])
        || Math.abs(previous[0] - position[0]) > 180)) fail('stop_route_public_limit');
      previous = position;
    }
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > STOP_ROUTE_LIMITS.bytes) fail('stop_route_public_limit');
  return /** @type {any} */ (value);
}

/**
 * Strict private stored-route boundary (posts.stop_route, backups).
 * @param {unknown} value
 * @returns {import('./stop-route.js').StoredStopRoute}
 */
export function validateStoredStopRoute(value) {
  if (!plain(value) || !keysExactly(value, ['version', 'fingerprint', 'computedAt', 'legs', 'route']) || value.version !== 1
    || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)
    || typeof value.computedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.computedAt)
    || !Number.isFinite(Date.parse(value.computedAt))
    || !denseArray(value.legs) || value.legs.length < 1 || value.legs.length > STOP_ROUTE_LIMITS.stops - 1) {
    fail('stop_route_invalid');
  }
  for (const leg of value.legs) {
    if (!plain(leg) || !keysExactly(leg, ['profile', 'kind'], ['fallback'])
      || !LEG_PROFILES.includes(leg.profile) || !RUN_KINDS.includes(leg.kind)) fail('stop_route_invalid');
    const routed = ROUTED_PROFILES.includes(leg.profile);
    const consistent = leg.kind === 'road'
      ? routed && leg.fallback === undefined
      : (leg.profile === 'straight' && leg.fallback === undefined) || (routed && LEG_FALLBACKS.includes(leg.fallback));
    if (!consistent) fail('stop_route_invalid');
  }
  try { validatePublicStopRoute(value.route); } catch { fail('stop_route_invalid'); }
  return /** @type {any} */ (value);
}
