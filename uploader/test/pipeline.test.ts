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
async function fixture(width: number, height: number, photo?: Record<string, string>): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .withIccProfile('srgb')
    .withExif({
      IFD0: { ImageDescription: 'fixture', Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD2: { DateTimeOriginal: '2026:07:04 18:23:11', ExposureTime: '1/250', ...photo },
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

  // #136: dimensions now come from the metadata probe instead of a decoded,
  // rotated re-encode. A portrait shot stored landscape with Orientation=6 is
  // where the two could disagree: the reported size and the variant pixels
  // must both be the orientation-corrected ones.
  it('reports orientation-corrected dimensions that match the encoded pixels', async () => {
    const stored = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#357' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await processImage(stored);
    expect({ width: result.width, height: result.height }).toEqual({ width: 800, height: 1200 });
    const full = result.variants.find((v) => v.format === 'webp' && v.width === 800)!;
    const meta = await sharp(full.data).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 800, height: 1200 });
    expect(result.variants.map((v) => v.width).every((w) => w === 640 || w === 800)).toBe(true);
  });

  it('produces avif+webp at each contract width, no upscaling', async () => {
    const result = await processImage(await fixture(2000, 1000));
    const widths = [...new Set(result.variants.map((v) => v.width))].sort((a, b) => a - b);
    expect(widths).toEqual([640, 1280, 1920, 2000]);
    expect(result.variants.filter((v) => v.format === 'avif')).toHaveLength(4);
    expect(result.variants.filter((v) => v.format === 'webp')).toHaveLength(4);
    expect(Math.max(...widths)).toBe(2000); // never exceeds source
  });

  it('emits JPEG-only responsive variants for real JPEG input when conversion is off', async () => {
    const result = await processImage(await fixture(2000, 1000), { convertJpeg: false });
    expect(result.format).toBe('jpeg');
    expect(result.variants.map((v) => v.format)).toEqual(['jpeg', 'jpeg', 'jpeg', 'jpeg']);
    for (const variant of result.variants) {
      const meta = await sharp(variant.data).metadata();
      expect(meta.format).toBe('jpeg');
      const tags = meta.exif ? exifReader(meta.exif) : null;
      expect(tags?.GPSInfo ?? null, `jpeg@${variant.width} leaked GPS`).toBeNull();
      expect(tags?.Image?.Make).toBe('Leica Camera AG');
      expect(tags?.Image?.Model).toBe('LEICA Q2');
    }
  });

  it('keeps non-JPEG inputs on the modern pair even when JPEG conversion is off', async () => {
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#246' },
    }).png().toBuffer();
    const result = await processImage(png, { convertJpeg: false });
    expect(result.format).toBeUndefined();
    expect(new Set(result.variants.map((v) => v.format))).toEqual(new Set(['avif', 'webp']));
  });

  it('decodes AVIF input without relabeling it as JPEG when conversion is disabled', async () => {
    const avif = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#246' } })
      .avif().toBuffer();
    const result = await processImage(avif, { convertJpeg: false });
    expect({ width: result.width, height: result.height, format: result.format })
      .toEqual({ width: 32, height: 24, format: undefined });
    expect(result.original.ext).toBe('avif');
    expect(result.original.data.equals(avif)).toBe(true);
    expect(new Set(result.variants.map((variant) => variant.format))).toEqual(new Set(['avif', 'webp']));
  });

  it('applies custom modern qualities without changing the format contract', async () => {
    const input = await fixture(320, 240);
    const low = await processImage(input, { avifQuality: 1, webpQuality: 1 });
    const high = await processImage(input, { avifQuality: 100, webpQuality: 100 });
    expect(low.format).toBeUndefined();
    expect(high.format).toBeUndefined();
    expect(low.variants.map((v) => v.data.equals(high.variants.find(
      (other) => other.width === v.width && other.format === v.format,
    )!.data))).toContain(false);
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

  it('keeps camera metadata but removes GPS from every variant decoded from AVIF', async () => {
    const avif = await sharp(await fixture(800, 600)).withMetadata().avif().toBuffer();
    const inputExif = (await sharp(avif).metadata()).exif;
    expect(inputExif).toBeDefined();
    expect(exifReader(inputExif!).GPSInfo).toBeDefined();
    const result = await processImage(avif);
    expect(result.original.ext).toBe('avif');
    expect(result.original.data.equals(avif)).toBe(true);
    expect(result.variants.map(({ width, format }) => `${width}:${format}`).sort())
      .toEqual(['640:avif', '640:webp', '800:avif', '800:webp']);
    for (const variant of result.variants) {
      const meta = await sharp(variant.data).metadata();
      const tags = meta.exif ? exifReader(meta.exif) : null;
      expect(tags?.GPSInfo ?? null, `${variant.format}@${variant.width} leaked GPS`).toBeNull();
      expect(tags?.Image?.Make).toBe('Leica Camera AG');
      expect(tags?.Image?.Model).toBe('LEICA Q2');
      expect([meta.width, meta.height]).toEqual([variant.width, variant.width * 3 / 4]);
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

  it.each([
    { exposure: '4/5', value: 0.8 },
    { exposure: '2/5', value: 0.4 },
    { exposure: '3/5', value: 0.6 },
    { exposure: '1/8000', value: 1 / 8000 },
  ])('preserves $exposure exposure and sub-unit aperture across output profiles', async ({ exposure, value }) => {
    const original = await fixture(800, 600, { ExposureTime: exposure, FNumber: '19/20' });
    const inputExif = (await sharp(original).metadata()).exif;
    expect(inputExif).toBeDefined();
    const input = exifReader(inputExif!);
    expect(input.Photo?.ExposureTime).toBeCloseTo(value, 10);
    expect(input.Photo?.FNumber).toBeCloseTo(0.95, 10);
    expect(input.GPSInfo).toBeDefined();

    for (const convertJpeg of [true, false]) {
      const result = await processImage(original, { convertJpeg });
      expect(result.original.data.equals(original)).toBe(true);
      expect(new Set(result.variants.map((variant) => `${variant.width}:${variant.format}`))).toEqual(
        new Set(convertJpeg
          ? ['640:avif', '640:webp', '800:avif', '800:webp']
          : ['640:jpeg', '800:jpeg']),
      );
      for (const variant of result.variants) {
        const exif = (await sharp(variant.data).metadata()).exif;
        expect(exif).toBeDefined();
        const tags = exifReader(exif!);
        expect(tags.Photo?.ExposureTime).toBeCloseTo(value, 10);
        expect(tags.Photo?.FNumber).toBeCloseTo(0.95, 10);
        expect(tags.Image?.Make).toBe('Leica Camera AG');
        expect(tags.Image?.Model).toBe('LEICA Q2');
        expect(tags.GPSInfo ?? null).toBeNull();
        expect(tags.Image?.ImageDescription).toBeUndefined();
        expect(tags.Image?.Orientation === undefined || tags.Image.Orientation === 1).toBe(true);
      }
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
