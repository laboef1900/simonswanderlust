import { describe, it, expect } from 'vitest';
import { makeDbCheck } from '../src/health.js';

describe('makeDbCheck', () => {
  it('resolves when the probe resolves within the timeout', async () => {
    const check = makeDbCheck(() => Promise.resolve({ rows: [{ '?column?': 1 }] }), 1_000);
    await expect(check()).resolves.toBeUndefined();
  });

  it('rejects with the probe error when the probe rejects (DB refused)', async () => {
    const check = makeDbCheck(() => Promise.reject(new Error('ECONNREFUSED')), 1_000);
    await expect(check()).rejects.toThrow('ECONNREFUSED');
  });

  it('rejects on timeout instead of awaiting forever when the DB is silently hung', async () => {
    // A probe that never settles models a network partition (dropped packets).
    const check = makeDbCheck(() => new Promise<never>(() => {}), 20);
    await expect(check()).rejects.toThrow(/timed out/);
  });
});
