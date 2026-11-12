import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  readExif, toRational, allowedExif, cleanExifString, gpsToDecimal, parseExif,
  emptyExposure, emptyMediaExif, exposureValue, normalizeExposure, type MediaExposure,
} from '../src/exif.js';

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
        // #570: stored by the library, deliberately NOT one of the eight
        // published tags — the exact assertion in `allowedExif` proves it.
        FocalLengthIn35mmFilm: '35',
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

const EXIF_IFD_POINTER = 0x8769;
const ISO_SPEED_RATINGS = 0x8827;
const SHORT = 3;
const ASCII = 2;
const UNDEFINED = 7;

/**
 * Raw EXIF bytes whose Exif IFD holds exactly one entry, laid out by hand.
 *
 * @ai-note Needed because libvips normalizes what `withExif()` writes: it
 * stores `ISOSpeedRatings: '100 200'` as the single value 100, so a
 * sharp-authored fixture can never carry an array, a count of 0 or an ASCII
 * value — but a camera's EXIF can, and exif-reader passes each through as a
 * different JS type.
 */
function exifWithPhotoEntry(tag: number, type: number, count: number, value: Buffer): Buffer {
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 12 + 4;   // entry count + one entry + next-IFD offset
  const data = exifIfd + 2 + 12 + 4;
  const inline = value.length <= 4;
  const tiff = Buffer.alloc(data + (inline ? 0 : value.length));
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(ifd0, 4);
  tiff.writeUInt16LE(1, ifd0);
  tiff.writeUInt16LE(EXIF_IFD_POINTER, ifd0 + 2);
  tiff.writeUInt16LE(4, ifd0 + 4);     // LONG
  tiff.writeUInt32LE(1, ifd0 + 6);
  tiff.writeUInt32LE(exifIfd, ifd0 + 10);
  tiff.writeUInt16LE(1, exifIfd);
  tiff.writeUInt16LE(tag, exifIfd + 2);
  tiff.writeUInt16LE(type, exifIfd + 4);
  tiff.writeUInt32LE(count, exifIfd + 6);
  if (inline) value.copy(tiff, exifIfd + 10);
  else { tiff.writeUInt32LE(data, exifIfd + 10); value.copy(tiff, data); }
  return Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
}

function shorts(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16LE(value, i * 2));
  return out;
}

describe('toRational', () => {
  function numeric(value: number): number {
    const encoded = toRational(value);
    expect(encoded).toMatch(/^\d+\/[1-9]\d*$/);
    if (encoded === null) throw new Error('Expected a supported EXIF rational');
    const [numerator, denominator] = encoded.split('/').map(Number);
    if (numerator === undefined || denominator === undefined) throw new Error('Missing rational component');
    return numerator / denominator;
  }

  it.each([0, 0.3, 0.4, 0.5, 0.6, 0.8, 0.95, 0.004, 1 / 8000, 2.8, 28])(
    'preserves the decoded value of %s',
    (value) => { expect(numeric(value)).toBe(value); },
  );

  it('uses reciprocal approximation only within one percent', () => {
    expect(numeric(0.4975)).toBe(0.5);
    expect(numeric(0.49)).toBe(0.49);
    expect(numeric(0.495)).toBe(0.495);
    expect(numeric(0.4951)).toBe(0.5);
    expect(Math.abs(numeric(0.71234) - 0.71234)).toBeLessThanOrEqual(0.0005);
  });

  it('preserves supported tiny values and refuses out-of-range rationals', () => {
    expect(numeric(1 / 4_000_000)).toBe(1 / 4_000_000);
    expect(toRational(1 / 4_000_001)).toBeNull();
    expect(numeric(4_000_000)).toBe(4_000_000);
    expect(toRational(4_000_001)).toBeNull();
  });

  it('rejects non-finite, negative and non-numeric input', () => {
    expect(toRational(Number.NaN)).toBeNull();
    expect(toRational(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toRational(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(toRational(-1)).toBeNull();
    expect(toRational('1/250')).toBeNull();
    expect(toRational(undefined)).toBeNull();
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
    const raw = await rawExif(await geotagged());
    // #570 invariant: the source carries FocalLengthIn35mmFilm (which the
    // library now stores), and the exact assertion below shows it is still
    // not published — the allow-list did not move.
    expect(readExif(raw)?.Photo?.FocalLengthIn35mmFilm).toBe(35);
    const allow = allowedExif(raw);
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

  it('does not publish an array-valued ISO, which the library stores', () => {
    const raw = exifWithPhotoEntry(ISO_SPEED_RATINGS, SHORT, 2, shorts(200, 400));
    expect(parseExif(raw).iso).toBe(200);
    expect(allowedExif(raw)).toBeNull();
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

  it('extracts the exposure settings as numbers from a real round-trip', async () => {
    const out = parseExif(await rawExif(await geotagged()));
    // Five distinct values, so a field wired to the wrong tag cannot pass.
    expect(out).toMatchObject({ focalLength: 28, focalLength35mm: 35, fNumber: 2.8, iso: 400, exposureTime: 0.004 });
  });

  it('returns all-null for missing, empty or garbage EXIF instead of throwing', () => {
    // exif-reader THROWS on malformed input rather than returning null.
    for (const raw of [undefined, Buffer.alloc(0), Buffer.from('not exif at all'), Buffer.from([0xff, 0xd8, 0x00])]) {
      expect(parseExif(raw)).toEqual({
        takenAt: null, camera: null, lens: null, lat: null, lng: null,
        focalLength: null, focalLength35mm: null, fNumber: null, iso: null, exposureTime: null,
      });
    }
  });

  it('never throws on a truncated block, and yields only null or in-range exposure values', async () => {
    const raw = await rawExif(await geotagged());
    if (!raw) throw new Error('fixture has no EXIF');
    for (let length = 0; length <= raw.length; length++) {
      const out = parseExif(raw.subarray(0, length));
      for (const field of Object.keys(emptyExposure()) as (keyof MediaExposure)[]) {
        expect(out[field] === null || exposureValue(field, out[field]) === out[field]).toBe(true);
      }
    }
  });

  // exif-reader returns rationals PRE-DIVIDED, so each malformed form arrives
  // as a different non-value. `double precision` would store the first two.
  it.each([
    ['1/0', Number.POSITIVE_INFINITY],
    ['0/0', Number.NaN],
    ['-5/1', 4294967291], // a negative in an unsigned slot
  ])('stores null for the malformed rational %s, keeping the valid tags beside it', async (rational, decoded) => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .withExif({
        IFD0: { Make: 'Canon' },
        IFD2: { ExposureTime: rational, FNumber: rational, FocalLength: rational, ISOSpeedRatings: '400', FocalLengthIn35mmFilm: '0' },
      }).jpeg().toBuffer();
    const raw = await rawExif(jpeg);
    const photo = readExif(raw)?.Photo;
    expect([photo?.ExposureTime, photo?.FNumber, photo?.FocalLength]).toEqual([decoded, decoded, decoded]);
    const out = parseExif(raw);
    expect(out).toMatchObject({ focalLength: null, fNumber: null, exposureTime: null, iso: 400, camera: 'Canon' });
    // FocalLengthIn35mmFilm 0 means "unknown" in the EXIF standard.
    expect(out.focalLength35mm).toBeNull();
  });

  it('stores null for an out-of-range 35 mm equivalent written as a negative', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .withExif({ IFD2: { FocalLengthIn35mmFilm: '-5' } }).jpeg().toBuffer();
    const raw = await rawExif(jpeg);
    expect(readExif(raw)?.Photo?.FocalLengthIn35mmFilm).toBe(65531);
    expect(parseExif(raw).focalLength35mm).toBeNull();
  });

  describe('ISOSpeedRatings shapes a camera can write (hand-built IFD bytes)', () => {
    const iso = (type: number, count: number, value: Buffer) =>
      parseExif(exifWithPhotoEntry(ISO_SPEED_RATINGS, type, count, value)).iso;

    it('reads the scalar exif-reader returns for count 1', () => {
      expect(iso(SHORT, 1, shorts(800))).toBe(800);
    });

    it('takes the first element of an array (count 2 inline, count 3 by offset)', () => {
      expect(readExif(exifWithPhotoEntry(ISO_SPEED_RATINGS, SHORT, 2, shorts(200, 400)))?.Photo?.ISOSpeedRatings)
        .toEqual([200, 400]);
      expect(iso(SHORT, 2, shorts(200, 400))).toBe(200);
      expect(iso(SHORT, 3, shorts(100, 200, 400))).toBe(100);
    });

    it('uses only the first element: an unusable one is null, not a search for a later value', () => {
      expect(iso(SHORT, 2, shorts(0, 400))).toBeNull();
    });

    it('stores null for count 0, which arrives as an empty array', () => {
      expect(readExif(exifWithPhotoEntry(ISO_SPEED_RATINGS, SHORT, 0, Buffer.alloc(0)))?.Photo?.ISOSpeedRatings).toEqual([]);
      expect(iso(SHORT, 0, Buffer.alloc(0))).toBeNull();
    });

    it('stores null for an ASCII value, which arrives as a string', () => {
      const ascii = Buffer.from('400\0', 'ascii');
      expect(readExif(exifWithPhotoEntry(ISO_SPEED_RATINGS, ASCII, 4, ascii))?.Photo?.ISOSpeedRatings).toBe('400');
      expect(iso(ASCII, 4, ascii)).toBeNull();
    });

    it('stores null for an UNDEFINED value, which arrives as a Buffer', () => {
      expect(iso(UNDEFINED, 2, shorts(400))).toBeNull();
    });
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

describe('emptyMediaExif / emptyExposure', () => {
  it('return every field null, as a fresh object each call', () => {
    expect(emptyExposure()).toEqual({ focalLength: null, focalLength35mm: null, fNumber: null, iso: null, exposureTime: null });
    expect(emptyMediaExif()).toEqual({
      takenAt: null, camera: null, lens: null, lat: null, lng: null,
      focalLength: null, focalLength35mm: null, fNumber: null, iso: null, exposureTime: null,
    });
    const first = emptyMediaExif();
    first.camera = 'mutated';
    expect(emptyMediaExif().camera).toBeNull();
  });
});

describe('exposureValue', () => {
  // Both ends of every closed range, one step inside and one step outside.
  // @ai-warning These bounds are a compatibility contract (widen only): a dump
  // holding a value this rejects is refused by readDump.
  it.each<[keyof MediaExposure, number, number | null]>([
    ['focalLength', 0.4999, null], ['focalLength', 0.5, 0.5], ['focalLength', 0.5001, 0.5001],
    ['focalLength', 4999.9999, 4999.9999], ['focalLength', 5000, 5000], ['focalLength', 5000.0001, null],
    ['focalLength35mm', 0, null], ['focalLength35mm', 1, 1], ['focalLength35mm', 2, 2],
    ['focalLength35mm', 9999, 9999], ['focalLength35mm', 10_000, 10_000], ['focalLength35mm', 10_001, null],
    ['fNumber', 0.4999, null], ['fNumber', 0.5, 0.5], ['fNumber', 0.5001, 0.5001],
    ['fNumber', 511.9999, 511.9999], ['fNumber', 512, 512], ['fNumber', 512.0001, null],
    ['iso', 0, null], ['iso', 1, 1], ['iso', 2, 2],
    ['iso', 9_999_999, 9_999_999], ['iso', 10_000_000, 10_000_000], ['iso', 10_000_001, null],
    ['exposureTime', 0, null], ['exposureTime', -0, null], ['exposureTime', Number.MIN_VALUE, Number.MIN_VALUE],
    ['exposureTime', 1 / 8000, 1 / 8000],
    ['exposureTime', 86_399.9999, 86_399.9999], ['exposureTime', 86_400, 86_400], ['exposureTime', 86_400.0001, null],
  ])('%s: %s -> %s', (field, input, expected) => {
    expect(exposureValue(field, input)).toBe(expected);
  });

  it('rounds the integer fields BEFORE the range check, and leaves the others exact', () => {
    expect(exposureValue('iso', 100.4)).toBe(100);
    expect(exposureValue('iso', 100.5)).toBe(101);
    expect(exposureValue('iso', 0.4)).toBeNull();        // rounds to 0
    expect(exposureValue('iso', 0.5)).toBe(1);
    expect(exposureValue('iso', 10_000_000.4)).toBe(10_000_000);
    expect(exposureValue('iso', 10_000_000.5)).toBeNull(); // rounds past the bound
    expect(exposureValue('focalLength35mm', 27.6)).toBe(28);
    expect(exposureValue('focalLength35mm', 0.4)).toBeNull();
    expect(exposureValue('focalLength35mm', 10_000.4)).toBe(10_000);
    expect(exposureValue('focalLength35mm', 10_000.5)).toBeNull();
    expect(exposureValue('focalLength', 4.3)).toBe(4.3);
    expect(exposureValue('fNumber', 2.8)).toBe(2.8);
    expect(exposureValue('exposureTime', 0.004)).toBe(0.004);
  });

  it.each<keyof MediaExposure>(['focalLength', 'focalLength35mm', 'fNumber', 'iso', 'exposureTime'])(
    '%s: null for anything that is not a finite number in range',
    (field) => {
      for (const bad of [
        Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 4294967291,
        '28', '', [28], [], null, undefined, true, {}, 28n, Buffer.from([28]), new Date(28),
      ]) {
        expect(exposureValue(field, bad)).toBeNull();
      }
    },
  );

  it('never unwraps an array itself — only parseExif knows the reader\'s count-1 quirk', () => {
    expect(exposureValue('iso', [400])).toBeNull();
    expect(exposureValue('iso', 400)).toBe(400);
  });
});

describe('normalizeExposure', () => {
  it('applies the bounds to all five fields and returns exactly those five', () => {
    expect(normalizeExposure({ focalLength: 4.3, focalLength35mm: 23.6, fNumber: 1.8, iso: 124.5, exposureTime: 1 / 500 }))
      .toEqual({ focalLength: 4.3, focalLength35mm: 24, fNumber: 1.8, iso: 125, exposureTime: 1 / 500 });
    expect(normalizeExposure({ focalLength: Number.NaN, focalLength35mm: 0, fNumber: '2.8', iso: [400], exposureTime: -1 }))
      .toEqual(emptyExposure());
    expect(normalizeExposure({})).toEqual(emptyExposure());
    // A whole MediaExif goes in; only the exposure fields come out.
    const exif = { ...emptyMediaExif(), camera: 'Leica Q2', lat: 63.4, lng: 10.4, iso: 200 };
    expect(normalizeExposure(exif)).toEqual({ ...emptyExposure(), iso: 200 });
  });
});
