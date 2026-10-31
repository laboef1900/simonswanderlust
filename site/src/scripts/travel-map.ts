import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  Map as MapLibreMap,
  Popup,
  NavigationControl,
  LngLatBounds,
  addProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedTheme } from 'protomaps-themes-base';
import type { PinCollection, TripGeometry } from '../lib/map-data';
import { mapFrame } from '../../../uploader/public/map-frame.js';

// Vite must bundle the v6 worker's shared-module import, not copy it verbatim.
setWorkerUrl(workerUrl);

// @ai-note: pmtiles protocol is registered once globally; Astro islands may
// call initFullMap / initMiniMap on multiple pages, so guard against double-registration.
const PMTILES_URL = 'pmtiles:///map/basemap.pmtiles';
let protocolRegistered = false;

function baseStyle(): StyleSpecification {
  if (!protocolRegistered) {
    addProtocol('pmtiles', new Protocol().tile);
    protocolRegistered = true;
  }
  // layers() needs a Theme object — use namedTheme('light') rather than the
  // string 'light' directly (the v4 API changed from layers(source, key) to
  // layers(source, theme)).
  return {
    version: 8,
    glyphs: '/map/fonts/{fontstack}/{range}.pbf',
    sources: {
      protomaps: { type: 'vector', url: PMTILES_URL, attribution: '© OpenStreetMap' },
    },
    layers: layers('protomaps', namedTheme('light')),
  } as StyleSpecification;
}

function createMap(container: HTMLElement): MapLibreMap {
  // Like the editor's gpx-map: v6 returns a partial Map rather than throwing
  // when WebGL2 is unavailable. Probe before allocating that partial instance.
  const context = document.createElement('canvas').getContext('webgl2');
  if (!context) throw new Error('map_webgl_unavailable');
  context.getExtension('WEBGL_lose_context')?.loseContext();

  const map = new MapLibreMap({ container, style: baseStyle(), attributionControl: {} });
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

export function initFullMap(
  container: HTMLElement,
  geojson: PinCollection,
  labels: { readStory: string },
): void {
  const map = createMap(container);
  map.addControl(new NavigationControl({ showCompass: false }));

  map.on('load', () => {
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
      if (!f) return;
      const p = f.properties as { title: string; href: string };
      const coords = (f.geometry as { type: 'Point'; coordinates: [number, number] }).coordinates;
      const [lng, lat] = coords;

      // Build popup content with DOM — never interpolate title/href into HTML (XSS-safe).
      const el = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = p.title;
      const br = document.createElement('br');
      const a = document.createElement('a');
      a.href = p.href;
      a.textContent = labels.readStory;
      el.append(strong, br, a);

      new Popup().setLngLat([lng, lat]).setDOMContent(el).addTo(map);
    });

    map.on('mouseenter', 'pins', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'pins', () => {
      map.getCanvas().style.cursor = '';
    });

    const bounds = new LngLatBounds();
    for (const f of geojson.features) {
      bounds.extend(f.geometry.coordinates);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 6 });

    container.dataset.ready = 'true';
  });
}

export function initMiniMap(container: HTMLElement, geometry: TripGeometry): void {
  const feats = [geometry.pin, ...geometry.stops];
  const frame = mapFrame([
    ...(geometry.track?.coordinates ?? []),
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
      if (feats.length === 1 && !geometry.track) {
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
