# syntax=docker/dockerfile:1

# Single app image: Fastify CMS + image service + static blog serving + the
# Astro toolchain for runtime rebuilds (spawned via plain node — no npx/shell,
# so the runtime stays the minimal non-root DHI variant).
#
# Bases default to Docker Hardened Images (requires `docker login dhi.io`),
# matching the image CI publishes to GHCR:
#   NODE_BUILD   dhi.io/node:26-dev   — SDK variant (npm + shell) for the installs
#   NODE_RUNTIME dhi.io/node:26       — minimal, non-root uid 1000, no shell
# The native ownership binding is qualified for this Node 26 / Debian glibc
# family on amd64 and arm64. Other images/libcs require fresh qualification;
# a successful build or lock acquisition alone is not mount approval.
ARG NODE_BUILD=dhi.io/node:26-dev@sha256:c8939885965365c675a024d062bcb761bda4b47e95ce0323aa998ac9bc312fd6
ARG NODE_RUNTIME=dhi.io/node:26@sha256:7312902a19cc5724ca350fb631e397cdb1bd6235c1c3f6905246d92e25842a77

# Self-hosted map basemap + glyph fonts are fetched at build time and baked into
# the image, so the container serves /map/ with zero server-side provisioning.
# The ~524 MB tileset can't live in git; the source build is pinned for
# reproducibility — bump PROTOMAPS_BUILD (see build-metadata.protomaps.dev) for a
# newer planet, or raise MAP_MAXZOOM for more detail (z6≈45MB, z7≈186MB, z8≈520MB).
#
# @ai-warning: a hardcoded PROTOMAPS_BUILD date EXPIRES. build.protomaps.com
# retains only ~5-7 days of daily builds and 404s anything older — measured
# 2026-07-26: 20260722 → 206, 20260719 → 404 — and offers no `latest` alias
# (probed: latest.pmtiles, latest.json, /, index.json all 404). A stale pin does
# not degrade, it fails the build outright, including
# .github/workflows/release.yml on the next v*.*.* tag. That is why the default
# is `auto`: the mapfetch stage resolves the newest build that exists.
# Set an explicit YYYYMMDD to pin a specific planet (it must still be within the
# retention window). The resolved date is recorded at /map-assets/BASEMAP_BUILD
# in the image, so a running container can always report which planet it carries.
ARG PMTILES_VERSION=1.30.3
ARG PROTOMAPS_BUILD=auto
ARG PROTOMAPS_MAX_AGE_DAYS=14
ARG MAP_MAXZOOM=8

# --- owned Node-API lifetime lock: compiler stays in this stage only ---
FROM ${NODE_BUILD} AS native-build
ARG NODE_BUILD
ARG NODE_RUNTIME
ENV NODE_BUILD=${NODE_BUILD} NODE_RUNTIME=${NODE_RUNTIME} DEBIAN_SNAPSHOT=20261029T000000Z
USER 0
WORKDIR /proof
COPY .github/native-owner/owned-flock.c .github/native-owner/build-native.mjs .github/native-owner/container-toolchain.mjs ./
RUN ["node", "-e", "require('node:fs').mkdirSync('/proof/inputs', { recursive: true })"]
RUN ["node", "container-toolchain.mjs"]
COPY uploader/scripts/build-native.mjs /app/uploader/scripts/build-native.mjs
RUN ["node", "/app/uploader/scripts/build-native.mjs", "/proof"]

# --- uploader deps + vendored admin assets ---
FROM ${NODE_BUILD} AS uploader-build
WORKDIR /app/uploader
COPY uploader/package.json uploader/package-lock.json ./
RUN npm ci --omit=dev
COPY uploader/ .
RUN node scripts/copy-fonts.mjs && node scripts/copy-easymde.mjs && node scripts/copy-vendor.mjs
# The build driver and descriptor-test subprocesses are not runtime inputs.
RUN ["node", "-e", "const fs = require('node:fs'); fs.rmSync('scripts/build-native.mjs'); fs.rmSync('test', { recursive: true, force: true });"]

# --- site deps (full install: Astro build needs devDependencies at runtime) ---
FROM ${NODE_BUILD} AS site-build
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci
COPY site/ .

# --- map assets: fetch the Protomaps basemap slice + glyph fonts ONCE, on the
# native build platform (tiles are arch-independent data). Kept off the node
# base so it needs no npm/toolchain and its 524 MB layer caches independently. ---
FROM --platform=$BUILDPLATFORM alpine:3.22 AS mapfetch
ARG PMTILES_VERSION
ARG PROTOMAPS_BUILD
# @ai-warning: a global ARG is NOT in scope inside a stage unless redeclared here.
# Omitting this one leaves it empty and the resolver's `seq 0 ""` fails.
ARG PROTOMAPS_MAX_AGE_DAYS
ARG MAP_MAXZOOM
ARG BUILDARCH
RUN apk add --no-cache curl tar
WORKDIR /work
# pmtiles CLI is a static Go binary (musl-safe); pick the asset for the build arch.
RUN set -eux; \
    case "$BUILDARCH" in amd64) A=x86_64 ;; arm64) A=arm64 ;; *) echo "unsupported build arch: $BUILDARCH" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${A}.tar.gz" | tar -xz pmtiles
# Whole-world z0..MAP_MAXZOOM slice, extracted over HTTP range reads (no full download).
# PROTOMAPS_BUILD=auto resolves the newest build that actually exists, probing back
# day by day; any other value is used verbatim so a build can still be pinned exactly.
# @ai-warning: do NOT replace the probe with a hardcoded date "for reproducibility".
# build.protomaps.com retains only ~5-7 days and has no `latest` alias, so a pin
# fails the build outright (HTTP 404) once it ages out — which takes down
# .github/workflows/release.yml on the next v*.*.* tag, not just local builds.
RUN set -eux; \
    mkdir -p /map/fonts; \
    if [ "${PROTOMAPS_BUILD}" = "auto" ]; then \
      NOW="$(date -u +%s)"; BUILD=""; \
      for i in $(seq 0 "${PROTOMAPS_MAX_AGE_DAYS}"); do \
        D="$(date -u -d "@$((NOW - i * 86400))" +%Y%m%d)"; \
        if curl -fsS -o /dev/null -r 0-0 "https://build.protomaps.com/${D}.pmtiles"; then BUILD="$D"; break; fi; \
      done; \
      [ -n "$BUILD" ] || { echo "no protomaps build found in the last ${PROTOMAPS_MAX_AGE_DAYS} days" >&2; exit 1; }; \
    else \
      BUILD="${PROTOMAPS_BUILD}"; \
    fi; \
    echo "using protomaps build ${BUILD}"; \
    ./pmtiles extract "https://build.protomaps.com/${BUILD}.pmtiles" /map/basemap.pmtiles --maxzoom="${MAP_MAXZOOM}"; \
    ./pmtiles show /map/basemap.pmtiles | head -3; \
    echo "${BUILD}" > /map/BASEMAP_BUILD
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
# uid 1000 = the DHI default user / `node` in node:26-slim. The site tree must
# be writable: astro writes .build-tmp/ and .astro/ during runtime builds.
COPY --from=uploader-build --chown=1000:1000 /app/uploader /app/uploader
COPY --from=native-build --chown=1000:1000 /app/uploader/native /app/uploader/native
COPY --from=site-build --chown=1000:1000 /app/site /app/site
# Basemap + glyph fonts baked in; the app serves them at /map/ (MAP_DIR=/map-assets).
COPY --from=mapfetch --chown=1000:1000 /map /map-assets
WORKDIR /app/uploader
VOLUME ["/data"]
EXPOSE 3000
USER 1000
CMD ["node", "--import", "tsx", "src/main.ts"]
