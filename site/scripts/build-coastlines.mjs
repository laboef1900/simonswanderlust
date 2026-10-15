#!/usr/bin/env node
/**
 * One-off generator for `site/src/lib/coastlines.ts`.
 *
 * Fetches Natural Earth's 1:110m land polygons, simplifies them, and writes a
 * committed TypeScript module of rings in degrees. Run it only to refresh or
 * re-tune the asset:
 *
 *   node scripts/build-coastlines.mjs [--tolerance 0.1] [--out src/lib/coastlines.ts]
 *
 * WHY a committed asset rather than a build step:
 * the app already self-hosts a real basemap, but it is a ~524 MB PMTiles slice
 * fetched by the `mapfetch` stage of the repo-root Dockerfile and baked into
 * the image at `/map-assets`. It does not exist in a checkout, so deriving the
 * silhouette from it at build time would break `npm run build`, `astro check`
 * and CI's full `astro build` — all three of which CLAUDE.md treats as
 * authoritative gates — on every machine that is not the container. Natural
 * Earth is the same kind of truth (surveyed public-domain coastlines, not an
 * approximation someone drew), costs one committed text file, and renders
 * identically in dev, CI and the container.
 *
 * @ai-warning Do NOT hand-edit the generated module, and do not "tidy" a ring
 * by eye. The whole claim the map band makes is that its geography is measured
 * rather than drawn (see the @ai-warning in src/lib/map-chart.ts); an edited
 * coordinate is an invented coastline with a citation attached to it.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Natural Earth 1:110m "land" layer, via the natural-earth-vector mirror.
 * Public domain (naturalearthdata.com/about/terms-of-use): no attribution
 * required, none implied by the project.
 */
const SOURCE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson';

/**
 * Simplification tolerance in DEGREES. The chart is 1000 viewBox units wide
 * over roughly 140° of longitude, i.e. ~7 units per degree, and renders around
 * 0.7 CSS px per unit on a desktop viewport — so 0.1° is about half a rendered
 * pixel at the widest the band ever gets. Coarser than that starts eating
 * recognisable coast (the Danish and Greek coastlines are the first to go, and
 * they are two of the nine destinations).
 */
const DEFAULT_TOLERANCE = 0.1;

/** Drop a ring whose bounding box is smaller than this in degrees, both axes. */
const MIN_RING_SPAN = 0.4;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Perpendicular distance from p to the segment a-b, in degrees. */
function segmentDistance(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer-Douglas-Peucker, iterative so a 1000-point ring cannot blow the stack. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
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

function span(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

const tolerance = Number(arg('tolerance', DEFAULT_TOLERANCE));
const out = resolve(process.cwd(), arg('out', 'src/lib/coastlines.ts'));

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} -> HTTP ${res.status}`);
const geo = await res.json();
if (geo.name !== 'ne_110m_land') throw new Error(`unexpected layer: ${geo.name}`);

const rings = [];
let sourcePoints = 0;
for (const feature of geo.features) {
  if (feature.geometry?.type !== 'Polygon') {
    throw new Error(`unexpected geometry ${feature.geometry?.type} — this layer is all Polygons`);
  }
  // Every ring, outer and hole alike: the renderer fills with `evenodd`, so a
  // hole needs no flag of its own. (The 110m layer has exactly one today.)
  for (const ring of feature.geometry.coordinates) {
    sourcePoints += ring.length;
    const points = simplify(ring, tolerance);
    const [w, h] = span(points);
    if (points.length < 4 || (w < MIN_RING_SPAN && h < MIN_RING_SPAN)) continue;
    rings.push(points);
  }
}

// Longest first: the renderer can stop clipping once a ring is off-window, and
// a stable order keeps the generated diff readable when the tolerance changes.
rings.sort((a, b) => b.length - a.length);

const round = (n) => Math.round(n * 100) / 100;
const body = rings
  .map((ring) => `  [${ring.flatMap(([lng, lat]) => [round(lng), round(lat)]).join(',')}],`)
  .join('\n');
const kept = rings.reduce((n, r) => n + r.length, 0);

const file = `/**
 * Land polygons for the home page map band, in degrees.
 *
 * GENERATED by \`scripts/build-coastlines.mjs\` — do not hand-edit. Each ring is
 * a flat \`[lng, lat, lng, lat, …]\` array at two decimals (~1 km), outer rings
 * and holes together, filled with \`fill-rule="evenodd"\`.
 *
 * Source: Natural Earth 1:110m land (\`ne_110m_land\`), public domain, via
 * natural-earth-vector. Retrieved ${new Date().toISOString().slice(0, 10)};
 * simplified at ${tolerance}° (${sourcePoints} source points → ${kept}), rings whose
 * bounding box is under ${MIN_RING_SPAN}° on both axes dropped.
 *
 * @ai-warning This is BUILD-TIME data, not a shipped asset: \`mapChart()\` clips
 * it to the chart's own window and emits only the projected path, so the page
 * carries the visible coast and nothing else. Importing this module into
 * anything that runs in a browser ships ${Math.round(kept * 0.012)} KB of the
 * Pacific to a reader.
 */

export const LAND_RINGS: readonly (readonly number[])[] = [
${body}
];
`;

await writeFile(out, file, 'utf8');
console.log(
  `wrote ${out}: ${rings.length} rings, ${kept} points (from ${sourcePoints}) at ${tolerance}°`,
);
