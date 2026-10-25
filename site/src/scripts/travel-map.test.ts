import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TripGeometry } from '../lib/map-data';
import { initFullMap, initMiniMap } from './travel-map';

const state = vi.hoisted(() => ({
  maps: [] as {
    sources: Map<string, unknown>;
    layers: Record<string, unknown>[];
    events: Map<string, () => void>;
    center: unknown;
    zoom: unknown;
    bounds: { points: [number, number][] } | undefined;
  }[],
}));

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));
vi.mock('pmtiles', () => ({ Protocol: class { tile = vi.fn(); } }));
vi.mock('protomaps-themes-base', () => ({ layers: () => [], namedTheme: () => ({}) }));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(), addProtocol: vi.fn(), NavigationControl: class {}, Popup: class {},
  LngLatBounds: class {
    points: [number, number][] = [];
    extend(point: [number, number]) { this.points.push(point); }
    isEmpty() { return this.points.length === 0; }
  },
  Map: class {
    sources = new Map<string, unknown>();
    layers: Record<string, unknown>[] = [];
    events = new Map<string, () => void>();
    center: unknown;
    zoom: unknown;
    bounds: { points: [number, number][] } | undefined;
    constructor() { state.maps.push(this); }
    addControl() {}
    on(event: string, ...args: unknown[]) { if (event === 'load') this.events.set(event, args[0] as () => void); }
    addSource(id: string, source: unknown) { this.sources.set(id, source); }
    addLayer(layer: Record<string, unknown>) { this.layers.push(layer); }
    setCenter(center: unknown) { this.center = center; }
    setZoom(zoom: unknown) { this.zoom = zoom; }
    fitBounds(bounds: { points: [number, number][] }) { this.bounds = bounds; }
  },
}));

const plain: TripGeometry = {
  pin: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { title: 'Story', href: '/story/', country: 'Country', region: 'europe' } },
  stops: [],
};
const routed: TripGeometry = {
  ...plain,
  stops: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] }, properties: { name: 'Stop' } }],
  track: { version: 1, type: 'MultiLineString', coordinates: [[[10, 20], [50, 60], [11, 21]], [[-10, -20], [-11, -21]]] },
};
const container = () => ({ dataset: {} }) as HTMLElement;

afterEach(() => { state.maps.length = 0; });

describe('story track map', () => {
  it('adds separate discontinuous line below all circles and fits every vertex, pin and stop', () => {
    const element = container();
    initMiniMap(element, routed);
    const map = state.maps[0]!;
    map.events.get('load')!();
    expect(map.layers.map((layer) => [layer.id, layer.type])).toEqual([['track', 'line'], ['trip', 'circle']]);
    expect(map.sources.get('track')).toEqual({ type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: routed.track!.coordinates },
    } });
    expect(map.sources.get('trip')).toEqual({ type: 'geojson', data: { type: 'FeatureCollection', features: [routed.pin, ...routed.stops] } });
    expect(map.bounds?.points).toEqual([[1, 2], [3, 4], [10, 20], [50, 60], [11, 21], [-10, -20], [-11, -21]]);
    expect(element.dataset.ready).toBe('true');
  });

  it('fits a track even when the story has no stops', () => {
    initMiniMap(container(), { ...routed, stops: [] });
    const map = state.maps[0]!;
    map.events.get('load')!();
    expect(map.bounds?.points).toContainEqual([50, 60]);
    expect(map.center).toBeUndefined();
  });

  it('leaves route-free single-pin behavior and stop bounds unchanged', () => {
    initMiniMap(container(), plain);
    const pinMap = state.maps[0]!;
    pinMap.events.get('load')!();
    expect(pinMap.layers.map((layer) => layer.id)).toEqual(['trip']);
    expect(pinMap.sources.has('track')).toBe(false);
    expect(pinMap.center).toEqual([1, 2]);
    expect(pinMap.zoom).toBe(5);
    initMiniMap(container(), { ...plain, stops: routed.stops });
    const stopMap = state.maps[1]!;
    stopMap.events.get('load')!();
    expect(stopMap.bounds?.points).toEqual([[1, 2], [3, 4]]);
  });

  it('keeps the full map pin-only', () => {
    initFullMap(container(), { type: 'FeatureCollection', features: [plain.pin] }, { readStory: 'Read' });
    const map = state.maps[0]!;
    map.events.get('load')!();
    expect([...map.sources.keys()]).toEqual(['pins']);
    expect(map.layers.map((layer) => layer.type)).toEqual(['circle']);
  });
});
