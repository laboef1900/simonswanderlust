# Phase 0 — EXIF Privacy & Upload Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the image pipeline from publishing EXIF GPS coordinates, stop `POST /upload` from silently discarding files in a multi-file request, and give the operator read-only tools to audit and (only if needed) remediate the existing corpus.

**Architecture:** `pipeline.ts` currently calls `.withMetadata()`, which copies the whole EXIF/XMP/IPTC block into every public variant. It is replaced by an explicit **allow-list re-injection**: parse the source EXIF with `exif-reader`, rebuild only eight approved tags, and write them back via `withExif()` alongside `keepIccProfile()`. Everything not on the list — the GPS IFD, XMP, IPTC, Orientation — is dropped by construction rather than by removal. Separately, `@fastify/multipart` gains `files`/`parts` limits so a multi-file request fails loudly instead of losing data.

**Tech Stack:** Node 26, TypeScript 6 (strict), Fastify 5, sharp 0.35.3, `exif-reader` 2.0.3 (new), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md` §Defects Fixed (Phase 0).

## Global Constraints

- **Golden Rule 1 — Tests Required.** Every change here is covered by Vitest. Run `npm test` and `npx typecheck` in `uploader/` before claiming done.
- **Golden Rule 7 — Strict Typing.** No `any`, no `@ts-ignore`, no suppressions. `tsconfig` extends strict.
- **Golden Rule 3 — Data Safety.** Nothing in this phase deletes or overwrites stored images except `strip-gps`, which is audit-gated, `--dry-run`-capable, atomic, and requires a backup first.
- **Golden Rule 5 — No Secrets.** No `.env` changes in this phase.
- All work happens in `uploader/`. `site/` is untouched by Phase 0.
- Commands run from `/Users/simon/Documents/localGIT/simonswanderlust/uploader`.
- Branch: `feature/phase-0-exif-privacy`.
- **The allow-list is exactly these eight tags** (verified to round-trip on both WebP and AVIF): `Make`, `Model` (IFD0); `LensModel`, `DateTimeOriginal`, `ExposureTime`, `FNumber`, `ISOSpeedRatings`, `FocalLength` (IFD2). Plus the ICC profile. Nothing else.
- **`Orientation` is never re-injected.** Variants are already auto-oriented by `.rotate()`; re-embedding it would double-rotate on display.
- **`taken_at`/`DateTimeOriginal` is wall-clock with no zone.** `exif-reader` relabels it as UTC, so it must be read and formatted with `getUTC*` accessors only.

---

### Task 1: `exif.ts` — safe EXIF read and the allow-list builder

**Files:**
- Create: `uploader/src/exif.ts`
- Create: `uploader/test/exif.test.ts`
- Modify: `uploader/package.json` (add `exif-reader` dependency)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function readExif(raw: Buffer | undefined): ExifTags | null` — never throws.
  - `export function cleanExifString(v: unknown): string | null` — strips control chars, NFC-normalises, trims, caps at 120.
  - `export function toRational(v: unknown): string | null` — EXIF unsigned rational string.
  - `export function allowedExif(raw: Buffer | undefined): AllowedExif | null` — the `withExif()` input, or `null` when there is nothing to write.
  - `export interface AllowedExif { IFD0: Record<string, string>; IFD2: Record<string, string> }`
  - `export type ExifTags = ReturnType<typeof exifReader>`

  Phase 2 extends this same module with `parseExif(raw): MediaExif` for the database. Do **not** add it here — nothing in Phase 0 consumes it.

- [ ] **Step 1: Add the dependency**

```bash
npm install --save exif-reader@2.0.3
```

Verify it is the right package before trusting it (Golden Rule: Dependency Integrity):

```bash
npm view exif-reader repository.url   # expect git://github.com/devongovett/exif-reader.git
npm view exif-reader dependencies     # expect {} (zero deps)
npm ls exif-reader                     # expect exif-reader@2.0.3
```

`exif-reader` ships its own `.d.ts`, so **no `@types/*` package is needed**. It has no install script, so `allowScripts` in `package.json` needs no new entry.

- [ ] **Step 2: Write the failing tests**

Create `uploader/test/exif.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/exif.test.ts`
Expected: FAIL — `Failed to resolve import "../src/exif.js"`.

- [ ] **Step 4: Write the implementation**

Create `uploader/src/exif.ts`:

```ts
import exifReader from 'exif-reader';

/**
 * EXIF handling for the image pipeline.
 *
 * @ai-warning: this module decides what metadata reaches PUBLIC image files.
 * It is an allow-list, not a filter: anything not explicitly listed in
 * ALLOW is dropped by construction. Widening it is a privacy change, not a
 * refactor — see the D1 section of
 * docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md.
 *
 * @ai-context: sharp exposes EXIF as raw bytes only (`metadata().exif`), so a
 * parser is genuinely required. exif-reader is the sharp-blessed one (shared
 * maintainer) and has zero dependencies and no install script.
 */

export type ExifTags = ReturnType<typeof exifReader>;

export interface AllowedExif {
  IFD0: Record<string, string>;
  IFD2: Record<string, string>;
}

/** Longest metadata string written to a variant or (in Phase 2) the database. */
const MAX_STR = 120;

/**
 * Parse raw EXIF bytes, or null when absent/unparseable.
 *
 * @ai-warning: exif-reader THROWS on malformed input rather than returning
 * null, and on partial corruption it can succeed with `Image: null` — its
 * bundled .d.ts understates that nullability. Callers must use optional
 * chaining, never truthiness.
 */
export function readExif(raw: Buffer | undefined): ExifTags | null {
  if (!raw || raw.length === 0) return null;
  try {
    return exifReader(raw);
  } catch {
    return null;
  }
}

/**
 * Sanitize a metadata string before it reaches a file or the database.
 *
 * The NUL strip is not cosmetic: Postgres `text` rejects a NUL byte outright,
 * so a crafted JPEG would otherwise 500 every upload of that file. The length
 * cap stops a multi-megabyte `Model` entering every media listing response.
 *
 * @ai-note: exported solely so it can be unit-tested directly. libvips
 * truncates strings at the first NUL when *writing* EXIF, so a sharp-authored
 * test fixture cannot carry one — but a real camera's EXIF can, and sharp only
 * reads that. Testing through a fixture would silently prove nothing.
 */
export function cleanExifString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()
    .slice(0, MAX_STR);
  return s || null;
}

/**
 * Encode a number as an EXIF unsigned rational string.
 *
 * @ai-note: exif-reader returns rationals PRE-DIVIDED (0.004, not 1/250), so
 * this re-encodes. Sub-second values become reciprocals because that is how
 * cameras record shutter speed and a /1000 denominator would round 1/8000 to
 * zero. Values >= 1 use a fixed /1000 denominator, which is exact enough for
 * apertures and focal lengths.
 */
export function toRational(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  if (v === 0) return '0/1';
  if (v < 1) {
    const den = Math.round(1 / v);
    if (den > 0 && den <= 4_000_000) return `1/${den}`;
    return null;
  }
  const num = Math.round(v * 1000);
  if (num > 4_000_000_000) return null;
  return `${num}/1000`;
}

/**
 * Format an exif-reader Date as an EXIF datetime string.
 *
 * @ai-warning: EXIF stores naive local wall-clock with no zone, and
 * exif-reader relabels those digits as UTC (`new Date(Date.UTC(...))`). Read
 * them back with getUTC* ONLY — local accessors double-shift the timestamp.
 */
function formatExifDate(d: unknown): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/**
 * Build the `sharp.withExif()` input containing ONLY the approved tags.
 * Returns null when nothing survives, so the caller can skip withExif entirely.
 */
export function allowedExif(raw: Buffer | undefined): AllowedExif | null {
  const tags = readExif(raw);
  if (!tags) return null;

  const IFD0: Record<string, string> = {};
  const IFD2: Record<string, string> = {};
  const put = (into: Record<string, string>, k: string, v: string | null): void => {
    if (v !== null) into[k] = v;
  };

  put(IFD0, 'Make', cleanExifString(tags.Image?.Make));
  put(IFD0, 'Model', cleanExifString(tags.Image?.Model));

  put(IFD2, 'LensModel', cleanExifString(tags.Photo?.LensModel));
  put(IFD2, 'DateTimeOriginal', formatExifDate(tags.Photo?.DateTimeOriginal));
  put(IFD2, 'ExposureTime', toRational(tags.Photo?.ExposureTime));
  put(IFD2, 'FNumber', toRational(tags.Photo?.FNumber));
  put(
    IFD2,
    'ISOSpeedRatings',
    Number.isFinite(tags.Photo?.ISOSpeedRatings)
      ? String(Math.round(Number(tags.Photo?.ISOSpeedRatings)))
      : null,
  );
  put(IFD2, 'FocalLength', toRational(tags.Photo?.FocalLength));

  if (Object.keys(IFD0).length === 0 && Object.keys(IFD2).length === 0) return null;
  return { IFD0, IFD2 };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/exif.test.ts`
Expected: PASS — all cases green.

If the `ISOSpeedRatings` assertion fails because `exif-reader` returned an array (some bodies write it as a list), change the implementation to take `Array.isArray(v) ? v[0] : v` before the `Number.isFinite` check, and add a test case for the array form. Do not loosen the assertion.

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/exif.ts test/exif.test.ts
git commit -m "feat(uploader): add EXIF allow-list builder

Parses source EXIF with exif-reader and rebuilds only the eight approved
camera tags. GPS, XMP, IPTC and Orientation are dropped by construction."
```

---

### Task 2: Replace `withMetadata()` with the allow-list in `pipeline.ts`

**Files:**
- Modify: `uploader/src/pipeline.ts:34-80`
- Modify: `uploader/test/pipeline.test.ts:5-16` (the fixture and its wrong comment), `:39-44` (the test that currently asserts the leak)

**Interfaces:**
- Consumes: `allowedExif(raw)` and `AllowedExif` from Task 1.
- Produces: `processImage()` keeps its exact existing signature — `(input: Buffer, opts?: ProcessOptions) => Promise<ProcessResult>`. No caller changes anywhere.

- [ ] **Step 1: Replace the misleading test fixture and the test that pins the leak**

The existing fixture comment is factually wrong and the existing EXIF test asserts the defect. In `uploader/test/pipeline.test.ts`, replace lines 5-16 (the `fixture` helper) with:

```ts
import exifReader from 'exif-reader';

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
```

Then **delete** the existing test at lines 39-44 (`'preserves EXIF metadata (incl. GPS) in output variants'`) and put these in its place:

```ts
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
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — `'never emits GPS in any output variant'` fails with a populated `GPSInfo`, because `withMetadata()` is still copying it. That failure **is** the reproduction of D1.

- [ ] **Step 3: Implement the allow-list in the pipeline**

In `uploader/src/pipeline.ts`, add the import at the top:

```ts
import { allowedExif } from './exif.js';
```

Replace the doc comment on `processImage` (lines 34-37):

```ts
/**
 * Auto-orients via EXIF, re-injects ONLY the allow-listed camera metadata,
 * and encodes AVIF + WebP at each contract width without upscaling.
 *
 * @ai-warning: public variants carry an EXIF ALLOW-LIST (see exif.ts), never
 * `.withMetadata()`. A blanket copy republishes GPS coordinates, XMP and IPTC
 * to anyone who downloads a photo. Widening this is a privacy change, not a
 * refactor.
 */
```

Then compute the allow-list once, before the variant loop (it is identical for every variant, and parsing per variant would be wasted work):

```ts
  // Parsed once: the source EXIF is the same for every variant.
  const keepExif = allowedExif((await sharp(input, { failOn: 'none' }).metadata()).exif);
```

And replace the variant-building block (lines 65-77) with:

```ts
  const variants: Variant[] = [];
  for (const w of variantWidths(width)) {
    for (const format of FORMATS) {
      let base = sharp(input, { failOn: 'none' })
        .rotate()             // applies EXIF orientation to the PIXELS
        .keepIccProfile()     // colour accuracy; an ICC profile carries no location
        .resize({ width: w, withoutEnlargement: true });
      // withExif() REPLACES the EXIF block wholesale, which is exactly the
      // point: anything not in the allow-list cannot survive. Skipped entirely
      // when the source had nothing worth keeping, leaving the variant clean.
      if (keepExif) base = base.withExif(keepExif);
      const data =
        format === 'avif'
          ? await base.avif({ quality: avifQuality }).toBuffer()
          : await base.webp({ quality: webpQuality }).toBuffer();
      variants.push({ width: w, format, data });
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pipeline.test.ts`
Expected: PASS — all cases, including the four pre-existing ones (dimensions, contract widths, tiny sources, untouched originals, SVG relabelling), which must **not** have changed behaviour.

- [ ] **Step 5: Run the whole uploader suite and type-check**

Run: `npm test && npm run typecheck`
Expected: PASS. `storage.test.ts`, `server.test.ts` and `wp-images` paths all call `processImage` and must be unaffected — its signature and return shape are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "fix(uploader): stop publishing EXIF GPS in image variants

processImage used .withMetadata(), copying the whole EXIF/XMP/IPTC block
into every public variant — including GPS coordinates. Replaced with an
explicit allow-list re-injection (exif.ts) plus keepIccProfile().

The previous test asserted only that the EXIF container was non-empty,
which is why this went unnoticed; it now asserts GPSInfo is null on every
variant at every width in both formats."
```

---

### Task 3: Reject multi-file uploads instead of silently discarding them

**Files:**
- Modify: `uploader/src/server.ts:103` (multipart registration), `:157-186` (the upload handler comment)
- Modify: `uploader/test/server.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. `POST /upload` behaviour only.

- [ ] **Step 1: Write the failing test**

Add these inside the existing `describe('POST /upload', ...)` block in `uploader/test/server.test.ts`. They reuse the file's established helpers — `build()`, `authed(b)` (returns `{ cookie }`), `jpeg()`, and the `form-data` package already imported at the top — rather than introducing parallel ones:

```ts
  it('rejects a multi-file upload instead of silently keeping only the last', async () => {
    // @ai-context: the handler reassigns `buf` on every file part, so N files
    // meant N-1 were fully buffered into memory and then dropped, with the last
    // one stored under the single `key`. Silent data loss, not an unsupported
    // feature — and bulk upload makes multi-file requests an obvious attempt.
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/x/photo');
    form.append('alt', 'a');
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    form.append('file', await jpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    // @fastify/multipart raises FST_FILES_LIMIT, typed 413 by createError, from
    // inside req.parts() — before the handler ever sees the second file. A
    // handler-level 400 is therefore unreachable by construction.
    expect(res.statusCode).toBe(413);
  });

  it('still accepts a single-file upload unchanged', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const form = new FormData();
    form.append('key', 'trips/x/photo');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await b.app.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().src).toMatch(
      /^https:\/\/img\.simonswanderlust\.com\/trips\/x\/photo-[0-9a-f]{8}$/,
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts -t 'multi-file'`
Expected: FAIL — status is 200, not 413, because both files are accepted and the last silently wins.

- [ ] **Step 3: Add the limits**

In `uploader/src/server.ts`, replace line 103:

```ts
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
```

with:

```ts
  // @ai-warning: `files: 1` is a data-integrity guard, not a convenience limit.
  // POST /upload reads one file into a single `buf`, so a multi-file request
  // used to buffer every file and silently keep only the last. Bulk upload is
  // N single-file requests by design.
  // `parts` also matters: @fastify/multipart's parser never consumes the body,
  // so Fastify's 1 MiB bodyLimit does NOT apply to multipart — without a cap,
  // one authenticated request could stream ~25 GB.
  app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, parts: 8 },
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS — the multi-file case returns 413 and every existing upload test still passes.

If the single-file test now fails with 413, the `parts: 8` cap is too low for the form (`key` + `alt` + `file` = 3 parts, so 8 is ample) — check whether the test helper is appending extra fields before raising it.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "fix(uploader): reject multi-file uploads instead of dropping files

The /upload handler reassigned buf per file part, so a multi-file request
buffered every file and silently stored only the last. multipart now caps
files:1 and parts:8, which also closes the unbounded-stream hole left by
bodyLimit not applying to multipart."
```

---

### Task 4: Give the server ownership of upload timeouts

**Files:**
- Modify: `uploader/src/server.ts:57` (the `Fastify({...})` call)
- Modify: `uploader/test/server.test.ts` (one assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
  it('sets an explicit request timeout so the proxy does not own the failure', () => {
    // @ai-context: encoding a 24MP frame takes ~19s; behind nginx's default
    // 60s proxy_read_timeout a slow upload 504s with no server-side trace.
    // An explicit timeout means the server logs and owns the failure instead.
    expect(app.initialConfig.requestTimeout).toBe(120_000);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts -t 'request timeout'`
Expected: FAIL — received `0` (Fastify's default: never time out).

- [ ] **Step 3: Implement**

In `uploader/src/server.ts`, change line 57:

```ts
  const app = Fastify({ logger: false, trustProxy: true });
```

to:

```ts
  // @ai-note: 120s comfortably exceeds the ~19s encode of a 24MP frame plus
  // transfer, while still bounding a stalled connection. Without it Fastify
  // never times out (default 0) and the reverse proxy decides instead — which
  // means a 504 with nothing in the app's logs.
  const app = Fastify({ logger: false, trustProxy: true, requestTimeout: 120_000 });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "fix(uploader): set an explicit requestTimeout

Fastify defaults to 0 (never), leaving a stalled upload to be killed by the
reverse proxy with no server-side trace."
```

---

### Task 5: `audit-exif` — read-only exposure report

**Files:**
- Create: `uploader/src/exif-audit.ts`
- Create: `uploader/test/exif-audit.test.ts`
- Modify: `uploader/src/cli.ts:109-123` (`main`, to add the subcommand)

**Interfaces:**
- Consumes: `readExif` from Task 1; `VARIANT_FILE_RE` and `isOriginalFile` from `media.ts`/`storage.ts`.
- Produces: `export async function auditExif(storageDir: string): Promise<ExifAudit>` where
  `export interface ExifAudit { variants: number; withExif: number; withGps: number; keys: number; gpsKeys: string[]; gpsKeysWithoutOriginal: string[] }`

**Why this exists:** a read-only scan of the local corpus found 102 variants carrying EXIF and **zero** carrying GPS — the Q2 has no GPS receiver, so nothing had coordinates to leak. The server's corpus may differ. This command decides whether Task 6 needs to run at all, and it is always safe to run.

- [ ] **Step 1: Write the failing test**

Create `uploader/test/exif-audit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/exif-audit.test.ts`
Expected: FAIL — cannot resolve `../src/exif-audit.js`.

- [ ] **Step 3: Implement**

Create `uploader/src/exif-audit.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { readExif } from './exif.js';
import { VARIANT_FILE_RE } from './media.js';
import { isOriginalFile } from './storage.js';

export interface ExifAudit {
  /** Variant files scanned. */
  variants: number;
  withExif: number;
  withGps: number;
  /** Distinct storage keys covered by those variants. */
  keys: number;
  gpsKeys: string[];
  /** GPS-bearing keys with no `-orig` — these cannot be losslessly re-encoded. */
  gpsKeysWithoutOriginal: string[];
}

const EMPTY: ExifAudit = {
  variants: 0, withExif: 0, withGps: 0, keys: 0,
  gpsKeys: [], gpsKeysWithoutOriginal: [],
};

/**
 * Read-only scan of the stored corpus: how much published metadata actually
 * carries location. Never writes, never throws on a bad file.
 *
 * @ai-context: gates whether `strip-gps` needs to run at all — re-encoding the
 * corpus is expensive and lossy for keys with no retained original, so it is
 * not something to do speculatively.
 */
export async function auditExif(storageDir: string): Promise<ExifAudit> {
  let entries;
  try {
    entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw e;
  }

  const keysWithOriginal = new Set<string>();
  const allKeys = new Set<string>();
  const gpsKeys = new Set<string>();
  let variants = 0;
  let withExif = 0;
  let withGps = 0;

  for (const d of entries) {
    if (!d.isFile()) continue;
    const rel = relative(storageDir, join(d.parentPath, d.name)).split(sep).join('/');

    if (isOriginalFile(d.name)) {
      keysWithOriginal.add(rel.replace(/-orig\.[a-z0-9]+$/i, ''));
      continue;
    }
    if (!VARIANT_FILE_RE.test(d.name)) continue;

    variants++;
    const key = rel.replace(VARIANT_FILE_RE, '');
    allKeys.add(key);

    try {
      const meta = await sharp(join(storageDir, rel)).metadata();
      const tags = readExif(meta.exif);
      if (!tags) continue;
      withExif++;
      if (tags.GPSInfo?.GPSLatitude) {
        withGps++;
        gpsKeys.add(key);
      }
    } catch {
      // Unreadable/corrupt file: counted as a variant, but nothing to report.
    }
  }

  const sortedGps = [...gpsKeys].sort();
  return {
    variants,
    withExif,
    withGps,
    keys: allKeys.size,
    gpsKeys: sortedGps,
    gpsKeysWithoutOriginal: sortedGps.filter((k) => !keysWithOriginal.has(k)),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/exif-audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI subcommand**

In `uploader/src/cli.ts`, add above `main()`:

```ts
async function auditExifMain(): Promise<void> {
  const { auditExif } = await import('./exif-audit.js');
  const storageDir = process.env.STORAGE_DIR ?? './data/images';
  const r = await auditExif(storageDir);
  console.log(`scanned ${r.variants} variant file(s) across ${r.keys} key(s) in ${storageDir}`);
  console.log(`  carrying EXIF : ${r.withExif}`);
  console.log(`  carrying GPS  : ${r.withGps}`);
  if (r.withGps === 0) {
    console.log('\nNo stored variant carries GPS. No rewrite is needed.');
    return;
  }
  console.log(`\n${r.gpsKeys.length} key(s) publish coordinates:`);
  for (const k of r.gpsKeys) console.log(`  ${k}`);
  if (r.gpsKeysWithoutOriginal.length) {
    console.log(
      `\n${r.gpsKeysWithoutOriginal.length} of them have NO -orig file and can only be ` +
      're-encoded from an existing variant (one generation of quality loss):',
    );
    for (const k of r.gpsKeysWithoutOriginal) console.log(`  ${k}`);
  }
  console.log('\nBack up first, then: node --import tsx src/cli.ts strip-gps --dry-run');
}
```

and register it as the first line of `main()`:

```ts
  if (process.argv[2] === 'audit-exif') return auditExifMain();
```

Extend the usage string in `main()` to mention `audit-exif`.

- [ ] **Step 6: Run the audit against the real local corpus**

Run: `STORAGE_DIR=./data/images npx tsx src/cli.ts audit-exif`
Expected: it reports ~102 variants, ~102 carrying EXIF, **0 carrying GPS**, and exits saying no rewrite is needed. This confirms the tool agrees with the earlier scan.

- [ ] **Step 7: Full suite + type-check, then commit**

Run: `npm test && npm run typecheck`

```bash
git add src/exif-audit.ts test/exif-audit.test.ts src/cli.ts
git commit -m "feat(uploader): add audit-exif CLI

Read-only report of how many stored variants carry EXIF and GPS, and which
GPS-bearing keys have no retained original. Gates whether the (expensive,
partly lossy) strip-gps rewrite needs to run at all."
```

---

### Task 6: `strip-gps` — audit-gated corpus rewrite

**Files:**
- Create: `uploader/src/exif-strip.ts`
- Create: `uploader/test/exif-strip.test.ts`
- Modify: `uploader/src/cli.ts` (`main`, add the subcommand)

**Interfaces:**
- Consumes: `auditExif` (Task 5), `processImage` (Task 2), `VARIANT_FILE_RE`.
- Produces: `export async function stripGps(opts: StripOptions): Promise<StripResult>` where
  `export interface StripOptions { storageDir: string; dryRun: boolean; fromVariants: boolean; onlyKey?: string }`
  `export interface StripResult { rewritten: string[]; skippedNoOriginal: string[]; failed: { key: string; error: string }[] }`

**Only build this if Task 5's audit reports GPS on the server.** If it reports zero, stop after Task 5 — the pipeline fix has already closed the defect going forward, and rewriting a clean corpus is pure risk. Mark this task skipped in that case and say so in the phase summary.

- [ ] **Step 1: Write the failing test**

Create `uploader/test/exif-strip.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { stripGps } from '../src/exif-strip.js';

async function geotaggedJpeg(w = 800, h = 600): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .withExif({
      IFD0: { Make: 'Leica Camera AG', Model: 'LEICA Q2' },
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100',
        GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100',
      },
    })
    .jpeg()
    .toBuffer();
}

/** A storage dir with one key that has an original and one that does not. */
async function corpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'strip-'));
  await mkdir(join(dir, 'trips', 'a'), { recursive: true });
  const src = await geotaggedJpeg();
  const variant = await sharp(src).resize({ width: 640 }).withMetadata().webp().toBuffer();
  await writeFile(join(dir, 'trips', 'a', 'withorig-640.webp'), variant);
  await writeFile(join(dir, 'trips', 'a', 'withorig-orig.jpg'), src);
  await writeFile(join(dir, 'trips', 'a', 'noorig-640.webp'), variant);
  return dir;
}

const gpsOf = async (p: string): Promise<unknown> => {
  const m = await sharp(p).metadata();
  return m.exif ? (exifReader(m.exif).GPSInfo ?? null) : null;
};

describe('stripGps', () => {
  it('dry-run reports what it would do and changes nothing', async () => {
    const dir = await corpus();
    const file = join(dir, 'trips', 'a', 'withorig-640.webp');
    const before = await readFile(file);
    const r = await stripGps({ storageDir: dir, dryRun: true, fromVariants: false });
    expect(r.rewritten).toEqual(['trips/a/withorig']);
    expect(r.skippedNoOriginal).toEqual(['trips/a/noorig']);
    expect((await readFile(file)).equals(before)).toBe(true);
    expect(await gpsOf(file)).not.toBeNull();
  });

  it('removes GPS by re-encoding from the retained original', async () => {
    const dir = await corpus();
    const file = join(dir, 'trips', 'a', 'withorig-640.webp');
    await stripGps({ storageDir: dir, dryRun: false, fromVariants: false });
    expect(await gpsOf(file)).toBeNull();
    const tags = exifReader((await sharp(file).metadata()).exif!);
    expect(tags.Image?.Make).toBe('Leica Camera AG');   // camera survives
  });

  it('refuses keys with no original unless fromVariants is set', async () => {
    const dir = await corpus();
    const orphan = join(dir, 'trips', 'a', 'noorig-640.webp');
    const r = await stripGps({ storageDir: dir, dryRun: false, fromVariants: false });
    expect(r.skippedNoOriginal).toEqual(['trips/a/noorig']);
    expect(await gpsOf(orphan)).not.toBeNull();          // untouched

    const r2 = await stripGps({ storageDir: dir, dryRun: false, fromVariants: true });
    expect(r2.rewritten).toContain('trips/a/noorig');
    expect(await gpsOf(orphan)).toBeNull();
  });

  it('preserves mtimes so the next backup does not re-tar the corpus', async () => {
    const dir = await corpus();
    const file = join(dir, 'trips', 'a', 'withorig-640.webp');
    const past = new Date(Date.UTC(2020, 0, 1));
    await utimes(file, past, past);
    await stripGps({ storageDir: dir, dryRun: false, fromVariants: false });
    // @ai-context: backup.ts selects archive members by mtimeMs >= sinceMs, and
    // image archives are never pruned — a bumped mtime would tar everything.
    expect(Math.abs((await stat(file)).mtimeMs - past.getTime())).toBeLessThan(2000);
  });

  it('leaves no .tmp files behind', async () => {
    const dir = await corpus();
    await stripGps({ storageDir: dir, dryRun: false, fromVariants: true });
    const names = (await readdir(join(dir, 'trips', 'a'))).filter((n) => n.endsWith('.tmp'));
    expect(names).toEqual([]);
  });

  it('scopes to a single key when onlyKey is given', async () => {
    const dir = await corpus();
    const r = await stripGps({
      storageDir: dir, dryRun: false, fromVariants: true, onlyKey: 'trips/a/noorig',
    });
    expect(r.rewritten).toEqual(['trips/a/noorig']);
    expect(await gpsOf(join(dir, 'trips', 'a', 'withorig-640.webp'))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/exif-strip.test.ts`
Expected: FAIL — cannot resolve `../src/exif-strip.js`.

- [ ] **Step 3: Implement**

Create `uploader/src/exif-strip.ts`:

```ts
import { readdir, readFile, writeFile, rename, stat, utimes, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { VARIANT_FILE_RE } from './media.js';
import { isOriginalFile } from './storage.js';

export interface StripOptions {
  storageDir: string;
  dryRun: boolean;
  /** Allow re-encoding from an existing variant when no -orig is retained. */
  fromVariants: boolean;
  onlyKey?: string;
}

export interface StripResult {
  rewritten: string[];
  skippedNoOriginal: string[];
  failed: { key: string; error: string }[];
}

interface KeyFiles {
  /** storageDir-relative variant paths. */
  variants: string[];
  /** storageDir-relative `-orig.<ext>` path, or null. */
  original: string | null;
}

const ORIGINAL_SUFFIX_RE = /-orig\.[a-z0-9]+$/i;

/** One readdir pass -> every key with its variant files and its original. */
async function scan(storageDir: string): Promise<Map<string, KeyFiles>> {
  const byKey = new Map<string, KeyFiles>();
  let entries;
  try {
    entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return byKey;
    throw e;
  }
  const at = (k: string): KeyFiles => {
    const cur = byKey.get(k) ?? { variants: [], original: null };
    byKey.set(k, cur);
    return cur;
  };
  for (const d of entries) {
    if (!d.isFile()) continue;
    const rel = relative(storageDir, join(d.parentPath, d.name)).split(sep).join('/');
    if (isOriginalFile(d.name)) {
      at(rel.replace(ORIGINAL_SUFFIX_RE, '')).original = rel;
    } else if (VARIANT_FILE_RE.test(d.name)) {
      at(rel.replace(VARIANT_FILE_RE, '')).variants.push(rel);
    }
  }
  // Keys seen only via an -orig have nothing to rewrite.
  for (const [k, f] of byKey) if (f.variants.length === 0) byKey.delete(k);
  return byKey;
}

/** The largest existing variant, used as a fallback source. */
async function largestVariant(storageDir: string, variants: string[]): Promise<string> {
  const widthOf = (p: string): number => Number(VARIANT_FILE_RE.exec(p)?.[1] ?? 0);
  return [...variants].sort((a, b) => widthOf(b) - widthOf(a))[0]!;
}

/**
 * Atomically replace one file, preserving its mtime.
 *
 * @ai-warning: never write a variant in place. The URL is content-hash
 * immutable, so a truncated file cannot be replaced without editing every
 * published post that references it.
 * @ai-warning: mtime preservation is not cosmetic — backup.ts selects image
 * archive members by `mtimeMs >= sinceMs`, and image archives are never
 * pruned, so bumping every mtime makes the next backup tar the whole corpus.
 */
async function replaceAtomically(abs: string, data: Buffer): Promise<void> {
  const before = await stat(abs);
  const tmp = `${abs}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  // Verify the temp file decodes before it is allowed to become the real one.
  await sharp(tmp).metadata();
  await rename(tmp, abs);
  await utimes(abs, before.atime, before.mtime);
}

/** Remove any stray temp files left by a failed key. */
async function cleanupTemps(storageDir: string, variants: string[]): Promise<void> {
  for (const rel of variants) {
    await unlink(join(storageDir, `${rel}.${process.pid}.tmp`)).catch(() => {});
  }
}

/**
 * Re-encode GPS-bearing variants through the allow-list pipeline.
 *
 * @ai-context: sharp cannot rewrite metadata without re-encoding, which is why
 * this is audit-gated (see exif-audit.ts) rather than run speculatively.
 * Keys are processed SEQUENTIALLY on purpose: this is a maintenance command
 * competing with a live server, and one 24MP re-encode peaks near 2 GB.
 */
export async function stripGps(opts: StripOptions): Promise<StripResult> {
  const { storageDir, dryRun, fromVariants, onlyKey } = opts;
  const result: StripResult = { rewritten: [], skippedNoOriginal: [], failed: [] };
  const byKey = await scan(storageDir);

  for (const [key, files] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (onlyKey && key !== onlyKey) continue;

    if (!files.original && !fromVariants) {
      result.skippedNoOriginal.push(key);
      continue;
    }
    if (dryRun) {
      result.rewritten.push(key);
      continue;
    }

    try {
      const sourceRel = files.original ?? (await largestVariant(storageDir, files.variants));
      const source = await readFile(join(storageDir, sourceRel));
      // processImage now applies the EXIF allow-list, so the regenerated
      // variants are clean by construction — no separate stripping step.
      const processed = await processImage(source);
      const byName = new Map(
        processed.variants.map((v) => [`${key}-${v.width}.${v.format}`, v.data]),
      );
      for (const rel of files.variants) {
        const data = byName.get(rel);
        // A width that the current contract no longer produces (e.g. the
        // source shrank) is left alone rather than deleted — deleting would
        // break an already-published URL.
        if (!data) continue;
        await replaceAtomically(join(storageDir, rel), data);
      }
      result.rewritten.push(key);
    } catch (e) {
      await cleanupTemps(storageDir, files.variants);
      result.failed.push({ key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!dryRun && !fromVariants) {
    // Recorded even on a real run so the operator sees what was left behind.
    result.skippedNoOriginal = [...byKey.entries()]
      .filter(([k, f]) => !f.original && (!onlyKey || k === onlyKey))
      .map(([k]) => k)
      .sort();
  }
  return result;
}
```

Note the two subtleties the tests pin: `skippedNoOriginal` is populated on both dry and real runs (the operator must see what was left GPS-bearing), and `replaceAtomically` verifies the temp file decodes *before* the rename, so a failed encode can never replace a good file.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/exif-strip.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Wire the CLI subcommand**

In `uploader/src/cli.ts`, add above `main()`:

```ts
async function stripGpsMain(argv: string[]): Promise<void> {
  const { auditExif } = await import('./exif-audit.js');
  const { stripGps } = await import('./exif-strip.js');
  const storageDir = process.env.STORAGE_DIR ?? './data/images';
  const dryRun = argv.includes('--dry-run');
  const fromVariants = argv.includes('--from-variants');
  const keyFlag = argv.indexOf('--key');
  const onlyKey = keyFlag >= 0 ? argv[keyFlag + 1] : undefined;
  if (keyFlag >= 0 && !onlyKey) {
    console.error('--key requires a storage key, e.g. --key trips/bucharest-2024/hero-1a2b3c4d');
    process.exit(1);
  }

  // Audit-gated: never re-encode a corpus that has nothing to fix.
  const audit = await auditExif(storageDir);
  if (audit.withGps === 0) {
    console.log(
      `no stored variant in ${storageDir} carries GPS (${audit.variants} scanned) — nothing to do.`,
    );
    return;
  }
  if (!dryRun) {
    console.log(
      'This re-encodes image files in place. Make sure a backup has run first ' +
      '(admin Settings -> "Back up now"), then re-run.\n',
    );
  }

  const r = await stripGps({ storageDir, dryRun, fromVariants, onlyKey });
  const verb = dryRun ? 'would rewrite' : 'rewrote';
  console.log(`${verb} ${r.rewritten.length} key(s):`);
  for (const k of r.rewritten) console.log(`  ${k}`);
  if (r.skippedNoOriginal.length) {
    console.log(
      `\nskipped ${r.skippedNoOriginal.length} key(s) with no -orig file ` +
      '(re-run with --from-variants to re-encode them at one generation of quality loss):',
    );
    for (const k of r.skippedNoOriginal) console.log(`  ${k}`);
  }
  if (r.failed.length) {
    console.error(`\n${r.failed.length} key(s) FAILED:`);
    for (const f of r.failed) console.error(`  ${f.key}: ${f.error}`);
    process.exitCode = 1;
    return;
  }
  if (!dryRun && r.rewritten.length) {
    console.log(
      '\nNote: variants are served immutable/max-age=365d, so a browser that already ' +
      'cached one keeps the old copy for up to a year.',
    );
  }
}
```

Register it as the second line of `main()`, after the `audit-exif` branch:

```ts
  if (process.argv[2] === 'strip-gps') return stripGpsMain(process.argv.slice(3));
```

Extend `main()`'s usage string to list both new subcommands alongside `restore` and `set-password`.

- [ ] **Step 6: Verify the dry run against the real local corpus**

Run: `STORAGE_DIR=./data/images npx tsx src/cli.ts strip-gps --dry-run`
Expected: given the local audit reports zero GPS, it prints "nothing to do" and exits 0 **without touching a single file**. Confirm `git status` in `uploader/data` is unchanged.

- [ ] **Step 7: Full suite + type-check, then commit**

Run: `npm test && npm run typecheck`

```bash
git add src/exif-strip.ts test/exif-strip.test.ts src/cli.ts
git commit -m "feat(uploader): add audit-gated strip-gps CLI

Re-encodes GPS-bearing variants from their retained original (or, with
--from-variants, from the largest existing variant at one generation of
quality loss). Atomic per file, mtime-preserving so the next backup does
not re-tar the corpus, resumable per key, and a no-op when audit-exif
reports no GPS."
```

---

### Task 7: Documentation

**Files:**
- Modify: `SECURITY.md` (add a "Published image metadata" section; leave the existing input-validation bullets alone)
- Modify: `ARCHITECTURE.md` (image pipeline section)
- Modify: `CLAUDE.md` (Project Status)
- Modify: `docs/authoring-workflow.md` (one note about single-file uploads)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Update `SECURITY.md`**

Add to the image-handling section:

```markdown
### Published image metadata (allow-list)

Public image variants carry an explicit **allow-list** of EXIF tags, built in
`uploader/src/exif.ts` and applied in `pipeline.ts`: `Make`, `Model`,
`LensModel`, `DateTimeOriginal`, `ExposureTime`, `FNumber`, `ISOSpeedRatings`,
`FocalLength`, plus the ICC profile. Everything else — the **GPS IFD**, XMP,
IPTC and `Orientation` — is dropped by construction, because `withExif()`
replaces the EXIF block wholesale rather than filtering it.

This replaced a blanket `.withMetadata()` which republished source GPS
coordinates on every public file. Untouched originals under `/data/images`
keep their full metadata; they are never served (`isOriginalFile` excludes
them from the static mount).

**Widening this list is a privacy change, not a refactor.** `audit-exif`
reports what the stored corpus actually publishes; `strip-gps` remediates it.
```

Leave `SECURITY.md`'s existing "Input validation" bullet ("**Storage keys** pass `assertSafeKey` in `storeVariants`") **unchanged** — that remains accurate in Phase 0. It only becomes wrong in Phase 2, when `storeVariants` is split and the chokepoint moves into `storeOriginal`; correcting it is that phase's job, not this one.

- [ ] **Step 2: Update `ARCHITECTURE.md`**

In the image-pipeline section, note that variants carry an EXIF allow-list (not full metadata), that originals retain everything and are never served, and document the two new CLI subcommands next to the existing `restore`/`set-password` entries.

- [ ] **Step 3: Update `CLAUDE.md` Project Status**

Add under **Done**:

```markdown
- **Done:** Phase 0 of the media-library work (2026-07-26) — published image variants now carry
  an EXIF allow-list instead of full metadata (no GPS/XMP/IPTC), `POST /upload` rejects
  multi-file requests instead of silently dropping files, an explicit `requestTimeout` is set,
  and `audit-exif` / `strip-gps` CLI subcommands report and remediate the stored corpus. See
  `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md`.
```

- [ ] **Step 4: Update `docs/authoring-workflow.md`**

Add one line to Stage 1 noting that the uploader accepts **one photo per request** (bulk upload arrives in Phase 2) and that photos keep camera and capture-date metadata but never location.

- [ ] **Step 5: Final verification**

```bash
cd uploader && npm test && npm run typecheck
cd ../site && npm test    # must be unaffected — Phase 0 does not touch site/
```

Expected: all green. `site/` requires `DATABASE_URL` for `astro check`/`build` but **not** for `npm test`, so no database is needed here.

- [ ] **Step 6: Commit**

```bash
git add SECURITY.md ARCHITECTURE.md CLAUDE.md docs/authoring-workflow.md
git commit -m "docs: record the EXIF allow-list and upload hardening"
```

---

## Done criteria

- [ ] `npm test` passes in `uploader/` and `site/`.
- [ ] `npm run typecheck` passes in `uploader/`.
- [ ] `processImage` emits **no** `GPSInfo` on any variant, at any width, in either format — asserted, not assumed.
- [ ] Camera, model, capture time, exposure, aperture, ISO, focal length and the ICC profile survive.
- [ ] A multi-file `POST /upload` returns 413; a single-file upload still returns 200 with an unchanged response shape.
- [ ] `audit-exif` runs clean against the real corpus and reports the actual GPS exposure.
- [ ] `strip-gps --dry-run` is a verified no-op when the audit is clean.
- [ ] No `.env`, compose, or `site/` changes.
