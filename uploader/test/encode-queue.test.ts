import { describe, expect, it } from 'vitest';
import { BacklogFullError, createEncodeQueue } from '../src/encode-queue.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import { createWorkLock } from '../src/work-lock.js';

const BASE = 'https://img.example.com';
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

async function seed(store: MediaStore, keys: string[], status: 'processing' | 'failed' = 'processing') {
  for (const key of keys) {
    await store.upsert({ key, status, width: 8, height: 6, origBytes: 1, exif: noExif, uploadedBy: null });
  }
}

function setup(opts: { concurrency?: number; maxBacklog?: number } = {}) {
  const store = memoryMediaStore({ baseUrl: BASE });
  const lock = createWorkLock();
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const logs: string[] = [];
  const queue = createEncodeQueue({
    store, storageDir: '/nonexistent', lock,
    concurrency: opts.concurrency ?? 2,
    ...(opts.maxBacklog !== undefined ? { maxBacklog: opts.maxBacklog } : {}),
    encodeOne: async (key) => {
      started.push(key);
      const gate = gates.get(key);
      if (gate) await gate.promise;
      return { bytes: 123 };
    },
    log: (m) => logs.push(m),
    error: () => { /* silence expected failures */ },
  });
  const hold = (key: string) => {
    const d = deferred();
    gates.set(key, d);
    return d;
  };
  return { store, lock, queue, started, hold, logs };
}

describe('createEncodeQueue', () => {
  it('marks a job ready and records its variant bytes', async () => {
    const { store, queue } = setup();
    await seed(store, ['a']);
    queue.enqueue('a');
    await queue.drain();
    expect(await store.get('a')).toMatchObject({ status: 'ready', variantBytes: 123 });
  });

  it('caps concurrency at the configured value', async () => {
    const { store, queue, started, hold } = setup({ concurrency: 2 });
    await seed(store, ['a', 'b', 'c']);
    const gates = ['a', 'b', 'c'].map(hold);
    ['a', 'b', 'c'].forEach((k) => queue.enqueue(k));
    await tick();
    expect(started).toEqual(['a', 'b']);       // 'c' waits
    expect(queue.stats()).toMatchObject({ running: 2, pending: 1 });
    gates.forEach((g) => g.resolve());
    await queue.drain();
    expect(started).toEqual(['a', 'b', 'c']);
  });

  // @ai-warning: the OOM mitigation. astro build and sharp both peak around
  // 2 GB in one container; they must never overlap.
  it('pauses while a site build holds the shared lock', async () => {
    const { store, lock, queue, started } = setup();
    await seed(store, ['a']);
    const build = deferred();
    const running = lock.runExclusive(() => build.promise);
    await tick();
    queue.enqueue('a');
    await tick();
    expect(started).toEqual([]);               // held off by the build
    build.resolve();
    await running;
    await queue.drain();
    expect(started).toEqual(['a']);
  });

  it('records a failure as a fixed enum and never leaks the raw message', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(),
      encodeOne: async () => { throw new Error('VipsJpeg: premature end of input file /data/images/secret.jpg'); },
      error: () => {},
    });
    await seed(store, ['bad']);
    queue.enqueue('bad');
    await queue.drain();
    const item = await store.get('bad');
    expect(item).toMatchObject({ status: 'failed', error: 'decode_failed' });
    // libvips embeds filesystem paths and the library UI displays this field.
    expect(JSON.stringify(item)).not.toContain('/data/images');
  });

  it('classifies an out-of-space failure distinctly', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(),
      encodeOne: async () => { throw new Error('ENOSPC: no space left on device'); },
      error: () => {},
    });
    await seed(store, ['full']);
    queue.enqueue('full');
    await queue.drain();
    expect(await store.get('full')).toMatchObject({ status: 'failed', error: 'no_space' });
  });

  it('one failing job never stops the others', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(), concurrency: 1,
      encodeOne: async (key) => { if (key === 'bad') throw new Error('boom'); return { bytes: 1 }; },
      error: () => {},
    });
    await seed(store, ['bad', 'good']);
    queue.enqueue('bad');
    queue.enqueue('good');
    await queue.drain();
    expect(await store.get('good')).toMatchObject({ status: 'ready' });
    expect(await store.get('bad')).toMatchObject({ status: 'failed' });
  });

  it('refuses to enqueue beyond the backlog cap', async () => {
    const { store, queue, hold } = setup({ concurrency: 1, maxBacklog: 2 });
    await seed(store, ['a', 'b', 'c', 'd']);
    const gate = hold('a');
    queue.enqueue('a');                 // runs
    queue.enqueue('b'); queue.enqueue('c'); // fill the backlog
    expect(() => queue.enqueue('d')).toThrow(BacklogFullError);
    gate.resolve();
    await queue.drain();
  });

  it('is idempotent — enqueueing the same key twice runs it once', async () => {
    const { store, queue, started } = setup({ concurrency: 1 });
    await seed(store, ['a']);
    queue.enqueue('a');
    queue.enqueue('a');
    await queue.drain();
    expect(started).toEqual(['a']);
  });

  it('recovers orphaned processing rows on boot', async () => {
    // A crash mid-encode leaves rows `processing`; re-encoding is idempotent
    // because it overwrites the same deterministic filenames.
    const { store, queue, started } = setup();
    await seed(store, ['x', 'y']);
    await store.upsert({ key: 'done', status: 'ready', width: 8, height: 6, origBytes: 1, exif: noExif, uploadedBy: null });
    expect(await queue.recover()).toBe(2);
    await queue.drain();
    expect(started.sort()).toEqual(['x', 'y']);   // the ready one is untouched
    expect(await store.get('done')).toMatchObject({ status: 'ready' });
  });

  it('says so when the backlog cap leaves recovery work behind (no silent truncation)', async () => {
    const { store, queue, logs } = setup({ concurrency: 1, maxBacklog: 2 });
    await seed(store, ['a', 'b', 'c', 'd']);
    await queue.recover();
    expect(logs.join('\n')).toMatch(/more still pending/);
    await queue.drain();
  });

  it('drain resolves immediately when nothing is queued', async () => {
    const { queue } = setup();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
