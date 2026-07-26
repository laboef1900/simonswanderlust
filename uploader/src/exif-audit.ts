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
}

const EMPTY: ExifAudit = {
  variants: 0, withExif: 0, withGps: 0, keys: 0,
  gpsKeys: [], gpsKeysWithoutOriginal: [],
};

/**
 * Read-only scan of the stored corpus: how much published metadata actually
 * carries location. Never writes, never throws on a bad file.
 *
 * @ai-context: gates whether `strip-gps` needs to run at all — re-encoding the
 * corpus is expensive and lossy for keys with no retained original, so it is
 * not something to do speculatively.
 */
export async function auditExif(storageDir: string): Promise<ExifAudit> {
  let entries;
  try {
    entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw e;
  }

  const keysWithOriginal = new Set<string>();
  const allKeys = new Set<string>();
  const gpsKeys = new Set<string>();
  let variants = 0;
  let withExif = 0;
  let withGps = 0;

  for (const d of entries) {
    if (!d.isFile()) continue;
    const rel = relative(storageDir, join(d.parentPath, d.name)).split(sep).join('/');

    if (isOriginalFile(d.name)) {
      keysWithOriginal.add(rel.replace(/-orig\.[a-z0-9]+$/i, ''));
      continue;
    }
    if (!VARIANT_FILE_RE.test(d.name)) continue;

    variants++;
    const key = rel.replace(VARIANT_FILE_RE, '');
    allKeys.add(key);

    try {
      const meta = await sharp(join(storageDir, rel)).metadata();
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

  const sortedGps = [...gpsKeys].sort();
  return {
    variants,
    withExif,
    withGps,
    keys: allKeys.size,
    gpsKeys: sortedGps,
    gpsKeysWithoutOriginal: sortedGps.filter((k) => !keysWithOriginal.has(k)),
  };
}
