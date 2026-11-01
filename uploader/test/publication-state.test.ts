import { describe, expect, it } from 'vitest';
import { ui } from '../../site/src/i18n/ui.js';
import { loadPublicationState, publication, type LiveObservation } from './publication-client-fixture.js';

const api = loadPublicationState();
const facts: LiveObservation[] = ['not-live', 'unknown', 'older-version-live', 'live'];

describe('publication vocabulary — first matching rule wins', () => {
  // Rows/columns follow facts above. This enumerates every bilingual observation,
  // rather than reproducing the classifier's branching implementation.
  const published = [
    ['notLive', 'publishedUnknown', 'notLive', 'notLive'],
    ['publishedUnknown', 'publishedUnknown', 'publishedUnknown', 'publishedUnknown'],
    ['notLive', 'publishedUnknown', 'differs', 'differs'],
    ['notLive', 'publishedUnknown', 'differs', 'live'],
  ];
  const draft = [
    ['draft', 'draftUnknown', 'draftStillLive', 'draftStillLive'],
    ['draftUnknown', 'draftUnknown', 'draftStillLive', 'draftStillLive'],
    ['draftStillLive', 'draftStillLive', 'draftStillLive', 'draftStillLive'],
    ['draftStillLive', 'draftStillLive', 'draftStillLive', 'draftStillLive'],
  ];
  for (const [i, de] of facts.entries()) for (const [j, en] of facts.entries()) {
    it(`classifies both CMS statuses with DE=${de}, EN=${en}`, () => {
      expect(api.publicationState({ ...publication(), live: { de, en } })).toBe(published[i]![j]);
      expect(api.publicationState({ ...publication('draft'), live: { de, en } })).toBe(draft[i]![j]);
    });
  }
  it('does not invent facts for unavailable, missing, or contradictory projections', () => {
    expect(api.publicationState({ availability: 'unavailable' })).toBe('unavailable');
    expect(api.publicationState({ availability: 'missing' })).toBe('missing');
    expect(api.publicationState({ ...publication(), committedLocales: [] })).toBe('unavailable');
    expect(api.publicationState(undefined)).toBe('unavailable');
  });
  it.each(['de', 'en'] as const)('accepts a committed %s-only story and surfaces unexpected other-locale membership', (locale) => {
    const other = locale === 'de' ? 'en' : 'de';
    const p = { ...publication(), requestedLocales: [locale], committedLocales: [locale], live: { de: 'not-live', en: 'not-live', [locale]: 'live' } };
    expect(api.publicationState(p)).toBe('live');
    expect(api.label(p)).not.toContain('requires a site rebuild');
    expect(api.publicationState({ ...p, live: { ...p.live, [other]: 'live' } })).toBe('differs');
    expect(api.publicationState({ ...p, live: { ...p.live, [other]: 'unknown' } })).toBe('publishedUnknown');
    expect(api.publicationState({ ...p, draftDiffers: true, requestedLocales: ['de', 'en'] })).toBe('newerDraft');
  });
  it('keeps mixed-locale evidence and pending saved translation coverage', () => {
    const p = { ...publication('published', true), live: { de: 'live', en: 'unknown' } };
    expect(api.label(p)).toBe('Published — live status unknown · newer draft saved · DE: live; EN: live status unknown');
    expect(api.newer(p)).toBe(true);
    expect(api.attention(p)).toBe(true);
    expect(api.newer({ availability: 'unavailable' })).toBe(false);
    expect(api.label({ ...publication('draft'), live: { de: 'live', en: 'unknown' } })).toContain('Draft in the CMS — still on the live site');
  });
  it('keeps independent build failure qualifiers away from Live and author labels', () => {
    const status = { running: { owner: 'unverified' }, last: { result: 'interrupted' } };
    expect(api.qualifiers(publication(), status)).toBe('');
    const p = { ...publication(), live: { de: 'not-live', en: 'not-live' } };
    expect(api.qualifiers(p, status)).toContain('may be running elsewhere');
    expect(api.qualifiers(p, status)).toContain('result unknown');
    expect(api.label(p)).toContain('requires a site rebuild');
    expect(api.label(p, true)).not.toContain('requires a site rebuild');
  });
  it('treats absent and unknown summary counts as unavailable, not zero', () => {
    expect(api.summary({ availability: 'available', release: 'unknown', posts: null, galleryDescriptions: null })).toContain('counts are unavailable');
    expect(api.summary({ availability: 'unavailable' })).toBe('Publication summary unavailable.');
    expect(api.summary({ availability: 'available', release: 'known', posts: { notLive: 2, olderVersionLive: 1, unexpectedLocaleLive: 3, unpublishedStillLive: 4, deletedStillLive: 5 }, galleryDescriptions: { photos: 6, stories: 7 } })).toContain('6 photos in 7 stories');
  });
  it.each(['de', 'en'] as const)('renders all states and preview/save consequences in %s', (locale) => {
    const local = loadPublicationState({ document: { documentElement: { lang: locale } } });
    for (const status of ['draft', 'published'] as const) for (const de of facts) for (const en of facts) {
      expect(local.label({ ...publication(status, status === 'published'), live: { de, en } })).not.toMatch(/undefined|\{\w+\}/);
    }
    expect(ui[locale]['editor.chrome.publicationPreview']).toContain(locale === 'de' ? 'nicht die Live-Website' : 'not the live site');
    expect(ui[locale]['editor.chrome.saveLiveUnchanged']).toContain(locale === 'de' ? 'Galeriebeschreibungen' : 'gallery descriptions');
  });
});
