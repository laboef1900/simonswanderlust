import { describe, expect, it } from 'vitest';
import { regionShape, stampStyle } from '../src/lib/stamp';

const INKS = ['#1a1a2e', '#1e3a6e', '#c0311e', '#6b3d9e', '#1e5c30'];
const BORDERS = ['single', 'double', 'dashed'];

describe('regionShape', () => {
  it('maps europe to rect, other regions to circle', () => {
    expect(regionShape('europe')).toBe('rect');
    expect(regionShape('north-america')).toBe('circle');
    expect(regionShape('south-america')).toBe('circle');
    expect(regionShape('whatever')).toBe('circle');
  });
});

describe('stampStyle', () => {
  it('is deterministic and case-insensitive for a given code', () => {
    expect(stampStyle('HU')).toEqual(stampStyle('hu'));
    expect(stampStyle('MX')).toEqual(stampStyle('MX'));
  });
  it('returns a valid style for any code', () => {
    for (const c of ['HU', 'RO', 'GR', 'DK', 'MX', 'CR', 'EC', 'BR', 'X', 'ZZ']) {
      const s = stampStyle(c);
      expect(INKS).toContain(s.ink);
      expect(BORDERS).toContain(s.border);
      expect(s.rotation).toBeGreaterThanOrEqual(-5);
      expect(s.rotation).toBeLessThanOrEqual(5);
    }
  });
  it('produces visible variety across the blog countries', () => {
    const inks = new Set(['HU', 'RO', 'GR', 'DK', 'MX', 'CR', 'EC', 'BR'].map((c) => stampStyle(c).ink));
    expect(inks.size).toBeGreaterThanOrEqual(3);
  });
  it('weights ink toward black/navy (as real stamps do)', () => {
    const codes: string[] = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b));
    const darks = codes.filter((c) => ['#1a1a2e', '#1e3a6e'].includes(stampStyle(c).ink)).length;
    expect(darks / codes.length).toBeGreaterThan(0.5);
  });
});
