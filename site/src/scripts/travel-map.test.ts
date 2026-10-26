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
    bounds: unknown;
    fitOptions: unknown;
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
    bounds: unknown;
    fitOptions: unknown;
    constructor() { state.maps.push(this); }
    addControl() {}
    on(event: string, ...args: unknown[]) { this.events.set(event, args[0] as () => void); }
    addSource(id: string, source: unknown) { this.sources.set(id, source); }
    addLayer(layer: Record<string, unknown>) { this.layers.push(layer); }
    setStyle() { this.sources.clear(); this.layers = []; }
    setCenter(center: unknown) { this.center = center; }
    setZoom(zoom: unknown) { this.zoom = zoom; }
    fitBounds(bounds: unknown, options: unknown) { this.bounds = bounds; this.fitOptions = options; }
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
  it('renders and frames before tiles load, then restores overlays after local basemap failure', () => {
    const element = container();
    initMiniMap(element, routed);
    const map = state.maps[0]!;
    map.events.get('style.load')!();
    const track = map.sources.get('track');
    const bounds = map.bounds;
    expect(map.fitOptions).toMatchObject({ duration: 0 });
    map.events.get('error')!();
    expect(map.sources.size).toBe(0);
    map.events.get('style.load')!();
    expect(map.sources.get('track')).toEqual(track);
    expect(map.layers.map((layer) => layer.id)).toEqual(['track', 'trip']);
    expect(map.bounds).toBe(bounds);
    expect(element.dataset.ready).toBe('true');
    map.events.get('error')!();
    expect(map.sources.get('track')).toEqual(track);
  });

  it('frames crossing route runs, pin and stops in one display-only world copy', () => {
    const geometry: TripGeometry = {
      pin: { ...plain.pin, geometry: { type: 'Point', coordinates: [179.96, -16.81] } },
      stops: [{ type: 'Feature', properties: { name: 'Stop' }, geometry: { type: 'Point', coordinates: [-179.9, -16.85] } }],
      track: { version: 1, type: 'MultiLineString', coordinates: [
        [[179.95, -16.8], [179.999, -16.82]], [[-179.98, -16.83], [-179.95, -16.84]],
      ] },
    };
    const before = structuredClone(geometry);
    initMiniMap(container(), geometry);
    const map = state.maps[0]!;
    map.events.get('style.load')!();
    expect(map.bounds).toEqual([[179.95, -16.85], [180.1, -16.8]]);
    expect(map.sources.get('track')).toMatchObject({ data: { geometry: { coordinates: [
      geometry.track!.coordinates[0], [[180.02, -16.83], [180.05, -16.84]],
    ] } } });
    expect(map.sources.get('trip')).toMatchObject({ data: { features: [
      { geometry: { coordinates: [179.96, -16.81] } }, { geometry: { coordinates: [180.1, -16.85] } },
    ] } });
    expect(geometry).toEqual(before);
  });

  it('does not fold a genuinely wide connected route at a gap between vertices', () => {
    initMiniMap(container(), { ...plain, track: { version: 1, type: 'MultiLineString', coordinates: [[[-170, 0], [0, 1], [170, 2]]] } });
    const map = state.maps[0]!;
    map.events.get('style.load')!();
    expect(map.bounds).toEqual([[-170, 0], [170, 2]]);
    expect(map.sources.get('track')).toMatchObject({ data: { geometry: { coordinates: [[[-170, 0], [0, 1], [170, 2]]] } } });
  });

  it('adds separate discontinuous line below all circles and fits every vertex, pin and stop', () => {
    const element = container();
    initMiniMap(element, routed);
    const map = state.maps[0]!;
    map.events.get('style.load')!();
    expect(map.layers.map((layer) => [layer.id, layer.type])).toEqual([['track', 'line'], ['trip', 'circle']]);
    expect(map.sources.get('track')).toEqual({ type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: routed.track!.coordinates },
    } });
    expect(map.sources.get('trip')).toEqual({ type: 'geojson', data: { type: 'FeatureCollection', features: [routed.pin, ...routed.stops] } });
    expect(map.bounds).toEqual([[-11, -21], [50, 60]]);
    expect(element.dataset.ready).toBe('true');
  });

  it('fits a track even when the story has no stops', () => {
    initMiniMap(container(), { ...routed, stops: [] });
    const map = state.maps[0]!;
    map.events.get('style.load')!();
    expect(map.bounds).toEqual([[-11, -21], [50, 60]]);
    expect(map.center).toBeUndefined();
  });

  it('leaves route-free single-pin behavior and stop bounds unchanged', () => {
    initMiniMap(container(), plain);
    const pinMap = state.maps[0]!;
    pinMap.events.get('style.load')!();
    expect(pinMap.layers.map((layer) => layer.id)).toEqual(['trip']);
    expect(pinMap.sources.has('track')).toBe(false);
    expect(pinMap.center).toEqual([1, 2]);
    expect(pinMap.zoom).toBe(5);
    initMiniMap(container(), { ...plain, stops: routed.stops });
    const stopMap = state.maps[1]!;
    stopMap.events.get('style.load')!();
    expect(stopMap.bounds).toEqual([[1, 2], [3, 4]]);
  });

  it('keeps the full map pin-only', () => {
    initFullMap(container(), { type: 'FeatureCollection', features: [plain.pin] }, { readStory: 'Read' });
    const map = state.maps[0]!;
    map.events.get('load')!();
    expect([...map.sources.keys()]).toEqual(['pins']);
    expect(map.layers.map((layer) => layer.type)).toEqual(['circle']);
  });
});
