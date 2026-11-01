import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
  BREAKOUT_WIDTH, COLUMN_WIDTH, ROW_GAP, MIN_ROW_HEIGHT, PARTITION_WORK_QUANTUM,
  partitionRows, partitionRowsAsync, partitionRowWork, cannotImprovePartition,
  galleryHeightAt, rowHeightAt, type GalleryRow,
} from './gallery-layout.js';

/** Frozen pre-#356 exhaustive DP, including arithmetic and predecessor ties. */
function oracle(input: readonly number[], containerWidth: number, inspect?: (count: number, height: number) => void): GalleryRow[] {
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : BREAKOUT_WIDTH;
  const ratios = input.filter(r => Number.isFinite(r) && r > 0);
  const n = ratios.length;
  const prefix = [0];
  for (const r of ratios) prefix.push(prefix[prefix.length - 1]! + r);
  let winner: number[][] = [];
  let closest = Infinity;
  for (let k = 1; k <= n; k++) {
    const target = (width - (k - 1) * ROW_GAP) / k;
    const cost = (from: number, to: number) => {
      const h = (width - (to - from - 1) * ROW_GAP) / (prefix[to]! - prefix[from]!);
      return to - from > 1 && h < MIN_ROW_HEIGHT ? Infinity : (h - target) ** 2;
    };
    let best = Array.from({ length: n + 1 }, (_, i) => i === 0 ? Infinity : cost(0, i));
    const parents = [new Array<number>(n + 1).fill(0)];
    for (let j = 2; j <= k; j++) {
      const next = new Array<number>(n + 1).fill(Infinity);
      const from = new Array<number>(n + 1).fill(0);
      for (let i = j; i <= n; i++) {
        for (let m = j - 1; m < i; m++) {
          const c = best[m]! + cost(m, i);
          if (c < next[i]!) { next[i] = c; from[i] = m; }
        }
      }
      best = next;
      parents.push(from);
    }
    if (!Number.isFinite(best[n])) continue;
    const rows: number[][] = [];
    for (let j = k, end = n; j >= 1; j--) {
      const start = parents[j - 1]![end]!;
      rows.unshift(ratios.slice(start, end));
      end = start;
    }
    const height = galleryHeightAt(rows, width);
    inspect?.(k, height);
    const distance = Math.abs(height - width);
    if (distance < closest) { closest = distance; winner = rows; }
  }
  return winner.map(row => ({
    ratios: row,
    maxWidthFraction: rowHeightAt(row, width) <= width ? null
      : (width * row.reduce((sum, r) => sum + r, 0) + (row.length - 1) * ROW_GAP) / width,
  }));
}

function* corpus() {
  yield [];
  const alphabet = [2 / 3, 1.5, 10];
  for (let length = 1; length <= 6; length++) {
    for (let code = 0; code < alphabet.length ** length; code++) {
      let value = code;
      yield Array.from({ length }, () => {
        const ratio = alphabet[value % alphabet.length]!;
        value = Math.floor(value / alphabet.length);
        return ratio;
      });
    }
  }
  for (let n = 1; n <= 37; n++) {
    yield Array.from({ length: n }, (_, i) => i % 3 ? 1.5 : 2 / 3);
    yield Array.from({ length: n }, (_, i) => i % 7 ? 0.02 : 10);
    yield Array.from({ length: n }, () => 1.5);
  }
  yield [NaN, 0, -1, Infinity, 1.5, 2 / 3, 1.5];
  // Two-photo rows immediately below / on / above the exact height floor.
  for (const width of [COLUMN_WIDTH, BREAKOUT_WIDTH]) {
    for (const delta of [-1e-10, 0, 1e-10]) {
      yield Array.from({ length: 12 }, () => (width - ROW_GAP) / (2 * MIN_ROW_HEIGHT) + delta);
    }
  }
}

describe('exact resumable partition', () => {
  it('preserves original membership, caps, multiplicity, objective and ties', () => {
    for (const width of [COLUMN_WIDTH, BREAKOUT_WIDTH, NaN, -1]) {
      for (const ratios of corpus()) {
        const candidateHeights = new Map<number, number>();
        const expected = oracle(ratios, width, (count, height) => candidateHeights.set(count, height));
        const normalizedWidth = Number.isFinite(width) && width > 0 ? width : BREAKOUT_WIDTH;
        const kernel = partitionRowWork(ratios, width, candidate => {
          const height = candidateHeights.get(candidate.count);
          expect(height).toBeDefined();
          const slack = Number.EPSILON * 64 * (ratios.length + 1) * Math.max(1, height!);
          expect(height! + slack).toBeGreaterThanOrEqual(candidate.lower);
          expect(height! - slack).toBeLessThanOrEqual(candidate.upper);
          if (candidate.skipped) {
            // Inspect EVERY excluded count against its actual original-DP winner.
            expect(Math.abs(height! - normalizedWidth)).toBeGreaterThanOrEqual(candidate.incumbent);
          }
        });
        let result: GalleryRow[];
        for (;;) {
          const step = kernel.next();
          if (step.done) { result = step.value; break; }
        }
        expect(result).toEqual(expected);
        expect(result.flatMap(row => row.ratios)).toEqual(ratios.filter(r => Number.isFinite(r) && r > 0));
      }
    }
  });

  it('only rejects intervals strictly beyond the incumbent, never near ties or square overlaps', () => {
    for (const width of [COLUMN_WIDTH, BREAKOUT_WIDTH]) {
      for (let count = 1; count <= 37; count++) {
        for (const distance of [0, 1, 100, 10000]) {
          expect(cannotImprovePartition(width + distance, width + distance + 100, width, distance, count)).toBe(false);
          expect(cannotImprovePartition(width + distance + Number.EPSILON * width, width + distance + 100, width, distance, count)).toBe(false);
          expect(cannotImprovePartition(width - 100, width + 100, width, distance, count)).toBe(false);
          expect(cannotImprovePartition(width + distance + 1, width + distance + 100, width, distance, count)).toBe(true);
          expect(cannotImprovePartition(width - distance - 100, width - distance - 1, width, distance, count)).toBe(true);
        }
      }
    }
  });

  it('resumes in every phase and yields exactly once per bounded quantum, with identical output', async () => {
    const ratios = Array.from({ length: 400 }, (_, i) => i % 3 ? 1.5 : 2 / 3);
    const kernel = partitionRowWork(ratios, COLUMN_WIDTH);
    const phases = new Set<string>();
    let operations = 0;
    let result: GalleryRow[];
    for (;;) {
      const step = kernel.next();
      if (step.done) { result = step.value; break; }
      phases.add(step.value.phase);
      expect(step.value.operations).toBeGreaterThan(0);
      expect(step.value.operations).toBeLessThanOrEqual(PARTITION_WORK_QUANTUM);
      operations += step.value.operations;
    }
    expect(phases).toEqual(new Set(['prepare', 'bounds', 'objective', 'reconstruct']));
    let yields = 0;
    let timerRan = false;
    const timer = setImmediate().then(() => { timerRan = true; });
    const scheduled = await partitionRowsAsync(ratios, COLUMN_WIDTH, {
      schedule: async work => {
        expect(work.operations).toBeGreaterThan(0);
        expect(work.operations).toBeLessThanOrEqual(PARTITION_WORK_QUANTUM);
        yields++;
        await setImmediate();
      },
    });
    expect(timerRan).toBe(true);
    await timer;
    expect(yields).toBe([...partitionRowWork(ratios, COLUMN_WIDTH)].length);
    expect(yields).toBeGreaterThan(1);
    expect(scheduled).toEqual(result!);
    expect(await partitionRowsAsync(ratios, COLUMN_WIDTH)).toEqual(result!);
    // Deterministic work regression, not a hardware-dependent timing assertion.
    expect(operations).toBeLessThan(2_000_000);
  });

  it('can pause inside reconstruction, not just at gallery or DP boundaries', () => {
    const ratios = Array.from({ length: 2050 }, () => 10);
    const work = partitionRowWork(ratios, COLUMN_WIDTH);
    let interruptedReconstruction = false;
    for (;;) {
      const step = work.next();
      if (step.done) {
        expect(step.value.flatMap(row => row.ratios)).toEqual(ratios);
        break;
      }
      expect(step.value.operations).toBeLessThanOrEqual(PARTITION_WORK_QUANTUM);
      if (step.value.phase === 'reconstruct' && step.value.operations === PARTITION_WORK_QUANTUM) interruptedReconstruction = true;
    }
    expect(interruptedReconstruction).toBe(true);
  });

  it('keeps concurrent request state separate and propagates scheduler failures', async () => {
    const inputs = [Array.from({ length: 100 }, () => 0.02), Array.from({ length: 100 }, () => 10)];
    const actual = await Promise.all(inputs.map(ratios => partitionRowsAsync(ratios, BREAKOUT_WIDTH, { schedule: () => setImmediate() })));
    expect(actual).toEqual(inputs.map(ratios => partitionRows(ratios, BREAKOUT_WIDTH)));
    await expect(partitionRowsAsync(inputs[0]!, COLUMN_WIDTH, { schedule: async () => { throw new Error('scheduler failed'); } })).rejects.toThrow('scheduler failed');
  });
});
