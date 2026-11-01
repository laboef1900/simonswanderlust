import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import { baseStyle } from './travel-map';
import { mapFrame } from '../../../uploader/public/map-frame.js';
import type { JourneyGeometry } from '../lib/journey-map';

export function initJourneyMap(container: HTMLElement, geometry: JourneyGeometry, pinLabel: string): void {
  const frame = mapFrame([
    ...geometry.tracks.features.map((feature) => feature.geometry.coordinates),
    ...geometry.pins.map((pin) => [pin.coordinates]),
  ]);
  const position = ([lng, lat]: [number, number]): [number, number] => [frame.longitude(lng), lat];
  const map = new MapLibreMap({ container, style: baseStyle(), attributionControl: {} });
  map.addControl(new NavigationControl({ showCompass: false }));
  let failed = false;
  let framed = false;
  map.on('error', () => {
    if (failed) return;
    failed = true;
    map.setStyle({ version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fbfbfd' } },
    ] });
  });
  // DOM links, not canvas-only circles: every numbered pin is keyboard reachable.
  for (const pin of geometry.pins) {
    const link = document.createElement('a');
    link.className = 'journey-map-pin';
    link.href = pin.href;
    link.textContent = String(pin.number);
    link.setAttribute('aria-label', pinLabel.replace('{number}', String(pin.number)).replace('{title}', pin.title));
    new Marker({ element: link }).setLngLat(position(pin.coordinates)).addTo(map);
  }
  map.on('style.load', () => {
    map.addSource('journey-runs', { type: 'geojson', data: {
      ...geometry.tracks,
      features: geometry.tracks.features.map((feature) => ({ ...feature,
        geometry: { ...feature.geometry, coordinates: feature.geometry.coordinates.map(position) },
      })),
    } });
    map.addLayer({ id: 'journey-runs', type: 'line', source: 'journey-runs',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#142a42', 'line-width': 3 },
    });
    if (!framed && frame.bounds) {
      map.fitBounds(frame.bounds, { padding: 48, maxZoom: 8, duration: 0 });
      framed = true;
    }
    container.dataset.ready = 'true';
  });
}
