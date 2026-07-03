# syntax=docker/dockerfile:1

# Single app image: Fastify CMS + image service + static blog serving + the
# Astro toolchain for runtime rebuilds (spawned via plain node — no npx/shell,
# so the runtime stays the minimal non-root DHI variant).
#
# CI overrides the bases with Docker Hardened Images:
#   --build-arg NODE_BUILD=dhi.io/node:22-dev     (npm for the installs)
#   --build-arg NODE_RUNTIME=dhi.io/node:22       (minimal, non-root uid 1000)
# @ai-warning: NODE_BUILD and NODE_RUNTIME must share an OS/libc family —
# sharp's and Astro's native binaries are installed in build stages and copied
# into the runtime.
ARG NODE_BUILD=node:22-slim
ARG NODE_RUNTIME=node:22-slim

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
WORKDIR /app/uploader
VOLUME ["/data"]
EXPOSE 3000
USER 1000
CMD ["node", "--import", "tsx", "src/main.ts"]
