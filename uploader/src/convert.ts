import sharp from 'sharp';

export interface ConvertOptions {
  quality?: number;
}

/**
 * Convert any sharp-readable image to WebP at its full resolution, auto-orienting
 * via EXIF and preserving all metadata (incl. GPS). Pure format conversion — no
 * resizing and no responsive variants (that's the blog pipeline in pipeline.ts).
 */
export async function convertToWebp(input: Buffer, opts: ConvertOptions = {}): Promise<Buffer> {
  const { quality = 82 } = opts;
  return sharp(input, { failOn: 'none' })
    .rotate()
    .withMetadata()
    .webp({ quality })
    .toBuffer();
}
