import { afterEach, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { initJourneyMap } from './journey-map';
import type { JourneyGeometry } from '../lib/journey-map';
const state = vi.hoisted(() => ({ maps: [] as {
  options: Record<string, unknown>; sources: Map<string, unknown>; layers: Record<string, unknown>[];
  events: Map<string, () => void>; bounds?: unknown;
}[], markers: [] as { element: HTMLElement; coordinates?: [number, number] }[] }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));
vi.mock('pmtiles', () => ({ Protocol: class { tile = vi.fn(); } }));
vi.mock('protomaps-themes-base', () => ({ layers: () => [], namedTheme: () => ({}) }));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(), addProtocol: vi.fn(), NavigationControl: class {}, Popup: class {}, LngLatBounds: class {},
  Marker: class {
    element: HTMLElement; coordinates?: [number, number];
    constructor({ element }: { element: HTMLElement }) { this.element = element; state.markers.push(this); }
    setLngLat(coordinates: [number, number]) { this.coordinates = coordinates; return this; }
    addTo() { return this; }
  },
  Map: class {
    options: Record<string, unknown>; sources = new Map<string, unknown>(); layers: Record<string, unknown>[] = [];
    events = new Map<string, () => void>(); bounds?: unknown;
    constructor(options: Record<string, unknown>) { this.options = options; state.maps.push(this); }
    addControl() {} on(event: string, callback: () => void) { this.events.set(event, callback); }
    addSource(id: string, source: unknown) { this.sources.set(id, source); }
    addLayer(layer: Record<string, unknown>) { this.layers.push(layer); }
    setStyle() { this.sources.clear(); this.layers = []; }
    fitBounds(bounds: unknown) { this.bounds = bounds; }
  },
}));
const window = new Window();
afterEach(() => { vi.unstubAllGlobals(); state.maps = []; state.markers = []; });
it('keeps each run independent, frames the antimeridian and exposes numbered keyboard links', () => {
  vi.stubGlobal('document', window.document);
  const geometry: JourneyGeometry = {
    pins: [{ number: 1, title: '<img onerror=bad>', href: '/first/', coordinates: [179.96, -16.81] },
      { number: 2, title: 'Second', href: '/second/', coordinates: [-179.9, -16.85] }],
    tracks: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[179.95, -16.8], [179.999, -16.82]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-179.98, -16.83], [-179.95, -16.84]] } },
    ] },
  };
  const before = structuredClone(geometry);
  const element = window.document.createElement('div') as unknown as HTMLElement;
  initJourneyMap(element, geometry, 'Story {number}: {title}');
  const map = state.maps[0]!; map.events.get('style.load')!();
  expect(map.options.style).toMatchObject({ glyphs: '/map/fonts/{fontstack}/{range}.pbf', sources: { protomaps: { url: 'pmtiles:///map/basemap.pmtiles' } } });
  expect(map.bounds).toEqual([[179.95, -16.85], [180.1, -16.8]]);
  expect(map.sources.get('journey-runs')).toMatchObject({ data: { features: [
    { geometry: { type: 'LineString', coordinates: geometry.tracks.features[0]!.geometry.coordinates } },
    { geometry: { type: 'LineString', coordinates: [[180.02, -16.83], [180.05, -16.84]] } },
  ] } });
  expect(map.layers.map((layer) => layer.type)).toEqual(['line']);
  expect(state.markers.map(({ element: link }) => [link.tagName, link.textContent, link.getAttribute('href'), link.getAttribute('aria-label')])).toEqual([
    ['A', '1', '/first/', 'Story 1: <img onerror=bad>'], ['A', '2', '/second/', 'Story 2: Second'],
  ]);
  expect(state.markers[0]!.element.querySelector('img')).toBeNull();
  const tracks = map.sources.get('journey-runs');
  map.events.get('error')!(); map.events.get('style.load')!();
  expect(map.sources.get('journey-runs')).toEqual(tracks);
  expect(state.markers).toHaveLength(2);
  expect(geometry).toEqual(before);
});
