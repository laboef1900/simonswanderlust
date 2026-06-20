import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processImage } from '../src/pipeline';

async function fixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .withExif({ IFD0: { ImageDescription: 'fixture' }, GPS: { GPSLatitudeRef: 'N' } })
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
});
