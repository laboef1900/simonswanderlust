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
- `routes/` — private GPX originals and expiring import staging; never a static root.
- `site/releases/<stamp>` + `site/current` (symlink) — built static output (`SITE_DIR`).
- `backup/` — MDX export backups; `backup/db/` — gzipped Postgres dumps, incremental
  image archives and manifest-matched private GPX original archives.
- `settings.json` — admin-configurable settings, including backup scheduling, image conversion/quality, and the AI provider registry (no secrets).

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

## GPX route boundary (#311)

The [owner-approved GPX specification](docs/superpowers/specs/2026-10-23-gpx-route-import-design.md)
governs the private workflow (#313) and public snapshot pipeline (#314).
Story URLs, shared stops and the free-text `route` label are unchanged.

- One private `post_routes` row per translation pair, authenticated import/attach/read APIs,
  and `/data/routes` beside—not inside—images/site/static roots. Attach compares both route
  version and pair `updatedAt`; pair mutations advance both locale timestamps monotonically.
  Detach retains the latest original for explicit recovery. GPX arrays stay outside ordinary
  post JSON, text revisions and browser draft backups. An unsaved post is explicitly saved
  before attaching; attachment to an existing post does not save unsaved text/metadata.
- Pair-wide transaction locks serialize save/attach/publish/delete against the two-locale
  schema; `translation_key` is not itself a unique parent key on `posts`. A separate
  file-lifecycle gate protects originals during mutation/backup. A process-lifetime
  PostgreSQL advisory lock and app-session drain check exclude concurrent restore.
  Lease loss latches writes/jobs off and closes the pool without stopping static serving;
  health reports `storageWritable: false`; an explicit app restart resumes writes.
  Cleanup never queues behind backup. Transactional operational `route_cleanup` intents
  retry failed explicit removals across restart without targeting current/restored sources.
- `gpx-public-track.js` is the canonical pure projection shared by browser, author Attach
  and admin Publish workers: separate runs, 25 m simplification, four-decimal 2D coordinates,
  fixed output caps. An independent admin worker prevents author imports occupying the
  Publish slot. Computation runs outside DB transaction locks.
- `getPublishState()` captures both locales and the route coherently. Explicit Publish
  compares the reviewed pair/route tokens again under the pair lock, then copies one
  validated `track` artifact into both locale snapshots; detachment omits the field.
  Legacy snapshot backfill never joins private routes. Content Layer and MDX consume only
  snapshot artifacts, so edits/detachment remain draft-only through Save and Rebuild.
  MDX retains working-copy prose but the last published track. Both snapshot projections
  must validate and agree; corrupt/mismatched artifacts refuse export and recovery capture.
- Story mini-maps render the public runs below pin/stop markers and fit all their bounds.
  Localized per-run lengths/endpoints remain usable without JavaScript, tiles or WebGL.
  Overview maps remain pin-only; routeless stories keep their existing fallback unchanged.
- Private dump v10 includes route rows; a full, manifest-matched private route archive
  includes retained originals. The archive is completed before the matching dump becomes
  visible; manifest references pair retention independently of filename timestamps.
  Explicitly degraded sets preserve the database/available originals when a source is
  missing, corrupt, unreadable or oversized; they never promise to recover unavailable
  bytes. Retained degraded manifests pin unreadable/oversized local sources against
  automatic reclamation, but explicit replacement/post deletion override those pins.
  Offline restore validates the set and both public snapshot projections, stages new
  identities, then commits database state transactionally. Legacy dumps restore without routes.
- The admin's self-hosted MapLibre 6.4.1 / PMTiles 4.4.1 preview is context only. Distance,
  point and whole-segment controls work without basemap data; WebGL failure uses a local SVG.
  Waypoints are unchecked and adopted independently as exact, shared stops only after explicit
  confirmation. No journey reuse, geocoder/AI call or third-party location transfer occurs.

Rollback leaves additive storage inert; removing a public line requires an authorized
rebuild, not merely an image redeploy. Full failure/recovery contracts and approval gates
are in the specification.

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
   inside the fence — `column` (default; justified rows at the 960px story width), `breakout`
   (the same rows in a 1112px break-out — centred below `lg`, the whole 960px story spread above it)
   or `slider` (a scroll-snap carousel). The row partition is computed at build time by
   `site/src/lib/gallery-layout.ts`, which is kept pure and dependency-free because draft
   preview runs it under `tsx` too. An unknown or missing mode falls back to `column` (it was
   `breakout` until 2026-09-20). `site/src/scripts/gallery-lightbox.ts` adds a `<dialog>` lightbox and the
   slider's controls as progressive enhancement — every photo is a real `<a>` to its largest
   variant, so the gallery works with JavaScript off. Gallery URLs are allow-listed against
   the image host's origin, because that markup is injected *after* the sanitizer runs (see
   [SECURITY.md](SECURITY.md#content-injected-after-sanitize-body-images-and-galleries)). The
   fence's per-line `| WIDTHxHEIGHT | alt="…" | caption="…"` metadata is lifted into the row's
   `images` map at save time by `uploader/src/body-content.ts`, and re-attached by the MDX
   exporter so a backup round-trips.
   For **article galleries**, current localized Media alt/caption override those saved
   copies at render time, even when blank; missing library rows retain the saved copy.
   The trips loader selects only media keys and the four description columns once per
   load. Draft preview and the alt audit use a batched metadata-only store lookup.
   Article bodies/order/dimensions/formats still come from the published snapshot;
   editing Media alone does not trigger a build. Hero/title images, ordinary inline
   images and About-page composition are unchanged. See the
   [approved contract](docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md).
5. **Release** — the build lands in a fresh `releases/<timestamp>` dir under `/data/site` (built
   into a CWD-local tmp dir first to dodge an `EXDEV` rename across the volume boundary, then
   `cp`'d into a dot-prefixed staging dir and renamed into place, so a release dir is either
   complete or absent), then the `current` symlink is **atomically** swapped to it (old releases
   pruned, keeping the last 3; staging dirs never count). Every run first sweeps `.build-tmp/`
   and any `releases/.*` leftover from a killed predecessor. The app serves `current` directly via
   `@fastify/static` — no separate web server.

The child is bounded (#110): it is SIGKILLed after `BUILD_TIMEOUT_MS` (15 min) and the build
reports `timed out`, releasing the shared build/encode lock instead of holding every later
publish, rebuild and encode until a manual restart. Its stderr is streamed to the container log
**and** its last 4 KiB is appended to the build error the admin sees, so a schema failure names
the post. The loaders' pool (`site/src/lib/loader-pool.ts`) carries connection and query
timeouts, so a silently hung Postgres fails the build within about a minute rather than running
into the deadline.

The Astro entry `id`s (`de/<slug>` / `en/<slug>`) and the Zod schema are unchanged from the original
MDX era, so the SEO slug contract (`site/src/lib/paths.ts`, `trips.ts`) holds: **DE at root, EN under
`/en/`** — slugs are never renamed.

**Build-on-boot:** on startup, if `/data/site/current` doesn't exist yet (fresh volume), the app
kicks off an initial build in the background without blocking Fastify from listening; blog routes
serve a 503 "site is building" page until it lands. A failed initial build is retried with
exponential backoff (30 s → 8 min, six attempts; `bootstrapRelease` in `build.ts`), stopping as
soon as any release exists — an admin's publish counts — and giving up, logged, after the last
attempt. `GET /health` reports `release: false` meanwhile (information, not a verdict — see
`SECURITY.md`). Restarts against an existing `/data` volume skip all of this and serve
immediately — no rebuild on every boot.

## Image pipeline

By default, the app optimizes each photo into AVIF + WebP at fixed widths (640/1280/1920 plus
the source width, never upscaled). **Settings → Images** can keep new JPEG inputs
as responsive JPEG variants instead; other input formats still produce AVIF + WebP.
WebP and AVIF quality are configurable (1–100, defaults 75 and 55); JPEG output uses quality 90.
Its **Compare quality** preview (admin-only `POST /settings/image-preview`) runs one test photo
through the same per-variant encoder (`encodeVariant` in `pipeline.ts`, shared with
`processImage`) at `min(width, 1920)` px, in memory, without EXIF, under the shared work-lock
and single-flight, and returns the bytes for a side-by-side comparison.
Metadata is **not** copied wholesale: `pipeline.ts` re-injects only an
EXIF **allow-list** (camera make/model/lens, capture time, exposure, aperture, ISO, focal length)
built by `uploader/src/exif.ts`, plus the ICC profile — GPS, XMP, IPTC and `Orientation` never
reach a public variant. The untouched upload (`{key}-orig.<ext>`) keeps its full original
metadata but is never served (excluded from the image-host static mount). See
[SECURITY.md](SECURITY.md#published-image-metadata-allow-list) for why and what's kept. `/upload`
hashes the original bytes together with the encoding profile into the client's key, so files
land as `{key}-{hash8}-{width}.{format}` under `STORAGE_DIR`: replacing a photo or changing its
encoding settings mints a new URL while previously published URLs keep serving untouched.
WP-import body/gallery keys stay deterministic and complete existing sets are resumed.
Its explicit **overwrite existing drafts** action retains the existing featured-image overwrite behavior.
`/upload` accepts **one file per request** (a second file in the same multipart body is rejected
with 413 rather than silently dropped — see [SECURITY.md](SECURITY.md#input-validation)); bulk
upload is N single-file requests by design.

**Uploads are asynchronous.** The request returns as soon as the untouched original is on disk;
variants encode in a background queue (`uploader/src/encode-queue.ts`). The media row stores
the encoding profile before the original is written; retries and crash recovery use that
snapshot, not the current global preference. `media.format` and `media.encoding` are additive
columns; legacy NULL values mean the original modern-format/default-quality contract.
Hero/body references carry optional `format: 'jpeg'`; absence means AVIF + WebP. Settings
changes never automatically reprocess existing files. The
response is still complete — the storage key is a pure function of the bytes and profile, and a
metadata-only probe reads orientation-corrected dimensions in ~0.0002 s versus ~0.467 s for the
re-encode probe it replaced. This exists because encoding a 24 MP frame costs ~19 s and ~1.94 GB
peak RSS: at concurrency 2 the old synchronous path held the connection for 40–90 s, against a
reverse proxy whose default read timeout is 60 s. The trade-off is that `{src}-640.webp` 404s
until the encode lands, so **`POST /posts/:tk/publish` refuses (409) while any photo the post
actually puts on the page is not `ready`** — the heroes and title images, and every `img`/`source`
URL the **rendered, `images`-resolved** body of either locale would emit (#334; a stale `images`
entry for a photo the body no longer mentions does not block). That gate is the only thing
standing between a lost encode job and a published page full of broken images. A key with no
`media` row never blocks (WordPress-imported and legacy files predate the library). The same gate
also refuses (409, with a count and up to five example URLs) while the rendered body of either
locale would emit an `<img>`, or holds a ` ```gallery ` line, whose **origin is not the image
host** (#91; both readings come from one render per locale in `analyzeBodyImages`,
`uploader/src/publish-gate.ts`): that is what a failed WXR re-host leaves behind, and the render
path would hot-link the old domain or drop the photo silently. The body is judged from the
renderer's own sanitized tree (`renderMarkdown` + `bodyImageSources`), so code fences, code spans
and every other Markdown/HTML subtlety are decided by the renderer itself, not a second parser.

The queue runs at concurrency **2** (the measured throughput plateau) and shares a lock with the
site builder (`uploader/src/work-lock.ts`) so a build and image encoding are **mutually
exclusive** — both peak around 2 GB in one container. The WordPress importer's per-image encodes
take the same lock as shared holders (#95; its fetches do not). A waiting build *preempts* the encode
backlog at the next job boundary rather than queueing behind it, because Publish awaits the
rebuild synchronously in the editor. That mutual exclusion is why `docker-compose.yml`'s
`mem_limit` is sized as `max(build, encode) + baseline` rather than their sum.
On shutdown, `main.ts` closes HTTP admission and quiesces background work together,
then ends the pool and releases storage ownership. Quiescence cancels further file/status
publication and waits for admitted work; abandoned encode rows remain `processing` for
`recover()` on the next boot. Lease loss uses the same quiescence without closing static HTTP.

**Disk headroom (#73):** roughly **17.5 MB per photo** (6.9 MB of variants + the 10.7 MB retained
original) ≈ **1.75 GB per 100 photos**, plus roughly the same again under `/data/backup` because
originals are captured by the incremental image archive — so a 100-photo trip costs about
**4 GB all-in**. `POST /upload` therefore refuses with **507** when `/data` lacks room for the
photo's full cost plus a reserve that keeps a build and a backup able to run; `POST /import`
applies the same precondition sized from the photos it still has to fetch (#94); and `GET /health`
reports free space to an admin session only (as information, never as a health verdict — see SECURITY.md). `heroImage` is a remote URL object
`{src,width,height,alt}`; body images are referenced by URL and rendered as `<picture>` at build
time. This contract is mirrored on the blog side in `site/src/lib/images.ts`.

**CLI subcommands** (alongside `restore`/`set-password`, see
[Database dumps](#database-dumps)):

- `rebuild` — rebuilds the live blog from the current database.
  `docker compose exec app node --import tsx src/cli.ts rebuild`. It does **not** build in the
  CLI process: it mints a one-request admin session, calls `POST /rebuild` on `127.0.0.1` and
  revokes the session in a `finally`. That keeps the build inside the single process whose
  `work-lock.ts` makes building and encoding mutually exclusive — the assumption
  `docker-compose.yml` sizes `mem_limit` against, and which a second unlocked builder would
  break (a build beside the encode queue is ≈4.9 GB against a 4.6 GB ceiling). Minting the
  session is not a new trust boundary: the same CLI already offers `set-password`. Requires the
  app to be running; exits non-zero with the build's own error message on failure. Normal
  publishing never needs it — Publish, unpublish, delete and page saves all build on their own;
  this is for changes made behind the app's back (a `restore`, a hand-run `UPDATE`).
- `audit-exif` — read-only scan of every variant under `STORAGE_DIR`, reporting how many carry
  EXIF and how many carry GPS, and (when any do) which storage keys and whether each has a
  retained `-orig` to re-encode from. Gates whether a remediation pass is needed at all; nothing
  is written. `docker compose exec app node --import tsx src/cli.ts audit-exif`.
- `strip-gps` — **not built, and its trigger never fired.** It would remediate the historical
  corpus (a lossy re-encode for the keys with no retained original), scoped to be added only if
  an `audit-exif` run found GPS-carrying variants. Audits found 102 variant files with EXIF and
  zero with GPS. The "server corpus is unaudited" caveat that used to sit here was retired on
  2026-07-29 with issue #68: there is no production deployment yet, and the WXR importer re-hosts
  via `processImage`, so imported photos pass the `allowedExif()` allow-list at encode time — the
  allow-list is upstream of the importer, not beside it. See SECURITY.md.

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

## Waypoint location lookup

The editor's **Find coordinates** action calls authenticated `POST /geocode`.
`uploader/src/geocoding.ts` performs a bounded Nominatim search via `safeFetch`,
with one app-wide in-flight request, at least 1100ms between starts, and a
100-entry/24h memory cache. This editor-only external service was approved by the
owner on 2026-10-16; public map assets and rendering remain self-hosted.
Selecting a result changes only the existing stop's `lat` and `lng`, then the
ordinary draft save persists them. No schema or publishing changes.

The existing admin-only `POST /settings` accepts `geocodingSearchUrl` to switch
to another Nominatim-compatible HTTPS search endpoint without a software update;
`GET /settings` returns the current value. Default:
`https://nominatim.openstreetmap.org/search`. Set it to `""` to disable lookup.
This operational setting is API-managed, not a new Settings-page field. Other
settings are preserved by partial updates. An alternate endpoint must use the
same JSON response format and OpenStreetMap data attribution. Do not run multiple
independent app replicas against the public service without a shared request budget.
See the [provider usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## AI alt-text (browser-direct providers)

The post editor and photo uploader offer a "Suggest alt text" button per alt field.
The browser downscales the photo and calls the selected OpenAI-compatible vision
provider directly; the app server never contacts a model. Which provider that is comes
from the **AI provider registry** (below): `captionProviderId` (or the default provider)
plus the existing `lmModel`, `captionTimeoutMs`, `captionMaxEdge` and `captionPrompt`.
Authors read `GET /ai-config?purpose=caption`, including resolved `captionBaseUrl` and
request-local `captionApiKey` (null for a local provider, which is never even looked up).

The media library reuses that caption config for photo details (title, DE/EN alt and
caption, tags): `public/media-ai.js` holds the fill rules and the sequential bulk runner,
`public/media-ai-dialog.js` the dialog, and `LLM.describePhoto` shares the caption
transport. The single-photo suggestion only fills the detail panel; the bulk run saves
through the existing `PATCH /media/items/*`, filling empty fields unless overwrite is
chosen, re-reading each row just before its save. No route or schema was added. See
[the design](docs/superpowers/specs/2026-10-18-media-ai-details-design.md).

The editorial-review client (#213, part of #211) shares `public/llm.js`.
`src/editorial-review.ts` owns the pure result type, JSON Schema,
default prompt and parser; the browser parser is checked against the same corpus.
`LLM.reviewStory` sends an active-locale draft snapshot directly to an OpenAI-compatible
provider with an optional request-local Bearer key. Its one deadline covers the initial
request, the single unsupported-`response_format` HTTP 400 fallback, and body reads;
an optional AbortSignal lets the drawer cancel stale work.

The editor's `public/editor-review.js` controller (#215) owns a native modal slide-over:
`EditorLinter.lintStory` renders five immediate checks, then `LLM.reviewStory` resolves
semantic suggestions from the same unsaved active-locale snapshot. A request epoch,
AbortController and editor identity check reject late results after close, re-review,
locale/post changes, restoration or edits. Applying a suggestion dispatches the normal
field input event under an owned-apply guard, preserving dirty tracking and slug derivation
without invalidating the other suggestion. No body rewrite, autosave or publish gate is
introduced. Source jumps close before focusing EasyMDE's zero-indexed line or hero alt;
normal close restores the trigger. Review output is rendered as text and is not persisted.

### AI provider registry (2026-10-19)

`settings.json` holds `aiProviders` (1–20 entries of `{ id, name, kind, baseUrl }`, `kind` one
of `lm-studio` / `openrouter` / `deepseek` / `custom`), `aiDefaultProviderId`, and one
assignment per use case — `reviewProviderId` (Story review & excerpts) and
`captionProviderId` (Photo descriptions: alt text and media details) — where `null` follows
the default. Validation guarantees every reference resolves; a hand-edited dangling id is
repaired on load and logged by field name. Postgres `app_secrets` holds one AES-256-GCM key
per remote provider under `ai_provider_key:<id>`; local providers never hold one.

| Route | Auth | Purpose |
|---|---|---|
| `GET` / `POST /settings` | admin | registry + assignments + kept fields; presence only (`hasApiKey`) |
| `POST /ai-providers`, `PUT` / `DELETE /ai-providers/:id` | admin | provider CRUD with optional key set/replace/remove |
| `GET /ai-providers/:id/credential` | admin | key for Settings' model lookup and **Test** (browser calls only `<baseUrl>/models`) |
| `GET /ai-config[?purpose=caption]` | author | resolved provider + that provider's key, consumer shape unchanged |

Default `GET /ai-config` returns the review provider's `kind` as `aiProvider`, its base URL as
`aiBaseUrl`, and its own key. Local caption config never queries or decrypts secrets and does
not wait on the settings queue, so a broken remote credential cannot break local captions.
Remote reads serialize with settings writes and fail closed on secret errors. Every config and
settings surface is `Cache-Control: no-store`. The first boot of this release migrates a
pre-registry `settings.json` (deterministic ids, `settings.json.pre-ai-registry` kept) and
copies the legacy `ai_api_key` envelope to the providers that used it before deleting it.
See [the design](docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md).

The master key is optional bootstrap `ENCRYPTION_KEY` (32 bytes / 64 hex characters),
forwarded explicitly by Compose. Missing means local-only startup remains available;
supplied malformed values fail before schema work. No secret is stored in settings.json.
Settings and provider writes serialize, validate first, commit the secret, then atomically
rename settings.json. **This is not a transaction across both stores:** a file failure
can leave a new key with the old URL. The API reports partial failure and the UI
clears its input and reloads; saving never runs inference. A key follows its provider's
URL; the UI confirms before an edit moves a stored key to a new URL.
See [the #214 design](docs/superpowers/specs/2026-09-19-encrypted-ai-review-secrets-design.md)
for trust boundaries, failure semantics, key escrow, rotation, and rollback.

## Data model (Postgres)

Created idempotently by `uploader/src/db.ts` (`ensureSchema`):

- **`users`** — `id`, `username` (unique, case-insensitive), `password_hash` (scrypt), `is_admin`, `created_at`.
- **`sessions`** — `id` (SHA-256 of the random token), `user_id` (FK, cascade), `expires_at`. Expired rows are swept hourly.
- **`app_secrets`** — `key` primary key, `ciphertext`, `iv`, `tag` (hex-encoded AES-256-GCM envelope), `updated_at`. One row per remote AI provider (`ai_provider_key:<id>`). The master key and plaintext credentials never enter this table.
- **`posts`** — one row per (`translation_key`, `locale`); `slug`, `title`, `date`, `country`, `country_code`, `region`, `excerpt`, `hero_image` (jsonb), `coordinates` (jsonb), optional `stops`/`route`/`key_facts`, `body_markdown`, `images` (jsonb), `status` (`draft`/`published`), `featured` (boolean, "use as homepage cover" — a SHARED value written to both locale rows, deliberately not unique: the homepage takes the newest flagged story and falls back to the newest story), `comments_enabled` (boolean, SHARED, default `true` — the per-post switch; the site-wide `settings.commentsEnabled`, default `false`, is the real gate). Unique on (`locale`, `slug`) **where `slug <> ''`** — an empty slug means "not set yet" (a DE-first draft without an EN title), so any number of such drafts may coexist; `validateForPublish` requires a real slug per locale (#119).
  Optional **`title_image`** (nullable jsonb) holds an independent per-locale story banner.
  It uses the hero's image shape, including format and focal point. The story header and
  draft preview prefer it; overview, homepage and social images retain `hero_image`.
  Working copies and published snapshots keep separate selections. The additive column
  migration runs before snapshot SQL references it and never backfills an existing snapshot
  from an unpublished working copy.
- **`post_routes`** — one private row per `translation_key`: route version, nullable trimmed
  geometry and latest-original identity/digest/size. No FK to the non-unique locale pair key.
  Post deletion removes this row and records source cleanup in the same transaction.
- **`route_cleanup`** — durable explicit source-deletion intents, excluded from dumps and
  revisions. Cleanup rechecks current references and is retryable across process restarts.
- **`comments`** — reader comments (#204, [spec](docs/superpowers/specs/2026-09-14-comments-design.md)): `id`, `translation_key` (one flat thread per post pair, no FK — `posts` has no single-column pair key), `locale` (the locale the reader posted from), `name`, `body` (plain text, 1–2000 chars, control characters stripped), `status` (`pending`/`approved`/`rejected`/`spam`; every reader row is born `pending`), `is_author` (an admin reply — born `approved`), `sender_hash` (keyed HMAC of the IP for rate limiting, never the raw IP), `created_at`. The legacy `email` column is always `NULL` — no email is collected. `pgPostStore.remove` deletes the thread in the same transaction as the post, and `ensureSchema` sweeps orphans on boot. **Runtime data, not build input:** the Astro build never reads this table — the blog fetches approved comments from `GET /comments?tk=…` at page load, so approving a comment needs no rebuild.
- **`media`** — one row per storage key: `folder` (virtual, decoupled from the key), `title`,
  bilingual `alt_*`/`caption_*`, `tags` (`text[]`), dimensions, byte sizes, `status`
  (`processing`/`ready`/`failed`/`missing`), EXIF (`taken_at`, `camera`, `lens`, `lat`, `lng`)
  and `uploaded_by` (FK, `ON DELETE SET NULL`).
- **`media_folders`** — `path` primary key; the single source of truth for the folder tree
  (every write that sets a `folder` upserts the row and its ancestors).
- **`import_jobs`** — one row per WordPress import (#92): `status` (`running` / `done` /
  `failed` / `interrupted`), `started_by`, timestamps, `progress` (jsonb counters) and the
  final `summary`. Operational state, not content — **excluded from the DB backup** and untouched
  by restore, pruned to the newest 20 rows. `POST /import` runs the pre-flight synchronously and
  answers 202 with the job; `GET /import/status` serves the running job's live counters from
  memory, else the newest row. Boot marks a row the previous process left `running` as
  `interrupted` (`importJobs.recover()`, before `listen()`); the recovery is running the import
  again, which resumes from disk.

> **The filesystem stays the source of truth for a file's existence.** A `media` row is metadata
> *about* a file under `STORAGE_DIR`, never the other way round — which is what preserves the
> property this document relies on elsewhere: photos survive a database loss.
> `uploader/src/media-sync.ts` reconciles the two on boot and on demand
> (`POST /media/rescan`): it backfills rows for keys already on disk, harvests existing alt text
> by **exact URL match only**, and marks a row whose files vanished as `missing` rather than
> deleting it. Its walk matches originals as well as variants, so a crashed upload — which has
> written only `{key}-orig.<ext>` — is discovered as `processing`. Both callers go through
> `createReconciler`, which runs the sync and **then** `encodeQueue.recover()`, so the row is
> actually re-queued (#117: the rescan route used to run the sync alone and strand it until the
> next restart). "Present" means **complete** (#118): a key is `ready` only when every file in
> `variantWidths(intrinsic) × FORMATS` exists, with the intrinsic width probed from the retained
> original (a crash truncates the *top* widths, so the largest surviving variant cannot be
> trusted to define the set); a partial set is `processing` when the original exists and
> `missing` when it does not, and a `ready` row that lost files is demoted the same way on the
> next pass. `storage.ts` writes every original and variant to a `.part-*` temp and renames it
> into place, so a file carrying a final name is never truncated. The report carries
> `recovered` and `demoted` counts alongside the sync counters.

Schema evolution is additive and idempotent — no migration framework, no `schema_version` table.
`ensureSchema` runs on every boot before the server starts serving, so a new column is added in
**both** places: the table's `CREATE TABLE` definition (fresh installs) and a matching
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` appended to the marked column-migrations section at the
end of `ensureSchema` (existing deployments pick it up at the next boot). `NOT NULL` columns must
carry a `DEFAULT`, or the `ALTER` fails on populated tables.

## Backups & disaster recovery

Full recovery needs **two things**: the Postgres content (`users`/`posts`/`pages`) and the
**`/data` volume** (image originals + variants, private GPX originals, site releases, MDX exports
and the in-app backup files themselves). Everything the app writes, including database dumps,
image archives and private route archives under `/data/backup/db/`, lives on the **same server disk** (`/data`
is bind-mounted from `./uploader/data`; `pgdata`, the live database, is a named volume on the
same host). The in-app backups therefore protect against application-level mistakes (bad edit,
botched restore, accidental delete), **not** against disk failure or host loss.

> **Offsite backup is required for real DR:** run a host-level backup (e.g. a restic / borg /
> rsync cron job) of `./uploader/data`. That one directory contains the DB dumps, the image
> archives, private GPX originals/archives, image originals, and settings.json. Encrypted AI credentials additionally require
> **separate offsite master-key escrow**; `/data` and a DB dump cannot recover a lost master key.
> The manual download buttons on the settings page are an escape hatch, not a strategy.

### Database dumps

`uploader/src/backup.ts` provides app-native logical dumps (no `pg_dump`, no sidecar container):

- **Dump format** — one file per run, `/data/backup/db/db-<YYYYMMDD-HHmmss>.json.gz`, containing
  `{ "version": 10, "createdAt": <ISO>, "tables": { "users": […], "posts": […], "pages": […], "media": […], "media_folders": […], "app_secrets": […], "comments": […], "post_routes": […] } }`
  with full column fidelity — an integration test diffs the dumped `posts` keys against
  `information_schema.columns`, so a column added in `db.ts` without touching `backup.ts` fails
  the suite instead of silently vanishing from every backup. The table reads run on one
  client inside a single `REPEATABLE READ` snapshot, so a bulk delete during a backup can never
  produce a dump whose `posts` reference `media` rows that aren't in it. `sessions` are
  **never** dumped — they're disposable, and token hashes don't belong in a backup file. A dump
  **never overwrites an existing file**: names have one-second resolution and every writer
  (scheduler, **Back up now**, the restore CLI's pre-restore dump — a separate process) shares
  the directory, so the finished temp file is published with `link(2)` (fails with `EEXIST`
  where `rename` would clobber) and a taken name advances to the next free second while
  `createdAt` keeps the real time (#114).
  `version` lets restore reject incompatible dumps; the guard is an **allow-list** (1 to 10), so
  every bump must widen it or newly written dumps become unrestorable. v1 predates `pages`, v2
  predates the media tables, v3 predates `posts.categories`/`tags`/`scheduled_at`, v4 predates
  `posts.featured` (the homepage-cover flag); all still restore and leave what they never
  captured alone (for media, `POST /media/rescan` rebuilds the rows from the files on disk; the
  older post columns come back at their defaults — `'{}'`, `'{}'`, `NULL`, `false`).
  v5 predates `app_secrets`: an absent secrets field preserves live rows; a present empty
  array clears them; present rows replace them in the content restore transaction.
  Restore needs no master key, but subsequent decryption needs the original key.
  v6 predates media `format`/`encoding`; v7 preserves both so JPEG-only files and queued
  encoding profiles survive restore. Older dumps restore media with legacy modern defaults.
  v8 (#204) added `comments` and `posts.comments_enabled`. A v≤7 dump has neither: the
  restore **always** replaces the comments table (a thread must not outlive posts the dump may
  not contain), so restoring an older dump leaves it empty, and `comments_enabled` comes back
  `true` (its column default). Comment rows from a dump are not trusted verbatim: `status`
  outside the moderation allow-list restores as `pending`, `is_author` only as the literal
  boolean `true`, and a legacy `email` field is dropped. The restore summary counts comments.
  v9 adds `posts.title_image`; both the working and published selections survive restore.
  Older dumps restore an absent title image as NULL, preserving the hero fallback.
  Older application versions reject v9 rather than silently dropping the new selection.
  v10 adds full private `post_routes`, including detached rows, and a `routeArchive` manifest
  when any route row exists. Its `routes-<stamp>-<random32>.tar` contains retained originals,
  including removed locations and source metadata. It is not a public export or image archive.
  The manifest binds names, byte counts and SHA-256 digests; degraded source states are explicit.
  The archive is published before its dump. Retention follows manifest references, not matching
  timestamps; unreadable manifests stop orphan reclamation. v1–v9 restore with no private routes.
  The CLI names replacement versus preservation and its pre-restore undo dump includes
  current encrypted secrets. Pause AI/settings edits during restore and reconcile the
  providers in settings.json before resuming: that file is not part of a logical DB dump.
  Two ordering details the naive version gets wrong: `media` and `media_folders` are deleted
  **before** `users` (`media.uploaded_by` is `ON DELETE SET NULL`, so the other order silently
  nulls every attribution), and `tags` is `text[]`, which cannot round-trip through the
  `JSON.stringify` path every other non-scalar column uses — it needs a `$n::text[]` bind.
- **Schedule** — admin-configurable in settings: `backupSchedule` (`off` / `daily` / `weekly`,
  default `off`) and `backupRetention` (1–100 files, default 14). An hourly in-process tick (same
  pattern as the session sweep) runs a backup in the first tick of each new calendar window —
  UTC day, or Monday-anchored UTC week — after the last success (an elapsed-time rule drifted an
  hour per day, #113), tracked in `/data/backup/db/state.json`
  (`lastAttemptAt`/`lastSuccessAt`/`lastError`/`lastImagesArchiveAt`); missed windows catch up on
  next boot. After a successful run, dump files beyond the retention count are pruned. Failures
  are recorded and logged, never crash the app.
- **Images archive safety (#113,
  [spec](docs/superpowers/specs/2026-09-05-images-archive-safety-design.md))** — the incremental
  `images-*.tar` is streamed to a `.<pid>.tmp` that is unlinked on any failure, including the
  process exiting mid-stream; stale temps from a SIGKILL are swept at boot and before each run.
  The archive refuses (recorded as `lastError`, cutoff unchanged) when its estimated size plus the
  same 2 GiB reserve `/upload` keeps would not fit. `state.json` is validated field by field, and
  the mtime cutoff is derived from the archives on disk when the state is unusable — a corrupt
  file resumes incrementally from the newest tar's stamp, and a hand-emptied archive dir starts
  a fresh full chain — rather than re-tarring the ~11 GB corpus. Not detected: deleting only
  *some* archives of a chain, and files whose mtime moved backwards (a host-level restore that
  preserves old mtimes) — an mtime incremental never picks those up.
- **Admin UI** (settings page) — schedule, retention, **Back up now**, last-run state and
  separate dump/image/private-route archive lists. Keep each private archive with its matching
  dump; download both for offline recovery. Degraded-source and cleanup status are visible.
- **Routes** (all admin-only): `GET /backups` returns state, running status, dump/image/route
  archive lists and route cleanup state; `POST /backups` returns **409** while already running.
  `GET /backups/:name` is `no-store`, accepts only strict dump/archive basenames and opens
  regular, single-link files without following symlinks.
- **Restore is CLI-only** (destructive, so no web button):
  Stop the app and wait for its work and database sessions to drain; keep Postgres running.
  Then run the same configured image/volumes without starting the app service:
  `docker compose run --rm --no-deps --entrypoint node app --import tsx src/cli.ts restore [--yes] /data/backup/db/<file>`.
  A running app holds the ownership lease, so `docker compose exec app … restore` is refused.
  Outside Docker, stop the configured app process and run `node --import tsx src/cli.ts restore <file>`
  with the same database/storage settings. Do not run other maintenance writers concurrently.
  Before anything destructive, restore (#114 and #313) refuses a file name
  outside `db-YYYYMMDD-HHmmss.json.gz` (the same pattern the download route enforces); rejects
  an unsupported dump `version`; prints the target database (`host:port/dbname`, never the
  credentials), the dump's `createdAt` and per-table counts, and the **live** per-table counts
  about to be replaced; then asks for the literal line `yes` — `--yes` skips the prompt for
  scripted use, and EOF/anything else aborts with nothing changed. It then writes a
  **pre-restore recovery set** of the current state into `BACKUP_DIR/db/`, verifies that
  set, and aborts if it cannot be safely restored. A v10 input is fully validated against its
  paired archive before database replacement. Originals stage under fresh identities, then
  database replacement commits in one transaction. Missing/corrupt/degraded originals are
  reported rather than silently reconstructed. Lost COMMIT acknowledgement retains both
  source sets; do not manually delete them while the outcome is unresolved.
  Deleting users invalidates every login. Start the app again only after the CLI exits;
  then sign in and explicitly rebuild the site. The prior static release remains unchanged
  until that rebuild. The CLI prints the verified undo dump path.
- **Storage lease loss:** `/health` returns 503 with `storageWritable: false`; mutations
  return `storage_read_only`. Static pages/images remain available. Confirm Postgres is
  healthy and no restore is running, then restart the same app configuration
  (`docker compose restart app`, or restart the bare Node process). Writes never resume
  automatically in a process that lost its lease.
- **Admin password recovery** — a forgotten password is reset from the host via the CLI (the
  runtime image has no shell, so use the exec form):
  `docker compose exec app node --import tsx src/cli.ts set-password <username>` — prompts for
  the new password when omitted (input is echoed; passing it as an argument would expose it in
  the container's process list), enforces the same 12–1024 character policy as the web forms
  (#109), and invalidates that user's sessions. Routine rotation while logged in: the "Change my
  password" card on `/admin/users.html`. A **login lockout** (100 failed attempts on the account
  within 15 minutes, from any addresses) lives in process memory: it expires on its own 15 minutes
  after the last failure, or `docker compose restart app` clears it at once — `set-password` does
  not, since the CLI is a separate process (see `SECURITY.md`, *Rate limiting*). Last-resort
  fallback: `docker compose exec db psql -U images -d images -c 'DELETE FROM users;'` re-opens
  `/setup` (zero-users check) on the next visit to `/login`. That deletes **only** accounts and
  their cascaded sessions — `posts`, `pages`, and images carry no user FK and are untouched.

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
- **Importer keys** — the WordPress importer writes a body/gallery photo under
  `trips/<slug>/<name>_<h8>`, where `<name>` is the source filename slugified and cut to 48
  characters and `<h8>` is the first 8 hex of SHA-256 over the source URL (#98; the `_` keeps the
  namespace disjoint from pre-#98 keys and from `contentHashKey`'s `-<hash>`); the featured image
  is `trips/<slug>/hero`. The key is a pure function of (slug, URL) — never of bytes or fetch order
  — because `/data/images` is the importer's resume record (#85): a re-run resolves the same key
  and skips what is complete on disk. Photos imported before #98 sit under the plain
  `trips/<slug>/<name>` and stay resumable while that name is unique within the pair.
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
| `ENCRYPTION_KEY` | app | Optional 64-hex master key for encrypted AI credentials; unset permits local workflows, malformed values refuse boot; escrow separately |
| `PUBLIC_BASE_URL` | app | Public base for image URLs (e.g. `https://img.simonswanderlust.com`) |
| `IMG_HOST` | app | Hostname routed to the image-variant static handler (defaults to the host of `PUBLIC_BASE_URL`) |
| `SITE_APP_DIR` | app | Path to the Astro project the builder spawns (`/app/site`) |
| `SITE_DIR` | app | Release root for the built blog (`/data/site`) — `current` is served from here |
| `MAP_DIR` | app | PMTiles/glyph assets root for `/map/` (`/map-assets`) |
| `STORAGE_DIR` | app | On-disk image originals + variants (`/data/images`) |
| `SETTINGS_PATH` | app | JSON settings store; defaults to `settings.json` beside `STORAGE_DIR` (`/data/settings.json`) |
| `BACKUP_DIR` | app | Root for MDX export backups and (in `db/`) database dumps; defaults to `backup/` beside `STORAGE_DIR` (`/data/backup`), for the app and the restore CLI alike |
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
