# Self-Hosted Map Basemap Setup

The travel map (`/karte/` and `/en/map/`) uses a self-hosted vector tileset instead of any third-party tile provider. This guide explains how to obtain, prepare, and deploy the basemap files.

## Overview

The map renders a **Protomaps planet PMTiles file** (`basemap.pmtiles`) and glyph fonts, both served by the **`app` container (Fastify)** at `/map/` — with `Accept-Ranges: bytes` and `.pmtiles`/`.pbf` MIME types, so PMTiles' random-access range reads work (`uploader/src/server.ts`). The build process is **independent of the basemap files** — if they are not present, the map displays a text/link fallback instead. This enables local development without needing the full production basemap.

## Getting the Basemap (exact recipe)

The full Protomaps planet is ~136 GB, so we **extract a low-zoom whole-world slice**
(`z0–8`, ~520 MB) directly from it over HTTP range requests — no full download, no build
toolchain. `z8` gives city-level detail and matches the per-story mini-map's zoom; raise
`--maxzoom` for more detail at the cost of size (z6 ≈ 45 MB, z7 ≈ 186 MB, z8 ≈ 520 MB,
z9 ≈ 2 GB).

1. **Install the `pmtiles` CLI** (the maintained Protomaps tool):
   ```bash
   brew install pmtiles          # macOS; see github.com/protomaps/go-pmtiles for other OSes
   ```

2. **Find the latest planet build key** (dated `YYYYMMDD.pmtiles`; the index lists every build):
   ```bash
   curl -s https://build-metadata.protomaps.dev/builds.json \
     | python3 -c "import sys,json; print(json.load(sys.stdin)[-1]['key'])"
   # e.g. 20260624.pmtiles  (a v4 tileset — matches protomaps-themes-base@4.x)
   ```

3. **Extract the whole-world z0–8 basemap** (replace the dated key from step 2):
   ```bash
   pmtiles extract https://build.protomaps.com/20260624.pmtiles \
     <MAP_ASSETS_DIR>/basemap.pmtiles --maxzoom=8
   pmtiles show <MAP_ASSETS_DIR>/basemap.pmtiles   # verify: tile type mvt, max zoom 8
   ```

4. **Get the glyph fonts** — the theme requests three stacks (**Noto Sans Regular / Medium /
   Italic**); their `.pbf` glyphs live in `protomaps/basemaps-assets`:
   ```bash
   git clone --depth 1 https://github.com/protomaps/basemaps-assets.git /tmp/pm-assets
   mkdir -p <MAP_ASSETS_DIR>/fonts
   for f in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
     cp -R "/tmp/pm-assets/fonts/$f" "<MAP_ASSETS_DIR>/fonts/"
   done
   ```

   The result is `<MAP_ASSETS_DIR>/basemap.pmtiles` + `<MAP_ASSETS_DIR>/fonts/<stack>/<range>.pbf`,
   served at `/map/basemap.pmtiles` and `/map/fonts/<stack>/<range>.pbf`.

## Deployment Setup

The host directory holding the assets is named by the `MAP_ASSETS_DIR` env var (default `./map-assets`). `docker-compose.yml` bind-mounts it **read-only** into the `app` container at `/map-assets`, and the app serves it at `/map/` (`MAP_DIR=/map-assets` inside the container). The Astro build is independent of these files — if they are missing, the build still succeeds and the map shows its fallback. Because the mount is a bind mount, dropping the files into the host `MAP_ASSETS_DIR` makes a running container serve them immediately — no image rebuild needed.

### Production Setup (Server)

1. **Place the basemap file** in the host asset dir (whatever `MAP_ASSETS_DIR` points at):
   ```bash
   cp basemap.pmtiles <MAP_ASSETS_DIR>/basemap.pmtiles
   ```

2. **Place glyph fonts** (one subdir per font stack, `.pbf` glyphs inside):
   ```bash
   mkdir -p <MAP_ASSETS_DIR>/fonts
   cp -R "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic" <MAP_ASSETS_DIR>/fonts/
   ```

3. **Set the env var** in your `.env` if you don't use the `./map-assets` default:
   ```
   MAP_ASSETS_DIR=./map-assets
   ```

4. **That's it — no web-server config.** The `app` container serves `GET /map/basemap.pmtiles` and `GET /map/fonts/<stack>/<range>.pbf` directly (with range support), so a `docker compose up -d` (or just the files appearing on the host, since the mount is live) is all it takes.

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
   export MAP_ASSETS_DIR=./map-assets
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

- **Map shows text fallback / blank map:** `/map/basemap.pmtiles` is 404ing (the file isn't in `<MAP_ASSETS_DIR>`) or range requests are blocked. Quick check against a running stack: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/map/basemap.pmtiles` should be `200`, and `curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' http://localhost:3000/map/basemap.pmtiles` should be `206`. If both 404, the asset dir is empty — provision it per "Getting the Basemap" above.
- **Fonts not loading:** Glyph font files (`.pbf`) are not in `<MAP_ASSETS_DIR>/fonts/` or the style URL is incorrect. Verify the font directory and check the browser's network tab for font requests.
- **Local dev without tiles:** This is expected behavior. Drop a small regional PMTiles file into `site/public/map/` to test styled rendering locally.

## References

- [PMTiles](https://pmtiles.io/) — the open-source tile format.
- [Protomaps](https://protomaps.com/) — planet basemap sources and tools.
- [protomaps-themes-base](https://github.com/protomaps/protomaps-themes-base) — Protomaps-compatible MapLibre GL styles and glyph fonts.
- [MapLibre GL](https://maplibre.org/) — client-side rendering library used by the site.
