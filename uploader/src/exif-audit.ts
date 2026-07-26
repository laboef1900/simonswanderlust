import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { readExif } from './exif.js';
import { VARIANT_FILE_RE } from './media.js';
import { isOriginalFile } from './storage.js';

export interface ExifAudit {
  /** Variant files scanned. */
  variants: number;
  withExif: number;
  withGps: number;
  /** Distinct storage keys covered by those variants. */
  keys: number;
  gpsKeys: string[];
  /** GPS-bearing keys with no `-orig` — these cannot be losslessly re-encoded. */
  gpsKeysWithoutOriginal: string[];
  /**
   * Directories the scan could not read (permission error, symlink cycle,
   * etc.), relative to storageDir. Nonempty means the counts above are a
   * PARTIAL view of the corpus, not the whole thing.
   */
  skippedDirs: string[];
}

const EMPTY: ExifAudit = {
  variants: 0, withExif: 0, withGps: 0, keys: 0,
  gpsKeys: [], gpsKeysWithoutOriginal: [], skippedDirs: [],
};

/**
 * Read-only scan of the stored corpus: how much published metadata actually
 * carries location. Never writes, never throws on a bad file or directory.
 *
 * @ai-context: gates whether `strip-gps` needs to run at all — re-encoding the
 * corpus is expensive and lossy for keys with no retained original, so it is
 * not something to do speculatively.
 *
 * @ai-warning: walks directory-by-directory (not `readdir`'s built-in
 * `recursive` option, which is all-or-nothing) so a permission error or
 * symlink cycle on ONE subdirectory only drops that subtree — recorded in
 * `skippedDirs` — instead of aborting the whole scan. This runs against a
 * live server's data directory whose permission state we don't control;
 * reporting a partial result beats reporting nothing. Symlinked entries are
 * never followed (Dirent.isDirectory()/isFile() are false for them), which
 * also sidesteps symlink cycles by construction.
 */
export async function auditExif(storageDir: string): Promise<ExifAudit> {
  const keysWithOriginal = new Set<string>();
  const allKeys = new Set<string>();
  const gpsKeys = new Set<string>();
  const skippedDirs: string[] = [];
  let variants = 0;
  let withExif = 0;
  let withGps = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const d of entries) {
      const full = join(dir, d.name);

      if (d.isDirectory()) {
        try {
          await walk(full);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // raced away mid-scan
          skippedDirs.push(relative(storageDir, full).split(sep).join('/'));
        }
        continue;
      }
      if (!d.isFile()) continue;

      const rel = relative(storageDir, full).split(sep).join('/');
      if (isOriginalFile(d.name)) {
        keysWithOriginal.add(rel.replace(/-orig\.[a-z0-9]+$/i, ''));
        continue;
      }
      if (!VARIANT_FILE_RE.test(d.name)) continue;

      variants++;
      const key = rel.replace(VARIANT_FILE_RE, '');
      allKeys.add(key);

      try {
        const meta = await sharp(full).metadata();
        const tags = readExif(meta.exif);
        if (!tags) continue;
        withExif++;
        if (tags.GPSInfo?.GPSLatitude) {
          withGps++;
          gpsKeys.add(key);
        }
      } catch {
        // Unreadable/corrupt file: counted as a variant, but nothing to report.
      }
    }
  }

  try {
    await walk(storageDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    // The root itself couldn't be opened (e.g. EACCES) — report a fully
    // skipped scan rather than throwing; every deeper failure is caught above.
    return { ...EMPTY, skippedDirs: ['.'] };
  }

  const sortedGps = [...gpsKeys].sort();
  return {
    variants,
    withExif,
    withGps,
    keys: allKeys.size,
    gpsKeys: sortedGps,
    gpsKeysWithoutOriginal: sortedGps.filter((k) => !keysWithOriginal.has(k)),
    skippedDirs: skippedDirs.sort(),
  };
}
