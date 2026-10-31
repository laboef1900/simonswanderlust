// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type * as MapLibreModule from 'maplibre-gl';
import { initFullMap, initMiniMap } from './travel-map';

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));
vi.mock('maplibre-gl', async (importOriginal) => {
  const actual = await importOriginal<typeof MapLibreModule>();
  return {
    ...actual,
    setWorkerUrl: () => {},
    addProtocol: () => {},
    // WebGL is the boundary; use the real AttributionControl, including its
    // sanitizer and compact disclosure DOM, on the application's actual style.
    Map: class {
      constructor(options: { container: HTMLElement; style: StyleSpecification }) {
        const adapter = {
          style: { tileManagers: Object.fromEntries(Object.entries(options.style.sources).map(([id, source]) => [id, { used: true, getSource: () => source }])) },
          getCanvasContainer: () => options.container,
          _getUIString: () => 'Attribution',
          on: () => {}, off: () => {},
        };
        const control = new actual.AttributionControl({});
        options.container.append(control.onAdd(adapter as unknown as MapLibreMap));
      }
      getCanvas() { return document.createElement('canvas'); }
      on() {}
      addControl() {}
    },
  };
});

// The map probes WebGL2 before constructing MapLibre (#364); happy-dom has none.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ getExtension: () => null }) as unknown as WebGL2RenderingContext,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

for (const width of [360, 1024]) {
  describe(`real attribution control at ${width}px`, () => {
    for (const kind of ['full', 'mini'] as const) {
      it(`keeps actionable data-license links in the ${kind} map disclosure`, () => {
        const element = document.createElement('div');
        Object.defineProperty(element, 'offsetWidth', { value: width });
        document.body.append(element);
        if (kind === 'full') initFullMap(element, { type: 'FeatureCollection', features: [] }, { readStory: 'Read' });
        else initMiniMap(element, {
          pin: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { title: 'Story', href: '/story/', country: 'Country', region: 'europe' } },
          stops: [],
        });
        const disclosure = element.querySelector('details')!;
        const link = disclosure.querySelector<HTMLAnchorElement>('a[href="https://www.openstreetmap.org/copyright"]')!;
        expect(link).not.toBeNull();
        const worldcover = disclosure.querySelector<HTMLAnchorElement>('a[href="https://esa-worldcover.org/en/data-access"]')!;
        const cc = disclosure.querySelector<HTMLAnchorElement>('a[href="https://creativecommons.org/licenses/by/4.0/"]')!;
        expect(worldcover).not.toBeNull();
        expect(cc).not.toBeNull();
        expect(disclosure.classList.contains('maplibregl-attrib-empty')).toBe(false);
        expect(disclosure.hasAttribute('open')).toBe(true);
        if (width < 640) {
          const summary = disclosure.querySelector('summary')!;
          expect(summary.getAttribute('aria-label')).toBeTruthy();
          summary.click();
          summary.click();
          expect(disclosure.classList.contains('maplibregl-compact-show')).toBe(true);
        }
        for (const anchor of [link, worldcover, cc]) {
          anchor.focus();
          expect(document.activeElement).toBe(anchor);
          const activated: string[] = [];
          anchor.addEventListener('click', (event) => { event.preventDefault(); activated.push(anchor.href); });
          anchor.click();
          expect(activated).toEqual([anchor.href]);
        }
      });
    }
  });
}
