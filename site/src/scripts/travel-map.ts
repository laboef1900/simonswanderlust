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
import type { OverviewPinFeature, PinCollection, TripGeometry } from '../lib/map-data';
import { mapFrame } from '../../../uploader/public/map-frame.js';
import { mapLandcoverAttribution, mapLandcoverLicense } from '../i18n/ui';
import { clusterPoints, graticule, type Graticule } from './map-overlays';

// Vite must bundle the v6 worker's shared-module import, not copy it verbatim.
setWorkerUrl(workerUrl);

// @ai-note: pmtiles protocol is registered once globally; Astro islands may
// call initFullMap / initMiniMap on multiple pages, so guard against double-registration.
const PMTILES_URL = 'pmtiles:///map/basemap.pmtiles';
let protocolRegistered = false;

/**
 * Label layers a trip overview has no use for: shop/POI icons (the style ships
 * no sprite), house numbers and road names. Countries, regions, towns, seas
 * and lakes stay.
 */
const DROPPED_LABELS: Record<string, true> = { pois: true, address_label: true, roads_labels_minor: true, roads_labels_major: true };

/** `lang` picks the place-name language; protomaps emits NO label layers without it. */
export function baseStyle(lang: string = (typeof document === 'undefined' ? '' : document.documentElement.lang) || 'en'): StyleSpecification {
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
    state_label_halo: '#f5f2eb',
    city_label: '#142a42',
    city_label_halo: '#f5f2eb',
    subplace_label: '#3b5168',
    subplace_label_halo: '#f5f2eb',
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
    layers: layers('protomaps', theme, { lang }).filter((layer) => !DROPPED_LABELS[layer.id]),
  } as StyleSpecification;
}

/**
 * `overview` is the travel map page: its pins are DOM markers placed once, so
 * world copies are off (a second, pin-less world would show beside them), and
 * rotation is off so the graticule stays a north-up chart.
 */
function createMap(container: HTMLElement, overview = false): MapLibreMap {
  // Like the editor's gpx-map: v6 returns a partial Map rather than throwing
  // when WebGL2 is unavailable. Probe before allocating that partial instance.
  const context = document.createElement('canvas').getContext('webgl2');
  if (!context) throw new Error('map_webgl_unavailable');
  context.getExtension('WEBGL_lose_context')?.loseContext();

  const map = new MapLibreMap({
    container,
    style: baseStyle(),
    attributionControl: {},
    ...(overview ? { cooperativeGestures: true, renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0 } : {}),
  });
  if (!map.getCanvas().getContext('webgl2')) {
    // A context can still fail after the probe. remove() itself throws on a
    // painter-less v6 Map; always discard its empty, keyboard-focusable canvas.
    try { map.remove(); } catch { /* Incomplete MapLibre initialization. */ }
    container.replaceChildren();
    container.classList.remove('maplibregl-map');
    throw new Error('map_webgl_unavailable');
  }
  if (overview) {
    map.touchZoomRotate?.disableRotation();
    map.keyboard?.disableRotation();
  }
  return map;
}

export interface FullMapLabels {
  readStory: string;
  pinLabel?: string;
  closePopup?: string;
  clusterLabel?: string;
}

/** Badge diameter (26px) plus a 4px gap: closer than this, two badges touch. */
const CLUSTER_RADIUS = 30;
/** Zoom a "locate" from the list lands on at least: countries apart, cities legible. */
const LOCATE_ZOOM = 5;
/** Clusters that cannot be separated by zooming list their trips instead. */
const MAX_CLUSTER_ZOOM = 12;
const ENTRY = (n: number) => String(n).padStart(2, '0');
const SVG_NS = 'http://www.w3.org/2000/svg';

interface PinMarker { element: HTMLButtonElement; feature: OverviewPinFeature; index: number; inRegion: boolean }
interface OpenPopup { popup: Popup; opener: HTMLElement | null }

export function initFullMap(
  container: HTMLElement,
  geojson: PinCollection,
  labels: FullMapLabels,
): void {
  const map = createMap(container, true);
  map.addControl(new NavigationControl({ showCompass: false }));

  const doc = container.ownerDocument ?? document;
  const reduceMotion = () => doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let basemapFailed = false;
  let mounted = false;
  let activeRegion = 'all';
  let userMoved = false;
  let current: OpenPopup | null = null;
  let activeIndex: number | null = null;
  let focusAfterRecluster: number[] | null = null;
  let clusterMarkers: Marker[] = [];
  let ticks: Graticule | null = null;
  const markers: PinMarker[] = [];

  // Degree labels are DOM (IBM Plex Mono, like the homepage chart); the map's
  // glyph server only carries Noto Sans.
  const labelLayer = doc.createElement('div');
  labelLayer.className = 'travel-map-graticule';
  labelLayer.setAttribute('aria-hidden', 'true');

  const fitRegionBounds = (region: string) => {
    const bounds = new LngLatBounds();
    for (const f of geojson.features) {
      if (region === 'all' || f.properties.region === region) bounds.extend(f.geometry.coordinates);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 56, maxZoom: 6, ...(reduceMotion() ? { duration: 0 } : {}) });
  };

  const setActive = (index: number | null) => {
    activeIndex = index;
    for (const m of markers) m.element.dataset.active = String(m.index === index);
    for (const entry of doc.querySelectorAll<HTMLElement>('[data-map-entry]')) {
      entry.dataset.active = String(index !== null && Number(entry.dataset.pinIndex) === index);
    }
  };

  const arrow = () => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'travel-map-popup__arrow');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 8h10M9 4l4 4-4 4');
    svg.append(path);
    return svg;
  };

  // Built with DOM APIs only — never interpolate title/href/src into HTML (XSS-safe).
  const pinPopupContent = (f: OverviewPinFeature) => {
    const p = f.properties;
    const el = doc.createElement('div');
    el.className = 'travel-map-popup';
    const img = doc.createElement('img');
    img.className = 'travel-map-popup__photo';
    img.src = p.photo.src;
    img.width = p.photo.width;
    img.height = p.photo.height;
    img.alt = p.photo.alt;
    img.decoding = 'async';
    if (p.photo.position) img.style.objectPosition = p.photo.position;
    const body = doc.createElement('div');
    body.className = 'travel-map-popup__body';
    const meta = doc.createElement('p');
    meta.className = 'travel-map-popup__meta';
    meta.textContent = `N°${ENTRY(p.number)} · ${p.country}`;
    const title = doc.createElement('strong');
    title.className = 'travel-map-popup__title';
    title.textContent = p.title;
    const a = doc.createElement('a');
    a.className = 'travel-map-popup__cta';
    a.href = p.href;
    a.append(doc.createTextNode(labels.readStory), arrow());
    body.append(meta, title, a);
    el.append(img, body);
    return el;
  };

  const clusterPopupContent = (members: PinMarker[]) => {
    const list = doc.createElement('ul');
    list.className = 'travel-map-popup travel-map-popup--list';
    for (const m of members) {
      const li = doc.createElement('li');
      const a = doc.createElement('a');
      a.className = 'travel-map-popup__cta';
      a.href = m.feature.properties.href;
      a.textContent = `N°${ENTRY(m.feature.properties.number)} ${m.feature.properties.title}`;
      li.append(a);
      list.append(li);
    }
    return list;
  };

  const dismissPopup = (restoreFocus: boolean) => {
    const open = current;
    if (!open) return;
    current = null;
    open.popup.remove();
    setActive(null);
    if (restoreFocus) open.opener?.focus();
  };

  const showPopup = (at: [number, number], content: HTMLElement, opener: HTMLElement | null) => {
    dismissPopup(false);
    const popup = new Popup({ offset: 16, maxWidth: 'none' }).setLngLat(at).setDOMContent(content).addTo(map);
    current = { popup, opener };
    // The close button removes itself from the DOM; hand focus back to the pin
    // or list button that opened the popup instead of dropping it on <body>.
    popup.on?.('close', () => {
      if (current?.popup !== popup) return;
      current = null;
      setActive(null);
      const focused = doc.activeElement;
      if (!focused || focused === doc.body) opener?.focus();
      recluster();
    });
    if (labels.closePopup) {
      container.querySelector('.maplibregl-popup-close-button')?.setAttribute('aria-label', labels.closePopup);
    }
  };

  const openPinPopup = (index: number, opener: HTMLElement | null) => {
    const f = geojson.features[index];
    if (!f) return;
    dismissPopup(false);
    setActive(index);
    recluster();
    showPopup(f.geometry.coordinates, pinPopupContent(f), opener);
  };

  const zoomIntoCluster = (members: PinMarker[], opener: HTMLElement) => {
    const bounds = new LngLatBounds();
    for (const m of members) bounds.extend(m.feature.geometry.coordinates);
    const coords = members.map((m) => m.feature.geometry.coordinates);
    const lngs = coords.map(([lng]) => lng);
    const lats = coords.map(([, lat]) => lat);
    const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
    userMoved = true;
    if (span < 1e-4 || map.getZoom() >= MAX_CLUSTER_ZOOM - 0.5) {
      // Same place, or as close as the map goes: list them rather than zoom forever.
      const [lng, lat] = coords[0]!;
      showPopup([lng, lat], clusterPopupContent(members), opener);
      return;
    }
    focusAfterRecluster = members.map((m) => m.index);
    map.fitBounds(bounds, { padding: 72, maxZoom: MAX_CLUSTER_ZOOM, ...(reduceMotion() ? { duration: 0 } : {}) });
  };

  /** Hide pins whose badges would touch and stand one count badge in for each group. */
  const recluster = () => {
    for (const marker of clusterMarkers) marker.remove();
    clusterMarkers = [];
    for (const m of markers) m.element.hidden = !m.inRegion;
    const candidates = markers.filter((m) => m.inRegion && m.index !== activeIndex);
    const groups = clusterPoints(candidates.map((m) => {
      const point = map.project(m.feature.geometry.coordinates);
      return { id: m.index, x: point.x, y: point.y };
    }), CLUSTER_RADIUS);
    const template = labels.clusterLabel ?? '{count} trips close together: zoom in to separate them';
    for (const group of groups) {
      if (group.length < 2) continue;
      const members = group.map((point) => markers[point.id]!);
      for (const m of members) m.element.hidden = true;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'travel-map-pin travel-map-pin--cluster';
      button.setAttribute('aria-label', template.replace('{count}', String(members.length)));
      const badge = doc.createElement('span');
      badge.className = 'travel-map-pin__badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = String(members.length);
      button.append(badge);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        zoomIntoCluster(members, button);
      });
      const lng = members.reduce((sum, m) => sum + m.feature.geometry.coordinates[0], 0) / members.length;
      const lat = members.reduce((sum, m) => sum + m.feature.geometry.coordinates[1], 0) / members.length;
      clusterMarkers.push(new Marker({ element: button }).setLngLat([lng, lat]).addTo(map));
    }
    // A keyboard user who zoomed into a cluster keeps their place: focus the
    // first member that is now its own pin, or the cluster still holding it.
    if (focusAfterRecluster) {
      const wanted = focusAfterRecluster;
      focusAfterRecluster = null;
      const pin = wanted.map((index) => markers[index]!).find((m) => !m.element.hidden);
      (pin?.element ?? clusterMarkers[0]?.getElement())?.focus();
    }
  };

  const positionLabels = () => {
    if (!ticks) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    // The attribution wraps to four lines on a phone; keep parallels clear of it.
    const bottomControls = container.querySelector('.maplibregl-ctrl-bottom-right')?.getBoundingClientRect().height ?? 0;
    const center = map.getCenter();
    labelLayer.querySelectorAll<HTMLElement>('[data-axis]').forEach((label) => {
      const value = Number(label.dataset.value);
      if (label.dataset.axis === 'meridian') {
        const x = map.project([value, center.lat]).x;
        // Keep clear of the zoom control (top right) and the frame edges.
        label.hidden = x < 24 || x > width - 72;
        label.style.transform = `translate(${Math.round(x)}px, 0) translateX(-50%)`;
      } else {
        const y = map.project([center.lng, value]).y;
        label.hidden = y < 28 || y > height - Math.max(40, bottomControls + 12);
        label.style.transform = `translate(0, ${Math.round(y)}px) translateY(-50%)`;
      }
    });
  };

  const updateGraticule = () => {
    const bounds = map.getBounds();
    ticks = graticule({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() });
    const source = map.getSource('graticule');
    if (source && 'setData' in source && typeof source.setData === 'function') source.setData(ticks.lines);
    labelLayer.replaceChildren(
      ...ticks.meridians.map((tick) => axisLabel('meridian', tick.value, tick.label)),
      ...ticks.parallels.map((tick) => axisLabel('parallel', tick.value, tick.label)),
    );
    positionLabels();
  };

  const axisLabel = (axis: 'meridian' | 'parallel', value: number, text: string) => {
    const span = doc.createElement('span');
    span.className = `travel-map-graticule__label travel-map-graticule__label--${axis}`;
    span.dataset.axis = axis;
    span.dataset.value = String(value);
    span.textContent = text;
    return span;
  };

  /** The graticule sits under the place names, so labels stay readable over it. */
  const addGraticuleLayer = () => {
    if (map.getSource('graticule')) return;
    map.addSource('graticule', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const beforeLabels = map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
    map.addLayer({
      id: 'graticule',
      type: 'line',
      source: 'graticule',
      paint: {
        'line-color': '#142a42',
        'line-opacity': ['case', ['get', 'primary'], 0.34, 0.16],
        'line-width': ['case', ['get', 'primary'], 1.25, 1],
        'line-dasharray': [3, 4],
      },
    }, beforeLabels);
  };

  const mountPinsAndControls = () => {
    const pinTemplate = labels.pinLabel ?? 'Trip {number}: {title} ({country})';
    geojson.features.forEach((f, index) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'travel-map-pin';
      button.dataset.pinIndex = String(index);
      button.dataset.region = f.properties.region;
      button.setAttribute('aria-label', pinTemplate
        .replace('{number}', String(f.properties.number))
        .replace('{title}', f.properties.title)
        .replace('{country}', f.properties.country));
      const badge = doc.createElement('span');
      badge.className = 'travel-map-pin__badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = ENTRY(f.properties.number);
      button.append(badge);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openPinPopup(index, button);
      });
      new Marker({ element: button }).setLngLat(f.geometry.coordinates).addTo(map);
      markers.push({ element: button, feature: f, index, inRegion: true });
    });

    for (const focusBtn of doc.querySelectorAll<HTMLButtonElement>('[data-map-focus]')) {
      focusBtn.addEventListener('click', () => {
        const index = Number(focusBtn.dataset.mapFocus);
        const f = geojson.features[index];
        if (!f) return;
        userMoved = true;
        // Land the pin below centre: the photo popup (~270px) then opens upward
        // inside the frame instead of running under the attribution bar.
        map.easeTo({
          center: f.geometry.coordinates,
          zoom: Math.max(map.getZoom(), LOCATE_ZOOM),
          offset: [0, Math.round(container.clientHeight * 0.22)],
          duration: reduceMotion() ? 0 : 650,
        });
        openPinPopup(index, focusBtn);
        container.scrollIntoView?.({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
      });
    }

    for (const entry of doc.querySelectorAll<HTMLElement>('[data-map-entry]')) {
      const marker = markers[Number(entry.dataset.pinIndex)];
      if (!marker) continue;
      const highlight = (on: boolean) => () => { marker.element.dataset.hover = String(on); };
      entry.addEventListener('mouseenter', highlight(true));
      entry.addEventListener('mouseleave', highlight(false));
      entry.addEventListener('focusin', highlight(true));
      entry.addEventListener('focusout', highlight(false));
    }

    for (const regionBtn of doc.querySelectorAll<HTMLButtonElement>('[data-map-region]')) {
      regionBtn.addEventListener('click', () => {
        const region = regionBtn.dataset.mapRegion ?? 'all';
        activeRegion = region;
        userMoved = false;
        dismissPopup(false);
        for (const btn of doc.querySelectorAll<HTMLButtonElement>('[data-map-region]')) {
          btn.setAttribute('aria-pressed', String(btn.dataset.mapRegion === region));
        }
        for (const m of markers) m.inRegion = region === 'all' || m.feature.properties.region === region;
        for (const group of doc.querySelectorAll<HTMLElement>('[data-region-group]')) {
          group.hidden = region !== 'all' && group.dataset.regionGroup !== region;
        }
        recluster();
        fitRegionBounds(region);
      });
    }

    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !current) return;
      event.preventDefault();
      dismissPopup(true);
      recluster();
    });
    container.append(labelLayer);
  };

  // Runs on `load`, and again on the fallback style's `style.load`: the style
  // swap drops every source, while DOM markers and the label layer survive.
  const mountOverlays = () => {
    if (!mounted) {
      mounted = true;
      mountPinsAndControls();
      fitRegionBounds(activeRegion);
    }
    addGraticuleLayer();
    updateGraticule();
    recluster();
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
    if (basemapFailed) mountOverlays();
  });
  map.on('dragstart', () => {
    userMoved = true;
  });
  map.on('move', positionLabels);
  map.on('moveend', () => {
    if (!mounted) return;
    updateGraticule();
    recluster();
  });
  map.on('resize', () => {
    if (!userMoved) fitRegionBounds(activeRegion);
  });
  map.on('load', mountOverlays);
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
