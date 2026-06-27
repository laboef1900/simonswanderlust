# syntax=docker/dockerfile:1

# Long-running builder: holds the Astro toolchain, builds from Postgres at
# runtime, and atomically publishes into the shared /srv/blog volume nginx serves.
#
# Base images are build ARGs so they can be swapped for Docker Hardened Images:
#   --build-arg NODE_BUILD=dhi.io/<ns>/dhi-node:22-dev
#   --build-arg NODE_RUNTIME=dhi.io/<ns>/dhi-node:22-dev
# @ai-warning: this service runs `npx astro build` AT RUNTIME, so NODE_RUNTIME
# must keep the toolchain (Node + npm + shell) — use the DHI *-dev (SDK) variant,
# NOT the minimal/distroless runtime. Keep NODE_BUILD and NODE_RUNTIME on the
# same OS/libc family (node_modules, incl. sharp's native binary, is copied across).
ARG NODE_BUILD=node:22-slim
ARG NODE_RUNTIME=node:22-slim

# --- deps stage: resolve node_modules from the lockfile (cacheable) ---
FROM ${NODE_BUILD} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- runtime stage: toolchain + app + resolved modules ---
FROM ${NODE_RUNTIME}
WORKDIR /app
ENV NODE_ENV=production \
    RELEASES_DIR=/srv/blog
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
VOLUME ["/srv/blog"]
# @ai-note: a DHI -dev base is non-root; /srv/blog and /app/.build-tmp must be
# writable by that user.
CMD ["node", "build-server.mjs"]
