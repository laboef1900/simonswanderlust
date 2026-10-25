import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StoryMiniMap from './StoryMiniMap.astro';
import type { Locale } from '../i18n/ui';
import type { Trip } from '../lib/trips';
import type { PublicTrack } from '../lib/public-track';

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
