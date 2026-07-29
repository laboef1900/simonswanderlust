import { describe, expect, it } from 'vitest';
import {
  BREAKOUT_WIDTH,
  COLUMN_WIDTH,
  GALLERY_MODES,
  MAX_LAST_ROW_HEIGHT,
  ROW_GAP,
  TARGET_ROW_HEIGHT,
  containerWidthFor,
  partitionRows,
  readLayoutMode,
} from './gallery-layout.js';

const LANDSCAPE = 3000 / 2000; // 1.5
const PORTRAIT = 2000 / 3000; // 0.667
const PANORAMA = 4; // a 4:1 strip

/** The rendered height of a row justified to fill `width`. */
const rowHeight = (ratios: number[], width: number) =>
  (width - (ratios.length - 1) * ROW_GAP) / ratios.reduce((a, r) => a + r, 0);

/** Row sizes, the shape most assertions care about. */
const sizes = (ratios: number[], width = BREAKOUT_WIDTH) =>
  partitionRows(ratios, width).map((row) => row.ratios.length);

const repeat = (n: number, r: number) => Array.from({ length: n }, () => r);

describe('readLayoutMode', () => {
  it('defaults to breakout when the fence carries no directive', () => {
    expect(readLayoutMode('https://img/a\nhttps://img/b')).toBe('breakout');
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
  it('falls back to breakout on an unknown, empty or malformed value', () => {
    expect(readLayoutMode('#layout: carousel')).toBe('breakout');
    expect(readLayoutMode('#layout:')).toBe('breakout');
    expect(readLayoutMode('#layout')).toBe('breakout');
    expect(readLayoutMode('#layout: slider extra')).toBe('breakout');
    expect(readLayoutMode('')).toBe('breakout');
  });

  it('ignores a directive-looking string that is not a whole line', () => {
    expect(readLayoutMode('https://img/a | alt="#layout: slider"')).toBe('breakout');
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

  it('keeps two and three landscapes on one row in the break-out width', () => {
    expect(sizes(repeat(2, LANDSCAPE))).toEqual([2]);
    expect(sizes(repeat(3, LANDSCAPE))).toEqual([3]);
  });

  it('breaks seven landscapes into full rows plus a remainder', () => {
    expect(sizes(repeat(7, LANDSCAPE))).toEqual([3, 3, 1]);
  });

  it('breaks thirteen landscapes the same way, all the way down', () => {
    const rows = sizes(repeat(13, LANDSCAPE));
    expect(rows).toEqual([3, 3, 3, 3, 1]);
    expect(rows.reduce((a, n) => a + n, 0)).toBe(13);
  });

  it('fits more portraits per row than landscapes', () => {
    // Five portraits are narrow enough to justify as one row.
    expect(sizes(repeat(5, PORTRAIT))).toEqual([5]);
  });

  it('gives a lone panorama its own row rather than squashing a mixed row', () => {
    expect(sizes([PANORAMA, LANDSCAPE, LANDSCAPE])).toEqual([1, 2]);
  });

  it('handles a panorama in the middle of a mix', () => {
    const rows = partitionRows([LANDSCAPE, LANDSCAPE, PANORAMA, PORTRAIT, LANDSCAPE], BREAKOUT_WIDTH);
    expect(rows.flatMap((row) => row.ratios)).toEqual([
      LANDSCAPE, LANDSCAPE, PANORAMA, PORTRAIT, LANDSCAPE,
    ]);
    // The panorama must not share a row with the two landscapes before it —
    // that row would be far shorter than the target.
    expect(rows[0]?.ratios).toEqual([LANDSCAPE, LANDSCAPE]);
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

  it('packs fewer photos per row in the narrower column width', () => {
    expect(sizes(repeat(6, LANDSCAPE), COLUMN_WIDTH)).toEqual([2, 2, 2]);
  });
});

describe('partitionRows — row heights', () => {
  it('keeps every full row within a sane band around the target height', () => {
    const rows = partitionRows(repeat(13, LANDSCAPE), BREAKOUT_WIDTH);
    // The last row is capped, not justified — it is asserted separately below.
    for (const row of rows.slice(0, -1)) {
      const h = rowHeight(row.ratios, BREAKOUT_WIDTH);
      expect(h).toBeGreaterThan(TARGET_ROW_HEIGHT * 0.5);
      expect(h).toBeLessThan(TARGET_ROW_HEIGHT * 1.5);
    }
  });

  it('never chooses a partition that a different break would bring closer to target', () => {
    // A row is closed only when adding the next photo would move its height
    // FURTHER from the target — the greedy invariant, stated as a property.
    const mix = [LANDSCAPE, PORTRAIT, PANORAMA, LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE];
    const rows = partitionRows(mix, BREAKOUT_WIDTH);
    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows[i]!.ratios;
      const next = rows[i + 1]!.ratios[0]!;
      const asIs = Math.abs(rowHeight(row, BREAKOUT_WIDTH) - TARGET_ROW_HEIGHT);
      const extended = Math.abs(rowHeight([...row, next], BREAKOUT_WIDTH) - TARGET_ROW_HEIGHT);
      expect(extended).toBeGreaterThan(asIs);
    }
  });
});

describe('partitionRows — the last row is capped, not stretched', () => {
  it('caps a lone portrait instead of blowing it up to the full width', () => {
    const [row] = partitionRows([PORTRAIT], BREAKOUT_WIDTH);
    // Justified it would be 1112 wide and ~1668 tall. Capped it is ~300×450.
    expect(row?.maxWidth).toBeCloseTo(MAX_LAST_ROW_HEIGHT * PORTRAIT, 5);
  });

  it('caps a lone landscape remainder row', () => {
    const rows = partitionRows(repeat(7, LANDSCAPE), BREAKOUT_WIDTH);
    const last = rows[rows.length - 1];
    expect(last?.ratios).toEqual([LANDSCAPE]);
    expect(last?.maxWidth).toBeCloseTo(MAX_LAST_ROW_HEIGHT * LANDSCAPE, 5);
  });

  it('leaves the cap off when it would not bind — the row fills the width', () => {
    // Three landscapes justify to ~242px tall, well under the cap, so a
    // max-width would only get in the way.
    const [row] = partitionRows(repeat(3, LANDSCAPE), BREAKOUT_WIDTH);
    expect(row?.maxWidth).toBeNull();
  });

  it('never caps a row that is not the last one', () => {
    const rows = partitionRows(repeat(7, LANDSCAPE), BREAKOUT_WIDTH);
    for (const row of rows.slice(0, -1)) expect(row.maxWidth).toBeNull();
  });

  it('accounts for the gaps when capping a multi-photo last row', () => {
    const rows = partitionRows([...repeat(3, LANDSCAPE), PORTRAIT, PORTRAIT], BREAKOUT_WIDTH);
    const last = rows[rows.length - 1]!;
    expect(last.ratios.length).toBeGreaterThan(1);
    const sum = last.ratios.reduce((a, r) => a + r, 0);
    expect(last.maxWidth).toBeCloseTo(MAX_LAST_ROW_HEIGHT * sum + (last.ratios.length - 1) * ROW_GAP, 5);
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
