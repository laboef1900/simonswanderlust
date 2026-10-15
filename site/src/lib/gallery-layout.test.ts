import { describe, expect, it } from 'vitest';
import {
  BREAKOUT_WIDTH,
  COLUMN_WIDTH,
  GALLERY_MODES,
  MIN_ROW_HEIGHT,
  ROW_GAP,
  containerWidthFor,
  galleryHeightAt,
  partitionRows,
  readLayoutMode,
  rowHeightAt,
} from './gallery-layout.js';

const LANDSCAPE = 3000 / 2000; // 1.5
const PORTRAIT = 2000 / 3000; // 0.667
const PANORAMA = 4; // a 4:1 strip

/** Row sizes, the shape most assertions care about. */
const sizes = (ratios: number[], width = BREAKOUT_WIDTH) =>
  partitionRows(ratios, width).map((row) => row.ratios.length);

/** Stacked height of a partition as a fraction of its width — 1 is a square. */
const squareness = (ratios: number[], width = BREAKOUT_WIDTH) =>
  galleryHeightAt(partitionRows(ratios, width).map((row) => row.ratios), width) / width;

/**
 * Every contiguous partition of `ratios`, for brute-force comparison against
 * the DP. 2^(n−1) of them, so keep n small.
 */
function* everyPartition(ratios: number[]): Generator<number[][]> {
  const n = ratios.length;
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const rows: number[][] = [];
    let row: number[] = [];
    ratios.forEach((r, i) => {
      row.push(r);
      if (i === n - 1 || mask & (1 << i)) {
        rows.push(row);
        row = [];
      }
    });
    yield rows;
  }
}

const repeat = (n: number, r: number) => Array.from({ length: n }, () => r);

describe('readLayoutMode', () => {
  it('defaults to the column when the fence carries no directive', () => {
    expect(readLayoutMode('https://img/a\nhttps://img/b')).toBe('column');
  });

  it('reads each of the three modes', () => {
    for (const mode of GALLERY_MODES) {
      expect(readLayoutMode(`#layout: ${mode}\nhttps://img/a`)).toBe(mode);
    }
  });

  it('tolerates the spacing an author might type', () => {
    expect(readLayoutMode('#layout:slider')).toBe('slider');
    expect(readLayoutMode('# layout: slider')).toBe('slider');
    expect(readLayoutMode('   #layout :  slider   ')).toBe('slider');
    expect(readLayoutMode('#LAYOUT: Slider')).toBe('slider');
  });

  // The whole point of the fallback: a typo degrades to the default rather
  // than breaking a gallery that would otherwise render.
  it('falls back to the column on an unknown, empty or malformed value', () => {
    expect(readLayoutMode('#layout: carousel')).toBe('column');
    expect(readLayoutMode('#layout:')).toBe('column');
    expect(readLayoutMode('#layout')).toBe('column');
    expect(readLayoutMode('#layout: slider extra')).toBe('column');
    expect(readLayoutMode('')).toBe('column');
  });

  it('ignores a directive-looking string that is not a whole line', () => {
    expect(readLayoutMode('https://img/a | alt="#layout: slider"')).toBe('column');
  });

  // First wins, so a stray duplicate can't silently override the author's
  // choice — and the picker only ever writes one.
  it('takes the first #layout: line when a fence has several', () => {
    expect(readLayoutMode('#layout: slider\n#layout: column')).toBe('slider');
  });

  it('leaves other comment lines alone', () => {
    expect(readLayoutMode('# just a note\n#layout: column')).toBe('column');
  });
});

describe('containerWidthFor', () => {
  it('maps the justified modes to their measured container widths', () => {
    expect(containerWidthFor('breakout')).toBe(BREAKOUT_WIDTH);
    expect(containerWidthFor('column')).toBe(COLUMN_WIDTH);
  });
});

describe('partitionRows — row membership', () => {
  it('returns no rows for no photos', () => {
    expect(partitionRows([], BREAKOUT_WIDTH)).toEqual([]);
  });

  it('puts a single photo in a single row', () => {
    expect(sizes([LANDSCAPE])).toEqual([1]);
    expect(sizes([PORTRAIT])).toEqual([1]);
  });

  it('stacks two landscapes rather than leaving a wide, short pair', () => {
    // Side by side they are 1112 × 366; stacked, 1112 × 1494 — closer to square.
    expect(sizes(repeat(2, LANDSCAPE))).toEqual([1, 1]);
  });

  it('pairs three landscapes and a portrait into two even rows', () => {
    const rows = partitionRows([LANDSCAPE, LANDSCAPE, LANDSCAPE, PORTRAIT], BREAKOUT_WIDTH);
    expect(rows.map((row) => row.ratios)).toEqual([[LANDSCAPE, LANDSCAPE], [LANDSCAPE, PORTRAIT]]);
  });

  it('never leaves a lone landscape as a full-width finale beside short rows', () => {
    // 3 + 3 + 1 stacks to 1249, marginally closer to 1112 than 2 + 2 + 3 at
    // 1366 — but its last photo would be three times the height of the rows
    // above it. Evenness within the row count decides, not the square alone.
    const rows = partitionRows(repeat(7, LANDSCAPE), BREAKOUT_WIDTH);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.ratios.length).sort()).toEqual([2, 2, 3]);
  });

  it('gives a lone panorama its own row rather than squashing a mixed row', () => {
    expect(sizes([PANORAMA, LANDSCAPE, LANDSCAPE])).toEqual([1, 2]);
  });

  it('preserves order and count across a nine-photo mix', () => {
    const mix = [LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE, PORTRAIT, PANORAMA, LANDSCAPE, PORTRAIT, LANDSCAPE];
    const rows = partitionRows(mix, BREAKOUT_WIDTH);
    expect(rows.flatMap((row) => row.ratios)).toEqual(mix);
    expect(rows.length).toBeGreaterThan(1);
  });

  it('preserves order and count across a thirteen-photo mix', () => {
    const mix = [...repeat(4, LANDSCAPE), ...repeat(3, PORTRAIT), PANORAMA, ...repeat(5, LANDSCAPE)];
    const rows = partitionRows(mix, BREAKOUT_WIDTH);
    expect(rows.flatMap((row) => row.ratios)).toEqual(mix);
  });

  it('partitions the same photos the same way in the column and the break-out', () => {
    // The square is scale-invariant apart from the 12px gap, so — until the
    // floor binds — the container changes how large the square is, not how
    // it is cut.
    expect(sizes(repeat(7, LANDSCAPE), COLUMN_WIDTH)).toEqual(sizes(repeat(7, LANDSCAPE), BREAKOUT_WIDTH));
    const mix = [LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE, PORTRAIT, LANDSCAPE];
    expect(sizes(mix, COLUMN_WIDTH)).toEqual(sizes(mix, BREAKOUT_WIDTH));
  });
});

describe('partitionRows — the gallery is a square', () => {
  it('chooses the row count whose stack lands closest to the width', () => {
    for (const gallery of [
      repeat(7, LANDSCAPE),
      [LANDSCAPE, LANDSCAPE, LANDSCAPE, PORTRAIT],
      [LANDSCAPE, PORTRAIT, PANORAMA, LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE],
      repeat(5, PORTRAIT),
    ]) {
      const chosen = partitionRows(gallery, BREAKOUT_WIDTH).map((row) => row.ratios);
      const distance = Math.abs(galleryHeightAt(chosen, BREAKOUT_WIDTH) - BREAKOUT_WIDTH);
      // No partition with a DIFFERENT row count does better. (Within the
      // chosen count the evenest split wins, and that can sit a hair further
      // from the square than a lopsided split with the same count would.)
      for (const other of everyPartition(gallery)) {
        if (other.length === chosen.length) continue;
        expect(Math.abs(galleryHeightAt(other, BREAKOUT_WIDTH) - BREAKOUT_WIDTH)).toBeGreaterThanOrEqual(distance);
      }
    }
  });

  it('lands near square for the galleries a story actually carries', () => {
    // A contiguous split of 3:2 frames cannot always hit 1:1 — four landscapes
    // are 2 + 2 at 0.67 or 1 + 2 + 1 at 1.68 — so this is a band, not a point.
    for (const gallery of [
      repeat(4, LANDSCAPE),
      repeat(7, LANDSCAPE),
      repeat(13, LANDSCAPE),
      [LANDSCAPE, LANDSCAPE, LANDSCAPE, PORTRAIT],
      [LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE, PORTRAIT, PANORAMA, LANDSCAPE, PORTRAIT, LANDSCAPE],
      [...repeat(4, LANDSCAPE), ...repeat(3, PORTRAIT), PANORAMA, ...repeat(5, LANDSCAPE)],
    ]) {
      expect(squareness(gallery)).toBeGreaterThan(0.6);
      expect(squareness(gallery)).toBeLessThan(1.35);
    }
  });

  it('keeps the rows of one gallery within a band of each other', () => {
    const rows = partitionRows(repeat(13, LANDSCAPE), BREAKOUT_WIDTH);
    const heights = rows.map((row) => rowHeightAt(row.ratios, BREAKOUT_WIDTH));
    expect(Math.max(...heights) / Math.min(...heights)).toBeLessThan(1.6);
  });
});

describe('partitionRows — photos never shrink below the floor', () => {
  it('grows a big gallery taller than square rather than cutting rows under MIN_ROW_HEIGHT', () => {
    // 37 landscapes as a square would be seven rows of ~134px.
    const rows = partitionRows(repeat(37, LANDSCAPE), BREAKOUT_WIDTH);
    for (const row of rows) expect(rowHeightAt(row.ratios, BREAKOUT_WIDTH)).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
    expect(squareness(repeat(37, LANDSCAPE))).toBeGreaterThan(1.35);
    // And no shorter than it must be: four a row clears the floor at 1112.
    expect(Math.max(...rows.map((row) => row.ratios.length))).toBe(4);
  });

  it('takes three landscapes a row in the column and four in the break-out', () => {
    expect(Math.max(...sizes(repeat(27, LANDSCAPE), COLUMN_WIDTH))).toBe(3);
    expect(Math.max(...sizes(repeat(27, LANDSCAPE), BREAKOUT_WIDTH))).toBe(4);
  });

  it('still admits a lone panorama that is under the floor on its own', () => {
    // A 10:1 strip is 80px tall at 800 — there is no legal row for it but its
    // own, and refusing it would drop the photo.
    const rows = partitionRows([LANDSCAPE, 10, LANDSCAPE], COLUMN_WIDTH);
    expect(rows.flatMap((row) => row.ratios)).toEqual([LANDSCAPE, 10, LANDSCAPE]);
    expect(rows.some((row) => row.ratios.length === 1 && row.ratios[0] === 10)).toBe(true);
  });
});

describe('partitionRows — rows fill the width', () => {
  it('leaves the cap off every row that fits under the square', () => {
    for (const row of partitionRows(repeat(7, LANDSCAPE), BREAKOUT_WIDTH)) expect(row.maxWidthFraction).toBeNull();
    for (const row of partitionRows(repeat(2, LANDSCAPE), BREAKOUT_WIDTH)) expect(row.maxWidthFraction).toBeNull();
  });

  it('caps a lone portrait at the height of the square instead of stretching it', () => {
    const [row] = partitionRows([PORTRAIT], BREAKOUT_WIDTH);
    // Justified it would be 1112 wide and ~1668 tall. Capped it is 741 × 1112.
    expect(row!.maxWidthFraction).toBeCloseTo(PORTRAIT, 5);
    for (const rendered of [BREAKOUT_WIDTH, 950, 780, 640]) {
      const width = row!.maxWidthFraction! * rendered;
      expect(width / PORTRAIT, `at ${rendered}px`).toBeCloseTo(rendered, 5);
    }
  });

  it('accounts for the gaps when capping a multi-photo row', () => {
    // Two slivers taller than they are wide, stacked would be 2 × 4448; side
    // by side 4400 tall — still over the square, so the row is capped.
    const sliver = 0.125;
    const [row] = partitionRows([sliver, sliver], BREAKOUT_WIDTH);
    expect(row!.ratios).toHaveLength(2);
    expect(row!.maxWidthFraction! * BREAKOUT_WIDTH).toBeCloseTo(BREAKOUT_WIDTH * 2 * sliver + ROW_GAP, 5);
  });
});

describe('partitionRows — hostile input', () => {
  it('drops non-finite and non-positive ratios rather than emitting NaN widths', () => {
    const rows = partitionRows([LANDSCAPE, Number.NaN, 0, -2, Number.POSITIVE_INFINITY, LANDSCAPE], BREAKOUT_WIDTH);
    expect(rows.flatMap((row) => row.ratios)).toEqual([LANDSCAPE, LANDSCAPE]);
  });

  it('falls back to the break-out width for a nonsensical container width', () => {
    expect(partitionRows(repeat(7, LANDSCAPE), 0)).toEqual(partitionRows(repeat(7, LANDSCAPE), BREAKOUT_WIDTH));
  });
});
