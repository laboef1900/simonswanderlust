import { describe, expect, it } from 'vitest';
import { GPX_LIMITS, geometryStats, selectionFromDistances, trimGeometry, validateGeometry,
  type PrivateGeometry, type TrimSelection } from '../public/gpx-geometry.js';

const geometry = (...runs: number[][]): PrivateGeometry => ({ version: 1,
  segments: runs.map((run) => ({ points: run.map((lng) => ({ lng, lat: 0 })) })) });
const selection = (startPoints = 0, endPoints = 0, removedSegments: number[] = []): TrimSelection => ({ startPoints, endPoints, removedSegments });

describe('private geometry validation', () => {
  it('enforces closed versioned shapes at every level and rejects disguised private fields', () => {
    const valid = geometry([0, 1]);
    expect(() => validateGeometry(valid)).not.toThrow();
    for (const invalid of [null, [], {}, { ...valid, version: 2 }, { ...valid, original: 'private' },
      { ...valid, segments: [{ points: valid.segments[0]!.points, source: 'private' }] },
      { ...valid, segments: [{ points: [{ lng: 0, lat: 0, metadata: {} }, { lng: 1, lat: 0 }] }] },
      geometry([0]), geometry([0, NaN]), geometry([0, Infinity]), geometry([0, 181]), geometry([179, -179])]) {
      expect(() => validateGeometry(invalid)).toThrow();
    }
    expect(() => validateGeometry(geometry())).toThrow('gpx_invalid_geometry');
    expect(() => validateGeometry(geometry(), true)).not.toThrow();
  });

  it('requires bounded elevation and canonical valid UTC timestamps', () => {
    for (const time of ['2024-02-29T00:00:00.000Z', '0001-01-01T00:00:00.000Z']) {
      const value = geometry([0, 1]);
      value.segments[0]!.points[0] = { lng: 0, lat: 90, elevation: -12000, time };
      expect(() => validateGeometry(value)).not.toThrow();
    }
    for (const fields of [{ elevation: 100001 }, { elevation: NaN }, { time: '2023-02-29T00:00:00.000Z' },
      { time: '0000-01-01T00:00:00.000Z' }, { time: '2024-01-01T00:00:00+00:00' }, { time: undefined }]) {
      const value = geometry([0, 1]);
      Object.assign(value.segments[0]!.points[0]!, fields);
      expect(() => validateGeometry(value)).toThrow('gpx_invalid_geometry');
    }
  });

  it('enforces total points and normalized segment caps', () => {
    expect(() => validateGeometry(geometry(Array(GPX_LIMITS.points + 1).fill(0) as number[]))).toThrow('gpx_limit');
    expect(() => validateGeometry(geometry(...Array.from({ length: 101 }, () => [0, 1])))).toThrow('gpx_invalid_geometry');
  });
});

describe('immutable normalized-index point trimming', () => {
  it('removes named runs before trimming without reindexing or merging gaps', () => {
    const source = geometry([0, 1, 2], [30, 31, 32], [60, 61, 62, 63]);
    const before = structuredClone(source);
    const trimmed = trimGeometry(source, selection(1, 1, [1]));
    expect(trimmed.geometry).toEqual(geometry([1, 2], [60, 61, 62]));
    expect(trimmed.removedPoints).toBe(5);
    expect(trimmed.droppedSegments).toBe(0);
    expect(source).toEqual(before);
    trimmed.geometry.segments[0]!.points[0]!.lng = 99;
    expect(source).toEqual(before);
    expect(trimGeometry(source, selection(0, 0, [0])).geometry).toEqual(geometry([30, 31, 32], [60, 61, 62, 63]));
  });

  it('drops trimmed singletons explicitly, preserves optional scalars and refuses all-empty attachment', () => {
    const source = geometry([0, 1], [10, 11, 12]);
    source.segments[1]!.points[0]!.elevation = 9;
    source.segments[1]!.points[0]!.time = '2024-01-01T00:00:00.000Z';
    const result = trimGeometry(source, selection(1));
    expect(result.droppedSegments).toBe(1);
    expect(result.removedPoints).toBe(2);
    expect(result.geometry.segments[0]!.points[0]).toEqual(source.segments[1]!.points[0]);
    for (const pick of [selection(5), selection(0, 5), selection(2, 3), selection(1, 3), selection(0, 0, [0, 1])]) {
      expect(() => trimGeometry(source, pick)).toThrow('gpx_empty_selection');
    }
    expect(() => trimGeometry(geometry(), selection())).toThrow('gpx_empty_selection');
  });

  it('validates safe integer counts and unique in-range immutable segment indices', () => {
    const source = geometry([0, 1], [10, 11]);
    for (const pick of [selection(-1), selection(0.5), selection(NaN), selection(Number.MAX_SAFE_INTEGER + 1),
      selection(0, -1), selection(0, 0, [0, 0]), selection(0, 0, [2]), selection(0, 0, [-1]),
      { ...selection(), injected: true }]) expect(() => trimGeometry(source, pick)).toThrow('gpx_invalid_selection');
  });
});

describe('gap-free cumulative distance trimming', () => {
  const step = 100 / (6371008.8 * Math.PI / 180);
  const source = geometry([0, step / 2, step], [10, 10 + step / 2, 10 + step]);

  it('uses haversine distance with no cross-run edge and one cumulative traversal', () => {
    expect(geometryStats(source)).toMatchObject({ points: 6, segments: 2 });
    expect(geometryStats(source).distanceMetres).toBeCloseTo(200, 7);
    expect(selectionFromDistances(source, [], 149, 0)).toEqual(selection(4));
    expect(selectionFromDistances(source, [], 0, 149)).toEqual(selection(0, 4));
    expect(selectionFromDistances(source, [0], 49, 0)).toEqual(selection(1, 0, [0]));
    expect(selectionFromDistances(source, [], 1000, 0)).toEqual(selection(6));
  });

  it('chooses the first traversal point at equal-distance run boundaries in either direction', () => {
    const ties = geometry([0, 0], [90, 90]);
    expect(selectionFromDistances(ties, [], 0, 0)).toEqual(selection());
    expect(selectionFromDistances(ties, [], 1, 1)).toEqual(selection(4, 4));
    const sameRuns = geometry([0, step], [0, step]);
    const length = geometryStats(geometry([0, step])).distanceMetres;
    expect(selectionFromDistances(sameRuns, [], length, length)).toEqual(selection(1, 1));
  });

  it('handles empty selections and invalid distances without inventing points', () => {
    expect(selectionFromDistances(source, [0, 1], 10, 10)).toEqual(selection(0, 0, [0, 1]));
    expect(geometryStats(geometry())).toEqual({ points: 0, segments: 0, distanceMetres: 0 });
    for (const distance of [-1, NaN, Infinity]) expect(() => selectionFromDistances(source, [], distance, 0)).toThrow('gpx_invalid_selection');
  });
});
