import { describe, expect, it, vi } from 'vitest';
import { createPublicationProjection, galleryPending, postPublicationCounts, projectPublication, type PublicationObservation } from '../src/publication.js';
import type { PublicationFact } from '../src/publication-contract.js';
import type { ReleaseObservation } from '../src/release-manifest.js';
import type { ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';
import { memoryMediaStore } from '../src/media-store.js';

const ORIGIN = 'https://images.example';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
function fact(overrides: Partial<PublicationFact> = {}): PublicationFact {
  return { translationKey: 'story', primaryLocale: 'de', status: 'published', requestedLocales: ['de', 'en'],
    committedLocales: ['de', 'en'], draftDiffers: false, rowDigest: { de: A, en: B }, ...overrides };
}
function release(posts: ReleaseManifestV1['posts'] = [
  { translationKey: 'story', locale: 'de', slug: 'reise', digest: A, gallery: [] },
  { translationKey: 'story', locale: 'en', slug: 'trip', digest: B, gallery: [] },
]): ReleaseObservation {
  return { release: 'known', manifest: { schema: 1, stamp: '1793000000000-1-0001', posts } };
}
function observation(facts: PublicationFact[], current: ReleaseObservation): PublicationObservation {
  return { facts, release: current, publications: new Map(facts.map((row) => [row.translationKey, projectPublication(row, current)])) };
}

describe('publication observations, not timestamp or action inference', () => {
  it('distinguishes confirmed absence, unreadable legacy releases and matching versions', () => {
    expect(projectPublication(fact(), { release: 'none' })).toMatchObject({ live: { de: 'not-live', en: 'not-live' } });
    expect(projectPublication(fact(), { release: 'unknown' })).toMatchObject({ live: { de: 'unknown', en: 'unknown' } });
    expect(projectPublication(fact(), release())).toEqual({ availability: 'available', status: 'published',
      requestedLocales: ['de', 'en'], committedLocales: ['de', 'en'], draftDiffers: false, live: { de: 'live', en: 'live' } });
    expect(projectPublication(fact({ rowDigest: { de: B, en: null } }), release())).toMatchObject({
      live: { de: 'older-version-live', en: 'older-version-live' } });
    expect(projectPublication(fact({ status: 'draft', committedLocales: [] }), release())).toMatchObject({ status: 'draft', live: { de: 'live', en: 'live' } });
  });

  it.each(['de', 'en'] as const)('counts only committed %s while retaining unexpectedly served other locales', (primaryLocale) => {
    const row = fact({ primaryLocale, requestedLocales: [primaryLocale], committedLocales: [primaryLocale] });
    const current = release([{ translationKey: 'story', locale: primaryLocale, slug: 'story', digest: row.rowDigest[primaryLocale]!, gallery: [] }]);
    expect(postPublicationCounts(observation([row], current))).toEqual({ notLive: 0, olderVersionLive: 0,
      unexpectedLocaleLive: 0, unpublishedStillLive: 0, deletedStillLive: 0 });
    expect(postPublicationCounts(observation([row], release()))?.unexpectedLocaleLive).toBe(1);
    const unomitted = { ...row, requestedLocales: ['de', 'en'] as ('de' | 'en')[], draftDiffers: true };
    expect(projectPublication(unomitted, current)).toMatchObject({ draftDiffers: true, committedLocales: [primaryLocale] });
  });

  it('rejects contradictory coverage and deduplicates deleted/unpublished counts by story', () => {
    expect(projectPublication(fact({ committedLocales: [] }), release())).toEqual({ availability: 'unavailable' });
    expect(projectPublication(fact({ requestedLocales: ['en', 'de'] }), release())).toEqual({ availability: 'unavailable' });
    expect(postPublicationCounts(observation([], release()))?.deletedStillLive).toBe(1);
    expect(postPublicationCounts(observation([fact({ status: 'draft', committedLocales: [] })], release()))?.unpublishedStillLive).toBe(1);
    expect(postPublicationCounts(observation([fact()], { release: 'unknown' }))).toBeNull();
  });

  it('reads the release before consistent DB facts and refreshes a promotion race on the next read', async () => {
    const events: string[] = [];
    let current: ReleaseObservation = release([]);
    const projector = createPublicationProjection({
      posts: { publicationFacts: async () => { events.push('db'); current = release(); return [fact()]; } },
      readRelease: async () => { events.push('disk'); return current; },
      media: memoryMediaStore({ baseUrl: ORIGIN }), imageBase: ORIGIN,
    });
    expect(await projector.one('story')).toMatchObject({ live: { de: 'not-live', en: 'not-live' } });
    expect(await projector.one('story')).toMatchObject({ live: { de: 'live', en: 'live' } });
    expect(events).toEqual(['disk', 'db', 'disk', 'db']);
  });

  it('separates failed DB reads from confirmed missing rows and contains diagnostic failure', async () => {
    let fail = true;
    const projector = createPublicationProjection({ posts: { publicationFacts: async () => { if (fail) throw new Error('database'); return []; } },
      readRelease: async () => release(), media: memoryMediaStore({ baseUrl: ORIGIN }), imageBase: ORIGIN,
      onUnavailable: () => { throw new Error('logger unavailable'); } });
    expect(await projector.one('story')).toEqual({ availability: 'unavailable' });
    expect(await projector.summary()).toEqual({ availability: 'unavailable' });
    fail = false;
    expect(await projector.one('story')).toEqual({ availability: 'missing' });
    expect(await projector.summary()).toMatchObject({ release: 'known', posts: { deletedStillLive: 1 } });
  });

  it('keeps link inspection failure unknown and summaries null without querying Media', async () => {
    const media = memoryMediaStore({ baseUrl: ORIGIN });
    const read = vi.spyOn(media, 'descriptions');
    const projector = createPublicationProjection({ posts: { publicationFacts: async () => [fact()] },
      readRelease: async () => { throw new Error('EACCES'); }, media, imageBase: ORIGIN });
    expect(await projector.one('story')).toMatchObject({ live: { de: 'unknown', en: 'unknown' } });
    expect(await projector.summary()).toEqual({ availability: 'available', release: 'unknown', posts: null, galleryDescriptions: null });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('shared current-release gallery summary', () => {
  it('measures field changes, reverts, post-read edits and rebuild inclusion without caching working metadata', async () => {
    const media = memoryMediaStore({ baseUrl: ORIGIN });
    await media.upsert({ key: 'photo', width: 800, height: 600, origBytes: 1, status: 'ready',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null,
      alt: { de: 'Alt', en: 'English' }, caption: { de: 'Caption', en: 'English caption' } });
    const photo = { src: `${ORIGIN}/photo`, alt: 'Alt', caption: 'Caption' };
    const posts: ReleaseManifestV1['posts'] = [
      { translationKey: 'story', locale: 'de', slug: 'reise', digest: A, gallery: [photo, photo] },
      { translationKey: 'second', locale: 'de', slug: 'second', digest: A, gallery: [{ ...photo, caption: null }] },
    ];
    const facts = [fact(), fact({ translationKey: 'second' })];
    const observed = observation(facts, release(posts));
    expect(await galleryPending(observed, media, ORIGIN)).toMatchObject({ photos: 0, stories: 0 });
    await media.patch('photo', { caption: { de: 'Changed' } });
    expect(await galleryPending(observed, media, ORIGIN)).toMatchObject({ photos: 1, stories: 1 });
    await media.patch('photo', { alt: { de: 'New alt' } });
    const pending = await galleryPending(observed, media, ORIGIN);
    expect(pending).toMatchObject({ photos: 1, stories: 2 });
    expect(pending!.byKey.get('photo')).toEqual({ de: { alt: true, caption: true }, en: { alt: false, caption: false } });
    const rebuilt = observation(facts, release(posts.map((post) => ({ ...post, gallery: post.gallery.map((use) => ({
      ...use, alt: 'New alt', caption: use.caption === null ? null : 'Changed',
    })) }))));
    expect(await galleryPending(rebuilt, media, ORIGIN)).toMatchObject({ photos: 0, stories: 0 });
    await media.patch('photo', { alt: { de: 'After loader read' } });
    expect(await galleryPending(rebuilt, media, ORIGIN)).toMatchObject({ photos: 1, stories: 2 });
    await media.patch('photo', { alt: { de: 'Alt' }, caption: { de: 'Caption' } });
    expect(await galleryPending(observed, media, ORIGIN)).toMatchObject({ photos: 0, stories: 0 });
    await media.patch('photo', { alt: { de: 'Changed again' } });
    const unpublished = observation(facts.map((row) => ({ ...row, status: 'draft' as const, committedLocales: [] })), release(posts));
    expect(await galleryPending(unpublished, media, ORIGIN)).toMatchObject({ photos: 0, stories: 0 });
  });

  it('excludes disabled/omitted locale occurrences, missing media and foreign keys', async () => {
    const media = memoryMediaStore({ baseUrl: ORIGIN });
    await media.upsert({ key: 'photo', width: 1, height: 1, origBytes: 1, status: 'ready',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null, alt: { de: 'new', en: 'new' } });
    const current = release([
      { translationKey: 'story', locale: 'en', slug: 'trip', digest: B, gallery: [{ src: `${ORIGIN}/photo`, alt: 'old', caption: '' }] },
      { translationKey: 'story', locale: 'de', slug: 'reise', digest: A, gallery: [
        { src: `${ORIGIN}/missing`, alt: 'old', caption: '' },
        { src: `${ORIGIN}.evil/photo`, alt: 'old', caption: '' },
      ] },
    ]);
    expect(await galleryPending(observation([fact({ committedLocales: ['de'], requestedLocales: ['de'] })], current), media, ORIGIN))
      .toMatchObject({ photos: 0, stories: 0 });
    expect(await galleryPending(observation([fact()], { release: 'none' }), media, ORIGIN)).toBeNull();
  });
});
