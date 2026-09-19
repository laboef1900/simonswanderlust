import { describe, expect, it } from 'vitest';
import {
  cardSizes,
  cellsUsed,
  demoteCover,
  GRID_COLUMNS,
  GRID_ROW_HEIGHT,
  storyGridSpans,
  tileWidth,
  type StorySpan,
} from './story-grid-layout';

/**
 * The one invariant worth a permanent test: the plan must tile exactly, at
 * every count and in both multi-column regimes. The bug this defends against
 * shipped — a fixed three-column grid with a 2×2 lead tile left a visible
 * 360×240 hole at the end of the live home page's story grid, and would do so
 * again at 10, 11, 13 … cards. Anything that changes the span arithmetic and
 * forgets a remainder fails here.
 */
describe('storyGridSpans', () => {
  it('has no plan for an empty set', () => {
    expect(storyGridSpans(0)).toEqual([]);
    expect(storyGridSpans(-3)).toEqual([]);
  });

  it('emits one span per card', () => {
    for (let n = 1; n <= 40; n++) expect(storyGridSpans(n)).toHaveLength(n);
  });

  it('fills every row completely at both breakpoints, for every count', () => {
    for (let n = 1; n <= 60; n++) {
      const used = cellsUsed(storyGridSpans(n));
      expect(used.sm % GRID_COLUMNS, `sm regime leaves a hole at ${n} cards`).toBe(0);
      expect(used.lg % GRID_COLUMNS, `lg regime leaves a hole at ${n} cards`).toBe(0);
      // Same invariant AFTER the homepage demotes its cover story — the swap
      // must not be able to open a cell the renderer cannot fill.
      const demoted = cellsUsed(demoteCover(storyGridSpans(n), 0));
      expect(demoted.sm % GRID_COLUMNS, `swapped sm regime leaves a hole at ${n}`).toBe(0);
      expect(demoted.lg % GRID_COLUMNS, `swapped lg regime leaves a hole at ${n}`).toBe(0);
    }
  });

  it('never spans more columns than the grid has', () => {
    for (let n = 1; n <= 40; n++) {
      for (const s of storyGridSpans(n)) {
        expect(s.lg).toBeLessThanOrEqual(GRID_COLUMNS);
        expect(s.sm).toBeLessThanOrEqual(GRID_COLUMNS);
      }
    }
  });

  it('gives the lead story a double-height tile once there are enough cards to wrap it', () => {
    const lead = (n: number) => storyGridSpans(n)[0] as StorySpan;
    expect(lead(9)).toEqual({ sm: 3, lg: 4, lgRows: 2 });
    // Below four cards a 4×2 lead cannot be wrapped without a hole, so the
    // plan drops it rather than emit a gap.
    expect(lead(3)?.lgRows).toBe(1);
  });

  it('levels the tail: one leftover becomes a band, two split the row', () => {
    // 9 = 3 in the lead block + 6, an exact pair of rows: no levelling needed.
    expect(storyGridSpans(9).slice(3).map((s) => s.lg)).toEqual([2, 2, 2, 2, 2, 2]);
    // 10 leaves one card alone.
    expect(storyGridSpans(10).slice(3).map((s) => s.lg)).toEqual([2, 2, 2, 2, 2, 2, 6]);
    // 11 leaves two.
    expect(storyGridSpans(11).slice(3).map((s) => s.lg)).toEqual([2, 2, 2, 2, 2, 2, 3, 3]);
  });

  it('widens the odd card out at sm so its row is not half empty', () => {
    expect(storyGridSpans(9).map((s) => s.sm)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 6]);
    expect(storyGridSpans(8).map((s) => s.sm)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    // Small counts are not exempt — three cards at sm used to be 3+3+3.
    expect(storyGridSpans(3).map((s) => s.sm)).toEqual([3, 3, 6]);
  });

  it('returns independent objects so widening one card cannot affect another', () => {
    const spans = storyGridSpans(3);
    expect(spans[0]).not.toBe(spans[1]);
    expect(spans[0]?.sm).toBe(3);
  });
});

/**
 * The homepage shows its cover story twice — once as the hero, once as a card
 * — so the cover must not also hold the 4×2 lead tile. The swap is the only
 * mechanism that can do that without touching the span multiset the
 * no-empty-cell invariant above depends on.
 */
describe('demoteCover', () => {
  const isLead = (s: StorySpan | undefined) => s?.lgRows === 2 && s.lg >= 4;

  it('moves the lead tile off the cover when the cover is the newest story', () => {
    for (const n of [4, 5, 7, 9, 10, 11, 20]) {
      const plan = demoteCover(storyGridSpans(n), 0);
      expect(isLead(plan[0]), `${n} cards: index 0 still holds the lead tile`).toBe(false);
      expect(isLead(plan[1]), `${n} cards: the second story should lead`).toBe(true);
    }
  });

  it('leaves the plan alone when the flagged cover is not the first story', () => {
    const plan = storyGridSpans(9);
    expect(demoteCover(plan, 3)).toEqual(plan);
    // Nothing to promote past: the lead stays at index 0 and the cover is a
    // small tile wherever it sits.
    expect(isLead(demoteCover(plan, 3)[0])).toBe(true);
  });

  it('levels every tile when the count is too small to hand the lead tile on', () => {
    // The old contract here was "return the plan unchanged", which is how a
    // one- or two-trip site ended up painting its cover as the hero AND as a
    // double-height tile directly below it.
    for (const n of [1, 2]) {
      const plan = demoteCover(storyGridSpans(n), 0);
      expect(plan.every((s) => s.lgRows === 1), `${n} cards: a tile is still two rows tall`).toBe(true);
      expect(plan.map((s) => s.lg)).toEqual(storyGridSpans(n).map((s) => s.lg));
    }
    // Three cards already carry no lead tile, so the swap is a no-op.
    expect(demoteCover(storyGridSpans(3), 0)).toEqual(storyGridSpans(3));
  });

  it('leaves the plan alone when no story is flagged as the cover', () => {
    for (const n of [1, 2, 9]) {
      expect(demoteCover(storyGridSpans(n), -1)).toEqual(storyGridSpans(n));
    }
  });

  it('preserves the span multiset, which is what keeps the grid gapless', () => {
    const plan = storyGridSpans(12);
    const key = (s: StorySpan) => `${s.sm}/${s.lg}/${s.lgRows}`;
    expect(demoteCover(plan, 0).map(key).sort()).toEqual(plan.map(key).sort());
  });

  it('does not mutate the plan it was given', () => {
    const plan = storyGridSpans(9);
    demoteCover(plan, 0);
    expect(isLead(plan[0])).toBe(true);
  });
});

describe('tileWidth', () => {
  it('measures a span against the locked-width grid', () => {
    // 6 columns of 178.67 plus 5 gaps of 16 = the 1152px content box.
    expect(tileWidth(6)).toBe(1152);
    expect(tileWidth(2)).toBe(373);
    expect(tileWidth(4)).toBe(763);
  });

  it('keeps tiles within a sane crop of the 3:2 frames they hold', () => {
    for (const [cols, rows] of [
      [2, 1],
      [3, 1],
      [4, 2],
      [6, 1],
    ] as const) {
      const height = rows * GRID_ROW_HEIGHT + (rows - 1) * 16;
      const aspect = tileWidth(cols) / height;
      // Below 1.5 the tile is TALLER than the frame it crops, so `cover`
      // scales by height — legal, and exactly why `cardSizes` corrects every
      // regime. Below 1.0 it would be a portrait box holding a landscape
      // photograph, which crops away most of the frame.
      expect(aspect, `${cols}x${rows} tile`).toBeGreaterThan(1);
      expect(aspect, `${cols}x${rows} tile`).toBeLessThan(5);
    }
  });
});

describe('cardSizes', () => {
  /*
   * @ai-warning Every entry is `max(box, painted)` because a 3:2 frame under
   * `object-fit: cover` paints `max(boxWidth, boxHeight × 1.5)`. At a 280px
   * row that second term wins on most of the grid: 420px for one row, 864px
   * for two.
   */
  it('hints the painted width, not the box width, in every regime', () => {
    const sizes = cardSizes({ sm: 3, lg: 2, lgRows: 1 });
    // 373px box, 420px paint.
    expect(sizes).toContain('(min-width: 1192px) max(373px, 420px)');
    expect(sizes).toContain('(min-width: 1024px) max(33vw, 420px)');
    expect(sizes).toContain('(min-width: 640px) max(50vw, 420px)');
    expect(sizes.endsWith('max(calc(100vw - 2.5rem), 420px)')).toBe(true);
  });

  it('scales the hint with the span', () => {
    expect(cardSizes({ sm: 3, lg: 4, lgRows: 2 })).toContain('(min-width: 1024px) max(67vw, 864px)');
    expect(cardSizes({ sm: 6, lg: 6, lgRows: 1 })).toContain('(min-width: 640px) max(100vw, 420px)');
  });

  it('corrects a double-height tile at lg, which a 240px row did not need', () => {
    // 763px wide against 2 × 280 + 16 = 576 tall: aspect 1.32, so the frame
    // paints 576 × 1.5 = 864. At the old 240px row the same tile was 763×496
    // and width led, which is why this entry used to be a bare pixel width.
    expect(cardSizes({ sm: 3, lg: 4, lgRows: 2 })).toContain('(min-width: 1192px) max(763px, 864px)');
  });

  it('takes the base regime\u2019s row count from the caller, not from the span', () => {
    // Below `sm` every card is full-width and StoryGrid picks the tall ones by
    // index, so the span cannot say. A tall tile paints 864px against a ~350px
    // box; hinting 420 there would ship an upscaled artifact for the largest
    // photograph on a phone.
    const span = { sm: 3, lg: 2, lgRows: 1 } as const;
    expect(cardSizes(span, true).endsWith('max(calc(100vw - 2.5rem), 864px)')).toBe(true);
    expect(cardSizes(span, false).endsWith('max(calc(100vw - 2.5rem), 420px)')).toBe(true);
    // `sm` resets every tile to one row regardless.
    expect(cardSizes(span, true)).toContain('(min-width: 640px) max(50vw, 420px)');
  });
});
