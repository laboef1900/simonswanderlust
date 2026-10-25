import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { createGpxWorker, type GpxWorker } from '../src/gpx-worker.js';
import { GpxError } from '../src/gpx-errors.js';

const input = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>'
  + '<trkpt lat="0" lon="0"/><trkpt lat="0" lon="1"/><trkpt lat="0" lon="2"/>'
  + '</trkseg><trkseg><trkpt lat="10" lon="10"/><trkpt lat="10" lon="11"/></trkseg></trk></gpx>');
const workers: GpxWorker[] = [];
function create(): GpxWorker { const worker = createGpxWorker(); workers.push(worker); return worker; }
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  vi.useRealTimers();
});

describe('real admitted GPX workers', () => {
  it('processes the full route point cap under the real heap/deadline/result limits', async () => {
    const bytes = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>'
      + '<trkpt lat="0" lon="0"/>'.repeat(GPX_LIMITS.points) + '</trkseg></trk></gpx>');
    const result = await create().parse(bytes);
    expect(result.counts.points).toBe(GPX_LIMITS.points);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(GPX_LIMITS.normalizedBytes);
  });

  it('parses and reparses/trims in the worker without detaching or leaking pooled caller bytes', async () => {
    const worker = create();
    const pooled = Buffer.allocUnsafe(input.length + 64).fill(0x7f);
    input.copy(pooled, 32);
    const bytes = pooled.subarray(32, 32 + input.length);
    const before = Buffer.from(pooled);
    const parsed = await worker.parse(bytes);
    expect(parsed.counts).toMatchObject({ inputPoints: 5, points: 5, segments: 2 });
    expect(pooled).toEqual(before);
    const trimmed = await worker.parse(bytes, { selection: { startPoints: 1, endPoints: 0, removedSegments: [1] } });
    expect(trimmed.geometry.segments).toEqual([{ points: [{ lng: 1, lat: 0 }, { lng: 2, lat: 0 }] }]);
    expect(trimmed.counts).toMatchObject({ inputPoints: 5, points: 2, segments: 1 });
    expect(pooled).toEqual(before);
  });

  it('keeps over-public-cap imports editable but refuses Attach until the same staged source is trimmed', async () => {
    const points = Array.from({ length: 2001 }, (_, i) =>
      `<trkpt lat="${i % 2 ? '0.01' : '0'}" lon="${(i * 0.01).toFixed(2)}"/>`).join('');
    const bytes = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>'
      + points + '</trkseg></trk></gpx>');
    const worker = create();
    const preview = await worker.parse(bytes);
    expect(preview.counts.points).toBe(2001);
    await expect(worker.parse(bytes, { selection: { startPoints: 0, endPoints: 0, removedSegments: [] } }))
      .rejects.toMatchObject({ code: 'track_public_limit', statusCode: 422,
        counts: { retainedRuns: 1, vertices: 2001, bytes: expect.any(Number) } });
    // Refusal does not consume or mutate the original; it remains usable for a new selection.
    const trimmed = await worker.parse(bytes, { selection: { startPoints: 1998, endPoints: 0, removedSegments: [] } });
    expect(trimmed.geometry.segments[0]!.points).toEqual(preview.geometry.segments[0]!.points.slice(1998));
    expect(trimmed.counts.points).toBe(3);
  });

  it('refuses a rounding-collapsed Attach without rejecting its import-only preview', async () => {
    const bytes = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>'
      + '<trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.000001"/></trkseg></trk></gpx>');
    const worker = create();
    expect((await worker.parse(bytes)).counts.points).toBe(2);
    await expect(worker.parse(bytes, { selection: { startPoints: 0, endPoints: 0, removedSegments: [] } }))
      .rejects.toMatchObject({ code: 'track_empty_after_rounding', statusCode: 422,
        counts: { retainedRuns: 0, vertices: 0, bytes: 0 } });
    expect((await worker.parse(bytes)).counts.points).toBe(2);
  });

  it('admits one worker process-wide with immediate refusal and no queued retry', async () => {
    const first = create();
    const second = create();
    const parsing = first.parse(input);
    await expect(second.parse(input)).rejects.toMatchObject({ code: 'gpx_busy', statusCode: 429 });
    await parsing;
    expect((await second.parse(input)).counts.points).toBe(5);
  });

  it('terminates on abort and holds admission until termination settles', async () => {
    const first = create();
    const second = create();
    const controller = new AbortController();
    const parsing = first.parse(input, { signal: controller.signal });
    const rejected = expect(parsing).rejects.toMatchObject({ code: 'gpx_aborted', statusCode: 499 });
    controller.abort();
    await expect(second.parse(input)).rejects.toMatchObject({ code: 'gpx_busy' });
    await rejected;
    expect((await second.parse(input)).counts.points).toBe(5);
  });

  it('enforces its parent deadline by terminating an actual worker, then releases admission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = create();
    const parsing = worker.parse(input);
    const rejected = expect(parsing).rejects.toMatchObject({ code: 'gpx_timeout', statusCode: 422 });
    // The real worker has not had an event-loop turn: advance the parent timer, not an in-worker timer.
    vi.advanceTimersByTime(GPX_LIMITS.workerMs);
    await rejected;
    vi.useRealTimers();
    expect((await worker.parse(input)).counts.points).toBe(5);
  });

  it('keeps the main loop responsive during hostile input and bounds its safe failure', async () => {
    const hostile = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><extensions>'
      + '<x a="PRIVATE_SENTINEL"/>'.repeat(150000) + '</extensions></gpx>');
    expect(hostile.byteLength).toBeLessThan(GPX_LIMITS.fileBytes);
    const worker = create();
    let heartbeat = 0;
    // Real heartbeat is the assertion: fake timers cannot demonstrate event-loop isolation.
    const timer = setInterval(() => heartbeat++, 1);
    let caught: unknown;
    try { await worker.parse(hostile); } catch (error) { caught = error; } finally { clearInterval(timer); }
    expect(heartbeat).toBeGreaterThan(0);
    expect(caught).toBeInstanceOf(GpxError);
    if (!(caught instanceof GpxError)) throw new Error('Expected a safe GPX worker error');
    expect(['gpx_empty', 'gpx_timeout', 'gpx_worker_failed']).toContain(caught.code);
    expect(JSON.stringify(caught)).not.toContain('PRIVATE_SENTINEL');
    expect((await worker.parse(input)).counts.points).toBe(5);
  });

  it('closes active work, prevents later admission, and leaves other handles usable', async () => {
    const first = create();
    const parsing = first.parse(input);
    const rejected = expect(parsing).rejects.toMatchObject({ code: 'gpx_aborted' });
    await first.close();
    await rejected;
    await expect(first.parse(input)).rejects.toMatchObject({ code: 'gpx_unavailable', statusCode: 503 });
    expect((await create().parse(input)).counts.points).toBe(5);
  });

  it('refuses invalid input/selection and propagates only coded point errors', async () => {
    const worker = create();
    await expect(worker.parse(new Uint8Array(GPX_LIMITS.fileBytes + 1))).rejects.toMatchObject({ code: 'gpx_too_large', statusCode: 413 });
    const controller = new AbortController();
    controller.abort();
    await expect(worker.parse(input, { signal: controller.signal })).rejects.toMatchObject({ code: 'gpx_aborted' });
    await expect(worker.parse(input, { selection: { startPoints: 0, endPoints: 0, removedSegments: [1, 1] } })).rejects.toMatchObject({ code: 'gpx_invalid_selection', statusCode: 400 });
    await expect(worker.parse(input, { selection: { startPoints: 5, endPoints: 0, removedSegments: [] } })).rejects.toMatchObject({ code: 'gpx_empty_selection' });
    await expect(worker.parse(Buffer.from(input.toString().replace('lat="0"', 'lat="PRIVATE_SENTINEL"')))).rejects.toMatchObject({ code: 'gpx_invalid_points', invalidPoints: 1, message: 'gpx_invalid_points' });
  });
});
