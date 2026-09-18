# Map teaser: real geography behind the pins

**Date:** 2026-09-18
**Status:** implemented
**Risk:** normal (was assessed as high while a PMTiles-derived build step was on the table — see §3)
**Driver:** the 2026-09-18 homepage critique, priority issue *"the map band spends 43% of a mobile
viewport and names no place"*.

## 1. The problem

`MapTeaser.astro` is the first band after the hero. It is 365px tall at 390×844 — 43% of the first
scroll — and 342px at 1440×900. Its heading promises **"Wo ich gewesen bin" / "Where I've been"**
and its graphic answers with nine 4.2px dots (8.5px desktop) on a bare graticule: no coastlines, no
country names, no interaction. Closest pin pair 13.3px apart at mobile width.

The graphic cannot answer its own heading. Reading a dot at 90°W/15°N as *Mexico* requires the
reader to hold a lat/long→country mapping in working memory, which the critique's cognitive-load
pass scored as a failure. The band is also the only thing on the page selling the real
MapLibre/PMTiles map — the most technically distinctive artifact in the project — and it sells it
with a picture that looks like a loading state.

Two further measurements from the same review:

- The bundled design detector flagged all nine degree labels for contrast. The **medians clear AA at
  desktop width (9.80:1 measured by pixel readback), but fall to 2.7–4.4:1 at 390px** — `45°E` at
  2.7:1 against a 3:1 need. That is the SVG-`font-size`-is-in-viewBox-units mechanism the existing
  `@ai-warning` in the component already describes, one notch worse than that warning assumed.
- The band's own payload is a heading, a stat line, a button and the dots. Nothing else.

## 2. The decision

Draw **real, measured coastlines** under the existing graticule and pins.

This directly contradicts the standing `@ai-warning` in `site/src/lib/map-chart.ts`:

> No coastlines. A hand-authored world silhouette would be an invented picture, and the projection
> here is honest instead […] Do not "improve" this with an approximate landmass path.

That rule is kept, not broken, because its subject was **invented** geography. The rule is rewritten
to say what it always meant: *measured coastlines only, never a drawn one.* A surveyed public-domain
coastline is the same class of truth as the coordinates already plotted on the chart. A smoothed,
stylised, or hand-tidied outline remains banned, and so does any decoration that is not data.

The invariant that survives unchanged: **no line joining the pins.** Each pin is a separate trip.

## 3. Why the asset is committed, and not derived from the basemap we already host

The obvious source is the basemap the app already self-hosts at `/map/`. It was rejected, and this is
the load-bearing decision in this spec.

That basemap is a **~524 MB Protomaps PMTiles slice fetched by the `mapfetch` stage of the repo-root
`Dockerfile` and baked into the image** at `/map-assets` (`docker-compose.yml` mounts nothing;
`server.ts` serves it via `cfg.mapDir`). It does not exist in a checkout, in CI, or on the author's
laptop — only inside a built image. The site build runs *inside* the app container in production, so
a PMTiles-derived build step would work there and **fail everywhere else**:

| Gate | With a PMTiles-derived build step |
|---|---|
| `npm run build` in `site/` | fails — no `/map-assets` |
| `npx astro check` | fails — the loader chain would need the tileset |
| `.github/workflows/ci.yml` (runs the full `astro build`) | fails — the tileset is not in CI |

`CLAUDE.md` treats all three as authoritative. Trading them for a silhouette is not a trade this
band is worth. It would also add a vector-tile decode step to the critical path of every publish.

**Chosen source:** Natural Earth **1:110m land** (`ne_110m_land`, public domain, no attribution
required), fetched once by `site/scripts/build-coastlines.mjs` and committed as
`site/src/lib/coastlines.ts` — 128 rings, 4,087 points, 53 KB of text. Same kind of truth, no
container coupling, byte-identical in dev, CI and production. Precedent for a committed generator
plus its output: `site/scripts/migrate-stub-posts.mjs`.

Rejected alternatives:

- **Named destination chips instead of a chart** (the critique's option b). Cheaper and honest, but
  it deletes the only cartography on the page and leaves the real map unsold. Kept on file as the
  fallback if the silhouette ever fails to earn its bytes.
- **A third-party static map image.** Zero third-party runtime requests is a project commitment.
- **Shipping the rings to the browser and projecting client-side.** The band is server-rendered and
  the page ships zero JavaScript today. Projecting at build time keeps both properties.

## 4. Implementation

Three files, one of them generated.

**`site/scripts/build-coastlines.mjs`** (new, one-off, plain Node ESM — no dependency added). Fetches
the layer, simplifies each ring with iterative Ramer–Douglas–Peucker at **0.1°**, drops rings whose
bounding box is under 0.4° on both axes, sorts longest-first, and writes the module with its own
provenance (source URL, licence, retrieval date, point counts) in the header.

- 0.1° is deliberate: the chart is 1000 viewBox units over ~140° of longitude (~7 units/degree) and
  renders ~0.7 CSS px per unit, so 0.1° is about half a rendered pixel at the widest the band gets.
  Coarser eats recognisable coast, and the Danish and Greek coastlines are two of the nine
  destinations.

**`site/src/lib/land-path.ts`** (new, pure, `astro:`-free). Clips rings to the chart's window with
Sutherland–Hodgman (exact for a convex rectangle), projects the survivors, simplifies again **in
projected units**, and emits one `d` string of closed subpaths.

- **Clip before projecting.** An unclipped Eurasian ring projects to tens of thousands of units
  off-frame, and the browser parses and paints every one of them.
- **Second simplification pass, 2 units.** The rings arrive simplified for the *widest* window; a
  narrow window magnifies them. Measured on the live nine-trip window: 1.2 units emitted 9,486 bytes
  of `d`, 2 units emits **4,378**. A quarter of the page's HTML for a silhouette at 0.14 opacity was
  not worth it. 2 units is ~1.4 CSS px desktop, ~0.7 px stacked.
- **Integer coordinates.** Worth ~2,000 bytes; costs at most a third of a pixel.
- **Rings under 8 sq units dropped.** A 3-unit island reads as a stray dot beside pins that are 6
  units across.
- Returns `''` when nothing survives, so the caller omits the element rather than emitting `d=""`.

**`site/src/lib/map-chart.ts`**: `MapChart` gains `land: string`, computed where the window is known.
**`site/src/components/MapTeaser.astro`**: renders the path as the **first** child of the SVG, under
the graticule and the pins, with `fill-rule="evenodd"` (the source layer has one hole),
`fill-opacity 0.14`, `stroke-opacity 0.32`, `stroke-width 1.5` — no gradient, no shadow, no stroke
heavier than the gridlines it sits under. A coastline drawn heavier than the parallels above it would
invert the band's claim that the grid is the measuring tool.

**Band height**: the stacked layout's padding and gap were tightened (`py-8`/`gap-6` below `lg`,
unchanged above) because the chart itself cannot shrink without breaking the label-size cap the
component's existing `@ai-warning` records. The slack came out of whitespace, not out of the data.

**Accessible name**: `home.mapTeaser.chartLabel` now says the pins sit on a map of coastlines, in
both locales, because a screen-reader user should not be told it is a bare grid.

## 5. Invariants

1. **Measured coastlines only.** Never hand-edit `coastlines.ts`; never substitute a "nicer looking"
   outline. Every coordinate on screen is surveyed or it does not ship.
2. **No route line joining the pins** (pre-existing, unchanged).
3. **Land renders under the graticule and pins**, never over, and never heavier than them.
4. **`coastlines.ts` is build-time only.** Importing it into anything that reaches a browser bundle
   ships ~50 KB of mostly Pacific coast to a reader. `map-chart.ts` and `land-path.ts` are the only
   consumers.
5. **The emitted `d` stays within the viewBox.** Guaranteed by clipping, pinned by tests in both
   `land-path.test.ts` and `map-chart.test.ts`.
6. **Re-measure the emitted byte count** after touching either tolerance. The band is on the home
   page, the one document a first-time visitor pays for in full.

## 6. Verification

- `site/src/lib/land-path.test.ts` (new, 11 cases): rings outside the window drop; interior rings
  pass through unchanged; a straddling ring is cut along the frame with interpolated crossings, not
  snapped to a corner; collinear runs collapse; holes survive as their own subpath; specks drop; and
  no emitted coordinate escapes the viewBox however far the source ring overhangs.
- `site/src/lib/map-chart.test.ts` (extended): the real nine-trip corpus draws land, entirely inside
  the frame; a mid-South-Pacific window degrades to the bare graticule and emits `''`.
- Visual confirmation at 1440×900 and 390×844 in both locales, plus a re-measurement of the degree
  labels' pixel contrast at 390px, recorded in the review thread.

## 7. Residual risk

- **Label contrast at 390px** (2.7–4.4:1 medians) is a pre-existing defect that the silhouette
  changes the backdrop of. It was re-measured after this change rather than assumed; if the land fill
  moves a label below 3:1, the fill is wrong, not the label.
- **Source refresh** is manual. Natural Earth 110m coastlines do not move meaningfully, and a pinned
  committed asset is the point; `build-coastlines.mjs` exists for a deliberate re-run, not a
  scheduled one.
