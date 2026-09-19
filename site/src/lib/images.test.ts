import { describe, expect, it } from 'vitest';
import {
  fallbackSrc,
  focusPosition,
  imageOrigin,
  largestVariant,
  PROD_IMAGE_ORIGIN,
  retargetImageOrigins,
  srcset,
  sourceFormats,
  variantWidths,
  type RemoteHeroImage,
} from './images';

/**
 * `focusPosition` is a render boundary: its output lands in a `style`
 * attribute, and its input is a key of the `posts.hero_image` jsonb column
 * that a draft save only shape-checks. These cases are the contract, not
 * plumbing — dropping the clamp, or the centred-value shortcut, each ships a
 * real defect (arbitrary CSS in a style attribute; an attribute on every
 * pre-existing post).
 */
describe('focusPosition', () => {
  const hero: RemoteHeroImage = {
    src: 'https://img.example/trips/x/hero',
    width: 1200,
    height: 800,
    alt: 'A boat on a canal',
  };

  it('emits nothing without a focal point, so existing posts render unchanged', () => {
    expect(focusPosition(hero)).toBeUndefined();
  });

  it('emits nothing for a centred point, so "reset to centre" is a real removal', () => {
    expect(focusPosition({ ...hero, focus: { x: 50, y: 50 } })).toBeUndefined();
  });

  it("emits the author's point", () => {
    expect(focusPosition({ ...hero, focus: { x: 22, y: 18 } })).toBe('object-position:22% 18%');
    expect(focusPosition({ ...hero, focus: { x: 0, y: 100 } })).toBe('object-position:0% 100%');
  });

  it('rounds, since a style attribute gains nothing from two decimals', () => {
    expect(focusPosition({ ...hero, focus: { x: 33.49, y: 66.51 } })).toBe('object-position:33% 67%');
  });

  it('clamps values the database can hold but CSS should not receive', () => {
    expect(focusPosition({ ...hero, focus: { x: -40, y: 1e9 } })).toBe('object-position:0% 100%');
  });

  it('never lets a non-numeric jsonb value reach the attribute', () => {
    const hostile = { x: 'red;background:url(//evil/x)', y: null } as unknown as { x: number; y: number };
    // Both axes fall back to the centre, which collapses to no attribute at all.
    expect(focusPosition({ ...hero, focus: hostile })).toBeUndefined();
    const half = { x: 10, y: undefined } as unknown as { x: number; y: number };
    expect(focusPosition({ ...hero, focus: half })).toBe('object-position:10% 50%');
  });
});

const big: RemoteHeroImage = {
  src: 'https://img.simonswanderlust.com/trips/rhodes-2021/hero',
  width: 2560,
  height: 965,
  alt: 'Rhodes coastline',
};
const small: RemoteHeroImage = {
  src: 'https://img.simonswanderlust.com/trips/bucharest-2024/hero',
  width: 768,
  height: 512,
  alt: 'Bucharest old town',
};
const jpeg: RemoteHeroImage = {
  src: 'https://img.simonswanderlust.com/trips/jpeg/hero',
  width: 1600,
  height: 1067,
  alt: 'JPEG-only photo',
  format: 'jpeg',
};

describe('variantWidths', () => {
  it('keeps standard widths below the source and appends the intrinsic width', () => {
    expect(variantWidths(2560)).toEqual([640, 1280, 1920, 2560]);
  });
  it('drops standard widths at or above the source (no upscaling)', () => {
    expect(variantWidths(768)).toEqual([640, 768]);
  });
  it('returns only the intrinsic width when the source is smaller than all standards', () => {
    expect(variantWidths(500)).toEqual([500]);
  });
  it('excludes a standard width that exactly equals the intrinsic', () => {
    expect(variantWidths(1280)).toEqual([640, 1280]);
  });
});

describe('srcset', () => {
  it('builds an avif srcset from the convention', () => {
    expect(srcset(big, 'avif')).toBe(
      'https://img.simonswanderlust.com/trips/rhodes-2021/hero-640.avif 640w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-1280.avif 1280w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-1920.avif 1920w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-2560.avif 2560w',
    );
  });
  it('builds a webp srcset honoring no-upscale', () => {
    expect(srcset(small, 'webp')).toBe(
      'https://img.simonswanderlust.com/trips/bucharest-2024/hero-640.webp 640w, ' +
        'https://img.simonswanderlust.com/trips/bucharest-2024/hero-768.webp 768w',
    );
  });
  it('builds an exact .jpeg srcset for a JPEG-only reference', () => {
    expect(srcset(jpeg, 'jpeg')).toBe(
      'https://img.simonswanderlust.com/trips/jpeg/hero-640.jpeg 640w, ' +
        'https://img.simonswanderlust.com/trips/jpeg/hero-1280.jpeg 1280w, ' +
        'https://img.simonswanderlust.com/trips/jpeg/hero-1600.jpeg 1600w',
    );
  });
});

describe('sourceFormats', () => {
  it('selects only generated formats for modern and JPEG-only references', () => {
    expect(sourceFormats(big)).toEqual(['avif', 'webp']);
    expect(sourceFormats(jpeg)).toEqual(['jpeg']);
  });
});
describe('fallbackSrc', () => {
  it('uses the 1280 webp when available', () => {
    expect(fallbackSrc(big)).toBe('https://img.simonswanderlust.com/trips/rhodes-2021/hero-1280.webp');
  });
  it('falls back to the largest available width otherwise', () => {
    expect(fallbackSrc(small)).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero-768.webp');
  });
  it('uses 1280 webp when the intrinsic width is exactly 1280', () => {
    expect(
      fallbackSrc({ src: 'https://img.simonswanderlust.com/trips/x/hero', width: 1280, height: 800, alt: '' }),
    ).toBe('https://img.simonswanderlust.com/trips/x/hero-1280.webp');
  });
  it('uses the .jpeg fallback for a JPEG-only reference', () => {
    expect(fallbackSrc(jpeg)).toBe('https://img.simonswanderlust.com/trips/jpeg/hero-1280.jpeg');
  });
});

describe('largestVariant', () => {
  it('returns the intrinsic-width variant, not the largest standard width', () => {
    expect(largestVariant(big)).toBe(
      'https://img.simonswanderlust.com/trips/rhodes-2021/hero-2560.webp',
    );
  });

  it('never upscales a source smaller than the standard widths', () => {
    expect(largestVariant(small)).toBe(
      'https://img.simonswanderlust.com/trips/bucharest-2024/hero-768.webp',
    );
  });

  it('can address another format', () => {
    expect(largestVariant(big, 'avif')).toBe(
      'https://img.simonswanderlust.com/trips/rhodes-2021/hero-2560.avif',
    );
  });
  it('uses the recorded JPEG format by default', () => {
    expect(largestVariant(jpeg)).toBe(
      'https://img.simonswanderlust.com/trips/jpeg/hero-1600.jpeg',
    );
  });

  it('agrees with srcset about which variants exist', () => {
    // The href would 404 if these ever disagreed.
    expect(srcset(big, 'webp')).toContain(`${largestVariant(big)} 2560w`);
  });
});

describe('imageOrigin', () => {
  it('reduces a configured base URL to its origin (no path, no trailing slash)', () => {
    expect(imageOrigin('https://img.simonswanderlust.com/')).toBe('https://img.simonswanderlust.com');
    expect(imageOrigin('http://localhost:3000/images')).toBe('http://localhost:3000');
  });

  it('falls back to the production origin when the build has no PUBLIC_BASE_URL', () => {
    expect(imageOrigin(undefined)).toBe(PROD_IMAGE_ORIGIN);
    expect(imageOrigin('')).toBe(PROD_IMAGE_ORIGIN);
    expect(imageOrigin('   ')).toBe(PROD_IMAGE_ORIGIN);
  });

  it('falls back on a non-string or unparsable value instead of emitting a broken hint', () => {
    expect(imageOrigin(42)).toBe(PROD_IMAGE_ORIGIN);
    expect(imageOrigin('img.simonswanderlust.com')).toBe(PROD_IMAGE_ORIGIN);
  });
});

describe('retargetImageOrigins', () => {
  const IMG = 'https://img.simonswanderlust.com';

  it('re-points registered image URLs at the configured origin, in body and map alike', () => {
    const out = retargetImageOrigins(
      {
        heroSrc: 'http://localhost:3000/trips/rhodos/hero',
        images: { 'http://localhost:3000/trips/rhodos/a': { width: 10, height: 5 } },
        body: '```gallery\nhttp://localhost:3000/trips/rhodos/a\n```',
      },
      IMG,
    );
    expect(out.heroSrc).toBe(`${IMG}/trips/rhodos/hero`);
    expect(Object.keys(out.images)).toEqual([`${IMG}/trips/rhodos/a`]);
    expect(out.body).toContain(`${IMG}/trips/rhodos/a`);
    expect(out.body).not.toContain('localhost');
  });

  it('leaves ordinary links alone — only registered images are rewritten', () => {
    const body = 'See [Kopenhagen](https://de.wikipedia.org/wiki/Kopenhagen) and\nhttp://localhost:3000/trips/x/a';
    const out = retargetImageOrigins(
      { heroSrc: '', images: { 'http://localhost:3000/trips/x/a': { width: 1, height: 1 } }, body },
      IMG,
    );
    expect(out.body).toContain('https://de.wikipedia.org/wiki/Kopenhagen');
    expect(out.body).toContain(`${IMG}/trips/x/a`);
  });

  it('does not corrupt a key that is a prefix of another key', () => {
    const out = retargetImageOrigins(
      {
        heroSrc: '',
        images: {
          'http://localhost:3000/trips/x/a': { width: 1, height: 1 },
          'http://localhost:3000/trips/x/a-2': { width: 1, height: 1 },
        },
        body: 'http://localhost:3000/trips/x/a\nhttp://localhost:3000/trips/x/a-2',
      },
      IMG,
    );
    expect(out.body.split('\n')).toEqual([`${IMG}/trips/x/a`, `${IMG}/trips/x/a-2`]);
    expect(Object.keys(out.images).sort()).toEqual([`${IMG}/trips/x/a`, `${IMG}/trips/x/a-2`]);
  });

  it('is a no-op when the content already matches the origin', () => {
    const input = {
      heroSrc: `${IMG}/trips/x/hero`,
      images: { [`${IMG}/trips/x/a`]: { width: 1, height: 1 } },
      body: `${IMG}/trips/x/a`,
    };
    expect(retargetImageOrigins(input, IMG)).toEqual(input);
  });
});
