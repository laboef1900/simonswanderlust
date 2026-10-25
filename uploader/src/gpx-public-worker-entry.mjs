import { parentPort, workerData } from 'node:worker_threads';
import { createPublicTrack, PUBLIC_TRACK_LIMITS, PublicTrackError } from '../public/gpx-public-track.js';
import { GPX_LIMITS } from '../public/gpx-geometry.js';

if (!parentPort) throw new Error('gpx_worker_unavailable');
try {
  if (!(workerData.bytes instanceof ArrayBuffer) || workerData.bytes.byteLength > GPX_LIMITS.normalizedBytes) {
    throw new Error('gpx_limit');
  }
  const geometry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workerData.bytes));
  const result = createPublicTrack(geometry);
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  // PublicTrackResult adds a fixed wrapper and one bounded count to the 64 KiB artifact.
  if (bytes.byteLength > PUBLIC_TRACK_LIMITS.bytes + 64) throw new Error('track_public_limit');
  parentPort.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
} catch (error) {
  const safeCodes = ['track_empty_after_rounding', 'track_public_limit', 'gpx_invalid_geometry', 'gpx_limit'];
  const code = error instanceof Error && safeCodes.includes(error.message) ? error.message : 'gpx_worker_failed';
  parentPort.postMessage({ ok: false, code,
    ...(error instanceof PublicTrackError && error.counts ? { counts: error.counts } : {}) });
}
