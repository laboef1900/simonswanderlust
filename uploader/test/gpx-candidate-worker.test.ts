import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createPublicTrack } from '../public/gpx-public-track.js';
import type { PrivateGeometry } from '../public/gpx-geometry.js';

// Run the real browser module with only its message-port globals supplied. No
// duplicate transform or network implementation is substituted by this adapter.
async function candidate(geometry: unknown): Promise<unknown> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = { postMessage: (value) => parentPort.postMessage(value) };
    import(workerData.url).then(() => self.onmessage({ data: { geometry: workerData.geometry } }));
  `, { eval: true, execArgv: [], workerData: { geometry,
    url: new URL('../public/gpx-candidate-worker.js', import.meta.url).href }, stdout: true, stderr: true });
  worker.stdout?.resume();
  worker.stderr?.resume();
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', () => reject(new Error('Candidate worker exited without a result')));
  try { return await promise; }
  finally { await worker.terminate(); }
}

describe('browser candidate module worker', () => {
  it('emits the same canonical artifact and collapsed-run count as the admitted server transform', async () => {
    const geometry: PrivateGeometry = { version: 1, segments: [
      { points: [{ lng: 0, lat: 0 }, { lng: 0.000001, lat: 0 }] },
      { points: [{ lng: 1.123456, lat: 0, elevation: 98765, time: '2026-10-23T12:34:56.789Z' },
        { lng: 2, lat: 0 }, { lng: 3.123456, lat: 0 }] },
    ] };
    const message = await candidate(geometry);
    expect(message).toEqual({ ok: true, result: createPublicTrack(geometry) });
    expect(JSON.stringify(message)).not.toContain('98765');
    expect(JSON.stringify(message)).not.toContain('2026-10-23');
  });

  it('returns only safe codes and bounded public counts for refusals', async () => {
    expect(await candidate({ version: 1, segments: [{ points: [{ lng: 0, lat: 0 }, { lng: 0.000001, lat: 0 }] }] }))
      .toEqual({ ok: false, code: 'track_empty_after_rounding', counts: { retainedRuns: 0, vertices: 0, bytes: 0 } });
    expect(await candidate({ private: 'PRIVATE_SENTINEL' })).toEqual({ ok: false, code: 'gpx_invalid_geometry' });
  });

  it('refuses an over-cap candidate without falling back to precise private geometry', async () => {
    expect(await candidate({ version: 1, segments: [{ points: Array.from({ length: 2001 }, (_, i) => ({
      lng: i * 0.01, lat: i % 2 ? 0.01 : 0,
    })) }] })).toEqual({ ok: false, code: 'track_public_limit',
      counts: { retainedRuns: 1, vertices: 2001, bytes: expect.any(Number) } });
  });
});
