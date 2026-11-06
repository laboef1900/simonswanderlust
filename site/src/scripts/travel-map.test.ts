import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StoryMiniMap from '../components/StoryMiniMap.astro';
import type { Trip } from '../lib/trips';
import type { OverviewPinFeature, PinFeature, PinPhoto, TripGeometry } from '../lib/map-data';
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
vi.stubGlobal('KeyboardEvent', browserWindow.KeyboardEvent);
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
    getElement() { return this.element; }
    remove() { this.element.remove(); }
  },
  Popup: class {
    lngLat?: [number, number];
    content?: HTMLElement;
    wrapper?: HTMLElement;
    handlers = new Map<string, () => void>();
    setLngLat(lngLat: [number, number]) { this.lngLat = lngLat; return this; }
    setDOMContent(content: HTMLElement) { this.content = content; return this; }
    addTo(map: { canvas: HTMLCanvasElement }) {
      const wrapper = document.createElement('div');
      wrapper.className = 'maplibregl-popup';
      const close = document.createElement('button');
      close.className = 'maplibregl-popup-close-button';
      close.setAttribute('aria-label', 'Close popup');
      // Like MapLibre: the close button removes the popup, which emits `close`.
      close.addEventListener('click', () => this.remove());
      if (this.content) wrapper.append(this.content);
      wrapper.append(close);
      map.canvas.parentElement?.append(wrapper);
      this.wrapper = wrapper;
      return this;
    }
    on(event: string, handler: () => void) { this.handlers.set(event, handler); return this; }
    remove() {
      if (!this.wrapper) return this;
      this.wrapper.remove();
      this.wrapper = undefined;
      this.handlers.get('close')?.();
      return this;
    }
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
    // Camera and projection for the overview map: a flat plane, 10px per degree at zoom 0.
    getZoom() { return typeof this.zoom === 'number' ? this.zoom : 1; }
    project([lng, lat]: [number, number]) { const scale = 10 * 2 ** this.getZoom(); return { x: lng * scale, y: -lat * scale }; }
    getCenter() { return { lng: 0, lat: 0 }; }
    getBounds() { return { getWest: () => -30, getEast: () => 30, getSouth: () => -20, getNorth: () => 60 }; }
    getSource(id: string) { return this.sources.get(id); }
    getStyle() { return { layers: this.layers }; }
    easeTo({ center, zoom }: { center: unknown; zoom: unknown }) { this.center = center; this.zoom = zoom; }
    jumpTo({ center, zoom }: { center: unknown; zoom: unknown }) { this.center = center; this.zoom = zoom; }
  },
}));

const plain: TripGeometry = {
  pin: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { title: 'Story', href: '/story/', country: 'Country', region: 'europe' } },
  stops: [],
};
/** An overview-map pin as `tripPins` emits it: entry number plus popup photo. */
const overview = (pin: PinFeature, number: number, photo: Partial<PinPhoto> = {}): OverviewPinFeature => ({
  ...pin,
  properties: { ...pin.properties, number, photo: { src: 'https://img.example/trips/x/hero-640.webp', width: 1280, height: 800, alt: 'Harbour at dusk', ...photo } },
});
const pinAt = (coordinates: [number, number], title: string, region: PinFeature['properties']['region'] = 'europe'): PinFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { title, href: `/${title.toLowerCase().replace(/\W+/g, '-')}/`, country: 'Country', region },
});
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
      : initFullMap(el, { type: 'FeatureCollection', features: [overview(plain.pin, 1)] }, { readStory: 'Read' });
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
    el.dataset.geojson = JSON.stringify({ type: 'FeatureCollection', features: [overview(plain.pin, 1)] });
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

  it('draws numbered DOM pins with photo popups, Escape focus return, region filters and error recovery', () => {
    document.body.innerHTML = `
      <button type="button" data-map-region="all" aria-pressed="true">All</button>
      <button type="button" data-map-region="europe" aria-pressed="false">Europe</button>
      <button type="button" data-map-region="south-america" aria-pressed="false">South America</button>
      <div id="map"></div>
      <section data-region-group="europe">
        <li data-map-entry data-pin-index="0" data-region="europe"><button type="button" data-map-focus="0">N°02</button></li>
      </section>
      <section data-region-group="south-america">
        <li data-map-entry data-pin-index="1" data-region="south-america"><button type="button" data-map-focus="1">N°01</button></li>
      </section>
    `;
    const el = document.getElementById('map')!;
    const south = overview({ ...pinAt([-78.5, -0.2], 'Ecuador <script>', 'south-america'), properties: { title: 'Ecuador <script>', href: '/ecuador/', country: 'Ecuador', region: 'south-america' } },
      1, { src: 'https://img.example/trips/ecuador/hero-640.webp', alt: 'Canoe on a black river', position: '20% 30%' });
    initFullMap(
      el,
      { type: 'FeatureCollection', features: [overview(plain.pin, 2), south] },
      { readStory: 'Read story', pinLabel: 'Trip {number}: {title} ({country})', closePopup: 'Hinweis schließen' },
    );
    const map = state.maps[0]!;
    map.events.get('load')!();
    // The only WebGL layer is the graticule; pins are DOM markers (a circle layer
    // would sit under every badge and repeat, unnumbered, in world copies).
    expect([...map.sources.keys()]).toEqual(['graticule']);
    expect(map.layers.map((layer) => [layer.id, layer.type])).toEqual([['graticule', 'line']]);
    expect(el.querySelector('.travel-map-graticule')?.textContent).toContain('45°N');

    const pins = el.querySelectorAll<HTMLButtonElement>('.travel-map-pin');
    expect([...pins].map((pin) => [pin.getAttribute('aria-label'), pin.textContent])).toEqual([
      ['Trip 2: Story (Country)', '02'],
      ['Trip 1: Ecuador <script> (Ecuador)', '01'],
    ]);

    // Locating from the list zooms in, opens an XSS-safe photo popup and syncs both active states.
    const locate = document.querySelector<HTMLButtonElement>('[data-map-focus="1"]')!;
    locate.focus();
    locate.click();
    expect(map.center).toEqual([-78.5, -0.2]);
    expect(map.zoom).toBe(5);
    expect(pins[1]!.dataset.active).toBe('true');
    expect(document.querySelectorAll<HTMLElement>('[data-map-entry]')[1]!.dataset.active).toBe('true');
    const popup = el.querySelector('.travel-map-popup')!;
    const photo = popup.querySelector('img')!;
    expect([photo.getAttribute('src'), photo.alt, photo.style.objectPosition]).toEqual(['https://img.example/trips/ecuador/hero-640.webp', 'Canoe on a black river', '20% 30%']);
    expect(popup.querySelector('.travel-map-popup__meta')?.textContent).toBe('N°01 · Ecuador');
    expect(popup.querySelector('.travel-map-popup__title')?.textContent).toBe('Ecuador <script>');
    expect(popup.querySelector('script')).toBeNull();
    expect(popup.querySelector<HTMLAnchorElement>('.travel-map-popup__cta')?.getAttribute('href')).toBe('/ecuador/');
    expect(el.querySelector('.maplibregl-popup-close-button')?.getAttribute('aria-label')).toBe('Hinweis schließen');

    // Escape closes it and hands focus back to the button that opened it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.querySelector('.travel-map-popup')).toBeNull();
    expect(document.activeElement).toBe(locate);
    expect(pins[1]!.dataset.active).toBe('false');

    // The popup's own close button also returns focus to the pin that opened it
    // (a real click focuses each button first; the close button then leaves the DOM).
    pins[0]!.focus();
    pins[0]!.click();
    const close = el.querySelector<HTMLButtonElement>('.maplibregl-popup-close-button')!;
    close.focus();
    close.click();
    expect(el.querySelector('.travel-map-popup')).toBeNull();
    expect(document.activeElement).toBe(pins[0]);

    // A region hides other pins and list groups and reframes; "All" is the reset.
    document.querySelector<HTMLButtonElement>('[data-map-region="europe"]')!.click();
    expect([pins[0]!.hidden, pins[1]!.hidden]).toEqual([false, true]);
    expect(document.querySelector<HTMLElement>('[data-region-group="south-america"]')!.hidden).toBe(true);
    expect(map.bounds).toMatchObject({ points: [[1, 2]] });
    document.querySelector<HTMLButtonElement>('[data-map-region="all"]')!.click();
    expect(pins[1]!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-region-group="south-america"]')!.hidden).toBe(false);
    expect(map.bounds).toMatchObject({ points: [[1, 2], [-78.5, -0.2]] });

    // Basemap failure swaps to the fallback style: the graticule comes back, pins are not duplicated.
    map.events.get('error')!();
    expect(map.sources.size).toBe(0);
    map.events.get('style.load')!();
    expect([...map.sources.keys()]).toEqual(['graticule']);
    expect(el.querySelectorAll('.travel-map-pin')).toHaveLength(2);
    expect(el.dataset.ready).toBe('true');
  });

  it('folds touching pins into a count badge that zooms them apart and keeps keyboard focus', () => {
    document.body.innerHTML = '<div id="map"></div>';
    const el = document.getElementById('map')!;
    // At zoom 1 the mock projects 20px per degree: these two are ~11px apart, the third far away.
    const features = [overview(pinAt([10, 50], 'Alpha'), 1), overview(pinAt([10.5, 50.2], 'Beta'), 2), overview(pinAt([100, 0], 'Gamma'), 3)];
    initFullMap(el, { type: 'FeatureCollection', features }, { readStory: 'Read', clusterLabel: '{count} trips close together' });
    const map = state.maps[0]!;
    map.events.get('load')!();
    const pins = el.querySelectorAll<HTMLButtonElement>('.travel-map-pin:not(.travel-map-pin--cluster)');
    const cluster = el.querySelector<HTMLButtonElement>('.travel-map-pin--cluster')!;
    expect([cluster.getAttribute('aria-label'), cluster.textContent]).toEqual(['2 trips close together', '2']);
    expect([...pins].map((pin) => pin.hidden)).toEqual([true, true, false]);

    cluster.focus();
    cluster.click();
    expect(map.bounds).toMatchObject({ points: [[10, 50], [10.5, 50.2]] });
    expect(map.fitOptions).toMatchObject({ maxZoom: 12 });
    // The camera arrives (zoom 6: ~320px apart) and the next moveend splits the badge.
    map.zoom = 6;
    map.events.get('moveend')!();
    expect(el.querySelector('.travel-map-pin--cluster')).toBeNull();
    expect([...pins].map((pin) => pin.hidden)).toEqual([false, false, false]);
    expect(document.activeElement).toBe(pins[0]);
  });

  it('lists trips at one spot instead of zooming forever', () => {
    document.body.innerHTML = '<div id="map"></div>';
    const el = document.getElementById('map')!;
    const features = [overview(pinAt([10, 50], 'Alpha'), 1), overview(pinAt([10, 50], 'Beta'), 2)];
    initFullMap(el, { type: 'FeatureCollection', features }, { readStory: 'Read' });
    const map = state.maps[0]!;
    map.events.get('load')!();
    const boundsBefore = map.bounds;
    el.querySelector<HTMLButtonElement>('.travel-map-pin--cluster')!.click();
    expect(map.bounds).toBe(boundsBefore);
    expect([...el.querySelectorAll('.travel-map-popup--list a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['N°01 Alpha', '/alpha/'], ['N°02 Beta', '/beta/'],
    ]);
  });
});
