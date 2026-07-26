import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { auditExif } from '../src/exif-audit.js';

// chmod 0o000 only blocks access for non-root POSIX processes; root and
// Windows don't enforce it, so the permission test below is skipped there
// rather than false-failing.
const CAN_ENFORCE_PERMS = typeof process.getuid === 'function' && process.getuid() !== 0;

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

// GPSInfo present, but without GPSLatitude — e.g. altitude/direction-only
// tags, which a real camera can write independently of a lat/long fix.
async function withGpsInfoButNoLatitude(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withExif({
      IFD0: { Make: 'Leica Camera AG' },
      IFD3: {
        GPSAltitudeRef: '0', GPSAltitude: '100/1',
        GPSImgDirectionRef: 'T', GPSImgDirection: '180/1',
      },
    })
    .webp()
    .toBuffer();
}

// No EXIF GPS at all, but an XMP packet carrying location — the shape
// Capture One and similar export tools write (RDF attribute form).
async function withXmpGpsOnly(): Promise<Buffer> {
  const xmp =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
    'exif:GPSLatitude="63,4.552N" exif:GPSLongitude="10,23.324E"/>' +
    '</rdf:RDF></x:xmpmeta>' +
    '<?xpacket end="w"?>';
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withXmp(xmp)
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

  it('detects GPS carried only in an XMP packet (no EXIF GPS)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-xmp-'));
    await writeFile(join(dir, 'c1-640.webp'), await withXmpGpsOnly());
    const r = await auditExif(dir);
    expect(r.variants).toBe(1);
    expect(r.withGps).toBe(1);
    expect(r.gpsKeys).toEqual(['c1']);
  });

  it('detects a GPSInfo block that has no GPSLatitude tag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-gpsinfo-'));
    await writeFile(join(dir, 'alt-640.webp'), await withGpsInfoButNoLatitude());
    const r = await auditExif(dir);
    expect(r.variants).toBe(1);
    expect(r.withGps).toBe(1);
    expect(r.gpsKeys).toEqual(['alt']);
  });

  it('returns zeros for an empty or missing storage dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-empty-'));
    const r = await auditExif(dir);
    expect(r).toEqual({
      variants: 0, withExif: 0, withGps: 0, keys: 0,
      gpsKeys: [], gpsKeysWithoutOriginal: [], skippedDirs: [],
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

  it.skipIf(!CAN_ENFORCE_PERMS)(
    'records an unreadable subdirectory instead of aborting the scan',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'audit-perm-'));
      await mkdir(join(dir, 'locked'), { recursive: true });
      await writeFile(join(dir, 'locked', 'secret-640.webp'), await withGps());
      await mkdir(join(dir, 'open'), { recursive: true });
      await writeFile(join(dir, 'open', 'visible-640.webp'), await withoutGps());

      await chmod(join(dir, 'locked'), 0o000);
      try {
        const r = await auditExif(dir);
        // The readable half still gets scanned...
        expect(r.variants).toBe(1);
        expect(r.keys).toBe(1);
        expect(r.withGps).toBe(0);
        // ...and the unreadable one is reported, not silently dropped.
        expect(r.skippedDirs).toEqual(['locked']);
      } finally {
        await chmod(join(dir, 'locked'), 0o755);
      }
    },
  );
});
