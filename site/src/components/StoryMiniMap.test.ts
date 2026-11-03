import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StoryMiniMap from './StoryMiniMap.astro';
import type { Locale } from '../i18n/ui';
import type { Trip } from '../lib/trips';
import type { PublicTrack } from '../lib/public-track';
import type { PublicStopRoute } from '../lib/public-stop-route';

const track: PublicTrack = {
  version: 1, type: 'MultiLineString',
  coordinates: [[[1, 0], [1.001, 0]], [[101, 0], [101.002, 0]]],
};
const trip = (extra: Partial<Trip['data']> = {}) => ({
  id: 'de/synthetic-route',
  data: { title: 'Synthetic route', country: 'Country', region: 'europe', coordinates: { lat: 0, lng: 1 }, ...extra },
}) as Trip;

async function render(locale: Locale, data: Partial<Trip['data']>) {
  const renderer = await AstroContainer.create();
  const html = await renderer.renderToString(StoryMiniMap, { props: { trip: trip(data), locale } });
  const window = new Window();
  const root = window.document.createElement('div');
  root.innerHTML = html;
  await window.happyDOM.close();
  return root;
}

describe('story route text without client enhancement', () => {
  it.each(['de', 'en'] as const)('renders each public run and a persistent map link in %s', async (locale) => {
    const root = await render(locale, { track, route: 'Two quiet paths', stops: [{ name: 'Named stop', lat: 2, lng: 3 }] });
    const section = root.querySelector('section')!;
    expect(section.textContent).toContain('Two quiet paths');
    const runs = [...section.querySelectorAll('ol > li')];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.textContent).toContain(locale === 'de' ? '0,11' : '0.11');
    expect(runs[1]?.textContent).toContain(locale === 'de' ? '0,22' : '0.22');
    expect(runs.map((run) => [...run.querySelectorAll('dd')].map((node) => node.textContent))).toEqual([
      ['0.0000, 1.0000', '0.0000, 1.0010'], ['0.0000, 101.0000', '0.0000, 101.0020'],
    ]);
    expect(section.querySelector('ul')?.textContent).toContain('Named stop');
    expect(section.querySelector('a')?.getAttribute('href')).toBe(locale === 'de' ? '/karte/' : '/en/map/');
    // Map mounting/failure may replace the canvas; these remain outside it.
    expect(root.querySelector('#mini-map')?.contains(section)).toBe(false);
    const encoded = root.querySelector('#mini-map')!.getAttribute('data-geometry')!;
    expect(JSON.parse(encoded).track).toEqual(track);
  });

  it('escapes supplied route labels and stop names as text', async () => {
    const root = await render('en', { track, route: '<img src=x onerror=alert(1)>', stops: [{ name: '<script>private()</script>', lat: 2, lng: 3 }] });
    const section = root.querySelector('section')!;
    expect(section.querySelector('img, script')).toBeNull();
    expect(section.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(section.textContent).toContain('<script>private()</script>');
  });

  it('does not invent a label for a track without one', async () => {
    const root = await render('en', { track });
    expect(root.querySelector('section > p')).toBeNull();
    expect(root.querySelectorAll('section ol > li')).toHaveLength(2);
  });

  it('keeps the original fallback and has no empty route section for routeless stories', async () => {
    const root = await render('de', { route: 'A legacy label alone is not a public track' });
    expect(root.querySelector('section')).toBeNull();
    const map = root.querySelector('#mini-map')!;
    expect(map.querySelector('a')?.getAttribute('href')).toBe('/karte/');
    expect(JSON.parse(map.getAttribute('data-geometry')!)).not.toHaveProperty('track');
  });
});

describe('stops and stop routes without a GPX track (#513)', () => {
  const stopRoute: PublicStopRoute = { version: 1, runs: [
    { kind: 'road', coordinates: [[23.7275, 37.9838], [22.9322, 37.9407]] },
    { kind: 'straight', coordinates: [[21.7346, 38.2466], [28.2278, 36.4341]] },
  ] };
  const stops = [
    { name: 'Athens', lat: 37.9838, lng: 23.7275 },
    { name: 'Secret via shortcut', lat: 37.9961, lng: 23.3439, via: true },
    { name: '<img src=x onerror=alert(1)>', lat: 37.9407, lng: 22.9322 },
    { name: 'Rhodes', lat: 36.4341, lng: 28.2278 },
  ];

  it.each(['de', 'en'] as const)('lists non-via stops in order with the route note in %s, and never the via name', async (locale) => {
    const root = await render(locale, { stops, stopRoute, route: 'Caption stays GPX-only' });
    const section = root.querySelector('section[aria-labelledby="public-stops-heading"]')!;
    expect([...section.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['Athens', '<img src=x onerror=alert(1)>', 'Rhodes']);
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('p')?.textContent).toContain(locale === 'de' ? 'Gestrichelte' : 'Dashed');
    expect(root.outerHTML).not.toContain('Secret via shortcut');
    expect(root.textContent).not.toContain('Caption stays GPX-only');
    expect(root.querySelector('#public-route-heading')).toBeNull();
    const map = root.querySelector('#mini-map')!;
    expect(JSON.parse(map.getAttribute('data-geometry')!).stopRoute).toEqual(stopRoute);
    expect(map.getAttribute('data-route-attribution')).toContain('OpenStreetMap');
  });

  it('omits the dashed-section note when every leg follows roads, and shows the plain list without a route', async () => {
    const roadOnly = await render('en', { stops, stopRoute: { version: 1, runs: [stopRoute.runs[0]!] } });
    expect(roadOnly.querySelector('section p')?.textContent).not.toContain('Dashed');
    const listOnly = await render('en', { stops });
    expect(listOnly.querySelector('section p')).toBeNull();
    expect(listOnly.querySelectorAll('section ol > li')).toHaveLength(3);
  });

  it('keeps one stop list and the GPX section when a track is published, ignoring the stop route', async () => {
    const root = await render('en', { track, stopRoute, stops });
    expect(root.querySelector('section[aria-labelledby="public-stops-heading"]')).toBeNull();
    expect(root.querySelector('#public-route-heading')).not.toBeNull();
    expect(JSON.parse(root.querySelector('#mini-map')!.getAttribute('data-geometry')!)).not.toHaveProperty('stopRoute');
    expect(root.outerHTML).not.toContain('Secret via shortcut');
  });
});
