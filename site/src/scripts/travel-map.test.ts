import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StoryMiniMap from '../components/StoryMiniMap.astro';
import type { Trip } from '../lib/trips';
import type { TripGeometry } from '../lib/map-data';
import { initFullMap, initMiniMap } from './travel-map';

// Astro components require Vitest's server transform; supply the browser DOM
// explicitly, as in StoryMiniMap.test.ts, instead of using a browser environment.
const browserWindow = new Window();
vi.stubGlobal('window', browserWindow);
vi.stubGlobal('document', browserWindow.document);
vi.stubGlobal('HTMLElement', browserWindow.HTMLElement);
vi.stubGlobal('HTMLCanvasElement', browserWindow.HTMLCanvasElement);
vi.stubGlobal('Event', browserWindow.Event);
vi.stubGlobal('CustomEvent', browserWindow.CustomEvent);
afterAll(() => vi.unstubAllGlobals());

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
  webgl: 'supported' as 'supported' | 'unsupported' | 'partial',
  removeThrows: false,
  removals: 0,
}));

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));
vi.mock('pmtiles', () => ({ Protocol: class { tile = vi.fn(); } }));
vi.mock('protomaps-themes-base', () => ({ layers: () => [], namedTheme: () => ({}) }));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(), addProtocol: vi.fn(), NavigationControl: class {},
  Marker: class {
    element: HTMLElement;
    coordinates?: [number, number];
    constructor({ element }: { element: HTMLElement }) { this.element = element; }
    setLngLat(coordinates: [number, number]) { this.coordinates = coordinates; return this; }
    addTo(map: { canvas: HTMLCanvasElement }) { map.canvas.parentElement?.append(this.element); return this; }
  },
  Popup: class {
    lngLat?: [number, number];
    content?: HTMLElement;
    wrapper?: HTMLElement;
    setLngLat(lngLat: [number, number]) { this.lngLat = lngLat; return this; }
    setDOMContent(content: HTMLElement) { this.content = content; return this; }
    addTo(map: { canvas: HTMLCanvasElement }) {
      const wrapper = document.createElement('div');
      wrapper.className = 'maplibregl-popup';
      const close = document.createElement('button');
      close.className = 'maplibregl-popup-close-button';
      close.setAttribute('aria-label', 'Close popup');
      if (this.content) wrapper.append(this.content);
      wrapper.append(close);
      map.canvas.parentElement?.append(wrapper);
      this.wrapper = wrapper;
      return this;
    }
    remove() { this.wrapper?.remove(); }
  },
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
    canvas: HTMLCanvasElement;
    constructor({ container }: { container: HTMLElement }) {
      this.canvas = document.createElement('canvas');
      this.canvas.dataset.mapCanvas = 'true';
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('role', 'region');
      container.classList.add('maplibregl-map');
      container.append(this.canvas);
      state.maps.push(this);
    }
    getCanvas() { return this.canvas; }
    remove() {
      state.removals++;
      if (state.removeThrows) throw new Error('painter is absent');
      this.canvas.remove();
    }
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
const container = () => document.createElement('div');
const loseContext = vi.fn();

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (state.webgl === 'unsupported' || (state.webgl === 'partial' && this.dataset.mapCanvas)) return null;
    return { getExtension: () => ({ loseContext }) } as unknown as WebGL2RenderingContext;
  });
});

afterEach(() => {
  state.maps.length = 0;
  state.webgl = 'supported';
  state.removeThrows = false;
  state.removals = 0;
  loseContext.mockClear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

// Execute the real Astro client script, with only its module imports supplied
// by this harness. Assertions below observe DOM behavior, not source wording.
function mount(component: string) {
  const source = readFileSync(resolve(process.cwd(), 'src/components', component), 'utf8');
  // Static imports and MapPage's lazy `await import()` (#280: an empty map page loads no
  // map bundle) both resolve to the module under test, injected below.
  const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]!.replace(/^  import .*;\n/gm, '')
    .replace(/^\s*const \{ initFullMap \} = await import\([^)]*\);\n/gm, '');
  let intersect = () => {};
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      intersect = () => callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        { disconnect } as unknown as IntersectionObserver,
      );
    }
    observe() {}
  }
  new Function('document', 'initMiniMap', 'initFullMap', 'IntersectionObserver', 'console', stripTypeScriptTypes(script))(
    document, initMiniMap, initFullMap, Observer, { error: vi.fn() },
  );
  return { intersect, disconnect };
}

async function story(track: boolean) {
  const renderer = await AstroContainer.create();
  document.body.innerHTML = await renderer.renderToString(StoryMiniMap, { props: {
    locale: 'en',
    trip: { id: 'en/synthetic-route', data: {
      title: 'Synthetic route', country: 'Country', region: 'europe',
      coordinates: { lat: 2, lng: 1 },
      ...(track ? { track: routed.track, route: 'Two public paths' } : {}),
    } } as Trip,
  } });
  return document.getElementById('mini-map')!;
}

describe('WebGL2 progressive enhancement', () => {
  it.each(['mini', 'full'] as const)('refuses unsupported %s maps before construction', (kind) => {
    state.webgl = 'unsupported';
    const el = container();
    const initialize = () => kind === 'mini'
      ? initMiniMap(el, plain)
      : initFullMap(el, { type: 'FeatureCollection', features: [plain.pin] }, { readStory: 'Read' });
    expect(initialize).toThrow('map_webgl_unavailable');
    expect(state.maps).toHaveLength(0);
    expect(el.querySelector('canvas')).toBeNull();
  });

  it.each([false, true])('removes a partial constructor result even when remove throws: %s', (removeThrows) => {
    state.webgl = 'partial';
    state.removeThrows = removeThrows;
    const el = container();
    expect(() => initMiniMap(el, routed)).toThrow('map_webgl_unavailable');
    expect(state.removals).toBe(1);
    expect(el.querySelector('[tabindex], canvas')).toBeNull();
    expect(el.classList.contains('maplibregl-map')).toBe(false);
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it.each(['unsupported', 'partial'] as const)('restores the trackless story link after %s initialization', async (webgl) => {
    state.webgl = webgl;
    state.removeThrows = true;
    const el = await story(false);
    const fallback = el.innerHTML;
    const observer = mount('StoryMiniMap.astro');
    expect(el.innerHTML).toBe(fallback); // still lazy before intersection
    observer.intersect();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(el.innerHTML).toBe(fallback);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/en/map/');
    expect(el.hidden).toBe(false);
    expect(el.style.height).toBe('auto');
    expect(el.querySelector('canvas, [tabindex]')).toBeNull();
  });

  it.each(['unsupported', 'partial'] as const)('keeps tracked story text and link without an empty map after %s initialization', async (webgl) => {
    state.webgl = webgl;
    const el = await story(true);
    const section = document.querySelector('section')!;
    const text = section.textContent;
    mount('StoryMiniMap.astro').intersect();
    expect(el.hidden).toBe(true);
    expect(el.querySelector('canvas, [tabindex]')).toBeNull();
    expect(section.textContent).toBe(text);
    expect(section.querySelectorAll('ol > li')).toHaveLength(2);
    expect(section.querySelector('a')?.getAttribute('href')).toBe('/en/map/');
  });

  it.each([false, true])('replaces the story fallback with a working map when supported (track: %s)', async (track) => {
    const el = await story(track);
    mount('StoryMiniMap.astro').intersect();
    const map = state.maps[0]!;
    expect(el.querySelector('canvas')).not.toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.hidden).toBe(false);
    expect(el.dataset.ready).toBeUndefined();
    map.events.get('style.load')!();
    expect(el.dataset.ready).toBe('true');
    expect(map.sources.has('track')).toBe(track);
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it.each(['unsupported', 'partial', 'supported'] as const)('keeps the full map list usable with %s WebGL2', (webgl) => {
    state.webgl = webgl;
    state.removeThrows = true;
    document.body.innerHTML = '<div><div id="map"></div></div><nav><a href="/story/">Story</a></nav>';
    const el = document.getElementById('map')!;
    el.dataset.geojson = JSON.stringify({ type: 'FeatureCollection', features: [plain.pin] });
    el.dataset.readstory = 'Read story';
    mount('pages/MapPage.astro');
    expect(document.querySelector('nav a')?.getAttribute('href')).toBe('/story/');
    if (webgl === 'supported') {
      expect(el.parentElement!.hidden).toBe(false);
      expect(el.querySelector('canvas')).not.toBeNull();
      state.maps[0]!.events.get('load')!();
      expect(el.dataset.ready).toBe('true');
    } else {
      expect(el.parentElement!.hidden).toBe(true);
      expect(el.querySelector('canvas, [tabindex]')).toBeNull();
    }
  });
});

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

  it('draws pins only as accessible DOM markers and keeps region filters and error recovery working', () => {
    document.body.innerHTML = `
      <button type="button" data-map-region="all" aria-pressed="true">All</button>
      <button type="button" data-map-region="europe" aria-pressed="false">Europe</button>
      <button type="button" data-map-region="south-america" aria-pressed="false">South America</button>
      <button type="button" data-map-reset>Reset</button>
      <div id="map"></div>
      <section data-region-group="europe">
        <li data-map-entry data-pin-index="0" data-region="europe"><button type="button" data-map-focus="0">01</button></li>
      </section>
      <section data-region-group="south-america">
        <li data-map-entry data-pin-index="1" data-region="south-america"><button type="button" data-map-focus="1">02</button></li>
      </section>
    `;
    const el = document.getElementById('map')!;
    const southPin = {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [-78.5, -0.2] as [number, number] },
      properties: { title: 'Ecuador <script>', href: '/ecuador/', country: 'Ecuador', region: 'south-america' as const },
    };
    initFullMap(
      el,
      { type: 'FeatureCollection', features: [plain.pin, southPin] },
      { readStory: 'Read story', pinLabel: 'Trip {number}: {title} ({country})', closePopup: 'Hinweis schließen' },
    );
    const map = state.maps[0]!;
    map.events.get('load')!();
    // No WebGL pin layer: it would duplicate the badges and repeat, unnumbered, in world copies.
    expect([...map.sources.keys()]).toEqual([]);
    expect(map.layers).toEqual([]);

    const pins = el.querySelectorAll<HTMLButtonElement>('.travel-map-pin');
    expect(pins).toHaveLength(2);
    expect(pins[0]!.getAttribute('aria-label')).toBe('Trip 1: Story (Country)');
    expect(pins[1]!.getAttribute('aria-label')).toBe('Trip 2: Ecuador <script> (Ecuador)');

    // Clicking a ledger focus button centers the map, opens an XSS-safe popup, and syncs active state.
    document.querySelector<HTMLButtonElement>('[data-map-focus="1"]')!.click();
    expect(map.center).toEqual([-78.5, -0.2]);
    expect(pins[1]!.dataset.active).toBe('true');
    expect(document.querySelectorAll<HTMLElement>('[data-map-entry]')[1]!.dataset.active).toBe('true');
    const popup = el.querySelector('.travel-map-popup')!;
    expect(popup.querySelector('.travel-map-popup__title')?.textContent).toBe('Ecuador <script>');
    expect(popup.querySelector('script')).toBeNull();
    expect(popup.querySelector<HTMLAnchorElement>('.travel-map-popup__cta')?.getAttribute('href')).toBe('/ecuador/');
    expect(el.querySelector('.maplibregl-popup-close-button')?.getAttribute('aria-label')).toBe('Hinweis schließen');

    // Filtering by region hides non-matching pins and ledger groups and reframes bounds.
    document.querySelector<HTMLButtonElement>('[data-map-region="europe"]')!.click();
    expect(pins[0]!.hidden).toBe(false);
    expect(pins[1]!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-region-group="south-america"]')!.hidden).toBe(true);
    expect(map.bounds).toMatchObject({ points: [[1, 2]] });

    // Reset button restores all regions and pins.
    document.querySelector<HTMLButtonElement>('[data-map-reset]')!.click();
    expect(pins[1]!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-region-group="south-america"]')!.hidden).toBe(false);
    expect(map.bounds).toMatchObject({ points: [[1, 2], [-78.5, -0.2]] });

    // Basemap failure swaps to the fallback style; the DOM pins survive and are not duplicated.
    map.events.get('error')!();
    expect(map.sources.size).toBe(0);
    map.events.get('style.load')!();
    expect(el.querySelectorAll('.travel-map-pin')).toHaveLength(2);
    expect(el.dataset.ready).toBe('true');
  });
});
