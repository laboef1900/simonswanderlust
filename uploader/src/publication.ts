import type { MediaDescriptions, MediaStore } from './media-store.js';
import type { PostStore } from './posts.js';
import type { ReleaseObservation } from './release-manifest.js';
import type { LiveState, Publication, PublicationFact, PublicationLocale, PublicationSummary } from './publication-contract.js';
import type { ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';

type ManifestIndex = ReadonlyMap<string, Partial<Record<PublicationLocale, ReleaseManifestV1['posts'][number]>>>;

const LOCALES = ['de', 'en'] as const;
const unavailable = (): Publication => ({ availability: 'unavailable' });

function validLocales(locales: PublicationLocale[]): boolean {
  return Array.isArray(locales) && locales.every((locale, index) =>
    LOCALES.includes(locale) && (index === 0 || locales[index - 1] === 'de' && locale === 'en'));
}

/** This projection explicitly enumerates the author-visible keys; digests stay internal. */
export function projectPublication(fact: PublicationFact, release: ReleaseObservation, index?: ManifestIndex): Publication {
  if (!validLocales(fact.requestedLocales) || !validLocales(fact.committedLocales)
    || !LOCALES.includes(fact.primaryLocale) || !['draft', 'published'].includes(fact.status)
    || typeof fact.draftDiffers !== 'boolean'
    || !fact.requestedLocales.includes(fact.primaryLocale)
    || fact.status === 'published' && !fact.committedLocales.includes(fact.primaryLocale)) return unavailable();
  const live: Record<PublicationLocale, LiveState> = { de: 'unknown', en: 'unknown' };
  for (const locale of LOCALES) {
    if (release.release === 'none') live[locale] = 'not-live';
    else if (release.release === 'known') {
      const entry = index ? index.get(fact.translationKey)?.[locale]
        : release.manifest.posts.find((row) => row.translationKey === fact.translationKey && row.locale === locale);
      live[locale] = !entry ? 'not-live' : entry.digest === fact.rowDigest[locale] ? 'live' : 'older-version-live';
    }
  }
  return { availability: 'available', status: fact.status,
    requestedLocales: [...fact.requestedLocales], committedLocales: [...fact.committedLocales],
    draftDiffers: fact.draftDiffers, live };
}

export interface PublicationObservation {
  release: ReleaseObservation;
  facts: PublicationFact[];
  publications: Map<string, Publication>;
}
export interface DescriptionPending { de: { alt: boolean; caption: boolean }; en: { alt: boolean; caption: boolean } }
export interface GalleryPending {
  photos: number;
  stories: number;
  byKey: Map<string, DescriptionPending>;
}

/** Exact overlay identity, not a variant-stripping or foreign-origin prefix match. */
function galleryKey(src: string, imageBase: string): string | null {
  const prefix = `${imageBase.replace(/\/+$/, '')}/`;
  if (!src.startsWith(prefix)) return null;
  try { if (new URL(src).origin !== new URL(imageBase).origin) return null; } catch { return null; }
  return src.length > prefix.length ? src.slice(prefix.length) : null;
}

/** Reusable by #318: compare fresh library fields to only eligible committed occurrences. */
export async function galleryPending(
  observation: PublicationObservation, media: Pick<MediaStore, 'descriptions'>, imageBase: string,
): Promise<GalleryPending | null> {
  if (observation.release.release !== 'known') return null;
  for (const publication of observation.publications.values()) if (publication.availability !== 'available') return null;
  const eligible = new Map(observation.facts.filter((fact) => fact.status === 'published')
    .map((fact) => [fact.translationKey, new Set(fact.committedLocales)]));
  const occurrences = observation.release.manifest.posts.flatMap((post) =>
    eligible.get(post.translationKey)?.has(post.locale)
      ? post.gallery.map((photo) => ({ ...photo, key: galleryKey(photo.src, imageBase), translationKey: post.translationKey, locale: post.locale })) : []);
  const keys = [...new Set(occurrences.flatMap((photo) => photo.key === null ? [] : [photo.key]))];
  const descriptions = keys.length ? await media.descriptions(keys) : new Map<string, MediaDescriptions>();
  const byKey = new Map<string, DescriptionPending>();
  const photos = new Set<string>();
  const stories = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.key === null) continue;
    const description = descriptions.get(occurrence.key);
    if (!description) continue;
    const alt = description.alt[occurrence.locale] !== occurrence.alt;
    const caption = occurrence.caption !== null && description.caption[occurrence.locale] !== occurrence.caption;
    const pending = byKey.get(occurrence.key) ?? { de: { alt: false, caption: false }, en: { alt: false, caption: false } };
    pending[occurrence.locale].alt ||= alt;
    pending[occurrence.locale].caption ||= caption;
    byKey.set(occurrence.key, pending);
    if (alt || caption) { photos.add(occurrence.key); stories.add(occurrence.translationKey); }
  }
  return { photos: photos.size, stories: stories.size, byKey };
}

export function postPublicationCounts(observation: PublicationObservation): NonNullable<Extract<PublicationSummary, { availability: 'available' }>['posts']> | null {
  if (observation.release.release !== 'known') return null;
  const counts = { notLive: 0, olderVersionLive: 0, unexpectedLocaleLive: 0, unpublishedStillLive: 0, deletedStillLive: 0 };
  for (const publication of observation.publications.values()) {
    if (publication.availability !== 'available') return null;
    if (publication.status === 'draft') {
      if (LOCALES.some((locale) => publication.live[locale] === 'live' || publication.live[locale] === 'older-version-live')) counts.unpublishedStillLive++;
    } else {
      if (publication.committedLocales.some((locale) => publication.live[locale] === 'not-live')) counts.notLive++;
      if (publication.committedLocales.some((locale) => publication.live[locale] === 'older-version-live')) counts.olderVersionLive++;
      if (LOCALES.some((locale) => !publication.committedLocales.includes(locale) && (publication.live[locale] === 'live' || publication.live[locale] === 'older-version-live'))) counts.unexpectedLocaleLive++;
    }
  }
  counts.deletedStillLive = new Set(observation.release.manifest.posts
    .filter((entry) => !observation.publications.has(entry.translationKey)).map((entry) => entry.translationKey)).size;
  return counts;
}

export function createPublicationProjection(options: {
  posts: Pick<PostStore, 'publicationFacts'>;
  readRelease: () => Promise<ReleaseObservation>;
  media: Pick<MediaStore, 'descriptions'>;
  imageBase: string;
  onUnavailable?: () => void;
}) {
  const diagnostic = () => { try { options.onUnavailable?.(); } catch { /* Optional state must not fail a committed write. */ } };
  async function read(): Promise<PublicationObservation | null> {
    let release: ReleaseObservation;
    try { release = await options.readRelease(); }
    catch { diagnostic(); release = { release: 'unknown' }; }
    try {
      // The disk observation MUST precede the store's consistent mode/row read.
      const facts = await options.posts.publicationFacts();
      const index = new Map<string, Partial<Record<PublicationLocale, ReleaseManifestV1['posts'][number]>>>();
      if (release.release === 'known') for (const entry of release.manifest.posts) {
        const locales = index.get(entry.translationKey) ?? {};
        locales[entry.locale] = entry;
        index.set(entry.translationKey, locales);
      }
      return { release, facts, publications: new Map(facts.map((fact) => [fact.translationKey, projectPublication(fact, release, index)])) };
    } catch { diagnostic(); return null; }
  }
  function from(observation: PublicationObservation | null, key: string): Publication {
    return observation ? observation.publications.get(key) ?? { availability: 'missing' } : unavailable();
  }
  return {
    read, from,
    async one(key: string): Promise<Publication> { return from(await read(), key); },
    async summary(): Promise<PublicationSummary> {
      const observation = await read();
      if (!observation) return { availability: 'unavailable' };
      if (observation.release.release !== 'known') return { availability: 'available', release: observation.release.release, posts: null, galleryDescriptions: null };
      const posts = postPublicationCounts(observation);
      if (!posts) return { availability: 'unavailable' };
      try {
        const pending = await galleryPending(observation, options.media, options.imageBase);
        return { availability: 'available', release: 'known', posts,
          galleryDescriptions: pending ? { photos: pending.photos, stories: pending.stories } : null };
      } catch { diagnostic(); return { availability: 'unavailable' }; }
    },
  };
}
