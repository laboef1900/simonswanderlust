# Design — Single App Container ("WordPress-style" topology) + Configurable DB Backup

**Date:** 2026-07-03
**Status:** Approved (brainstorming) — ready for implementation planning
**Relates to:** Replaces the 4-container topology (blog nginx / blog-builder / images / db)
documented in `ARCHITECTURE.md` with a 2-container topology (app / db). Adds a database
backup feature configured from the admin settings page. Supersedes the packaging sections
of `ARCHITECTURE.md` and parts of `SECURITY.md` once implemented.

## Problem

The stack currently runs four containers for one blog: nginx serving static output,
a runtime Astro build server, the uploader/CMS, and Postgres. That split buys real
security and availability properties, but the owner prefers the operational simplicity
of a WordPress-style shape: **one application container + one database container**.

Separately, the database has **no backup automation at all** — `users` and `posts`
live only in the `pgdata` volume (the MDX "Export all" covers published post content,
not users or drafts). Backup must become a first-class, configurable feature.

## Goals

- Two compose services: `app` (Fastify: CMS + image service + static blog serving +
  in-process Astro builds) and `db` (Postgres, unchanged).
- Preserve **every public URL**: blog slugs (Golden Rule 2) and image URLs baked into
  published content (`https://img.simonswanderlust.com/...`) keep working unchanged.
- Preserve today's hardening where possible: minimal non-root DHI runtime for `app`,
  db internal-only, all existing app-level controls (auth, rate limits, SSRF guards,
  traversal guards, sanitization).
- DB backup: scheduled + on-demand, retention-pruned, status visible in the admin
  settings page, restorable via CLI.
- Faster restarts: no full rebuild on every boot.

## Non-Goals (YAGNI)

- No restore button in the web UI (restore is destructive; CLI-only).
- No `pg_dump`-based backups, no sidecar/cron containers.
- No async publish queue — publish stays synchronous like today.
- No change to the Astro project structure, content schema, slug contract, or the
  authoring workflow. `site/` remains its own npm project.
- No change to the `db` service beyond compose wiring.

## Key Decisions

1. **Host-based routing keeps the img subdomain.** One Fastify process serves both
   domains on port 3000. Image-variant static serving is registered with a Fastify
   host constraint for the hostname of `PUBLIC_BASE_URL` (overridable via `IMG_HOST`).
   All other routes are unconstrained (they are auth-gated or public-static anyway);
   on the img host the constrained `/` wildcard wins, so image URLs behave exactly
   as today. The host TLS proxy points **both** domains at port 3000.
2. **Astro is spawned without npx.** `spawn(process.execPath,
   ['node_modules/astro/bin/astro.mjs', 'build', '--outDir', <tmp>])` with
   `cwd=/app/site` and `ASTRO_TELEMETRY_DISABLED=1`. Verified: `astro.mjs` is a plain
   Node entry (astro 6.4.6). Consequence: the runtime image needs **no npm, no shell,
   no root** — the merged image stays on the minimal DHI `node:22` runtime, uid 1000.
   This removes the main security regression of merging the builder into the CMS.
3. **Backups are app-native logical dumps, not pg_dump.** The app SELECTs `users` and
   `posts` into one gzipped JSON file. `sessions` are excluded deliberately: they are
   disposable, and session-token hashes do not belong in backups. Consequence: after a
   restore, everyone logs in again. This needs zero new binaries and is fully testable.
4. **Build-on-boot only when no release exists.** The release dir persists on `/data`,
   so restarts serve the existing release immediately. Publish and the new
   "Rebuild site now" admin button trigger builds; boot builds only on a fresh volume.
5. **Static output moves to the `/data` volume** (`/data/site/releases/<stamp>` +
   `/data/site/current` symlink). The `blog-dist` named volume disappears. The proven
   mechanics from `site/build-server.mjs` are kept: build into a CWD-local tmp dir
   (Astro EXDEV workaround), `cp` to the release dir, atomic symlink flip, prune to
   the last 3 releases, single in-flight flag.

## Architecture

### Removed

- `blog` (nginx) service, `site/nginx.conf`, `NGINX_TAG`, `BLOG_PORT`, the dhi.io/nginx
  pull, and the `blog-dist` volume.
- `blog-builder` service, `site/build-server.mjs`, `site/Dockerfile`, the
  `BUILD_SECRET` / `BUILDER_URL` env vars, and `uploader/src/publish.ts` (the HTTP
  build-trigger client). The GHCR `simonswanderlust-blog-builder` image is retired.
- The `GET / → /admin/` redirect in the uploader (the blog homepage owns `/`).

### Added / changed

- **`app` service** — single image (GHCR `simonswanderlust-app`), built from a new
  multistage Dockerfile with repo-root build context:
  - build stage A: uploader deps (`npm ci --omit=dev`) + vendored admin assets
    (fonts, EasyMDE) — as today.
  - build stage B: site deps (full `npm ci` — build-required packages live in
    devDependencies) — as today for blog-builder.
  - runtime stage: minimal base (default `node:22-slim`, CI override
    `dhi.io/node:22`), non-root uid 1000 in both cases (`USER node` locally; DHI
    default). App trees at `/app/uploader` and `/app/site`, copied `--chown=1000`
    (the site tree needs writable `.build-tmp/` and `.astro/`). Entrypoint unchanged:
    `node --import tsx src/main.ts`.
  - The libc-family warning (sharp native binaries; now also Astro/Tailwind native
    deps) carries over: build and runtime bases must share an OS family.
- **compose** — `app` publishes `3000:3000`, mounts `./uploader/data:/data` and
  `${MAP_ASSETS_DIR:-./map-assets}:/map-assets:ro`, gets `DATABASE_URL`,
  `PUBLIC_BASE_URL`, LM Studio vars; `depends_on: db: service_healthy`;
  healthcheck hits the app's `/health` (added if absent — returns 200 once Fastify
  listens; it does **not** gate on a release existing).
- **CI** — `.github/workflows/release.yml` matrix shrinks to one image.

### Routing (single Fastify instance)

| Host | Path | Behavior |
| :-- | :-- | :-- |
| img host | `/*` | `@fastify/static` over `STORAGE_DIR`, 1-year immutable cache — unchanged |
| any | `/admin/*`, `/upload`, `/suggest`, API routes, `/health` | As today (auth-gated where applicable); no longer proxied — served directly |
| main | `/map/*` | `@fastify/static` over `/map-assets`; explicit MIME types (`.pmtiles` → `application/octet-stream`, `.pbf` → `application/x-protobuf`); byte-range support (required by PMTiles; `@fastify/send` provides it) |
| main | `/*` (blog) | `@fastify/static` over `/data/site/current`: directory → `index.html` (the `trailingSlash: 'always'` contract), **301 redirect adding a missing trailing slash** (canonical URLs), not-found handler streams `404.html` with status 404 |

Until the first-ever release exists, blog routes return a minimal 503 "site is
building" page with `Retry-After`. Admin, upload, and image routes work regardless.

**Security headers:** `X-Content-Type-Options: nosniff` stays global.
`X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` move from the global
`onSend` hook to admin/API responses only, so blog pages are no longer stamped with
admin policies (parity with today, where nginx adds none to blog pages).

### Build pipeline (`uploader/src/build.ts`, ported from `build-server.mjs`)

- `buildSite()`: guarded by a single in-flight flag; a second caller gets a
  "build already running" error surfaced verbatim in the admin UI (parity with today).
- Publish (`POST /posts/:tk/publish`, admin-only) awaits `buildSite()` in-process —
  the 300 s HTTP timeout and shared-secret plumbing disappear.
- New admin-only `POST /rebuild` + "Rebuild site now" button on the settings page
  (needed after a restore; also replaces the old secret-gated `POST /build`).
- Boot: if `/data/site/current` is missing, kick off an initial build in the
  background; never block Fastify startup on it.

## DB backup feature

### Settings (extends the existing `SettingsStore` — JSON file, atomic writes)

| Field | Type / values | Default | Validation |
| :-- | :-- | :-- | :-- |
| `backupSchedule` | `'off' \| 'daily' \| 'weekly'` | `'off'` | enum |
| `backupRetention` | integer | `14` | 1–100 |

Backup directory is fixed at `/data/backup/db/` (inside the existing `/data` volume,
alongside the MDX backups) — not configurable, to keep path handling safe and simple.

### Dump format

One file per run: `db-<YYYYMMDD-HHmmss>.json.gz` containing
`{ "version": 1, "createdAt": <ISO>, "tables": { "users": [...], "posts": [...] } }`
— full column fidelity (jsonb as objects, timestamps as ISO strings). `version` lets
restore reject incompatible files.

### Scheduler (in-process, same pattern as the hourly session sweep)

- State file `/data/backup/db/state.json`: `{ lastAttemptAt, lastSuccessAt, lastError }`.
- On boot and then on an hourly tick: if enabled and `now - lastSuccessAt` exceeds the
  interval (24 h / 7 d), run a backup (missed windows catch up on next boot).
- Never runs concurrently with itself; after a successful run, prune to the newest
  `backupRetention` files.
- Failures set `lastError` and are logged; they never crash the app.

### Admin UI (settings page)

Schedule select, retention input, **Back up now** button (admin-only route, runs a
dump immediately), last-backup status line (time + ok/error message), and a list of
existing backup files with admin-only download links (served only from the fixed
backup dir; filenames validated against the `db-*.json.gz` pattern — no traversal).

### Restore (CLI-only)

New command in the existing `uploader/src/cli.ts`: validates the dump `version`,
then in **one transaction** deletes and re-inserts `users` and `posts`. Deleting
users cascades to `sessions` (FK `ON DELETE CASCADE`), so every login is invalidated
immediately. Prints a reminder to trigger a rebuild afterwards.

## Security posture (accepted deltas — to be reflected in SECURITY.md)

**Accepted:**
- The app process can write the served web root (inherent to the merge; WordPress-parity
  risk). The rehype-sanitize build chokepoint remains for all content-derived output,
  but a fully compromised app process could write files directly.
- Public-site availability is coupled to app + db health (mitigated: restarts are
  seconds now that boot builds are skipped; nginx's serve-through-anything property is
  given up knowingly).
- All public traffic terminates in the process that parses uploads and WXR imports
  (mitigated by existing authn, rate limiting, `safeFetch`, size caps, `assertSafeKey`).

**Preserved:** non-root minimal runtime with no shell/npm (Decision 2), db with no
published port, TLS-terminating reverse proxy still required in front, all existing
app-level controls unchanged.

## Error handling

- Build failure: publish/rebuild responses carry the error; the last release keeps
  serving (atomic symlink flip only happens on success).
- Backup failure: recorded in `state.json`, shown on the settings page, logged.
- Restore: transactional — a bad file changes nothing; version mismatch is a clear error.
- First boot before any release: 503 page on blog routes only.

## Testing (Vitest, per Golden Rule 1)

- `build.ts`: in-flight guard, release/prune/symlink logic (spawn mocked; fs real in tmp dirs).
- Backup: dump→restore round-trip against Postgres (gated on `TEST_DATABASE_URL`,
  like the existing `pg.integration.test.ts`); scheduler due-time logic with fake
  timers; retention pruning; settings validation bounds; download-route filename
  validation.
- Routing: `fastify.inject` with Host headers — img host serves variants, main host
  serves blog HTML; trailing-slash 301; `404.html`; `.pmtiles` MIME + range request;
  503 pre-first-release; `/` no longer redirects to `/admin/`.
- Unchanged: all `site/` suites (paths/trips/i18n/format) and `npx astro check`.

## Migration & rollout

1. Feature branch `feature/single-app-container`; the old topology keeps working on
   `main` until merge.
2. Implementation lands the new Dockerfile + compose + code + tests + docs together.
3. Server cutover: `docker compose down` old stack, pull/up new one. First boot builds
   into the fresh `/data/site`; Postgres data and image variants are untouched
   (`pgdata` and `/data` volumes carry over). Host proxy change: main domain now
   targets port 3000 (was 8090); img domain unchanged.
4. Rollback: the old compose file + images remain tagged on GHCR; `docker compose up`
   the previous revision.
5. Docs updated in the same change: `ARCHITECTURE.md` (topology, packaging, trust
   boundaries), `SECURITY.md` (posture deltas above), `README.md`, `CLAUDE.md`
   (monorepo description, build commands), `.env.example`.

## Out of scope for this spec

- DNS cutover itself (Phase 4) — unchanged, still the final step after this lands.
- Any change to post schema, slugs, i18n, or the map feature beyond serving `/map/`
  from the app.
