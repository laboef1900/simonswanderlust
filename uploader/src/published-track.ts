import { validatePublicTrack, type PublicTrack } from '../public/gpx-public-track.js';
import type { LanguageConfig } from './language.js';

export interface PublishedTrackRow {
  locale: unknown;
  status: unknown;
  omitted: unknown;
  published_at: unknown;
  published_snapshot: unknown;
}

export interface PublishedTrackProjection {
  language: LanguageConfig;
  /** Retained snapshot membership, not working coverage or public visibility. */
  locales: ('de' | 'en')[];
  track?: PublicTrack;
}

function hasTrack(snapshot: unknown): snapshot is { track: unknown } {
  return snapshot !== null && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'track');
}

/** Validate the complete physical pair before interpreting an absent counterpart. */
export function publishedTrackOf(rows: readonly PublishedTrackRow[], language: LanguageConfig): PublishedTrackProjection {
  try {
    if (rows.length !== 2 || !rows.some(row => row.locale === 'de') || !rows.some(row => row.locale === 'en')) throw new Error();
    const primary = rows.find(row => row.locale === language.primary)!;
    const snapshots: PublishedTrackRow[] = [];
    for (const row of rows) {
      if (typeof row.omitted !== 'boolean' || (row.status !== 'draft' && row.status !== 'published')) throw new Error();
      const snapshot = row.published_snapshot;
      const history = row.published_at;
      if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) throw new Error();
      if (history !== null && !(history instanceof Date ? Number.isFinite(history.getTime()) : typeof history === 'string' && Number.isFinite(Date.parse(history)))) throw new Error();
      if (row.omitted && (row.status !== 'draft' || snapshot !== null || history !== null)) throw new Error();
      if (!language.locales.includes(row.locale as 'de' | 'en') && (snapshot !== null || history !== null || row.status !== 'draft')) throw new Error();
      if ((history !== null || row.status === 'published') && snapshot === null) throw new Error();
      if (snapshot !== null && history === null) throw new Error();
      if (row.status === 'published' && primary.status !== 'published') throw new Error();
      if (snapshot !== null) snapshots.push(row);
    }
    if (primary.omitted || (snapshots.length && primary.published_snapshot === null)) throw new Error();
    const result: PublishedTrackProjection = { language, locales: snapshots.map(row => row.locale as 'de' | 'en') };
    if (!snapshots.some(row => hasTrack(row.published_snapshot))) return result;
    for (const row of snapshots) {
      if (!hasTrack(row.published_snapshot)) throw new Error();
      const track = validatePublicTrack(row.published_snapshot.track);
      if (result.track && JSON.stringify(result.track.coordinates) !== JSON.stringify(track.coordinates)) throw new Error();
      result.track = track;
    }
    return result;
  } catch {
    throw new Error('invalid_published_track');
  }
}
