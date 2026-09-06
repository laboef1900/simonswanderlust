import sharp from 'sharp';
import { variantWidths, FORMATS, type ImageFormat } from './variants.js';
import { allowedExif } from './exif.js';

export interface Variant {
  width: number;
  format: ImageFormat;
  data: Buffer;
}

export interface OriginalImage {
  /** The untouched input bytes, byte-for-byte. */
  data: Buffer;
  /** File extension derived from the detected input format (e.g. 'jpg', 'png'). */
  ext: string;
}

export interface ProcessResult {
  width: number;
  height: number;
  variants: Variant[];
  original: OriginalImage;
}

// sharp format names that differ from the conventional file extension.
// @ai-note: sharp reports AVIF as 'heif' (AVIF is the AV1 flavor of HEIF, and
// the prebuilt binaries decode only that flavor), so 'avif' is the honest ext.
const EXT_BY_FORMAT: Record<string, string> = { jpeg: 'jpg', heif: 'avif' };

export interface ProcessOptions {
  avifQuality?: number;
  webpQuality?: number;
}

export interface ImageProbe {
  /** Orientation-corrected intrinsic size — what `processImage` will produce. */
  width: number;
  height: number;
  /** Extension for the retained original, matching what storeOriginal writes. */
  ext: string;
  /** Raw EXIF bytes, for `parseExif` — sharp exposes EXIF only as a Buffer. */
  exif: Buffer | undefined;
}

/**
 * Read dimensions and format WITHOUT re-encoding.
 *
 * The async upload path needs the intrinsic size to answer the request
 * immediately; a metadata-only probe does that in ~0.0002 s where the full
 * re-encode `processImage` performs costs ~0.467 s (and the encode itself
 * ~19 s for a 24 MP frame).
 *
 * @ai-warning The SVG case is why this cannot simply use `metadata().format`.
 * The re-encode probe reports `png` for SVG input (sharp rasterises it) and
 * `processImage` therefore stores the untouched bytes as `-orig.png`, which is
 * DELIBERATE: a publicly served `-orig.svg` would be a stored-XSS vector on
 * the image host. `metadata()` honestly reports `svg`, so the two disagree —
 * verified empirically — and this maps it back to `png` to keep the two paths
 * writing the same filename. Do not "fix" that mapping.
 */
export async function probeImage(input: Buffer): Promise<ImageProbe> {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  // `autoOrient` is sharp's orientation-corrected size; `width`/`height` are
  // the raw stored ones, which are swapped for a 90°-rotated photo.
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  const format = meta.format === 'svg' ? 'png' : meta.format ?? '';
  return { width, height, ext: EXT_BY_FORMAT[format] ?? format, exif: meta.exif };
}

/**
 * Auto-orients via EXIF, re-injects ONLY the allow-listed camera metadata,
 * and encodes AVIF + WebP at each contract width without upscaling.
 *
 * @ai-warning: public variants carry an EXIF ALLOW-LIST (see exif.ts), never
 * `.withMetadata()`. A blanket copy republishes GPS coordinates, XMP and IPTC
 * to anyone who downloads a photo. Widening this is a privacy change, not a
 * refactor.
 */
export async function processImage(
  input: Buffer,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const { avifQuality = 55, webpQuality = 75 } = opts;

  // One metadata-only probe supplies the orientation-corrected size, the
  // original's extension and the EXIF block. The full decode + rotate +
  // full-resolution re-encode in the input format this replaced existed only
  // to read `info.width/height/format`, and was the largest avoidable spike
  // in the measured ~1.94 GB peak RSS (#136) — a 268 MP PNG under the byte
  // cap allocated ~1 GB of pixels plus a PNG encode buffer before any variant.
  // @ai-warning: `probeImage` maps SVG to `png` on purpose — see its doc. The
  // original bytes are passed through untouched so /data/images doubles as a
  // lossless media archive (enables future re-encodes at new widths/formats).
  const { width, height, ext, exif } = await probeImage(input);
  const original: OriginalImage = { data: input, ext };

  // Parsed once: the source EXIF is the same for every variant.
  const keepExif = allowedExif(exif);

  // @ai-warning Deliberately a fresh `sharp(input)` per variant, NOT a base
  // pipeline `.clone()`d per variant as #136 first suggested: sharp 0.35's
  // clone() runs `structuredClone(options)`, which deep-copies the input
  // Buffer — eight extra copies of a 25 MiB upload — while a fresh instance
  // holds the same Buffer by reference. Each awaited encode runs its own
  // libvips pipeline either way, so only one variant's pixels are live at a
  // time; the decode is not shared and cannot be without materialising the
  // full-resolution raw image across all encodes (a larger peak, not a smaller one).
  const variants: Variant[] = [];
  for (const w of variantWidths(width)) {
    for (const format of FORMATS) {
      let base = sharp(input, { failOn: 'none' })
        .rotate()             // applies EXIF orientation to the PIXELS
        .keepIccProfile()     // colour accuracy; an ICC profile carries no location
        .resize({ width: w, withoutEnlargement: true });
      // withExif() REPLACES the EXIF block wholesale, which is exactly the
      // point: anything not in the allow-list cannot survive. Skipped entirely
      // when the source had nothing worth keeping, leaving the variant clean.
      if (keepExif) base = base.withExif(keepExif);
      const data =
        format === 'avif'
          ? await base.avif({ quality: avifQuality }).toBuffer()
          : await base.webp({ quality: webpQuality }).toBuffer();
      variants.push({ width: w, format, data });
    }
  }

  return { width, height, variants, original };
}
