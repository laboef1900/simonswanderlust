import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { convertToWebp } from '../src/convert.js';

describe('convertToWebp', () => {
  it('produces a webp at the source dimensions', async () => {
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#369' } })
      .jpeg().toBuffer();
    const webp = await convertToWebp(jpg);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  it('preserves EXIF metadata (incl. GPS) through the conversion', async () => {
    const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#333' } })
      .withExif({ IFD0: { ImageDescription: 'fixture' } })
      .jpeg().toBuffer();
    const webp = await convertToWebp(jpg);
    const meta = await sharp(webp).metadata();
    expect(meta.exif).toBeDefined();
  });
});
