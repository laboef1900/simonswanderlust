import { describe, expect, it } from 'vitest';
import { clusterPoints, graticule } from './map-overlays';

const ids = (groups: { id: number }[][]) => groups.map((group) => group.map((point) => point.id));

describe('clusterPoints', () => {
  it('keeps points at least one radius apart as singles', () => {
    expect(ids(clusterPoints([{ id: 0, x: 0, y: 0 }, { id: 1, x: 30, y: 0 }, { id: 2, x: 0, y: 30 }], 30))).toEqual([[0], [1], [2]]);
  });

  it('groups a chain where only neighbours touch, so no badge is left under another', () => {
    const chain = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 25, y: 0 }, { id: 2, x: 50, y: 0 }, { id: 3, x: 200, y: 0 }];
    expect(ids(clusterPoints(chain, 30))).toEqual([[0, 1, 2], [3]]);
  });

  it('merges two groups once a later point bridges them', () => {
    const bridged = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 50, y: 0 }, { id: 2, x: 25, y: 0 }];
    expect(ids(clusterPoints(bridged, 30))).toEqual([[0, 1, 2]]);
  });
});

describe('graticule', () => {
  it('uses the homepage chart step ladder and labels for the visible window', () => {
    const g = graticule({ west: -30, east: 30, south: -20, north: 60 });
    expect(g.meridians.map((m) => m.label)).toEqual(['30°W', '15°W', '0°', '15°E', '30°E']);
    expect(g.parallels.map((p) => p.label)).toEqual(['15°S', '0°', '15°N', '30°N', '45°N', '60°N']);
    expect(g.meridians.filter((m) => m.primary).map((m) => m.value)).toEqual([0]);
  });

  it('runs lines past the window but never beyond the Mercator or date-line limits', () => {
    const g = graticule({ west: -200, east: 200, south: -89, north: 89 });
    const coordinates = g.lines.features.flatMap((feature) => feature.geometry.coordinates);
    expect(Math.max(...coordinates.map(([, lat]) => Math.abs(lat)))).toBeLessThanOrEqual(85);
    expect(Math.max(...coordinates.map(([lng]) => Math.abs(lng)))).toBeLessThanOrEqual(180);
    expect(g.lines.features).toHaveLength(g.meridians.length + g.parallels.length);
  });
});
