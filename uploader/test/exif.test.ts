import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readExif, toRational, allowedExif, cleanExifString, gpsToDecimal, parseExif } from '../src/exif.js';

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

describe('gpsToDecimal', () => {
  // @ai-warning: exif-reader returns rationals ALREADY DIVIDED ([63, 4, 33.12]),
  // not as numerator/denominator pairs. Most DMS snippets online assume the
  // pair form and produce garbage here.
  it('converts a pre-divided DMS triple', () => {
    expect(gpsToDecimal([63, 4, 33.12], 'N')).toBeCloseTo(63.0759, 4);
    expect(gpsToDecimal([10, 23, 19.44], 'E')).toBeCloseTo(10.3887, 4);
  });

  it('negates for the S and W hemispheres', () => {
    expect(gpsToDecimal([33, 52, 0], 'S')).toBeCloseTo(-33.8667, 4);
    expect(gpsToDecimal([70, 30, 0], 'W')).toBeCloseTo(-70.5, 4);
  });

  it('returns null for a NaN component — the zero-denominator rational case', () => {
    // This guard is what stops a broken coordinate reaching the database.
    expect(gpsToDecimal([NaN, 0, 0], 'N')).toBeNull();
    expect(gpsToDecimal([63, 4, Number.POSITIVE_INFINITY], 'N')).toBeNull();
  });

  it('returns null for a malformed or out-of-range triple', () => {
    expect(gpsToDecimal(undefined, 'N')).toBeNull();
    expect(gpsToDecimal([63], 'N')).toBeNull();
    expect(gpsToDecimal('63,4,33', 'N')).toBeNull();
    expect(gpsToDecimal([999, 0, 0], 'E')).toBeNull();
    expect(gpsToDecimal(['63', '4', '33'], 'N')).toBeNull();
  });
});

describe('parseExif', () => {
  it('extracts capture time, camera, lens and GPS from a real round-trip', async () => {
    const out = parseExif(await rawExif(await geotagged()));
    expect(out.camera).toBe('Leica Camera AG LEICA Q2');
    expect(out.lens).toBe('SUMMILUX 1:1.7/28 ASPH.');
    expect(out.lat).toBeCloseTo(63.0759, 3);
    expect(out.lng).toBeCloseTo(10.3887, 3);
    // @ai-warning: EXIF wall-clock is relabelled as UTC by exif-reader — read
    // it with getUTC* only, or photos are mislabelled across timezones.
    expect(out.takenAt?.getUTCHours()).toBe(18);
    expect(out.takenAt?.getUTCMinutes()).toBe(23);
  });

  it('returns all-null for missing, empty or garbage EXIF instead of throwing', () => {
    // exif-reader THROWS on malformed input rather than returning null.
    for (const raw of [undefined, Buffer.alloc(0), Buffer.from('not exif at all'), Buffer.from([0xff, 0xd8, 0x00])]) {
      expect(parseExif(raw)).toEqual({ takenAt: null, camera: null, lens: null, lat: null, lng: null });
    }
  });

  it('leaves lat/lng null for a photo with no GPS IFD', async () => {
    const plain = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .withExif({ IFD0: { Make: 'Canon' } }).jpeg().toBuffer();
    const out = parseExif(await rawExif(plain));
    expect(out.camera).toBe('Canon');
    expect(out).toMatchObject({ lat: null, lng: null });
  });

  it('caps an absurdly long camera string', async () => {
    const long = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .withExif({ IFD0: { Model: 'M'.repeat(500) } }).jpeg().toBuffer();
    // The length cap keeps a multi-megabyte Model out of every /media response.
    expect(parseExif(await rawExif(long)).camera?.length).toBeLessThanOrEqual(120);
  });
});
