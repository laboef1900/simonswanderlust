import { describe, expect, it } from 'vitest';
import { publicRoutes } from './public-routes';
import { rssPath } from './paths';
import type { SiteLanguage } from './site-language';
import type { Trip } from './trips';

const trips: Trip[] = [
  { id: 'de/reise', collection: 'trips', data: { title: 'Reise', date: new Date('2024-01-01'), translationKey: 'pair', region: 'europe', country: 'Deutschland', countryCode: 'DE', excerpt: 'Reise', heroImage: { src: 'https://example.com/photo', width: 100, height: 100, alt: '' }, coordinates: { lat: 1, lng: 2 } } },
  { id: 'en/journey', collection: 'trips', data: { title: 'Journey', date: new Date('2024-01-01'), translationKey: 'pair', region: 'europe', country: 'Germany', countryCode: 'DE', excerpt: 'Journey', heroImage: { src: 'https://example.com/photo', width: 100, height: 100, alt: '' }, coordinates: { lat: 1, lng: 2 } } },
];
const cases: { language: SiteLanguage; paths: string[] }[] = [
  { language: { primary: 'de', locales: ['de', 'en'] }, paths: ['/', '/uber-mich/', '/karte/', '/reiseziele/', '/reiseziele/europa/', '/reise/', '/rss.xml', '/en/', '/en/about-me/', '/en/map/', '/en/destinations/', '/en/destinations/europe/', '/en/journey/', '/en/rss.xml'] },
  { language: { primary: 'en', locales: ['en', 'de'] }, paths: ['/', '/about-me/', '/travel-map/', '/destinations/', '/destinations/europe/', '/journey/', '/rss.xml', '/de/', '/de/uber-mich/', '/de/karte/', '/de/reiseziele/', '/de/reiseziele/europa/', '/de/reise/', '/de/rss.xml'] },
  { language: { primary: 'de', locales: ['de'] }, paths: ['/', '/uber-mich/', '/karte/', '/reiseziele/', '/reiseziele/europa/', '/reise/', '/rss.xml'] },
  { language: { primary: 'en', locales: ['en'] }, paths: ['/', '/about-me/', '/travel-map/', '/destinations/', '/destinations/europe/', '/journey/', '/rss.xml'] },
];

describe('public route inventory', () => {
  it.each(cases)('matches the approved literal inventory for $language', ({ language, paths }) => {
    const actual = publicRoutes(trips, language, { pages: [], journeys: [] }).map(({ path }) => path);
    actual.push(...language.locales.map((locale) => rssPath(locale, language)));
    expect(actual.sort()).toEqual([...paths].sort());
    expect(actual).not.toContain('/map/');
  });
  it('does not invent a counterpart or an empty translated region', () => {
    const paths = publicRoutes([trips[0]!], cases[0]!.language, { pages: [], journeys: [] }).map(({ path }) => path);
    expect(paths).toContain('/reiseziele/europa/');
    expect(paths).not.toContain('/en/journey/');
    expect(paths).not.toContain('/en/destinations/europe/');
    expect(paths).toContain('/en/destinations/');
  });
  it('fails rather than silently shadowing a fixed page', () => {
    expect(() => publicRoutes([{ ...trips[0]!, id: 'de/karte' }], cases[0]!.language, { pages: [], journeys: [] })).toThrow('Conflicting public routes');
  });
  it('adding the secondary is additive for both primary choices', () => {
    for (const primary of ['de', 'en'] as const) {
      const before = publicRoutes(trips, { primary, locales: [primary] }, { pages: [], journeys: [] }).map(({ path }) => path);
      const after = new Set(publicRoutes(trips, { primary, locales: ['de', 'en'] }, { pages: [], journeys: [] }).map(({ path }) => path));
      expect(before.every((path) => after.has(path))).toBe(true);
    }
  });
});
