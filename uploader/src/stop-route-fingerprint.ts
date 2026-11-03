import { createHash } from 'node:crypto';
import { stopRouteBasis } from '../public/stop-route.js';

/**
 * Synchronous server twin of stopRouteFingerprint() (the browser one is async
 * SubtleCrypto). Both hash the same basis string, so their hex digests match.
 */
export function stopRouteFingerprintSync(stops: Parameters<typeof stopRouteBasis>[0]): string {
  return createHash('sha256').update(stopRouteBasis(stops)).digest('hex');
}
