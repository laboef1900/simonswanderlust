import { describe, expect, it } from 'vitest';
import { GPX_LIMITS, trimGeometry, type PrivateGeometry } from '../public/gpx-geometry.js';
import { createPublicTrack, validatePublicTrack, PUBLIC_TRACK_LIMITS, PublicTrackError, type PublicTrack } from '../public/gpx-public-track.js';

type Position = [number, number];
const geometry = (...runs: Position[][]): PrivateGeometry => ({ version: 1,
  segments: runs.map((run) => ({ points: run.map(([lng, lat]) => ({ lng, lat })) })) });
const track = (...coordinates: Position[][]): PublicTrack => ({ version: 1, type: 'MultiLineString', coordinates });
const rounded = (n: number) => Math.round(n * 10000) / 10000 || 0;

describe('canonical public track transformation', () => {
  it('simplifies a full private point-cap straight run without truncating its endpoints', () => {
    const run: Position[] = Array.from({ length: GPX_LIMITS.points }, (_, i) => [i / 10000, 0]);
    expect(createPublicTrack(geometry(run))).toEqual({ track: track([[0, 0], [4.9999, 0]]), collapsedRuns: 0 });
  });

  it('uses the fixed 25 metre spherical tolerance, not a degree or pixel approximation', () => {
    const latitude = (metres: number) => metres / 6371008.8 * 180 / Math.PI;
    const below: Position[] = [[0, 0], [0.01, latitude(24)], [0.02, 0]];
    const above: Position[] = [[0, 0], [0.01, latitude(26)], [0.02, 0]];
    expect(createPublicTrack(geometry(below)).track).toEqual(track([[0, 0], [0.02, 0]]));
    expect(createPublicTrack(geometry(above)).track).toEqual(track([[0, 0], [0.01, 0.0002], [0.02, 0]]));
  });

  it('measures the finite minor segment, including endpoints, rather than an infinite great circle', () => {
    const backtracking: Position[] = [[0, 0], [2, 0], [1, 0]];
    expect(createPublicTrack(geometry(backtracking)).track).toEqual(track(backtracking));
  });

  it('uses great-circle rather than planar latitude interpolation near the pole', () => {
    const middleLatitude = Math.atan(Math.tan(80 * Math.PI / 180) / Math.cos(Math.PI / 4)) * 180 / Math.PI;
    expect(createPublicTrack(geometry([[-45, 80], [0, middleLatitude], [45, 80]])).track)
      .toEqual(track([[-45, 80], [45, 80]]));
    expect(createPublicTrack(geometry([[-90, 80], [0, 90], [90, 80]])).track)
      .toEqual(track([[-90, 80], [90, 80]]));
  });

  it('handles coincident and antipodal endpoints conservatively using retained source points', () => {
    const loop: Position[] = [[0, 0], [0, 0.001], [0, 0]];
    expect(createPublicTrack(geometry(loop)).track).toEqual(track(loop));
    const antipodal: Position[] = [[0, 0], [90, 10], [180, 0]];
    expect(createPublicTrack(geometry(antipodal)).track).toEqual(track(antipodal));
    // No chosen antipodal hemisphere and no invented intermediate point.
    const polar: Position[] = [[0, 90], [45, 0], [90, -90]];
    expect(createPublicTrack(geometry(polar)).track).toEqual(track(polar));
  });

  it('preserves antimeridian splits and refuses a shortcut that would invent a wrapping edge', () => {
    const normalized = geometry([[179, 0], [179.9, 0]], [[-179.9, 0], [-179, 0]]);
    expect(createPublicTrack(normalized).track).toEqual(track([[179, 0], [179.9, 0]], [[-179.9, 0], [-179, 0]]));
    const aroundPole: Position[] = [[-170, 89.9999], [0, 89.9999], [170, 89.9999]];
    expect(createPublicTrack(geometry(aroundPole)).track).toEqual(track(aroundPole));
    expect(() => createPublicTrack(geometry([[179, 0], [-179, 0]]))).toThrow('gpx_invalid_geometry');
  });

  it('rounds only after simplification, removes consecutive collisions and reports collapsed runs', () => {
    const result = createPublicTrack(geometry(
      [[-0.000001, -0.000001], [0.000001, 0.000001]],
      [[12.345678, -45.123456], [12.346789, -45.123456]],
    ));
    expect(result).toEqual({ track: track([[12.3457, -45.1235], [12.3468, -45.1235]]), collapsedRuns: 1 });
    expect(() => createPublicTrack(geometry([[0, 0], [0.000001, 0.000001]]))).toThrow('track_empty_after_rounding');
    expect(() => createPublicTrack(geometry())).toThrow('track_empty_after_rounding');
    const zero = createPublicTrack(geometry([[-0.000001, -0], [0.001, 0]])).track.coordinates[0]![0]!;
    expect(zero).toEqual([0, 0]);
    expect(Object.is(zero[0], -0)).toBe(false);
    expect(Object.is(zero[1], -0)).toBe(false);
  });

  it('keeps source-run provenance after trim, never bridges gaps or projects private fields', () => {
    const source = geometry([[0, 0], [1.123456, 0], [2.234567, 0]],
      [[30.345678, 1], [31.456789, 1]], [[60.567891, 0], [61.678912, 0], [62.789123, 0]]);
    for (const run of source.segments) for (const point of run.points) {
      point.elevation = 98765.4321;
      point.time = '2026-10-23T12:34:56.789Z';
    }
    const before = structuredClone(source);
    const retained = trimGeometry(source, { startPoints: 1, endPoints: 1, removedSegments: [1] }).geometry;
    const result = createPublicTrack(retained);
    expect(result.track).toEqual(track([[1.1235, 0], [2.2346, 0]], [[60.5679, 0], [61.6789, 0]]));
    for (let i = 0; i < result.track.coordinates.length; i++) {
      const sourceRun = retained.segments[i]!.points.map((p): Position => [rounded(p.lng), rounded(p.lat)]);
      for (const position of result.track.coordinates[i]!) expect(sourceRun).toContainEqual(position);
    }
    expect(source).toEqual(before);
    expect(Object.keys(result.track).sort()).toEqual(['coordinates', 'type', 'version']);
    expect(JSON.stringify(result)).not.toContain('98765');
    expect(JSON.stringify(result)).not.toContain('2026-10-23');
    expect(createPublicTrack(retained)).toEqual(result);
  });

  it('admits all 100 normalized runs but refuses an over-2000-vertex zigzag rather than raising tolerance', () => {
    const runs = Array.from({ length: 100 }, (): Position[] => [[0, 0], [1, 0]]);
    expect(createPublicTrack(geometry(...runs)).track.coordinates).toHaveLength(100);
    const zigzag: Position[] = Array.from({ length: 2002 }, (_, i) => [i * 0.01, i % 2 ? 0.01 : 0]);
    let failure: unknown;
    try { createPublicTrack(geometry(zigzag)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PublicTrackError);
    if (!(failure instanceof PublicTrackError)) throw new Error('Expected a coded public refusal');
    const publicZigzag = zigzag.map(([lng, lat]): Position => [rounded(lng), rounded(lat)]);
    expect(failure.message).toBe('track_public_limit');
    expect(failure.counts).toEqual({ retainedRuns: 1, vertices: 2001, bytes: Buffer.byteLength(JSON.stringify(track(publicZigzag))) });
  });
});

describe('strict public artifact validation', () => {
  it('accepts the original object by identity and bounds compact UTF-8 JSON', () => {
    const value = track([[0, -90], [180, 90]]);
    expect(validatePublicTrack(value)).toBe(value);
    const maximum = track(Array.from({ length: 2000 }, (_, i): Position => [i % 2 ? -179.9999 : -178.9999, -89.9999]));
    expect(validatePublicTrack(maximum)).toBe(maximum);
    expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThanOrEqual(PUBLIC_TRACK_LIMITS.bytes);
  });

  it('refuses private/unknown keys, third ordinates, coercion, negative zero and noncanonical precision', () => {
    const valid = track([[0, 0], [1, 1]]);
    const invalid: unknown[] = [null, [], {}, { ...valid, version: 2 }, { ...valid, type: 'LineString' },
      { ...valid, geometry: { private: true } }, { ...valid, collapsedRuns: 1 },
      { ...valid, coordinates: [[[0, 0, 999], [1, 1]]] },
      { ...valid, coordinates: [[['0', 0], [1, 1]]] },
      track([[-0, 0], [1, 1]]), track([[0.00001, 0], [1, 1]]), track([[NaN, 0], [1, 1]]),
      track([[0, Infinity], [1, 1]]), track([[181, 0], [1, 1]]), track([[0, -91], [1, 1]]),
      track([[0, 0], [0, 0]]), track([[0, 0]]), track([[179, 0], [-179, 0]]),
      track(...Array.from({ length: 101 }, (): Position[] => [[0, 0], [1, 1]])),
      track(Array.from({ length: 2001 }, (_, i): Position => [i % 2, 0])),
      { ...valid, [Symbol('private')]: 1 },
      { ...valid, coordinates: Object.assign([[[0, 0], [1, 1]]], { private: true }) },
      { ...valid, coordinates: [[Object.assign([0, 0], { elevation: 999 }), [1, 1]]] },
    ];
    for (const value of invalid) expect(() => validatePublicTrack(value)).toThrow('track_public_limit');
    expect(() => validatePublicTrack(track())).toThrow('track_empty_after_rounding');
  });
});
