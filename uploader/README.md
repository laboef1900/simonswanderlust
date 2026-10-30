# simonswanderlust-images

Self-hosted image uploader **and admin CMS** for the Astro blog: uploads a photo and generates
responsive AVIF/WebP variants (or JPEG for JPG uploads when conversion is off), and hosts the in-admin editor, the media library and the WordPress
import — and, since the single-app-container merge, **also serves the public blog itself**
and runs its Astro builds in-process (no separate build server). How it fits the rest of the
stack: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Security model: [`../SECURITY.md`](../SECURITY.md).

> Published variants carry an **eight-tag EXIF allow-list**, not the source metadata — no GPS, no
> XMP, no IPTC. The untouched `-orig` retains everything but is never served. Widening that list
> is a privacy change; see [`../SECURITY.md`](../SECURITY.md).

## Contract

Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp` by default or `jpeg` for JPEG-only images.
Image references carry `format: 'jpeg'` for the latter; omission preserves the existing
modern-format contract. Must match the blog's `site/src/lib/images.ts`. `/upload` and the CLI
hash the original bytes **and encoding settings** into a short key suffix (`…/hero-<hash8>`),
so changing the photo or encoding profile mints a new URL and old URLs keep serving —
which is what justifies serving variants with a
one-year immutable cache. (WP-import rehost keys stay deterministic so
re-imports are idempotent.) The untouched upload is additionally persisted as
`{key}-orig.<ext>` next to the variants, so the images dir is a complete media
archive (and future re-encodes stay possible). Originals exist only for uploads
made from this version onward; earlier uploads exist as variants only.

### Image conversion settings

Open **Settings → Images**:

- **Convert JPG images to WebP and AVIF** is on by default. Turn it off to create responsive
  JPEG variants from new JPG uploads. JPEG output still corrects orientation, strips GPS and
  uses the same metadata allow-list; it is not a public copy of the original.
- **WebP quality** and **AVIF quality** accept whole numbers from 1 to 100; defaults are 75
  and 55. Higher values generally mean larger files. These controls do not change JPEG output
  (quality 90), and non-JPEG uploads still produce both modern formats.
- **Save image settings** saves this section independently of pending AI or backup edits.
  No redeploy is needed. Existing photos are not automatically reprocessed, and queued uploads
  retain their captured settings through retries/restarts. The CLI reads the same settings store.
- **Compare quality** encodes one test photo with the current (possibly unsaved) WebP or AVIF
  quality through the same encoder as real uploads, at `min(photo width, 1920)` px, and shows
  the original and the result side by side with pixel size, file size and the saving (plus a
  synchronized **1:1 pixels** view). Admin-only `POST /settings/image-preview`; nothing is
  stored, logged or added to the library, the result carries no EXIF, and the encode runs under
  the shared work-lock (a site build goes first) with one preview at a time (429 otherwise).
  See `docs/superpowers/specs/2026-10-19-image-quality-preview-design.md`.

New import work uses the settings; complete body/gallery variant sets are reused regardless
of the current preference. The importer's explicit **overwrite existing drafts** option still
has its existing featured-image overwrite semantics. Untouched originals remain private.
Backup v7 preserves each media item's format and encoding profile.

---

## Install & run locally (Docker — recommended)

**Prerequisite:** Docker Desktop (or any Docker Engine) running. Check with
`docker info`.

```bash
# 1. From the monorepo root (the docker-compose.yml lives there, not in uploader/),
#    create your env file from the uploader's template:
cp uploader/.env.example .env

# 2. Set a strong Postgres password and the matching DATABASE_URL in .env:
#    POSTGRES_PASSWORD=<long-random-string>
#    DATABASE_URL=postgres://images:<same-password>@db:5432/images
#    PUBLIC_BASE_URL=http://localhost:3000

# 3. Build the image (compose has no build: key, so `--build` is a no-op) and
#    start the containers in the background:
docker build -t ghcr.io/laboef1900/simonswanderlust-app:local .
IMAGE_TAG=local docker compose up -d

# 4. First run — open /login to create the first admin account:
open http://localhost:3000/login      # macOS (or just browse to the URL)
```

On first run, when no users exist, `/login` shows a "Create the first admin"
form. Fill in a username and password to create the admin account; the form is
closed once any user exists. Sign in at `/login`, then pick a key
(e.g. `trips/rhodes-2021/hero`) and alt text, choose a photo, and click
**Upload** — the page prints the `heroImage:` snippet to paste into the post's
frontmatter.

Uploaded variants — plus the untouched original as `{key}-orig.<ext>` — are
written to `./data/images/` on the host (a Docker volume), so they survive
container restarts. `./data/` is git-ignored. Note that `./data/` (images,
site releases, and the in-app backups) lives on the same disk as everything
else: for disaster recovery, keep a host-level offsite backup of it — see
[`../ARCHITECTURE.md`](../ARCHITECTURE.md#backups--disaster-recovery).

**Manage the container:**

```bash
docker compose logs -f      # follow logs
docker compose restart      # restart after an .env change
docker compose down         # stop and remove the container (keeps ./data)
```

**Quick end-to-end check** (log in via cookie jar, then upload):

```bash
node -e "require('sharp')({create:{width:1600,height:1067,channels:3,background:'#357'}}).jpeg().toFile('/tmp/sample.jpg')"
# Log in (stores the session cookie in cookies.txt), then upload with it.
curl -s -c cookies.txt -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"username":"simon","password":"YOUR_PASSWORD"}'
curl -s -b cookies.txt -X POST http://localhost:3000/upload \
  -F key=trips/smoke/hero -F alt="Smoke" -F file=@/tmp/sample.jpg
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/hero-640.webp  # -> 200
```

## Run locally without Docker (Node)

**Prerequisite:** Node >= 26, a local Postgres instance.

```bash
npm install
DATABASE_URL=postgres://images:YOUR_PASSWORD@127.0.0.1:5432/images \
  STORAGE_DIR=./data/images PUBLIC_BASE_URL=http://localhost:3000 npm start
# -> "image uploader listening on :3000", open /login to create the first admin
```

For an isolated feature worktree, set absolute writable paths for `STORAGE_DIR`,
`SETTINGS_PATH`, `SITE_DIR` and `SITE_APP_DIR`, plus `HOST=127.0.0.1` and a separate
`PORT`. Set `MAP_DIR` to the self-hosted basemap assets. Use a dedicated database;
integration tests require a different `TEST_DATABASE_URL`, never the content database.
An empty `SITE_DIR` starts a build from `SITE_APP_DIR`, so check both paths before launch.

---

## Deploy to your server

1. Copy the repo to the server.
2. From the monorepo root: `cp uploader/.env.example .env`, set a strong `POSTGRES_PASSWORD`, the
   matching `DATABASE_URL`, and `PUBLIC_BASE_URL=https://img.simonswanderlust.com`.
3. Build and run: `docker build -t ghcr.io/laboef1900/simonswanderlust-app:local .` then
   `IMAGE_TAG=local docker compose up -d` (compose has no `build:` key, so plain
   `docker compose up -d --build` is a no-op) — or, to run the released GHCR image instead of
   building: `docker compose pull && docker compose up -d`.
4. Because the container runs non-root (uid 1000), make its data bind-mount writable once — this
   now covers image variants *and* the built blog output, since both live under the same `/data`
   volume: `mkdir -p uploader/data && sudo chown -R 1000:1000 uploader/data` (run from the
   monorepo root).
5. Run **one host-level TLS proxy** (nginx/Caddy/Traefik), without a CDN or additional proxy
   hop: **both** `https://simonswanderlust.com` **and** `https://img.simonswanderlust.com`
   → `127.0.0.1:3000`. One Fastify process serves both domains; its raw `Host` check
   (`IMG_HOST`) selects image variants versus blog/admin.
   Preserve the verbatim `Host`, overwrite `X-Forwarded-Proto` with the proxy's scheme,
   and append or overwrite XFF so the rightmost address is the client the proxy accepted.
   nginx: `proxy_set_header Host $http_host;`,
   `proxy_set_header X-Forwarded-Proto $scheme;`,
   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
   Never rely on an upstream-name `Host` rewrite: it sends image requests to blog/admin.
   Compose's literal `TRUSTED_PROXY: docker-gateway` trusts only loopback and the discovered
   bridge gateway at hop zero. Do not put it in `.env`; a different network/proxy topology
   requires a new spec. Failed gateway discovery refuses boot rather than losing `Secure`
   cookies or collapsing every reader into one limiter bucket.
6. Open `https://simonswanderlust.com/login` to create the first admin account, then upload.
   Before public cutover, inspect the target server's observed proxy peer, confirm `Secure`
   on an HTTPS login, and verify independent login-limit buckets from two external networks.
   The #369 Docker Desktop production-image TCP probe covers the Linux VM host-network
   proxy → app bridge path, not the target VPS's published-loopback/NAT configuration.

The admin panel is reachable directly at `https://simonswanderlust.com/admin/` — the same process
serves it, so there's nothing to proxy to separately anymore.

The landing page is the publishing **Desk**: it features the most recently edited draft pair,
lists published trips with saved changes, reports the photo-processing count, and links to the
current live site. Those three data sources load independently. If posts, queue status, or health
is unavailable, only that section shows a retry; unknown queue/release state is never presented as
an idle queue or as confirmation that no release exists.

### Security notes

Full details in [`../SECURITY.md`](../SECURITY.md); the essentials:

- **Public hosting requires the documented host TLS proxy.** Forwarded headers are accepted
  only from an allow-listed immediate peer, never from an arbitrary bridge container.
  Host-local processes remain inside the trust boundary. The proxy must preserve `Host`,
  overwrite forwarded protocol and supply the accepted client as rightmost XFF. Never expose
  port 3000 directly or broaden trust to a subnet to compensate for misconfiguration.
- **Password-verifying endpoints are rate-limited** per client IP (`/login`, `/setup`, and the
  authenticated `POST /users/me/password`: 10 requests per 15 minutes) to slow brute-force; they
  share one bucket, so failed current-password guesses count against login attempts from that IP.
  `/login` also locks an account after 100 failed attempts within 15 minutes from any addresses —
  ten times the per-IP budget, so one client cannot lock the admin out (#109); the lock is
  in-memory and `docker compose restart app` clears it. Passwords are 12–1024 characters
  everywhere, including the CLI reset; usernames at most 64.
- **Publishing is admin-only.** Non-admin accounts can create and edit drafts but cannot publish
  to the public site or change a published slug; only admins can publish.
- **WordPress import is admin-only and SSRF-guarded.** Only admins can run `/admin/import.html`
  (it creates drafts, writes under `/data`, and fetches from the host named in the export);
  remote image fetches reject internal/loopback addresses, time out, and cap the download size;
  imported slugs are validated before anything is written.

## GPX routes

**Story details → GPX route** accepts a `.gpx` file up to 5 MiB. Authors can inspect,
trim by point count/distance, remove whole segments, and explicitly attach the result.
The self-hosted map has a no-basemap grid and a local SVG fallback; no GPX operation
calls a remote tile, geocoder or AI provider. Publishing remains admin-only.

- On a new post, **Save draft and attach route** saves the form first. If attachment
  then fails, the saved draft remains and the preview can be retried. On an existing
  post, **Attach route** saves only the private route, not unsaved text or metadata.
- A confirmed replacement deletes the superseded original. **Detach route** keeps the
  latest original for **Load original again**. Post deletion removes it; old backups
  remain subject to retention. Failed file cleanup is reported and retried.
- Closing/discarding a preview cancels its staged original. Abandoned staging expires
  after one hour. Preview geometry, source metadata, selections and tokens never enter
  browser draft storage or text revisions.
- Waypoints start unchecked. Explicitly adopted stops keep exact coordinates and one
  shared name for DE/EN, independently of route trimming. Save them through the normal
  draft action; closing the route dialog does not undo adoption.
- The solid preview is the actual public candidate: separate runs, 25 m simplification,
  four-decimal 2D coordinates, at most 100 runs / 2,000 vertices / 64 KiB. Wait for validation;
  collapsed/over-limit candidates require more trimming or replacement, not weaker precision.
  These limits are not anonymization. The server derives and checks the same candidate.
- Only admin Publish copies the artifact into both locale snapshots. Route edits and
  detachment remain draft-only through Save and Rebuild. A failed build keeps the old
  static release served; a later rebuild uses the committed snapshot.
- Story maps and their localized per-run textual alternatives use only the public artifact.
  MDX exports working-copy prose but only the last published track; overview maps stay pin-only.
- Private originals and dump/archive recovery sets retain removed locations, elevation,
  timestamps and source metadata. Download paired private recovery files from Settings;
  keep them confidential. MDX is not a private-route backup.

See the [approved contract](../docs/superpowers/specs/2026-10-23-gpx-route-import-design.md)
for the private (#313) and public snapshot (#314) boundaries.
For offline restore, verified undo sets and `storage_read_only` recovery, follow
[Database dumps](../ARCHITECTURE.md#database-dumps). A running app prevents restore;
do not bypass the ownership/session drain checks.

## Media library

`/admin/media.html` is the browsable store behind every photo the blog serves — one row per
storage key, not per variant file. Bulk drag-and-drop upload, virtual folders (a `media_folders`
table; moving a photo re-labels it, it does not move bytes on disk), search, and per-item alt text
that the gallery picker reuses.

Re-uploading the same file preserves its existing non-root folder, including when recovering
a `failed` or `missing` photo, even if the recovery attempt is refused by a full queue.
A ready photo or a failed/missing photo being re-created may adopt the upload's selected
folder only while still in the root; the upload response reports the stored folder.
Processing and `queue_full` recovery retain all stored metadata, including a root folder.
Other recovery keeps existing title, alt, caption and tags when the upload supplies no
replacement metadata.

The shared image picker in `public/media-picker.js` exposes read-only folder navigation
for title images, heroes, and galleries. It uses `MediaApi.folderTree`, the Media page's
folder styles, and the existing `/media/folders` endpoint. Folder views include descendants;
search and pagination stay scoped to the folder. Selection/order survives folder changes,
and stale list responses cannot repaint a newer view. Folder loading is independent of photo
loading, so a failed folder request does not prevent searching all photos. At narrow widths
the folder list becomes a native disclosure. `test/media-picker-dom.test.ts` exercises these
behaviors against the real in-memory store's filters.

Encoding is **asynchronous**: an upload lands, its row goes `processing`, and `encode-queue.ts`
works the backlog at concurrency 2. A build preempts the queue — both take the same mutex in
`work-lock.ts`, so a publish never competes with an encode. Rows survive restarts: the boot pass
and `POST /media/rescan` both run `createReconciler` (`media-sync` reconciles disk against the
database — backfilling rows for keys already on disk, harvesting alt text by exact URL match,
flagging rows whose files have vanished, and demoting a `ready` row whose variant set is no
longer complete for its original's width — and then `encodeQueue.recover()` re-seeds the queue
from `status = 'processing'`). Variant and original files are written atomically (temp +
rename), so a crash never leaves a truncated file under a final name.

The Media grid refreshes automatically when uploads complete, with a 200 ms debounce for
bursts. **Clear finished** is not needed to show the accepted photos; queue entries stay
visible until cleared. Refreshes retain the current folder, search, status filter, sort and
page, so a photo outside that query will not appear there. Selections still in view and
unsaved detail edits survive the refresh; switching to another photo still asks before
discarding edits. Keyboard focus stays on the same visible photo even if its sort position
changes. The refresh preserves whichever photo is focused when the response is rendered,
not when the request started, and does not pull focus away from search, upload, folder,
queue or detail controls. A focused detail field keeps its caret and selection even before
the first edit; explicit **Save details** still refreshes the saved values and clears the
unsaved state. If an automatic completion refresh overtakes an explicit Save or folder
change, the winning response still completes that explicit update rather than retaining
an old detail baseline or folder navigation. Arrow and Space navigation continue from the
restored photo.
The queue's **done** means the upload was accepted, not that encoding has
finished: the grid displays the status returned by the server, including **processing**.
This is a completion-triggered refresh, not continuous polling for encoding progress.

The backlog admits at most 200 waiting jobs, in addition to the two running jobs. When an
upload receives **429** because that backlog is full, a new photo keeps its original as
`failed` / `queue_full`, not stranded `processing`; an existing photo's prior status/error is
restored unless another request already admitted or completed its job. Once capacity returns,
**Retry** or re-uploading the same bytes encodes the retained photo. Re-upload also repairs an
older orphan `processing` row by enqueueing it when no active job owns the key (#348).
Upload, Retry, and boot/rescan recovery serialize admission and refusal rollback for the
same key, including the awaited status write. Recovery re-reads the row after waiting rather
than admitting a stale `processing` snapshot. Re-uploading a `queue_full` photo changes only
its status and restores its original; curated folder, localized descriptions, title, tags,
and the saved encoding profile are retained even across repeated refusals.
Recovery starts each admitted job immediately, so a later candidate's database read failure
does not strand earlier admissions. The rescan still reports the error; already admitted
photos finish independently, while remaining `processing` photos can recover on a later rescan.

Three consequences worth knowing:

- **Publishing is gated on encode state.** A post referencing a photo that is not yet `ready` is
  refused rather than published with a broken image.
- **Deleting is gated on usage in both copies, and on the encoder.** `DELETE /media/items/*`
  refuses (409) while any post's working copy **or published snapshot** — what the blog is
  actually built from — still references the photo, or any page does. A draft that swapped a
  photo out does not make the old one deletable until the post is republished (or unpublished);
  the response's `usedIn` entries carry `published`/`working` flags so the library can say
  "(published version)". It also refuses while the photo is `processing` or its key is queued /
  in flight: the running job would write variants under the deleted key and the next rescan would
  resurrect it as a `ready` row with no original. Should a row still vanish mid-encode, the queue
  discards the result and unlinks what it wrote instead of writing `ready` into thin air.
- **`GET /media` redacts for non-admins** — GPS (`lat`/`lng`) and uploader identity are stripped.
  Never return a raw row.

Irreversible operations (`DELETE /media/items/*`, `PATCH`/`DELETE /media/folders`,
`POST /media/rescan`) are admin-only.

## Comment moderation

`/admin/comments.html` (admin-only, like Settings) is the queue for reader comments on trip
reports. Every reader comment lands `pending` and is invisible to the public until approved.
The page lists pending (default) or approved comments with name, body, post key, locale and
time — all painted as text, never markup — and offers **Approve** / **Unapprove**, **Delete**
and **Spam** (both permanent, both confirm the scope), and **Reply as author**, which inserts an
approved, author-flagged sibling on the same thread without passing through the queue. The
routes behind it (`GET /moderation/comments`, `POST /moderation/comments/:id/status`,
`DELETE /moderation/comments/:id`, `POST /moderation/comments/:id/reply`) are all
`requireAdmin`: unauthenticated callers get 401, authors 403, and a non-UUID id is a 400.
Approving does not rebuild the site — comments are runtime data, never baked by `astro build`.

Unsent author replies stay in memory, keyed by comment ID, while this page is open.
Only one reply can be sending per comment ID: its submit button stays disabled even
when filtering or moderation recreates the row, and becomes available again after
success or failure so a later intentional reply or retry is possible.
Moderation actions and switching between Pending and Approved preserve other replies;
hidden rows recover their own draft when shown again. A successful reply clears only
the submitted text, preserving newer edits made while it was sending; failed replies
keep their input. List refreshes restore the active row control and textarea selection
when that row remains visible, or focus the status filter when it disappears. Drafts
are not saved to browser storage or the server: navigating away or reloading the page
discards them.

## Galleries

Several photos render as one grid from a fenced ```` ```gallery ```` block, one image URL per line.
Authors get it from **"Insert / edit gallery"** on either locale tab, which opens the library in
multi-select mode with an ordering strip; the button writes exactly the text a person would type by
hand. Per-line `| WxH | alt="…" | caption="…"` metadata is lifted into the post's `images` map at
the store chokepoint (`normalizeGalleryFences`), leaving the body as bare URLs.

Three layout modes, selected by a `#layout:` line **inside** the fence — `column` (default,
justified rows aligned to body text), `breakout` (justified rows wider than the story column), and
`slider`. All three get a `<dialog>` lightbox. An unknown or absent directive falls back to
`column` (the default was `breakout` until 2026-09-20; the picker writes `#layout: breakout` for
a gallery that should stay wide). The directive lives inside the fence rather than on the opener
because an info-string argument is discarded before the renderer ever sees it.

Author-facing detail is in [`../docs/authoring-workflow.md`](../docs/authoring-workflow.md).

> **Gallery markup is injected *after* `rehype-sanitize`**, so it inherits none of its protections.
> URLs are allow-listed by **origin equality** (never a prefix match), alt/caption are coerced with
> `String()`, and dimensions are validated before reaching markup arithmetic. Validation lives at
> the `posts.ts`/`pages.ts` store chokepoint, not in `validateDraft` — the WXR importer bypasses
> the latter.

## AI alt-text (browser-direct providers)

Settings → **AI models** keeps a **Providers** list (Local LM Studio by default; add
OpenRouter, DeepSeek, or any custom HTTP(S) OpenAI-compatible endpoint, each with its own
name, base URL and, for remote providers, its own encrypted API key) and a **Use case
assignments** grid. **Photo descriptions** (alt text and media details) picks a provider —
or follows the default — and a model; its prompt/timeout/output budget/max edge are independent
of review.
Select a **vision-capable model**; a provider's model list does not guarantee image support.

The editor and photo uploader send a resized JPEG and caption prompt directly from
the browser to that provider, with that provider's own key. The app server never contacts
the model. Use only photos you intend to share with the selected provider; usage charges may
apply.

The use-case **Model** fields are dropdowns filled from the provider's own model list. When the
AI models tab opens, and whenever a row's provider changes (or its refresh button is pressed),
the browser lists models (`GET <baseUrl>/models` only — never a completion) for each assigned
provider; remote providers use their stored key, fetched request-locally from the admin-only
`GET /ai-providers/:id/credential`. A saved model the provider does not list stays selectable,
and **Other model ID…** takes any ID by hand (for example when browser CORS blocks the list).
**Test** on a provider row (or **Test connection** in its edit form) lists models on demand,
with the typed key if one is entered. Listing sends no photo and does not verify vision
support. Custom providers must allow browser CORS. Local LM Studio providers never hold or
receive a key.

**Maximum output tokens** sets the per-photo output ceiling for both editor/uploader
alt-text suggestions and media-library AI details (single and bulk). Default **8,000**;
allowed range **256–32,768**, whole numbers only. Reasoning models spend this same budget
on thinking and the final answer: DeepSeek exhausted the former fixed 1,000-token
photo-details limit before returning any metadata. A higher ceiling permits more work
and may increase provider charges and latency; the chosen model must support it.
This does not toggle thinking or change the separate caption timeout. Existing settings
files without the field use 8,000; saved values survive restart.

Alt-text suggestions discard case-insensitive `<think>…</think>` blocks, including
an unfinished block through the end of the reply. A `finish_reason: "length"` reply
is refused even if it contains valid-looking caption JSON. Hero/body fields and
hosted-gallery alt text retain their existing value on refusal; the token-limit
hint names **Maximum output tokens** rather than suggesting a connection problem.
Gallery suggestions still require explicit acceptance before changing Markdown.

Non-secret settings (`aiProviders`, `aiDefaultProviderId`, `captionProviderId`, `lmModel`,
`captionTimeoutMs`, `captionMaxTokens`, `captionMaxEdge`, `captionPrompt`) live in settings.json.
Authenticated `GET /ai-config?purpose=caption` resolves `captionBaseUrl` and provides
`captionApiKey` only for a remote photo provider. Local captions remain usable with broken or
missing remote credentials. Editor suggestions fill editable alt text, never autosave/publish.
See `docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md`.

**Media library photo details.** `public/media-ai.js` (pure rules, unit-tested) and
`public/media-ai-dialog.js` (bulk dialog) use the same caption config, key and display
variant to call `LLM.describePhoto`, which asks for `{title, altEn, altDe, captionEn,
captionDe, tags}`; the saved caption prompt is house guidance for the alt fields only.
`LLM.parsePhotoDetails` keeps bounded single-line text and normalized tags, and never
invents a missing field. **Suggest with AI** in the detail panel fills empty fields and
offers the rest beside their text; **Save details** still saves. The bulk dialog (selected
photos, or every photo in the current folder/filter view) **does save**, photo by photo
through `PATCH /media/items/*`: by default only empty fields, re-checked against the row
just before each save, so re-running continues a stopped run. **Replace text that is
already filled in** is opt-in per run. A suggestion never clears a field, Stop sends no
further save, and three failures in a row stop the run. Library metadata changes no
published story. See `docs/superpowers/specs/2026-10-18-media-ai-details-design.md`.

**Gallery photo CORS:** before contacting a model, the browser downloads the hosted
display variant and resizes it. When the editor and image host use different origins,
the image response must allow that read. Public variants carry
`Access-Control-Allow-Origin: *`; authenticated APIs and private originals do not.
An image may display normally while JavaScript cannot read it. A console error naming
the image URL and a missing CORS header means inference has not started, even if
**Test connection** succeeds. Deploy the app fix to the service serving `IMG_HOST`.
If a browser or reverse proxy still serves an older immutable response without the
header, bypass the browser cache (DevTools → Network → Disable cache) while retrying,
and invalidate any proxy-cached response for the affected variant. No site rebuild,
image re-encode, provider change or key replacement is required for this fix.

### Editorial-review client API (#213)

`public/llm.js` also exports
`LLM.reviewStory(baseUrl, model, prompt, story, apiKey, timeoutMs, signal?)` and
`LLM.parseEditorialReview(content)`. The story is an active-locale snapshot:
`{ locale: 'de' | 'en', title, excerpt, markdown, heroAlt, heroSrc }`, with string text
fields. It is sent as untrusted JSON in a user message, separate from the review prompt.
`src/editorial-review.ts` exports `EditorialReviewResult`, `DEFAULT_REVIEW_PROMPT`,
`EDITORIAL_REVIEW_SCHEMA`, and the matching pure parser.

The parser accepts JSON wrapped in prose/fences or preceded by `<think>` reasoning,
but rejects missing fields, wrong types/statuses, and extra keys. It strips Unicode
control characters, caps text at 1,000 UTF-16 units, and caps each list at 10 strings
of 200 units (without splitting surrogate pairs). Empty strings/lists are allowed;
title suggestions and the suggested excerpt are optional. Alt-text observations use
`practicalDetails`, because the agreed result contract has no separate alt-text section.
Parsing also bounds synchronous work: raw output may contain at most 128 Ki UTF-16
units, with at most 32 open objects and 128 completed object candidates. A single
string-aware traversal still recovers a valid review after unmatched prose braces;
it never repeatedly scans the same suffix. Exceeding a bound rejects the response,
rather than blocking the browser before its deadline/cancellation handler can run.

Review calls use a 60-second default deadline (positive values up to 600,000 ms),
covering response reads and at most one fallback without `response_format` after an
HTTP 400 explicitly identifying that parameter as unsupported. Cancellation rejects
with `AbortError`; deadline expiry with `TimeoutError`. Other failures are sanitized,
without provider error text, draft content or keys. Redirects are refused, cookies are
omitted, and OpenRouter attribution is attached only for hostname `openrouter.ai`.
Base URLs must be HTTP(S) with no credentials, query or fragment.

`public/editor-review.js` integrates this client with the editor's **Review Story**
drawer (#215). Captions and model discovery also use request-local credentials when remote.

### Country coordinates and excerpt assistance

`public/country-coordinates.js` resolves German/English country names or ISO2 codes against
`public/country-centers.js`, an offline table of approximate label points from public-domain
Natural Earth v5.1.2. `node scripts/build-country-centers.mjs` regenerates the table from
the pinned upstream GeoJSON. No runtime geocoding or provider request is involved.
Committed country edits fill empty coordinates/ISO codes; subsequent edits follow only
session-owned automatic values. Saved/manual values are retained, conflicting locale
countries are refused, and **Use country center** is an explicit replacement action.

`public/editor-excerpt.js` fetches the existing `/ai-config` and calls
`LLM.suggestExcerpt(baseUrl, model, guidance, { locale, title, markdown }, apiKey?, timeoutMs?, signal?)`.
It shares Story Review's provider, model, prompt-as-editorial-guidance, timeout, and key.
The dedicated task asks for 100–160 characters in the active language; the parser accepts
only `{"excerpt":"…"}` with plain text up to 300 characters, rejecting rather than
truncating invalid output. The shared review transport preserves its cancellation,
redirect, credential, and response-format fallback rules.

The generator previews the suggestion next to the locale's excerpt. Explicit acceptance
is required; no request saves or publishes. Draft edits, locale switches, and loading a
different post invalidate results, with a second snapshot comparison on acceptance.
Provider failure leaves the current excerpt untouched. New chrome lives in both locales
of `site/src/i18n/ui.ts`.


### AI providers and encrypted credentials (#214, registry 2026-10-19)

Settings → **AI models** → **Use case assignments** → **Story review & excerpts** picks a
provider from the Providers list (or follows the default) and a model. The excerpt generator
uses these same settings. Review instructions/timeout sit below the grid and stay separate
from captions. The default provider on a fresh install is Local LM Studio; remote inference
is optional. **Save AI settings** saves assignments, models, prompts and timeouts; no
inference occurs on save.

For remote credentials, privately generate a master key with `openssl rand -hex 32`, store
its 64 hex characters as `ENCRYPTION_KEY` in the untracked root `.env`, and recreate the
app container so Compose injects it. Never share its output or `docker compose config`
output containing it. Leave the variable **unset**, not empty, for local-only use.
Malformed supplied keys refuse boot; missing keys permit local startup/captions but
encrypted operations report `ENCRYPTION_KEY not configured in .env`.

Each remote provider has its own masked **API key** field in its Add/Edit form. OpenRouter
and DeepSeek require one; Local LM Studio providers never hold one. Blank leaves a stored key
untouched; **Remove stored key** explicitly deletes it after confirmation. "Key stored" means
stored, not tested. Postgres stores AES-256-GCM ciphertext; **every signed-in author receives
the key of the provider assigned to a use case, in browser memory**, for direct provider calls
— never the key of an unassigned provider. The server never contacts a model. The assigned
providers receive review/excerpt content or resized caption photos; use provider-side limits
and revoke/reissue a credential after suspected exposure.

A key is bound to its provider: switching a use case to another provider sends that
provider's key. Editing a provider's base URL while it holds a key asks for confirmation,
naming both URLs. **Set default** confirms when it moves a use case that follows the default
to another destination. A provider can be deleted only when it is neither the default nor
assigned. Prefer HTTPS for custom endpoints. Browser CORS/mixed-content failures are not
bypassed by a server proxy.

**Test review** tests the selected review provider, model, instructions and timeout
from the browser with a built-in sample, never an author's draft. It does not save settings
or keys. A successful test requires a valid structured review, not just a reachable endpoint.
Provider usage charges may apply. A remote provider's stored key comes from the admin-only
`GET /ai-providers/:id/credential`, request-local. Missing required keys are caught before
provider calls. Authentication, credit, rate-limit and timeout failures do not display
provider response bodies. Editing a review field cancels the running test and clears its
result. Testing never runs automatically on load, selection or save. This review test does
not verify a caption model's image support.

Provider/key saves are not atomic across disk/Postgres. If the key commits and settings
fail, the new key can remain associated with the old URL (or a removed key with a provider
that still exists). The UI clears the typed key and reloads on partial/unknown outcomes;
inspect the provider and deliberately replace/remove the key before remote use. Local caption
config never reads secrets.

**Upgrade:** the first boot of the registry release converts a pre-registry settings.json
into providers (keeping `settings.json.pre-ai-registry`) and copies the old shared key to the
remote providers that used it, then deletes the old slot. Take **Back up now** before
deploying: rollback is the older image + that dump + the `.pre-ai-registry` copy.

**Recovery:** v6 and later DB dumps include encrypted secrets, not the master key or settings.json.
Escrow the master key separately offsite and keep historical keys for historical dumps.
Absent secrets in legacy v1–v5 preserve live rows; an empty v6-or-later array intentionally clears
them. Restore is still CLI-only, confirmed, with a pre-restore undo dump. Pause AI/settings
edits during restore and reconcile the providers in settings.json before resuming; a restored
pre-registry `ai_api_key` row is never read — re-enter keys per provider.

To rotate a provider key, replace it in that provider's form then revoke the old one externally.
To rotate the master key, back up DB/settings and escrow the old key, pause remote use,
install a new generated key/recreate the app, re-enter each provider credential, verify
deliberately with non-sensitive content, and take a new backup. Changing only the master
key does not re-encrypt old rows. Lost master keys require reissued provider credentials.
Full misuse cases and rollback: [#214 design](../docs/superpowers/specs/2026-09-19-encrypted-ai-review-secrets-design.md)
and [registry design](../docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md).

### Review Story in the editor (#215)

Choose **Review Story** directly in the editor's top command bar, beside Save draft
and Publish, to review the active DE or EN tab's **unsaved** title, excerpt,
hero alt text and Markdown. Five deterministic checks appear immediately; editorial
suggestions arrive asynchronously from the provider selected in Settings. Opening the
drawer starts that browser-direct request, sending the active-locale snapshot to that
provider. Use only content you intend to share with it.

**Apply suggested title** and **Apply suggested excerpt** change only that locale's form
field and mark the draft dirty. Loaded or manually entered slugs stay unchanged; a new
automatic slug still derives from the title. Body prose is never replaced. Save draft
or Publish remains an explicit, separate action; warnings and provider failures do not
gate either action or bypass their existing validation.

Quick-check links jump to the actual Markdown line in EasyMDE, or the hero alt field.
Escape/Close returns focus to Review Story; a jump instead focuses its editing target.
The drawer traps keyboard focus, scrolls on narrow screens and respects reduced motion.

Closing, changing locale/post, restoring a draft, or editing the reviewed fields cancels
and invalidates that review. **Review again** captures a fresh snapshot. Cancellation
cannot recall content already sent to a provider. Late responses cannot apply to a
different draft. Results and credentials are not persisted by the drawer.

If the provider is offline, refuses access, times out or returns malformed output, the
quick checks remain available with recovery guidance. Admins can follow **Open AI
settings** where appropriate; authors are directed to their administrator. Missing
OpenRouter/DeepSeek keys refuse the request locally; a keyless custom endpoint is allowed.

## Deterministic editorial checks

`public/editor-linter.js` exposes `window.EditorLinter` for one unsaved locale; load
`gallery-fence.js` first. It is a pure, network-free advisory module, not a save/publish
gate, and supplies the Review Story drawer's immediate quick checks.

Call `lintStory({ title, excerpt, markdown, heroSrc, heroAlt })`, or the individual
`lintTitle`, `lintExcerpt`, `lintHeadings`, `lintAltText`, and `lintInternalLinks` checks.
Title (20–70) and excerpt (100–160) limits use the exact field's JavaScript string length,
including spaces. The result contains each check, `pass`, and `warningCount` (individual
findings, not categories). Findings have stable `code` values and readable `message`s;
alt findings identify `target: 'hero' | 'inline' | 'gallery'`. Markdown `line` values are
**1-indexed**; subtract one for CodeMirror. Hero and document-wide link findings have no line.

ATX headings and inline image/link syntax ignore fenced examples through the same
`GalleryFence.scanFences` used by the picker. Headings are checked before inline syntax;
inline image/link checks hide code spans without crossing blank lines or ATX headings.
Gallery metadata uses `GalleryFence.parse`. Inline checks cover `![alt](url)` / `[label](path)`, including
escaped labels, optional titles, and angle destinations; reference links and raw HTML are
outside this check. Another-story links can be root-relative or path-relative, not remote
URLs, fragment-only links, or query-only links. Alt checks flag missing/whitespace-only text,
not generic wording; they inspect the supplied markdown rather than the saved `images` map.

`findImage(markdown, src)` reuses that inline scanner to locate a body image's
editable alt label. It returns `{ start, end, line }` (zero-based string offsets,
exclusive end, one-based line), or `null` when the image is absent. Code examples
and ordinary links are not repair targets.

## Editor titles and save state

Article titles grow and wrap in the editor while remaining single-line values in
saved posts. Pasted line breaks become spaces; loaded and manually chosen slugs
are not re-derived when the title changes.

The command bar separates draft persistence from publish readiness:
**Not saved yet**, **Unsaved changes**, **Saving…**, or **Saved to server**.
Edits made during an in-flight save remain dirty until a later save includes them.
Failed saves and cancelled URL-change confirmations retain the unsaved form.
A browser recovery stash is not a server save, and saving a published post's draft
does not change its live version.
Restoring a local draft retains the saved-version token it was edited against.
A stale restore gets a conflict rather than overwriting a newer server version.
An existing post's stash without a usable version can be restored for copying, but
cannot be saved: copy the needed text, reload, and decline the restore to return to
the saved version. If the post has since been published, its current live slugs are
kept. A failed restore keeps its original stash and blocks saving the partial form.

## Alt-text audit (advisory)

The saved-draft audit flags empty descriptions, descriptions that repeat the
locale's title, and imported filename-pattern descriptions. It covers both
locales' heroes plus body and gallery photos in the `images` map.

The editor initially shows only a compact **Alt-text review** disclosure with the
photo count and an **optional** label. Expanding it groups issues by locale and
reason. Each photo button selects the correct locale and focuses that gallery
photo's alt field, selects the inline Markdown image's alt label, or opens the
hero alt field. Gallery links also restore visual previews when raw Markdown is
showing. A photo removed from the current draft produces a refresh-after-save
message instead of sending the author to an unrelated field.

The audit refreshes after saving. Its disclosure state and focused issue survive
a refresh when that issue remains; resolving every issue hides the disclosure.
The warning stays within the writing column, leaving the pinned Story details
panel and its collapse icon available beside it.

It is a **warning, never a gate**: `src/alt-audit.ts` is pure, is not part of `validateForPublish`,
and touches none of `publish-gate.ts`'s 409 paths — every WordPress-imported post stores the post
title as its hero alt, so refusing would strand the whole imported corpus. `GET /posts/:tk/alt-audit`
serves it before publishing; `POST /posts/:tk/publish` carries the same shape as `altAudit` in its
success reply, so the editor can name what just went live undescribed.

## CLI upload (Phase 2 migration)

```bash
STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com \
  npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"
```

Prints the paste-ready `heroImage:` snippet and writes all variants (plus the
untouched `-orig` original) under `STORAGE_DIR`.

## CLI rebuild

Rebuild the live blog from the current database without signing in:

```bash
docker compose exec app node --import tsx src/cli.ts rebuild
```

Use it after something changed the database behind the app's back — a `restore`, or a hand-run
`UPDATE`. Normal publishing needs none of this: Publish, unpublish, delete and page saves all
trigger a build themselves and wait for it.

It asks the **running** app over loopback (minting and immediately revoking a one-request admin
session) rather than spawning its own `astro build`. That is deliberate: `work-lock.ts` makes a
build and image encoding mutually exclusive within one process, and `docker-compose.yml` sizes
`mem_limit` as `max(build, encode) + baseline` on exactly that assumption — a second, unlocked
builder could OOM the container. It exits non-zero on a failed build and prints the reason.

## CLI password reset (recovery)

Forgot a password? Reset it from the host — the runtime image has no shell, so use the exec form:

```bash
docker compose exec app node --import tsx src/cli.ts set-password <username>
```

Prompts for the new password when it is omitted (input is echoed), enforces the same 12–1024
character policy as the web forms, and invalidates that user's sessions. Routine rotation while
logged in uses the "Change my password" card on
`/admin/users.html`. Full recovery notes (including the last-resort `DELETE FROM users;` →
`/setup` fallback) are in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

The admin-only Users page reports list-load errors separately from account actions.
**Reload users** clears obsolete rows and their Remove buttons before fetching; a failed
request or unreadable JSON response leaves an explicit error, not an apparently empty
successful list. Reloading does not discard entries in the Add user or password forms.
After an account is added or removed, its refresh supersedes any older list request;
late responses cannot hide the new account or restore a deleted account's Remove button.
Both forms support Enter to submit, disable their submit button while waiting, and
re-enable it after success or failure. A transport failure preserves the entries and
reports that the outcome could not be confirmed: reload the list before retrying Add user,
since a lost response does not prove the server rejected the change. The admin UI remains
English; these status and recovery messages come from the shared DE/EN copy registry.

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`
