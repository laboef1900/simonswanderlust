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
export const GALLERY_MODES = ['column', 'breakout', 'slider'] as const;
export type GalleryMode = (typeof GALLERY_MODES)[number];

/**
 * Applied when the directive is absent, unknown or malformed.
 *
 * @ai-note `column` since 2026-09-20 (it was `breakout` from #66 until then):
 * galleries align with the text column by default, as they did on the
 * WordPress site. The picker writes no directive for the default, so every
 * fence authored without one flips with this constant — that is the intent.
 * A gallery that should stay wide carries an explicit `#layout: breakout`.
 */
export const DEFAULT_GALLERY_MODE: GalleryMode = 'column';

/**
 * Full-bleed break-out width, in CSS px. Derived, not chosen: `StoryPage.astro`
 * renders the story inside `mx-auto max-w-3xl px-5` → 768 − 40 = 728, and
 * 728 + 24rem = 1112 exactly — the site's content box.
 */
export const BREAKOUT_WIDTH = 1112;

/**
 * The design width a `column` gallery is partitioned and source-hinted for:
 * the centred story body below the opening spread (`--container-story-wide`,
 * 800px). In the 728px reading column beside the rail the same rows simply
 * render a tenth narrower — the partition is scale-invariant bar the 12px
 * gap, and a `sizes` hint sized for the wider of the two never under-fetches.
 */
export const COLUMN_WIDTH = 800;

/** Gap between photos, in CSS px. MUST match the `gap` in global.css. */
export const ROW_GAP = 12;

/**
 * The shortest a row of two or more photos may be at the design width, in CSS
 * px. The square rule alone would cut a 37-photo gallery into 134px-tall
 * rows — a contact sheet — so a row is only admitted when it clears this, and
 * a big gallery grows taller than it is wide instead. At 168 the column
 * (800) takes three landscapes a row (172px) and the break-out (1112) four
 * (179px); a lone photo in its own row is always admitted, or a panorama
 * could have no legal partition at all.
 */
export const MIN_ROW_HEIGHT = 168;

/** One justified row: the photos' aspect ratios, in order, plus its width cap. */
export interface GalleryRow {
  /** `width / height` per photo, in document order. */
  ratios: number[];
  /**
   * Upper bound on the row's width as a FRACTION of the container (0–1), or
   * `null` when the row fills it — which every row does, except one that
   * would otherwise stand taller than the container is wide (a lone portrait:
   * justified to 1112 wide it is ~1668 tall). Such a row is capped at the
   * square's own height, so the gallery never leaves the square it aims for.
   *
   * A fraction rather than a pixel value on purpose: the container scales,
   * and a px cap computed at the design width drifts out of step everywhere
   * else — a remainder capped at 363px sat 242px tall next to 167px rows on
   * a tablet, back when the last row was capped to match the row above it.
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
 * The layout mode a fence selects, defaulting to `DEFAULT_GALLERY_MODE`.
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
export function rowHeightAt(ratios: readonly number[], width: number): number {
  const sum = ratios.reduce((a, r) => a + r, 0);
  return (width - (ratios.length - 1) * ROW_GAP) / sum;
}

/** Rendered height of a whole gallery of `rows` at `width`, gaps included. */
export function galleryHeightAt(rows: readonly (readonly number[])[], width: number): number {
  return rows.reduce((a, row) => a + rowHeightAt(row, width), 0) + (rows.length - 1) * ROW_GAP;
}

/**
 * The partition of `ratios` into exactly `k` contiguous rows whose heights are
 * the most even — the one minimising Σ (height − target)², where `target` is
 * the height `k` equal rows would need to stack to a square — or `null` when
 * every such partition has a multi-photo row under MIN_ROW_HEIGHT. Dynamic
 * programming over the row boundaries; O(k · n²).
 */
function evenestRows(ratios: readonly number[], width: number, k: number): number[][] | null {
  const n = ratios.length;
  const target = (width - (k - 1) * ROW_GAP) / k;
  const prefix = [0];
  for (const r of ratios) prefix.push(prefix[prefix.length - 1]! + r);
  // Cost of the row holding photos [from, to); infinite when it is too short.
  const cost = (from: number, to: number) => {
    const h = (width - (to - from - 1) * ROW_GAP) / (prefix[to]! - prefix[from]!);
    return to - from > 1 && h < MIN_ROW_HEIGHT ? Number.POSITIVE_INFINITY : (h - target) ** 2;
  };
  // best[i] = cheapest split of the first i photos into the current number of
  // rows; parent[j][i] = where that split's last row starts.
  let best = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? Number.POSITIVE_INFINITY : cost(0, i)));
  const parent: number[][] = [Array.from({ length: n + 1 }, () => 0)];
  for (let j = 2; j <= k; j++) {
    const next = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const from = new Array<number>(n + 1).fill(0);
    for (let i = j; i <= n; i++) {
      for (let m = j - 1; m < i; m++) {
        const c = best[m]! + cost(m, i);
        if (c < next[i]!) {
          next[i] = c;
          from[i] = m;
        }
      }
    }
    best = next;
    parent.push(from);
  }
  if (!Number.isFinite(best[n])) return null;
  const rows: number[][] = [];
  for (let j = k, end = n; j >= 1; j--) {
    const start = parent[j - 1]![end]!;
    rows.unshift(ratios.slice(start, end));
    end = start;
  }
  return rows;
}

/**
 * Partition photos into justified rows that together make a square.
 *
 * Every row fills the container; the number of rows is whichever brings the
 * stacked height closest to the container width, and within that count the
 * rows are as even as the photos' ratios allow (see evenestRows). Order is
 * never changed — the author's sequence is the story — so the square is only
 * as exact as a contiguous split can make it, and a gallery of two landscapes
 * stacks them rather than leaving a wide, short pair.
 *
 * The square yields to MIN_ROW_HEIGHT: a row that would have to be shorter
 * than that to fit is not on offer, so a large gallery grows taller than it
 * is wide rather than shrinking its photos to thumbnails.
 *
 * The choice of row count is scale-invariant apart from the fixed gap and the
 * floor, so the same photos partition much the same way in the 728px column
 * and the 1112px break-out; what the width mainly changes is how large the
 * square is.
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

  // k = n (one photo per row) is always legal, so a candidate always exists.
  // Strictly closer wins, so a tie keeps the fewer, larger rows.
  let rows: number[][] = [];
  let closest = Number.POSITIVE_INFINITY;
  for (let k = 1; k <= usable.length; k++) {
    const candidate = evenestRows(usable, width, k);
    if (candidate === null) continue;
    const distance = Math.abs(galleryHeightAt(candidate, width) - width);
    if (distance < closest) {
      rows = candidate;
      closest = distance;
    }
  }

  return rows.map((ratiosInRow) => {
    // A row taller than the square is wide (realistically a lone portrait)
    // is capped at that height instead of filling the width. Everything else
    // fills, and omitting the cap keeps the emitted style attribute (and the
    // DOM) free of noise.
    if (rowHeightAt(ratiosInRow, width) <= width) return { ratios: ratiosInRow, maxWidthFraction: null };
    const sum = ratiosInRow.reduce((a, x) => a + x, 0);
    const capped = width * sum + (ratiosInRow.length - 1) * ROW_GAP;
    return { ratios: ratiosInRow, maxWidthFraction: capped / width };
  });
}
