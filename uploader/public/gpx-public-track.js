import { validateGeometry } from './gpx-geometry.js';

/** @typedef {{version: 1, type: 'MultiLineString', coordinates: [number, number][][]}} PublicTrack */
/** @typedef {{track: PublicTrack, collapsedRuns: number}} PublicTrackResult */
/** @typedef {{retainedRuns: number, vertices: number, bytes: number}} PublicTrackCounts */

export class PublicTrackError extends Error {
  /** @param {string} code @param {PublicTrackCounts} [counts] */
  constructor(code, counts) {
    super(code);
    this.name = 'PublicTrackError';
    if (counts !== undefined) this.counts = counts;
  }
}

export const PUBLIC_TRACK_LIMITS = Object.freeze({ runs: 100, vertices: 2000, bytes: 65536 });
const radius = 6371008.8;
const tolerance = 25 / radius;
const radians = Math.PI / 180;
const encoder = new TextEncoder();
const fail = (code, counts) => { throw new PublicTrackError(code, counts); };
const round = (value) => Math.round(value * 10000) / 10000 || 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const array = (value) => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1;
const equal = (a, b) => a[0] === b[0] && a[1] === b[1];

// Counts are saturated lower bounds once processing stops at a limit. Count only
// the attempted public projection, never its private source points or metadata.
function failureCounts(coordinates) {
  if (!coordinates.length) return { retainedRuns: 0, vertices: 0, bytes: 0 };
  let vertices = 0;
  let bytes = JSON.stringify({ version: 1, type: 'MultiLineString', coordinates: [] }).length;
  for (let i = 0; i < coordinates.length; i++) {
    const run = coordinates[i];
    vertices = Math.min(PUBLIC_TRACK_LIMITS.vertices + 1, vertices + run.length);
    if (bytes > PUBLIC_TRACK_LIMITS.bytes) continue;
    bytes += 2 + (i ? 1 : 0);
    for (let j = 0; j < run.length && bytes <= PUBLIC_TRACK_LIMITS.bytes; j++) {
      bytes += JSON.stringify(run[j]).length + (j ? 1 : 0);
    }
  }
  return { retainedRuns: Math.min(coordinates.length, PUBLIC_TRACK_LIMITS.runs + 1),
    vertices, bytes: Math.min(bytes, PUBLIC_TRACK_LIMITS.bytes + 1) };
}

/** Strict public boundary: return the original value, never repair or strip private fields.
 * @param {unknown} value
 * @returns {PublicTrack}
 */
export function validatePublicTrack(value) {
  if (!object(value) || Reflect.ownKeys(value).length !== 3
    || value.version !== 1 || value.type !== 'MultiLineString' || !array(value.coordinates)
    || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'type') || !Object.hasOwn(value, 'coordinates')) {
    fail('track_public_limit');
  }
  const runs = value.coordinates;
  if (!runs.length) fail('track_empty_after_rounding', failureCounts(runs));
  if (runs.length > PUBLIC_TRACK_LIMITS.runs) fail('track_public_limit');
  let vertices = 0;
  for (const run of runs) {
    if (!array(run) || run.length < 2) fail('track_public_limit');
    vertices += run.length;
    if (vertices > PUBLIC_TRACK_LIMITS.vertices) fail('track_public_limit');
    let previous;
    for (const position of run) {
      if (!array(position) || position.length !== 2) fail('track_public_limit');
      for (let axis = 0; axis < 2; axis++) {
        const number = position[axis];
        if (typeof number !== 'number' || !Number.isFinite(number) || Object.is(number, -0)
          || Math.abs(number) > (axis === 0 ? 180 : 90) || round(number) !== number) fail('track_public_limit');
      }
      if (previous && (equal(previous, position) || Math.abs(previous[0] - position[0]) > 180)) fail('track_public_limit');
      previous = position;
    }
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > PUBLIC_TRACK_LIMITS.bytes) fail('track_public_limit', failureCounts(runs));
  return value;
}

// atan2 remains well-conditioned at both the poles and almost-coincident endpoints.
function angle(ax, ay, az, bx, by, bz) {
  return Math.atan2(Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx),
    ax * bx + ay * by + az * bz);
}

function simplify(points) {
  const count = points.length;
  const vectors = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const latitude = points[i].lat * radians;
    const longitude = points[i].lng * radians;
    const cos = Math.cos(latitude);
    vectors[i * 3] = cos * Math.cos(longitude);
    vectors[i * 3 + 1] = cos * Math.sin(longitude);
    vectors[i * 3 + 2] = Math.sin(latitude);
  }
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const stack = [0, count - 1];
  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();
    if (end - start < 2) continue;
    const a = start * 3;
    const b = end * 3;
    const ax = vectors[a], ay = vectors[a + 1], az = vectors[a + 2];
    const bx = vectors[b], by = vectors[b + 1], bz = vectors[b + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const normalLength = Math.hypot(nx, ny, nz);
    const dot = ax * bx + ay * by + az * bz;
    // An antipodal pair has no unique minor arc. Subdivide using source points,
    // never choose a hemisphere. Also subdivide a longitude-wrapping chord so
    // MapLibre cannot invent a connection that normalization explicitly removed.
    if ((normalLength < 1e-12 && dot < 0) || Math.abs(points[start].lng - points[end].lng) > 180) {
      const middle = Math.floor((start + end) / 2);
      keep[middle] = 1;
      stack.push(start, middle, middle, end);
      continue;
    }
    const arc = Math.atan2(normalLength, dot);
    const ux = normalLength ? nx / normalLength : 0;
    const uy = normalLength ? ny / normalLength : 0;
    const uz = normalLength ? nz / normalLength : 0;
    const tx = uy * az - uz * ay, ty = uz * ax - ux * az, tz = ux * ay - uy * ax;
    let furthest = -1;
    let maximum = tolerance;
    for (let i = start + 1; i < end; i++) {
      const offset = i * 3;
      const px = vectors[offset], py = vectors[offset + 1], pz = vectors[offset + 2];
      let distance = Math.min(angle(px, py, pz, ax, ay, az), angle(px, py, pz, bx, by, bz));
      if (normalLength >= 1e-12) {
        const alongA = px * ax + py * ay + pz * az;
        const alongT = px * tx + py * ty + pz * tz;
        const along = Math.atan2(alongT, alongA);
        if (along >= 0 && along <= arc) {
          const cross = Math.atan2(Math.abs(px * ux + py * uy + pz * uz), Math.hypot(alongA, alongT));
          distance = Math.min(distance, cross);
        }
      }
      if (distance > maximum) { maximum = distance; furthest = i; }
    }
    if (furthest !== -1) {
      keep[furthest] = 1;
      stack.push(start, furthest, furthest, end);
    }
  }
  const positions = [];
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue;
    const position = [round(points[i].lng), round(points[i].lat)];
    if (!positions.length || !equal(positions[positions.length - 1], position)) positions.push(position);
  }
  return positions;
}

/** Derive only from retained source runs; no metadata, interpolation or cross-run edge.
 * @param {import('./gpx-geometry.js').PrivateGeometry} geometry
 * @returns {PublicTrackResult}
 */
export function createPublicTrack(geometry) {
  validateGeometry(geometry, true);
  const coordinates = [];
  let collapsedRuns = 0;
  let vertices = 0;
  for (const run of geometry.segments) {
    const positions = simplify(run.points);
    if (positions.length < 2) { collapsedRuns++; continue; }
    vertices += positions.length;
    coordinates.push(positions);
    if (vertices > PUBLIC_TRACK_LIMITS.vertices || coordinates.length > PUBLIC_TRACK_LIMITS.runs) {
      fail('track_public_limit', failureCounts(coordinates));
    }
  }
  const track = validatePublicTrack({ version: 1, type: 'MultiLineString', coordinates });
  return { track, collapsedRuns };
}
