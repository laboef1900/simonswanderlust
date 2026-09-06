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
import { MAX_PAGE_SIZE, type MediaStore } from './media-store.js';
import type { PagePair } from './pages.js';
import type { PostUsageRow } from './posts.js';

export interface SyncReport {
  scanned: number;
  inserted: number;
  altHarvested: number;
  markedMissing: number;
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

interface DiskKey { key: string; hasVariants: boolean; largestVariant: string | null; origBytes: number }

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
  const widths = new Map<string, number>();
  for (const d of entries) {
    if (!d.isFile()) continue;
    const rel = relative(root, join(d.parentPath, d.name)).split(sep).join('/');
    const isVariant = VARIANT_FILE_RE.test(d.name);
    const isOriginal = !isVariant && ORIGINAL_FILE_RE.test(d.name);
    if (!isVariant && !isOriginal) continue;
    const key = rel.replace(isVariant ? VARIANT_FILE_RE : ORIGINAL_FILE_RE, '');
    const entry = byKey.get(key) ?? { key, hasVariants: false, largestVariant: null, origBytes: 0 };
    if (isVariant) {
      entry.hasVariants = true;
      const m = VARIANT_FILE_RE.exec(d.name);
      const w = Number(m?.[1] ?? 0);
      if (String(m?.[2]) === 'webp' && w >= (widths.get(key) ?? 0)) {
        widths.set(key, w);
        entry.largestVariant = rel;
      }
    } else {
      // Best-effort: a stat failure just leaves origBytes at 0 ("unknown").
      try { entry.origBytes = (await stat(join(root, rel))).size; } catch { /* keep 0 */ }
    }
    byKey.set(key, entry);
  }
  return byKey;
}

/** Probe a variant's intrinsic size; 0/0 when unreadable (never aborts the pass). */
async function probeDims(file: string): Promise<{ width: number; height: number }> {
  try {
    const meta = await sharp(file).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch {
    return { width: 0, height: 0 };
  }
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

  return {
    async run(): Promise<SyncReport> {
      const report: SyncReport = { scanned: 0, inserted: 0, altHarvested: 0, markedMissing: 0 };
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
        const dims = entry.largestVariant
          ? await probeDims(join(resolve(opts.storageDir), entry.largestVariant))
          : { width: 0, height: 0 };
        const alt = harvestAlt(`${baseUrl}/${entry.key}`, corpus.posts);
        if (alt.de || alt.en) report.altHarvested++;
        try {
          await opts.store.upsert({
            key: entry.key,
            // A key with an original but no variants is a crashed upload: put
            // it back in the queue rather than declaring it ready.
            status: entry.hasVariants ? 'ready' : 'processing',
            width: dims.width, height: dims.height, origBytes: entry.origBytes,
            alt, exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null },
            uploadedBy: null,
          });
          report.inserted++;
        } catch (e) {
          log(`media-sync: could not insert ${entry.key}: ${(e as Error).message}`);
        }
      }

      // Prune: a row whose files have all vanished is MARKED, never deleted —
      // the metadata is the only thing left worth keeping.
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
      const readyKeys: string[] = [];
      for (let page = 1; ; page++) {
        const { items, total } = await opts.store.list({
          status: 'ready', sort: 'key', order: 'asc', page, pageSize: MAX_PAGE_SIZE,
        });
        readyKeys.push(...items.map((i) => i.key));
        if (items.length < MAX_PAGE_SIZE || readyKeys.length >= total) break;
      }
      for (const key of readyKeys) {
        if (disk.has(key)) continue;
        await opts.store.setStatus(key, 'missing');
        report.markedMissing++;
      }

      log(`media-sync: scanned ${report.scanned} key(s), inserted ${report.inserted}, `
        + `harvested alt for ${report.altHarvested}, marked ${report.markedMissing} missing`);
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
