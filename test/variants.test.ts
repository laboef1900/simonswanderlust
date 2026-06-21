import { describe, expect, it } from 'vitest';
import { variantWidths, WIDTHS, FORMATS } from '../src/variants.js';

describe('variantWidths', () => {
  it('keeps standard widths below the source and appends the intrinsic width', () => {
    expect(variantWidths(2560)).toEqual([640, 1280, 1920, 2560]);
  });
  it('never upscales (drops standards >= source)', () => {
    expect(variantWidths(768)).toEqual([640, 768]);
  });
  it('returns only the intrinsic width when smaller than all standards', () => {
    expect(variantWidths(500)).toEqual([500]);
  });
});

describe('contract constants', () => {
  it('matches the blog-side contract', () => {
    expect(WIDTHS).toEqual([640, 1280, 1920]);
    expect(FORMATS).toEqual(['avif', 'webp']);
  });
});
