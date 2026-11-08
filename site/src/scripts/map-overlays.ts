import { degreeLabel, graticuleTicks } from '../lib/map-chart';

export interface ScreenPoint { id: number; x: number; y: number }

/**
 * Groups points whose badges would touch: any two closer than `radius` pixels
 * share a group, transitively (connected components), so no two of the
 * returned groups' singles can overlap. Groups keep input order; members keep
 * input order. A pin chain A–B–C where only neighbours touch is one group,
 * which is the point: splitting it would leave B under A or C.
 */
export function clusterPoints(points: readonly ScreenPoint[], radius: number): ScreenPoint[][] {
  const parent = points.map((_, index) => index);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const limit = radius * radius;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy < limit) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, ScreenPoint[]>();
  points.forEach((point, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(point);
    else groups.set(root, [point]);
  });
  return [...groups.values()];
}

export interface GraticuleView { west: number; east: number; south: number; north: number }
export interface GraticuleTick { value: number; label: string; primary: boolean }
export interface Graticule {
  meridians: GraticuleTick[];
  parallels: GraticuleTick[];
  lines: { type: 'FeatureCollection'; features: { type: 'Feature'; properties: { primary: boolean }; geometry: { type: 'LineString'; coordinates: [number, number][] } }[] };
}

/** Mercator's usable latitude range; lines beyond it would draw off the map. */
const MAX_LAT = 85;

/**
 * Meridians and parallels for the visible window, using the homepage chart's
 * step ladder (`graticuleTicks`, ≤6 lines per axis) and its "30°E" labels.
 * Lines run a little past the window so a pan never shows their ends.
 */
export function graticule(view: GraticuleView): Graticule {
  const west = Math.max(-180, view.west);
  const east = Math.min(180, view.east);
  const south = Math.max(-MAX_LAT, view.south);
  const north = Math.min(MAX_LAT, view.north);
  const lngPad = (east - west) * 0.5;
  const latPad = (north - south) * 0.5;
  const latLo = Math.max(-MAX_LAT, south - latPad);
  const latHi = Math.min(MAX_LAT, north + latPad);
  const lngLo = Math.max(-180, west - lngPad);
  const lngHi = Math.min(180, east + lngPad);
  const meridians = graticuleTicks(west, east).map((value) => ({ value, label: degreeLabel(value, 'E', 'W'), primary: value === 0 }));
  const parallels = graticuleTicks(south, north).map((value) => ({ value, label: degreeLabel(value, 'N', 'S'), primary: value === 0 }));
  return {
    meridians,
    parallels,
    lines: {
      type: 'FeatureCollection',
      features: [
        ...meridians.map((m) => ({
          type: 'Feature' as const,
          properties: { primary: m.primary },
          geometry: { type: 'LineString' as const, coordinates: [[m.value, latLo], [m.value, latHi]] as [number, number][] },
        })),
        ...parallels.map((p) => ({
          type: 'Feature' as const,
          properties: { primary: p.primary },
          geometry: { type: 'LineString' as const, coordinates: [[lngLo, p.value], [lngHi, p.value]] as [number, number][] },
        })),
      ],
    },
  };
}
