import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from 'node:worker_threads';
import { PUBLIC_TRACK_LIMITS } from '../public/gpx-public-track.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { readPublicTrackCounts } from '../src/gpx-errors.js';

interface ControlledWorker {
  options: WorkerOptions;
  emit(event: string, value?: unknown): void;
  termination: PromiseWithResolvers<number>;
}
const state = vi.hoisted(() => ({ workers: [] as ControlledWorker[] }));
vi.mock('node:worker_threads', () => ({
  Worker: class {
    options: WorkerOptions;
    callbacks: Record<string, ((value: unknown) => void) | undefined> = {};
    termination = Promise.withResolvers<number>();
    stdout = { resume() {} };
    stderr = { resume() {} };
    constructor(_url: URL, options: WorkerOptions) { this.options = options; state.workers.push(this); }
    once(event: string, callback: (value: unknown) => void) { this.callbacks[event] = callback; return this; }
    emit(event: string, value?: unknown) { this.callbacks[event]?.(value); }
    terminate() { return this.termination.promise; }
  },
}));
const handles: PublicTrackWorker[] = [];
const geometry = { version: 1 as const, segments: [{ points: [{ lng: 0, lat: 0 }, { lng: 1, lat: 0 }] }] };
function create(): PublicTrackWorker { const handle = createPublicTrackWorker(); handles.push(handle); return handle; }
afterEach(async () => {
  for (const worker of state.workers.splice(0)) worker.termination.resolve(0);
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('public worker parent trust boundary', () => {
  it('configures bounded isolated heaps and keeps its slot until successful-result termination completes', async () => {
    const first = create();
    const second = create();
    const pending = first.transform(geometry);
    const worker = state.workers[0]!;
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
    expect(worker.options.execArgv).toEqual([]);
    const result = { track: { version: 1, type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]]] }, collapsedRuns: 0 };
    worker.emit('message', { ok: true, bytes: new TextEncoder().encode(JSON.stringify(result)).buffer });
    await expect(second.transform(geometry)).rejects.toMatchObject({ code: 'publish_busy' });
    worker.termination.resolve(0);
    expect(await pending).toEqual(result);
  });

  it.each([
    { ok: true, bytes: new ArrayBuffer(PUBLIC_TRACK_LIMITS.bytes + 65) },
    { ok: true, bytes: new TextEncoder().encode('PRIVATE_SENTINEL').buffer },
    { ok: true, bytes: new TextEncoder().encode(JSON.stringify({
      track: { version: 1, type: 'MultiLineString', coordinates: [[[0, 0, 999], [1, 0]]] }, collapsedRuns: 0,
    })).buffer },
    { ok: false, code: 'PRIVATE_SENTINEL', statusCode: 500 },
    { ok: false, code: 'track_public_limit', counts: { retainedRuns: 1, vertices: 2, bytes: 'PRIVATE_SENTINEL' } },
    { ok: false, code: 'track_public_limit', counts: { retainedRuns: 1, vertices: 2002, bytes: 100 } },
  ])('sanitizes malformed, oversized or untrusted result envelopes', async (message) => {
    const pending = create().transform(geometry);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'gpx_worker_failed', message: 'gpx_worker_failed' });
    const worker = state.workers[0]!;
    worker.emit('message', message);
    worker.termination.resolve(0);
    await rejected;
  });

  it.each(['error', 'exit'])('sanitizes an unexpected worker %s and waits for termination', async (event) => {
    const pending = create().transform(geometry);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'gpx_worker_failed', message: 'gpx_worker_failed' });
    const worker = state.workers[0]!;
    worker.emit(event, new Error('PRIVATE_SENTINEL'));
    await expect(create().transform(geometry)).rejects.toMatchObject({ code: 'publish_busy' });
    worker.termination.resolve(0);
    await rejected;
  });

  it('never accepts a late successful message after cancellation has begun', async () => {
    const controller = new AbortController();
    const pending = create().transform(geometry, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'gpx_aborted' });
    const worker = state.workers[0]!;
    controller.abort();
    worker.emit('message', { ok: true, bytes: new TextEncoder().encode(JSON.stringify({
      track: { version: 1, type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]]] }, collapsedRuns: 0,
    })).buffer });
    worker.termination.resolve(0);
    await rejected;
  });
});

describe('bounded public refusal count metadata', () => {
  it('accepts only closed integer count objects, including saturated lower bounds', () => {
    expect(readPublicTrackCounts(undefined)).toBeUndefined();
    expect(readPublicTrackCounts({ retainedRuns: 0, vertices: 0, bytes: 0 })).toEqual({ retainedRuns: 0, vertices: 0, bytes: 0 });
    expect(readPublicTrackCounts({ retainedRuns: 101, vertices: 2001, bytes: 65537 }))
      .toEqual({ retainedRuns: 101, vertices: 2001, bytes: 65537 });
    for (const value of [null, [], { retainedRuns: 1, vertices: 2, bytes: 0 },
      { retainedRuns: 102, vertices: 2, bytes: 100 }, { retainedRuns: 1, vertices: 2002, bytes: 100 },
      { retainedRuns: 1, vertices: 2, bytes: 65538 }, { retainedRuns: 1, vertices: NaN, bytes: 100 },
      { retainedRuns: 1, vertices: 2.5, bytes: 100 }, { retainedRuns: 1, vertices: 2, bytes: 'PRIVATE_SENTINEL' },
      { retainedRuns: 1, vertices: 2, bytes: 100, geometry: 'PRIVATE_SENTINEL' }]) {
      expect(() => readPublicTrackCounts(value)).toThrow('gpx_worker_failed');
    }
  });
});
