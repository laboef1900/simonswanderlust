/**
 * Justified-row geometry and gallery-wide layout/caption directive readers.
 * Photo-line metadata is decoded by uploader/public/gallery-photo-line.js.
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
 * Full-bleed break-out width, in CSS px. Derived, not chosen: below `lg`
 * `StoryPage.astro` renders the story inside `mx-auto max-w-3xl px-5` →
 * 768 − 40 = 728, and 728 + 24rem = 1112 exactly — the site's content box.
 */
export const BREAKOUT_WIDTH = 1112;

/**
 * The design width a `column` gallery is partitioned and source-hinted for:
 * the centred story body below the opening spread (`--container-story-wide`,
 * 1056px). In the 720px reading column beside the rail the same rows simply
 * render narrower — the partition is scale-invariant bar the 12px gap, and a
 * `sizes` hint sized for the wider of the two never under-fetches.
 */
export const COLUMN_WIDTH = 1056;

/** Gap between photos, in CSS px. MUST match the `gap` in global.css. */
export const ROW_GAP = 12;

/**
 * The shortest a row of two or more photos may be at the design width, in CSS
 * px. The square rule alone would cut a 37-photo gallery into 134px-tall
 * rows — a contact sheet — so a row is only admitted when it clears this, and
 * a big gallery grows taller than it is wide instead. At 168 the column
 * (1056) and the break-out (1112) both admit four landscapes a row (170px
 * and 179px); a lone photo in its own row is always admitted, or a panorama
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


/**
 * A whole line reading `#captions: <value>` — the same shape and tolerance as
 * the `#layout:` directive, for the same reason (a sequence inside a quoted
 * value is content, not a directive).
 */
export const CAPTIONS_DIRECTIVE_RE = /^\s*#\s*captions\s*:\s*(\S*)\s*$/i;

/**
 * Whether a fence shows its captions (figure captions AND, because the
 * lightbox reads them back out of the figure, lightbox captions).
 *
 * Only `#captions: hidden` hides; an absent, unknown or malformed value means
 * visible, so a typo can never silently strip every caption. The first
 * `#captions:` line wins, as for `#layout:`. Hiding never deletes caption
 * text — the lines and the `images` map are untouched — so showing them again
 * restores exactly what the author wrote.
 *
 * @ai-context docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md
 *   (§Gallery-local caption controls)
 */
export function readCaptionsVisible(fenceText: string): boolean {
  for (const line of String(fenceText ?? '').split('\n')) {
    const m = CAPTIONS_DIRECTIVE_RE.exec(line);
    if (!m) continue;
    return (m[1] ?? '').toLowerCase() !== 'hidden';
  }
  return true;
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

/** One unit is a prefix, edge, DP state/transition, or reconstruction photo. */
export type PartitionPhase = 'prepare' | 'bounds' | 'objective' | 'reconstruct';
export const PARTITION_WORK_QUANTUM = 4096;
export interface PartitionWork {
  operations: number;
  phase: PartitionPhase;
}
export interface PartitionOptions {
  /** Requests inject a real event-loop yield; builds omit it and drain synchronously. */
  schedule?: (work: PartitionWork) => Promise<void>;
}

/** Optional inspection for oracle tests; request/build drivers do not collect it. */
export interface PartitionCandidate {
  count: number;
  lower: number;
  upper: number;
  incumbent: number;
  skipped: boolean;
}

interface RowEdge {
  start: number;
  height: number;
  actualHeight: number;
}

/**
 * Conservative interval rejection. Roundoff near an incumbent is deliberately
 * evaluated, not pruned. Bounds use direct row sums (the final height's arithmetic),
 * whereas the evenness objective keeps the original prefix-subtraction arithmetic.
 */
export function cannotImprovePartition(
  lower: number, upper: number, width: number, closest: number, count: number,
): boolean {
  const distance = Math.max(lower - width, width - upper, 0);
  const slack = Number.EPSILON * 32 * (count + 1) * Math.max(1, Math.abs(lower), Math.abs(upper), width, closest);
  return distance > closest + slack;
}

/**
 * One resumable exact optimizer for both runtimes. Each yielded chunk accounts
 * for at most PARTITION_WORK_QUANTUM operations, including initialization.
 * No process-global scratch state. Native buffer allocation is not a wall-clock
 * guarantee; total worst-case work remains O(n³ B), memory O(n² + n B).
 */
export function* partitionRowWork(
  ratios: readonly number[], containerWidth: number,
  inspectCandidate?: (candidate: PartitionCandidate) => void,
): Generator<PartitionWork, GalleryRow[], void> {
  let operations = 0;
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : BREAKOUT_WIDTH;
  const usable: number[] = [];
  const prefix = [0];
  for (const ratio of ratios) {
    if (Number.isFinite(ratio) && ratio > 0) {
      usable.push(ratio);
      prefix.push(prefix[prefix.length - 1]! + ratio);
    }
    if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'prepare' }; operations = 0; }
  }
  const n = usable.length;
  if (!n) {
    if (operations) yield { operations, phase: 'prepare' };
    return [];
  }
  const incoming: RowEdge[][] = [];
  const minimum = new Int32Array(n + 1);
  const suffix = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    incoming.push([]);
    minimum[i] = i === 0 ? 0 : n;
    if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'prepare' }; operations = 0; }
  }
  // Advancing starts puts each incoming list in the original ascending
  // predecessor order. Strict '<' below therefore preserves every DP tie.
  const maxLength = Math.floor(width / ROW_GAP) + 1;
  for (let start = 0; start < n; start++) {
    let sum = 0;
    for (let end = start + 1; end <= n && end - start <= maxLength; end++) {
      sum += usable[end - 1]!;
      const numerator = width - (end - start - 1) * ROW_GAP;
      const height = numerator / (prefix[end]! - prefix[start]!);
      if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'prepare' }; operations = 0; }
      if (end - start > 1 && height < MIN_ROW_HEIGHT) break;
      incoming[end]!.push({ start, height, actualHeight: numerator / sum });
      minimum[end] = Math.min(minimum[end]!, minimum[start]! + 1);
    }
  }
  // Every legal row can be split into legal rows, so reachable counts form
  // [minimum, photo count]. Suffix minima give the same exact reachability
  // test for the unfinished part of a candidate.
  for (let end = n; end > 0; end--) {
    for (const edge of incoming[end]!) {
      const value = suffix[end]! + 1;
      if (suffix[edge.start] === 0 || value < suffix[edge.start]!) suffix[edge.start] = value;
      if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'prepare' }; operations = 0; }
    }
  }
  if (operations) { yield { operations, phase: 'prepare' }; operations = 0; }
  let low = new Float64Array(n + 1).fill(Infinity);
  let high = new Float64Array(n + 1).fill(-Infinity);
  low[0] = high[0] = 0;
  let nextLow = new Float64Array(n + 1);
  let nextHigh = new Float64Array(n + 1);
  const lower = new Float64Array(n + 1);
  const upper = new Float64Array(n + 1);
  for (let count = 1; count <= n; count++) {
    for (let end = 0; end <= n; end++) {
      nextLow[end] = Infinity;
      nextHigh[end] = -Infinity;
      if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'bounds' }; operations = 0; }
      if (end < count || minimum[end]! > count) continue;
      for (const edge of incoming[end]!) {
        if (edge.start >= count - 1 && minimum[edge.start]! <= count - 1) {
          nextLow[end] = Math.min(nextLow[end]!, low[edge.start]! + edge.actualHeight);
          nextHigh[end] = Math.max(nextHigh[end]!, high[edge.start]! + edge.actualHeight);
        }
        if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'bounds' }; operations = 0; }
      }
    }
    lower[count] = nextLow[n]! + (count - 1) * ROW_GAP;
    upper[count] = nextHigh[n]! + (count - 1) * ROW_GAP;
    [low, nextLow] = [nextLow, low];
    [high, nextHigh] = [nextHigh, high];
  }
  if (operations) { yield { operations, phase: 'bounds' }; operations = 0; }
  let closest = Infinity;
  let winner: number[][] = [];
  for (let count = minimum[n]!; count <= n; count++) {
    if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'objective' }; operations = 0; }
    const skipped = cannotImprovePartition(lower[count]!, upper[count]!, width, closest, n);
    inspectCandidate?.({ count, lower: lower[count]!, upper: upper[count]!, incumbent: closest, skipped });
    if (skipped) continue;
    const target = (width - (count - 1) * ROW_GAP) / count;
    let best = new Float64Array(n + 1).fill(Infinity);
    let next = new Float64Array(n + 1);
    best[0] = 0;
    const parents: Int32Array[] = [];
    for (let row = 1; row <= count; row++) {
      const parent = new Int32Array(n + 1);
      parents.push(parent);
      for (let end = 0; end <= n; end++) {
        next[end] = Infinity;
        if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'objective' }; operations = 0; }
        const remaining = count - row;
        if (end < row || minimum[end]! > row || n - end < remaining || suffix[end]! > remaining) continue;
        for (const edge of incoming[end]!) {
          const cost = best[edge.start]! + (edge.height - target) ** 2;
          if (cost < next[end]!) {
            next[end] = cost;
            parent[end] = edge.start;
          }
          if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'objective' }; operations = 0; }
        }
      }
      [best, next] = [next, best];
    }
    if (operations) { yield { operations, phase: 'objective' }; operations = 0; }
    if (!Number.isFinite(best[n])) continue;
    const candidate = new Array<number[]>(count);
    for (let row = count, end = n; row > 0; row--) {
      const start = parents[row - 1]![end]!;
      const values: number[] = [];
      for (let i = start; i < end; i++) {
        values.push(usable[i]!);
        if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'reconstruct' }; operations = 0; }
      }
      candidate[row - 1] = values;
      end = start;
    }
    let height = 0;
    for (const row of candidate) {
      let sum = 0;
      for (const ratio of row) {
        sum += ratio;
        if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'reconstruct' }; operations = 0; }
      }
      height += (width - (row.length - 1) * ROW_GAP) / sum;
    }
    const distance = Math.abs(height + (count - 1) * ROW_GAP - width);
    if (distance < closest) {
      closest = distance;
      winner = candidate;
    }
    if (operations) { yield { operations, phase: 'reconstruct' }; operations = 0; }
  }
  const result: GalleryRow[] = [];
  for (const row of winner) {
    let sum = 0;
    for (const ratio of row) {
      sum += ratio;
      if (++operations === PARTITION_WORK_QUANTUM) { yield { operations, phase: 'reconstruct' }; operations = 0; }
    }
    const height = (width - (row.length - 1) * ROW_GAP) / sum;
    result.push({
      ratios: row,
      maxWidthFraction: height <= width ? null : (width * sum + (row.length - 1) * ROW_GAP) / width,
    });
  }
  if (operations) yield { operations, phase: 'reconstruct' };
  return result;
}

/** Request driver: never substitutes microtasks for the supplied scheduler. */
export async function partitionRowsAsync(
  ratios: readonly number[], width: number, options: PartitionOptions = {},
): Promise<GalleryRow[]> {
  if (!options.schedule) return partitionRows(ratios, width);
  const work = partitionRowWork(ratios, width);
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
    await options.schedule(step.value);
  }
}

/**
 * Partition photos into justified rows that together make a square.
 *
 * Every row fills the container; the number of rows is whichever brings the
 * stacked height closest to the container width, and within that count the
 * rows are as even as the photos' ratios allow (see partitionRowWork). Order is
 * never changed — the author's sequence is the story — so the square is only
 * as exact as a contiguous split can make it, and a gallery of two landscapes
 * stacks them rather than leaving a wide, short pair.
 *
 * The square yields to MIN_ROW_HEIGHT: a row that would have to be shorter
 * than that to fit is not on offer, so a large gallery grows taller than it
 * is wide rather than shrinking its photos to thumbnails.
 *
 * The choice of row count is scale-invariant apart from the fixed gap and the
 * floor, so the same photos partition much the same way in the 1056px column
 * and the 1112px break-out; what the width mainly changes is how large the
 * square is.
 *
 * @ai-note Row MEMBERSHIP is fixed here, at render time, for `containerWidth`.
 * Only the justification WITHIN a row is fluid (the emitted ratios let the
 * browser redo that arithmetic at any width). Between ~600px and the design
 * width the same rows simply get shorter; below that the CSS container query
 * stacks them. This is an accepted trade-off, not a solved problem — do not
 * read the ratio emission as making the whole layout responsive.
 */
export function partitionRows(ratios: readonly number[], containerWidth: number): GalleryRow[] {
  const work = partitionRowWork(ratios, containerWidth);
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}
