# simonswanderlust-images

Self-hosted image uploader **and admin CMS** for the Astro blog: uploads a photo and generates
responsive AVIF/WebP variants, and hosts the in-admin editor, the media library and the WordPress
import — and, since the single-app-container merge, **also serves the public blog itself**
and runs its Astro builds in-process (no separate build server). How it fits the rest of the
stack: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Security model: [`../SECURITY.md`](../SECURITY.md).

> Published variants carry an **eight-tag EXIF allow-list**, not the source metadata — no GPS, no
> XMP, no IPTC. The untouched `-orig` retains everything but is never served. Widening that list
> is a privacy change; see [`../SECURITY.md`](../SECURITY.md).

## Contract

Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp`. Must match the blog's
`site/src/lib/images.ts`. `/upload` (and the CLI) append a short content-hash
suffix to the key (`…/hero-<hash8>`), so re-uploading a photo mints a new URL
and old URLs keep serving — which is what justifies serving variants with a
one-year immutable cache. (WP-import rehost keys stay deterministic so
re-imports are idempotent.) The untouched upload is additionally persisted as
`{key}-orig.<ext>` next to the variants, so the images dir is a complete media
archive (and future re-encodes stay possible). Originals exist only for uploads
made from this version onward; earlier uploads exist as variants only.

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
5. Point your reverse proxy (nginx/Caddy/Traefik) at the container, terminating TLS: **both**
   `https://simonswanderlust.com` **and** `https://img.simonswanderlust.com` → `127.0.0.1:3000`.
   One Fastify process serves both domains — a host-header check (`IMG_HOST`) picks image-variant
   serving vs. the blog/admin, so each domain behaves exactly as before the merge. **The proxy
   must forward the original, verbatim `Host` header for both domains** (nginx:
   `proxy_set_header Host $host;` — do not rely on the default, which some nginx configs override
   with `$proxy_host`/the upstream name). If the `Host` header reaching the app isn't exactly
   `img.simonswanderlust.com`, image URLs silently fall through to the blog/admin routing instead
   of serving image variants.
6. Open `https://simonswanderlust.com/login` to create the first admin account, then upload.

The admin panel is reachable directly at `https://simonswanderlust.com/admin/` — the same process
serves it, so there's nothing to proxy to separately anymore.

The landing page is the publishing **Desk**: it features the most recently edited draft pair,
lists published trips with saved changes, reports the photo-processing count, and links to the
current live site. Those three data sources load independently. If posts, queue status, or health
is unavailable, only that section shows a retry; unknown queue/release state is never presented as
an idle queue or as confirmation that no release exists.

### Security notes

Full details in [`../SECURITY.md`](../SECURITY.md); the essentials:

- **Always run behind the TLS-terminating reverse proxy.** The app trusts `X-Forwarded-*`
  (so per-IP login throttling and the cookie `secure` flag work); your proxy MUST set
  `X-Forwarded-Proto`. Do not expose port 3000 directly to the internet.
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

## Media library

`/admin/media.html` is the browsable store behind every photo the blog serves — one row per
storage key, not per variant file. Bulk drag-and-drop upload, virtual folders (a `media_folders`
table; moving a photo re-labels it, it does not move bytes on disk), search, and per-item alt text
that the gallery picker reuses.

Encoding is **asynchronous**: an upload lands, its row goes `processing`, and `encode-queue.ts`
works the backlog at concurrency 2. A build preempts the queue — both take the same mutex in
`work-lock.ts`, so a publish never competes with an encode. Rows survive restarts: the boot pass
and `POST /media/rescan` both run `createReconciler` (`media-sync` reconciles disk against the
database — backfilling rows for keys already on disk, harvesting alt text by exact URL match,
flagging rows whose files have vanished, and demoting a `ready` row whose variant set is no
longer complete for its original's width — and then `encodeQueue.recover()` re-seeds the queue
from `status = 'processing'`). Variant and original files are written atomically (temp +
rename), so a crash never leaves a truncated file under a final name.

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

## Galleries

Several photos render as one grid from a fenced ```` ```gallery ```` block, one image URL per line.
Authors get it from **"Insert / edit gallery"** on either locale tab, which opens the library in
multi-select mode with an ordering strip; the button writes exactly the text a person would type by
hand. Per-line `| WxH | alt="…" | caption="…"` metadata is lifted into the post's `images` map at
the store chokepoint (`normalizeGalleryFences`), leaving the body as bare URLs.

Three layout modes, selected by a `#layout:` line **inside** the fence — `breakout` (default,
justified rows wider than the story column), `column` (justified rows aligned to body text), and
`slider`. All three get a `<dialog>` lightbox. An unknown or absent directive falls back to
`breakout`. The directive lives inside the fence rather than on the opener because an info-string
argument is discarded before the renderer ever sees it.

Author-facing detail is in [`../docs/authoring-workflow.md`](../docs/authoring-workflow.md).

> **Gallery markup is injected *after* `rehype-sanitize`**, so it inherits none of its protections.
> URLs are allow-listed by **origin equality** (never a prefix match), alt/caption are coerced with
> `String()`, and dimensions are validated before reaching markup arithmetic. Validation lives at
> the `posts.ts`/`pages.ts` store chokepoint, not in `validateDraft` — the WXR importer bypasses
> the latter.

## AI alt-text (local LM Studio)

The post editor and photo uploader offer a "Suggest alt text" button per alt field. The browser
downscales the picked photo and calls the author's local LM Studio (`<lmBaseUrl>/chat/completions`)
directly — the app server never contacts the model. LM config (`lmBaseUrl`, `lmModel`,
`captionTimeoutMs`, `captionMaxEdge`, `captionPrompt`) lives in the JSON settings store, edited on
the admin-only Settings page; authors read it read-only via `GET /ai-config`. No
`docker-compose`/`.env` LM variables are needed.

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

This is the reusable client/contract slice, not a new editor action. Settings/secrets
and the review drawer remain separate issues #214/#215. Existing `caption`, `listModels`,
`prepImage`, and alt-text workflows are unchanged.

## Deterministic editorial checks

`public/editor-linter.js` exposes `window.EditorLinter` for one unsaved locale; load
`gallery-fence.js` first. It is a pure, network-free advisory module, not a save/publish
gate. The review drawer is integrated separately (#215).

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

## Alt-text audit (advisory)

The editor shows a warning listing every photo of the post that reaches a reader with **no
description** — an empty alt, or an alt that only repeats that locale's title, which
`heroAltOf` (`site/src/lib/trips.ts`) renders as `alt=""` because the heading beside the photo
already says those words. It covers both locales' heroes plus the body and gallery photos in the
`images` map, and each entry is a button that jumps to the field (and the "Suggest alt text"
button) that fixes it.

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

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`
