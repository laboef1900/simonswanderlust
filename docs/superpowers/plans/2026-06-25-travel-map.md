# Travel Map (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted MapLibre travel map — dedicated page (`/karte/` · `/en/map/`), wired homepage teaser, and per-story mini-maps — driven by each trip's `coordinates`/`stops`, with graceful no-JS fallbacks.

**Architecture:** A pure, unit-tested data helper turns the trip collection into GeoJSON, embedded into pages at build time. A single client island (`maplibre-gl` + `pmtiles`, bundled) renders it against a self-hosted pmtiles basemap in two modes (full = map page; mini = story page, lazy). Every map is progressive enhancement over a static text/link fallback.

**Tech Stack:** Astro 6 (static), MapLibre GL JS, pmtiles, protomaps-themes-base, Tailwind 4, Vitest.

## Global Constraints

- All site commands run from `site/`. Astro static output, `trailingSlash: 'always'`, i18n `defaultLocale: 'de'` (no prefix), `en` under `/en/`.
- Strict TS (`astro/tsconfigs/strict`) — no `any`, no `@ts-ignore`, no `astro check` suppressions.
- **No hardcoded UI strings** — all user-facing copy in `site/src/i18n/ui.ts` for BOTH locales (completeness-tested).
- **No binaries in git** — the `basemap.pmtiles` + glyph fonts are runtime assets, git-ignored, served by nginx.
- **Zero third-party requests** — pmtiles basemap + glyphs are same-origin; `maplibre-gl`/`pmtiles` are bundled (no CDN).
- **Progressive enhancement** — no JS / missing basemap / tile failure must leave a usable static fallback; `astro build` must NOT depend on the basemap file.
- **GeoJSON coordinate order is `[lng, lat]`** (not `[lat, lng]`).
- New routes: `/karte/` (DE) · `/en/map/` (EN) — new pages, not WP slugs.
- Gates: `npx astro check` + `npm test` green (both need a reachable Postgres — the loader runs). Commit style `type(scope): desc`.

---

### Task 1: Map data helper (pure, unit-tested) + `mapPath`

**Files:**
- Create: `site/src/lib/map-data.ts`
- Test: `site/test/map-data.test.ts`
- Modify: `site/src/lib/paths.ts` (add `mapPath`)
- Test: `site/test/paths.test.ts` (add a `mapPath` case)

**Interfaces:**
- Consumes: `Trip`, `byLocale`, `pathOf` (`site/src/lib/trips.ts`); `Region` (`site/src/lib/paths.ts`); `Locale` (`site/src/i18n/ui.ts`).
- Produces:
  - `interface PinFeature { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { title: string; href: string; country: string; region: Region } }`
  - `interface PinCollection { type: 'FeatureCollection'; features: PinFeature[] }`
  - `function tripPins(trips: Trip[], locale: Locale): PinCollection`
  - `interface StopFeature { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { name: string } }`
  - `interface TripGeometry { pin: PinFeature; stops: StopFeature[] }`
  - `function tripGeometry(trip: Trip): TripGeometry`
  - `function mapPath(locale: Locale): string` (DE `/karte/`, EN `/en/map/`)

- [ ] **Step 1: Write the failing test** — `site/test/map-data.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { Trip } from '../src/lib/trips';
import { tripPins, tripGeometry } from '../src/lib/map-data';

// Minimal Trip stub — only the fields the helpers read.
function trip(id: string, data: Partial<Trip['data']>): Trip {
  return { id, data: { title: 'T', country: 'C', region: 'europe', coordinates: { lat: 1, lng: 2 }, date: new Date('2024-01-01'), ...data } } as unknown as Trip;
}

describe('tripPins', () => {
  it('builds [lng,lat] Points with localized hrefs, one per locale trip', () => {
    const all = [
      trip('de/rhodos', { title: 'Rhodos', coordinates: { lat: 36.4, lng: 28.2 }, country: 'Griechenland', region: 'europe' }),
      trip('en/rhodes', { title: 'Rhodes', coordinates: { lat: 36.4, lng: 28.2 }, country: 'Greece', region: 'europe' }),
    ];
    const fc = tripPins(all, 'de');
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.coordinates).toEqual([28.2, 36.4]); // [lng, lat]
    expect(f.properties).toMatchObject({ title: 'Rhodos', href: '/rhodos/', country: 'Griechenland', region: 'europe' });
  });
  it('uses /en/ hrefs for the en locale', () => {
    const all = [trip('en/rhodes', { coordinates: { lat: 1, lng: 2 } })];
    expect(tripPins(all, 'en').features[0].properties.href).toBe('/en/rhodes/');
  });
  it('is empty for an empty collection', () => {
    expect(tripPins([], 'de').features).toEqual([]);
  });
});

describe('tripGeometry', () => {
  it('returns the pin and a Point per stop ([lng,lat])', () => {
    const t = trip('de/x', { coordinates: { lat: 10, lng: 20 }, stops: [{ name: 'A', lat: 11, lng: 21 }] });
    const g = tripGeometry(t);
    expect(g.pin.geometry.coordinates).toEqual([20, 10]);
    expect(g.stops).toHaveLength(1);
    expect(g.stops[0]).toMatchObject({ properties: { name: 'A' }, geometry: { coordinates: [21, 11] } });
  });
  it('has no stops when none are defined', () => {
    expect(tripGeometry(trip('de/x', {})).stops).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** — `cd site && npx vitest run test/map-data.test.ts` → module not found.

- [ ] **Step 3: Implement** — `site/src/lib/map-data.ts`

```ts
import type { Locale } from '../i18n/ui';
import type { Region } from './paths';
import { byLocale, pathOf, type Trip } from './trips';

export interface PinFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { title: string; href: string; country: string; region: Region };
}
export interface PinCollection { type: 'FeatureCollection'; features: PinFeature[] }
export interface StopFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { name: string };
}
export interface TripGeometry { pin: PinFeature; stops: StopFeature[] }

function pinOf(trip: Trip): PinFeature {
  const { lat, lng } = trip.data.coordinates;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { title: trip.data.title, href: pathOf(trip), country: trip.data.country, region: trip.data.region as Region },
  };
}

export function tripPins(trips: Trip[], locale: Locale): PinCollection {
  return { type: 'FeatureCollection', features: byLocale(trips, locale).map(pinOf) };
}

export function tripGeometry(trip: Trip): TripGeometry {
  const stops: StopFeature[] = (trip.data.stops ?? []).map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { name: s.name },
  }));
  return { pin: pinOf(trip), stops };
}
```

- [ ] **Step 4: Run — expect PASS** — `cd site && npx vitest run test/map-data.test.ts`

- [ ] **Step 5: Add `mapPath` to `paths.ts`** (after `aboutPath`):

```ts
export function mapPath(locale: Locale): string {
  return locale === 'en' ? '/en/map/' : '/karte/';
}
```

Add to `site/test/paths.test.ts` (match the file's existing test style):

```ts
import { mapPath } from '../src/lib/paths';
// inside the existing describe (or a new one):
it('mapPath: DE at /karte/, EN at /en/map/', () => {
  expect(mapPath('de')).toBe('/karte/');
  expect(mapPath('en')).toBe('/en/map/');
});
```

- [ ] **Step 6: Run full unit suite + commit** — `cd site && npm test` (green) then:

```bash
git add site/src/lib/map-data.ts site/test/map-data.test.ts site/src/lib/paths.ts site/test/paths.test.ts
git commit -m "feat(map): tripPins/tripGeometry GeoJSON helpers + mapPath route"
```

---

### Task 2: i18n strings

**Files:**
- Modify: `site/src/i18n/ui.ts` (both `de` and `en`)

**Interfaces:**
- Produces these keys (used by Tasks 4 & 5): `nav.map`, `map.title`, `map.intro`, `map.fallbackHeading`, `map.miniLabel`, `map.viewOnMap`, `map.readStory`. Removes `home.mapTeaser.soon`.

- [ ] **Step 1: Read `ui.ts`** to see the exact object shape and where `nav.*` / `home.mapTeaser.*` live.

- [ ] **Step 2: Add the keys to BOTH locales and remove `home.mapTeaser.soon` from both.** Use these values:

DE: `'nav.map': 'Karte'`, `'map.title': 'Reisekarte'`, `'map.intro': 'Alle Reisen auf einen Blick.'`, `'map.fallbackHeading': 'Reiseziele'`, `'map.miniLabel': 'Auf der Karte'`, `'map.viewOnMap': 'Auf der Karte ansehen'`, `'map.readStory': 'Reisebericht lesen'`.

EN: `'nav.map': 'Map'`, `'map.title': 'Travel map'`, `'map.intro': 'Every trip at a glance.'`, `'map.fallbackHeading': 'Destinations'`, `'map.miniLabel': 'On the map'`, `'map.viewOnMap': 'View on the map'`, `'map.readStory': 'Read the story'`.

- [ ] **Step 3: Run the i18n completeness test + commit** — `cd site && npm test` (the i18n suite verifies both locales have identical keys; it must stay green). Then:

```bash
git add site/src/i18n/ui.ts
git commit -m "feat(map): i18n strings for map page, nav, mini-map; drop teaser 'soon'"
```

---

### Task 3: Map assets — deps, serving config, gitignore

**Files:**
- Modify: `site/package.json` (deps)
- Modify: `site/.gitignore` (or root `.gitignore`) — ignore the basemap + fonts
- Modify: `site/nginx.conf` (serve `/map/` with range support) — confirm the real filename
- Modify: `docker-compose.yml` + `uploader/docker-compose.yml` (mount a map-assets volume into the `blog` service) and `.env.example` (document it)

**Interfaces:**
- Produces: bundleable `maplibre-gl`, `pmtiles`, `protomaps-themes-base`; an nginx `location /map/` serving `/map/basemap.pmtiles` + `/map/fonts/...` with HTTP range requests; the basemap/fonts git-ignored.

- [ ] **Step 1: Install deps** — `cd site && npm install maplibre-gl pmtiles protomaps-themes-base`. Expected: all three in `package.json` dependencies; exit 0.

- [ ] **Step 2: Gitignore the runtime map assets** — append to `site/.gitignore`:

```
# Runtime map assets (self-hosted basemap + glyphs) — never commit (binaries)
public/map/
```
(Place the dev/build copy under `site/public/map/` so Astro serves it locally; it's git-ignored.)

- [ ] **Step 3: nginx — serve `/map/` with range requests.** Read `site/nginx.conf` first. Add a location that serves the mounted map assets directory with `add_header Accept-Ranges bytes;` and correct types (`application/octet-stream` for `.pmtiles`, `application/x-protobuf` for `.pbf`). Example block:

```nginx
location /map/ {
    alias /usr/share/nginx/map/;
    add_header Accept-Ranges bytes;
    types { application/octet-stream pmtiles; application/x-protobuf pbf; }
    try_files $uri =404;
}
```

- [ ] **Step 4: compose — mount the map-assets volume into `blog`.** In both `docker-compose.yml` and `uploader/docker-compose.yml`, add to the `blog` service a bind/volume mapping the host map dir to `/usr/share/nginx/map` (read-only), e.g. `- ${MAP_ASSETS_DIR:-./map-assets}:/usr/share/nginx/map:ro`. Document `MAP_ASSETS_DIR` in `.env.example` (path to the dir holding `basemap.pmtiles` + `fonts/`).

- [ ] **Step 5: Verify + commit** — `cd site && npx astro check` (clean — deps resolve) and `docker compose config >/dev/null` (both compose files valid). Then:

```bash
git add site/package.json site/package-lock.json site/.gitignore site/nginx.conf docker-compose.yml uploader/docker-compose.yml .env.example
git commit -m "build(map): add maplibre/pmtiles deps; serve /map/ assets with range support"
```

---

### Task 4: Map page + island (full mode) + routes + nav + teaser

**Files:**
- Create: `site/src/scripts/travel-map.ts` (MapLibre init, full + mini modes)
- Create: `site/src/components/pages/MapPage.astro`
- Create: `site/src/pages/karte.astro`, `site/src/pages/en/map.astro`
- Modify: `site/src/components/MapTeaser.astro` (CTA → `mapPath`, drop "soon")
- Modify: the primary nav component (add a Map link) — find it (search for `aboutPath(` / existing nav links)

**Interfaces:**
- Consumes: `tripPins` (T1), `mapPath` (T1), i18n keys (T2), `maplibre-gl`/`pmtiles`/`protomaps-themes-base` (T3).
- Produces: `initFullMap(container: HTMLElement, geojson: PinCollection, labels: { readStory: string }): void` and `initMiniMap(container: HTMLElement, geometry: TripGeometry): void` exported from `travel-map.ts`.

**Note on external APIs (verify before coding):** `protomaps-themes-base` and the MapLibre style schema vary by version. Before writing `travel-map.ts`, check the installed `protomaps-themes-base` export shape (e.g. a `layers(sourceName, flavor)` function) and the pmtiles `Protocol` usage, and adapt the code below to the installed versions. The code below is the intended shape.

- [ ] **Step 1: Implement `travel-map.ts`**

```ts
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import layers from 'protomaps-themes-base';
import type { PinCollection, TripGeometry } from '../lib/map-data';

const PMTILES_URL = 'pmtiles:///map/basemap.pmtiles';
let protocolRegistered = false;

function baseStyle(): maplibregl.StyleSpecification {
  if (!protocolRegistered) {
    maplibregl.addProtocol('pmtiles', new Protocol().tile);
    protocolRegistered = true;
  }
  return {
    version: 8,
    glyphs: '/map/fonts/{fontstack}/{range}.pbf',
    sources: { protomaps: { type: 'vector', url: PMTILES_URL, attribution: '© OpenStreetMap' } },
    layers: layers('protomaps', 'light'),
  } as maplibregl.StyleSpecification;
}

export function initFullMap(container: HTMLElement, geojson: PinCollection, labels: { readStory: string }): void {
  const map = new maplibregl.Map({ container, style: baseStyle(), attributionControl: true });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.on('load', () => {
    map.addSource('pins', { type: 'geojson', data: geojson });
    map.addLayer({ id: 'pins', type: 'circle', source: 'pins',
      paint: { 'circle-radius': 7, 'circle-color': '#d23b30', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    map.on('click', 'pins', (e) => {
      const f = e.features?.[0]; if (!f) return;
      const p = f.properties as { title: string; href: string };
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      new maplibregl.Popup().setLngLat([lng, lat])
        .setHTML(`<strong></strong><br><a></a>`).addTo(map);
      // set text safely (no HTML injection):
      const el = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = p.title;
      const a = document.createElement('a'); a.href = p.href; a.textContent = labels.readStory;
      el.append(strong, document.createElement('br'), a);
      const popups = document.getElementsByClassName('maplibregl-popup-content');
      const last = popups[popups.length - 1]; if (last) { last.innerHTML = ''; last.appendChild(el); }
    });
    map.on('mouseenter', 'pins', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pins', () => { map.getCanvas().style.cursor = ''; });
    const bounds = new maplibregl.LngLatBounds();
    for (const f of geojson.features) bounds.extend(f.geometry.coordinates);
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 6 });
    container.dataset.ready = 'true';
  });
}

export function initMiniMap(container: HTMLElement, geometry: TripGeometry): void {
  const map = new maplibregl.Map({ container, style: baseStyle(), interactive: true, attributionControl: true });
  map.on('load', () => {
    const feats = [geometry.pin, ...geometry.stops];
    map.addSource('trip', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
    map.addLayer({ id: 'trip', type: 'circle', source: 'trip',
      paint: { 'circle-radius': 6, 'circle-color': '#d23b30', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    if (feats.length === 1) { map.setCenter(geometry.pin.geometry.coordinates); map.setZoom(5); }
    else { const b = new maplibregl.LngLatBounds(); for (const f of feats) b.extend(f.geometry.coordinates); map.fitBounds(b, { padding: 40, maxZoom: 8 }); }
    container.dataset.ready = 'true';
  });
}
```
(The popup-building approach must use `textContent`/DOM, never interpolate `title`/`href` into HTML — XSS-safe. Adjust to a clean popup API if the installed MapLibre offers `setDOMContent`, which is preferable: `new maplibregl.Popup().setLngLat(...).setDOMContent(el).addTo(map)`.)

- [ ] **Step 2: Implement `MapPage.astro`** — container + embedded GeoJSON + region-grouped fallback + script:

```astro
---
import { getCollection } from 'astro:content';
import Base from '../../layouts/Base.astro';  // confirm the real base layout import
import { useTranslations, type Locale } from '../../i18n/ui';
import { byLocale, pathOf } from '../../lib/trips';
import { tripPins } from '../../lib/map-data';
import { regions } from '../../lib/paths';

interface Props { locale: Locale }
const { locale } = Astro.props;
const t = useTranslations(locale);
const all = await getCollection('trips');
const trips = byLocale(all, locale);
const geojson = tripPins(all, locale);
---
<Base locale={locale} title={t('map.title')}>
  <section class="mx-auto max-w-6xl px-5 py-10">
    <h1 class="text-3xl font-extrabold text-navy">{t('map.title')}</h1>
    <p class="mt-1 text-ink/70">{t('map.intro')}</p>
    <div id="map" class="mt-6 h-[70vh] w-full rounded-lg bg-navy/5" data-geojson={JSON.stringify(geojson)} data-readstory={t('map.readStory')}></div>
    <noscript><p class="mt-2 text-sm text-ink/60">{t('map.intro')}</p></noscript>
    <nav class="mt-8" aria-label={t('map.fallbackHeading')}>
      <h2 class="text-lg font-bold text-navy">{t('map.fallbackHeading')}</h2>
      <ul class="mt-2 grid gap-1">
        {trips.map((trip) => (<li><a class="text-brand-red hover:underline" href={pathOf(trip)}>{trip.data.title}</a></li>))}
      </ul>
    </nav>
  </section>
</Base>
<script>
  import { initFullMap } from '../../scripts/travel-map';
  const el = document.getElementById('map');
  if (el && el.dataset.geojson) {
    try { initFullMap(el, JSON.parse(el.dataset.geojson), { readStory: el.dataset.readstory ?? '' }); }
    catch (err) { console.error('map init failed', err); }
  }
</script>
```
(Confirm the real base layout component + its props by reading `AboutPage.astro`; match that pattern. The fallback `<ul>` is always in the DOM so no-JS/tile-fail users keep a working list.)

- [ ] **Step 3: Thin routes** — `site/src/pages/karte.astro`: `--- import MapPage from '../components/pages/MapPage.astro'; --- <MapPage locale="de" />`. `site/src/pages/en/map.astro`: same with `locale="en"`.

- [ ] **Step 4: Nav + teaser** — add a Map link (`mapPath(locale)`, `t('nav.map')`) to the primary nav component next to the existing Stories/About links. In `MapTeaser.astro`, change the CTA `<span>` to `<a href={mapPath(locale)}>` showing `t('home.mapTeaser.cta')` and remove the `— {t('home.mapTeaser.soon')}` part.

- [ ] **Step 5: Verify + commit** — `cd site && npx astro check` (clean) and `npm test` (green). Then run `npm run build` to confirm the build succeeds WITHOUT a basemap file present (the page builds; the map falls back at runtime). Visual check optional here (needs the basemap). Then:

```bash
git add site/src/scripts/travel-map.ts site/src/components/pages/MapPage.astro site/src/pages/karte.astro site/src/pages/en/map.astro site/src/components/MapTeaser.astro site/src/components/*Nav*.astro
git commit -m "feat(map): map page + MapLibre island, routes, nav link, teaser wiring"
```

---

### Task 5: Per-story mini-map (lazy)

**Files:**
- Create: `site/src/components/StoryMiniMap.astro`
- Modify: the story render component/layout (find where a single story renders — search `pages/[slug].astro` and `components/pages/` for the story page)

**Interfaces:**
- Consumes: `tripGeometry` (T1), `initMiniMap` (T4), i18n keys (T2), `mapPath` (T1).

- [ ] **Step 1: Implement `StoryMiniMap.astro`** — embedded single-trip geometry + lazy init + fallback link:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';
import { mapPath } from '../lib/paths';
import { tripGeometry } from '../lib/map-data';
import type { Trip } from '../lib/trips';

interface Props { trip: Trip; locale: Locale }
const { trip, locale } = Astro.props;
const t = useTranslations(locale);
const geometry = tripGeometry(trip);
---
<section class="my-8">
  <h2 class="text-sm font-bold text-navy">{t('map.miniLabel')}</h2>
  <div id="mini-map" class="mt-2 h-64 w-full rounded-lg bg-navy/5" data-geometry={JSON.stringify(geometry)}>
    <a class="block p-4 text-brand-red hover:underline" href={mapPath(locale)}>{t('map.viewOnMap')}</a>
  </div>
</section>
<script>
  import { initMiniMap } from '../scripts/travel-map';
  const el = document.getElementById('mini-map');
  if (el && el.dataset.geometry) {
    const geometry = JSON.parse(el.dataset.geometry);
    const obs = new IntersectionObserver((entries, o) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          o.disconnect();
          el.innerHTML = '';  // clear the fallback link before mounting the map
          try { initMiniMap(el, geometry); } catch (err) { console.error('mini-map init failed', err); }
        }
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
  }
</script>
```
(The fallback `<a>` lives inside the container and is cleared only when the map is about to mount — so no-JS users still get the link.)

- [ ] **Step 2: Insert into the story render** — read the story page component (the one that renders a single trip's body, e.g. `src/pages/[slug].astro` or a `components/pages/StoryPage.astro`), and render `<StoryMiniMap trip={trip} locale={locale} />` in a sensible spot (e.g. after the body, near `KeyFacts`). Use the variable names already in that component for the current trip + locale.

- [ ] **Step 3: Verify + commit** — `cd site && npx astro check` (clean), `npm test` (green), `npm run build` (succeeds without a basemap). Then:

```bash
git add site/src/components/StoryMiniMap.astro site/src/pages/'[slug].astro' site/src/components/pages/
git commit -m "feat(map): lazy per-story mini-map with no-JS fallback link"
```

---

### Task 6: Docs

**Files:**
- Create: `docs/map-assets.md` (ops note) ; Modify: `CLAUDE.md`

- [ ] **Step 1: `docs/map-assets.md`** — how to produce/deploy the self-hosted basemap: download/extract a Protomaps planet `.pmtiles` capped at max zoom ≈8–10, place it at `<MAP_ASSETS_DIR>/basemap.pmtiles` and glyph fonts under `<MAP_ASSETS_DIR>/fonts/`, served at `/map/` by the `blog` nginx container (range requests). Note the map shows its text fallback until the file is present; the build never requires it. For local dev, drop the same files under `site/public/map/` (git-ignored).

- [ ] **Step 2: `CLAUDE.md`** — in Project Status, mark **Phase 3 (MapLibre travel map)** as **Done** (map page `/karte/` · `/en/map/`, homepage teaser wired, per-story mini-maps; self-hosted pmtiles). Update Remaining to just Phase 4 (DNS cutover). Add `map-data` to the `site/src/lib/` list and note the `travel-map` island.

- [ ] **Step 3: Commit**

```bash
git add docs/map-assets.md CLAUDE.md
git commit -m "docs(map): self-hosted basemap ops note; Phase 3 done"
```

---

## Self-Review

**Spec coverage:** data helper + GeoJSON → T1; i18n → T2; deps + self-hosted serving + gitignore → T3; map page + island (full) + routes + nav + teaser wiring → T4; per-story lazy mini-map + fallback → T5; ops docs + status → T6. Zero-third-party (pmtiles/bundled), no-binaries (gitignore), progressive-enhancement (fallbacks always in DOM; build independent of basemap), `[lng,lat]` order, both-locale i18n — all enforced in the tasks/constraints.

**Placeholder scan:** No TBD/TODO. T1 is full TDD with concrete code/tests. T4/T5 carry concrete island code with an explicit "verify the installed `protomaps-themes-base`/MapLibre API and adapt" instruction (these are client-only and can't be unit-tested; verified via `astro check` + build + visual) — this is a real external-API caveat, not a placeholder. Layout/nav/story-component file names are flagged "find/confirm by reading X" because their exact paths must be confirmed in-repo.

**Type consistency:** `PinFeature`/`PinCollection`/`TripGeometry`/`StopFeature` (T1) are consumed unchanged by `initFullMap`/`initMiniMap` (T4) and `StoryMiniMap` (T5). `tripPins(trips, locale)`, `tripGeometry(trip)`, `mapPath(locale)` signatures match across tasks. i18n keys defined in T2 are exactly those used in T4/T5. GeoJSON `[lng,lat]` order is asserted in the T1 test and relied on by `fitBounds`/`setCenter` in T4.

**Verification honesty:** the unit-tested guarantee is the data layer (T1). The MapLibre islands (T4/T5) are verified by `astro check` + a successful `npm run build` (which must pass WITHOUT the basemap, proving build-independence) + a visual check once the basemap is present (operator step, same class as the WP-import media reachability).
