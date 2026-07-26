import exifReader from 'exif-reader';

/**
 * EXIF handling for the image pipeline.
 *
 * @ai-warning: this module decides what metadata reaches PUBLIC image files.
 * It is an allow-list, not a filter: anything not explicitly listed in
 * ALLOW is dropped by construction. Widening it is a privacy change, not a
 * refactor — see the D1 section of
 * docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md.
 *
 * @ai-context: sharp exposes EXIF as raw bytes only (`metadata().exif`), so a
 * parser is genuinely required. exif-reader is the sharp-blessed one (shared
 * maintainer) and has zero dependencies and no install script.
 */

export type ExifTags = ReturnType<typeof exifReader>;

export interface AllowedExif {
  IFD0: Record<string, string>;
  IFD2: Record<string, string>;
}

/** Longest metadata string written to a variant or (in Phase 2) the database. */
const MAX_STR = 120;

/**
 * Parse raw EXIF bytes, or null when absent/unparseable.
 *
 * @ai-warning: exif-reader THROWS on malformed input rather than returning
 * null, and on partial corruption it can succeed with `Image: null` — its
 * bundled .d.ts understates that nullability. Callers must use optional
 * chaining, never truthiness.
 */
export function readExif(raw: Buffer | undefined): ExifTags | null {
  if (!raw || raw.length === 0) return null;
  try {
    return exifReader(raw);
  } catch {
    return null;
  }
}

/**
 * Sanitize a metadata string before it reaches a file or the database.
 *
 * The NUL strip is not cosmetic: Postgres `text` rejects a NUL byte outright,
 * so a crafted JPEG would otherwise 500 every upload of that file. The length
 * cap stops a multi-megabyte `Model` entering every media listing response.
 *
 * @ai-note: exported solely so it can be unit-tested directly. libvips
 * truncates strings at the first NUL when *writing* EXIF, so a sharp-authored
 * test fixture cannot carry one — but a real camera's EXIF can, and sharp only
 * reads that. Testing through a fixture would silently prove nothing.
 */
export function cleanExifString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()
    .slice(0, MAX_STR);
  return s || null;
}

/**
 * Encode a number as an EXIF unsigned rational string.
 *
 * @ai-note: exif-reader returns rationals PRE-DIVIDED (0.004, not 1/250), so
 * this re-encodes. Sub-second values become reciprocals because that is how
 * cameras record shutter speed and a /1000 denominator would round 1/8000 to
 * zero. Values >= 1 use a fixed /1000 denominator, which is exact enough for
 * apertures and focal lengths.
 */
export function toRational(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  if (v === 0) return '0/1';
  if (v < 1) {
    const den = Math.round(1 / v);
    if (den > 0 && den <= 4_000_000) return `1/${den}`;
    return null;
  }
  const num = Math.round(v * 1000);
  if (num > 4_000_000_000) return null;
  return `${num}/1000`;
}

/**
 * Format an exif-reader Date as an EXIF datetime string.
 *
 * @ai-warning: EXIF stores naive local wall-clock with no zone, and
 * exif-reader relabels those digits as UTC (`new Date(Date.UTC(...))`). Read
 * them back with getUTC* ONLY — local accessors double-shift the timestamp.
 */
function formatExifDate(d: unknown): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/**
 * Build the `sharp.withExif()` input containing ONLY the approved tags.
 * Returns null when nothing survives, so the caller can skip withExif entirely.
 */
export function allowedExif(raw: Buffer | undefined): AllowedExif | null {
  const tags = readExif(raw);
  if (!tags) return null;

  const IFD0: Record<string, string> = {};
  const IFD2: Record<string, string> = {};
  const put = (into: Record<string, string>, k: string, v: string | null): void => {
    if (v !== null) into[k] = v;
  };

  put(IFD0, 'Make', cleanExifString(tags.Image?.Make));
  put(IFD0, 'Model', cleanExifString(tags.Image?.Model));

  put(IFD2, 'LensModel', cleanExifString(tags.Photo?.LensModel));
  put(IFD2, 'DateTimeOriginal', formatExifDate(tags.Photo?.DateTimeOriginal));
  put(IFD2, 'ExposureTime', toRational(tags.Photo?.ExposureTime));
  put(IFD2, 'FNumber', toRational(tags.Photo?.FNumber));
  put(
    IFD2,
    'ISOSpeedRatings',
    Number.isFinite(tags.Photo?.ISOSpeedRatings)
      ? String(Math.round(Number(tags.Photo?.ISOSpeedRatings)))
      : null,
  );
  put(IFD2, 'FocalLength', toRational(tags.Photo?.FocalLength));

  if (Object.keys(IFD0).length === 0 && Object.keys(IFD2).length === 0) return null;
  return { IFD0, IFD2 };
}

/**
 * The READ side: what the media library stores about a photo.
 *
 * Distinct from `allowedExif` above, which decides what gets WRITTEN into
 * public variants. GPS is deliberately extracted here and never there — the
 * library keeps coordinates as private metadata for the author (and the API
 * redacts them from non-admins), while published files carry none.
 */
export interface MediaExif {
  /**
   * @ai-warning EXIF wall-clock with no zone. exif-reader relabels those digits
   * as UTC (`new Date(Date.UTC(...))`), so a shot taken at 18:23 in Norway is
   * stored as 18:23Z. Format it with `getUTC*` accessors ONLY — a local-time
   * formatter double-shifts it and silently mislabels photos across timezones.
   */
  takenAt: Date | null;
  camera: string | null;
  lens: string | null;
  lat: number | null;
  lng: number | null;
}

const EMPTY_EXIF: MediaExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

/**
 * Convert an EXIF GPS degrees/minutes/seconds triple to a signed decimal.
 *
 * @ai-note exif-reader returns rationals ALREADY DIVIDED (`[63, 4, 33.12]`),
 * not as numerator/denominator pairs — most DMS snippets online assume the
 * pair form and produce garbage here. The `Number.isFinite` guard is what
 * stops a zero-denominator rational (which arrives as NaN) reaching the
 * database as a broken coordinate.
 */
export function gpsToDecimal(dms: unknown, ref: unknown): number | null {
  if (!Array.isArray(dms) || dms.length < 2) return null;
  const [d = 0, m = 0, s = 0] = dms as number[];
  if (![d, m, s].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const dec = d + m / 60 + s / 3600;
  if (!Number.isFinite(dec)) return null;
  const signed = ref === 'S' || ref === 'W' ? -dec : dec;
  // A malformed triple can still produce an out-of-range value; a coordinate
  // outside the globe is not worth storing.
  if (Math.abs(signed) > 180) return null;
  return signed;
}

/**
 * Parse the camera metadata the library shows. Never throws — malformed EXIF
 * is a normal input here, not an error.
 *
 * @ai-warning IFD grouping is not flat: the body is under `Image`, the lens
 * and capture time under `Photo`, GPS under `GPSInfo`. exif-reader's bundled
 * .d.ts understates their nullability (partial corruption parses fine with
 * `Image: null`), so use optional chaining rather than truthiness.
 */
export function parseExif(raw: Buffer | undefined): MediaExif {
  const tags = readExif(raw);
  if (!tags) return { ...EMPTY_EXIF };
  const takenAt = tags.Photo?.DateTimeOriginal;
  const lat = gpsToDecimal(tags.GPSInfo?.GPSLatitude, tags.GPSInfo?.GPSLatitudeRef);
  const lng = gpsToDecimal(tags.GPSInfo?.GPSLongitude, tags.GPSInfo?.GPSLongitudeRef);
  return {
    takenAt: takenAt instanceof Date && !Number.isNaN(takenAt.getTime()) ? takenAt : null,
    // Make and Model are separate tags; the library shows one "camera" string.
    camera: cleanExifString(
      [cleanExifString(tags.Image?.Make), cleanExifString(tags.Image?.Model)].filter(Boolean).join(' ') || null,
    ),
    lens: cleanExifString(tags.Photo?.LensModel),
    // Latitude is bounded tighter than longitude.
    lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    lng,
  };
}
