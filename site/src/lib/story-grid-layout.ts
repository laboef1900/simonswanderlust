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

/** Rendered width in CSS px of a tile spanning `cols` of the locked-width grid. */
export function tileWidth(cols: number): number {
  const track = (MAX_CONTENT - (GRID_COLUMNS - 1) * GAP) / GRID_COLUMNS;
  return Math.round(cols * track + (cols - 1) * GAP);
}

/**
 * `sizes` for a card photo, exact above `CONTENT_LOCKED_AT` and a column
 * fraction below it.
 *
 * @ai-note Cards crop with `object-fit: cover` into a box that is WIDER than
 * it is tall (a 2-column tile is 373×240), so unlike the full-bleed hero the
 * painted width is the box width and a plain width hint is correct here. The
 * hero's hint is not — see the @ai-warning in FeaturedHero.astro.
 */
export function cardSizes(span: StorySpan): string {
  const pct = (cols: number) => Math.round((cols / GRID_COLUMNS) * 100);
  return [
    `(min-width: ${CONTENT_LOCKED_AT}px) ${tileWidth(span.lg)}px`,
    `(min-width: 1024px) ${pct(span.lg)}vw`,
    `(min-width: 640px) ${pct(span.sm)}vw`,
    'calc(100vw - 2.5rem)',
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
