import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
  LngLatBounds,
  addProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedTheme } from 'protomaps-themes-base';
import type { PinCollection, PinFeature, TripGeometry } from '../lib/map-data';
import { mapFrame } from '../../../uploader/public/map-frame.js';
import { mapLandcoverAttribution, mapLandcoverLicense } from '../i18n/ui';

// Vite must bundle the v6 worker's shared-module import, not copy it verbatim.
setWorkerUrl(workerUrl);

// @ai-note: pmtiles protocol is registered once globally; Astro islands may
// call initFullMap / initMiniMap on multiple pages, so guard against double-registration.
const PMTILES_URL = 'pmtiles:///map/basemap.pmtiles';
let protocolRegistered = false;

export function baseStyle(): StyleSpecification {
  if (!protocolRegistered) {
    addProtocol('pmtiles', new Protocol().tile);
    protocolRegistered = true;
  }
  // layers() needs a Theme object — use namedTheme('light') rather than the
  // string 'light' directly (the v4 API changed from layers(source, key) to
  // layers(source, theme)).
  const base = namedTheme('light');
  const theme = {
    ...base,
    background: '#f5f2eb',
    earth: '#f5f2eb',
    water: '#d4e2ec',
    boundaries: '#8c9ba8',
    country_label: '#142a42',
    state_label: '#3b5168',
    city_label: '#142a42',
    ocean_label: '#4a6b82',
    park_a: '#e4ebe0',
    park_b: '#dde6d8',
    wood_a: '#dfe8da',
    wood_b: '#d8e2d2',
    scrub_a: '#e9ece2',
    scrub_b: '#e4e8dc',
    sand: '#efe9d8',
    beach: '#f2ecdc',
    glacier: '#fbfbfd',
    ...(base.landcover ? {
      landcover: {
        ...base.landcover,
        barren: '#efe9d8',
        farmland: '#ecefe4',
        forest: '#dfe8da',
        glacier: '#fbfbfd',
        grassland: '#e7ece0',
        scrub: '#eaede2',
        urban_area: '#eae6df',
      },
    } : {}),
  };
  return {
    version: 8,
    glyphs: '/map/fonts/{fontstack}/{range}.pbf',
    sources: {
      // The source's required English credit is retained in both dictionaries.
      // 2020 is the Daylight source year, not the planet or app release year;
      // artifact/provenance evidence: docs/third-party-image-evidence.json.
      protomaps: { type: 'vector', url: PMTILES_URL, attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | ' +
        `<a href="https://esa-worldcover.org/en/data-access">${mapLandcoverAttribution}</a> ` +
        `(<a href="https://creativecommons.org/licenses/by/4.0/">${mapLandcoverLicense}</a>)`,
      },
    },
    layers: layers('protomaps', theme),
  } as StyleSpecification;
}

function createMap(container: HTMLElement, options?: { cooperativeGestures?: boolean }): MapLibreMap {
  // Like the editor's gpx-map: v6 returns a partial Map rather than throwing
  // when WebGL2 is unavailable. Probe before allocating that partial instance.
  const context = document.createElement('canvas').getContext('webgl2');
  if (!context) throw new Error('map_webgl_unavailable');
  context.getExtension('WEBGL_lose_context')?.loseContext();

  const map = new MapLibreMap({
    container,
    style: baseStyle(),
    attributionControl: {},
    ...(options?.cooperativeGestures ? { cooperativeGestures: true } : {}),
  });
  if (!map.getCanvas().getContext('webgl2')) {
    // A context can still fail after the probe. remove() itself throws on a
    // painter-less v6 Map; always discard its empty, keyboard-focusable canvas.
    try { map.remove(); } catch { /* Incomplete MapLibre initialization. */ }
    container.replaceChildren();
    container.classList.remove('maplibregl-map');
    throw new Error('map_webgl_unavailable');
  }
  return map;
}

export interface FullMapLabels {
  readStory: string;
  pinLabel?: string;
  closePopup?: string;
}

export function initFullMap(
  container: HTMLElement,
  geojson: PinCollection,
  labels: FullMapLabels,
): void {
  const map = createMap(container, { cooperativeGestures: true });
  map.addControl(new NavigationControl({ showCompass: false }));

  let basemapFailed = false;
  let markersMounted = false;
  let activeRegion = 'all';
  let userMoved = false;
  let activePopup: { remove?: () => void } | null = null;
  const markers: { element: HTMLButtonElement; feature: PinFeature; index: number }[] = [];
  const doc = container.ownerDocument ?? document;

  const fitRegionBounds = (region: string) => {
    const bounds = new LngLatBounds();
    for (const f of geojson.features) {
      if (region === 'all' || f.properties.region === region) {
        bounds.extend(f.geometry.coordinates);
      }
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 6 });
  };

  const openPinPopup = (index: number) => {
    const f = geojson.features[index];
    if (!f) return;
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;

    activePopup?.remove?.();
    map.setCenter?.([lng, lat]);
    for (const m of markers) {
      m.element.dataset.active = String(m.index === index);
    }
    for (const entry of doc.querySelectorAll<HTMLElement>('[data-map-entry]')) {
      entry.dataset.active = String(Number(entry.dataset.pinIndex) === index);
    }

    // Build popup content with DOM — never interpolate title/href into HTML (XSS-safe).
    const el = doc.createElement('div');
    el.className = 'travel-map-popup';
    if (p.country) {
      const meta = doc.createElement('p');
      meta.className = 'travel-map-popup__meta';
      meta.textContent = `${String(index + 1).padStart(2, '0')} · ${p.country}`;
      el.append(meta);
    }
    const strong = doc.createElement('strong');
    strong.className = 'travel-map-popup__title';
    strong.textContent = p.title;
    const a = doc.createElement('a');
    a.className = 'travel-map-popup__cta';
    a.href = p.href;
    a.textContent = `${labels.readStory} →`;
    el.append(strong, a);

    activePopup = new Popup({ offset: 14 }).setLngLat([lng, lat]).setDOMContent(el).addTo(map) as { remove?: () => void };
    if (labels.closePopup) {
      const closeBtn = container.querySelector<HTMLButtonElement>('.maplibregl-popup-close-button');
      if (closeBtn) closeBtn.setAttribute('aria-label', labels.closePopup);
    }
  };

  const applyRegionFilter = (region: string) => {
    activeRegion = region;
    userMoved = false;
    activePopup?.remove?.();
    for (const btn of doc.querySelectorAll<HTMLButtonElement>('[data-map-region]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mapRegion === region));
    }
    for (const m of markers) {
      m.element.hidden = region !== 'all' && m.feature.properties.region !== region;
      m.element.dataset.active = 'false';
    }
    for (const group of doc.querySelectorAll<HTMLElement>('[data-region-group]')) {
      group.hidden = region !== 'all' && group.dataset.regionGroup !== region;
    }
    for (const entry of doc.querySelectorAll<HTMLElement>('[data-map-entry]')) {
      entry.dataset.active = 'false';
    }
    fitRegionBounds(region);
  };

  const mountDomMarkersAndControls = () => {
    const labelTemplate = labels.pinLabel ?? 'Trip {number}: {title} ({country})';
    geojson.features.forEach((f, index) => {
      const num = String(index + 1);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'travel-map-pin';
      button.dataset.pinIndex = String(index);
      button.dataset.region = f.properties.region;
      button.setAttribute(
        'aria-label',
        labelTemplate
          .replace('{number}', num)
          .replace('{title}', f.properties.title)
          .replace('{country}', f.properties.country),
      );
      const badge = doc.createElement('span');
      badge.className = 'travel-map-pin__badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = num.padStart(2, '0');
      button.append(badge);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openPinPopup(index);
      });
      new Marker({ element: button }).setLngLat(f.geometry.coordinates).addTo(map);
      markers.push({ element: button, feature: f, index });
    });

    for (const focusBtn of doc.querySelectorAll<HTMLButtonElement>('[data-map-focus]')) {
      focusBtn.addEventListener('click', () => {
        const idx = Number(focusBtn.dataset.mapFocus);
        const f = geojson.features[idx];
        if (!f) return;
        map.setCenter?.(f.geometry.coordinates);
        openPinPopup(idx);
        container.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      });
    }

    for (const entry of doc.querySelectorAll<HTMLElement>('[data-map-entry]')) {
      const idx = Number(entry.dataset.pinIndex);
      entry.addEventListener('mouseenter', () => {
        if (markers[idx]) markers[idx].element.dataset.hover = 'true';
      });
      entry.addEventListener('mouseleave', () => {
        if (markers[idx]) markers[idx].element.dataset.hover = 'false';
      });
    }

    for (const regionBtn of doc.querySelectorAll<HTMLButtonElement>('[data-map-region]')) {
      regionBtn.addEventListener('click', () => {
        applyRegionFilter(regionBtn.dataset.mapRegion ?? 'all');
      });
    }

    for (const resetBtn of doc.querySelectorAll<HTMLButtonElement>('[data-map-reset]')) {
      resetBtn.addEventListener('click', () => {
        applyRegionFilter('all');
      });
    }
  };

  const mountPins = () => {
    map.addSource('pins', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'pins',
      type: 'circle',
      source: 'pins',
      paint: {
        'circle-radius': 7,
        'circle-color': '#d23b30',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    map.on('click', 'pins', (e) => {
      const f = e.features?.[0];
      if (!f || !f.properties) return;
      const href = typeof f.properties.href === 'string' ? f.properties.href : '';
      const idx = geojson.features.findIndex((item) => item.properties.href === href);
      if (idx !== -1) openPinPopup(idx);
    });

    map.on('mouseenter', 'pins', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'pins', () => {
      map.getCanvas().style.cursor = '';
    });

    if (!markersMounted) {
      markersMounted = true;
      mountDomMarkersAndControls();
    }

    fitRegionBounds(activeRegion);
    container.dataset.ready = 'true';
  };

  map.on('error', () => {
    if (basemapFailed) return;
    basemapFailed = true;
    map.setStyle({
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#fbfbfd' } }],
    });
  });
  map.on('style.load', () => {
    if (basemapFailed) mountPins();
  });
  map.on('dragstart', () => {
    userMoved = true;
  });
  map.on('resize', () => {
    if (!userMoved) fitRegionBounds(activeRegion);
  });
  map.on('load', mountPins);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * `routeAttribution` is the active locale's `map.routeAttribution`. It rides on
 * the stop-route source itself, so it stays visible when the basemap falls back
 * to the source-less style (#513: OSM attribution wherever a routed line shows).
 */
export function initMiniMap(container: HTMLElement, geometry: TripGeometry, routeAttribution = ''): void {
  const feats = [geometry.pin, ...geometry.stops];
  const frame = mapFrame([
    ...(geometry.track?.coordinates ?? []),
    ...(geometry.stopRoute?.runs.map((run) => run.coordinates) ?? []),
    ...feats.map((feature) => [feature.geometry.coordinates]),
  ]);
  const position = ([lng, lat]: [number, number]): [number, number] => [frame.longitude(lng), lat];
  const map = createMap(container);

  let framed = false;
  let basemapFailed = false;
  map.on('error', () => {
    if (basemapFailed) return;
    basemapFailed = true;
    // The local archive is optional. Keep the public-only overlay and the
    // existing textual route description; never fall back to external tiles.
    map.setStyle({ version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fbfbfd' } },
    ] });
  });
  map.on('style.load', () => {
    if (geometry.track) {
      map.addSource('track', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: {
          type: geometry.track.type, coordinates: geometry.track.coordinates.map((run) => run.map(position)),
        } },
      });
      // A separate MultiLineString preserves gaps; added before all story circles.
      map.addLayer({
        id: 'track',
        type: 'line',
        source: 'track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#142a42', 'line-width': 3 },
      });
    }
    const stopRoute = geometry.stopRoute;
    if (stopRoute) {
      const kinds = ['road', 'straight'] as const;
      map.addSource('stop-route', {
        type: 'geojson',
        attribution: `<a href="https://www.openstreetmap.org/copyright">${escapeHtml(routeAttribution)}</a>`,
        data: { type: 'FeatureCollection', features: kinds.map((kind) => ({
          type: 'Feature', properties: { kind }, geometry: {
            type: 'MultiLineString',
            coordinates: stopRoute.runs.filter((run) => run.kind === kind).map((run) => run.coordinates.map(position)),
          },
        })) },
      });
      // Road legs share the GPX line style; straight fallbacks (sea, no road) are dashed.
      for (const kind of kinds) {
        map.addLayer({
          id: `stop-route-${kind}`,
          type: 'line',
          source: 'stop-route',
          filter: ['==', ['get', 'kind'], kind],
          layout: { 'line-cap': kind === 'road' ? 'round' : 'butt', 'line-join': 'round' },
          paint: { 'line-color': '#142a42', 'line-width': 3, ...(kind === 'straight' ? { 'line-dasharray': [2, 2] } : {}) },
        });
      }
    }
    map.addSource('trip', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: feats.map((feature) => ({
        ...feature, geometry: { ...feature.geometry, coordinates: position(feature.geometry.coordinates) },
      })) },
    });
    map.addLayer({
      id: 'trip',
      type: 'circle',
      source: 'trip',
      paint: {
        'circle-radius': 6,
        'circle-color': '#d23b30',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    if (!framed) {
      if (feats.length === 1 && !geometry.track && !geometry.stopRoute) {
        map.setCenter(geometry.pin.geometry.coordinates);
        map.setZoom(5);
      } else if (frame.bounds) {
        // No initial fly-in: a tile-failure style swap must not interrupt the fit.
        map.fitBounds(frame.bounds, { padding: 40, maxZoom: 8, duration: 0 });
      }
      framed = true;
    }

    container.dataset.ready = 'true';
  });
}
