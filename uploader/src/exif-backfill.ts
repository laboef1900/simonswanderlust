/**
 * Fill the exposure columns (#570) of photos uploaded before they existed,
 * from each photo's retained original. Run by the `backfill-exif` CLI.
 *
 * @ai-warning This reads PRIVATE originals, which carry full EXIF including
 * GPS. Two rules keep that contained, and both are tested:
 *  - only the five exposure fields reach the store (`setExposure` names no
 *    other column) — never status, text, camera, lens, capture time or GPS,
 *    even when the original disagrees with the stored row;
 *  - a log line carries a storage key and a FIXED reason category, or counts —
 *    never a metadata value, a coordinate, a filesystem path or the libvips
 *    error message (which embeds the path). An unsafe key is counted and never
 *    echoed: it comes from a row and may be attacker-sized.
 *
 * Idempotent and resumable by construction: each row is one independent
 * conditional UPDATE, so a second run reports `updated: 0` and a run that died
 * half-way converges when repeated. No lock, no state file.
 *
 * @ai-context docs/superpowers/specs/2026-11-11-issue-570-media-details-design.md §Backfill
 */
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { DbPool } from './db.js';
import { parseExif, type MediaExposure } from './exif.js';
import { assertStoredMediaKey, ORIGINAL_FILE_RE } from './media-files.js';
import type { MediaStore } from './media-store.js';

export interface ExifBackfillReport {
  /** Media rows visited. */
  scanned: number;
  /** Rows whose stored exposure values changed. */
  updated: number;
  /** Rows already holding what their original says (including "nothing"). */
  unchanged: number;
  /** No `-orig.<ext>` on disk — normal for legacy keys, which keep NULLs. */
  missingOriginal: number;
  /** More than one `-orig.<ext>` for the key: skipped rather than guessed. */
  ambiguousOriginal: number;
  /** The directory or the original could not be read. */
  unreadable: number;
  /** The stored key fails `assertStoredMediaKey`; nothing was read for it. */
  invalidKey: number;
}

type SkipReason = 'missing-original' | 'ambiguous-original' | 'unreadable';

const SKIP_COUNTER = {
  'missing-original': 'missingOriginal',
  'ambiguous-original': 'ambiguousOriginal',
  unreadable: 'unreadable',
} as const satisfies Record<SkipReason, keyof ExifBackfillReport>;

/** The `media` columns `setExposure` writes, as `ensureSchema` creates them. */
const EXPOSURE_COLUMNS = ['focal_length', 'focal_length_35mm', 'f_number', 'iso', 'exposure_time'] as const;

/**
 * Whether the upgraded app has migrated this database. The CLI refuses to run
 * before it has: `setExposure` would fail on the first row otherwise.
 *
 * @ai-warning Scoped to `current_schema()` like the boot check in main.ts:
 * information_schema spans every schema in the database, and a `media` table
 * elsewhere must not answer for this one.
 */
export async function hasExposureColumns(db: Pick<DbPool, 'query'>): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'media' AND column_name = ANY($1::text[])`,
    [EXPOSURE_COLUMNS],
  );
  return rows[0]?.n === EXPOSURE_COLUMNS.length;
}

/**
 * The exposure settings recorded in one original; null when it cannot be read.
 * `parseExif` also yields camera, lens, capture time and GPS — they stop here.
 */
async function originalExposure(file: string): Promise<MediaExposure | null> {
  try {
    // Dirent.isFile() admitted it; re-check so a symlink swapped in since is never followed.
    if (!(await lstat(file)).isFile()) return null;
    const meta = await sharp(file, { failOn: 'none' }).metadata();
    const { focalLength, focalLength35mm, fNumber, iso, exposureTime } = parseExif(meta.exif);
    return { focalLength, focalLength35mm, fNumber, iso, exposureTime };
  } catch {
    return null; // the message embeds the path: callers report a fixed category only
  }
}

/**
 * Visit every media row once. A file problem skips that row and is counted; a
 * STORE error is not caught — the run stops, rows already written keep their
 * values, and repeating it finishes the rest. `store` is narrowed to the two
 * methods it may use, so no other column can be written from here.
 */
export async function backfillExif(
  store: Pick<MediaStore, 'allKeys' | 'setExposure'>,
  storageDir: string,
  log: (message: string) => void,
): Promise<ExifBackfillReport> {
  const root = resolve(storageDir);
  const report: ExifBackfillReport = {
    scanned: 0, updated: 0, unchanged: 0, missingOriginal: 0, ambiguousOriginal: 0, unreadable: 0, invalidKey: 0,
  };

  // One listing per directory per RUN: library keys share `library/<year>/`, so
  // a readdir per key would cost keys × directory size. Maps a key's basename to
  // its `-orig.<ext>` file names; null marks a directory that could not be read.
  const listings = new Map<string, Map<string, string[]> | null>();
  async function originalsIn(dir: string): Promise<Map<string, string[]> | null> {
    const cached = listings.get(dir);
    if (cached !== undefined) return cached;
    let listing: Map<string, string[]> | null = new Map<string, string[]>();
    try {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (!d.isFile() || !ORIGINAL_FILE_RE.test(d.name)) continue;
        // Exact base, like deleteMedia: `hero-orig.jpg` belongs to `hero`, never to `hero-b`.
        const base = d.name.replace(ORIGINAL_FILE_RE, '');
        const names = listing.get(base);
        if (names) names.push(d.name);
        else listing.set(base, [d.name]);
      }
    } catch (e) {
      // A missing directory simply holds no originals; anything else is unreadable.
      listing = (e as NodeJS.ErrnoException).code === 'ENOENT' ? new Map<string, string[]>() : null;
    }
    listings.set(dir, listing);
    return listing;
  }

  const skip = (key: string, reason: SkipReason): void => {
    report[SKIP_COUNTER[reason]]++;
    log(`backfill-exif: skipped ${key}: ${reason}`);
  };

  for (const key of await store.allKeys()) {
    report.scanned++;
    try {
      assertStoredMediaKey(key);
    } catch {
      report.invalidKey++; // counted only: no path is built and the key is never echoed
      continue;
    }
    const dir = join(root, dirname(key));
    const listing = await originalsIn(dir);
    if (listing === null) { skip(key, 'unreadable'); continue; }
    const originals = listing.get(basename(key)) ?? [];
    const [original] = originals;
    if (original === undefined) { skip(key, 'missing-original'); continue; }
    if (originals.length > 1) { skip(key, 'ambiguous-original'); continue; }
    const exposure = await originalExposure(join(dir, original));
    if (exposure === null) { skip(key, 'unreadable'); continue; }
    if (await store.setExposure(key, exposure)) report.updated++;
    else report.unchanged++;
  }

  log(
    `backfill-exif: scanned ${report.scanned}, updated ${report.updated}, unchanged ${report.unchanged}, ` +
    `missing original ${report.missingOriginal}, ambiguous original ${report.ambiguousOriginal}, ` +
    `unreadable ${report.unreadable}, invalid key ${report.invalidKey}`,
  );
  return report;
}
