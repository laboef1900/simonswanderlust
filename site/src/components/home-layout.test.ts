import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import HomePage from './pages/HomePage.astro';
import { pathOf, type Trip } from '../lib/trips';
import { ui } from '../i18n/ui';

const content = vi.hoisted(() => ({ trips: [] as Trip[] }));
vi.mock('astro:content', () => ({
  getCollection: async (name: string) => (name === 'trips' ? content.trips : []),
  getEntry: async () => undefined,
  render: async () => ({ headings: [] }),
}));

const windows: Window[] = [];
function documentOf(html: string) {
  const window = new Window();
  windows.push(window);
  return new window.DOMParser().parseFromString(html, 'text/html');
}

function makeTrip(slug: string, title: string, coords: { lat: number; lng: number }): Trip {
  return {
    id: `en/${slug}`,
    collection: 'trips',
    rendered: { html: '<p>Body</p>' },
    data: {
      title,
      date: new Date('2025-05-01'),
      translationKey: slug,
      region: 'europe',
      country: 'Romania',
      countryCode: 'RO',
      excerpt: 'Excerpt',
      coordinates: coords,
      heroImage: { src: 'https://example.com/photo', width: 1600, height: 900, alt: '' },
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  content.trips = [];
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

describe('HomePage navigation and MapTeaser pins', () => {
  it('offers region navigation and links map pins with full accessible titles', async () => {
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify({ primary: 'en', locales: ['en'] }));
    const tripA = makeTrip('bucharest', '4-day travel report: Bucharest', { lat: 44.4268, lng: 26.1025 });
    const tripB = makeTrip('rhodes', 'Rhodes', { lat: 36.4349, lng: 28.2176 });
    content.trips = [tripA, tripB];

    const container = await AstroContainer.create();
    const doc = documentOf(
      await container.renderToString(HomePage, {
        props: { locale: 'en' },
        request: new Request('https://simonswanderlust.com/'),
      }),
    );

    const storiesSection = doc.getElementById('stories')!;
    expect(storiesSection.querySelector('h2')?.textContent).toBe(ui.en['home.allStories']);
    expect(storiesSection.querySelector(`nav[aria-label="${ui.en['regions.navLabel']}"]`)).not.toBeNull();

    const chartSvg = doc.querySelector(`svg[aria-label="${ui.en['home.mapTeaser.chartLabel']}"]`)!;
    expect(chartSvg).not.toBeNull();
    expect(chartSvg.getAttribute('role')).toBe('group');

    const pinLinks = [...chartSvg.querySelectorAll('a.chart-pin')];
    expect(pinLinks).toHaveLength(2);
    expect(pinLinks[0]?.getAttribute('href')).toBe(pathOf(tripA));
    expect(pinLinks[0]?.getAttribute('aria-label')).toBe(tripA.data.title);
    expect(pinLinks[0]?.querySelector('title')?.textContent).toBe(tripA.data.title);
    expect(pinLinks[0]?.querySelector('text')?.textContent?.trim()).toBe('4-day travel…');

    expect(pinLinks[1]?.getAttribute('href')).toBe(pathOf(tripB));
    expect(pinLinks[1]?.querySelector('text')?.textContent?.trim()).toBe('Rhodes');
  });
});
