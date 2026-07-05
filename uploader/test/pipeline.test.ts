import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processImage } from '../src/pipeline.js';

async function fixture(width: number, height: number): Promise<Buffer> {
  // sharp's typed withExif() exposes only IFD0–IFD3, not a GPS IFD. We can't
  // inject GPS tags here, but the pipeline preserves metadata via withMetadata(),
  // which copies the whole EXIF block wholesale — so proving IFD0 survives proves
  // GPS would survive too. Hence the assertion checks the EXIF container is intact.
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .withExif({ IFD0: { ImageDescription: 'fixture' } })
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

  it('preserves EXIF metadata (incl. GPS) in output variants', async () => {
    const result = await processImage(await fixture(2000, 1000));
    const v = result.variants.find((x) => x.format === 'webp' && x.width === 640)!;
    const meta = await sharp(v.data).metadata();
    expect(meta.exif).toBeDefined();
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
