# Self-Hosted Map Basemap Setup

The travel map (`/karte/` and `/en/map/`) uses a self-hosted vector tileset instead of any third-party tile provider. This guide explains how to obtain, prepare, and deploy the basemap files.

## Overview

The map renders a **Protomaps planet PMTiles file** (`basemap.pmtiles`) and glyph fonts, both served by the `blog` nginx container at `/map/`. The build process is **independent of the basemap files** — if they are not present, the map displays a text/link fallback instead. This enables local development without needing the full production basemap.

## Getting the Basemap

1. **Download a PMTiles file** — Obtain a Protomaps planet extract capped at zoom level **8–10** (covers country/region detail without excessive file size):
   - [Protomaps Downloads](https://protomaps.com/downloads) — extract by region or download the full planet and subset it.
   - Aim for a file in the **500 MB–2 GB** range depending on your region.

2. **Name it** — Rename the file to `basemap.pmtiles`.

3. **Get glyph fonts** — Download Protomaps-compatible glyph font files (`.pbf` format):
   - Check the [protomaps-themes-base](https://github.com/protomaps/protomaps-themes-base) repository for pre-built font glyphs.
   - Or use [fonttools](https://github.com/fonttools/fonttools) to build your own from `.ttf` files.

## Deployment Setup

The map assets are served from a directory specified by the `MAP_ASSETS_DIR` environment variable (default: `/data/map` on the server). The Astro build at deployment time uses the files present in that directory; if files are missing, the build succeeds anyway and the map shows a fallback.

### Production Setup (Server)

1. **Place the basemap file:**
   ```bash
   cp basemap.pmtiles <MAP_ASSETS_DIR>/basemap.pmtiles
   ```

2. **Place glyph fonts:**
   ```bash
   mkdir -p <MAP_ASSETS_DIR>/fonts
   cp *.pbf <MAP_ASSETS_DIR>/fonts/
   ```

3. **Set the environment variable** in your `.env` (or Docker environment):
   ```
   MAP_ASSETS_DIR=/data/map
   ```

4. **Serve via nginx** — The `blog` container's nginx config mounts `MAP_ASSETS_DIR` and serves it at `/map/`:
   ```nginx
   location /map/ {
     alias <MAP_ASSETS_DIR>/;
     autoindex off;
   }
   ```
   The site will request the basemap at URLs like `GET /map/basemap.pmtiles` (with HTTP range requests for tiled access).

### Local Development (without full basemap)

For development on a local machine without the full production basemap:

1. **Create a stub directory:**
   ```bash
   mkdir -p site/public/map/fonts
   ```

2. **Place a small PMTiles file (optional):**
   - Use a tiny regional extract or a test file to speed up local tile rendering.
   - Or leave the directory empty — the map will show its text/link fallback.

3. **Place font files (required for styled labels):**
   - Copy glyph font files to `site/public/map/fonts/`.

4. **Set the environment variable:**
   ```bash
   export MAP_ASSETS_DIR=site/public/map
   ```

5. **Run the dev server:**
   ```bash
   npm run dev
   ```
   The map will request tiles from `/map/basemap.pmtiles`; if the file is present, the styled basemap loads; otherwise, the fallback displays.

> **Note:** `site/public/map/` is **git-ignored**. Store map assets only on the server; keep local copies out of version control.

## How It Works

- **Map script** (`site/src/scripts/travel-map.ts`) initializes MapLibre GL with a style that points to `/map/basemap.pmtiles`.
- **Progressive enhancement** — If the tile file fails to load, the script falls back to a text list of trips and a per-story link (rendered in the HTML as a `<noscript>` fallback).
- **Build independence** — The Astro build (`npm run build` or `astro build`) does not require the basemap files to succeed. The CSS, JavaScript, and HTML are all static and will render correctly.
- **Runtime tile loading** — Once deployed, the browser requests tiles from `/map/` as the user pans and zooms. HTTP range requests make it efficient — only the parts of the PMTiles file relevant to the current viewport are downloaded.

## Troubleshooting

- **Map shows text fallback:** The `basemap.pmtiles` file is not being served at `/map/basemap.pmtiles`, or the HTTP `Range` header requests are blocked. Check nginx logs and ensure the file exists at `<MAP_ASSETS_DIR>/basemap.pmtiles`.
- **Fonts not loading:** Glyph font files (`.pbf`) are not in `<MAP_ASSETS_DIR>/fonts/` or the style URL is incorrect. Verify the font directory and check the browser's network tab for font requests.
- **Local dev without tiles:** This is expected behavior. Drop a small regional PMTiles file into `site/public/map/` to test styled rendering locally.

## References

- [PMTiles](https://pmtiles.io/) — the open-source tile format.
- [Protomaps](https://protomaps.com/) — planet basemap sources and tools.
- [protomaps-themes-base](https://github.com/protomaps/protomaps-themes-base) — Protomaps-compatible MapLibre GL styles and glyph fonts.
- [MapLibre GL](https://maplibre.org/) — client-side rendering library used by the site.
