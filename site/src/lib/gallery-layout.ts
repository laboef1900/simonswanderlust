/**
 * Justified-row geometry and the `#layout:` directive reader for ```gallery
 * fences.
 *
 * @ai-context docs/superpowers/specs/2026-07-29-gallery-layout-modes-and-lightbox-design.md
 *
 * @ai-warning This module runs in TWO runtimes. `uploader/src/preview.ts`
 * imports `transformBodyImages` cross-tree, so everything here also executes
 * under the uploader's `tsx` runtime, where `import.meta.env` and every
 * `astro:*` module are absent. Keep it pure, dependency-free and env-free, or
 * `GET /posts/:tk/preview` breaks — and it breaks at request time in the admin,
 * not at build time where a test would catch it.
 */

/** The layout modes a gallery may select with a `#layout:` directive. */
export const GALLERY_MODES = ['breakout', 'column', 'slider'] as const;
export type GalleryMode = (typeof GALLERY_MODES)[number];

/** Applied when the directive is absent, unknown or malformed. */
export const DEFAULT_GALLERY_MODE: GalleryMode = 'breakout';

/**
 * Full-bleed break-out width, in CSS px. Derived, not chosen: `StoryPage.astro`
 * renders `<Content />` inside `mx-auto max-w-3xl px-5` → 768 − 40 = 728, and
 * 728 + 24rem = 1112 exactly.
 */
export const BREAKOUT_WIDTH = 1112;

/** The story column itself — `column` mode aligns galleries with body text. */
export const COLUMN_WIDTH = 728;

/** Gap between photos, in CSS px. MUST match the `gap` in global.css. */
export const ROW_GAP = 12;

/** The row height the partition aims for, in CSS px. */
export const TARGET_ROW_HEIGHT = 300;

/**
 * Ceiling for the last row's height when there is NO row above it to match —
 * a gallery that fits on one line.
 *
 * A short final row must not be stretched to the container width: a lone
 * portrait would render 1112 wide and ~1668 tall, taller than most viewports.
 * But a two-landscape gallery justifies to a comfortable ~367 and should fill
 * the width, so the bound is 1.5 × the target rather than the target itself.
 *
 * @ai-note When the gallery HAS more than one row, this constant does not
 * apply — the last row is capped at the height of the row above it instead
 * (see partitionRows). That is what makes a remainder read as a partial row
 * rather than an oversized finale, and it is why the cap has to be recomputed
 * per gallery rather than being one number.
 */
export const MAX_LAST_ROW_HEIGHT = TARGET_ROW_HEIGHT * 1.5;

/** One justified row: the photos' aspect ratios, in order, plus its width cap. */
export interface GalleryRow {
  /** `width / height` per photo, in document order. */
  ratios: number[];
  /**
   * Upper bound on the row's width as a FRACTION of the container (0–1), or
   * `null` when the row should always fill it.
   *
   * Only ever set on the last row. A fraction rather than a pixel value on
   * purpose: the row above it also scales with the container, so a px cap
   * computed at the design width would drift out of step everywhere else — a
   * remainder capped at 363px sat 242px tall next to 167px rows on a tablet.
   */
  maxWidthFraction: number | null;
}

const MODES = new Set<string>(GALLERY_MODES);

/**
 * A whole line reading `#layout: <mode>`. Deliberately anchored and
 * whole-line: a `#layout:` sequence inside an `alt="…"` value is content, not
 * a directive.
 */
const LAYOUT_DIRECTIVE_RE = /^\s*#\s*layout\s*:\s*(\S*)\s*$/i;

/**
 * The layout mode a fence selects, defaulting to `breakout`.
 *
 * The directive lives INSIDE the fence rather than on its opener because an
 * info-string argument is unimplementable here: ```` ```gallery layout=slider ````
 * and a plain ```` ```gallery ```` render to byte-identical HTML — the info
 * string is discarded before `body-images.ts` ever sees it. Both sides already
 * tolerate a `#`-prefixed line (`isSkippableLine` in the uploader's
 * `body-content.ts`, and `galleryNode`'s own skip), so the directive needed no
 * new syntax, only this reader.
 *
 * The first `#layout:` line wins, so a stray duplicate cannot silently override
 * the author's choice.
 */
export function readLayoutMode(fenceText: string): GalleryMode {
  for (const line of String(fenceText ?? '').split('\n')) {
    const m = LAYOUT_DIRECTIVE_RE.exec(line);
    if (!m) continue;
    const value = (m[1] ?? '').toLowerCase();
    return MODES.has(value) ? (value as GalleryMode) : DEFAULT_GALLERY_MODE;
  }
  return DEFAULT_GALLERY_MODE;
}

/** The container a justified mode partitions against. `slider` never partitions. */
export function containerWidthFor(mode: Exclude<GalleryMode, 'slider'>): number {
  return mode === 'column' ? COLUMN_WIDTH : BREAKOUT_WIDTH;
}

/** Height of a row of `ratios` justified to fill `width`. */
function heightAt(ratios: readonly number[], width: number): number {
  const sum = ratios.reduce((a, r) => a + r, 0);
  return (width - (ratios.length - 1) * ROW_GAP) / sum;
}

/**
 * Partition photos into justified rows.
 *
 * Greedy, and the invariant is worth stating because the tests assert it as a
 * property: a row is closed only when adding the next photo would move the
 * row's height FURTHER from the target than leaving it out does.
 *
 * @ai-note Row MEMBERSHIP is fixed here, at build time, for `containerWidth`.
 * Only the justification WITHIN a row is fluid (the emitted ratios let the
 * browser redo that arithmetic at any width). Between ~600px and the design
 * width the same rows simply get shorter; below that the CSS container query
 * stacks them. This is an accepted trade-off, not a solved problem — do not
 * read the ratio emission as making the whole layout responsive.
 */
export function partitionRows(ratios: readonly number[], containerWidth: number): GalleryRow[] {
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : BREAKOUT_WIDTH;
  // The caller validates dimensions before it gets here; this is the second
  // line of defence, because a NaN ratio would propagate silently into a
  // `max-width` and collapse the row to nothing.
  const usable = [...ratios].filter((r) => Number.isFinite(r) && r > 0);
  if (usable.length === 0) return [];

  const rows: number[][] = [];
  let row: number[] = [];
  for (const r of usable) {
    if (row.length === 0) {
      row.push(r);
      continue;
    }
    const asIs = Math.abs(heightAt(row, width) - TARGET_ROW_HEIGHT);
    const extended = Math.abs(heightAt([...row, r], width) - TARGET_ROW_HEIGHT);
    if (extended > asIs) {
      rows.push(row);
      row = [r];
    } else {
      row.push(r);
    }
  }
  rows.push(row);

  return rows.map((ratiosInRow, i) => {
    if (i !== rows.length - 1) return { ratios: ratiosInRow, maxWidthFraction: null };
    // Match the row above, so a remainder reads as a partial row instead of an
    // oversized finale — at every viewport width, since that row's height and
    // this cap scale together. With no row above, fall back to the constant.
    const previous = rows[i - 1];
    const capHeight = previous ? heightAt(previous, width) : MAX_LAST_ROW_HEIGHT;
    const sum = ratiosInRow.reduce((a, x) => a + x, 0);
    const capped = capHeight * sum + (ratiosInRow.length - 1) * ROW_GAP;
    // A cap at or above the container never binds — omitting it keeps the
    // emitted style attribute (and the DOM) free of noise.
    return { ratios: ratiosInRow, maxWidthFraction: capped < width ? capped / width : null };
  });
}
