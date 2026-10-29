import { describe, expect, it, vi } from 'vitest';
import { liveJourneys, journeyPositions, journeyAlternates } from './journeys';
import { journeyGeometry } from './journey-map';
import { publicRoutes, routeOwner } from './public-routes';
import { journeyPath, journeysIndexPath, storyPath } from './paths';
import { namespaceOf, reservation } from './reserved-routes';
import { journeyFixture, tripFixture, modes } from '../../test/journey-fixtures';
import { siteLanguage } from './site-language';
import { pageDataSchema } from './page-content';

describe('one public journey projection', () => {
  it.each(modes)('resolves only enabled published members in order in $primary / $locales', (language) => {
    const entries = [journeyFixture('de'), journeyFixture('en')];
    const trips = [tripFixture('c'), tripFixture('a'), tripFixture('a', 'en')];
    for (const locale of ['de', 'en'] as const) {
      const live = liveJourneys(entries, trips, locale, language);
      if (!language.locales.includes(locale)) {
        expect(live).toEqual([]);
        expect(() => journeysIndexPath(locale, language)).toThrow();
        continue;
      }
      expect(live[0]!.members.map((trip) => trip.data.translationKey)).toEqual(locale === 'de' ? ['a', 'c'] : ['a']);
      const prefix = locale === language.primary ? '' : `/${locale}`;
      const base = locale === 'de' ? 'rundreisen' : 'journeys';
      expect(journeyPath('expedition', locale, language)).toBe(`${prefix}/${base}/expedition/`);
      expect(reservation(namespaceOf(locale, language), base, language)?.owner).toBe('site');
      expect(storyPath('unchanged-slug', locale, language)).toBe(`${prefix}/unchanged-slug/`);
      expect(journeyPositions(live, entries).get(`${locale}/a`)?.index).toBe(0);
    }
    const baseline = publicRoutes(trips, language, { pages: [], journeys: [] });
    const withJourneys = publicRoutes(trips, language, { pages: [], journeys: entries });
    expect(withJourneys.filter((route) => route.kind !== 'journey' && route.kind !== 'journeys').map(({ path }) => path)).toEqual(baseline.map(({ path }) => path));
  });
  it.each(modes)('keeps page ownership and rejects conflicting journey identities in $primary / $locales', (language) => {
    const locale = language.primary;
    const journey = journeyFixture(locale);
    const trips = [tripFixture('a', locale)];
    const page = { id: `contact/${locale}`, data: pageDataSchema.parse({
      key: 'contact', locale, slug: 'contact', title: 'Contact',
    }) };
    const routes = publicRoutes(trips, language, { pages: [page], journeys: [journey] });
    expect(routes.find((route) => route.kind === 'page')?.path).toBe('/contact/');
    const journeyRoute = routes.find((route) => route.kind === 'journey')!;
    expect(routeOwner(journeyRoute)).toBe(`journey:${journey.data.journeyId}:${locale}`);
    const competing = journeyFixture(locale, ['a'], '22222222-2222-4222-8222-222222222222');
    for (const entries of [[journey, competing], [competing, journey]]) {
      expect(() => publicRoutes(trips, language, { pages: [page], journeys: entries }, vi.fn()))
        .toThrow(`Conflicting public routes at ${journeyRoute.path}: journey:${journey.data.journeyId}:${locale} and journey:${competing.data.journeyId}:${locale}`);
    }
    const reserved = locale === 'de' ? 'rundreisen' : 'journeys';
    expect(() => publicRoutes(trips, language, {
      pages: [{ ...page, data: { ...page.data, slug: reserved } }], journeys: [],
    })).toThrow('Conflicting public routes');
    expect(() => publicRoutes([{ ...trips[0]!, id: `${locale}/${reserved}` }], language, {
      pages: [], journeys: [],
    })).toThrow('Conflicting public routes');
  });
  it('passes duplicate-claim warnings through the inventory without choosing a strip', () => {
    const first = journeyFixture();
    const second = { ...journeyFixture('de', ['a'], '22222222-2222-4222-8222-222222222222'), id: 'de/other' };
    const warn = vi.fn();
    const routes = publicRoutes([tripFixture('a')], { primary: 'de', locales: ['de'] }, {
      pages: [], journeys: [first, second],
    }, warn);
    expect(routes.filter((route) => route.kind === 'journey')).toHaveLength(2);
    expect(routes.find((route) => route.kind === 'story')).not.toHaveProperty('journeyPosition');
    expect(warn).toHaveBeenCalledOnce();
  });
  it('dormant and absent committed locales produce no index, page, strip or alternate', () => {
    const entries = [journeyFixture('de', ['missing']), journeyFixture('en')];
    const trips = [tripFixture('a')];
    expect(liveJourneys(entries, trips, 'de')).toEqual([]);
    expect(liveJourneys(entries, trips, 'en')).toEqual([]);
    expect(publicRoutes(trips, siteLanguage(), { pages: [], journeys: entries }))
      .toEqual(publicRoutes(trips, siteLanguage(), { pages: [], journeys: [] }));
    const visible = liveJourneys([journeyFixture()], trips, 'de')[0]!;
    expect(journeyAlternates(visible, [journeyFixture()], trips)).toBeUndefined();
  });
  it('warns once and omits every ambiguous strip without removing either list', () => {
    const entries = [journeyFixture(), journeyFixture('de', ['a'], '22222222-2222-4222-8222-222222222222')];
    const live = liveJourneys(entries, [tripFixture('a'), tripFixture('c')], 'de');
    const warn = vi.fn();
    const positions = journeyPositions(live, entries, warn);
    expect(live.map((journey) => journey.members.length)).toEqual([2, 1]);
    expect(positions.has('de/a')).toBe(false);
    expect(positions.get('de/c')?.index).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toContain('Story');
  });
  it('suppresses a cross-locale duplicate claim even when only one journey is live here', () => {
    const entries = [journeyFixture(), journeyFixture('en', ['a'], '22222222-2222-4222-8222-222222222222')];
    const live = liveJourneys(entries, [tripFixture('a')], 'de');
    expect(live).toHaveLength(1);
    expect(journeyPositions(live, entries, vi.fn()).has('de/a')).toBe(false);
  });
  it('emits exactly each public track run, never stops or connectors', () => {
    const a = tripFixture('a'); const c = tripFixture('c');
    a.data.track = { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] };
    c.data.track = { version: 1, type: 'MultiLineString', coordinates: [[[90, 20], [91, 21]]] };
    const geometry = journeyGeometry(liveJourneys([journeyFixture()], [c, a], 'de')[0]!);
    expect(geometry.pins.map((pin) => [pin.number, pin.href])).toEqual([[1, '/a/'], [2, '/c/']]);
    expect(geometry.tracks.features.map((feature) => feature.geometry.coordinates)).toEqual([...a.data.track.coordinates, ...c.data.track.coordinates]);
    expect(geometry.tracks.features.every((feature) => feature.geometry.type === 'LineString')).toBe(true);
    expect(JSON.stringify(geometry)).not.toContain('Not on overview');
  });
});
