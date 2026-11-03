import { describe, expect, it } from 'vitest';
import { publicStopRouteSchema } from './public-stop-route';
import { validatePublicStopRoute } from '../../../uploader/public/stop-route.js';

const run = (kind: string, coordinates: unknown) => ({ kind, coordinates });
const longRun = (count: number) => Array.from({ length: count }, (_, i) => [Number((i * 0.0001 - 50).toFixed(4)), Number((i % 2 ? 1 : 0).toFixed(4))]);

// One fixture set judged by both boundaries: the uploader (write/publish/restore) and the build (Zod).
const VALID: [string, unknown][] = [
  ['road and straight runs', { version: 1, runs: [run('road', [[23.7275, 37.9838], [22.9322, 37.9407]]), run('straight', [[21.7346, 38.2466], [28.2278, 36.4341]])] }],
  ['antimeridian boundary vertices', { version: 1, runs: [run('straight', [[179.5, -16], [180, -16.5]]), run('straight', [[-180, -16.5], [-179.5, -17]])] }],
  ['exactly 2000 vertices', { version: 1, runs: [run('road', longRun(2000))] }],
];
const INVALID: [string, unknown][] = [
  ['a GPX track shape', { version: 1, type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]]] }],
  ['no runs', { version: 1, runs: [] }],
  ['unknown kind', { version: 1, runs: [run('ferry', [[1, 1], [2, 2]])] }],
  ['extra run key', { version: 1, runs: [{ ...run('road', [[1, 1], [2, 2]]), leg: 0 }] }],
  ['extra top-level key', { version: 1, runs: [run('road', [[1, 1], [2, 2]])], source: 'osrm' }],
  ['a single position', { version: 1, runs: [run('road', [[1, 1]])] }],
  ['five decimals', { version: 1, runs: [run('road', [[1.00001, 1], [2, 2]])] }],
  ['negative zero', { version: 1, runs: [run('road', [[-0, 1], [2, 2]])] }],
  ['a repeated position', { version: 1, runs: [run('road', [[1, 1], [1, 1]])] }],
  ['a wrapping jump', { version: 1, runs: [run('road', [[179, 1], [-179, 1]])] }],
  ['latitude out of range', { version: 1, runs: [run('road', [[1, 91], [2, 2]])] }],
  ['2001 vertices', { version: 1, runs: [run('road', longRun(1000)), run('road', longRun(1001))] }],
  ['101 runs', { version: 1, runs: Array.from({ length: 101 }, () => run('road', [[1, 1], [2, 2]])) }],
  ['version 2', { version: 2, runs: [run('road', [[1, 1], [2, 2]])] }],
];

describe('public stop route boundary parity (#513)', () => {
  it.each(VALID)('both accept %s', (_name, value) => {
    expect(publicStopRouteSchema.safeParse(value).success).toBe(true);
    expect(() => validatePublicStopRoute(value)).not.toThrow();
  });
  it.each(INVALID)('both refuse %s', (_name, value) => {
    expect(publicStopRouteSchema.safeParse(value).success).toBe(false);
    expect(() => validatePublicStopRoute(value)).toThrow();
  });
});
