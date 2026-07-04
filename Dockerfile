# syntax=docker/dockerfile:1

# Single app image: Fastify CMS + image service + static blog serving + the
# Astro toolchain for runtime rebuilds (spawned via plain node — no npx/shell,
# so the runtime stays the minimal non-root DHI variant).
#
# Bases default to Docker Hardened Images (requires `docker login dhi.io`),
# matching the image CI publishes to GHCR:
#   NODE_BUILD   dhi.io/node:22-dev   — SDK variant (npm + shell) for the installs
#   NODE_RUNTIME dhi.io/node:22       — minimal, non-root uid 1000, no shell
# To build without a DHI subscription, override both with the plain node base:
#   docker build --build-arg NODE_BUILD=node:22-slim --build-arg NODE_RUNTIME=node:22-slim .
# @ai-warning: NODE_BUILD and NODE_RUNTIME must share an OS/libc family —
# sharp's and Astro's native binaries are installed in build stages and copied
# into the runtime.
ARG NODE_BUILD=dhi.io/node:22-dev
ARG NODE_RUNTIME=dhi.io/node:22

# Self-hosted map basemap + glyph fonts are fetched at build time and baked into
# the image, so the container serves /map/ with zero server-side provisioning.
# The ~524 MB tileset can't live in git; the source build is pinned for
# reproducibility — bump PROTOMAPS_BUILD (see build-metadata.protomaps.dev) for a
# newer planet, or raise MAP_MAXZOOM for more detail (z6≈45MB, z7≈186MB, z8≈520MB).
ARG PMTILES_VERSION=1.30.3
ARG PROTOMAPS_BUILD=20260704
ARG MAP_MAXZOOM=8

# --- uploader deps + vendored admin assets ---
FROM ${NODE_BUILD} AS uploader-build
WORKDIR /app/uploader
COPY uploader/package.json uploader/package-lock.json ./
RUN npm ci --omit=dev
COPY uploader/ .
RUN node scripts/copy-fonts.mjs && node scripts/copy-easymde.mjs

# --- site deps (full install: Astro build needs devDependencies at runtime) ---
FROM ${NODE_BUILD} AS site-build
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci
COPY site/ .

# --- map assets: fetch the Protomaps basemap slice + glyph fonts ONCE, on the
# native build platform (tiles are arch-independent data). Kept off the node
# base so it needs no npm/toolchain and its 524 MB layer caches independently. ---
FROM --platform=$BUILDPLATFORM alpine:3.20 AS mapfetch
ARG PMTILES_VERSION
ARG PROTOMAPS_BUILD
ARG MAP_MAXZOOM
ARG BUILDARCH
RUN apk add --no-cache curl tar
WORKDIR /work
# pmtiles CLI is a static Go binary (musl-safe); pick the asset for the build arch.
RUN set -eux; \
    case "$BUILDARCH" in amd64) A=x86_64 ;; arm64) A=arm64 ;; *) echo "unsupported build arch: $BUILDARCH" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${A}.tar.gz" | tar -xz pmtiles
# Whole-world z0..MAP_MAXZOOM slice, extracted over HTTP range reads (no full download).
RUN set -eux; \
    mkdir -p /map/fonts; \
    ./pmtiles extract "https://build.protomaps.com/${PROTOMAPS_BUILD}.pmtiles" /map/basemap.pmtiles --maxzoom="${MAP_MAXZOOM}"; \
    ./pmtiles show /map/basemap.pmtiles | head -3
# Glyph fonts the Protomaps theme requests (Noto Sans Regular/Medium/Italic; tracks main).
RUN set -eux; \
    curl -fsSL "https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.tar.gz" | tar -xz; \
    for f in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do \
      cp -R "basemaps-assets-main/fonts/$f" /map/fonts/; \
    done; \
    rm -rf basemaps-assets-main

# --- runtime: both trees, non-root, no build tooling ---
FROM ${NODE_RUNTIME}
ENV NODE_ENV=production \
    STORAGE_DIR=/data/images \
    SITE_APP_DIR=/app/site \
    SITE_DIR=/data/site \
    MAP_DIR=/map-assets \
    PORT=3000
# uid 1000 = the DHI default user / `node` in node:22-slim. The site tree must
# be writable: astro writes .build-tmp/ and .astro/ during runtime builds.
COPY --from=uploader-build --chown=1000:1000 /app/uploader /app/uploader
COPY --from=site-build --chown=1000:1000 /app/site /app/site
# Basemap + glyph fonts baked in; the app serves them at /map/ (MAP_DIR=/map-assets).
COPY --from=mapfetch --chown=1000:1000 /map /map-assets
WORKDIR /app/uploader
VOLUME ["/data"]
EXPOSE 3000
USER 1000
CMD ["node", "--import", "tsx", "src/main.ts"]
