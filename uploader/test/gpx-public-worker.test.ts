import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPX_LIMITS, type PrivateGeometry } from '../public/gpx-geometry.js';
import { createPublicTrack, type PublicTrackResult } from '../public/gpx-public-track.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { createGpxWorker, type GpxWorker } from '../src/gpx-worker.js';

const geometry: PrivateGeometry = { version: 1, segments: [{ points: [
  { lng: 1.123456, lat: 0, elevation: 12345.6789, time: '2026-10-23T12:34:56.789Z' },
  { lng: 1.5, lat: 0 }, { lng: 2.123456, lat: 0 },
] }] };
const input = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>'
  + '<trkpt lat="0" lon="0"/><trkpt lat="0" lon="1"/></trkseg></trk></gpx>');
const workers: (PublicTrackWorker | GpxWorker)[] = [];
function create(): PublicTrackWorker { const worker = createPublicTrackWorker(); workers.push(worker); return worker; }
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  vi.useRealTimers();
});

describe('separate process-wide admitted public transform worker', () => {
  it('returns exactly the canonical bounded public result without mutating private input', async () => {
    const before = structuredClone(geometry);
    const result: PublicTrackResult = await create().transform(geometry);
    expect(result).toEqual(createPublicTrack(geometry));
    expect(Object.keys(result).sort()).toEqual(['collapsedRuns', 'track']);
    expect(JSON.stringify(result)).not.toContain('12345.6789');
    expect(JSON.stringify(result)).not.toContain('2026-10-23');
    expect(geometry).toEqual(before);
  });

  it('admits an author and an admin concurrently but never two admins or two authors', async () => {
    const author = createGpxWorker();
    const otherAuthor = createGpxWorker();
    workers.push(author, otherAuthor);
    const admin = create();
    const otherAdmin = create();
    const parsing = author.parse(input);
    const transforming = admin.transform(geometry);
    await expect(otherAuthor.parse(input)).rejects.toMatchObject({ code: 'gpx_busy', statusCode: 429 });
    await expect(otherAdmin.transform(geometry)).rejects.toMatchObject({ code: 'publish_busy', statusCode: 409 });
    expect((await parsing).counts.points).toBe(2);
    expect(await transforming).toEqual(createPublicTrack(geometry));
    expect(await otherAdmin.transform(geometry)).toEqual(createPublicTrack(geometry));
  });

  it('waits for actual termination on abort before releasing process-wide admission', async () => {
    const first = create();
    const second = create();
    const controller = new AbortController();
    const transforming = first.transform(geometry, { signal: controller.signal });
    const rejected = expect(transforming).rejects.toMatchObject({ code: 'gpx_aborted', statusCode: 499 });
    controller.abort();
    await expect(second.transform(geometry)).rejects.toMatchObject({ code: 'publish_busy', statusCode: 409 });
    await rejected;
    expect(await second.transform(geometry)).toEqual(createPublicTrack(geometry));
  });

  it('enforces the two-second parent deadline independently of worker code and recovers admission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = create();
    const transforming = worker.transform(geometry);
    const rejected = expect(transforming).rejects.toMatchObject({ code: 'gpx_timeout', statusCode: 422 });
    vi.advanceTimersByTime(GPX_LIMITS.workerMs);
    await rejected;
    vi.useRealTimers();
    expect(await worker.transform(geometry)).toEqual(createPublicTrack(geometry));
  });

  it('closes only its own work, holds admission through termination, and never reopens', async () => {
    const idle = create();
    const active = create();
    const transforming = active.transform(geometry);
    await idle.close();
    expect(await transforming).toEqual(createPublicTrack(geometry));
    await expect(idle.transform(geometry)).rejects.toMatchObject({ code: 'gpx_unavailable', statusCode: 503 });
    const cancelling = active.transform(geometry);
    const rejected = expect(cancelling).rejects.toMatchObject({ code: 'gpx_aborted' });
    const closing = active.close();
    await expect(create().transform(geometry)).rejects.toMatchObject({ code: 'publish_busy' });
    await closing;
    await rejected;
    await expect(active.transform(geometry)).rejects.toMatchObject({ code: 'gpx_unavailable' });
    expect(await create().transform(geometry)).toEqual(createPublicTrack(geometry));
  });

  it('refuses pre-aborted requests without consuming admission and sanitizes worker errors', async () => {
    const worker = create();
    const controller = new AbortController();
    controller.abort();
    await expect(worker.transform(geometry, { signal: controller.signal })).rejects.toMatchObject({ code: 'gpx_aborted', statusCode: 499 });
    const invalid = structuredClone(geometry);
    invalid.segments[0]!.points[0]!.time = 'PRIVATE_SENTINEL';
    const failed = worker.transform(invalid);
    await expect(failed).rejects.toMatchObject({ code: 'gpx_invalid_geometry', message: 'gpx_invalid_geometry' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    expect(await worker.transform(geometry)).toEqual(createPublicTrack(geometry));
  });

  it('reports collapse and output-cap failures instead of precise or truncated fallbacks', async () => {
    const worker = create();
    await expect(worker.transform({ version: 1, segments: [{ points: [{ lng: 0, lat: 0 }, { lng: 0.000001, lat: 0 }] }] }))
      .rejects.toMatchObject({ code: 'track_empty_after_rounding', statusCode: 422, counts: { retainedRuns: 0, vertices: 0, bytes: 0 } });
    const complex: PrivateGeometry = { version: 1, segments: [{ points: Array.from({ length: 2001 }, (_, i) => ({ lng: i * 0.01, lat: i % 2 ? 0.01 : 0 })) }] };
    await expect(worker.transform(complex)).rejects.toMatchObject({ code: 'track_public_limit', statusCode: 422,
      counts: { retainedRuns: 1, vertices: 2001, bytes: expect.any(Number) } });
    expect(await worker.transform(geometry)).toEqual(createPublicTrack(geometry));
  });
});
