import { describe, expect, it } from 'vitest';
import { fixedWindowLimiter } from '../src/rate-limit.js';

describe('fixedWindowLimiter', () => {
  it('allows up to max per window, then blocks', () => {
    let t = 1000;
    const lim = fixedWindowLimiter({ max: 3, windowMs: 100, now: () => t });
    expect(lim.check('ip')).toBe(true);
    expect(lim.check('ip')).toBe(true);
    expect(lim.check('ip')).toBe(true);
    expect(lim.check('ip')).toBe(false);
  });
  it('resets after the window elapses', () => {
    let t = 0;
    const lim = fixedWindowLimiter({ max: 1, windowMs: 100, now: () => t });
    expect(lim.check('ip')).toBe(true);
    expect(lim.check('ip')).toBe(false);
    t = 101;
    expect(lim.check('ip')).toBe(true);
  });
  it('tracks keys independently', () => {
    const t = 0;
    const lim = fixedWindowLimiter({ max: 1, windowMs: 100, now: () => t });
    expect(lim.check('a')).toBe(true);
    expect(lim.check('b')).toBe(true);
    expect(lim.check('a')).toBe(false);
  });
});
