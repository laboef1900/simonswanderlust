# Architecture

This repo is a monorepo for [simonswanderlust.com](https://simonswanderlust.com): a **static**
Astro blog whose content is authored through a **self-hosted CMS** and built from **Postgres** at
runtime. Everything runs in Docker on Simon's own server, as **one application container + one
database container** (WordPress-style). This document describes the components, how content flows
from keyboard to published page, and the trust boundaries. For the security posture specifically,
see [SECURITY.md](SECURITY.md).

## Components

| Service (compose) | Image | Role | Exposure |
| :-- | :-- | :-- | :-- |
| `app` | `ghcr.io/laboef1900/simonswanderlust-app` (built from the repo-root `Dockerfile`, DHI node base) | Single Fastify 5 process: admin CMS (editor, WordPress import), image service (sharp, host-routed on the img subdomain), public blog static serving, in-process `astro build` on Publish/boot/manual rebuild, `/map/` PMTiles basemap, and DB backups | Public (via host port → reverse proxy / TLS) |
| `db` | `postgres:18-alpine` | Source of truth for posts, users, and sessions | Internal only (`:5432`) |

The `app` image is **released to GHCR** by CI and pulled on the server (pinned via `IMAGE_TAG`).
`docker-compose.yml` has no `build:` key, so `docker compose up -d --build` is a no-op — to build
the image locally, run `docker build .` from the repo root instead. See [Packaging & release
pipeline](#packaging--release-pipeline). Note: rebuilding the image does not regenerate the
already-built blog on `/data` — see [docs/authoring-workflow.md](docs/authoring-workflow.md)
(Stage 3: How the rebuild works).

Shared state, all under the **`/data`** volume (bind-mounted from `./uploader/data`):
- `images/` — optimized image variants plus the untouched upload originals
  (`{key}-orig.<ext>`) (`STORAGE_DIR`).
- `site/releases/<stamp>` + `site/current` (symlink) — built static output (`SITE_DIR`).
- `backup/` — MDX export backups; `backup/db/` — gzipped Postgres dumps and incremental
  image archives.
- `settings.json` — admin-configurable settings (backup schedule/retention).

Plus the **`pgdata`** volume — Postgres data.

```
                         ┌──────────────────────── browser ────────────────────────┐
                         │  reader (blog + images)                 author / admin   │
                         └──────┬───────────────────────────────────────┬───────────┘
                                │ GET simonswanderlust.com/*             │ /admin/  /upload
                                │ GET img.simonswanderlust.com/*         │ /backups  /rebuild
                                ▼                                        ▼
                         ┌───────────────────────────────────────────────────────────┐
                         │  app — Fastify 5, single process, host-routed             │
                         │   img host → /data/images (variants, 1y cache)            │
                         │   main host → /data/site/current (blog) · /map-assets     │
                         │   any host → /admin/*, /upload, /backups, /rebuild, ...   │
                         └───────────┬───────────────────────────┬───────────────────┘
                                      │ pg                        │ spawn(node astro.mjs build)
                                      ▼                            ▼
                               ┌──────────────┐          /data/site/releases/<stamp>
                               │  Postgres    │          → current (atomic symlink flip)
                               │ posts/users/ │
                               │  sessions    │
                               └──────────────┘
```

## Content pipeline (keyboard → published page)

1. **Author** writes a post (DE + EN) in the in-admin editor (`/admin/editor.html`, EasyMDE). Body
   is Markdown; hero and body photos are uploaded inline and optimized by the app's image pipeline.
2. **Store** — drafts and published posts live in the Postgres `posts` table (one row per locale).
   Postgres is the source of truth; git holds no content.
3. **Publish** — the editor calls `POST /posts/:tk/publish` (admin-only). The app validates the
   post, flips its status to `published`, exports an MDX backup to `/data/backup` (best-effort),
   and **awaits the in-process build** (`buildSite()`) before responding — no HTTP hop, no shared
   secret.
4. **Build** — `createSiteBuilder` (`uploader/src/build.ts`, ported from the retired
   `build-server.mjs`) spawns `astro build` **via plain node**
   (`node node_modules/astro/bin/astro.mjs build`, no npx/npm/shell) with `cwd=/app/site` and
   `ASTRO_TELEMETRY_DISABLED=1`. Astro's Content Layer loader (`site/src/lib/postgres-loader.ts`)
   `SELECT`s the published rows and turns each into a content entry. Post bodies are rendered
   Markdown → HTML, **sanitized**, and body images become responsive `<picture>`
   (`site/src/lib/body-images.ts`). A ` ```gallery ` fence (one image URL per line) becomes a
   photo gallery in the same pass, in one of three layout modes selected by a `#layout:` line
   inside the fence — `breakout` (default; justified rows in a 1112px full-bleed break-out),
   `column` (the same rows at the 728px story width) or `slider` (a scroll-snap carousel).
   The row partition is computed at build time by `site/src/lib/gallery-layout.ts`, which is
   kept pure and dependency-free because draft preview runs it under `tsx` too. An unknown or
   missing mode falls back to `breakout`, so every gallery authored before the modes existed
   still renders. `site/src/scripts/gallery-lightbox.ts` adds a `<dialog>` lightbox and the
   slider's controls as progressive enhancement — every photo is a real `<a>` to its largest
   variant, so the gallery works with JavaScript off. Gallery URLs are allow-listed against
   the image host's origin, because that markup is injected *after* the sanitizer runs (see
   [SECURITY.md](SECURITY.md#content-injected-after-sanitize-body-images-and-galleries)). The
   fence's per-line `| WIDTHxHEIGHT | alt="…" | caption="…"` metadata is lifted into the row's
   `images` map at save time by `uploader/src/body-content.ts`, and re-attached by the MDX
   exporter so a backup round-trips.
5. **Release** — the build lands in a fresh `releases/<timestamp>` dir under `/data/site` (built
   into a CWD-local tmp dir first to dodge an `EXDEV` rename across the volume boundary, then
   `cp`'d), then the `current` symlink is **atomically** swapped to it (old releases pruned, keeping
   the last 3). The app serves `current` directly via `@fastify/static` — no separate web server.

The Astro entry `id`s (`de/<slug>` / `en/<slug>`) and the Zod schema are unchanged from the original
MDX era, so the SEO slug contract (`site/src/lib/paths.ts`, `trips.ts`) holds: **DE at root, EN under
`/en/`** — slugs are never renamed.

**Build-on-boot:** on startup, if `/data/site/current` doesn't exist yet (fresh volume), the app
kicks off an initial build in the background without blocking Fastify from listening; blog routes
serve a 503 "site is building" page until it lands. Restarts against an existing `/data` volume
skip this and serve immediately — no rebuild on every boot.

## Image pipeline

The app optimizes each photo into AVIF + WebP at fixed widths (640/1280/1920 plus the source
width, never upscaled). Metadata is **not** copied wholesale: `pipeline.ts` re-injects only an
EXIF **allow-list** (camera make/model/lens, capture time, exposure, aperture, ISO, focal length)
built by `uploader/src/exif.ts`, plus the ICC profile — GPS, XMP, IPTC and `Orientation` never
reach a public variant. The untouched upload (`{key}-orig.<ext>`) keeps its full original
metadata but is never served (excluded from the image-host static mount). See
[SECURITY.md](SECURITY.md#published-image-metadata-allow-list) for why and what's kept. `/upload`
appends a short content hash to the client's key, so files land as `{key}-{hash8}-{width}.{format}`
under `STORAGE_DIR`: replacing a photo mints a new URL while previously published URLs keep
serving untouched — which is what makes the one-year immutable cache correct. (The WP-import
rehost path keeps deterministic `{key}-{width}.{format}` keys so re-imports stay idempotent.)
`/upload` accepts **one file per request** (a second file in the same multipart body is rejected
with 413 rather than silently dropped — see [SECURITY.md](SECURITY.md#input-validation)); bulk
upload is N single-file requests by design.

**Uploads are asynchronous.** The request returns as soon as the untouched original is on disk;
the AVIF/WebP variants encode in a background queue (`uploader/src/encode-queue.ts`). The
response is still complete — the storage key is a pure function of the content hash, and a
metadata-only probe reads orientation-corrected dimensions in ~0.0002 s versus ~0.467 s for the
re-encode probe it replaced. This exists because encoding a 24 MP frame costs ~19 s and ~1.94 GB
peak RSS: at concurrency 2 the old synchronous path held the connection for 40–90 s, against a
reverse proxy whose default read timeout is 60 s. The trade-off is that `{src}-640.webp` 404s
until the encode lands, so **`POST /posts/:tk/publish` refuses (409) while any photo the post
references is not `ready`** — that gate is the only thing standing between a lost encode job and
a published page full of broken images. A key with no `media` row never blocks (WordPress-imported
and legacy files predate the library).

The queue runs at concurrency **2** (the measured throughput plateau) and shares a lock with the
site builder (`uploader/src/work-lock.ts`) so a build and image encoding are **mutually
exclusive** — both peak around 2 GB in one container. A waiting build *preempts* the encode
backlog at the next job boundary rather than queueing behind it, because Publish awaits the
rebuild synchronously in the editor. That mutual exclusion is why `docker-compose.yml`'s
`mem_limit` is sized as `max(build, encode) + baseline` rather than their sum.
`createShutdown` drains the queue between closing the HTTP server and ending the pg pool, so
in-flight jobs can still write their final status.

**Disk headroom (#73):** roughly **17.5 MB per photo** (6.9 MB of variants + the 10.7 MB retained
original) ≈ **1.75 GB per 100 photos**, plus roughly the same again under `/data/backup` because
originals are captured by the incremental image archive — so a 100-photo trip costs about
**4 GB all-in**. `POST /upload` therefore refuses with **507** when `/data` lacks room for the
photo's full cost plus a reserve that keeps a build and a backup able to run, and `GET /health`
reports free space (as information, never as a health verdict — see SECURITY.md). `heroImage` is a remote URL object
`{src,width,height,alt}`; body images are referenced by URL and rendered as `<picture>` at build
time. This contract is mirrored on the blog side in `site/src/lib/images.ts`.

**CLI subcommands** (alongside `restore`/`set-password`, see
[Database dumps](#database-dumps)):

- `audit-exif` — read-only scan of every variant under `STORAGE_DIR`, reporting how many carry
  EXIF and how many carry GPS, and (when any do) which storage keys and whether each has a
  retained `-orig` to re-encode from. Gates whether a remediation pass is needed at all; nothing
  is written. `docker compose exec app node --import tsx src/cli.ts audit-exif`.
- `strip-gps` — **not yet built.** It remediates the historical corpus (a lossy re-encode for
  the keys with no retained original), and is scoped to be added only if a server-side
  `audit-exif` run finds GPS-carrying variants. A pre-release audit of the **local development
  corpus** (not the server) found 102 variant files with EXIF and zero with GPS, so it wasn't
  built speculatively — the pipeline fix above already stops new GPS exposure regardless. The
  server's corpus has not yet been audited; see SECURITY.md.

Host-based routing keeps the two domains on one process: the image-variant static handler is
registered with a Fastify **host constraint** for the hostname of `PUBLIC_BASE_URL` (overridable
via `IMG_HOST`), so on the img host the constrained `/` wildcard wins and image URLs behave exactly
as before the merge. All other routes (admin, blog, map) are unconstrained.

Legacy WordPress URLs are 301-redirected by the not-found handler (blog host only, before the
404/503 fallbacks): the `/feed/` family (`/feed/`, its `/feed/{atom,rss2,rss,rdf}/` aliases,
`/comments/feed/` and the `/en/…` Polylang equivalents) goes to `/rss.xml` resp. `/en/rss.xml`, and the six
`/category/<region>/` archives map to their `/reiseziele/…` / `/en/destinations/…` pages. The
data-driven map lives in `uploader/src/redirects.ts` and is extensible once the real WXR
inventory is available. `/wp-content/uploads/*` image URLs are intentionally **not** redirected
(accepted loss — the old URLs carry no post slug, so they cannot be mapped onto the
`trips/<slug>/…` key scheme, and no mapping table was persisted at import time).

## AI alt-text (local LM Studio)

The post editor and photo uploader offer a "Suggest alt text" button per alt field. The browser
downscales the picked photo and calls the author's local LM Studio (`<lmBaseUrl>/chat/completions`)
directly — the app server never contacts the model. LM config (`lmBaseUrl`, `lmModel`,
`captionTimeoutMs`, `captionMaxEdge`, `captionPrompt`) lives in the JSON settings store, edited on
the admin-only Settings page; authors read it read-only via `GET /ai-config`. No
`docker-compose`/`.env` LM variables are needed.

## Data model (Postgres)

Created idempotently by `uploader/src/db.ts` (`ensureSchema`):

- **`users`** — `id`, `username` (unique, case-insensitive), `password_hash` (scrypt), `is_admin`, `created_at`.
- **`sessions`** — `id` (SHA-256 of the random token), `user_id` (FK, cascade), `expires_at`. Expired rows are swept hourly.
- **`posts`** — one row per (`translation_key`, `locale`); `slug`, `title`, `date`, `country`, `country_code`, `region`, `excerpt`, `hero_image` (jsonb), `coordinates` (jsonb), optional `stops`/`route`/`key_facts`, `body_markdown`, `images` (jsonb), `status` (`draft`/`published`). Unique on (`locale`, `slug`).
- **`media`** — one row per storage key: `folder` (virtual, decoupled from the key), `title`,
  bilingual `alt_*`/`caption_*`, `tags` (`text[]`), dimensions, byte sizes, `status`
  (`processing`/`ready`/`failed`/`missing`), EXIF (`taken_at`, `camera`, `lens`, `lat`, `lng`)
  and `uploaded_by` (FK, `ON DELETE SET NULL`).
- **`media_folders`** — `path` primary key; the single source of truth for the folder tree
  (every write that sets a `folder` upserts the row and its ancestors).

> **The filesystem stays the source of truth for a file's existence.** A `media` row is metadata
> *about* a file under `STORAGE_DIR`, never the other way round — which is what preserves the
> property this document relies on elsewhere: photos survive a database loss.
> `uploader/src/media-sync.ts` reconciles the two on boot and on demand
> (`POST /media/rescan`): it backfills rows for keys already on disk, harvests existing alt text
> by **exact URL match only**, and marks a row whose files vanished as `missing` rather than
> deleting it. Its walk matches originals as well as variants, so a crashed upload — which has
> written only `{key}-orig.<ext>` — is discovered and re-queued.

Schema evolution is additive and idempotent — no migration framework, no `schema_version` table.
`ensureSchema` runs on every boot before the server starts serving, so a new column is added in
**both** places: the table's `CREATE TABLE` definition (fresh installs) and a matching
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` appended to the marked column-migrations section at the
end of `ensureSchema` (existing deployments pick it up at the next boot). `NOT NULL` columns must
carry a `DEFAULT`, or the `ALTER` fails on populated tables.

## Backups & disaster recovery

Full recovery needs **two things**: the Postgres content (`users`/`posts`/`pages`) and the
**`/data` volume** (image originals + variants, site releases, MDX exports — and the in-app
backup files themselves). Everything the app writes, including its own DB dumps and image
archives under `/data/backup/db/`, lives on the **same server disk** as the live data (`/data`
is bind-mounted from `./uploader/data`; `pgdata`, the live database, is a named volume on the
same host). The in-app backups therefore protect against application-level mistakes (bad edit,
botched restore, accidental delete), **not** against disk failure or host loss.

> **Offsite backup is required for real DR:** run a host-level backup (e.g. a restic / borg /
> rsync cron job) of `./uploader/data`. That one directory contains the DB dumps, the image
> archives, and the image originals, so copying it offsite is the complete disaster-recovery
> story. The manual download buttons on the settings page are an escape hatch, not a strategy.

### Database dumps

`uploader/src/backup.ts` provides app-native logical dumps (no `pg_dump`, no sidecar container):

- **Dump format** — one file per run, `/data/backup/db/db-<YYYYMMDD-HHmmss>.json.gz`, containing
  `{ "version": 3, "createdAt": <ISO>, "tables": { "users": […], "posts": […], "pages": […], "media": […], "media_folders": […] } }`
  with full column fidelity. `sessions` are **never** dumped — they're disposable, and token
  hashes don't belong in a backup file. `version` lets restore reject incompatible dumps; the
  guard is an **allow-list** (1, 2 and 3), so every bump must widen it or newly written dumps
  become unrestorable. v1 predates `pages`, v2 predates the media tables; both still restore and
  leave the tables they never captured alone (for media, `POST /media/rescan` rebuilds the rows
  from the files on disk).
  Two ordering details the naive version gets wrong: `media` and `media_folders` are deleted
  **before** `users` (`media.uploaded_by` is `ON DELETE SET NULL`, so the other order silently
  nulls every attribution), and `tags` is `text[]`, which cannot round-trip through the
  `JSON.stringify` path every other non-scalar column uses — it needs a `$n::text[]` bind.
- **Schedule** — admin-configurable in settings: `backupSchedule` (`off` / `daily` / `weekly`,
  default `off`) and `backupRetention` (1–100 files, default 14). An hourly in-process tick (same
  pattern as the session sweep) runs a backup when due, tracked in
  `/data/backup/db/state.json` (`lastAttemptAt`/`lastSuccessAt`/`lastError`/`lastImagesArchiveAt`);
  missed windows catch up on next boot. After a successful run, dump files beyond the retention
  count are pruned. Failures are recorded and logged, never crash the app.
- **Admin UI** (settings page) — schedule select, retention input, **Back up now** button, last-run
  status, and lists of existing dumps and image archives with download links.
- **Routes** (all admin-only): `GET /backups` (state + dump list + image-archive list),
  `POST /backups` (run now), `GET /backups/:name` (download; filename validated against
  `^db-\d{8}-\d{6}\.json\.gz$` or `^images-\d{8}-\d{6}\.tar$` — no traversal).
- **Restore is CLI-only** (destructive, so no web button):
  `docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/<file>`.
  The DHI runtime image has no shell, so `exec` must invoke `node` directly (a bare
  `tsx src/cli.ts ...` cannot run there); outside Docker use `npx tsx src/cli.ts restore <file>`.
  Restore validates
  the dump `version`, then in **one transaction** deletes and re-inserts `users`, `posts`, and —
  for v2 dumps — `pages` (v1 dumps leave existing pages untouched). Deleting users **cascades to
  `sessions`**, so every login is invalidated — the CLI prints a reminder to trigger a rebuild
  afterwards (`POST /rebuild`).
- **Admin password recovery** — a forgotten password is reset from the host via the CLI (the
  runtime image has no shell, so use the exec form):
  `docker compose exec app node --import tsx src/cli.ts set-password <username>` — prompts for
  the new password when omitted (input is echoed; passing it as an argument would expose it in
  the container's process list) and invalidates that user's sessions. Routine rotation while
  logged in: the "Change my password" card on `/admin/users.html`. Last-resort lockout fallback:
  `docker compose exec db psql -U images -d images -c 'DELETE FROM users;'` re-opens `/setup`
  (zero-users check) on the next visit to `/login`. That deletes **only** accounts and their
  cascaded sessions — `posts`, `pages`, and images carry no user FK and are untouched.

### Image originals & incremental archives

- **Originals** — every image write path (`/upload`, the CLI uploader, and WordPress re-hosting)
  persists the untouched upload as `{key}-orig.<ext>` next to the AVIF/WebP variants, so
  `/data/images` is a complete media archive: a DB restore alone can't bring photos back, and
  without originals the lossy variants would be the only server-side copy of every photo.
  Originals also enable future re-encodes (new widths/formats/quality). Cost: roughly double the
  per-upload disk use. Note: originals exist only for uploads made from this version onward —
  images uploaded earlier had their originals discarded at upload time and exist as variants only.
  Originals are a **private DR asset**: they live in `STORAGE_DIR` so the incremental archive
  captures them, but the app's image-host static mount excludes `-orig.*` (404), so a
  full-resolution original is never publicly downloadable — only the derived variants the site
  links to are served.
- **Image archives** — after each successful scheduled/on-demand dump, files under `/data/images`
  modified since the previous archive are tarred into
  `/data/backup/db/images-<YYYYMMDD-HHmmss>.tar` (mtime-incremental; when nothing changed, no
  file is written). Archives are **never pruned** — each holds a unique slice of the library —
  so the chain eventually stores one extra copy of every image; the offsite host-level backup
  above remains the real DR protection. To rebuild the images dir from archives, untar them
  **oldest-first** into an empty `images/` (later duplicates simply overwrite earlier ones).

### Upgrading a Postgres major (e.g. 17 → 18)

A Postgres major cannot read the previous major's cluster files, and `postgres:18+` images also
moved the volume mount from `/var/lib/postgresql/data` to `/var/lib/postgresql` (data lives in a
versioned subdirectory). **Deployments with a pre-18 `pgdata` volume must migrate via
dump-and-restore — do NOT just pull the new image**: with the old volume mounted at the new path,
the entrypoint finds its versioned PGDATA empty and silently `initdb`s a fresh, empty cluster
(the old data sits unreferenced at the volume root, and the app happily re-seeds — the blog
comes up blank without an error). The same dump → drop volume → bump tag → restore sequence
applies to every future major (18 → 19, …). Procedure:

```bash
# 1. still on the OLD version/compose: dump
docker exec blog-db-1 pg_dump -U images -d images --no-owner > pg-upgrade-dump.sql
# 2. stop, drop the old-format volume (the dump is your data now)
docker compose down && docker volume rm blog_pgdata
# 3. deploy the new compose (new image + mount), start the db, restore
docker compose up -d db
docker exec -i blog-db-1 psql -U images -d images < pg-upgrade-dump.sql
docker compose up -d
```

**App-native alternative** (JSON backup instead of `pg_dump`/`psql`): while **still on the OLD
version**, take a fresh dump first (admin Settings → **Back up now**, or `POST /backups` —
`backupSchedule` defaults to `off`, so don't assume one exists) and confirm the file is present
under `/data/backup/db` **before** running `docker compose down` / `docker volume rm`. After
`docker compose up -d` on the new major, the app's boot-time `ensureSchema` recreates all tables
on the fresh cluster, so that `/data/backup/db/db-*.json.gz` dump (see
[Database backups](#database-backups)) can be restored with the shell-less exec-form CLI:
`docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/db-<YYYYMMDD-HHmmss>.json.gz`.
Note the database has **zero users** until the restore completes, which re-opens first-run
`POST /setup` to anyone who can reach port 3000 — run the restore immediately after the app is
healthy, or keep the port unreachable (reverse proxy off / firewall) during the window.
The restore covers `users`, `posts`, and `pages` only — sessions are disposable and app settings
live on disk under `/data`, but every login is invalidated, so log in again and trigger a rebuild
(`/admin/settings.html` → **Rebuild site now**, or `POST /rebuild`). Prefer the `pg_dump`/`psql`
path above as primary — it captures the whole database with full fidelity.

## Packaging & release pipeline

One image, built from a **multistage Dockerfile at the repo root** (context = repo root, so it can
copy both `uploader/` and `site/`) whose base images are `ARG`-parameterized (`NODE_BUILD` /
`NODE_RUNTIME`, defaulting to **Docker Hardened Images** (minimal, low-CVE, non-root) from
`dhi.io` — CI passes the same bases explicitly (requires a dhi.io login):

| Stage | Base | Purpose |
| :-- | :-- | :-- |
| Build (`uploader-build`, `site-build`) | `dhi.io/node:26-dev` | `npm ci` for both trees (uploader: `--omit=dev`; site: full install — Astro's build tooling lives in devDependencies) |
| Runtime | `dhi.io/node:26` (minimal, no shell/npm) | Runs everything — Astro is spawned **via plain node**, not `npx`/`npm`, so the runtime no longer needs the `-dev` toolchain image it used to (that's the one thing that made merging the builder into the CMS safe) |

Both trees (`/app/uploader`, `/app/site`) are copied into the runtime stage `--chown=1000:1000` —
the site tree needs to stay writable for Astro's `.build-tmp/` and `.astro/` dirs at runtime. The
runtime user is non-root **uid 1000** (the DHI default). The build and runtime bases must share a
libc (sharp ships native binaries, and now Astro/Tailwind's native deps too), which the Dockerfile
warns about.

**Release flow** (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag —

1. logs in to GHCR (`GITHUB_TOKEN`) and to `dhi.io` (repo variable `DHI_USERNAME` + secret
   `DHI_TOKEN`) to pull the DHI bases,
2. `buildx` multi-arch (**amd64 + arm64**) with the DHI build-args, pushed to
   `ghcr.io/laboef1900/simonswanderlust-app` tagged `{version}`, `{major}.{minor}`, and `latest`,
3. creates the GitHub Release with generated notes.

On the server: pull the GHCR image directly (no `dhi.io` login needed there — that's CI-only), set
`IMAGE_TAG` in `.env`, then `docker compose pull && docker compose up -d`. Cutting a release = bump
the `IMAGE_TAG` defaults (`docker-compose.yml`, `uploader/.env.example`), commit, tag, push the tag.

## Configuration (environment)

| Var | Used by | Purpose |
| :-- | :-- | :-- |
| `DATABASE_URL` | app | Postgres connection (content + auth) |
| `PUBLIC_BASE_URL` | app | Public base for image URLs (e.g. `https://img.simonswanderlust.com`) |
| `IMG_HOST` | app | Hostname routed to the image-variant static handler (defaults to the host of `PUBLIC_BASE_URL`) |
| `SITE_APP_DIR` | app | Path to the Astro project the builder spawns (`/app/site`) |
| `SITE_DIR` | app | Release root for the built blog (`/data/site`) — `current` is served from here |
| `MAP_DIR` | app | PMTiles/glyph assets root for `/map/` (`/map-assets`) |
| `STORAGE_DIR` | app | On-disk image variants |
| `BACKUP_DIR` | app | Root for MDX export backups and (in `db/`) database dumps |
| `PORT` | app | Listen port (default `3000`) |
| `PROTOMAPS_BUILD` / `MAP_MAXZOOM` / `PMTILES_VERSION` | Dockerfile (build args) | Pin the map basemap fetched + baked into the image at build (see `docs/map-assets.md`) |
| `IMAGE_TAG` | compose | Released GHCR image version to run |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | db | Database bootstrap |

## Trust boundaries

- **Public, unauthenticated:** the static blog (read-only files) and the optimized images.
- **Public, authenticated:** the admin app (`/admin/`) and its API — session-cookie gated, with
  admin-only operations (publishing, user management, rebuild, backups).
- **Internal only:** Postgres is not exposed to the internet (no published port).

Both public and admin traffic now terminate in the **same process**, which is a deliberate,
accepted trade-off for the WordPress-style topology (see [Security posture — accepted
deltas](#security-posture--accepted-deltas)).

As defense-in-depth, the `app` container runs on a hardened, minimal base image (DHI) as a non-root
user with no shell or package manager — see [Packaging & release pipeline](#packaging--release-pipeline).

### Security posture — accepted deltas

Collapsing the four-container stack (nginx / blog-builder / uploader / db) into one `app` container
knowingly accepts:

- **The app process can write the served web root.** Inherent to the merge (WordPress-parity
  risk). The `rehype-sanitize` build chokepoint still runs on all content-derived output, but a
  fully compromised app process could write files to `/data/site/current` directly.
- **Public-site availability is coupled to app + db health.** Mitigated: restarts are now seconds,
  since a build only runs on boot when no release exists yet — nginx's "keep serving stale files
  even if the backend is down" property is given up knowingly.
- **All public traffic terminates in the process that parses uploads and WXR imports.** Mitigated
  by the existing app-level controls: authn, rate limiting, `safeFetch` (SSRF guards), size caps,
  `assertSafeKey` (path-traversal guards).

**Preserved:** the non-root, minimal (no shell/npm) runtime; `db` has no published port; a
TLS-terminating reverse proxy is still required in front; all existing app-level controls
(auth, rate limiting, sanitization, SSRF/traversal guards) are unchanged.

See [SECURITY.md](SECURITY.md) for how each boundary is enforced.
