(function () {
  'use strict';
  var protocolRegistered = false;
  var scriptPromise;
  var cssPromise;
  var maplibreUrl = '/admin/gpx-maplibre.mjs';
  var pmtilesUrl = '/admin/vendor/pmtiles.js';
  var cssUrl = '/admin/vendor/maplibre-gl.css';

  function loadScript(url) {
    if (url === maplibreUrl && window.maplibregl) return Promise.resolve();
    if (url === pmtilesUrl && window.pmtiles) return Promise.resolve();
    var promise = url === maplibreUrl ? scriptPromise : window.__gpxPmtilesPromise;
    if (promise) return promise;
    promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      if (url === maplibreUrl) script.type = 'module';
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('gpx_map_load_failed')); };
      document.head.appendChild(script);
    });
    if (url === maplibreUrl) scriptPromise = promise;
    else window.__gpxPmtilesPromise = promise;
    return promise;
  }

  function loadCss() {
    if (document.querySelector('link[data-gpx-map-css]')) return Promise.resolve();
    if (!cssPromise) cssPromise = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = cssUrl; link.dataset.gpxMapCss = 'true';
      link.onload = resolve; link.onerror = resolve;
      document.head.appendChild(link);
      window.setTimeout(resolve, 2500);
    });
    return cssPromise;
  }

  function sameOrigin(url) { return new URL(url, location.href).origin === location.origin; }
  function boundsFor(runs) {
    var west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    runs.forEach(function (run) { run.forEach(function (p) {
      if (!p || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return;
      west = Math.min(west, p.lng); east = Math.max(east, p.lng);
      south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    }); });
    return west === Infinity ? null : [[west, south], [east, north]];
  }
  function copyText(copy, key) {
    var mapped = {
      loading: 'mapLoading', basemapMissing: 'mapBasemapMissing', webglFallback: 'mapWebglFallback',
      kept: 'mapLegendKept', removed: 'mapLegendRemoved', waypoints: 'mapLegendWaypoints',
      routeLabel: 'mapRouteLabel', waypointLabel: 'mapWaypointLabel', noGeometry: 'mapNoGeometry'
    }[key] || key;
    return String(copy[key] || copy[mapped] || '');
  }
  function runsOf(geometry) {
    return geometry && Array.isArray(geometry.segments) ? geometry.segments.map(function (s) {
      return s && Array.isArray(s.points) && s.points.every(function (p) {
        return p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && p.lng >= -180 && p.lng <= 180 && p.lat >= -90 && p.lat <= 90;
      }) ? s.points : [];
    }).filter(function (r) { return r.length > 0; }) : [];
  }
  function feature(runs, properties) {
    var coordinates = runs.map(function (run) { return run.map(function (p) { return [p.lng, p.lat]; }); });
    var nondegenerate = coordinates.filter(function (line) { return line.length > 1; });
    if (!nondegenerate.length) return null;
    return { type: 'Feature', properties: properties, geometry: { type: 'MultiLineString', coordinates: nondegenerate } };
  }
  function removedRuns(original, kept) {
    var retainedEdges = new Set();
    function key(a, b) { return a.lng + ',' + a.lat + '>' + b.lng + ',' + b.lat; }
    kept.forEach(function (run) {
      for (var i = 1; i < run.length; i += 1) retainedEdges.add(key(run[i - 1], run[i]));
    });
    var result = [];
    original.forEach(function (run) {
      var current = [];
      for (var i = 1; i < run.length; i += 1) {
        var a = run[i - 1], b = run[i];
        if (retainedEdges.has(key(a, b))) {
          if (current.length > 1) result.push(current);
          current = [];
        } else {
          if (!current.length) current.push(a);
          current.push(b);
        }
      }
      if (current.length > 1) result.push(current);
    });
    return result;
  }
  function svgFallback(container, status, copy, retained, removed, waypoints, statusKey) {
    var all = retained.concat(removed, waypoints.map(function (point) { return [point]; }));
    var bounds = boundsFor(all);
    var width = Math.max(320, container.clientWidth || 640), height = 300, pad = 24;
    function xy(point) {
      var x = bounds && bounds[0][0] !== bounds[1][0] ? (point.lng - bounds[0][0]) / (bounds[1][0] - bounds[0][0]) : .5;
      var y = bounds && bounds[0][1] !== bounds[1][1] ? (bounds[1][1] - point.lat) / (bounds[1][1] - bounds[0][1]) : .5;
      return [pad + x * (width - 2 * pad), pad + y * (height - 2 * pad)];
    }
    function paths(runs, cls) { return runs.filter(function (r) { return r.length > 1; }).map(function (run) {
      return '<polyline class="gpx-map__line ' + cls + '" points="' + run.map(function (p) { var q = xy(p); return q[0].toFixed(2) + ',' + q[1].toFixed(2); }).join(' ') + '" />';
    }).join(''); }
    container.innerHTML = '<svg class="gpx-map__svg" role="img" aria-label="' + copyText(copy, 'routeLabel').replace(/[&<>"']/g, '') + '" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" class="gpx-map__grid" />' + paths(removed, 'is-removed') + paths(retained, 'is-kept') + waypoints.map(function (w) {
      if (!w || !Number.isFinite(w.lng) || !Number.isFinite(w.lat)) return '';
      var q = xy(w); return '<circle class="gpx-map__waypoint' + (w.selected ? ' is-selected' : '') + '" cx="' + q[0].toFixed(2) + '" cy="' + q[1].toFixed(2) + '" r="' + (w.selected ? 7 : 4) + '" />';
    }).join('') + '</svg>';
    status.textContent = copyText(copy, statusKey);
  }

  function webgl2Available() {
    var context = document.createElement('canvas').getContext('webgl2');
    if (!context) return false;
    var release = context.getExtension('WEBGL_lose_context');
    if (release) release.loseContext();
    return true;
  }

  async function create(options) {
    var container = options.container, status = options.statusElement, copy = options.copy;
    var latestData = null;
    var map = null, dead = false, observer = null, failed = false;
    var styleReady = false, basemapFailed = false, needsFit = true;
    function removeMap() {
      var current = map;
      map = null;
      // A partially initialized MapLibre 6 map can throw during remove().
      // Optional preview cleanup must not turn an acknowledged attach into a failure.
      if (current) { try { current.remove(); } catch (_) { } }
    }
    var legend = document.createElement('div');
    legend.className = 'gpx-map__legend';
    legend.setAttribute('aria-label', copyText(copy, 'routeLabel'));
    [
      ['is-kept', 'kept'],
      ['is-removed', 'removed'],
      ['is-waypoint', 'waypoints']
    ].forEach(function (entry) {
      var item = document.createElement('span');
      var swatch = document.createElement('i');
      swatch.className = 'gpx-map__swatch ' + entry[0];
      swatch.setAttribute('aria-hidden', 'true');
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(copyText(copy, entry[1])));
      legend.appendChild(item);
    });
    if (container.parentNode) container.parentNode.insertBefore(legend, container.nextSibling);
    var fallbackKey = 'webglFallback';
    function destroy() {
      if (dead) return;
      dead = true;
      if (options.signal) options.signal.removeEventListener('abort', destroy);
      if (observer) observer.disconnect();
      removeMap();
      delete container.dataset.gpxNoBasemap;
      container.replaceChildren();
      legend.remove();
    }
    var api = { render: render, resize: function () { if (map && !dead) map.resize(); }, destroy: destroy };
    // Cancel before shared vendor loads finish, not after a newer preview has mounted.
    if (options.signal) {
      options.signal.addEventListener('abort', destroy, { once: true });
      if (options.signal.aborted) destroy();
    }
    if (dead) return api;
    status.textContent = copyText(copy, 'loading');
    try { await Promise.all([loadCss(), loadScript(maplibreUrl), loadScript(pmtilesUrl)]); }
    catch (_) { failed = true; }
    if (dead) return api;
    var gl = window.maplibregl;
    var pm = window.pmtiles;
    if (!gl || !pm || typeof gl.Map !== 'function' || typeof pm.Protocol !== 'function') {
      failed = true;
      status.textContent = copyText(copy, 'webglFallback');
    } else {
      if (!sameOrigin('/map/basemap.pmtiles')) throw new Error('gpx_map_origin_invalid');
      if (!protocolRegistered) { gl.addProtocol('pmtiles', new pm.Protocol().tile); protocolRegistered = true; }
      var style = { version: 8, glyphs: '/map/fonts/{fontstack}/{range}.pbf', sources: { protomaps: { type: 'vector', url: 'pmtiles:///map/basemap.pmtiles', attribution: '© OpenStreetMap' } }, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#f2f3f4' } },
        { id: 'earth', type: 'fill', source: 'protomaps', 'source-layer': 'earth', paint: { 'fill-color': '#e7e5dc' } },
        { id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water', paint: { 'fill-color': '#d9e8ed' } },
        { id: 'roads', type: 'line', source: 'protomaps', 'source-layer': 'roads', paint: { 'line-color': '#c5bda9', 'line-width': 1 } },
        { id: 'boundaries', type: 'line', source: 'protomaps', 'source-layer': 'boundaries', paint: { 'line-color': '#b6aa94', 'line-width': 1 } },
        { id: 'places', type: 'symbol', source: 'protomaps', 'source-layer': 'places', layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name'], ''], 'text-font': ['Noto Sans Regular'], 'text-size': 12 }, paint: { 'text-color': '#142a42', 'text-halo-color': '#f2f3f4', 'text-halo-width': 1 } }
      ] };
      try {
        // MapLibre 6.4.1 returns early without a painter on WebGL2 failure.
        // Probe first: its partially initialized instance cannot release all resources.
        if (!webgl2Available()) throw new Error('gpx_map_webgl_unavailable');
        map = new gl.Map({ container: container, style: style, attributionControl: {}, fadeDuration: 0 });
        if (!map.getCanvas().getContext('webgl2')) throw new Error('gpx_map_webgl_unavailable');
        styleReady = map.isStyleLoaded();
        map.addControl(new gl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('style.load', function () {
          styleReady = true;
          if (!dead && latestData) render(latestData);
        });
        map.on('error', function () {
          if (dead || failed || basemapFailed) return;
          basemapFailed = true; styleReady = false;
          container.dataset.gpxNoBasemap = 'true';
          fallbackKey = 'basemapMissing'; status.textContent = copyText(copy, fallbackKey);
          try { map.setStyle({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-opacity': 0 } }] }); }
          catch (_) {
            failed = true;
            removeMap();
            if (latestData) render(latestData);
          }
        });
        map.on('load', function () { if (!dead && !failed && !basemapFailed) status.textContent = ''; });
      } catch (_) {
        failed = true; status.textContent = copyText(copy, 'webglFallback');
        removeMap();
      }
    }
    function render(data) {
      if (dead) return;
      latestData = data;
      var retained = runsOf(data.kept), removed = removedRuns(runsOf(data.geometry), retained);
      var selected = new Set(Array.isArray(data.selectedWaypointIndices) ? data.selectedWaypointIndices : []);
      var points = (Array.isArray(data.waypoints) ? data.waypoints : []).map(function (point, index) {
        return { lng: point.lng, lat: point.lat, selected: selected.has(index) };
      }).filter(function (point) { return Number.isFinite(point.lng) && Number.isFinite(point.lat) && Math.abs(point.lng) <= 180 && Math.abs(point.lat) <= 90; });
      if (!retained.length && !removed.length && !points.length) { status.textContent = copyText(copy, 'noGeometry'); return; }
      if (failed || !map) { svgFallback(container, status, copy, retained, removed, points, fallbackKey); return; }
      if (!styleReady || dead) return;
      try {
        var keepFeature = feature(retained, { kind: 'kept' }), removeFeature = feature(removed, { kind: 'removed' });
        var update = function () {
          if (dead) return;
          ['gpx-kept', 'gpx-removed', 'gpx-waypoints'].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); });
          if (keepFeature) { map.addSource('gpx-kept', { type: 'geojson', data: keepFeature }); map.addLayer({ id: 'gpx-kept', type: 'line', source: 'gpx-kept', paint: { 'line-color': '#d23b30', 'line-width': 4 } }); }
          if (removeFeature) { map.addSource('gpx-removed', { type: 'geojson', data: removeFeature }); map.addLayer({ id: 'gpx-removed', type: 'line', source: 'gpx-removed', paint: { 'line-color': '#59636d', 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': .8 } }); }
          if (points.length) { map.addSource('gpx-waypoints', { type: 'geojson', data: { type: 'FeatureCollection', features: points.map(function (point) { return { type: 'Feature', properties: { selected: point.selected }, geometry: { type: 'Point', coordinates: [point.lng, point.lat] } }; }) } }); map.addLayer({ id: 'gpx-waypoints', type: 'circle', source: 'gpx-waypoints', paint: { 'circle-radius': ['case', ['get', 'selected'], 7, 4], 'circle-color': ['case', ['get', 'selected'], '#142a42', '#fff'], 'circle-stroke-color': '#142a42', 'circle-stroke-width': 2 } }); }
          var bounds = boundsFor(retained.concat(removed, points.map(function (point) { return [point]; })));
          if (needsFit && bounds) { map.fitBounds(bounds, { padding: 40, maxZoom: 8, duration: 0 }); needsFit = false; }
        };
        update();
      } catch (_) {
        failed = true;
        removeMap();
        svgFallback(container, status, copy, retained, removed, points, fallbackKey);
      }
    }
    observer = map && typeof ResizeObserver === 'function' ? new ResizeObserver(function () { if (map && !dead) map.resize(); }) : null;
    if (observer) observer.observe(container);
    return api;
  }
  window.GpxMap = { create: create };
})();
