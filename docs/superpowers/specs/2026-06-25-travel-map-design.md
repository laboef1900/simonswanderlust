# Design — Travel Map (Phase 3)

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — ready for implementation planning
**Builds on:** the existing trip schema (`coordinates`/`stops`/`route` already present), the
`MapTeaser` placeholder component, and the i18n/route helpers. Realises the map called for in the
redesign spec (`docs/superpowers/specs/2026-06-11-blog-redesign-design.md` §Map).

## Problem

The redesign promised a Polarsteps-style travel map, but it isn't built: the homepage `MapTeaser`
shows "coming soon", there is no map page, and story pages have no mini-map — even though every trip
already carries `coordinates` (+ optional `stops`/`route`).

## Goals

- A **dedicated map page** (`/karte/` · `/en/map/`) plotting all trips as pins; clicking a pin opens
  a popup linking to that story **in the active locale**.
- Wire the **homepage teaser** to the real map page (drop "coming soon").
- A **per-story mini-map** showing that trip's pin (+ `stops` markers when present).
- **MapLibre GL JS** is the only JS island; **self-hosted pmtiles** basemap → **zero third-party
  requests**. Everything degrades gracefully without JS.

## Non-Goals (YAGNI)

- No clustering (9 pins don't need it).
- No route **lines** in v1 — `route` is a freeform string in the schema today (no geometry), so the
  mini-map plots the pin + `stops` markers only; route-line drawing comes later (per the redesign spec)
  when real route geometry exists.
- No third-party tiles, API keys, or accounts.
- No server-side static map-image rendering (the mini-map/teaser fallbacks are text/links, not images).
- No search/filter UI on the map page (v1 plots all trips).

## Source facts (verified)

- Trip schema (`site/src/content.config.ts`): `coordinates: {lat,lng}`, `stops?: {name,lat,lng}[]`,
  `route?: string`, plus `country`, `countryCode`, `region`.
- `site/src/lib/paths.ts` holds route helpers (`homePath`, `aboutPath`, `regionsIndexPath`,
  `regionPath`); `Region = 'europe'|'north-america'|'south-america'`. **New routes are not WP slugs**,
  so there is no SEO-slug conflict — but they are registered here for consistency.
- `site/src/components/MapTeaser.astro` already computes `trips`/`countries`/`continents` via
  `byLocale(await getCollection('trips'), locale)` and renders a CTA reading
  `t('home.mapTeaser.cta') — t('home.mapTeaser.soon')`. Wiring = make the CTA a link and drop `soon`.
- `site/src/i18n/ui.ts` holds all UI strings for both locales (completeness-tested). `stats.trips`/
  `stats.countries`/`stats.continents` and `home.mapTeaser.*` already exist.
- No map library is installed.

## Architecture

### 1. Data layer — `site/src/lib/map-data.ts` (pure, unit-tested)

`tripPins(entries, locale)` → a GeoJSON `FeatureCollection` of `Point`s, one per trip at its
`coordinates`, with `properties: { title, href, country, region }` where `href` is the localized
story path (reuse the existing path logic used by story links). Optional helper for a single trip's
mini-map geometry: `tripGeometry(entry)` → the pin Point + one Point per `stops` entry (no route line
in v1 — see Non-Goals). All pure functions over the
already-loaded collection; **Vitest-covered** (correct coordinates, localized hrefs, stops/route
inclusion, all-trips coverage, empty-collection safety). The page embeds the output as a
`<script type="application/json">` block (build-time; no runtime fetch).

### 2. Map island — `site/src/scripts/travel-map.ts` (client)

A single client module that:
- registers the `pmtiles` protocol with MapLibre and points the basemap source at the self-hosted
  `.pmtiles` (relative URL on the same origin);
- builds the style from `protomaps-themes-base` (a chosen flavor, e.g. "light") with `glyphs` pointing
  at the self-hosted font path;
- adds the embedded GeoJSON as a source + a pin layer (circle/symbol), wires click → popup
  (`properties.title` + a localized "read story" link via `properties.href`), and fits bounds to all
  features;
- exposes an init usable in two modes: **full** (map page — all pins, fit-to-all) and **mini**
  (story page — one trip's geometry, centered/zoomed to it).
`maplibre-gl` + `pmtiles` are **bundled** by Astro/Vite — no CDN.

### 3. Placements

- **Map page** — `site/src/pages/karte.astro` (DE) + `site/src/pages/en/map.astro` (EN), both thin
  routes rendering a shared `site/src/components/pages/MapPage.astro`. Full-height map container with
  the embedded GeoJSON; the island initializes in **full** mode. **No-JS / tile-failure fallback**
  (always in the DOM, hidden once the map boots): trips listed by region, each linking to its story.
  Add a **Map** link to the primary nav (`nav.map`).
- **Homepage teaser** — modify `MapTeaser.astro`: the CTA becomes a link to `mapPath(locale)`; remove
  the `soon` text and the `home.mapTeaser.soon` string usage. **Homepage stays zero-JS** (no island).
- **Per-story mini-map** — a `site/src/components/StoryMiniMap.astro` rendered on the story layout,
  given the trip's embedded geometry. The island initializes in **mini** mode **lazily** via
  `IntersectionObserver` (only when scrolled into view) to keep story pages light. **No-JS fallback:**
  a "view on the map" link to the map page.

### 4. Self-hosted map assets (operational)

- **`basemap.pmtiles`** — a Protomaps planet build capped at a **moderate max zoom (≈ z8–10)** for an
  overview travel map (≈ low-single-digit GB; full street-zoom planet ~100 GB is out of scope). It is
  a **binary, git-ignored** (Golden Rule 3), placed on the server and served as a **static file with
  HTTP range support** by the `blog` nginx container from a **mounted volume** (e.g. `/map/basemap.pmtiles`).
  Dev/build also need a copy at a known path; if absent, the map simply shows its fallback (build must
  not fail without it).
- **Glyph fonts** (PBF) self-hosted under `/map/fonts/{fontstack}/{range}.pbf`; `protomaps-themes-base`
  supplies the style layers. No sprites required for the base theme (text + vector layers).
- Compose/nginx wiring: a volume + a `location /map/` serving the pmtiles + fonts with range requests;
  documented in `.env.example`/compose and `authoring`/ops docs.

## Error handling / progressive enhancement

Every map is an enhancement layered over a usable static page:
- No JS, MapLibre throw, or missing/unreachable basemap → the static fallback remains (map page = trip
  list; mini-map = link; teaser = static strip + CTA). The map container is only revealed after a
  successful `map.on('load')`.
- The build never depends on the basemap file (it's a runtime asset) — `astro build` succeeds without it.

## Testing

- **Vitest** (`site/test/`): `tripPins`/`tripGeometry` — coordinates, localized hrefs, stops/route
  features, all-trips coverage, empty-collection safety. i18n completeness test already guards the new
  `ui.ts` keys.
- The MapLibre island is client-only — verified visually (`npm run dev`): pins for all trips, popups
  link to the correct story per locale, fit-bounds, mini-map per story, no-JS fallback (disable JS).
- `npx astro check` + `npm test` green (note: both need a reachable Postgres for the loader).

## Dependencies

- New `site` deps: **`maplibre-gl`**, **`pmtiles`**, **`protomaps-themes-base`** (all self-hosted/bundled,
  no CDN). MapLibre is ~200 KB gzip but loads only on the map page + lazily on story pages.

## Operational notes (for deploy)

Generating/deploying `basemap.pmtiles` (Protomaps planet extract at the chosen max zoom) is a
**deploy-time step on the server**, like the WordPress import's media reachability — documented, not
automated by the build. The map works the moment the file is present and serves the fallback until then.

## Risks

- **Basemap size vs. detail:** higher max zoom = larger file. ≈z8–10 balances overview clarity against
  storage; revisit if street-level detail is wanted later (regional extracts are an option).
- **MapLibre payload:** mitigated by loading it only on the map page and lazily on story pages; the
  homepage and all other pages stay zero-JS.
- **Asset availability:** the basemap/fonts are runtime assets outside git; the fallback covers their
  absence so nothing breaks if they're missing in a given environment.
