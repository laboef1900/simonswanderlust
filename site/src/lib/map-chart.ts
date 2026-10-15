/**
 * Static plotting chart for the home page's map band.
 *
 * @ai-context The band used to be navy plus `Contours` plus a decorative
 * 40px dashed `<pattern>` — a two-axis grid overlay with nothing under it —
 * a heading, a stats line and a ghost button. It occupied the first slot after
 * the hero, pushed the story grid below the fold, and asked for a click on the
 * strength of a verbal promise: there was no cartography anywhere on the page,
 * while `map-data.ts` already exported `tripPins()` and the app already
 * self-hosts the real basemap at `/map/`.
 *
 * This turns the same grid into an actual graticule with the real trips plotted
 * on it, over a real coastline. Two rules it holds to:
 *
 * @ai-warning Measured coastlines only — never a drawn one. The silhouette is
 * Natural Earth's 1:110m land layer (public domain), committed as degrees by
 * `scripts/build-coastlines.mjs` and clipped to this chart's own window by
 * `land-path.ts`. An approximated, smoothed or hand-tidied landmass would make
 * the band a picture of a map, and the pins would be plotted against a
 * fiction; the whole claim here is that every coordinate on screen is
 * surveyed. Do not edit `coastlines.ts` by hand, do not swap the source for a
 * "nicer looking" outline, and do not add graticule-free decoration to the
 * band. (The app self-hosts a real basemap at `/map/`, but that is a ~524 MB
 * PMTiles slice baked into the Docker image by the repo-root Dockerfile — it
 * does not exist in a checkout, so deriving this from it would break
 * `npm run build`, `astro check` and CI's `astro build` everywhere but the
 * container. See the design spec dated 2026-09-18.)
 *
 * @ai-warning No line joining the pins. Each pin is a separate trip, not a leg
 * of one journey — a polyline through them would draw a route that was never
 * travelled. The dashed route divider elsewhere on the site is ornament with no
 * data behind it; this chart has data behind it and must not overclaim.
 */

import { LAND_RINGS } from './coastlines.js';
import { landPath } from './land-path.js';

export interface ChartPin {
  x: number;
  y: number;
  /** Used only for the SVG title/desc text, never rendered as a label. */
  title: string;
}
export interface ChartGridLine {
  /** Position along the axis, in viewBox units. */
  at: number;
  /** Formatted degree label, e.g. `60°W`, `0°`, `40°N`. */
  label: string;
  /**
   * Where the label's baseline goes along the constrained axis, kept far
   * enough from the frame that no glyph is clipped. For a meridian this is
   * `at`; for a parallel it is `at` nudged above its line and clamped.
   */
  labelAt: number;
  /** True for the equator and the prime meridian, which are drawn stronger. */
  primary: boolean;
}
export interface MapChart {
  width: number;
  height: number;
  viewBox: string;
  meridians: ChartGridLine[];
  parallels: ChartGridLine[];
  pins: ChartPin[];
  /**
   * Land silhouette as SVG path data in viewBox units, clipped to the window
   * and meant for `fill-rule="evenodd"`. Empty string when no ring intersects
   * the window, so the caller omits the element rather than emitting `d=""`.
   */
  land: string;
  /** Baseline for the meridian labels along the bottom edge. */
  labelBaseline: number;
}

export interface ChartInput {
  lng: number;
  lat: number;
  title: string;
}

/** viewBox width; height follows from the fitted aspect ratio. */
const WIDTH = 1000;
/**
 * Width:height the fitted bounds are expanded to.
 *
 * Wide on purpose: this band sits between the hero and the story grid, and
 * every row of height it takes pushes the grid further below the fold. 2.8
 * keeps the chart a strip rather than a panel. Exported so the test measures
 * the real value instead of restating it.
 */
export const TARGET_ASPECT = 2.8;
/** Padding around the data, as a fraction of its own span. */
const PAD_FRACTION = 0.12;
/** Minimum padding in degrees, so a single pin still gets a readable window. */
const MIN_PAD = 8;
/** Graticule steps, coarsest last; the first that yields ≤6 lines per axis wins. */
const STEPS = [5, 10, 15, 20, 30, 45, 60, 90] as const;
const MAX_LINES = 6;
/**
 * Largest label font-size in viewBox units, i.e. the stacked layout's — an SVG
 * `font-size` is in viewBox units, so MapTeaser.astro sets two (30 stacked, 17
 * side-by-side) to land on a stable rendered size. The clamps below reserve
 * room for the bigger one, since a label clipped by the frame is worse than
 * one sitting slightly off its line.
 */
const LABEL_SIZE = 30;
/** Gap between a parallel's line and the label above it. */
const LABEL_LIFT = 8;
/**
 * Ascent above the baseline, as a multiple of the label size. Measured, not
 * assumed: `getBBox()` on a 30-unit `60°N` in IBM Plex Mono reports 31.4 units
 * above the baseline — the degree ring sits above the cap height, so a 1.0em
 * reserve still clipped the glyph by 1.4 units on a phone.
 */
const LABEL_ASCENT = 1.1;

/**
 * Project trips onto an equirectangular chart sized for the band.
 *
 * Equirectangular, not Web Mercator: the real map at `/map/` is Mercator, but
 * this is a 1000-unit-wide strip covering a fraction of the globe where the
 * two barely differ, and a linear latitude axis is what makes the labelled
 * parallels honest at this size.
 */
export function mapChart(input: ChartInput[]): MapChart | null {
  if (input.length === 0) return null;

  const lngs = input.map((p) => p.lng);
  const lats = input.map((p) => p.lat);
  let [west, east] = padded(Math.min(...lngs), Math.max(...lngs), -180, 180);
  let [south, north] = padded(Math.min(...lats), Math.max(...lats), -90, 90);

  // Expand the axis that is short of the target aspect, around the data's own
  // centre, so `preserveAspectRatio="xMidYMid meet"` never has to crop a pin.
  const aspect = (east - west) / (north - south);
  if (aspect < TARGET_ASPECT) {
    const want = (north - south) * TARGET_ASPECT;
    [west, east] = grow(west, east, want, -180, 180);
  } else if (aspect > TARGET_ASPECT) {
    const want = (east - west) / TARGET_ASPECT;
    [south, north] = grow(south, north, want, -90, 90);
  }

  const lngSpan = east - west;
  const latSpan = north - south;
  const height = Math.round((WIDTH * latSpan) / lngSpan);
  const x = (lng: number) => round(((lng - west) / lngSpan) * WIDTH);
  const y = (lat: number) => round(((north - lat) / latSpan) * height);

  // Meridian labels sit on one baseline along the bottom; a descender at the
  // largest label size still clears the frame.
  const labelBaseline = height - LABEL_SIZE * 0.35;
  const clampBaseline = (v: number) =>
    round(Math.min(Math.max(v, LABEL_SIZE * LABEL_ASCENT), labelBaseline - LABEL_SIZE * 0.6));
  return {
    width: WIDTH,
    height,
    viewBox: `0 0 ${WIDTH} ${height}`,
    labelBaseline: round(labelBaseline),
    // Clipped and projected here, where the window is known, so the emitted
    // path is the visible coast and nothing else.
    land: landPath(LAND_RINGS, { west, east, south, north }, { x, y }),
    meridians: ticks(west, east).map((lng) => ({
      at: x(lng),
      labelAt: x(lng),
      label: degrees(lng, 'E', 'W'),
      primary: lng === 0,
    })),
    parallels: ticks(south, north).map((lat) => ({
      at: y(lat),
      labelAt: clampBaseline(y(lat) - LABEL_LIFT),
      label: degrees(lat, 'N', 'S'),
      primary: lat === 0,
    })),
    pins: input.map((p) => ({ x: x(p.lng), y: y(p.lat), title: p.title })),
  };
}

function padded(lo: number, hi: number, min: number, max: number): [number, number] {
  const pad = Math.max((hi - lo) * PAD_FRACTION, MIN_PAD);
  return [Math.max(min, lo - pad), Math.min(max, hi + pad)];
}

/** Widen [lo, hi] to `want` around its midpoint, staying inside [min, max]. */
function grow(lo: number, hi: number, want: number, min: number, max: number): [number, number] {
  const limit = max - min;
  const span = Math.min(want, limit);
  const mid = (lo + hi) / 2;
  let a = mid - span / 2;
  let b = mid + span / 2;
  if (a < min) {
    b += min - a;
    a = min;
  }
  if (b > max) {
    a -= b - max;
    b = max;
  }
  return [a, b];
}

/** Graticule values inside [lo, hi] at the coarsest step that stays readable. */
function ticks(lo: number, hi: number): number[] {
  const step = STEPS.find((s) => Math.floor(hi / s) - Math.ceil(lo / s) + 1 <= MAX_LINES) ?? 90;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function degrees(value: number, positive: string, negative: string): string {
  const v = round(value);
  if (v === 0) return '0°';
  return `${Math.abs(v)}°${v > 0 ? positive : negative}`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
