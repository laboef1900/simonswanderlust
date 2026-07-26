import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { processImage } from '../src/pipeline.js';

/**
 * A JPEG carrying camera tags AND a real GPS IFD.
 * @ai-note: libvips maps IFD3 to the GPS IFD, so GPS *can* be injected here.
 * A previous comment claimed otherwise and settled for asserting only that
 * "the EXIF container is intact" — which is why the GPS leak went unnoticed.
 */
async function fixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .withIccProfile('srgb')
    .withExif({
      IFD0: { ImageDescription: 'fixture', Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD2: { DateTimeOriginal: '2026:07:04 18:23:11', ExposureTime: '1/250' },
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
        GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
      },
    })
    .jpeg()
    .toBuffer();
}

describe('processImage', () => {
  it('reports intrinsic dimensions', async () => {
    const result = await processImage(await fixture(2000, 1000));
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
  });

  it('produces avif+webp at each contract width, no upscaling', async () => {
    const result = await processImage(await fixture(2000, 1000));
    const widths = [...new Set(result.variants.map((v) => v.width))].sort((a, b) => a - b);
    expect(widths).toEqual([640, 1280, 1920, 2000]);
    expect(result.variants.filter((v) => v.format === 'avif')).toHaveLength(4);
    expect(result.variants.filter((v) => v.format === 'webp')).toHaveLength(4);
    expect(Math.max(...widths)).toBe(2000); // never exceeds source
  });

  it('only emits the intrinsic width for tiny sources', async () => {
    const result = await processImage(await fixture(500, 400));
    expect([...new Set(result.variants.map((v) => v.width))]).toEqual([500]);
  });

  it('never emits GPS in any output variant', async () => {
    const result = await processImage(await fixture(2000, 1000));
    // Every variant, both formats, every width — not just a sample.
    for (const v of result.variants) {
      const meta = await sharp(v.data).metadata();
      const tags = meta.exif ? exifReader(meta.exif) : null;
      expect(tags?.GPSInfo ?? null, `${v.format}@${v.width} leaked GPS`).toBeNull();
    }
  });

  it('keeps camera, model and capture time in output variants', async () => {
    const result = await processImage(await fixture(2000, 1000));
    for (const fmt of ['avif', 'webp'] as const) {
      const v = result.variants.find((x) => x.format === fmt && x.width === 640)!;
      const tags = exifReader((await sharp(v.data).metadata()).exif!);
      expect(tags.Image?.Make).toBe('Leica Camera AG');
      expect(tags.Image?.Model).toBe('LEICA Q2');
      expect(tags.Photo?.DateTimeOriginal?.toISOString()).toBe('2026-07-04T18:23:11.000Z');
      expect(tags.Photo?.ExposureTime).toBeCloseTo(0.004, 6);
    }
  });

  it('drops non-allow-listed EXIF such as ImageDescription', async () => {
    const result = await processImage(await fixture(800, 600));
    const v = result.variants.find((x) => x.format === 'webp')!;
    const tags = exifReader((await sharp(v.data).metadata()).exif!);
    expect(tags.Image?.ImageDescription).toBeUndefined();
  });

  it('keeps the ICC profile (colour accuracy) while dropping location', async () => {
    const result = await processImage(await fixture(800, 600));
    const v = result.variants.find((x) => x.format === 'webp')!;
    expect((await sharp(v.data).metadata()).icc).toBeDefined();
  });

  it('does not re-embed Orientation (already applied by rotate)', async () => {
    const result = await processImage(await fixture(800, 600));
    for (const v of result.variants) {
      const meta = await sharp(v.data).metadata();
      const tags = meta.exif ? exifReader(meta.exif) : null;
      // undefined or 1 ("normal") are both fine; anything else double-rotates.
      const o = tags?.Image?.Orientation;
      expect(o === undefined || o === 1, `${v.format}@${v.width} orientation=${o}`).toBe(true);
    }
  });

  it('still produces valid variants for an image with no EXIF at all', async () => {
    const plain = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 5, g: 6, b: 7 } },
    }).jpeg().toBuffer();
    const result = await processImage(plain);
    expect(result.width).toBe(900);
    expect(result.variants.length).toBeGreaterThan(0);
    const meta = await sharp(result.variants[0]!.data).metadata();
    expect(meta.width).toBeGreaterThan(0);
  });

  it('returns the untouched original bytes with the detected extension', async () => {
    const jpg = await fixture(800, 600);
    const fromJpg = await processImage(jpg);
    expect(fromJpg.original.data.equals(jpg)).toBe(true);
    expect(fromJpg.original.ext).toBe('jpg');

    const png = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    const fromPng = await processImage(png);
    expect(fromPng.original.data.equals(png)).toBe(true);
    expect(fromPng.original.ext).toBe('png');
  });

  it('labels SVG originals as png (rasterized probe), never svg', async () => {
    // Pins the deliberate relabeling: sharp rasterizes SVG, so the probe
    // reports 'png' and the untouched SVG bytes are stored as `-orig.png`.
    // Guard: switching the derivation to metadata().format could yield a
    // publicly served `-orig.svg`, a stored-XSS vector on the image host.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>',
    );
    const result = await processImage(svg);
    expect(result.original.data.equals(svg)).toBe(true);
    expect(result.original.ext).toBe('png');
  });
});
