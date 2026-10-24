import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const script = await readFile(join(import.meta.dirname, '../public/gpx-map.js'), 'utf8');

function harness(webgl: 'ready' | 'unavailable' | 'partial' | 'throws' = 'ready') {
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
  const document = {
    head: { appendChild(el: { src?: string; onload?: () => void }) { if (el.src) windowState[el.src.includes('maplibre') ? 'maplibregl' : 'pmtiles'] = el.src.includes('maplibre') ? gl : pm; queueMicrotask(() => el.onload?.()); } },
    createElement: (tag: string) => tag === 'canvas'
      ? Object.assign(new Element(), { getContext: () => webgl === 'unavailable' ? null : { getExtension: () => ({ loseContext() {} }) } })
      : new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    querySelector: () => null,
  };
  const ResizeObserver = class { observe() {} disconnect() {} };
  new Function('window', 'document', 'location', 'ResizeObserver', script)(windowState, document, { href: 'http://localhost/admin/', origin: 'http://localhost' }, ResizeObserver);
  return { window: windowState, map, sources, container, status };
}

const copy = { loading: 'Loading', routeLabel: 'Route', kept: 'Kept', removed: 'Removed', waypoints: 'Waypoints', noGeometry: 'Empty', webglFallback: 'Fallback', basemapMissing: 'No basemap' };
const segment = (...points: { lng: number; lat: number }[]) => ({ points });
const featureSource = (value: unknown) => value as { data: { geometry: { type: string; coordinates: number[][][] } } };

describe('GPX preview map', () => {
  it('renders independent route runs and exact selected waypoint coordinates', async () => {
    const h = harness();
    const api = await (h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; resize(): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    const original = { version: 1 as const, segments: [segment({ lng: 1, lat: 2 }, { lng: 3, lat: 4 }, { lng: 5, lat: 6 }), segment({ lng: 40, lat: 50 }, { lng: 42, lat: 52 })] };
    const kept = { version: 1 as const, segments: [segment({ lng: 3, lat: 4 }, { lng: 5, lat: 6 })] };
    api.render({ geometry: original, kept, waypoints: [{ lng: 41, lat: 51 }], selectedWaypointIndices: [0] });
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
    api.render({ geometry: { version: 1, segments: [segment({ lng: -180, lat: -90 }, { lng: 180, lat: 90 })] }, kept: { version: 1, segments: [] }, waypoints: [{ lng: 0, lat: 90 }], selectedWaypointIndices: [0] });
    expect((h.container as unknown as { innerHTML: string }).innerHTML).toContain('<svg');
    expect((h.container as unknown as { innerHTML: string }).innerHTML).not.toMatch(/\b(?:NaN|Infinity)\b/);
    expect(h.status.textContent).toBe('Fallback');
    api.destroy();
    expect(h.container.innerHTML).toBe('');
  });

  it('shows unselected waypoints without requiring an attachable route', async () => {
    const h = harness('unavailable');
    const api = await (h.window.GpxMap as { create: (options: unknown) => Promise<{ render(data: unknown): void; destroy(): void }> }).create({ container: h.container, statusElement: h.status, copy });
    api.render({ geometry: { version: 1, segments: [] }, kept: { version: 1, segments: [] }, waypoints: [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }], selectedWaypointIndices: [1] });
    const svg = (h.container as unknown as { innerHTML: string }).innerHTML;
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg.match(/class="gpx-map__waypoint is-selected"/g)).toHaveLength(1);
    expect(svg).not.toContain('<polyline');
    api.destroy();
  });
});
