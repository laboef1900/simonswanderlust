import type { Journey } from '../src/lib/journeys';
import type { Trip } from '../src/lib/trips';
import type { Locale } from '../src/i18n/ui';
import type { SiteLanguage } from '../src/lib/site-language';
export const modes: SiteLanguage[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
export const hero = { src: 'https://old.example/photos/journey', width: 1600, height: 1200, alt: 'A mountain', focus: { x: 23, y: 71 } };
export function journeyFixture(locale: Locale = 'de', members = ['a', 'draft-secret', 'c'], id = '11111111-1111-4111-8111-111111111111'): Journey {
  return { id: `${locale}/expedition`, collection: 'journeys', data: {
    journeyId: id, title: `Published journey ${locale}`, intro: '<script>not markup</script>\n\nSecond paragraph', heroImage: hero, members,
  } };
}
export function tripFixture(key: string, locale: Locale = 'de'): Trip {
  return { id: `${locale}/${key}`, collection: 'trips', rendered: { html: `<p>Published ${key}</p>` }, data: {
    translationKey: key, title: `Story ${key}`, date: new Date('2024-01-01'), country: 'Country', countryCode: 'DE', region: 'europe', excerpt: `Excerpt ${key}`,
    heroImage: hero, coordinates: { lat: 1, lng: 2 }, stops: [{ name: 'Not on overview', lat: 88, lng: 177 }],
  } };
}
