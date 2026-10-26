import { describe, expect, it } from 'vitest';
import { mapFrame } from '../public/map-frame.js';

describe('display-only longitude frame', () => {
  it('uses the compact world copy for split crossing runs and isolated pins', () => {
    const runs: [number, number][][] = [[[179.95, -16.8], [179.999, -16.82]], [[-179.98, -16.83], [-179.95, -16.84]], [[-179.9, -16.85]]];
    const before = structuredClone(runs);
    const frame = mapFrame(runs);
    expect(frame.bounds).toEqual([[179.95, -16.85], [180.1, -16.8]]);
    expect(frame.longitude(-179.95)).toBe(180.05);
    expect(frame.longitude(179.95)).toBe(179.95);
    expect(runs).toEqual(before);
  });

  it.each([
    { runs: [[[1, 2], [3, 4]]], bounds: [[1, 2], [3, 4]] },
    // Choosing the largest gap between vertices would cut this connected run.
    { runs: [[[-170, 0], [0, 1], [170, 2]]], bounds: [[-170, 0], [170, 2]] },
    { runs: [[[-180, 0], [0, 1], [180, 2]]], bounds: [[-180, 0], [180, 2]] },
    { runs: [[[-90, 0]], [[90, 0]]], bounds: [[-90, 0], [90, 0]] },
    { runs: [[[180, 90]], [[-180, -90]]], bounds: [[180, -90], [180, 90]] },
    { runs: [[[8, 9], [8, 9]]], bounds: [[8, 9], [8, 9]] },
  ])('retains sensible bounds for $runs', ({ runs, bounds }) => {
    const frame = mapFrame(runs as [number, number][][]);
    expect(frame.bounds).toEqual(bounds);
    for (const run of runs) {
      for (let index = 1; index < run.length; index++) {
        expect(frame.longitude(run[index]![0]!) - frame.longitude(run[index - 1]![0]!))
          .toBeCloseTo(run[index]![0]! - run[index - 1]![0]!);
      }
    }
  });

  it('handles empty geometry without inventing bounds', () => {
    expect(mapFrame([[]]).bounds).toBeNull();
    expect(mapFrame([]).longitude(12)).toBe(12);
  });
});
