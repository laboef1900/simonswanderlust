import { describe, expect, it, vi } from 'vitest';
import { navigationSchema } from './navigation-loader';
import { DEFAULT_NAVIGATION } from './navigation';
import { resolveNavigation } from './resolve-navigation';
import { publicRoutes } from './public-routes';
import { pageDataSchema } from './page-content';
import { aboutPath, homePath, mapPath } from './paths';
import type { SiteLanguage } from './site-language';
import { journeyFixture, tripFixture } from '../../test/journey-fixtures';

const modes: SiteLanguage[] = [{ primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] }];
const empty = { version: 1, header: [], footer: [], legal: [] };

describe('configured navigation build boundary', () => {
  it.each(modes)('reproduces seeded header/footer links for $primary/$locales', (mode) => {
    const routes = publicRoutes([], mode, { pages: [], journeys: [] });
    for (const locale of mode.locales) {
      const nav = resolveNavigation(DEFAULT_NAVIGATION, routes, mode, locale, aboutPath(locale, mode));
      expect(nav.header.map((link) => link.href)).toEqual([homePath(locale, mode) + '#stories', mapPath(locale, mode), aboutPath(locale, mode)]);
      expect(nav.footer.map((link) => link.href)).toEqual([aboutPath(locale, mode)]);
      expect(nav.legal).toEqual([]);
      expect(nav.header.map((link) => link.current)).toEqual([false, false, true]);
    }
  });
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\tjavascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:foo', 'http://example.com', 'mailto:a@example.com', 'tel:123', 'file:///etc/passwd', '//evil.example/',
    'https://name:password@example.com/', 'https://example.com/a b', 'https://example.com/\n'])('refuses %j before markup', (href) => {
    const input = { ...empty, header: [{ kind: 'external', href: { de: href }, label: { de: 'Link' } }] };
    expect(navigationSchema.safeParse(input).success).toBe(false);
    expect(() => resolveNavigation(input, publicRoutes([], modes[0]!, { pages: [], journeys: [] }), modes[0]!, 'de', '/')).toThrow();
  });
  it.each(['//evil.example/', '/\\evil.example', '/evil path', '/\tevil', 'javascript:alert(1)', '/<script>'])('refuses unsafe relative path %j', (href) => {
    expect(navigationSchema.safeParse({ ...empty, footer: [{ kind: 'path', href: { de: href }, label: { de: 'Link' } }] }).success).toBe(false);
  });
  it('uses emitted locale resources, never pair status or an unbuilt page', () => {
    const mode = modes[0]!;
    const page = { id: 'contact/de', data: pageDataSchema.parse({ key: 'contact', locale: 'de', slug: 'kontakt', title: 'Contact' }) };
    const routes = publicRoutes([], mode, { pages: [page], journeys: [] });
    const config = { ...empty, header: [{ kind: 'page', target: 'contact' }, { kind: 'page', target: 'privacy' }],
      footer: [{ kind: 'external', href: { de: 'https://example.com/' }, label: { de: '<script>plain text</script>' } }] };
    const de = resolveNavigation(config, routes, mode, 'de', '/kontakt/');
    expect(de.header).toEqual([{ href: '/kontakt/', label: 'Kontakt', external: false, current: true }]);
    expect(de.footer[0]?.label).toBe('<script>plain text</script>');
    expect(de.footer[0]?.external).toBe(true);
    expect(resolveNavigation(config, routes, mode, 'en', '/en/')).toEqual({ header: [], footer: [], legal: [] });
  });
  it('drops absent manual paths with a warning, retaining real paths with query/fragment', () => {
    const mode = modes[0]!;
    const warn = vi.fn();
    const config = { ...empty, legal: ['/missing/?a=1#x', '/uber-mich?x=1#content', '/rss.xml'].map((href) => ({ kind: 'path', href: { de: href }, label: { de: 'Read' } })) };
    const result = resolveNavigation(config, publicRoutes([], mode, { pages: [], journeys: [] }), mode, 'de', '/', warn);
    expect(result.legal.map((item) => item.href)).toEqual(['/uber-mich?x=1#content', '/rss.xml']);
    expect(warn).toHaveBeenCalledOnce();
  });
  it.each(modes)('permits manual journey links only while their locale pages are emitted in $primary/$locales', (mode) => {
    const journeys = [journeyFixture('de'), journeyFixture('en')];
    const trips = [tripFixture('a', 'de'), tripFixture('a', 'en')];
    const routes = publicRoutes(trips, mode, { pages: [], journeys });
    const baseline = publicRoutes(trips, mode, { pages: [], journeys: [] });
    for (const locale of mode.locales) {
      const journey = routes.find((route) => route.locale === locale && route.kind === 'journey')!;
      const index = routes.find((route) => route.locale === locale && route.kind === 'journeys')!;
      const hrefs = [index.path, journey.path.slice(0, -1) + '?view=map#route'];
      const config = { ...empty, footer: hrefs.map((href) => ({
        kind: 'path', href: { [locale]: href }, label: { [locale]: 'Read journey' },
      })) };
      expect(resolveNavigation(config, routes, mode, locale, '/').footer.map((item) => item.href)).toEqual(hrefs);
      const warn = vi.fn();
      const dormant = publicRoutes([], mode, { pages: [], journeys });
      expect(resolveNavigation(config, dormant, mode, locale, '/', warn).footer).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(resolveNavigation(DEFAULT_NAVIGATION, routes, mode, locale, '/'))
        .toEqual(resolveNavigation(DEFAULT_NAVIGATION, baseline, mode, locale, '/'));
    }
    if (mode.locales.length === 1) {
      const inactive = mode.primary === 'de' ? 'en' : 'de';
      const config = { ...empty, footer: [{
        kind: 'path', href: { [inactive]: '/private-inactive-310/' }, label: { [inactive]: 'Private' },
      }] };
      expect(resolveNavigation(config, routes, mode, inactive, '/').footer).toEqual([]);
    }
  });
  it('never projects inactive labels, destinations or prepared pages before activation', () => {
    const mode = modes[2]!;
    const config = { ...empty, footer: [{ kind: 'external', href: { en: 'https://private.example/' }, label: { en: 'PRIVATE' } }] };
    expect(resolveNavigation(config, publicRoutes([], mode, { pages: [], journeys: [] }), mode, 'de', '/').footer).toEqual([]);
    expect(resolveNavigation(config, publicRoutes([], mode, { pages: [], journeys: [] }), mode, 'en', '/en/').footer).toEqual([]);
  });
  it('normalizes safe HTTPS destinations and strips controls from bounded plain-text labels', () => {
    const parsed = navigationSchema.parse({ ...empty, header: [{ kind: 'external', href: { de: 'https://EXAMPLE.com' }, label: { de: '  Re\u202ead  ' } }] });
    expect(parsed.header[0]).toEqual({ kind: 'external', href: { de: 'https://example.com/' }, label: { de: 'Read' } });
  });
});
