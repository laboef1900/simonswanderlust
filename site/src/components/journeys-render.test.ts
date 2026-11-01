import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import JourneyPage from './pages/JourneyPage.astro';
import JourneysPage from './pages/JourneysPage.astro';
import StoryPage from './pages/StoryPage.astro';
import RemoteImage from './RemoteImage.astro';
import { liveJourneys, journeyPositions, type Journey } from '../lib/journeys';
import type { Trip } from '../lib/trips';
import { journeyEntries } from '../lib/journeys-loader';
import { journeyFixture, tripFixture, hero, modes } from '../../test/journey-fixtures';
import { ui } from '../i18n/ui';
import { publicTrackSummary } from '../lib/public-track';
const content = vi.hoisted(() => ({ journeys: [] as Journey[], trips: [] as Trip[] }));
vi.mock('astro:content', () => ({
  getCollection: async (name: string) => name === 'journeys' ? content.journeys : name === 'trips' ? content.trips : [],
  getEntry: async () => undefined, render: async () => ({ headings: [] }),
}));
const windows: Window[] = [];
function documentOf(html: string) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(html, 'text/html');
}
afterEach(async () => {
  content.journeys = []; content.trips = []; vi.unstubAllEnvs();
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});
describe('journey public HTML consumers', () => {
  it.each(modes)('renders escaped metadata, ordered public cards and complete fallback in $primary / $locales', async (language) => {
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(language));
    content.journeys = [journeyFixture('de'), journeyFixture('en')];
    content.trips = ['de', 'en'].flatMap((locale) => [tripFixture('a', locale as 'de' | 'en'), tripFixture('c', locale as 'de' | 'en')]);
    const container = await AstroContainer.create();
    for (const locale of language.locales) {
      const live = liveJourneys(content.journeys, content.trips, locale);
      const html = await container.renderToString(JourneyPage, { props: { journey: live[0] }, request: new Request(`https://simonswanderlust.com${live[0]!.path}`) });
      const document = documentOf(html);
      expect(document.querySelector('h1')?.textContent).toBe(`Published journey ${locale}`);
      expect(document.querySelector('main script:not([src])')?.textContent ?? '').not.toContain('not markup');
      expect(document.querySelector('main')?.textContent).toContain('<script>not markup</script>');
      expect(document.querySelectorAll('[data-journey-stories] > li')).toHaveLength(2);
      expect(document.querySelectorAll('[data-journey-map-fallback] > li > a')).toHaveLength(2);
      expect(document.querySelector('[data-journey-map]')?.getAttribute('aria-label')).toBe(ui[locale]['journey.map'].replace('{title}', live[0]!.entry.data.title));
      expect(document.querySelectorAll('[data-comments-root]')).toHaveLength(0);
      expect(html).not.toContain('draft-secret');
      expect(document.querySelectorAll('link[hreflang]')).toHaveLength(language.locales.length === 2 ? 3 : 0);
      const index = documentOf(await container.renderToString(JourneysPage, { props: { locale, journeys: live } }));
      expect(index.querySelector('main ul a')?.getAttribute('href')).toBe(live[0]!.path);
    }
  });
  it('omits an uncommitted journey locale from pages, index alternates and links', async () => {
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(modes[0]));
    content.journeys = [journeyFixture('de')];
    content.trips = [tripFixture('a', 'de'), tripFixture('a', 'en')];
    const container = await AstroContainer.create();
    const live = liveJourneys(content.journeys, content.trips, 'de');
    for (const html of [
      await container.renderToString(JourneyPage, { props: { journey: live[0] } }),
      await container.renderToString(JourneysPage, { props: { locale: 'de', journeys: live } }),
    ]) {
      const document = documentOf(html);
      expect(document.querySelectorAll('link[hreflang]')).toHaveLength(0);
      expect([...document.querySelectorAll('a[href]')].some((link) => link.getAttribute('href')!.startsWith('/en/journeys/'))).toBe(false);
      expect(document.querySelector('main')?.textContent).not.toContain('Published journey en');
    }
  });
  it('keeps each public run summary and endpoint in the non-JavaScript fallback', async () => {
    const trip = tripFixture('a');
    trip.data.track = { version: 1, type: 'MultiLineString', coordinates: [
      [[1, 2], [3, 4]], [[90, 20], [91, 21]],
    ] };
    content.trips = [trip, tripFixture('c')]; content.journeys = [journeyFixture()];
    const container = await AstroContainer.create();
    const journey = liveJourneys(content.journeys, content.trips, 'de')[0]!;
    const document = documentOf(await container.renderToString(JourneyPage, { props: { journey } }));
    const fallback = document.querySelector('[data-journey-map-fallback]')!;
    expect(fallback.querySelectorAll(':scope > li > ol > li')).toHaveLength(2);
    for (const run of publicTrackSummary(trip.data.track, 'de')) {
      expect(fallback.textContent).toContain(run.start);
      expect(fallback.textContent).toContain(run.end);
      expect(fallback.textContent).toContain(run.distance);
    }
    expect(document.querySelector('main')!.textContent).toContain(ui.de['journey.mapNote']);
    expect(fallback.textContent).not.toContain('Not on overview');
  });
  it('adds one distinct strip while keeping the actual chronological pager unchanged', async () => {
    content.trips = [tripFixture('a'), tripFixture('c'), tripFixture('nonmember')];
    content.journeys = [journeyFixture()];
    const positions = journeyPositions(liveJourneys(content.journeys, content.trips, 'de'), content.journeys);
    const container = await AstroContainer.create();
    for (const trip of content.trips) {
      const render = (withJourney: boolean) => container.renderToString(StoryPage, { props: { trip, ...(withJourney ? { journeyPosition: positions.get(trip.id) } : {}) } });
      const before = await render(false); const after = await render(true);
      const baseline = documentOf(before); const current = documentOf(after);
      const selector = `nav[aria-label="${ui.de['story.pagination']}"]`;
      expect(current.querySelector(selector)?.outerHTML).toBe(baseline.querySelector(selector)?.outerHTML);
      if (trip.data.translationKey === 'nonmember') { expect(after).toBe(before); continue; }
      expect(current.querySelectorAll('[data-journey-strip]')).toHaveLength(1);
      expect(current.querySelector('[data-journey-strip] a')?.getAttribute('href')).toBe('/rundreisen/expedition/');
      expect(current.querySelector('[data-journey-strip]')?.textContent).toContain(trip.id === 'de/a' ? 'Geschichte 1 von 2' : 'Geschichte 2 von 2');
      expect(current.querySelector('[data-journey-previous]')?.getAttribute('href')).toBe(trip.id === 'de/a' ? undefined : '/a/');
      expect(current.querySelector('[data-journey-next]')?.getAttribute('href')).toBe(trip.id === 'de/a' ? '/c/' : undefined);
      expect(after).not.toContain('draft-secret');
    }
  });
  it.each([undefined, 'jpeg'] as const)('renders each real RemoteImage variant exactly once after retargeting (%s)', async (format) => {
    const entry = journeyEntries({ id: 'id', published_snapshot: { version: 1, members: [], locales: {
      de: { slug: 'trip', title: 'Title', intro: 'Introduction', heroImage: { ...hero, ...(format ? { format } : {}) } },
    } } }, modes[0]!, 'https://public.example')[0]!;
    const container = await AstroContainer.create();
    const document = documentOf(await container.renderToString(RemoteImage, { props: { image: entry.data.heroImage, sizes: '100vw' } }));
    for (const source of document.querySelectorAll('source')) for (const candidate of source.getAttribute('srcset')!.split(', ')) {
      expect(candidate).toMatch(/^https:\/\/public\.example\/photos\/journey-(640|1280|1600)\.(avif|webp|jpeg) (640|1280|1600)w$/);
    }
    expect(document.querySelector('img')?.getAttribute('src')).toBe(`https://public.example/photos/journey-1280.${format ?? 'webp'}`);
    expect(document.querySelector('img')?.getAttribute('style')).toContain('object-position:23% 71%');
    expect(document.querySelector('img')?.getAttribute('width')).toBe('1600');
  });
});
