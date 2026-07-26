import { describe, expect, it } from 'vitest';
import { createWorkLock } from '../src/work-lock.js';

/** A promise plus its resolver, so a test can hold a job open deterministically. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createWorkLock', () => {
  it('runs shared work concurrently', async () => {
    const lock = createWorkLock();
    const a = deferred(); const b = deferred();
    const ra = lock.runShared(() => a.promise);
    const rb = lock.runShared(() => b.promise);
    await tick();
    expect(lock.stats().sharedRunning).toBe(2);
    a.resolve(); b.resolve();
    await Promise.all([ra, rb]);
    expect(lock.stats().sharedRunning).toBe(0);
  });

  it('an exclusive holder excludes shared work, and vice versa', async () => {
    const lock = createWorkLock();
    const build = deferred();
    const order: string[] = [];
    const rBuild = lock.runExclusive(async () => { order.push('build:start'); await build.promise; order.push('build:end'); });
    await tick();
    const rEncode = lock.runShared(async () => { order.push('encode'); });
    await tick();
    expect(order).toEqual(['build:start']); // encode is held off
    build.resolve();
    await Promise.all([rBuild, rEncode]);
    expect(order).toEqual(['build:start', 'build:end', 'encode']);
  });

  it('waits for in-flight encodes before starting a build (never cancels one)', async () => {
    const lock = createWorkLock();
    const encode = deferred();
    const order: string[] = [];
    const rEncode = lock.runShared(async () => { await encode.promise; order.push('encode:end'); });
    await tick();
    const rBuild = lock.runExclusive(async () => { order.push('build:start'); });
    await tick();
    expect(order).toEqual([]);
    expect(lock.stats()).toMatchObject({ sharedRunning: 1, exclusiveWaiting: 1 });
    encode.resolve();
    await Promise.all([rEncode, rBuild]);
    expect(order).toEqual(['encode:end', 'build:start']);
  });

  // @ai-warning: this is THE load-bearing property. Publish awaits the rebuild
  // synchronously in the editor, so a build must preempt the backlog at the
  // next job boundary rather than queueing behind every pending encode.
  it('a waiting build preempts the encode backlog — it never queues behind it', async () => {
    const lock = createWorkLock();
    const running = deferred();
    const order: string[] = [];
    // One encode in flight...
    const inFlight = lock.runShared(async () => { await running.promise; order.push('encode:in-flight'); });
    await tick();
    // ...a build arrives...
    const build = lock.runExclusive(async () => { order.push('build'); });
    await tick();
    // ...and then 50 more encodes queue up behind it.
    const backlog = Array.from({ length: 50 }, (_, i) =>
      lock.runShared(async () => { order.push(`encode:${i}`); }));
    await tick();
    expect(order).toEqual([]);

    running.resolve();
    await Promise.all([inFlight, build, ...backlog]);
    // The build goes second — right after the one job that was already running.
    expect(order.slice(0, 2)).toEqual(['encode:in-flight', 'build']);
    expect(order).toHaveLength(52);
  });

  it('releases the lock when the job throws', async () => {
    const lock = createWorkLock();
    await expect(lock.runExclusive(async () => { throw new Error('build failed'); })).rejects.toThrow('build failed');
    expect(lock.stats()).toMatchObject({ exclusiveRunning: false, sharedRunning: 0 });
    await expect(lock.runShared(async () => { throw new Error('encode failed'); })).rejects.toThrow('encode failed');
    expect(lock.stats().sharedRunning).toBe(0);
    // Still usable afterwards.
    await expect(lock.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('serializes two builds', async () => {
    const lock = createWorkLock();
    const first = deferred();
    const order: string[] = [];
    const a = lock.runExclusive(async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
    await tick();
    const b = lock.runExclusive(async () => { order.push('b'); });
    await tick();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });
});
