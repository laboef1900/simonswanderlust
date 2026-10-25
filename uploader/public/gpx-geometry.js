// Native ESM: the editor and admitted worker use exactly the same private geometry rules.
export const GPX_LIMITS = Object.freeze({
  fileBytes: 5242880, normalizedBytes: 12582912, points: 50000, segments: 100,
  waypoints: 500, nameCodePoints: 200, workerMs: 2000, nesting: 32,
});
const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const encoder = new TextEncoder();

export function validateGeometry(value, allowEmpty = false) {
  if (!keys(value, ['version', 'segments']) || value.version !== 1 || !Array.isArray(value.segments)
    || value.segments.length > GPX_LIMITS.segments || (!allowEmpty && !value.segments.length)) fail('gpx_invalid_geometry');
  let count = 0;
  for (const segment of value.segments) {
    if (!keys(segment, ['points']) || !Array.isArray(segment.points) || segment.points.length < 2) fail('gpx_invalid_geometry');
    count += segment.points.length;
    if (count > GPX_LIMITS.points) fail('gpx_limit');
    let previous;
    for (const point of segment.points) {
      if (!keys(point, ['lng', 'lat', 'elevation', 'time']) || !finite(point.lng, -180, 180)
        || !finite(point.lat, -90, 90)) fail('gpx_invalid_geometry');
      if ('elevation' in point && !finite(point.elevation, -12000, 100000)) fail('gpx_invalid_geometry');
      if ('time' in point && (typeof point.time !== 'string'
        || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(point.time)
        || !Number.isFinite(Date.parse(point.time)) || new Date(point.time).toISOString() !== point.time)) fail('gpx_invalid_geometry');
      if (previous && Math.abs(previous.lng - point.lng) > 180) fail('gpx_invalid_geometry');
      previous = point;
    }
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > GPX_LIMITS.normalizedBytes) fail('gpx_limit');
}

function selectedRuns(geometry, selection) {
  if (!keys(selection, ['startPoints', 'endPoints', 'removedSegments'])
    || !integer(selection.startPoints) || !integer(selection.endPoints) || !Array.isArray(selection.removedSegments)
    || selection.removedSegments.length > geometry.segments.length) fail('gpx_invalid_selection');
  const removed = new Set();
  for (const index of selection.removedSegments) {
    if (!integer(index) || index >= geometry.segments.length || removed.has(index)) fail('gpx_invalid_selection');
    removed.add(index);
  }
  return geometry.segments.filter((_, index) => !removed.has(index));
}

export function trimGeometry(geometry, selection) {
  validateGeometry(geometry, true);
  const runs = selectedRuns(geometry, selection);
  const total = runs.reduce((count, run) => count + run.points.length, 0);
  if (selection.startPoints >= total || selection.endPoints >= total - selection.startPoints) fail('gpx_empty_selection');
  const end = total - selection.endPoints;
  let offset = 0;
  let retained = 0;
  let droppedSegments = 0;
  const segments = [];
  for (const run of runs) {
    const startIndex = Math.max(0, selection.startPoints - offset);
    const endIndex = Math.min(run.points.length, end - offset);
    offset += run.points.length;
    if (endIndex - startIndex < 2) { droppedSegments++; continue; }
    const points = run.points.slice(startIndex, endIndex).map((point) => ({ ...point }));
    retained += points.length;
    segments.push({ points });
  }
  if (!segments.length) fail('gpx_empty_selection');
  return {
    geometry: { version: 1, segments },
    removedPoints: geometry.segments.reduce((count, run) => count + run.points.length, 0) - retained,
    droppedSegments,
  };
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const sinLat = Math.sin((b.lat - a.lat) * rad / 2);
  const sinLng = Math.sin((b.lng - a.lng) * rad / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sinLng * sinLng;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function geometryStats(geometry) {
  validateGeometry(geometry, true);
  let points = 0;
  let distanceMetres = 0;
  for (const run of geometry.segments) {
    points += run.points.length;
    for (let i = 1; i < run.points.length; i++) distanceMetres += distance(run.points[i - 1], run.points[i]);
  }
  return { points, segments: geometry.segments.length, distanceMetres };
}

// Each traversal carries cumulative distance across gaps without adding a connecting edge.
function removedAtDistance(runs, metres, reverse) {
  let cumulative = 0;
  let removed = 0;
  for (let i = 0; i < runs.length; i++) {
    const points = runs[reverse ? runs.length - 1 - i : i].points;
    for (let j = 0; j < points.length; j++) {
      const index = reverse ? points.length - 1 - j : j;
      if (j) cumulative += distance(points[reverse ? index + 1 : index - 1], points[index]);
      if (cumulative >= metres) return removed;
      removed++;
    }
  }
  return removed;
}

export function selectionFromDistances(geometry, removedSegments, startMetres, endMetres) {
  validateGeometry(geometry, true);
  if (!finite(startMetres, 0, Number.MAX_VALUE) || !finite(endMetres, 0, Number.MAX_VALUE)) fail('gpx_invalid_selection');
  const runs = selectedRuns(geometry, { startPoints: 0, endPoints: 0, removedSegments });
  return {
    startPoints: removedAtDistance(runs, startMetres, false),
    endPoints: removedAtDistance(runs, endMetres, true),
    removedSegments: [...removedSegments],
  };
}
