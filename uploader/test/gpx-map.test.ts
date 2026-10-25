import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const script = await readFile(join(import.meta.dirname, '../public/gpx-map.js'), 'utf8');

function harness(webgl: 'ready' | 'unavailable' | 'partial' | 'throws' = 'ready', deferLoads = false) {
  const sources: Record<string, unknown> = {};
  const layers: Record<string, unknown> = {};
  const map = {
    on: vi.fn(), once: vi.fn((_name: string, fn: () => void) => fn()),
    isStyleLoaded: () => true, isSourceLoaded: () => true,
    getCanvas: () => ({ getContext: () => webgl === 'partial' ? null : {} }),
    addSource: (id: string, source: unknown) => { sources[id] = source; },
    addLayer: (layer: { id: string }) => { layers[layer.id] = layer; },
    getSource: (id: string) => sources[id], getLayer: (id: string) => layers[id],
    removeSource: (id: string) => { delete sources[id]; }, removeLayer: (id: string) => { delete layers[id]; },
    fitBounds: vi.fn(), resize: vi.fn(), remove: vi.fn(() => { if (webgl === 'partial') throw new Error('renderer unavailable'); }), addControl: vi.fn(), setStyle: vi.fn(),
  };
  class Element {
    className = ''; dataset: Record<string, string> = {}; children: Element[] = []; parentNode: Element | null = null;
    textContent = ''; innerHTML = ''; attrs: Record<string, string> = {};
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child: Element, _ref: Element | null) { return this.appendChild(child); }
    replaceChildren() { this.children = []; this.innerHTML = ''; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); }
  }
  const container = new Element() as unknown as HTMLElement;
  Object.assign(container, { clientWidth: 600 });
  const parent = new Element();
  parent.appendChild(container as unknown as Element);
  const status = new Element() as unknown as HTMLElement;
  const windowState: Record<string, unknown> = { setTimeout };
  const gl = { Map: class { constructor() { if (webgl === 'throws') throw new Error('WebGL2 unavailable'); Object.assign(this, map); } }, NavigationControl: class {}, addProtocol: vi.fn() };
  const pm = { Protocol: class { tile = () => {}; } };
  const loads: (() => void)[] = [];
  const document = {
    head: { appendChild(el: { src?: string; onload?: () => void }) {
      if (el.src) windowState[el.src.includes('maplibre') ? 'maplibregl' : 'pmtiles'] = el.src.includes('maplibre') ? gl : pm;
      const loaded = () => el.onload?.();
      if (deferLoads) loads.push(loaded); else queueMicrotask(loaded);
    } },
    createElement: (tag: string) => tag === 'canvas'
      ? Object.assign(new Element(), { getContext: () => webgl === 'unavailable' ? null : { getExtension: () => ({ loseContext() {} }) } })
      : new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    querySelector: () => null,
  };
  const ResizeObserver = class { observe() {} disconnect() {} };
  new Function('window', 'document', 'location', 'ResizeObserver', script)(windowState, document, { href: 'http://localhost/admin/', origin: 'http://localhost' }, ResizeObserver);
  return { window: windowState, map, sources, container, status, finishLoads: () => loads.splice(0).forEach((loaded) => loaded()) };
}

const copy = { loading: 'Loading', routeLabel: 'Route', kept: 'Kept', removed: 'Removed', waypoints: 'Waypoints', noGeometry: 'Empty', webglFallback: 'Fallback', basemapMissing: 'No basemap' };
const segment = (...points: { lng: number; lat: number }[]) => ({ points });
const featureSource = (value: unknown) => value as { data: { geometry: { type: string; coordinates: number[][][] } } };

describe('GPX preview map', () => {
  it('cancels an initializing preview without letting its stale teardown erase the replacement route', async () => {
    const h = harness('unavailable', true);
    const maps = h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; destroy(): void }> };
    const controller = new AbortController();
    const oldPending = maps.create({ container: h.container, statusElement: h.status, copy, signal: controller.signal });
    controller.abort();
    const nextPending = maps.create({ container: h.container, statusElement: h.status, copy });
    h.finishLoads();
    const [old, next] = await Promise.all([oldPending, nextPending]);
    next.render({ geometry: { version: 1, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 })] }, rawKept: { version: 1, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 })] }, selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] } });
    old.destroy();
    expect(h.container.innerHTML).toContain('<polyline');
    expect(h.container.parentNode?.children).toHaveLength(2);
    next.destroy();
    expect(h.container.innerHTML).toBe('');
  });

  it('keeps the route in the initial viewport while its public candidate is pending', async () => {
    const h = harness();
    const api = await (h.window.GpxMap as { create(options: unknown): Promise<{ render(data: unknown): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    const geometry = { version: 1, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 })] };
    const pending = { geometry, rawKept: geometry, selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, track: null, waypoints: [{ lng: 40, lat: 50 }] };
    api.render(pending);
    expect(h.map.fitBounds).toHaveBeenCalledWith([[1, 2], [40, 50]], expect.objectContaining({ duration: 0 }));
    expect(h.sources['gpx-kept']).toBeUndefined();
    api.render({ ...pending, track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] } });
    expect(h.map.fitBounds).toHaveBeenCalledOnce();
    expect(featureSource(h.sources['gpx-kept']).data.geometry.coordinates).toEqual([[[1, 2], [3, 4]]]);
    api.destroy();
  });

  it.each([false, true])('preserves map availability while an untrimmed candidate refreshes (missing basemap: %s)', async (missingBasemap) => {
    const h = harness();
    const api = await (h.window.GpxMap as { create(options: unknown): Promise<{ render(data: unknown): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    const fire = (name: string) => (h.map.on.mock.calls.find((call) => call[0] === name)![1] as () => void)();
    fire('load');
    if (missingBasemap) { fire('error'); fire('style.load'); }
    const availability = h.status.textContent;
    const geometry = { version: 1, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 })] };
    const pending = { geometry, rawKept: geometry, selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, track: null, waypoints: [] };
    api.render(pending);
    expect(h.status.textContent).toBe(availability);
    expect(h.sources['gpx-kept']).toBeUndefined();
    api.render({ ...pending, track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] } });
    expect(featureSource(h.sources['gpx-kept']).data.geometry.coordinates).toEqual([[[1, 2], [3, 4]]]);
    expect(h.status.textContent).toBe(availability);
    api.destroy();
  });

  it('renders independent route runs and exact selected waypoint coordinates', async () => {
    const h = harness();
    const api = await (h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; resize(): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    const original = { version: 1 as const, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 }, { lng: 5, lat: 6 }), segment({ lng: 40, lat: 50 }, { lng: 42, lat: 52 })] };
    const kept = { version: 1 as const, segments: [segment({ lng: 3, lat: 4 }, { lng: 5, lat: 6 })] };
    api.render({ geometry: original, rawKept: kept, selection: { startPoints: 1, endPoints: 0, removedSegments: [1] }, track: { version: 1, type: 'MultiLineString', coordinates: [[[3, 4], [5, 6]]] }, waypoints: [{ lng: 41, lat: 51 }], selectedWaypointIndices: [0] });
    const removedData = featureSource(h.sources['gpx-removed']).data;
    expect(removedData.geometry.type).toBe('MultiLineString');
    expect(removedData.geometry.coordinates).toEqual([[[1, 2], [3, 4]], [[40, 50], [42, 52]]]);
    expect(featureSource(h.sources['gpx-kept']).data.geometry.coordinates).toEqual([[[3, 4], [5, 6]]]);
    expect((featureSource(h.sources['gpx-waypoints']).data as unknown as { features: { geometry: { coordinates: number[] } }[] }).features[0]!.geometry.coordinates).toEqual([41, 51]);
    api.resize(); api.destroy();
    expect(h.map.remove).toHaveBeenCalledOnce();
    expect((h.container as unknown as { children: unknown[] }).children).toHaveLength(0);
  });

  it.each(['unavailable', 'partial', 'throws'] as const)('draws and cleans up a local SVG for %s WebGL initialization, including polar coordinates', async (mode) => {
    const h = harness(mode);
    const api = await (h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    api.render({ geometry: { version: 1, segments: [segment({ lng: -180, lat: -90 }, { lng: 180, lat: 90 })] }, rawKept: { version: 1, segments: [] }, selection: { startPoints: 0, endPoints: 0, removedSegments: [0] }, track: null, waypoints: [{ lng: 0, lat: 90 }], selectedWaypointIndices: [0] });
    expect((h.container as unknown as { innerHTML: string }).innerHTML).toContain('<svg');
    expect((h.container as unknown as { innerHTML: string }).innerHTML).not.toMatch(/\b(?:NaN|Infinity)\b/);
    expect(h.status.textContent).toBe('Fallback');
    api.destroy();
    expect(h.container.innerHTML).toBe('');
  });

  it('shows unselected waypoints without requiring an attachable route', async () => {
    const h = harness('unavailable');
    const api = await (h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    api.render({ geometry: { version: 1, segments: [] }, rawKept: { version: 1, segments: [] }, selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, track: null, waypoints: [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }], selectedWaypointIndices: [1] });
    const svg = (h.container as unknown as { innerHTML: string }).innerHTML;
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg.match(/class="gpx-map__waypoint is-selected"/g)).toHaveLength(1);
    expect(svg).not.toContain('<polyline');
    api.destroy();
  });
  it('draws only rounded public vertices as solid and only explicitly removed original edges as dashed', async () => {
    const h = harness();
    const maps = h.window.GpxMap as { create(options: unknown): Promise<{ render(data: unknown): void; destroy(): void }> };
    const api = await maps.create({ container: h.container, statusElement: h.status, copy });
    const run = segment({ lng: 1.0000123, lat: 2.0000123 }, { lng: 1.1000123, lat: 2.1000123 }, { lng: 1.2000123, lat: 2.2000123 });
    const rawKept = { version: 1, segments: [run] };
    const data = {
      geometry: { version: 1, segments: [run, structuredClone(run)] }, rawKept,
      selection: { startPoints: 0, endPoints: 0, removedSegments: [1] },
      track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [1.2, 2.2]]] },
    };
    api.render(data);
    expect(featureSource(h.sources['gpx-kept']).data.geometry.coordinates).toEqual(data.track.coordinates);
    expect(featureSource(h.sources['gpx-removed']).data.geometry.coordinates).toEqual([
      run.points.map(({ lng, lat }) => [lng, lat]),
    ]);
    expect(h.map.fitBounds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 0 }));
    api.render({ ...data, track: null, geometry: rawKept, selection: { startPoints: 0, endPoints: 0, removedSegments: [] } });
    expect(h.sources['gpx-kept']).toBeUndefined();
    expect(h.sources['gpx-removed']).toBeUndefined();
    api.destroy();
  });

  it('keeps the rounded solid and removed dashed paths distinct in the no-WebGL fallback', async () => {
    const h = harness('unavailable');
    const maps = h.window.GpxMap as { create(options: unknown): Promise<{ render(data: unknown): void; destroy(): void }> };
    const api = await maps.create({ container: h.container, statusElement: h.status, copy });
    const original = { version: 1, segments: [segment({ lng: 1, lat: 2 }, { lng: 3.000012, lat: 4.000012 }, { lng: 5.000012, lat: 6.000012 })] };
    api.render({
      geometry: original, rawKept: { version: 1, segments: [segment(...original.segments[0]!.points.slice(1))] },
      selection: { startPoints: 1, endPoints: 0, removedSegments: [] },
      track: { version: 1, type: 'MultiLineString', coordinates: [[[3, 4], [5, 6]]] },
    });
    expect(h.container.innerHTML.match(/class="gpx-map__line is-kept"/g)).toHaveLength(1);
    expect(h.container.innerHTML.match(/class="gpx-map__line is-removed"/g)).toHaveLength(1);
    api.destroy();
  });
});
