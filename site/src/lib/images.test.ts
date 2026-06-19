import { describe, expect, it } from 'vitest';
import { variantWidths, srcset, fallbackSrc, type RemoteHeroImage } from './images';

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
});
