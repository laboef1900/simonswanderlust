import { describe, expect, it } from 'vitest';
import { fixedWindowLimiter, accountLockoutLimiter } from '../src/rate-limit.js';

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

describe('accountLockoutLimiter', () => {
  it('locks account after max failed attempts and clears on success', () => {
    let t = 1000;
    const lim = accountLockoutLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect(lim.isLocked('simon')).toBe(false);
    lim.recordFailure('Simon');
    lim.recordFailure('simon');
    expect(lim.isLocked('SIMON')).toBe(false);
    lim.recordFailure('simon');
    expect(lim.isLocked('simon')).toBe(true);

    // Clears on successful login
    lim.recordSuccess('Simon');
    expect(lim.isLocked('simon')).toBe(false);
  });

  it('resets lock after windowMs elapses', () => {
    let t = 1000;
    const lim = accountLockoutLimiter({ max: 2, windowMs: 500, now: () => t });
    lim.recordFailure('user');
    lim.recordFailure('user');
    expect(lim.isLocked('user')).toBe(true);

    t = 1501;
    expect(lim.isLocked('user')).toBe(false);
  });
});
