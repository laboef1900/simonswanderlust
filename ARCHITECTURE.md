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
| `app` | `ghcr.io/laboef1900/simonswanderlust-app` (built from the repo-root `Dockerfile`, DHI node base) | Single Fastify 5 process: admin CMS (editor, WordPress import, AI alt-text), image service (sharp, host-routed on the img subdomain), public blog static serving, in-process `astro build` on Publish/boot/manual rebuild, `/map/` PMTiles basemap, and DB backups | Public (via host port → reverse proxy / TLS) |
| `db` | `postgres:18-alpine` | Source of truth for posts, users, and sessions | Internal only (`:5432`) |

The `app` image is **released to GHCR** by CI and pulled on the server (pinned via `IMAGE_TAG`);
the compose service keeps its `build:` so local dev can still `docker compose up -d --build` from
source. See [Packaging & release pipeline](#packaging--release-pipeline).

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
   (`site/src/lib/body-images.ts`).
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
width, never upscaled), preserving EXIF/GPS. `/upload` appends a short content hash to the
client's key, so files land as `{key}-{hash8}-{width}.{format}` under `STORAGE_DIR`: replacing a
photo mints a new URL while previously published URLs keep serving untouched — which is what
makes the one-year immutable cache correct. (The WP-import rehost path keeps deterministic
`{key}-{width}.{format}` keys so re-imports stay idempotent.) `heroImage` is a remote URL object
`{src,width,height,alt}`; body images are referenced by URL and rendered as `<picture>` at build
time. This contract is mirrored on the blog side in `site/src/lib/images.ts`.

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


## Data model (Postgres)

Created idempotently by `uploader/src/db.ts` (`ensureSchema`):

- **`users`** — `id`, `username` (unique, case-insensitive), `password_hash` (scrypt), `is_admin`, `created_at`.
- **`sessions`** — `id` (SHA-256 of the random token), `user_id` (FK, cascade), `expires_at`. Expired rows are swept hourly.
- **`posts`** — one row per (`translation_key`, `locale`); `slug`, `title`, `date`, `country`, `country_code`, `region`, `excerpt`, `hero_image` (jsonb), `coordinates` (jsonb), optional `stops`/`route`/`key_facts`, `body_markdown`, `images` (jsonb), `status` (`draft`/`published`). Unique on (`locale`, `slug`).

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
  `{ "version": 2, "createdAt": <ISO>, "tables": { "users": [...], "posts": [...], "pages": [...] } }`
  with full column fidelity. `sessions` are **never** dumped — they're disposable, and token
  hashes don't belong in a backup file. `version` lets restore reject incompatible dumps
  (v1 dumps, which predate `pages`, are still accepted).
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
