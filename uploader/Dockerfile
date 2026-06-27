# syntax=docker/dockerfile:1

# Base images are build ARGs so they can be swapped for Docker Hardened Images
# without touching the build logic, e.g.:
#   --build-arg NODE_BUILD=dhi.io/<ns>/dhi-node:22-dev   (has npm + shell)
#   --build-arg NODE_RUNTIME=dhi.io/<ns>/dhi-node:22     (minimal, non-root)
# Defaults keep the image buildable with no subscription.
# @ai-warning: NODE_BUILD and NODE_RUNTIME must share the same OS/libc family —
# sharp's native binary is installed in the build stage and copied into the
# runtime, so a Debian build + Alpine/musl runtime (or vice versa) breaks it.
ARG NODE_BUILD=node:22-slim
ARG NODE_RUNTIME=node:22-slim

# --- build stage: install prod deps and vendor the admin-UI assets ---
FROM ${NODE_BUILD} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Self-host the admin UI webfonts + EasyMDE (copied from node_modules; not in git).
RUN node scripts/copy-fonts.mjs && node scripts/copy-easymde.mjs

# --- runtime stage: no build tooling; runs the prebuilt app tree ---
FROM ${NODE_RUNTIME}
WORKDIR /app
ENV NODE_ENV=production \
    STORAGE_DIR=/data/images \
    PORT=3000
COPY --from=build /app ./
VOLUME ["/data"]
EXPOSE 3000
# The runtime base may be distroless (no npm), so invoke node directly; tsx is a
# production dependency that runs the TypeScript entrypoint.
# @ai-note: a DHI runtime is non-root, so /data must be writable by that user
# (chown the mounted volume or run an init container).
CMD ["node", "--import", "tsx", "src/main.ts"]
