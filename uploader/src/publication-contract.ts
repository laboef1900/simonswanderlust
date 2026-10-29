export type PublicationLocale = 'de' | 'en';
export type LiveState = 'live' | 'older-version-live' | 'not-live' | 'unknown';
export type Publication =
  | { availability: 'available'; status: 'draft' | 'published'; requestedLocales: PublicationLocale[];
      committedLocales: PublicationLocale[]; draftDiffers: boolean; live: Record<PublicationLocale, LiveState> }
  | { availability: 'unavailable' }
  | { availability: 'missing' };

/** Internal consistent database observation. Never serialize these digest-bearing facts. */
export interface PublicationFact {
  translationKey: string;
  primaryLocale: PublicationLocale;
  status: 'draft' | 'published';
  requestedLocales: PublicationLocale[];
  committedLocales: PublicationLocale[];
  draftDiffers: boolean;
  rowDigest: Record<PublicationLocale, string | null>;
}

export type PublicationSummary =
  | { availability: 'available'; release: 'none' | 'unknown' | 'known';
      posts: { notLive: number; olderVersionLive: number; unexpectedLocaleLive: number;
        unpublishedStillLive: number; deletedStillLive: number } | null;
      galleryDescriptions: { photos: number; stories: number } | null }
  | { availability: 'unavailable' };
