import { describe, expect, it } from 'vitest';
import {
  createImportRunner, memoryImportJobStore, ImportBusyError, IMPORT_FAILED_MESSAGE, IMPORT_JOB_HISTORY,
  type ImportJob, type ImportJobStore,
} from '../src/import-jobs.js';
import type { ImportProgress, ImportSummary } from '../src/wp-import.js';

const OK: ImportSummary = { imported: 1, updated: 0, skippedPublished: 0, rejected: 0, failed: 0, images: { total: 2, hosted: 2, failed: 0 }, warnings: [] };
const planned = (): ImportProgress => ({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 0, failed: 0 } });

/** The repo's resolvable-gate idiom. */
/** One event-loop turn, so the serialised write chain (a few microtasks) has landed. */
const flush = () => new Promise<void>((r) => { setImmediate(r); });

const gate = () => {
  let open = (): void => {};
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};

/** A store that records every write, so persistence cadence is observable. */
const recording = () => {
  const inner = memoryImportJobStore();
  const writes: { id: string; keys: string[] }[] = [];
  const store: ImportJobStore = {
    ...inner,
    update: (id, patch) => { writes.push({ id, keys: Object.keys(patch) }); return inner.update(id, patch); },
  };
  return { store, writes };
};

/**
 * Issue #92: one job at a time, live counters from memory, outcome persisted,
 * and a fixed failure message.
 *
 * @ai-context docs/superpowers/specs/2026-09-05-async-import-job-design.md
 */
describe('createImportRunner', () => {
  it('starts a job as running, then records done with the summary', async () => {
    const store = memoryImportJobStore();
    const runner = createImportRunner({ store, log: () => {} });
    const finish = gate();
    const job = await runner.start({ startedBy: 'simon', planned: planned(), run: async () => { await finish.opened; return OK; } });
    expect(job).toMatchObject({ status: 'running', startedBy: 'simon', summary: null, error: null, finishedAt: null });
    expect(runner.current()?.id).toBe(job.id);
    expect((await store.latest())?.status).toBe('running'); // the row exists before the run
    finish.open();
    await runner.settle();
    expect(runner.current()).toBeNull();
    const done = await runner.latest();
    expect(done).toMatchObject({ id: job.id, status: 'done', summary: OK });
    expect(done?.finishedAt).toBeTruthy();
    expect((await store.latest())?.status).toBe('done');
  });

  it('refuses a second start while one runs, and accepts one after it finishes', async () => {
    const runner = createImportRunner({ store: memoryImportJobStore(), log: () => {} });
    const finish = gate();
    await runner.start({ startedBy: 'a', planned: planned(), run: async () => { await finish.opened; return OK; } });
    await expect(runner.start({ startedBy: 'b', planned: planned(), run: async () => OK })).rejects.toBeInstanceOf(ImportBusyError);
    finish.open();
    await runner.settle();
    const second = await runner.start({ startedBy: 'b', planned: planned(), run: async () => OK });
    expect(second.startedBy).toBe('b');
    await runner.settle();
  });

  it('serves live progress from memory: current() reflects the latest callback', async () => {
    const runner = createImportRunner({ store: memoryImportJobStore(), log: () => {} });
    let report: (p: ImportProgress) => void = () => {};
    const finish = gate();
    await runner.start({
      startedBy: 'a', planned: planned(),
      run: async (onProgress) => { report = onProgress; await finish.opened; return OK; },
    });
    report({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 1, failed: 0 } });
    expect(runner.current()?.progress).toEqual({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 1, failed: 0 } });
    // A copy, not the importer's mutable object.
    const p = { groups: { total: 1, done: 1 }, images: { planned: 2, hosted: 2, failed: 0 } };
    report(p);
    p.images.hosted = 99;
    expect(runner.current()?.progress.images.hosted).toBe(2);
    finish.open();
    await runner.settle();
  });

  it('persists on every group boundary, and image events at most every persistEveryMs', async () => {
    const { store, writes } = recording();
    let clock = 0;
    const runner = createImportRunner({ store, log: () => {}, now: () => clock, persistEveryMs: 2_000 });
    let report: (p: ImportProgress) => void = () => {};
    const finish = gate();
    await runner.start({ startedBy: 'a', planned: planned(), run: async (onProgress) => { report = onProgress; await finish.opened; return OK; } });
    const img = (hosted: number, done = 0): ImportProgress => ({ groups: { total: 3, done }, images: { planned: 6, hosted, failed: 0 } });
    report(img(1)); // t=0, within the window since start → not persisted
    clock = 1_000; report(img(2)); // still within the window
    await flush();
    expect(writes).toHaveLength(0);
    clock = 2_000; report(img(3)); // window elapsed → persisted
    await flush();
    expect(writes).toHaveLength(1);
    clock = 2_500; report(img(3, 1)); // group boundary → persisted regardless of the clock
    await flush();
    expect(writes).toHaveLength(2);
    clock = 2_600; report(img(4, 1)); // same group, window not elapsed
    await flush();
    expect(writes).toHaveLength(2);
    finish.open();
    await runner.settle();
    // The final write carries the outcome.
    expect(writes.at(-1)?.keys).toEqual(expect.arrayContaining(['status', 'summary', 'finishedAt']));
    expect((await store.latest())?.progress.images.hosted).toBe(4);
  });

  it('records an unexpected run failure with a fixed message, logs the detail, and frees the slot', async () => {
    const logged: string[] = [];
    const runner = createImportRunner({ store: memoryImportJobStore(), log: (m) => logged.push(m) });
    await runner.start({ startedBy: 'a', planned: planned(), run: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } });
    await runner.settle();
    const job = await runner.latest();
    expect(job).toMatchObject({ status: 'failed', error: IMPORT_FAILED_MESSAGE, summary: null });
    expect(job?.error).not.toContain('10.0.0.5');
    expect(logged.join('\n')).toContain('ECONNREFUSED 10.0.0.5:5432');
    expect(runner.current()).toBeNull();
  });

  it('survives a failing progress write: the import keeps running and the outcome is retried', async () => {
    const inner = memoryImportJobStore();
    let fail = true;
    const store: ImportJobStore = { ...inner, update: (id, patch) => (fail ? Promise.reject(new Error('db down')) : inner.update(id, patch)) };
    const logged: string[] = [];
    const runner = createImportRunner({ store, log: (m) => logged.push(m), persistEveryMs: 0 });
    let report: (p: ImportProgress) => void = () => {};
    const finish = gate();
    await runner.start({ startedBy: 'a', planned: planned(), run: async (onProgress) => { report = onProgress; await finish.opened; return OK; } });
    report({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 1, failed: 0 } });
    await flush();
    expect(logged.join('\n')).toMatch(/progress write failed/);
    fail = false;
    finish.open();
    await runner.settle();
    expect((await inner.latest())?.status).toBe('done');
  });

// Review finding on #167: pooled UPDATEs issued without awaiting can commit
  // out of order, so an older snapshot could overwrite a newer one or even the
  // terminal write. Writes are serialised; a slow early write must not win.
  it('serialises progress writes so a slow early write cannot overwrite a later one', async () => {
    const inner = memoryImportJobStore();
    const slow = gate();
    let calls = 0;
    const store: ImportJobStore = {
      ...inner,
      update: async (id, patch) => { if (++calls === 1) await slow.opened; return inner.update(id, patch); },
    };
    const runner = createImportRunner({ store, log: () => {}, persistEveryMs: 0 });
    let report: (p: ImportProgress) => void = () => {};
    const finish = gate();
    await runner.start({ startedBy: 'a', planned: planned(), run: async (onProgress) => { report = onProgress; await finish.opened; return OK; } });
    report({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 1, failed: 0 } }); // first write: stalls
    report({ groups: { total: 1, done: 0 }, images: { planned: 2, hosted: 2, failed: 0 } }); // second: must wait
    finish.open();
    await Promise.resolve();
    expect((await inner.latest())?.status).toBe('running'); // nothing has landed yet, not even the outcome
    slow.open();
    await runner.settle();
    expect(await inner.latest()).toMatchObject({ status: 'done', progress: { images: { hosted: 2 } } });
  });

  it('keeps the outcome in memory when its terminal write fails, so latest() never reports a stale running row', async () => {
    const inner = memoryImportJobStore();
    let failTerminal = true;
    const store: ImportJobStore = {
      ...inner,
      update: (id, patch) => (failTerminal && patch.status ? Promise.reject(new Error('db down')) : inner.update(id, patch)),
    };
    const logged: string[] = [];
    const runner = createImportRunner({ store, log: (m) => logged.push(m) });
    await runner.start({ startedBy: 'a', planned: planned(), run: async () => OK });
    await runner.settle();
    expect((await inner.latest())?.status).toBe('running'); // the row IS stale …
    expect(await runner.latest()).toMatchObject({ status: 'done', summary: OK }); // … but the page sees the truth
    expect(logged.join('\n')).toMatch(/could not be persisted/);
    // A later import supersedes the memory copy.
    failTerminal = false;
    const next = await runner.start({ startedBy: 'b', planned: planned(), run: async () => OK });
    await runner.settle();
    expect((await runner.latest())?.id).toBe(next.id);
  });

  it('recover() flips running rows to interrupted and leaves finished ones alone', async () => {
    const store = memoryImportJobStore();
    const job = (id: string, status: ImportJob['status']): ImportJob => ({
      id, status, startedBy: 'a', startedAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
      finishedAt: null, progress: planned(), summary: null, error: null,
    });
    await store.insert(job('old-done', 'done'));
    await store.insert(job('crashed', 'running'));
    const runner = createImportRunner({ store, log: () => {} });
    expect(await runner.recover()).toBe(1);
    expect((await store.latest())).toMatchObject({ id: 'crashed', status: 'interrupted' });
    expect((await store.latest())?.finishedAt).toBeTruthy();
    expect(await runner.recover()).toBe(0);
  });

  it('latest() falls back to the store when nothing is running', async () => {
    const store = memoryImportJobStore();
    const runner = createImportRunner({ store, log: () => {} });
    expect(await runner.latest()).toBeNull();
    await runner.start({ startedBy: 'a', planned: planned(), run: async () => OK });
    await runner.settle();
    expect((await runner.latest())?.status).toBe('done');
  });
});

describe('memoryImportJobStore', () => {
  it('keeps only the newest IMPORT_JOB_HISTORY rows', async () => {
    const store = memoryImportJobStore();
    for (let i = 0; i < IMPORT_JOB_HISTORY + 5; i++) {
      await store.insert({
        id: `j${i}`, status: 'done', startedBy: 'a', startedAt: `2026-09-05T00:00:${String(i).padStart(2, '0')}.000Z`,
        updatedAt: '2026-09-05T00:00:00.000Z', finishedAt: null, progress: planned(), summary: null, error: null,
      });
    }
    expect((await store.latest())?.id).toBe(`j${IMPORT_JOB_HISTORY + 4}`);
    // The oldest were pruned: updating one is a no-op rather than a resurrection.
    await store.update('j0', { status: 'failed' });
    expect(await store.interruptRunning()).toBe(0);
  });
});
