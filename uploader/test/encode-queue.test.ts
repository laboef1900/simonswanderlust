import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('drops backlog and blocks status publication on lease loss, then recovers on a fresh queue', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await seed(store, ['a', 'b']);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const keys: string[] = [];
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(), concurrency: 1, signal: controller.signal,
      encodeOne: async (key) => { keys.push(key); started.resolve(); await finish.promise; return { bytes: 123 }; },
    });
    queue.enqueue('a');
    queue.enqueue('b');
    await started.promise;
    controller.abort();
    let settled = false;
    const stop = queue.quiesce().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(queue.stats().pending).toBe(0);
    expect(() => queue.enqueue('c')).toThrow();
    await expect(queue.recover()).rejects.toMatchObject({ code: 'storage_read_only' });
    finish.resolve();
    await stop;
    expect(keys).toEqual(['a']);
    expect((await store.get('a'))?.status).toBe('processing');
    expect((await store.get('b'))?.status).toBe('processing');
    const fresh = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(), log: () => {},
      encodeOne: async () => ({ bytes: 456 }),
    });
    expect(await fresh.recover()).toBe(2);
    await fresh.idle();
    expect(await store.get('a')).toMatchObject({ status: 'ready', variantBytes: 456 });
    expect(await store.get('b')).toMatchObject({ status: 'ready', variantBytes: 456 });
  });

  it('does not record an encoding failure after quiesce', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await seed(store, ['a']);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(),
      encodeOne: async () => { entered.resolve(); await finish.promise; throw new Error('decode failed'); },
    });
    queue.enqueue('a');
    await entered.promise;
    const stop = queue.quiesce();
    finish.resolve();
    await stop;
    expect((await store.get('a'))?.status).toBe('processing');
  });

  it('awaits an admitted recovery read and never starts its rows after quiesce', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await seed(store, ['a']);
    const listed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const queue = createEncodeQueue({
      store: { ...store, list: async (query) => { listed.resolve(); await finish.promise; return store.list(query); } },
      storageDir: '/nonexistent', lock: createWorkLock(), encodeOne: async () => { throw new Error('must not encode'); },
    });
    const recovery = queue.recover();
    const rejected = expect(recovery).rejects.toMatchObject({ code: 'storage_read_only' });
    await listed.promise;
    let settled = false;
    const stop = queue.quiesce().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    await Promise.all([stop, rejected]);
    expect(queue.stats()).toEqual({ pending: 0, running: 0 });
  });
  it('marks a job ready and records its variant bytes', async () => {
    const { store, queue } = setup();
    await seed(store, ['a']);
    queue.enqueue('a');
    await queue.idle();
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
    await queue.idle();
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('reports a key as active from enqueue until its job finishes', async () => {
    const { store, queue, hold } = setup({ concurrency: 1 });
    await seed(store, ['a', 'b']);
    const gate = hold('a');
    queue.enqueue('a'); queue.enqueue('b');
    await tick();
    expect(queue.isActive('a')).toBe(true);   // in flight
    expect(queue.isActive('b')).toBe(true);   // pending
    expect(queue.isActive('zzz')).toBe(false);
    gate.resolve();
    await queue.idle();
    expect(queue.isActive('a')).toBe(false);
    expect(queue.isActive('b')).toBe(false);
  });

  // #116: a key deleted mid-encode must not come back. The encoder writes its
  // variants under the deleted key, and media-sync backfills any key with a
  // variant as `ready` — the delete would silently undo itself on rescan.
  it('discards an encode whose row was deleted mid-flight and unlinks what it wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encq-'));
    const store = memoryMediaStore({ baseUrl: BASE });
    const logs: string[] = [];
    let release!: () => void;
    const queue = createEncodeQueue({
      store, storageDir: dir, lock: createWorkLock(),
      encodeOne: async (key) => {
        // Simulate storeVariantFiles landing after the row vanished.
        await new Promise<void>((r) => { release = r; });
        await mkdir(join(dir, 'trips/x'), { recursive: true });
        await writeFile(join(dir, `${key}-640.webp`), 'x');
        return { bytes: 1 };
      },
      log: (m) => logs.push(m), error: () => {},
    });
    await seed(store, ['trips/x/gone']);
    queue.enqueue('trips/x/gone');
    await tick();
    await store.remove('trips/x/gone');
    release();
    await queue.idle();
    expect(await readdir(join(dir, 'trips/x'))).toEqual([]);
    expect(await store.get('trips/x/gone')).toBeNull();   // no zombie row written back
    expect(logs.join('\n')).toMatch(/discarded.*row deleted mid-encode/);
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
    await queue.idle();
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
    await queue.idle();
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
    await queue.idle();
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
    await queue.idle();
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
    await queue.idle();
  });

  it('is idempotent — enqueueing the same key twice runs it once', async () => {
    const { store, queue, started } = setup({ concurrency: 1 });
    await seed(store, ['a']);
    queue.enqueue('a');
    queue.enqueue('a');
    await queue.idle();
    expect(started).toEqual(['a']);
  });

  it('recovers orphaned processing rows on boot', async () => {
    // A crash mid-encode leaves rows `processing`; re-encoding is idempotent
    // because it overwrites the same deterministic filenames.
    const { store, queue, started } = setup();
    await seed(store, ['x', 'y']);
    await store.upsert({ key: 'done', status: 'ready', width: 8, height: 6, origBytes: 1, exif: noExif, uploadedBy: null });
    expect(await queue.recover()).toBe(2);
    await queue.idle();
    expect(started.sort()).toEqual(['x', 'y']);   // the ready one is untouched
    expect(await store.get('done')).toMatchObject({ status: 'ready' });
  });

  it('finishes admitted recovery work when reading a later row fails', async () => {
    const { store, queue } = setup();
    await seed(store, ['x', 'y']);
    const get = store.get.bind(store);
    store.get = async (key) => {
      if (key === 'y') throw new Error('lookup unavailable');
      return get(key);
    };
    await expect(queue.recover()).rejects.toThrow('lookup unavailable');
    await tick();
    expect(await get('x')).toMatchObject({ status: 'ready', variantBytes: 123 });
    expect(await get('y')).toMatchObject({ status: 'processing' });
    await queue.idle();
  });

  it('recovery waits for same-key rollback and discards its stale processing snapshot', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await seed(store, ['orphan']);
    const rollbackEntered = deferred();
    const landRollback = deferred();
    const listed = deferred();
    const started: string[] = [];
    const queue = createEncodeQueue({
      store: {
        ...store,
        list: async (query) => {
          const snapshot = await store.list(query);
          listed.resolve();
          return snapshot;
        },
      },
      storageDir: '/nonexistent', lock: createWorkLock(),
      encodeOne: async (key) => { started.push(key); return { bytes: 1 }; },
      log: () => {},
    });
    const rollback = queue.withAdmission('orphan', async () => {
      rollbackEntered.resolve();
      await landRollback.promise;
      await store.setStatusIfProcessing('orphan', 'failed', 'queue_full');
    });
    await rollbackEntered.promise;
    const recovery = queue.recover();
    await listed.promise;
    // Serialization is per key, not a queue-wide lock.
    await queue.withAdmission('unrelated', async () => {
      expect(queue.isActive('orphan')).toBe(false);
    });
    landRollback.resolve();
    await rollback;
    expect(await recovery).toBe(0);
    await queue.idle();
    expect(started).toEqual([]);
    expect(await store.get('orphan')).toMatchObject({ status: 'failed', error: 'queue_full' });
    // A later genuine processing row still participates in crash recovery.
    await store.setStatus('orphan', 'processing');
    expect(await queue.recover()).toBe(1);
    await queue.idle();
    expect(started).toEqual(['orphan']);
    expect(await store.get('orphan')).toMatchObject({ status: 'ready' });
  });

  it('releases same-key admission after a refused operation so the next request can proceed', async () => {
    const { store, queue } = setup();
    await seed(store, ['a']);
    await expect(queue.withAdmission('a', async () => {
      await store.setStatusIfProcessing('a', 'failed', 'queue_full');
      throw new BacklogFullError();
    })).rejects.toBeInstanceOf(BacklogFullError);
    await queue.withAdmission('a', async () => {
      expect(await store.get('a')).toMatchObject({ status: 'failed', error: 'queue_full' });
      await store.setStatus('a', 'processing');
      queue.enqueue('a');
    });
    await queue.idle();
    expect(await store.get('a')).toMatchObject({ status: 'ready' });
  });

  it('uses each row snapshot during recovery instead of mutable global settings', async () => {
    const store = memoryMediaStore({ baseUrl: BASE });
    await store.upsert({
      key: 'jpeg', status: 'processing', width: 8, height: 6, origBytes: 1,
      exif: noExif, uploadedBy: null, format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 84, avifQuality: 64 },
    });
    const seen: unknown[] = [];
    const queue = createEncodeQueue({
      store, storageDir: '/nonexistent', lock: createWorkLock(),
      encodeOne: async (_key, profile) => { seen.push(profile); return { bytes: 1 }; },
    });
    expect(await queue.recover()).toBe(1);
    await queue.idle();
    expect(seen).toEqual([{
      format: 'jpeg',
      encoding: { convertJpeg: false, webpQuality: 84, avifQuality: 64 },
    }]);
    expect(await store.get('jpeg')).toMatchObject({ status: 'ready', format: 'jpeg' });
  });

  it('says so when the backlog cap leaves recovery work behind (no silent truncation)', async () => {
    const { store, queue, logs } = setup({ concurrency: 1, maxBacklog: 2 });
    await seed(store, ['a', 'b', 'c', 'd']);
    await queue.recover();
    expect(logs.join('\n')).toMatch(/more still pending/);
    await queue.idle();
  });

  it('drain resolves immediately when nothing is queued', async () => {
    const { queue } = setup();
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  // #134: `docker stop` with a 100-photo backlog. The drain used to keep
  // dequeuing ~19 s jobs until Docker SIGKILLed it mid-write — the very
  // partial-variant case it exists to avoid. Only in-flight work may finish.
  it('drain finishes the in-flight job but starts nothing from the backlog', async () => {
    const { store, queue, started, hold } = setup({ concurrency: 1 });
    await seed(store, ['a', 'b', 'c']);
    const gate = hold('a');
    ['a', 'b', 'c'].forEach((k) => queue.enqueue(k));
    await tick();
    expect(started).toEqual(['a']);
    const drained = queue.drain();
    gate.resolve();
    await drained;
    expect(started).toEqual(['a']);
    expect(queue.stats()).toEqual({ pending: 2, running: 0 });
    // The finished job was persisted; the backlog stays `processing` for recover().
    expect(await store.get('a')).toMatchObject({ status: 'ready' });
    expect(await store.get('b')).toMatchObject({ status: 'processing' });
    // One-way: a late enqueue after the drain never runs either.
    expect(() => queue.enqueue('d')).toThrow();
    await tick();
    expect(started).toEqual(['a']);
  });

  it('drain with an empty backlog still waits for the in-flight job', async () => {
    const { store, queue, hold } = setup({ concurrency: 1 });
    await seed(store, ['a']);
    const gate = hold('a');
    queue.enqueue('a');
    await tick();
    let settled = false;
    const drained = queue.drain().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    gate.resolve();
    await drained;
    expect(await store.get('a')).toMatchObject({ status: 'ready' });
  });
});
