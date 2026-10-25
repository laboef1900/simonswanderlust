import { PUBLIC_TRACK_LIMITS, type PublicTrackCounts } from '../public/gpx-public-track.js';

// Codes/counts only: never retain XML values, parser causes, paths or worker messages.
export class GpxError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly invalidPoints?: number;
  readonly counts?: PublicTrackCounts;

  constructor(code: string, statusCode = 422, invalidPoints?: number, counts?: PublicTrackCounts) {
    super(code);
    this.name = 'GpxError';
    this.code = code;
    this.statusCode = statusCode;
    if (invalidPoints !== undefined) this.invalidPoints = invalidPoints;
    if (counts !== undefined) this.counts = counts;
  }
}

/** Validate worker count metadata before exposing it to an HTTP caller. */
export function readPublicTrackCounts(value: unknown): PublicTrackCounts | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !('retainedRuns' in value) || !('vertices' in value) || !('bytes' in value)
    || typeof value.retainedRuns !== 'number' || !Number.isSafeInteger(value.retainedRuns)
    || value.retainedRuns < 0 || value.retainedRuns > PUBLIC_TRACK_LIMITS.runs + 1
    || typeof value.vertices !== 'number' || !Number.isSafeInteger(value.vertices)
    || value.vertices < 0 || value.vertices > PUBLIC_TRACK_LIMITS.vertices + 1
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0 || value.bytes > PUBLIC_TRACK_LIMITS.bytes + 1
    || ((value.retainedRuns === 0 || value.vertices === 0 || value.bytes === 0)
      && (value.retainedRuns !== 0 || value.vertices !== 0 || value.bytes !== 0))) {
    throw new GpxError('gpx_worker_failed');
  }
  return { retainedRuns: value.retainedRuns, vertices: value.vertices, bytes: value.bytes };
}
