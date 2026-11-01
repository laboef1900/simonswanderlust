import { describe, expect, it } from 'vitest';
import { pageDataSchema, publishedPageRows, type PublicPage } from './page-content';
import { assertPublicRoutes, pageAlternates, publicRoutes, type PublicRoute } from './public-routes';
import { homePath, aboutPath, mapPath, regionsIndexPath } from './paths';
import type { SiteLanguage } from './site-language';
import type { Trip } from './trips';

const modes: SiteLanguage[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
const row = (locale: 'de' | 'en', key = 'contact', slug = locale === 'de' ? 'kontakt' : 'contact') => ({
  key, locale, slug, title: 'Contact', body_markdown: 'Public body', status: 'published', images: {},
});
const page = (locale: 'de' | 'en', slug = locale === 'de' ? 'kontakt' : 'contact'): PublicPage => ({
  id: `contact/${locale}`, data: pageDataSchema.parse(row(locale, 'contact', slug)), body: 'Public body',
});
function story(locale: 'de' | 'en', slug: string): Trip {
  return { id: `${locale}/${slug}`, collection: 'trips', data: { title: 'Story', translationKey: 'trip', date: new Date('2026-01-01'),
    country: 'Test', countryCode: 'DE', region: 'europe', excerpt: '', coordinates: { lat: 1, lng: 2 },
    heroImage: { src: 'https://img.example/photo', width: 640, height: 480, alt: 'Photo' } } };
}

describe('published page boundary', () => {
  it.each(modes)('selects only public registry rows in $primary/$locales', (mode) => {
    const rows = [row('de'), row('en'), { ...row('de', 'privacy'), status: 'draft', body_markdown: 'PRIVATE DRAFT' },
      { ...row('de', 'unknown'), images: 'malformed private legacy row' }];
    expect(publishedPageRows(rows, mode.locales).map((page) => page.locale)).toEqual(['de', 'en'].filter((locale) => mode.locales.includes(locale as 'de' | 'en')));
  });
  it.each(['title', 'body_markdown', 'slug'])('fails restored enabled published rows with empty %s', (field) => {
    expect(() => publishedPageRows([{ ...row('de'), [field]: '' }], ['de'])).toThrow();
  });
  it('refuses a missing enabled counterpart instead of silently dropping a published route', () => {
    expect(() => publishedPageRows([row('de')], ['de', 'en'])).toThrow('contact/en');
  });
  it('preserves empty About fallback but refuses a forged stored About slug', () => {
    expect(publishedPageRows([{ ...row('de', 'about', ''), title: '', body_markdown: '' }], ['de'])).toHaveLength(1);
    expect(() => publishedPageRows([row('de', 'about', 'renamed')], ['de'])).toThrow('fixed route');
  });
  it.each([{ width: 0, height: 20 }, { width: 20, height: 20, caption: { type: 'raw', value: '<script>alert(1)</script>' } },
    { width: 20, height: 20, format: 'svg' }])('refuses malicious image maps: %j', (image) => {
    expect(() => publishedPageRows([{ ...row('de'), images: { '/photo': image } }], ['de'])).toThrow();
  });
});

describe('all-mode page route ownership', () => {
  it.each(modes)('registers About once and preserves fixed resources in $primary/$locales', (mode) => {
    const about: PublicPage[] = mode.locales.map((locale) => ({ id: `about/${locale}`, data: pageDataSchema.parse(row(locale, 'about', '')) }));
    const routes = publicRoutes([], mode, { pages: [...about, page('de'), page('en')], journeys: [] });
    for (const locale of mode.locales) {
      expect(routes.filter((route) => route.path === aboutPath(locale, mode))).toHaveLength(1);
      expect(routes.find((route) => route.path === mapPath(locale, mode))?.kind).toBe('map');
      expect(routes.find((route) => route.path === regionsIndexPath(locale, mode))?.kind).toBe('regions');
      expect(routes.some((route) => route.path === homePath(locale, mode) + (locale === 'de' ? 'kontakt/' : 'contact/'))).toBe(true);
    }
    expect(pageAlternates(routes, 'contact')).toEqual(mode.locales.length === 2
      ? { de: homePath('de', mode) + 'kontakt/', en: homePath('en', mode) + 'contact/' } : undefined);
  });
  it.each(modes)('fails competing pages/stories at every fixed namespace-relative path in $primary/$locales', (mode) => {
    for (const locale of mode.locales) for (const fixed of [aboutPath, mapPath, regionsIndexPath]) {
      const slug = fixed(locale, mode).slice(homePath(locale, mode).length, -1);
      expect(() => publicRoutes([], mode, { pages: [page(locale, slug)], journeys: [] })).toThrow('Conflicting public routes');
      expect(() => publicRoutes([story(locale, slug)], mode, { pages: [], journeys: [] })).toThrow('Conflicting public routes');
    }
    for (const slug of ['de', 'en', 'admin', 'map', 'feed', '404']) {
      expect(() => publicRoutes([], mode, { pages: [page(mode.primary, slug)], journeys: [] })).toThrow('Conflicting public routes');
    }
  });
  it.each(modes)('rejects both creation orders deterministically in $primary/$locales', (mode) => {
    const p = page(mode.primary, 'same');
    const s = story(mode.primary, 'same');
    const claims: PublicRoute[] = [{ path: '/same/', kind: 'page', locale: mode.primary, page: p },
      { path: '/same/', kind: 'story', locale: mode.primary, trip: s }];
    for (const ordered of [claims, [...claims].reverse()]) {
      expect(() => assertPublicRoutes(ordered, mode)).toThrow(`Conflicting public routes at /same/: page:contact:${mode.primary} and story:trip:${mode.primary}`);
    }
    expect(() => publicRoutes([s], mode, { pages: [p], journeys: [] })).toThrow('Conflicting public routes at /same/');
  });
  it('warns for grandfathered app/legacy stories but never allows a page to claim them', () => {
    const warnings: string[] = [];
    expect(publicRoutes([story('de', 'posts'), story('de', 'feed')], modes[0]!, { pages: [], journeys: [] }, (warning) => warnings.push(warning)).map((route) => route.path)).toEqual(expect.arrayContaining(['/posts/', '/feed/']));
    expect(warnings).toHaveLength(2);
    expect(() => publicRoutes([], modes[0]!, { pages: [page('de', 'posts')], journeys: [] })).toThrow('app:posts');
    expect(() => publicRoutes([], modes[0]!, { pages: [page('en', 'posts')], journeys: [] })).not.toThrow();
  });
  it.each(['de', 'en'] as const)('activation adds complete secondary page routes without moving %s routes', (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const pages = [page('de'), page('en')];
    const before = publicRoutes([], { primary, locales: [primary] }, { pages, journeys: [] });
    const after = publicRoutes([], { primary, locales: [primary, secondary] }, { pages, journeys: [] });
    expect(before.every((route) => after.some((next) => next.path === route.path && next.kind === route.kind))).toBe(true);
    expect(pageAlternates(before, 'contact')).toBeUndefined();
    expect(pageAlternates(after, 'contact')).toBeDefined();
  });
});
