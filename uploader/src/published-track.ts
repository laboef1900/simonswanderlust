import { validatePublicTrack, type PublicTrack } from '../public/gpx-public-track.js';

export interface PublishedTrackRow {
  locale: unknown;
  published_snapshot: unknown;
}

function hasTrack(snapshot: unknown): snapshot is { track: unknown } {
  return snapshot !== null && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'track');
}

/** Only the last published pair is authoritative; never fill a missing side from a draft. */
export function publishedTrackOf(rows: readonly PublishedTrackRow[]): PublicTrack | undefined {
  if (!rows.some(row => hasTrack(row.published_snapshot))) return undefined;
  try {
    if (rows.length !== 2) throw new Error();
    const de = rows.find(row => row.locale === 'de')?.published_snapshot;
    const en = rows.find(row => row.locale === 'en')?.published_snapshot;
    if (!hasTrack(de) || !hasTrack(en)) throw new Error();
    const left = validatePublicTrack(de.track);
    const right = validatePublicTrack(en.track);
    // Closed validation fixes version/type. JSON number syntax and object-key
    // order are not identity; coordinate order and run boundaries are.
    if (JSON.stringify(left.coordinates) !== JSON.stringify(right.coordinates)) throw new Error();
    return left;
  } catch {
    throw new Error('invalid_published_track');
  }
}
