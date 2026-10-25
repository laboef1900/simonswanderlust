import { createPublicTrack, PublicTrackError } from './gpx-public-track.js';

// The dialog owns cancellation, deadline and epoch checks; this worker has no I/O.
self.onmessage = (event) => {
  try {
    const result = createPublicTrack(event.data?.geometry);
    self.postMessage({ ok: true, result });
  } catch (error) {
    const safeCodes = ['track_empty_after_rounding', 'track_public_limit', 'gpx_invalid_geometry', 'gpx_limit'];
    const code = error instanceof Error && safeCodes.includes(error.message) ? error.message : 'gpx_worker_failed';
    self.postMessage({ ok: false, code,
      ...(error instanceof PublicTrackError && error.counts ? { counts: error.counts } : {}) });
  }
};
