import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StoryPage from './pages/StoryPage.astro';
import { identity, buildSiteOrigin } from '../lib/build-identity';
import { parseIdentitySnapshot } from '../lib/site-identity';
import { pathOf, type Trip } from '../lib/trips';
import { homePath } from '../lib/paths';
import type { SiteLanguage } from '../lib/site-language';
import { GET as robots } from '../pages/robots.txt';
import { GET as feed } from '../pages/[...locale]/rss.xml';

const content = vi.hoisted(() => ({ trips: [] as Trip[] }));
vi.mock('astro:content', () => ({
  getCollection: async () => content.trips,
  render: async () => ({ headings: [] }),
}));
const windows: Window[] = [];
function documentOf(text: string, xml = false) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
}
afterEach(async () => {
  Object.assign(identity, parseIdentitySnapshot(undefined));
  vi.unstubAllEnvs();
  content.trips = [];
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});
const modes: SiteLanguage[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
const origins = ['https://simonswanderlust.com', 'https://journal.example:8443', null];

for (const language of modes) {
  describe(`canonical output with ${language.primary}-primary ${language.locales.join('+')}`, () => {
    it.each(origins)('uses %s without changing story paths or image URLs', async (canonicalOrigin) => {
      vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(language));
      Object.assign(identity, parseIdentitySnapshot(undefined), { canonicalOrigin, locales: language.locales });
      content.trips = language.locales.map((locale) => ({
        id: `${locale}/${locale === 'de' ? 'reise' : 'journey'}`, collection: 'trips',
        rendered: { html: '<p>A published story.</p>' },
        data: {
          title: 'Journey', date: new Date('2024-01-01'), translationKey: 'canonical-fixture',
          country: 'Country', countryCode: 'DE', region: 'europe', excerpt: 'Excerpt',
          coordinates: { lat: 1, lng: 2 },
          heroImage: { src: 'https://images.example/photo', width: 1600, height: 900, alt: 'Landscape' },
        },
      }));
      const origin = canonicalOrigin ?? 'https://unconfigured.invalid';
      expect(buildSiteOrigin()).toBe(origin);
      const container = await AstroContainer.create({ astroConfig: { site: origin } });
      for (const trip of content.trips) {
        const locale = trip.id.startsWith('de/') ? 'de' : 'en';
        const path = pathOf(trip);
        const document = documentOf(await container.renderToString(StoryPage, {
          props: { trip }, request: new Request(`https://request-host.example${path}`),
        }));
        expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(origin + path);
        expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(origin + path);
        expect(document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null).toBe(canonicalOrigin === null ? 'noindex' : null);
        const alternates = [...document.querySelectorAll('link[hreflang]')];
        expect(alternates).toHaveLength(language.locales.length === 2 ? 3 : 0);
        for (const link of alternates) expect(new URL(link.getAttribute('href')!).origin).toBe(origin);
        if (language.locales.length === 2) {
          expect(document.querySelector('link[hreflang="x-default"]')?.getAttribute('href')).toBe(origin + pathOf(content.trips[0]!));
        }
        const structured = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
        expect(structured.mainEntityOfPage).toBe(origin + path);
        expect(structured.image.url).toBe('https://images.example/photo-1600.webp');
        expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(structured.image.url);
        const response = await feed({ site: new URL(origin), currentLocale: locale });
        const xml = documentOf(await response.text(), true);
        expect(xml.querySelector('channel > link')?.textContent).toBe(origin + homePath(locale));
        expect(xml.querySelector('item > link')?.textContent).toBe(origin + path);
      }
      const response = robots();
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await response.text()).toBe(canonicalOrigin === null
        ? 'User-agent: *\nDisallow: /\n'
        : `User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap-index.xml\n`);
    });
  });
}
