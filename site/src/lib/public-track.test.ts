import { describe, expect, it } from 'vitest';
import { publicTrackSchema, publicTrackSummary, type PublicTrack } from './public-track';

const track: PublicTrack = {
  version: 1, type: 'MultiLineString',
  coordinates: [[[1, 0], [1.001, 0]], [[101, 0], [101.002, 0]]],
};

function withCoordinates(coordinates: unknown) {
  return { ...track, coordinates };
}

describe('strict public track content schema', () => {
  it('round-trips the exact two-dimensional public artifact and leaves missing tracks optional', () => {
    expect(publicTrackSchema.parse(JSON.parse(JSON.stringify(track)))).toEqual(track);
    expect(publicTrackSchema.optional().parse(undefined)).toBeUndefined();
    expect(publicTrackSchema.optional().safeParse(null).success).toBe(false);
  });

  it.each([
    { ...track, version: 2 },
    { ...track, type: 'LineString' },
    { ...track, original: '/data/routes/private.gpx' },
    { ...track, geometry: { runs: [] } },
    { ...track, time: '2026-10-23T00:00:00Z' },
    { ...track, elevation: 12 },
    { ...track, removedPoints: 20 },
    { ...track, unknown: true },
    withCoordinates([[[1, 2, 3], [2, 3, 4]]]),
    withCoordinates([[{ lng: 1, lat: 2 }, { lng: 2, lat: 3 }]]),
    withCoordinates([[['1', 2], [2, 3]]]),
    withCoordinates([[[NaN, 2], [2, 3]]]),
    withCoordinates([[[1, Infinity], [2, 3]]]),
    withCoordinates([[[-Infinity, 2], [2, 3]]]),
    withCoordinates([[[180.0001, 2], [2, 3]]]),
    withCoordinates([[[-180.0001, 2], [2, 3]]]),
    withCoordinates([[[1, 90.0001], [2, 3]]]),
    withCoordinates([[[1, -90.0001], [2, 3]]]),
    withCoordinates([[[1.12345, 2], [2, 3]]]),
    withCoordinates([[[1, 2.12345], [2, 3]]]),
    withCoordinates([[[-0, 2], [2, 3]]]),
    withCoordinates([[[1, -0], [2, 3]]]),
    withCoordinates([]),
    withCoordinates([[]]),
    withCoordinates([[[1, 2]]]),
    withCoordinates([[[1, 2], [1, 2]]]),
    withCoordinates([[[1, 2], [1, 2], [2, 3]]]),
    withCoordinates([[[179, 0], [-179, 0]]]),
  ])('rejects malformed or private data instead of stripping or coercing it (%#)', (value) => {
    expect(publicTrackSchema.safeParse(value).success).toBe(false);
  });

  it('accepts boundary coordinates and exact four-decimal numbers without floating-point false positives', () => {
    expect(publicTrackSchema.safeParse(withCoordinates([
      [[-180, -90], [-179.9999, -89.9999]], [[180, 90], [179.9999, 89.9999]],
      [[12.3456, -12.3456], [0.0001, 0]],
    ])).success).toBe(true);
  });

  it('enforces run and total vertex caps including across multiple runs', () => {
    const run: [number, number][] = Array.from({ length: 20 }, (_, i) => [i, 0]);
    expect(publicTrackSchema.safeParse(withCoordinates(Array.from({ length: 100 }, () => run))).success).toBe(true);
    expect(publicTrackSchema.safeParse(withCoordinates(Array.from({ length: 101 }, () => [[1, 0], [2, 0]]))).success).toBe(false);
    expect(publicTrackSchema.safeParse(withCoordinates(Array.from({ length: 100 }, () => [...run, [21, 0]]))).success).toBe(false);
    expect(publicTrackSchema.safeParse(withCoordinates([Array.from({ length: 2001 }, (_, i) => [i % 2, 0])])).success).toBe(false);
  });

  it('also rejects compact JSON beyond the byte cap', () => {
    // Valid precision/ranges cannot exhaust 64 KiB within 2,000 vertices;
    // this oversized artifact must fail both independent resource limits.
    const oversized = withCoordinates(Array.from({ length: 100 }, () =>
      Array.from({ length: 40 }, (_, i) => [i % 2 ? -179.9999 : -179.9998, -89.9999])));
    expect(JSON.stringify(oversized).length).toBeGreaterThan(64 * 1024);
    const parsed = publicTrackSchema.safeParse(oversized);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message === 'Public track byte limit exceeded')).toBe(true);
  });
});

describe('public route text', () => {
  it('summarizes each public run, never the distance across the gap', () => {
    expect(publicTrackSummary(track, 'en')).toEqual([
      { distance: '0.11', start: '0.0000, 1.0000', end: '0.0000, 1.0010' },
      { distance: '0.22', start: '0.0000, 101.0000', end: '0.0000, 101.0020' },
    ]);
    expect(publicTrackSummary(track, 'de').map((run) => run.distance)).toEqual(['0,11', '0,22']);
  });

  it('uses every retained bend, handles poles/antimeridian, and exposes only distance and public endpoints', () => {
    const bent: PublicTrack = { ...track, coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001]]] };
    expect(publicTrackSummary(bent, 'en')[0]).toEqual({ distance: '0.22', start: '0.0000, 0.0000', end: '0.0010, 0.0010' });
    const edge: PublicTrack = { ...track, coordinates: [[[179.999, 0], [180, 0]], [[-180, 0], [-179.999, 0]], [[0, 90], [1, 90]]] };
    expect(publicTrackSummary(edge, 'en').map((run) => run.distance)).toEqual(['0.11', '0.11', '0.00']);
  });
});
