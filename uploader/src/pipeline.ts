import sharp from 'sharp';
import { variantWidths, FORMATS, type ImageFormat } from './variants.js';

export interface Variant {
  width: number;
  format: ImageFormat;
  data: Buffer;
}

export interface ProcessResult {
  width: number;
  height: number;
  variants: Variant[];
}

export interface ProcessOptions {
  avifQuality?: number;
  webpQuality?: number;
}

/**
 * Auto-orients via EXIF, preserves all metadata (incl. GPS), and encodes
 * AVIF + WebP at each contract width without upscaling.
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

  const variants: Variant[] = [];
  for (const w of variantWidths(width)) {
    for (const format of FORMATS) {
      const base = sharp(input, { failOn: 'none' })
        .rotate()
        .withMetadata() // keep EXIF (GPS), capture time, ICC
        .resize({ width: w, withoutEnlargement: true });
      const data =
        format === 'avif'
          ? await base.avif({ quality: avifQuality }).toBuffer()
          : await base.webp({ quality: webpQuality }).toBuffer();
      variants.push({ width: w, format, data });
    }
  }

  return { width, height, variants };
}
