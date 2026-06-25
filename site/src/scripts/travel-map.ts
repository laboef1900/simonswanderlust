import {
  Map as MapLibreMap,
  Popup,
  NavigationControl,
  LngLatBounds,
  addProtocol,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedTheme } from 'protomaps-themes-base';
import type { PinCollection, TripGeometry } from '../lib/map-data';

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

export function initFullMap(
  container: HTMLElement,
  geojson: PinCollection,
  labels: { readStory: string },
): void {
  const map = new MapLibreMap({ container, style: baseStyle(), attributionControl: {} });
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
  const map = new MapLibreMap({
    container,
    style: baseStyle(),
    interactive: true,
    attributionControl: {},
  });

  map.on('load', () => {
    const feats = [geometry.pin, ...geometry.stops];
    map.addSource('trip', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: feats },
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

    if (feats.length === 1) {
      map.setCenter(geometry.pin.geometry.coordinates);
      map.setZoom(5);
    } else {
      const b = new LngLatBounds();
      for (const f of feats) b.extend(f.geometry.coordinates);
      map.fitBounds(b, { padding: 40, maxZoom: 8 });
    }

    container.dataset.ready = 'true';
  });
}
