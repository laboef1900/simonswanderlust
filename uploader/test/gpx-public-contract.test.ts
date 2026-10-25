import { describe, expect, it } from 'vitest';
import { createPublicTrack, validatePublicTrack, type PublicTrack } from '../public/gpx-public-track.js';
import { publicTrackSchema, type PublicTrack as ContentPublicTrack } from '../../site/src/lib/public-track.js';

// Mutual assignability alone misses optional fields added on one side. This
// exact identity check pins keys, tuple arity, literals and optionality too.
// site/map-data.test.ts completes the chain to generated content + TripGeometry.
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false;
const publicShape: Exact<PublicTrack, ContentPublicTrack> = true;
const optionalShape: Exact<PublicTrack | undefined, ContentPublicTrack | undefined> = true;
const expectedShape: Exact<PublicTrack, {
  version: 1; type: 'MultiLineString'; coordinates: [number, number][][];
}> = true;
void publicShape;
void optionalShape;
void expectedShape;

const track: PublicTrack = {
  version: 1, type: 'MultiLineString',
  coordinates: [[[10.1235, 20.1235], [10.1245, 20.1245]], [[-20.1235, -10.1235], [-20.1245, -10.1245]]],
};

describe('uploader ↔ content public track contract', () => {

  it('round-trips the canonical public transform through JSON and the real site schema', () => {
    const result = createPublicTrack({ version: 1, segments: [
      { points: [
        { lng: 10.123456, lat: 20.123456, elevation: 1234, time: '2026-10-23T01:02:03.000Z' },
        { lng: 10.124456, lat: 20.124456, elevation: 1235, time: '2026-10-23T01:03:03.000Z' },
      ] },
      { points: [
        { lng: -20.123456, lat: -10.123456, elevation: 1236, time: '2026-10-23T02:02:03.000Z' },
        { lng: -20.124456, lat: -10.124456, elevation: 1237, time: '2026-10-23T02:03:03.000Z' },
      ] },
    ] });
    expect(result.track).toEqual(track);
    const decoded: unknown = JSON.parse(JSON.stringify(result.track));
    const content = publicTrackSchema.parse(decoded);
    expect(content).toEqual(track);
    expect(validatePublicTrack(content)).toEqual(track);
    expect(Object.keys(content)).toEqual(['version', 'type', 'coordinates']);
    expect(content.coordinates.flat().every((point) => point.length === 2)).toBe(true);
  });

  it.each([
    { ...track, original: 'private.gpx' },
    { ...track, removedPoints: 3 },
    { ...track, coordinates: [[[1, 2, 999], [3, 4, 1000]]] },
    { ...track, coordinates: [[[1.12345, 2], [3, 4]]] },
    { ...track, coordinates: [[[1, NaN], [3, 4]]] },
    { ...track, coordinates: [[[-0, 2], [3, 4]]] },
    { ...track, coordinates: [[[1, 2], [1, 2]]] },
    { ...track, coordinates: [] },
  ])('rejects malformed/private data on both sides (%#)', (value) => {
    expect(() => validatePublicTrack(value)).toThrow();
    expect(publicTrackSchema.safeParse(value).success).toBe(false);
  });
});
