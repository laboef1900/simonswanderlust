import { Worker } from 'node:worker_threads';
import { GPX_LIMITS, type PrivateGeometry } from '../public/gpx-geometry.js';
import { PUBLIC_TRACK_LIMITS, validatePublicTrack, type PublicTrackResult } from '../public/gpx-public-track.js';
import { GpxError, readPublicTrackCounts } from './gpx-errors.js';

export interface PublicTrackWorker {
  transform(geometry: PrivateGeometry, options?: { signal?: AbortSignal }): Promise<PublicTrackResult>;
  close(): Promise<void>;
}
interface ActiveJob { owner: object; cancel: () => Promise<void> }
// Independent process-wide admin slot: author imports cannot consume Publish admission.
let active: ActiveJob | undefined;
const safeCodes = ['track_empty_after_rounding', 'track_public_limit', 'gpx_invalid_geometry', 'gpx_limit', 'gpx_worker_failed'];

export function createPublicTrackWorker(): PublicTrackWorker {
  const owner = {};
  let closed = false;
  return {
    async transform(geometry, options = {}) {
      if (closed) throw new GpxError('gpx_unavailable', 503);
      if (options.signal?.aborted) throw new GpxError('gpx_aborted', 499);
      if (active) throw new GpxError('publish_busy', 409);
      // Geometry comes from the private store, not the HTTP body. Bound transport;
      // all geometry validation and simplification still execute inside the worker.
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = new TextEncoder().encode(JSON.stringify(geometry)); }
      catch { throw new GpxError('gpx_invalid_geometry'); }
      if (bytes.byteLength > GPX_LIMITS.normalizedBytes) throw new GpxError('gpx_limit');
      const { promise, resolve, reject } = Promise.withResolvers<PublicTrackResult>();
      let worker: Worker;
      try {
        worker = new Worker(new URL('./gpx-public-worker-entry.mjs', import.meta.url), {
          workerData: { bytes: bytes.buffer }, transferList: [bytes.buffer],
          execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          stdout: true, stderr: true,
        });
      } catch { throw new GpxError('gpx_worker_failed'); }
      worker.stdout?.resume();
      worker.stderr?.resume();
      let stopping: Promise<void> | undefined;
      const finish = (error?: GpxError, result?: PublicTrackResult): Promise<void> => {
        if (stopping) return stopping;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', abort);
        stopping = (async () => {
          try { await worker.terminate(); }
          catch { error = new GpxError('gpx_worker_failed'); }
          finally {
            if (active?.owner === owner) active = undefined;
            if (error) reject(error);
            else if (result) resolve(result);
            else reject(new GpxError('gpx_worker_failed'));
          }
        })();
        return stopping;
      };
      const abort = () => { void finish(new GpxError('gpx_aborted', 499)); };
      const deadline = setTimeout(() => { void finish(new GpxError('gpx_timeout')); }, GPX_LIMITS.workerMs);
      active = { owner, cancel: () => finish(new GpxError('gpx_aborted', 499)) };
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.once('error', () => { void finish(new GpxError('gpx_worker_failed')); });
      worker.once('exit', () => { if (!stopping) void finish(new GpxError('gpx_worker_failed')); });
      worker.once('message', (message: unknown) => {
        if (stopping) return;
        if (!message || typeof message !== 'object') { void finish(new GpxError('gpx_worker_failed')); return; }
        const response = message as Record<string, unknown>;
        if (response.ok === true && response.bytes instanceof ArrayBuffer
          && response.bytes.byteLength > 0 && response.bytes.byteLength <= PUBLIC_TRACK_LIMITS.bytes + 64) {
          try {
            const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes));
            if (!result || typeof result !== 'object' || Array.isArray(result)
              || Object.keys(result).length !== 2 || !('track' in result) || !('collapsedRuns' in result)
              || typeof result.collapsedRuns !== 'number' || !Number.isSafeInteger(result.collapsedRuns)
              || result.collapsedRuns < 0 || result.collapsedRuns > GPX_LIMITS.segments) throw new Error('gpx_worker_failed');
            const track = validatePublicTrack(result.track);
            void finish(undefined, { track, collapsedRuns: result.collapsedRuns });
          } catch { void finish(new GpxError('gpx_worker_failed')); }
        } else if (response.ok === false && typeof response.code === 'string' && safeCodes.includes(response.code)) {
          try { void finish(new GpxError(response.code, 422, undefined, readPublicTrackCounts(response.counts))); }
          catch { void finish(new GpxError('gpx_worker_failed')); }
        } else void finish(new GpxError('gpx_worker_failed'));
      });
      if (options.signal?.aborted) abort();
      return await promise;
    },
    async close() {
      closed = true;
      if (active?.owner === owner) await active.cancel();
    },
  };
}
