import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import HomePage from './pages/HomePage.astro';
import AboutPage from './pages/AboutPage.astro';
import MapPage from './pages/MapPage.astro';
import RegionPage from './pages/RegionPage.astro';
import StoryPage from './pages/StoryPage.astro';
import NotFound from '../pages/404.astro';
import { GET as feed, getStaticPaths as feedPaths } from '../pages/[...locale]/rss.xml';
import { homePath, aboutPath, mapPath, regionPath, rssPath } from '../lib/paths';
import { pathOf, type Trip } from '../lib/trips';
import type { SiteLanguage } from '../lib/site-language';
import type { Locale } from '../i18n/ui';

const content = vi.hoisted(() => ({ trips: [] as Trip[] }));
vi.mock('astro:content', () => ({
  getCollection: async () => content.trips,
  getEntry: async () => undefined,
  render: async () => ({ headings: [] }),
}));
const windows: Window[] = [];
function documentOf(html: string, xml = false) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(html, xml ? 'application/xml' : 'text/html');
}
function trip(locale: Locale): Trip {
  return {
    id: `${locale}/${locale === 'de' ? 'reise' : 'journey'}`, collection: 'trips',
    rendered: { html: '<p>Published body</p>' },
    data: {
      title: locale === 'de' ? 'Reise' : 'Journey', date: new Date('2024-01-01'), translationKey: 'pair',
      region: 'europe', country: 'Country', countryCode: 'DE', excerpt: 'Excerpt',
      coordinates: { lat: 1, lng: 2 },
      heroImage: { src: 'https://example.com/photo', width: 1600, height: 900, alt: '' },
    },
  };
}
const modes: SiteLanguage[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
afterEach(async () => {
  vi.unstubAllEnvs(); content.trips = [];
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

describe('configured public language rendering', () => {
  it.each(modes)('renders enabled routes, SEO, maps, comments and feeds for $primary / $locales', async (language) => {
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(language));
    // Deliberately include a disabled locale: public consumers must not leak it.
    content.trips = [trip('de'), trip('en')];
    const container = await AstroContainer.create();
    for (const locale of language.locales) {
      const current = trip(locale);
      const pageCases = [
        { component: HomePage, props: { locale }, path: homePath(locale), primary: homePath(language.primary) },
        { component: AboutPage, props: { locale }, path: aboutPath(locale), primary: aboutPath(language.primary) },
        { component: MapPage, props: { locale }, path: mapPath(locale), primary: mapPath(language.primary) },
        { component: RegionPage, props: { locale, region: 'europe' }, path: regionPath('europe', locale), primary: regionPath('europe', language.primary) },
        { component: StoryPage, props: { trip: current }, path: pathOf(current), primary: pathOf(trip(language.primary)) },
      ];
      for (const page of pageCases) {
        const document = documentOf(await container.renderToString(page.component, {
          props: page.props, request: new Request(`https://simonswanderlust.com${page.path}`),
        }));
        expect(document.documentElement.lang).toBe(locale);
        expect(new URL(document.querySelector('link[rel="canonical"]')!.getAttribute('href')!).pathname).toBe(page.path);
        expect(document.querySelector('link[type="application/rss+xml"]')?.getAttribute('href')).toBe(rssPath(locale));
        expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe(locale === 'de' ? 'de_DE' : 'en_US');
        const alternatives = document.querySelectorAll('link[hreflang]');
        expect(alternatives).toHaveLength(language.locales.length === 2 ? 3 : 0);
        expect(document.querySelectorAll('meta[property="og:locale:alternate"]')).toHaveLength(language.locales.length === 2 ? 1 : 0);
        if (language.locales.length === 2) {
          expect(new URL(document.querySelector('link[hreflang="x-default"]')!.getAttribute('href')!).pathname).toBe(page.primary);
        } else {
          expect(document.querySelectorAll('a[hreflang]')).toHaveLength(0);
          const absent = locale === 'de' ? 'en' : 'de';
          for (const link of document.querySelectorAll('a[href]')) expect(link.getAttribute('href')).not.toMatch(new RegExp(`^/${absent}(?:/|$)`));
        }
        if (page.component === MapPage) {
          const pins = JSON.parse(document.querySelector('[data-geojson]')!.getAttribute('data-geojson')!);
          expect(pins.features).toHaveLength(1);
          expect(pins.features[0].properties.href).toBe(pathOf(current));
          expect(document.querySelector('main nav a')?.getAttribute('href')).toBe(pathOf(current));
        }
        if (page.component === StoryPage) {
          expect(document.querySelector('[data-comments-root]')?.getAttribute('data-locale')).toBe(locale);
          expect(document.querySelector('[data-comments-root]')?.getAttribute('data-comments-url')).toBe('/comments');
          const geometry = JSON.parse(document.querySelector('[data-geometry]')!.getAttribute('data-geometry')!);
          expect(geometry.pin.properties.href).toBe(pathOf(current));
          const jsonLd = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
          expect(jsonLd.inLanguage).toBe(locale);
        }
      }
      const response = await feed({ site: new URL('https://simonswanderlust.com'), props: { locale } });
      const xml = documentOf(await response.text(), true);
      expect(xml.querySelector('channel > language')?.textContent).toBe(locale);
      expect(xml.querySelectorAll('item')).toHaveLength(1);
      expect(new URL(xml.querySelector('item > link')!.textContent!).pathname).toBe(pathOf(current));
    }
    expect(feedPaths().map(({ props }) => props.locale)).toEqual(language.locales);
    const notFound = documentOf(await container.renderToString(NotFound, { request: new Request('https://simonswanderlust.com/404.html') }));
    expect(notFound.documentElement.lang).toBe(language.primary);
    expect([...notFound.querySelectorAll('main a')].map((link) => link.getAttribute('href'))).toEqual(language.locales.map((locale) => homePath(locale)));
  });

  it.each(['de', 'en'] as const)('does not claim an untranslated story or region has a counterpart when %s is primary', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify({ primary, locales: [primary, secondary] }));
    content.trips = [trip(primary)];
    const container = await AstroContainer.create();
    for (const page of [
      { component: StoryPage, props: { trip: trip(primary) }, path: pathOf(trip(primary)) },
      { component: RegionPage, props: { locale: primary, region: 'europe' }, path: regionPath('europe', primary) },
    ]) {
      const document = documentOf(await container.renderToString(page.component, { props: page.props, request: new Request(`https://simonswanderlust.com${page.path}`) }));
      expect(document.querySelectorAll('link[hreflang]')).toHaveLength(0);
      expect(document.querySelectorAll('meta[property="og:locale:alternate"]')).toHaveLength(0);
      const switcher = document.querySelector(`nav a[hreflang="${secondary}"]`);
      expect(switcher?.getAttribute('href')).toBe(homePath(secondary));
      expect(document.querySelectorAll('main a[hreflang]')).toHaveLength(0);
    }
  });
});
