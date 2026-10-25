import { Worker } from 'node:worker_threads';
import { GPX_LIMITS, type TrimSelection } from '../public/gpx-geometry.js';
import { assertGpxDecoders, type GpxPreview } from './gpx-parser.js';
import { GpxError, readPublicTrackCounts } from './gpx-errors.js';

export interface GpxWorker {
  parse(bytes: Uint8Array, options?: { signal?: AbortSignal; selection?: TrimSelection }): Promise<GpxPreview>;
  close(): Promise<void>;
}
interface ActiveJob { owner: object; cancel: () => Promise<void> }
// Process-wide, not one slot per createGpxWorker() caller. There is deliberately no queue.
let active: ActiveJob | undefined;

export function createGpxWorker(): GpxWorker {
  assertGpxDecoders();
  const owner = {};
  let closed = false;
  return {
    async parse(bytes, options = {}) {
      if (closed) throw new GpxError('gpx_unavailable', 503);
      if (options.signal?.aborted) throw new GpxError('gpx_aborted', 499);
      if (active) throw new GpxError('gpx_busy', 429);
      if (bytes.byteLength > GPX_LIMITS.fileBytes) throw new GpxError('gpx_too_large', 413);
      if (!bytes.byteLength) throw new GpxError('gpx_invalid_xml');
      // Bound selection serialization before workerData cloning, even for non-HTTP callers.
      if (options.selection !== undefined) {
        const selection = options.selection;
        if (!selection || typeof selection !== 'object' || Array.isArray(selection)
          || Object.keys(selection).some((key) => !['startPoints', 'endPoints', 'removedSegments'].includes(key))
          || !Number.isSafeInteger(selection.startPoints) || selection.startPoints < 0
          || !Number.isSafeInteger(selection.endPoints) || selection.endPoints < 0
          || !Array.isArray(selection.removedSegments) || selection.removedSegments.length > GPX_LIMITS.segments
          || selection.removedSegments.some((index) => !Number.isSafeInteger(index) || index < 0)) {
          throw new GpxError('gpx_invalid_selection', 400);
        }
      }
      // A pooled Buffer may cover unrelated private bytes. Transfer only an exclusively owned copy.
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      const { promise, resolve, reject } = Promise.withResolvers<GpxPreview>();
      let worker: Worker;
      try {
        worker = new Worker(new URL('./gpx-worker-entry.mjs', import.meta.url), {
          workerData: { bytes: owned.buffer, selection: options.selection }, transferList: [owned.buffer],
          execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          stdout: true, stderr: true,
        });
      } catch { throw new GpxError('gpx_worker_failed'); }
      worker.stdout?.resume();
      worker.stderr?.resume();
      let stopping: Promise<void> | undefined;
      const finish = (error?: GpxError, result?: GpxPreview): Promise<void> => {
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
          && response.bytes.byteLength > 0 && response.bytes.byteLength <= GPX_LIMITS.normalizedBytes) {
          try {
            // Only our worker's bounded normalized result is decoded here; XML never runs on this thread.
            const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) as GpxPreview;
            void finish(undefined, result);
          } catch { void finish(new GpxError('gpx_worker_failed')); }
        } else if (response.ok === false && typeof response.code === 'string'
          && (/^gpx_[a-z_]{1,40}$/.test(response.code)
            || response.code === 'track_empty_after_rounding' || response.code === 'track_public_limit')
          && (response.statusCode === 400 || response.statusCode === 413 || response.statusCode === 422 || response.statusCode === 503)
          && (response.invalidPoints === undefined || (typeof response.invalidPoints === 'number'
            && Number.isSafeInteger(response.invalidPoints) && response.invalidPoints > 0
            && response.invalidPoints <= GPX_LIMITS.points + GPX_LIMITS.waypoints))) {
          try {
            void finish(new GpxError(response.code, response.statusCode, response.invalidPoints as number | undefined,
              readPublicTrackCounts(response.counts)));
          } catch { void finish(new GpxError('gpx_worker_failed')); }
        } else void finish(new GpxError('gpx_worker_failed'));
      });
      // Covers an abort that arrived while creating the worker, before listener registration.
      if (options.signal?.aborted) abort();
      return await promise;
    },
    async close() {
      closed = true;
      if (active?.owner === owner) await active.cancel();
    },
  };
}
