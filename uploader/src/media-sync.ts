/**
 * Reconcile the media DATABASE with what is actually on DISK.
 *
 * The filesystem is the source of truth for a file's existence (see
 * media-store.ts), so the database can drift: photos uploaded before the
 * library existed have no row, a crashed upload leaves a row nobody finished,
 * and a file deleted out of band leaves a row pointing at nothing. The sync
 * runs inside `createReconciler` — after `listen()` (never blocking boot) and
 * on demand via `POST /media/rescan` — logs what it did, and degrades
 * gracefully.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   §Reconciliation — issue #64.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { ORIGINAL_FILE_RE, VARIANT_FILE_RE } from './media-files.js';
import { FORMATS, variantWidths } from './variants.js';
import { MAX_PAGE_SIZE, type MediaStore } from './media-store.js';
import type { PagePair } from './pages.js';
import type { PostUsageRow } from './posts.js';

export interface SyncReport {
  scanned: number;
  inserted: number;
  altHarvested: number;
  markedMissing: number;
  /** `ready` rows whose variant set on disk turned out incomplete (#118): now `processing` or `missing`. */
  demoted: number;
}

/** What `POST /media/rescan` and the boot pass return: the sync plus the encode re-seed. */
export interface ReconcileReport extends SyncReport {
  /** Rows left `processing` that the pass handed to the encode queue. */
  recovered: number;
}

export interface MediaSyncOptions {
  store: MediaStore;
  storageDir: string;
  baseUrl: string;
  /** Post rows + pages, for the alt-text harvest. */
  corpus: () => Promise<{ posts: PostUsageRow[]; pages: PagePair[] }>;
  log?: (msg: string) => void;
}

export interface DiskKey {
  key: string;
  /** Variant files present, as `${width}.${format}` — the shape `isCompleteSet` checks. */
  variants: Set<string>;
  /** storageDir-relative path of the widest variant (webp preferred), for probing a key with no original. */
  largestVariant: string | null;
  /** storageDir-relative path of the retained `-orig.<ext>`; null for legacy WP-era files. */
  original: string | null;
  origBytes: number;
}

/**
 * Walk storageDir grouping BOTH variants and originals by key.
 *
 * @ai-warning This deliberately does not reuse `listMedia`, which matches
 * variants only: a `processing` row has written just `${key}-orig.<ext>` and
 * has no variant files yet, so a variants-only walk would never discover a
 * crashed upload — the exact case the backfill most needs to heal.
 */
export async function walkStorageKeys(storageDir: string): Promise<Map<string, DiskKey>> {
  const root = resolve(storageDir);
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw e;
  }
  const byKey = new Map<string, DiskKey>();
  const largest = new Map<string, { width: number; webp: boolean }>();
  for (const d of entries) {
    if (!d.isFile()) continue;
    const rel = relative(root, join(d.parentPath, d.name)).split(sep).join('/');
    const isVariant = VARIANT_FILE_RE.test(d.name);
    const isOriginal = !isVariant && ORIGINAL_FILE_RE.test(d.name);
    if (!isVariant && !isOriginal) continue; // includes storage.ts's `.part-*` temps
    const key = rel.replace(isVariant ? VARIANT_FILE_RE : ORIGINAL_FILE_RE, '');
    const entry = byKey.get(key) ?? { key, variants: new Set<string>(), largestVariant: null, original: null, origBytes: 0 };
    if (isVariant) {
      const m = VARIANT_FILE_RE.exec(d.name);
      const width = Number(m?.[1] ?? 0);
      const webp = m?.[2] === 'webp';
      entry.variants.add(`${width}.${m?.[2]}`);
      const best = largest.get(key);
      if (!best || width > best.width || (width === best.width && webp && !best.webp)) {
        largest.set(key, { width, webp });
        entry.largestVariant = rel;
      }
    } else {
      entry.original = rel;
      // Best-effort: a stat failure just leaves origBytes at 0 ("unknown").
      try { entry.origBytes = (await stat(join(root, rel))).size; } catch { /* keep 0 */ }
    }
    byKey.set(key, entry);
  }
  return byKey;
}

/**
 * The variant contract on disk: every width `variantWidths(intrinsicWidth)`
 * prescribes, in every format (variants.ts, mirrored by the site's images.ts —
 * the srcset asks for exactly these files). One stray variant is not a photo.
 */
export function isCompleteSet(variants: ReadonlySet<string>, intrinsicWidth: number): boolean {
  if (!Number.isInteger(intrinsicWidth) || intrinsicWidth <= 0) return false;
  return variantWidths(intrinsicWidth).every((w) => FORMATS.every((f) => variants.has(`${w}.${f}`)));
}

/**
 * Probe a file's intrinsic size; 0/0 when unreadable (never aborts the pass).
 * Orientation-corrected, like `probeImage` — an original carrying EXIF
 * rotation was resized against its corrected width, and that is the width
 * the variant set was derived from.
 */
async function probeDims(file: string): Promise<{ width: number; height: number }> {
  try {
    const meta = await sharp(file).metadata();
    return { width: meta.autoOrient?.width ?? meta.width ?? 0, height: meta.autoOrient?.height ?? meta.height ?? 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

type DiskVerdict = { status: 'ready' | 'processing' | 'missing'; width: number; height: number };

/**
 * What the files say a key's status and dimensions should be.
 *
 * @ai-warning The expected set MUST be derived from the retained original
 * when there is one, never from the largest surviving variant. Variants are
 * written in ascending width, so a crash truncates the TOP widths — and a
 * top-truncated set is byte-for-byte a complete set for a smaller photo.
 * `createRehostResume` (wp-images.ts) fails closed for the same reason. Only
 * a legacy key with no original falls back to the widest variant: there is
 * no ground truth to compare against, and the recorded width is then at
 * least self-consistent with the files that exist.
 */
async function assess(root: string, entry: DiskKey): Promise<DiskVerdict> {
  if (entry.original) {
    const dims = await probeDims(join(root, entry.original));
    if (dims.width > 0 && isCompleteSet(entry.variants, dims.width)) return { status: 'ready', ...dims };
    // A crashed upload (no variants), a partial set or an unreadable original:
    // re-encoding is idempotent and either heals it or fails honestly.
    return { status: 'processing', ...dims };
  }
  const dims = entry.largestVariant ? await probeDims(join(root, entry.largestVariant)) : { width: 0, height: 0 };
  if (dims.width > 0 && isCompleteSet(entry.variants, dims.width)) return { status: 'ready', ...dims };
  // Nothing can re-encode it: flag it so the library shows it and the publish gate blocks it.
  return { status: 'missing', ...dims };
}

/**
 * Alt text already written for this image, by locale.
 *
 * @ai-warning EXACT URL matches only — `heroImage.src` equality and the
 * `![alt](src)` parse. No fuzzy matching: a mis-attribution would silently
 * poison the library and then denormalize into every future post that picks
 * the photo.
 */
export function harvestAlt(src: string, posts: PostUsageRow[]): { de: string; en: string } {
  const out = { de: '', en: '' };
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const row of posts) {
    const locale = row.locale;
    if (locale !== 'de' && locale !== 'en') continue;
    if (out[locale]) continue;
    if (row.heroImage?.src === src && typeof row.heroImage.alt === 'string' && row.heroImage.alt) {
      out[locale] = row.heroImage.alt;
      continue;
    }
    imgRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(row.bodyMarkdown ?? '')) !== null) {
      if (m[2] === src && m[1]) { out[locale] = m[1]; break; }
    }
  }
  return out;
}

export function createMediaSync(opts: MediaSyncOptions) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const root = resolve(opts.storageDir);

  return {
    async run(): Promise<SyncReport> {
      const report: SyncReport = { scanned: 0, inserted: 0, altHarvested: 0, markedMissing: 0, demoted: 0 };
      const disk = await walkStorageKeys(opts.storageDir);
      report.scanned = disk.size;
      const known = new Set(await opts.store.allKeys());

      let corpus: { posts: PostUsageRow[]; pages: PagePair[] } = { posts: [], pages: [] };
      try {
        corpus = await opts.corpus();
      } catch (e) {
        log(`media-sync: could not load content for the alt harvest (${(e as Error).message}); continuing without it`);
      }
      for (const entry of disk.values()) {
        if (known.has(entry.key)) continue;
        const verdict = await assess(root, entry);
        const alt = harvestAlt(`${baseUrl}/${entry.key}`, corpus.posts);
        if (alt.de || alt.en) report.altHarvested++;
        try {
          await opts.store.upsert({
            key: entry.key,
            // Only a COMPLETE variant set is `ready` (#118). A key with an
            // original but a partial set — a crashed upload — goes back in the
            // queue; one without an original cannot be re-encoded and is
            // flagged `missing` rather than declared whole.
            status: verdict.status,
            width: verdict.width, height: verdict.height, origBytes: entry.origBytes,
            alt, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null },
            uploadedBy: null,
          });
          report.inserted++;
        } catch (e) {
          log(`media-sync: could not insert ${entry.key}: ${(e as Error).message}`);
        }
      }

      // Prune: a row whose files have all vanished is MARKED, never deleted —
      // the metadata is the only thing left worth keeping. A row whose set
      // merely lost files (a partial restore of /data/images, #118) is
      // demoted the same way the backfill would classify it.
      // @ai-warning Skips rows that are not `ready`: an upload in flight has a
      // row but not yet a full file set, and a concurrent pass would otherwise
      // mark a perfectly healthy in-progress upload as missing.
      //
      // @ai-warning Two phases, and the split is load-bearing. `list()` caps
      // pageSize at MAX_PAGE_SIZE, so a single page silently stopped sweeping
      // at 200 photos — the sweep reported success having checked a fraction of
      // the library. Paginating naively is no better: marking a row `missing`
      // drops it out of the `status = 'ready'` filter, so every mutation
      // shifts the rows underneath the next OFFSET and skips one. Collect the
      // whole ready set first (no writes, so paging is stable), then mutate.
      const ready: { key: string; width: number }[] = [];
      for (let page = 1; ; page++) {
        const { items, total } = await opts.store.list({
          status: 'ready', sort: 'key', order: 'asc', page, pageSize: MAX_PAGE_SIZE,
        });
        ready.push(...items.map((i) => ({ key: i.key, width: i.width })));
        if (items.length < MAX_PAGE_SIZE || ready.length >= total) break;
      }
      for (const row of ready) {
        const entry = disk.get(row.key);
        if (!entry) {
          await opts.store.setStatus(row.key, 'missing');
          report.markedMissing++;
          continue;
        }
        // Fast path, no image read: the srcset is built from the recorded
        // width, so if every file it can ask for exists nothing can 404.
        if (isCompleteSet(entry.variants, row.width)) continue;
        const verdict = await assess(root, entry);
        if (verdict.status === 'ready') continue; // complete for its real width; the recorded one is merely stale
        await opts.store.setStatus(row.key, verdict.status);
        report.demoted++;
        log(`media-sync: ${row.key} has an incomplete variant set on disk — now ${verdict.status}`);
      }

      log(`media-sync: scanned ${report.scanned} key(s), inserted ${report.inserted}, `
        + `harvested alt for ${report.altHarvested}, marked ${report.markedMissing} missing, demoted ${report.demoted}`);
      return report;
    },
  };
}

/**
 * Reconcile disk ↔ database, THEN resume anything left half-encoded — the
 * one entry point for both boot and `POST /media/rescan`.
 *
 * @ai-warning The order is load-bearing, and the two steps must never run
 * separately. The sync inserts a backfilled crashed upload (an `-orig.*` on
 * disk with no variants) as `processing`, and `recover()` re-seeds the queue
 * from `status = 'processing'`. Nothing else un-sticks such a row: `POST
 * /media/retry` skips `processing` and the UI offers Retry only for
 * `failed`, while the publish gate blocks every post referencing it. Before
 * this existed the rescan route ran the sync alone (#117), so an admin's
 * Rescan stranded exactly the rows it discovered until the next restart.
 * Fired in parallel the bug returns: `recover()` is a single query and
 * finishes before the sync's disk walk, so it never sees those rows.
 */
export function createReconciler(opts: {
  sync: { run(): Promise<SyncReport> };
  queue: { recover(): Promise<number> };
}) {
  return {
    async run(): Promise<ReconcileReport> {
      // A failed sync (unreadable storage dir, DB hiccup) still gets the
      // recovery pass: the `processing` rows a crash left behind predate this
      // run and heal independently of it. The sync error is re-thrown after.
      let report: SyncReport | undefined;
      let syncError: unknown;
      try {
        report = await opts.sync.run();
      } catch (e) {
        syncError = e;
      }
      const recovered = await opts.queue.recover();
      if (report === undefined) throw syncError;
      return { ...report, recovered };
    },
  };
}
