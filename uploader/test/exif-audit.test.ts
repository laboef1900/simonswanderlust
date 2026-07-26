import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { auditExif } from '../src/exif-audit.js';

async function withGps(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withExif({
      IFD0: { Make: 'Leica Camera AG' },
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
        GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
      },
    })
    .webp()
    .toBuffer();
}

async function withoutGps(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withExif({ IFD0: { Make: 'Leica Camera AG' } })
    .webp()
    .toBuffer();
}

describe('auditExif', () => {
  it('counts variants, EXIF and GPS, and flags keys with no original', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    await mkdir(join(dir, 'trips', 'a'), { recursive: true });
    // key trips/a/leaky — has GPS, has an original
    await writeFile(join(dir, 'trips', 'a', 'leaky-640.webp'), await withGps());
    await writeFile(join(dir, 'trips', 'a', 'leaky-orig.jpg'), Buffer.from('orig'));
    // key trips/a/orphan — has GPS, NO original
    await writeFile(join(dir, 'trips', 'a', 'orphan-640.webp'), await withGps());
    // key trips/a/clean — EXIF but no GPS
    await writeFile(join(dir, 'trips', 'a', 'clean-640.webp'), await withoutGps());

    const r = await auditExif(dir);
    expect(r.variants).toBe(3);
    expect(r.withExif).toBe(3);
    expect(r.withGps).toBe(2);
    expect(r.keys).toBe(3);
    expect(r.gpsKeys.sort()).toEqual(['trips/a/leaky', 'trips/a/orphan']);
    expect(r.gpsKeysWithoutOriginal).toEqual(['trips/a/orphan']);
  });

  it('returns zeros for an empty or missing storage dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-empty-'));
    const r = await auditExif(dir);
    expect(r).toEqual({
      variants: 0, withExif: 0, withGps: 0, keys: 0,
      gpsKeys: [], gpsKeysWithoutOriginal: [],
    });
    expect((await auditExif(join(dir, 'does-not-exist'))).variants).toBe(0);
  });

  it('ignores unreadable files rather than aborting the scan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-bad-'));
    await writeFile(join(dir, 'broken-640.webp'), Buffer.from('not an image'));
    await writeFile(join(dir, 'good-640.webp'), await withGps());
    const r = await auditExif(dir);
    expect(r.variants).toBe(2);
    expect(r.withGps).toBe(1);
  });
});
