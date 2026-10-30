import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { Locale } from '../../i18n/ui';
import type { Trip } from '../../lib/trips';
import RegionPage from './RegionPage.astro';
import MapPage from './MapPage.astro';
import AboutPage from './AboutPage.astro';

const content = vi.hoisted(() => ({ trips: [] as Trip[] }));
vi.mock('astro:content', () => ({
  getCollection: async () => content.trips,
  getEntry: async () => undefined,
  render: vi.fn(),
}));

function seed(locale: Locale, count: number) {
  content.trips = Array.from({ length: count }, (_, index): Trip => ({
    id: `${locale}/trip-${index}`,
    collection: 'trips',
    data: {
      title: `Story ${index}`, date: new Date('2026-01-01'),
      country: 'Japan', countryCode: 'JP', region: 'asia', translationKey: `trip-${index}`,
      excerpt: 'A journey.', coordinates: { lat: 35, lng: 139 },
      heroImage: { src: 'https://images.example/trip', width: 1280, height: 800, alt: 'Landscape' },
    },
  }));
}

const cases = [
  ['de', 0, '0 REISEN', '0 Pin-Standorte'],
  ['de', 1, '1 REISE', '1 Pin-Standort'],
  ['de', 2, '2 REISEN', '2 Pin-Standorte'],
  ['en', 0, '0 TRIPS', '0 pin locations'],
  ['en', 1, '1 TRIP', '1 pin location'],
  ['en', 2, '2 TRIPS', '2 pin locations'],
] as const;

describe('rendered public count labels', () => {
  it.each(cases)('renders region and map counts in %s for %d', async (locale, count, trips, pins) => {
    seed(locale, count);
    const renderer = await AstroContainer.create();
    const window = new Window();
    try {
      const region = window.document.createElement('div');
      region.innerHTML = await renderer.renderToString(RegionPage, { props: { locale, region: 'asia' } });
      expect(region.querySelector('main section p')?.textContent?.trim()).toBe(trips);

      const map = window.document.createElement('div');
      map.innerHTML = await renderer.renderToString(MapPage, { props: { locale } });
      expect([...map.querySelectorAll('main span')].some((span) => span.textContent?.trim() === pins)).toBe(true);
    } finally {
      await window.happyDOM.close();
    }
  });

  it.each([
    ['de', ['REISE', 'LAND', 'KONTINENT']],
    ['en', ['TRIP', 'COUNTRY', 'CONTINENT']],
  ] as const)('renders singular About statistics in %s', async (locale, labels) => {
    seed(locale, 1);
    const renderer = await AstroContainer.create();
    const window = new Window();
    try {
      const root = window.document.createElement('div');
      root.innerHTML = await renderer.renderToString(AboutPage, { props: { locale } });
      const rows = [...root.querySelectorAll('main div.flex.justify-between')];
      expect(rows.map((row) => [...row.querySelectorAll('span')].map((span) => span.textContent)))
        .toEqual(labels.map((label) => [label, '1']));
    } finally {
      await window.happyDOM.close();
    }
  });
});
