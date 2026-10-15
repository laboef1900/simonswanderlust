import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixedWindowLimiter, accountLockoutLimiter, MAX_KEY_LENGTH } from '../src/rate-limit.js';

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

  // The map is bounded by maxKeys, not by the (attacker-chosen) number of
  // distinct keys: at the cap the OLDEST window is evicted, which an
  // unbounded map would never do, so the evicted key gets a fresh bucket (#109).
  it('caps tracked keys and evicts the oldest live window at the cap', () => {
    const lim = fixedWindowLimiter({ max: 1, windowMs: 100, maxKeys: 2, now: () => 0 });
    expect(lim.check('a')).toBe(true);
    expect(lim.check('b')).toBe(true);
    expect(lim.check('a')).toBe(false); // exhausted while tracked
    expect(lim.check('c')).toBe(true); // third key evicts 'a'
    expect(lim.check('a')).toBe(true); // forgotten → fresh window (evicts 'b')
    expect(lim.check('c')).toBe(false); // 'c' was still tracked
  });

  it('evicts expired windows before live ones', () => {
    let t = 0;
    const lim = fixedWindowLimiter({ max: 1, windowMs: 100, maxKeys: 2, now: () => t });
    lim.check('a');
    t = 50;
    lim.check('b');
    t = 120; // 'a' expired, 'b' live
    expect(lim.check('c')).toBe(true); // sweeps 'a', keeps 'b'
    expect(lim.check('b')).toBe(false);
  });

  it('stays bounded under many distinct keys', () => {
    const lim = fixedWindowLimiter({ max: 1, windowMs: 100, maxKeys: 1000, now: () => 0 });
    for (let i = 0; i < 50_000; i++) lim.check(`k${i}`);
    expect(lim.check('k49999')).toBe(false); // newest still tracked
    expect(lim.check('k0')).toBe(true); // oldest long evicted
    expect(lim.check('k48999')).toBe(true); // 1000th-newest evicted by the insert above
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

  it('caps tracked accounts: an eviction forgets failures, never locks (#109)', () => {
    const lim = accountLockoutLimiter({ max: 1, windowMs: 1000, maxKeys: 2, now: () => 0 });
    lim.recordFailure('a');
    lim.recordFailure('b');
    expect(lim.isLocked('a')).toBe(true);
    lim.recordFailure('c'); // evicts 'a'
    expect(lim.isLocked('a')).toBe(false);
    expect(lim.isLocked('b')).toBe(true);
    expect(lim.isLocked('c')).toBe(true);
  });

  it('bounds key length: an over-long account is tracked under its hash, disjoint from every verbatim key', () => {
    // A 1 MiB username must not cost the map 1 MiB — but it must still lock,
    // and its hash must not alias a real ≤ 64-char username.
    const lim = accountLockoutLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    const long = 'a'.repeat(100_000);
    lim.recordFailure(long);
    expect(lim.isLocked(long)).toBe(true);
    expect(lim.isLocked(long.toUpperCase())).toBe(true); // normalised before hashing
    expect(lim.isLocked(long.slice(0, 64))).toBe(false); // not a truncation
    expect(lim.isLocked(long.slice(0, MAX_KEY_LENGTH + 1))).toBe(false);
    const hex = createHash('sha256').update(long).digest('hex'); // a legal 64-char username
    expect(lim.isLocked(hex)).toBe(false);
    lim.recordSuccess(hex);
    expect(lim.isLocked(long)).toBe(true); // success on the hex name did not clear the long one
  });
});
