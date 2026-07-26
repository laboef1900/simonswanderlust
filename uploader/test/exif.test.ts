import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readExif, toRational, allowedExif, cleanExifString } from '../src/exif.js';

/** A JPEG carrying camera tags, a full GPS IFD, and an ICC profile. */
async function geotagged(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 20, channels: 3, background: { r: 90, g: 120, b: 150 } },
  })
    .withIccProfile('srgb')
    .withExif({
      IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD2: {
        DateTimeOriginal: '2026:07:04 18:23:11',
        LensModel: 'SUMMILUX 1:1.7/28 ASPH.',
        ExposureTime: '1/250',
        FNumber: '28/10',
        ISOSpeedRatings: '400',
        FocalLength: '28/1',
      },
      // @ai-note: libvips maps IFD3 to the GPS IFD. An older comment in
      // pipeline.test.ts claimed GPS could not be injected here; it was wrong.
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
        GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
      },
    })
    .jpeg()
    .toBuffer();
}

const rawExif = async (buf: Buffer): Promise<Buffer | undefined> =>
  (await sharp(buf).metadata()).exif;

describe('toRational', () => {
  it('encodes sub-second exposures as reciprocals without losing precision', () => {
    expect(toRational(0.004)).toBe('1/250');
    expect(toRational(1 / 8000)).toBe('1/8000');
  });

  it('encodes values >= 1 with a fixed denominator', () => {
    expect(toRational(2.8)).toBe('2800/1000');
    expect(toRational(28)).toBe('28000/1000');
  });

  it('rejects non-finite, negative and non-numeric input', () => {
    expect(toRational(Number.NaN)).toBeNull();
    expect(toRational(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toRational(-1)).toBeNull();
    expect(toRational('1/250')).toBeNull();
    expect(toRational(undefined)).toBeNull();
  });

  it('encodes zero without dividing by it', () => {
    expect(toRational(0)).toBe('0/1');
  });
});

describe('cleanExifString', () => {
  // @ai-note: tested DIRECTLY rather than through a sharp-authored fixture.
  // libvips TRUNCATES a string at the first NUL when *writing* EXIF, so a
  // fixture built with withExif() can never carry one — but a real camera's
  // EXIF can, and sharp only reads that. The unit test is the honest one.
  it('strips NUL and other control characters', () => {
    expect(cleanExifString('Le' + String.fromCharCode(0) + 'ica')).toBe('Leica');
    expect(cleanExifString('A' + String.fromCharCode(31) + 'B')).toBe('AB');
    expect(cleanExifString(String.fromCharCode(127) + 'X')).toBe('X');
  });

  it('caps length at 120 and trims', () => {
    expect(cleanExifString('M'.repeat(500))).toHaveLength(120);
    expect(cleanExifString('  spaced  ')).toBe('spaced');
  });

  it('returns null for non-strings and for strings that clean to nothing', () => {
    expect(cleanExifString(42)).toBeNull();
    expect(cleanExifString(undefined)).toBeNull();
    expect(cleanExifString(String.fromCharCode(0))).toBeNull();
    expect(cleanExifString('   ')).toBeNull();
  });
});

describe('readExif', () => {
  it('parses camera, lens, time and GPS from a real buffer', async () => {
    const tags = readExif(await rawExif(await geotagged()));
    expect(tags?.Image?.Make).toBe('Leica Camera AG');
    expect(tags?.Photo?.LensModel).toBe('SUMMILUX 1:1.7/28 ASPH.');
    expect(tags?.GPSInfo?.GPSLatitude).toEqual([63, 4, 33.12]);
  });

  it('returns null instead of throwing for absent, empty and malformed EXIF', () => {
    expect(readExif(undefined)).toBeNull();
    expect(readExif(Buffer.alloc(0))).toBeNull();
    expect(readExif(Buffer.from('not exif at all'))).toBeNull();
    // Valid 'Exif\0\0II' header, truncated body -> exif-reader throws
    // "Ends before ifdOffset" rather than returning null. readExif swallows it.
    const truncated = Buffer.concat([
      Buffer.from('Exif'), Buffer.alloc(2),
      Buffer.from('II'), Buffer.from([0x2a, 0x00, 0x08]),
    ]);
    expect(readExif(truncated)).toBeNull();
  });
});

describe('allowedExif', () => {
  it('keeps exactly the eight approved tags', async () => {
    const allow = allowedExif(await rawExif(await geotagged()));
    expect(allow).toEqual({
      IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD2: {
        LensModel: 'SUMMILUX 1:1.7/28 ASPH.',
        DateTimeOriginal: '2026:07:04 18:23:11',
        ExposureTime: '1/250',
        FNumber: '2800/1000',
        ISOSpeedRatings: '400',
        FocalLength: '28000/1000',
      },
    });
  });

  it('never emits a GPS IFD, whatever the source carries', async () => {
    const allow = allowedExif(await rawExif(await geotagged()));
    expect(JSON.stringify(allow)).not.toMatch(/GPS/i);
    expect(allow).not.toHaveProperty('IFD3');
  });

  it('never emits Orientation (variants are already rotated)', async () => {
    const allow = allowedExif(await rawExif(await geotagged()));
    expect(allow?.IFD0).not.toHaveProperty('Orientation');
  });

  it('returns null when there is no EXIF to carry forward', async () => {
    const plain = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();
    expect(allowedExif(await rawExif(plain))).toBeNull();
    expect(allowedExif(undefined)).toBeNull();
  });

  it('caps absurdly long strings from a real EXIF round-trip', async () => {
    const long = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withExif({ IFD0: { Model: 'M'.repeat(500) } })
      .jpeg()
      .toBuffer();
    const allow = allowedExif(await rawExif(long));
    expect(allow?.IFD0.Model).toHaveLength(120);
  });

  it('formats DateTimeOriginal from UTC accessors, not local time', async () => {
    // exif-reader relabels naive wall-clock as UTC. Formatting with local
    // accessors would shift the timestamp by the runner's offset.
    const allow = allowedExif(await rawExif(await geotagged()));
    expect(allow?.IFD2.DateTimeOriginal).toBe('2026:07:04 18:23:11');
  });
});
