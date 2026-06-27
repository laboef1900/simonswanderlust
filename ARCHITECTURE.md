# Architecture

This repo is a monorepo for [simonswanderlust.com](https://simonswanderlust.com): a **static**
Astro blog whose content is authored through a **self-hosted CMS** and built from **Postgres** at
runtime. Everything runs in Docker on Simon's own server. This document describes the components,
how content flows from keyboard to published page, and the trust boundaries. For the security
posture specifically, see [SECURITY.md](SECURITY.md).

## Components

| Service (compose) | Image / build | Role | Exposure |
| :-- | :-- | :-- | :-- |
| `blog` | `nginx:alpine` | Serves the built static site from a shared volume; reverse-proxies `/admin/`, `/upload`, `/suggest` to the uploader; serves the `/map/` PMTiles basemap | Public (via host port → reverse proxy / TLS) |
| `blog-builder` | `./site` (`build-server.mjs`) | Long-running, secret-gated HTTP server that runs `astro build` **from Postgres** into the shared volume | Internal only (`:4000`) |
| `images` (uploader) | `./uploader` (Fastify) | Admin CMS: editor, WordPress import, AI alt-text, image optimization (sharp); also serves the optimized images | Public (behind the proxy) |
| `db` | `postgres:17-alpine` | Source of truth for posts, users, and sessions | Internal only (`:5432`) |

Shared state:
- **`blog-dist`** volume — the built static site. `blog-builder` writes it, `blog` (nginx) reads it.
- **`/data`** volume (uploader) — optimized image variants, MDX backups, and `settings.json`.
- **`pgdata`** volume — Postgres data.

```
                         ┌──────────────────────── browser ────────────────────────┐
                         │  reader                                  author / admin   │
                         └──────┬───────────────────────────────────────┬───────────┘
                                │ GET simonswanderlust.com               │ /admin/  /upload  /suggest
                                ▼                                        ▼
                         ┌──────────────┐   proxy /admin /upload /suggest┌──────────────┐
                         │  nginx (blog)│ ─────────────────────────────► │  uploader    │
                         │  root:        │                               │  Fastify 5   │
                         │  /srv/blog/   │                               │  + sharp     │
                         │   current     │                               └──────┬───────┘
                         └──────▲───────┘                                        │ pg + fs
                  blog-dist     │ static files                                   ▼
                   volume       │                                         ┌──────────────┐
                         ┌──────┴───────┐  POST /build (x-build-secret)   │  Postgres    │
                         │ blog-builder │ ◄───── triggered on Publish ────│ posts/users/ │
                         │ astro build  │ ─────── reads published ───────►│  sessions    │
                         │ from Postgres│                                 └──────────────┘
                         └──────────────┘
```

## Content pipeline (keyboard → published page)

1. **Author** writes a post (DE + EN) in the in-admin editor (`/admin/editor.html`, EasyMDE). Body
   is Markdown; hero and body photos are uploaded inline and optimized by the uploader.
2. **Store** — drafts and published posts live in the Postgres `posts` table (one row per locale).
   Postgres is the source of truth; git holds no content.
3. **Publish** — the editor calls `POST /posts/:tk/publish` (admin-only). The uploader validates the
   post, flips its status to `published`, exports an MDX backup to `/data/backup` (best-effort), and
   triggers a rebuild via `triggerBuild` → `blog-builder`.
4. **Build** — `blog-builder` (`site/build-server.mjs`) runs `astro build`. Astro's Content Layer
   loader (`site/src/lib/postgres-loader.ts`) `SELECT`s the published rows and turns each into a
   content entry. Post bodies are rendered Markdown → HTML, **sanitized**, and body images become
   responsive `<picture>` (`site/src/lib/body-images.ts`).
5. **Release** — the build is written to a fresh `releases/<timestamp>` dir on the `blog-dist`
   volume, then the `current` symlink is **atomically** swapped to it (old releases pruned, keeping
   the last 3). nginx serves `current`.

The Astro entry `id`s (`de/<slug>` / `en/<slug>`) and the Zod schema are unchanged from the original
MDX era, so the SEO slug contract (`site/src/lib/paths.ts`, `trips.ts`) holds: **DE at root, EN under
`/en/`** — slugs are never renamed.

## Image pipeline

The uploader optimizes each photo into AVIF + WebP at fixed widths (640/1280/1920 plus the source
width, never upscaled), preserving EXIF/GPS. Files are content-addressed as `{key}-{width}.{format}`
under `STORAGE_DIR` and served with a one-year immutable cache. `heroImage` is a remote URL object
`{src,width,height,alt}`; body images are referenced by URL and rendered as `<picture>` at build
time. This contract is mirrored on the blog side in `site/src/lib/images.ts`.

Optional **AI alt text**: the batch uploader can call a local LM Studio (qwen-VL) to suggest
DE + EN alt text and a slug for body photos. The server never needs to reach the model; it is
configured per-deployment and runs on the author's machine.

## Data model (Postgres)

Created idempotently by `uploader/src/db.ts` (`ensureSchema`):

- **`users`** — `id`, `username` (unique, case-insensitive), `password_hash` (scrypt), `is_admin`, `created_at`.
- **`sessions`** — `id` (SHA-256 of the random token), `user_id` (FK, cascade), `expires_at`. Expired rows are swept hourly.
- **`posts`** — one row per (`translation_key`, `locale`); `slug`, `title`, `date`, `country`, `country_code`, `region`, `excerpt`, `hero_image` (jsonb), `coordinates` (jsonb), optional `stops`/`route`/`key_facts`, `body_markdown`, `images` (jsonb), `status` (`draft`/`published`). Unique on (`locale`, `slug`).

## Build & deploy flow (`build-server.mjs`)

- Boots with an initial build, then serves two routes:
  - `GET /health` — 200 once `current` exists.
  - `POST /build` — gated by a constant-time `x-build-secret` check; builds and atomically releases.
- Builds into a CWD-local tmp dir first (so Astro's prerender `rename()` stays on-device), then
  `cp`s to the volume — avoiding `EXDEV` across the Docker volume boundary.
- Concurrent builds are rejected (a single in-flight flag).

## Configuration (environment)

| Var | Used by | Purpose |
| :-- | :-- | :-- |
| `DATABASE_URL` | uploader, blog-builder | Postgres connection (content + auth) |
| `BUILD_SECRET` | uploader, blog-builder | Shared secret authorizing a rebuild trigger |
| `BUILDER_URL` | uploader | Where to POST `/build` (default `http://blog-builder:4000`) |
| `PUBLIC_BASE_URL` | uploader | Public base for image URLs (e.g. `https://img.simonswanderlust.com`) |
| `STORAGE_DIR` / `BACKUP_DIR` | uploader | On-disk image variants / MDX backups |
| `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` | uploader | Local AI alt-text endpoint (optional) |
| `RELEASES_DIR` / `BUILD_PORT` | blog-builder | Release root on the volume / listen port |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | db | Database bootstrap |

## Trust boundaries

- **Public, unauthenticated:** the static blog (read-only files) and the optimized images.
- **Public, authenticated:** the uploader admin (`/admin/`) and its API — session-cookie gated,
  with admin-only operations (publishing, user management). Must sit behind a TLS-terminating
  reverse proxy.
- **Internal only:** Postgres and `blog-builder` are not exposed to the internet; the only way to
  trigger a build from outside is the secret-gated `POST /build`, reached via the uploader.

See [SECURITY.md](SECURITY.md) for how each boundary is enforced.
