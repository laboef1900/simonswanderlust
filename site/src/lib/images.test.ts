import { describe, expect, it } from 'vitest';
import {
  fallbackSrc,
  imageOrigin,
  largestVariant,
  PROD_IMAGE_ORIGIN,
  retargetImageOrigins,
  srcset,
  variantWidths,
  type RemoteHeroImage,
} from './images';

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
