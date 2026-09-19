/**
 * Span plan for the story index mosaic.
 *
 * The grid is SIX columns wide at every breakpoint; what changes is how many
 * columns a card spans (6 = one per row, 3 = two per row, 2 = three per row).
 * Six exists so a remainder of two can be split evenly — three columns cannot
 * do that, and the remainder is the whole reason this module exists.
 *
 * @ai-warning The plan MUST leave no empty cell for ANY count, because the
 * count is "however many stories are published" and it changes every time the
 * author hits Publish. The old grid hardcoded `md:grid-cols-3` with a 2×2 lead
 * tile, which happens to tile exactly at 9, 12, 15 … cards and left a visible
 * 360×240 hole at every other count — the live home page was one of those
 * ("N°01 México" sat beside a gap). Do not reintroduce a fixed column count
 * with a spanning tile; extend `storyGridSpans` and its test instead.
 *
 * @ai-note Nothing here is responsive-by-CSS: the remainder rule depends on how
 * many cards fit a row, which differs per breakpoint, so each regime gets its
 * own span. `gallery-layout.ts` is the precedent for computing layout in TS —
 * same reason (row membership is not expressible as a media query).
 */

/** Columns in the grid. Not configurable — the class lookup in StoryGrid.astro is written out for these spans. */
export const GRID_COLUMNS = 6;

/** Fixed row height in px, and the gap between tracks, used to derive `sizes`. */
const ROW_HEIGHT = 240;
const GAP = 16;

/**
 * Height of a double-height tile, and the width its photograph actually
 * paints there. See the @ai-note on `cardSizes`.
 */
const DOUBLE_ROW_HEIGHT = 2 * ROW_HEIGHT + GAP;
/** Aspect ratio of the landscape hero frames the cards crop (3:2). */
const FRAME_ASPECT = 3 / 2;
const DOUBLE_PAINTED_WIDTH = Math.round(DOUBLE_ROW_HEIGHT * FRAME_ASPECT);

/** Widest the grid's content box gets (`max-w-6xl` minus the section's `px-5`). */
const MAX_CONTENT = 1152;
/** Viewport width at which the content box stops growing. */
const CONTENT_LOCKED_AT = MAX_CONTENT + 2 * 20;

export interface StorySpan {
  /** Columns spanned from the `sm` breakpoint up (two cards per row). */
  sm: 3 | 6;
  /** Columns spanned from the `lg` breakpoint up. */
  lg: 2 | 3 | 4 | 6;
  /** Row spanned at `lg`; only the lead tile is ever 2. */
  lgRows: 1 | 2;
}

/**
 * Per-card spans for `count` cards, in render order.
 *
 * Layout at `lg`, for four or more cards: a 4×2 lead tile fills the left of
 * the first two rows with one card stacked beside it in each, then three cards
 * per row. The tail is levelled so the last row is always full — one leftover
 * becomes a full-width band, two leftovers split the row in half.
 */
export function storyGridSpans(count: number): StorySpan[] {
  if (count <= 0) return [];
  const spans = count < 4 ? leadOnly(count) : mosaic(count);
  // Two cards per row from `sm` up, so an odd count leaves the last one alone
  // in its row. Widening it is the same levelling the `lg` tail does, and it
  // MUST run for every count — the small-count plans below are not exempt
  // (three cards at `sm` are 3+3 then a lone 3, i.e. a half-empty last row).
  if (count % 2 === 1) {
    const last = spans[count - 1];
    if (last) last.sm = 6;
  }
  return spans;
}

/** Fewer cards than the lead tile's own footprint needs; just fill the rows. */
function leadOnly(count: number): StorySpan[] {
  if (count === 1) return [{ sm: 6, lg: 6, lgRows: 2 }];
  if (count === 2) return [
    { sm: 3, lg: 3, lgRows: 2 },
    { sm: 3, lg: 3, lgRows: 2 },
  ];
  return [
    { sm: 3, lg: 2, lgRows: 1 },
    { sm: 3, lg: 2, lgRows: 1 },
    { sm: 3, lg: 2, lgRows: 1 },
  ];
}

function mosaic(count: number): StorySpan[] {
  const spans: StorySpan[] = [
    { sm: 3, lg: 4, lgRows: 2 },
    { sm: 3, lg: 2, lgRows: 1 },
    { sm: 3, lg: 2, lgRows: 1 },
  ];
  // The lead tile plus its two neighbours occupy the first two rows exactly,
  // so the tail below starts on a fresh row and levels independently.
  const tail = count - 3;
  const remainder = tail % 3;
  for (let i = 0; i < tail; i++) {
    const fromEnd = tail - i;
    if (remainder === 1 && fromEnd === 1) spans.push({ sm: 3, lg: 6, lgRows: 1 });
    else if (remainder === 2 && fromEnd <= 2) spans.push({ sm: 3, lg: 3, lgRows: 1 });
    else spans.push({ sm: 3, lg: 2, lgRows: 1 });
  }
  return spans;
}

/**
 * Hands the 4×2 lead tile to the SECOND story when the homepage cover is the
 * first one, and returns the plan otherwise unchanged.
 *
 * @ai-note Why: the homepage renders its cover story TWICE — once as
 * `FeaturedHero` and once as a card, because the grid must contain every
 * story for the count beside its heading to be true by construction (see the
 * @ai-warning in HomePage.astro). With the cover also holding the lead tile,
 * the same photograph was painted at 1440×585 and again at 736×496 inside
 * 1.4 viewports, and the `<h1>` string was repeated verbatim by the first
 * `<h3>`: 8 `.avif` references to one story in the served HTML against 2 for
 * every other. Demoting it to a small tile keeps the story in the grid and
 * gives the lead slot to a photograph the visitor has not seen yet.
 *
 * @ai-warning Swapping two entries is the ONLY safe way to do this, because it
 * preserves the span multiset and therefore the module's no-empty-cell
 * invariant at every count — never shrink or drop a span here. The hole the
 * swap opens in the first row is filled by CSS grid's own sparse
 * auto-placement: a 2-column card, then the 4-column/2-row lead, then the
 * next 2-column card drops back into row 2, columns 1–2.
 *
 * A cover flagged further down the list (`coverIndex > 0`) needs no swap: the
 * lead tile already belongs to a different story, and the cover simply appears
 * as a small tile. Several stories MAY carry the flag — see `content.config.ts`
 * — so `coverIndex` is just "wherever the chosen one happens to sit".
 *
 * @ai-warning Below three cards there is no sibling to hand the tall tile to,
 * and the old code simply gave up and returned the plan — so a site with one
 * or two published trips painted its cover as the 65vh hero AND as a
 * double-height tile immediately below, which is the exact failure this
 * function exists to prevent, surviving in the only case it was never
 * exercised on. Levelling EVERY tile to one row is the safe answer at those
 * counts and only those: one card fills its row alone, two fill one row
 * together, so no cell is opened either way. Levelling just the cover's tile
 * would leave its neighbour two rows tall beside a one-row gap.
 */
export function demoteCover(spans: StorySpan[], coverIndex: number): StorySpan[] {
  if (coverIndex < 0 || coverIndex >= spans.length) return spans;
  if (spans.length < 3) return spans.map((span) => ({ ...span, lgRows: 1 }));
  if (coverIndex !== 0) return spans;
  const swapped = [...spans];
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  return swapped;
}

/** Rendered width in CSS px of a tile spanning `cols` of the locked-width grid. */
export function tileWidth(cols: number): number {
  const track = (MAX_CONTENT - (GRID_COLUMNS - 1) * GAP) / GRID_COLUMNS;
  return Math.round(cols * track + (cols - 1) * GAP);
}

/**
 * `sizes` for a card photo, exact above `CONTENT_LOCKED_AT` and a column
 * fraction below it.
 *
 * @ai-note Single-height cards crop with `object-fit: cover` into a box that
 * is WIDER than it is tall (a 2-column tile is 373×240), so unlike the
 * full-bleed hero the painted width is the box width and a plain width hint is
 * correct for them. A DOUBLE-height card is the hero's trap in miniature: in
 * the base regime it is one column wide (≈350px) and two rows tall
 * (2 × 240 + 16 = 496), so a 3:2 frame under `cover` scales by HEIGHT and
 * paints 496 × 1.5 ≈ 744px while `100vw` claims 350 — the candidate picker
 * would ship an upscaled artifact for the largest tile on a phone. Only the
 * base entry needs the correction: at `sm` the tile is reset to one row
 * (StoryGrid's `sm:row-span-1`), and at `lg` it is 763px wide against the same
 * 496 height, so width leads again. See the @ai-warning in FeaturedHero.astro
 * for the measured version of the same mistake.
 */
export function cardSizes(span: StorySpan): string {
  const pct = (cols: number) => Math.round((cols / GRID_COLUMNS) * 100);
  const base =
    span.lgRows === 2
      ? `max(calc(100vw - 2.5rem), ${DOUBLE_PAINTED_WIDTH}px)`
      : 'calc(100vw - 2.5rem)';
  return [
    `(min-width: ${CONTENT_LOCKED_AT}px) ${tileWidth(span.lg)}px`,
    `(min-width: 1024px) ${pct(span.lg)}vw`,
    `(min-width: 640px) ${pct(span.sm)}vw`,
    base,
  ].join(', ');
}

/**
 * Cells a plan occupies per regime, including any row a spanning tile reaches
 * into. Exists so the test can assert the plan tiles exactly; the renderer
 * does not need it.
 */
export function cellsUsed(spans: StorySpan[]): { sm: number; lg: number } {
  return {
    sm: spans.reduce((n, s) => n + s.sm, 0),
    lg: spans.reduce((n, s) => n + s.lg * s.lgRows, 0),
  };
}

/** Row height in px — exported so StoryGrid and its test cannot drift. */
export const GRID_ROW_HEIGHT = ROW_HEIGHT;
