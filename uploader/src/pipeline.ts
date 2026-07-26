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

  // Read orientation-corrected intrinsic size from a probe.
  const probe = await sharp(input, { failOn: 'none' })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const width = probe.info.width;
  const height = probe.info.height;
  // With no output format forced, sharp keeps the input format for the probe,
  // so info.format identifies what was uploaded. The original bytes are passed
  // through untouched so /data/images doubles as a lossless media archive
  // (enables future re-encodes at new widths/formats/quality).
  // @ai-warning: vector input is the deliberate exception — sharp rasterizes
  // SVG and the probe reports 'png', so untouched SVG bytes land as
  // `-orig.png` (mislabeled but preserved, and served as image/png). Do NOT
  // "fix" this via sharp(input).metadata().format: a publicly served
  // `-orig.svg` would be a stored-XSS vector on the image host.
  const original: OriginalImage = {
    data: input,
    ext: EXT_BY_FORMAT[probe.info.format] ?? probe.info.format,
  };

  // Parsed once: the source EXIF is the same for every variant.
  const keepExif = allowedExif((await sharp(input, { failOn: 'none' }).metadata()).exif);

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
