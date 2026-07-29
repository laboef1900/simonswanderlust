# Security model

This documents how the self-hosted app (`uploader/`, which now also serves the static blog built
from `site/`) is protected. A single Fastify process serves everything — the admin CMS, the image
service, the public blog, and the runtime Astro build — so the interesting surface is the whole
**app** (auth, uploads, database, remote fetches, the build pipeline, and now DB backups). See
[Single app container](#single-app-container) for what that topology change does and doesn't
change about the security posture.

## Threat model

- **Single-tenant, semi-trusted authors.** The expected operators are Simon and any accounts he
  creates. Many controls below therefore lean on "authors are trusted," but the system *does*
  support multiple accounts with an **admin / author** distinction, so privilege boundaries are
  enforced rather than assumed.
- **Defense in depth.** Even where a control is mainly relevant "once an untrusted account exists,"
  it is implemented now (admin-only publish, body sanitization, SSRF guards, traversal guards).
- **Out of scope:** DDoS, host/OS hardening, and a fully DNS-rebind-proof SSRF filter (see
  *Known limitations*).

## Authentication & sessions

- **Passwords** are hashed with **scrypt** (`N=16384, r=8, p=1`, 64-byte key, per-user random salt)
  and verified in constant time (`timingSafeEqual`). Hashes are stored, never the password.
  (`uploader/src/users.ts`)
- **Sessions** use a 256-bit random token sent as an **HttpOnly, `SameSite=Strict`** cookie; only
  the **SHA-256 hash** of the token is stored in Postgres, so a database read cannot reproduce a
  live session. Cookies are marked `Secure` when the request is HTTPS. Sessions last 30 days and
  expired rows are swept hourly. (`uploader/src/sessions.ts`, `authn.ts`)
- **First-admin setup** (`/setup`) is only available while no users exist, and is **serialized**
  with a per-process lock so two concurrent requests cannot both create an admin (TOCTOU closed).
- **Password changes** — `POST /users/me/password` lets an authenticated user rotate their own
  password after re-proving the **current** one (rate-limited, so a hijacked session cannot
  brute-force it — see *Rate limiting*). On success **all of that user's sessions are destroyed**
  and the caller receives a freshly minted cookie, so any stolen session dies immediately.
  Forgotten passwords are reset out-of-band from the host via the CLI
  (`docker compose exec app node --import tsx src/cli.ts set-password <username>`), which also
  invalidates all of that user's sessions — recovery procedure in `ARCHITECTURE.md`.

## Authorization

- `requireAuth` gates all CMS/editor/upload/import endpoints.
- `requireAdmin` gates **user management**, **settings** (`/settings` — backup schedule and
  retention), **backups**, **rebuild**, **page edits**, and, importantly, everything that
  changes what the public site serves: **publishing** (`POST /posts/:tk/publish`),
  **unpublishing** (`POST /posts/:tk/unpublish`), **post deletion** (`DELETE /posts/:tk`),
  and their batch form **`POST /posts/bulk`** (`{action, keys[]}` — the `action` is checked
  against a fixed allow-list and `keys` is capped at 100 per request, since an unbounded array
  is an authenticated N-round-trip amplifier against the process that also serves the blog).
- **Media library** — browsing (`GET /media`, `GET /media/items/*`) and editing a photo's own
  metadata are **session-level**, a deliberate downgrade from the admin-only `GET /images` they
  replace: the gallery picker needs authors to browse. What makes that safe is the redaction
  below. The bulk-irreversible operations stay admin-only — `DELETE /media/items/*`,
  `PATCH /media/folders` (rename) and `DELETE /media/folders` — because media has no revision
  history the way posts do. `POST /media/rescan` is admin-only too.
  The line is **reversibility, not blast radius**: `POST /media/move` (up to 100 photos) and
  `POST /media/folders` (create) are session-level even though a move is a bulk write, because
  folders are *virtual* — moving a photo never changes its URL, so no move can break a published
  post, and any move can be undone by moving it back. A folder rename rewrites a whole subtree in
  one statement and a delete is unrecoverable, which is why those two sit on the other side.
  `POST /media/retry` is session-level for the same reason: it re-encodes from the retained
  original, and the encode queue's `MAX_BACKLOG`/concurrency caps bound what it can cost.

### Media metadata redaction

`GET /media` and `GET /media/items/*` strip **`exif.lat`, `exif.lng` and `uploadedBy`** for
non-admin users (`redactForNonAdmin`, `uploader/src/media-store.ts`). Camera, lens and capture
time are kept — they are useful and carry no location.

> **This is what keeps the Phase 0 privacy fix intact.** Published image variants carry no GPS
> at all (the EXIF allow-list above), but the library *stores* coordinates as private metadata
> for the author. Serving those through a gate that any author can pass would reintroduce
> exactly the exposure the allow-list removed. `server.test.ts` asserts the redaction itself,
> not merely the status code.

### Upload preconditions

`POST /upload` refuses with **507** when `/data` lacks headroom for the whole cost of the photo
(the retained original plus its variant set) plus a reserve that keeps a site build and a backup
able to run — see `uploader/src/disk.ts`. A full `/data` otherwise fails mid-pipeline and can
leave a partial variant set with no complete record. Free space is also reported on `/health`,
but **never as a health verdict**: a low-space 503 would trigger a restart loop, which makes a
full disk strictly worse.

Encoding runs in a bounded background queue: at most 2 concurrent encodes, a backlog cap that
returns **429** rather than accepting unbounded work, and a shared lock (`work-lock.ts`) that
makes a site build and image encoding mutually exclusive so the container cannot OOM with both
running. Encode failures are recorded as a **fixed enum** (`decode_failed`, `encode_failed`,
`write_failed`, `no_space`), never a raw message — libvips embeds filesystem paths in its errors
and the library UI displays that field.
  Non-admin authors may create and edit drafts but **cannot push content to the public site,
  take it down, or change a published slug** — only admins publish.

## Error handling

Unexpected errors (database failures, bugs) are caught by a global Fastify error handler that
logs the full error server-side (stdout, captured by Docker) and returns a **generic
`500 internal server error`** — internal details such as connection strings or stack messages
never reach the client. Intentional 4xx framework responses (body-size 413, malformed JSON 400)
keep their sanitized messages. (`uploader/src/server.ts`)

## Rate limiting

A per-client-IP fixed-window limiter throttles the password-verifying endpoints — the
unauthenticated `/login` and `/setup`, plus the authenticated `POST /users/me/password` — to slow
brute-force attempts. All three share the same per-IP bucket, so failed current-password guesses
also count against login attempts from that IP. It is in-memory and dependency-free
(`uploader/src/rate-limit.ts`); with a single container that is sufficient. (If ever scaled to
multiple replicas, limits would be counted per replica.)

## Input validation

- **Storage keys** pass `assertSafeKey` in `storeOriginal` — the central chokepoint for every write
  path (direct upload *and* the WordPress re-host path). Keys must match `^[a-z0-9][a-z0-9/_-]*$`
  with no `..` or `//`, so a write can never escape `STORAGE_DIR` (path-traversal defense).
- **Imported slugs** are validated at the WordPress-import boundary; a group with an unsafe slug is
  skipped with a warning and never reaches the database, the storage path, or the MDX export.
- **Coordinates** are bounded on publish (`lat ∈ [-90,90]`, `lng ∈ [-180,180]`, finite).
- **SQL** is parameterized throughout (`pg` placeholders) — no string-built queries.
- **Uploads** — `POST /upload` is capped at one file per request (`files: 1`); a second file in the
  same multipart body gets the request rejected with **413**, rather than the old silent behavior
  of buffering every file and keeping only the last. `fileSize` is capped at 25 MB and `parts` at
  8, and the app sets an explicit `requestTimeout` (120 s) — @fastify/multipart's parser never
  consumes the body itself, so without these an authenticated caller could stream an effectively
  unbounded request. (`uploader/src/server.ts`)

### Published image metadata (allow-list)

Public image variants carry an explicit **allow-list** of EXIF tags, built in
`uploader/src/exif.ts` and applied in `pipeline.ts`: `Make`, `Model`,
`LensModel`, `DateTimeOriginal`, `ExposureTime`, `FNumber`, `ISOSpeedRatings`,
`FocalLength`, plus the ICC profile. Everything else — the **GPS IFD**, XMP,
IPTC and `Orientation` — is dropped by construction, because `withExif()`
replaces the EXIF block wholesale rather than filtering it.

This replaced a blanket `.withMetadata()` which republished source GPS
coordinates on every public file. Untouched originals under `/data/images`
keep their full metadata; they are never served (`isOriginalFile` excludes
them from the static mount).

**Widening this list is a privacy change, not a refactor.** `audit-exif`
(`docker compose exec app node --import tsx src/cli.ts audit-exif`) is a
read-only scan of the stored corpus reporting how many variants carry EXIF
and how many carry GPS (in either the EXIF GPS IFD or an XMP packet). A
read-only audit of the **local development corpus** (not the server — that
corpus was not reachable from the environment this audit ran in) at shipping
time found 102 variant files with EXIF and **zero** with GPS. Separately,
the blog's own camera has no GPS receiver, but the audited corpus itself
cannot support a claim about *why* it came back clean: 88 of the 102
variants carry EXIF with no Make, no Model and no Software at all, and the
remaining 14 carry only `Software: Capture One Macintosh` — i.e. these are
processed exports whose metadata was already largely stripped before it
reached this corpus, not a direct read of camera-original files.
Because that audit was clean, a remediation `strip-gps` command was not
built in this phase.

**The "server corpus" caveat this section used to carry is now resolved
(2026-07-29, issue #68 closed as obsolete).** It reserved judgement pending
an `audit-exif` run against a production `/data/images` holding
WordPress-imported photos from other devices and years. Two things settled
it: there is no production deployment (Phase 4, the DNS cutover, has not
started), and the WordPress import itself cannot introduce the exposure —
`wp-images.ts` re-hosts through `processImage` in `pipeline.ts`, the same
path as any upload, so every imported variant passes through `allowedExif()`
at encode time. The allow-list sits **upstream** of the importer, not beside
it.

That was then exercised for real: the 2026-07-29 WXR import re-hosted **665
photos** shot on other devices between 2021 and 2024, all encoded through
the allow-list. The only variants ever published without it are the 102 that
predate the fix, audited twice with identical results.

`strip-gps` therefore remains unbuilt, correctly — its trigger never fired.
Re-run `audit-exif` if a pre-#62 variant corpus is ever copied onto a server
wholesale; that is the one path that could reintroduce the question.

## SSRF protection (WordPress import)

The importer fetches image URLs taken from an uploaded export — attacker-influenced input. All such
fetches go through `safeFetch` (`uploader/src/safe-fetch.ts`), which:

- allows only `http`/`https` and rejects URLs with embedded credentials;
- rejects literal **loopback** and **link-local** addresses, including the cloud-metadata endpoint
  `169.254.169.254`;
- enforces a hard **timeout** (AbortController); and
- **caps the download size while streaming**, so a huge or never-ending response cannot be buffered
  fully into memory.

(The former LM Studio caption feature — the app's only other outbound-fetch surface — was removed
in July 2026; the WordPress importer is now the sole remote-fetch path.)

## Output sanitization (stored XSS)

Post bodies are DB-stored Markdown rendered to HTML at build time. Before that HTML reaches the
public site it is run through **`rehype-sanitize`** (`site/src/lib/body-images.ts`), stripping
`<script>`, inline event handlers, `javascript:` URLs, and `iframe`/`object`/`svg`. The schema is
tuned so it does **not** break legitimate output: heading `id`s stay un-prefixed (so the table of
contents `#anchor` links resolve) and code-span classes/inline styles (Shiki syntax colors) are
preserved. Verified end-to-end against a published post carrying an XSS payload.

> We deliberately use a maintained, allow-list sanitizer rather than hand-rolled escaping — the
> cardinal rule of XSS defense.

### Content injected *after* sanitize (body images and galleries)

`transformBodyImages` sanitizes first and then replaces recognized nodes with its own trusted
`<picture>` / gallery markup. Those injected nodes therefore inherit **none** of the sanitizer's
protections, so they carry their own:

- **Gallery URLs are allow-listed by origin equality.** A ` ```gallery ` fence's URLs arrive as
  *text* content, which `rehype-sanitize` never protocol-checks (unlike an `<img src>`), and they
  land in an `<a href>`. A `javascript:` line would fire. The check is
  `new URL(raw).origin === new URL(imageOrigin).origin` — **never a string prefix**:
  `startsWith('https://img.simonswanderlust.com')` passes both
  `https://img.simonswanderlust.com.evil.com/x` and `https://img.simonswanderlust.com@evil.com/x`.
  The origin arrives as an explicit parameter (from `PUBLIC_BASE_URL` at build time, from
  `cfg.baseUrl` for draft previews), keeping the transform pure and env-free.
- **The `images` map is validated at the write chokepoint.** `uploader/src/body-content.ts`
  (`imagesMapError`) rejects an entry whose `alt`/`caption` is not a string or whose
  `width`/`height` is not a positive integer, from `draftWithDefaults` (posts) and
  `validatePagePair` (pages). This is enforced in the *store*, not in `validateDraft`: the WXR
  importer calls `upsertDraft` directly and would otherwise bypass it entirely. The reason it
  matters is that hastscript treats a node-shaped object in a children array **as a node**, so a
  caption of `{"type":"raw","value":"<script>…</script>"}` would emit a live script tag — the
  render boundary additionally coerces with `String()` as a backstop.

Why this is not merely theoretical: `GET /posts/:tk/preview` is `requireAuth` (**any** author, not
just admins), runs the identical transform, and is served same-origin with `/admin/*` with no CSP.
A non-admin author storing a payload in a draft that an admin then previews would run script with
the admin's cookie against `POST /users`, `GET /backups/*` and `POST /posts/:tk/publish`.

## Transport, headers & proxy

- Every response carries `X-Content-Type-Options: nosniff`. `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer` are added only on the admin/API surface (`/admin`, `/login`,
  `/logout`, `/auth`, `/setup`, `/settings`, `/users`, `/posts`, `/upload`, `/import`,
  `/export`, `/backups`, `/rebuild`, `/health`); public blog pages carry only `nosniff`, at parity
  with the old nginx config. (CSP is intentionally omitted because the admin pages use inline
  scripts; a strict policy would need nonces.)
- The app sets `trustProxy`, so it reads `X-Forwarded-*` for the client IP (rate limiting) and the
  cookie `Secure` flag. **It must run behind a TLS-terminating reverse proxy that sets
  `X-Forwarded-Proto`**, and port 3000 must not be exposed directly to the internet.
- **The proxy must forward the original, verbatim `Host` header for both domains**
  (`simonswanderlust.com` and `img.simonswanderlust.com`) — nginx: `proxy_set_header Host $host;`.
  Image-vs-blog/admin routing is a single Fastify process that dispatches on the `Host` header
  (`IMG_HOST`); a proxy that rewrites `Host` (e.g. nginx's default `$proxy_host` behavior) breaks
  every image URL by routing image requests into the blog/admin handler instead.

## Secrets

- `DATABASE_URL` is provided via environment (compose `.env`), never committed. `.env`,
  credentials, and binaries are git-ignored.
- The rebuild trigger (`POST /rebuild`) and the DB backup routes (`GET`/`POST /backups`,
  `GET /backups/:name`) are gated by `requireAdmin` — no separate shared secret; the retired
  `BUILD_SECRET` / `x-build-secret` mechanism no longer exists.

## Single app container

The stack runs as **one application container + Postgres** (WordPress-style), replacing the
previous four-container split (nginx / a secret-gated build server / uploader / db). This is a
deliberate trade-off, not an oversight:

- **Accepted:** the app process can write the served web root (inherent to serving the blog and
  running the build from the same process that handles uploads and admin auth) — the
  `rehype-sanitize` build chokepoint (below) still runs on all content-derived HTML, but a fully
  compromised app process could write files to the release directory directly. Public-site
  availability is now coupled to app + db health rather than sitting behind nginx, which used to
  keep serving stale files even if the backend went down; this is mitigated by boot only rebuilding
  when no release exists yet, so restarts are seconds. All public traffic (blog, images, admin)
  now terminates in the same process that parses uploads and WordPress (WXR) imports, mitigated by
  the controls documented elsewhere on this page: auth, rate limiting, `safeFetch` (SSRF guards),
  size caps, and `assertSafeKey` (path-traversal guards).
- **Preserved:** the runtime still runs as a **non-root user (uid 1000)** on a minimal image with
  no shell or package manager (Astro is spawned via plain `node`, not `npx`/`npm`, which is what
  keeps the merged image minimal); `db` still has no published port; a TLS-terminating reverse
  proxy is still required in front; every app-level control on this page (auth, rate limiting,
  sanitization, SSRF/traversal guards) is unchanged.

### Backups

- Backup dumps (`/data/backup/db/db-*.json.gz`) contain the `users` table **including scrypt
  password hashes** — treat backup files as sensitive, same as the database itself. `sessions` are
  **never** dumped (disposable, and token hashes don't belong in a backup).
- Image archives (`/data/backup/db/images-*.tar`) contain no password hashes — only the already
  publicly served image files — but their download route stays behind the same admin gate and
  strict filename validation as the dumps.
- The download route (`GET /backups/:name`) is **admin-only** and validates the filename against a
  strict pattern (`^db-\d{8}-\d{6}\.json\.gz$` or `^images-\d{8}-\d{6}\.tar$`) before touching the
  filesystem — no path traversal.
- Restore is **CLI-only**
  (`docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/<file>` — the
  shell-less runtime image requires invoking `node` directly), never a web route, because it's
  destructive: it deletes and re-inserts `users`, `posts`, and `pages` in one transaction
  (`pages` only when present in the dump — v1 dumps predate them and leave existing pages
  untouched). Deleting `users` cascades to `sessions`, so a restore invalidates every login.
- In-app backups live on the **same disk** as the live data; disaster recovery requires an
  offsite host-level backup of `./uploader/data` — see
  [ARCHITECTURE.md](ARCHITECTURE.md#backups--disaster-recovery).

## Known limitations

- SSRF filtering blocks literal internal IPs but does not resolve DNS, so a hostname that resolves
  to a private address is not caught (DNS-rebind-proof filtering is out of scope for the trusted,
  single-tenant deployment).
- The rate limiter and (non-pg) session/user fallbacks are per-process/in-memory.
- No Content-Security-Policy on the admin app (inline scripts).

## Reporting

This is a personal project. If you find a security issue, contact the maintainer privately rather
than opening a public issue.
