import { parentPort, workerData } from 'node:worker_threads';
import { GPX_LIMITS, trimGeometry, validateGeometry, type TrimSelection } from '../public/gpx-geometry.js';
import { createPublicTrack, PublicTrackError } from '../public/gpx-public-track.js';
import { parseGpx } from './gpx-parser.js';
import { GpxError } from './gpx-errors.js';

if (!parentPort) throw new Error('gpx_worker_unavailable');
const input: { bytes: ArrayBuffer; selection?: TrimSelection } = workerData;
try {
  const preview = parseGpx(new Uint8Array(input.bytes));
  if (input.selection !== undefined) {
    const trimmed = trimGeometry(preview.geometry, input.selection);
    validateGeometry(trimmed.geometry);
    // Import-only previews stay available for trimming; Attach must pass the exact
    // same public transform as Publish before any existing route can be replaced.
    createPublicTrack(trimmed.geometry);
    preview.geometry = trimmed.geometry;
    preview.counts.points = trimmed.geometry.segments.reduce((total, run) => total + run.points.length, 0);
    preview.counts.segments = trimmed.geometry.segments.length;
    preview.counts.droppedSegments += trimmed.droppedSegments;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(preview));
  if (bytes.byteLength > GPX_LIMITS.normalizedBytes) throw new GpxError('gpx_limit');
  parentPort.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
} catch (error) {
  const sharedCodes = ['gpx_invalid_geometry', 'gpx_invalid_selection', 'gpx_empty_selection', 'gpx_limit',
    'track_empty_after_rounding', 'track_public_limit'];
  const code = error instanceof GpxError ? error.code
    : error instanceof Error && sharedCodes.includes(error.message) ? error.message : 'gpx_worker_failed';
  parentPort.postMessage({ ok: false, code, statusCode: error instanceof GpxError ? error.statusCode
    : code === 'gpx_invalid_selection' ? 400 : 422,
    invalidPoints: error instanceof GpxError ? error.invalidPoints : undefined,
    counts: error instanceof PublicTrackError || error instanceof GpxError ? error.counts : undefined });
}
