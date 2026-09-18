/**
 * Turns lon/lat land rings into SVG path data for the home page's map band.
 *
 * @ai-context `coastlines.ts` holds the rings (generated — see
 * `scripts/build-coastlines.mjs`); `map-chart.ts` owns the window and the
 * projection and calls `landPath` with both. Split out because this is pure
 * geometry with no chart vocabulary in it, and because the clipping is the
 * part worth testing on its own.
 *
 * @ai-warning Everything here runs at BUILD time. The whole point of clipping
 * before projecting is that the page carries only the coast inside the chart's
 * window — the full ring set is ~50 KB of degrees, most of it ocean-facing
 * Pacific and Antarctic coast the band never shows. Never import
 * `coastlines.ts` from anything that reaches a browser bundle.
 */

export interface LandWindow {
  /** Window edges in degrees. `west < east`, `south < north`. */
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Projection from degrees to viewBox units, as `map-chart.ts` defines it. */
export interface Projection {
  x: (lng: number) => number;
  y: (lat: number) => number;
}

type Point = readonly [number, number];

/**
 * Simplification tolerance in viewBox units, applied AFTER projection.
 *
 * The rings arrive simplified at 0.1° for the widest window the band can fit;
 * a narrow window magnifies them, so this second pass is what keeps the
 * emitted path proportional to what is actually VISIBLE instead of to how much
 * coast the source happened to record. Measured on the live nine-trip window
 * (viewBox 1000×357): 1.2 units emitted 9,486 bytes of `d`, 2 units emits
 * 4,378 — a quarter of the page's HTML for a silhouette at 0.14 opacity was
 * not worth it. 2 units is ~1.4 CSS px at the band's desktop width (712px for
 * 1000 units) and ~0.7 px stacked, i.e. under a pixel where most readers see
 * it. Re-measure the byte count if this changes; the band is on the home page,
 * which is the one document a first-time visitor pays for in full.
 */
const SIMPLIFY_UNITS = 2;

/**
 * Clipped rings smaller than this, in square viewBox units, are dropped: a
 * 3-unit island renders as a speck that reads as a stray dot beside the pins,
 * which are themselves 6 units across.
 */
const MIN_AREA_UNITS = 8;

/** Shoelace area, unsigned — ring winding is not normalised in the source. */
function area(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * One Sutherland-Hodgman pass. `inside` tests a vertex; `cut` returns the
 * crossing point of the edge `a→b` with the clip line.
 */
function clipToEdge(
  points: readonly Point[],
  inside: (p: Point) => boolean,
  cut: (a: Point, b: Point) => Point,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const previous = points[(i + points.length - 1) % points.length]!;
    const currentIn = inside(current);
    const previousIn = inside(previous);
    if (currentIn) {
      if (!previousIn) out.push(cut(previous, current));
      out.push(current);
    } else if (previousIn) {
      out.push(cut(previous, current));
    }
  }
  return out;
}

/** Interpolate the crossing of `a→b` with the vertical line `lng`. */
const cutLng = (lng: number) => (a: Point, b: Point): Point => {
  const t = (lng - a[0]) / (b[0] - a[0]);
  return [lng, a[1] + t * (b[1] - a[1])];
};

/** Interpolate the crossing of `a→b` with the horizontal line `lat`. */
const cutLat = (lat: number) => (a: Point, b: Point): Point => {
  const t = (lat - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), lat];
};

/**
 * Clip a ring to the window. Convex rectangle, so Sutherland-Hodgman is exact
 * and the result stays a single closed ring — a landmass that leaves and
 * re-enters the window gets a segment along the frame, which is what a map
 * cropped to a window looks like.
 */
export function clipRing(ring: readonly Point[], w: LandWindow): Point[] {
  let points: Point[] = [...ring];
  points = clipToEdge(points, (p) => p[0] >= w.west, cutLng(w.west));
  if (points.length === 0) return points;
  points = clipToEdge(points, (p) => p[0] <= w.east, cutLng(w.east));
  if (points.length === 0) return points;
  points = clipToEdge(points, (p) => p[1] >= w.south, cutLat(w.south));
  if (points.length === 0) return points;
  return clipToEdge(points, (p) => p[1] <= w.north, cutLat(w.north));
}

/** Perpendicular distance from `p` to the segment `a→b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Ramer-Douglas-Peucker. Iterative: a clipped Eurasian ring is a few thousand
 * points and recursion here would be a stack depth proportional to the data.
 */
export function simplifyRing(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i]!, points[first]!, points[last]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index > -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Whole units. At 0.71 CSS px per unit (the band's desktop scale) rounding
 * costs at most a third of a pixel, and it is worth ~2,000 bytes of `d` on the
 * home page: decimals in path data are the cheapest thing to give up here.
 */
const unit = (n: number): number => Math.round(n);

/**
 * Project the rings that intersect `window` into one `d` attribute.
 *
 * Subpaths are concatenated and meant to be filled with
 * `fill-rule="evenodd"`, which is what makes a hole in the source (the 110m
 * layer has one) a hole in the render without carrying a flag for it.
 *
 * Returns `''` when no ring survives, so the caller can omit the element
 * rather than emit an empty path.
 */
export function landPath(
  rings: readonly (readonly number[])[],
  window: LandWindow,
  projection: Projection,
): string {
  const subpaths: string[] = [];
  for (const flat of rings) {
    const ring: Point[] = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([flat[i]!, flat[i + 1]!]);
    const clipped = clipRing(ring, window);
    if (clipped.length < 3) continue;
    const projected = clipped.map(
      (p): Point => [unit(projection.x(p[0])), unit(projection.y(p[1]))],
    );
    const simplified = simplifyRing(projected, SIMPLIFY_UNITS);
    if (simplified.length < 3 || area(simplified) < MIN_AREA_UNITS) continue;
    const [first, ...rest] = simplified;
    subpaths.push(
      `M${first![0]} ${first![1]}${rest.map((p) => `L${p[0]} ${p[1]}`).join('')}Z`,
    );
  }
  return subpaths.join('');
}
