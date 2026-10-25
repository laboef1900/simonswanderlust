import type { PrivateGeometry } from './gpx-geometry.js';

export interface PublicTrack {
  version: 1;
  type: 'MultiLineString';
  coordinates: [number, number][][];
}
export interface PublicTrackResult { track: PublicTrack; collapsedRuns: number }
/** Saturated at the public limits plus one; lower bounds when work stops early. */
export interface PublicTrackCounts { retainedRuns: number; vertices: number; bytes: number }
export class PublicTrackError extends Error {
  readonly counts?: PublicTrackCounts;
  constructor(code: string, counts?: PublicTrackCounts);
}
export const PUBLIC_TRACK_LIMITS: Readonly<{ runs: 100; vertices: 2000; bytes: 65536 }>;
export function createPublicTrack(geometry: PrivateGeometry): PublicTrackResult;
export function validatePublicTrack(value: unknown): PublicTrack;
