import { describe, expect, it } from 'vitest';
import {
  cardSizes,
  cellsUsed,
  demoteCover,
  GRID_COLUMNS,
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

  it('keeps tiles close to the 3:2 frames they crop', () => {
    // Every tile is 240px tall per row; the lead spans two rows plus the gap.
    for (const [cols, rows] of [
      [2, 1],
      [3, 1],
      [4, 2],
      [6, 1],
    ] as const) {
      const height = rows * 240 + (rows - 1) * 16;
      const aspect = tileWidth(cols) / height;
      expect(aspect, `${cols}x${rows} tile`).toBeGreaterThan(1.3);
      expect(aspect, `${cols}x${rows} tile`).toBeLessThan(5);
    }
  });
});

describe('cardSizes', () => {
  it('states an exact pixel width once the grid stops growing', () => {
    const sizes = cardSizes({ sm: 3, lg: 2, lgRows: 1 });
    expect(sizes).toContain('(min-width: 1192px) 373px');
    expect(sizes).toContain('(min-width: 1024px) 33vw');
    expect(sizes).toContain('(min-width: 640px) 50vw');
    expect(sizes.endsWith('calc(100vw - 2.5rem)')).toBe(true);
  });

  it('scales the hint with the span', () => {
    expect(cardSizes({ sm: 3, lg: 4, lgRows: 2 })).toContain('(min-width: 1024px) 67vw');
    expect(cardSizes({ sm: 6, lg: 6, lgRows: 1 })).toContain('(min-width: 640px) 100vw');
  });

  it('corrects the base hint for a double-height tile, which crops by height', () => {
    // Base regime: one column wide (~350px) but 2 × 240 + 16 = 496 tall, so a
    // 3:2 frame under `object-fit: cover` paints 496 × 1.5 = 744px. A plain
    // `100vw` claimed 350 and shipped an upscaled artifact.
    const lead = cardSizes({ sm: 3, lg: 4, lgRows: 2 });
    expect(lead.endsWith('max(calc(100vw - 2.5rem), 744px)')).toBe(true);
    // Single-height cards are wider than tall, so the box width is the hint.
    expect(cardSizes({ sm: 3, lg: 2, lgRows: 1 }).endsWith('calc(100vw - 2.5rem)')).toBe(true);
    // Only the base entry changes; `sm` resets the tile to one row and `lg`
    // makes it 763px wide against the same 496.
    expect(lead).toContain('(min-width: 640px) 50vw');
    expect(lead).toContain('(min-width: 1192px) 763px');
  });
});
