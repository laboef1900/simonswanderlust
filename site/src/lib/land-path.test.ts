import { describe, expect, it } from 'vitest';
import { clipRing, landPath, simplifyRing, type LandWindow, type Projection } from './land-path';

/** A 20°×10° window and the projection `map-chart.ts` builds for it. */
const WINDOW: LandWindow = { west: -10, east: 10, south: 0, north: 10 };
const PROJECTION: Projection = {
  x: (lng) => ((lng - WINDOW.west) / 20) * 1000,
  y: (lat) => ((WINDOW.north - lat) / 10) * 500,
};

/** `[lng, lat, …]` flat rings, as `coastlines.ts` stores them. */
const square = (west: number, south: number, size: number): number[] => [
  west, south,
  west + size, south,
  west + size, south + size,
  west, south + size,
];

/** Every coordinate pair in a `d` attribute. */
function coords(d: string): [number, number][] {
  return [...d.matchAll(/[ML](-?\d+) (-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('clipRing', () => {
  it('drops a ring that never enters the window', () => {
    expect(clipRing([[40, 40], [50, 40], [50, 50]], WINDOW)).toHaveLength(0);
  });

  it('keeps a ring that is wholly inside, unchanged', () => {
    const ring: [number, number][] = [[-2, 2], [2, 2], [2, 6], [-2, 6]];
    expect(clipRing(ring, WINDOW)).toEqual(ring);
  });

  it('cuts a straddling ring along the frame instead of letting it overhang', () => {
    // Spans well past every edge; the result must live inside the window.
    const clipped = clipRing([[-40, -20], [40, -20], [40, 40], [-40, 40]], WINDOW);
    expect(clipped.length).toBeGreaterThanOrEqual(4);
    for (const [lng, lat] of clipped) {
      expect(lng).toBeGreaterThanOrEqual(WINDOW.west);
      expect(lng).toBeLessThanOrEqual(WINDOW.east);
      expect(lat).toBeGreaterThanOrEqual(WINDOW.south);
      expect(lat).toBeLessThanOrEqual(WINDOW.north);
    }
  });

  it('interpolates the crossing rather than snapping to a corner', () => {
    // A triangle leaving through the east edge: the cut sits where the edge
    // actually crosses 10°E, which is lat 5 for this geometry.
    const clipped = clipRing([[0, 0], [20, 10], [0, 10]], WINDOW);
    expect(clipped).toContainEqual([10, 5]);
  });
});

describe('simplifyRing', () => {
  it('collapses a collinear run to its endpoints', () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
    expect(simplifyRing(line, 1)).toEqual([[0, 0], [4, 0]]);
  });

  it('keeps a vertex that deviates by more than the tolerance', () => {
    const bump: [number, number][] = [[0, 0], [2, 5], [4, 0]];
    expect(simplifyRing(bump, 1)).toEqual(bump);
    expect(simplifyRing(bump, 6)).toEqual([[0, 0], [4, 0]]);
  });
});

describe('landPath', () => {
  it('emits nothing when no ring reaches the window', () => {
    expect(landPath([square(40, 40, 10)], WINDOW, PROJECTION)).toBe('');
  });

  it('projects a ring into a closed subpath inside the viewBox', () => {
    const d = landPath([square(-4, 2, 8)], WINDOW, PROJECTION);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    for (const [x, y] of coords(d)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1000);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(500);
    }
  });

  it('never emits a coordinate outside the viewBox, however far the ring overhangs', () => {
    // The whole reason clipping happens before projection: an unclipped
    // Eurasia would project to tens of thousands of units off-frame, and the
    // browser would still parse and paint every one of them.
    const d = landPath([square(-180, -80, 300)], WINDOW, PROJECTION);
    expect(d).not.toBe('');
    for (const [x, y] of coords(d)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1000);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(500);
    }
  });

  it('keeps a hole as its own subpath, so evenodd can cut it out', () => {
    const d = landPath([square(-8, 1, 16), square(-2, 4, 4)], WINDOW, PROJECTION);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('drops a ring too small to read beside a pin', () => {
    // A 0.05° speck projects to ~2.5×2.5 units — under MIN_AREA_UNITS, and it
    // would render as a stray dot beside pins that are 6 units across. A 1°
    // island is 50×50 units and stays.
    expect(landPath([square(0, 5, 0.05)], WINDOW, PROJECTION)).toBe('');
    expect(landPath([square(0, 5, 1)], WINDOW, PROJECTION)).not.toBe('');
  });
});
