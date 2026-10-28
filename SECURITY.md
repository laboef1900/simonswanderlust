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

## GPX routes — private source and public snapshot

The [2026-10-23 GPX specification](docs/superpowers/specs/2026-10-23-gpx-route-import-design.md)
is owner-approved as a design (PR #326). #313 implements bounded XML import, private route
storage and recovery; #314 adds the strictly projected public artifact. The private route
table is never serialized into ordinary posts, builds or MDX exports.
Implementation approval and merge authorization remain separate from design approval.

- GPX originals and attached draft coordinates, elevation and timestamps are sensitive.
  Any authenticated author may read them, unlike media GPS redaction. Only an admin may
  Publish. Originals live outside every public/static root, with guarded attachment-only
  downloads; private responses and failures are `no-store`.
  GPX mutations compare a supplied Origin to the admin request's scheme and verbatim
  forwarded `Host`, not `PUBLIC_BASE_URL` (the separate image origin).
  `X-Forwarded-Host` is not used; the existing proxy must preserve `Host` and set
  `X-Forwarded-Proto`. Missing/malformed authority fails closed.
- Trimming protects **publication**, not private retention. The owner chose to keep the
  latest attached original through detachment, delete it on replacement/post deletion,
  and retain full private route state in DB dumps with a manifest-matched private route
  archive. Those backups deliberately contain removed points/times until normal expiry.
  Public HTML/JSON/assets and MDX expose only the approved 2D snapshot artifact.
  Damaged sources may be protected from automatic cleanup by a retained degraded
  manifest, but explicit replacement/post deletion override that protection. Durable
  deletion intents retry failed unlink operations; a pending retry is not physical erasure.
- Strict UTF-8 / BOM-marked UTF-16 decoding precedes DOCTYPE/entity refusal. The 5 MiB
  file and 5 MiB + 16 KiB multipart caps are enforced while streaming; uploads have a
  15-second admission deadline. Decoding, validation and normalization run in a terminable
  2-second worker with bounded heap/output, not on the request event loop. One import/attach
  worker is admitted without queuing. Limits also cover nesting, points, segments and
  waypoints. Malformed coordinates cannot be skipped into a new connecting line.
- No private GPX preview/point arrays go to third-party tiles, geocoders, AI or browser draft
  storage. **Owner decision after review:** explicitly selected waypoints keep exact GPX
  coordinates as ordinary shared stops, with an unchecked selection and a warning that
  stops publish independently of track trimming. They follow existing stop metadata/stash
  rules. Track rounding (four decimals) and simplification (25 m) are not anonymization;
  neither they nor a z8 basemap protect those separately approved stop coordinates.
- Route edits/detachment are durable private draft operations. Separate route and pair tokens
  are checked under a per-pair transaction lock; a lost acknowledgement blocks blind retry.
  Private state never enters text revisions. Publish derives the artifact outside transaction
  locks, then rechecks both tokens under the pair lock before updating both locale snapshots.
  Builds and MDX read those snapshots only; edits and detachment cannot change the public
  line until another Publish. Backup capture and restore reject malformed or mismatched
  public projections without treating intentionally private backup contents as a leak.
  A failed build leaves the previous release served, not a partially updated public route.
  Single/bulk Publish responses are `no-store` at the response hook, including authorization
  and body-parser refusals that never reach the handler.
- Public projection uses 25 m per-run spherical simplification, four decimal places and
  strict 2D coordinates, capped at 100 runs, 2,000 vertices and 64 KiB. Discontinuities
  remain separate; ambiguous antipodal or antimeridian-crossing shortcuts are subdivided
  using existing retained points, never invented connections. Empty/over-cap results fail
  closed. Attach checks the same candidate before replacing an attachment.
  The admin transform has its own process-wide, nonqueued 2-second worker slot, separate
  from author import/attach. Browser previews use a terminable worker too; none falls back
  to synchronous simplification. Public text derives only from the public artifact and
  remains available without JavaScript/WebGL; overview maps remain pin-only.
- Original directories/files use `0700`/`0600`, hashed pair paths and opaque source IDs.
  Read/write boundaries reject symlinks and validate retained bytes. Pending previews are
  author-bound, excluded from backups, cancelled explicitly and reconciled every minute;
  abandoned imports expire after one hour. Cleanup failures are reported, not called erasure.
- The app holds a database ownership lease. Lease loss latches mutation/job admission off,
  aborts/drains work and closes app pools while static serving continues. Restore requires
  the lease and absence of app-tagged sessions, validates the complete recovery set, creates
  a verified undo set and stages fresh source IDs before replacing database state.
  Unknown commit outcomes retain both source sets until reference-checked reconciliation.
  Restore is offline; do not force-terminate another process to bypass its admission check.

The specification defines transaction/file ordering, paired restore, misuse cases and
rollback. Reverting code is not erasure, and removing future published geometry requires
an owner-authorized safe rebuild/release switch and cache assessment. No safety gate is waived.

## Authentication & sessions

- **Passwords** are hashed with **scrypt** (`N=16384, r=8, p=1`, 64-byte key, per-user random salt)
  and verified in constant time (`timingSafeEqual`). Hashes are stored, never the password.
  The **password policy** is length-only (12–1024 characters — no composition rules, per ASVS 5.0
  §6.2.5) and is enforced inside `hashPassword` itself, so `/setup`, `POST /users`,
  `POST /users/me/password`, both user stores and the CLI `set-password` recovery path all share
  one rule with no way around it (#109). **Usernames** follow the same pattern (#131):
  `usernamePolicyViolation` — 1–64 characters from `[A-Za-z0-9._-]`, plain ASCII identifiers, so
  no markup, whitespace, or homoglyph can become a limiter key, a `lower(username)` lookup, an
  `aria-label`, or a log line — is enforced inside both stores' `create` and checked up front by
  `/setup` and `POST /users` for the 400. `/login` and the CLI still accept any stored name, so an
  account that predates the rule keeps signing in. The admin shell in `auth.js` sets the username
  into the sidebar badge with `textContent`, never `innerHTML`. (`uploader/src/users.ts`)
- **Sessions** use a 256-bit random token sent as an **HttpOnly, `SameSite=Strict`** cookie; only
  the **SHA-256 hash** of the token is stored in Postgres, so a database read cannot reproduce a
  live session. Cookies are marked `Secure` when the request is HTTPS. Sessions last 30 days and
  expired rows are swept hourly. (`uploader/src/sessions.ts`, `authn.ts`)
- **The session is resolved only where it is read** (#129). There is no global per-request
  session hook: `createAuthn` (`authn.ts`) hands each route one of three preHandlers —
  `optionalAuth`, `requireAuth`, `requireAdmin` — and only a route that declares one queries
  the session store. The public blog, the image host, the basemap and the `/admin/*` static
  pages never do, so a down or hung Postgres cannot 500 the public site for the one browser that
  carries the admin cookie, and a forged cookie on a public page costs no lookup. A store failure
  on a guarded route is a sanitized 500, never "anonymous" — a database outage must not read as
  "logged out". Spec: `docs/superpowers/specs/2026-09-06-lazy-session-resolution-design.md`.
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

- `requireAuth` gates all CMS/editor/upload endpoints.
- `requireAdmin` gates **user management**, **settings** (`/settings` — backup schedule and
  retention), **backups**, **rebuild**, **page edits**, the **WordPress import** (`POST /import`,
  since #97 — it creates/overwrites drafts, writes gigabytes under `/data`, and makes hundreds of
  outbound fetches to a host chosen by the export, governed by admin-only settings knobs), and,
  importantly, everything that
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
  **Owner-approved gallery-description change (2026-10-19):** current library alt/caption
  now feed article galleries on the next admin-triggered build, even for already-published
  stories. An author's session-level Media edits can therefore change those descriptions
  without a separate per-article Publish; they cannot trigger the build themselves.
  This is the sole exception to frozen article snapshots, not permission to publish draft
  bodies, reorder galleries or change image URLs. The build reads only media key and
  localized alt/caption; preview/audit use the same metadata-only projection. GPS, EXIF,
  uploader identity and library titles never enter the public overlay. Existing gallery
  origin equality, dimension/format validation and post-sanitize string coercion/escaping
  remain mandatory. See the
  [approved contract and rollback](docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md).
- **Post revisions die with the post** (#137). `post_revisions` (up to 20 full-body snapshots per
  post, readable by any authenticated author via `GET /posts/:tk/revisions/:id`) has no foreign
  key — `posts` is keyed `(translation_key, locale)` — so a delete used to leave the snapshots of a
  post an admin removed for being wrong or sensitive readable forever by anyone holding the URL.
  `pgPostStore.remove` now deletes post and revisions in one statement, `ensureSchema` sweeps
  revisions orphaned before that change on every boot, and the item route 404s whenever the post
  is gone, exactly like the list route. See
  `docs/superpowers/specs/2026-09-06-delete-post-revisions-design.md`.

### Public comments

`GET /comments?tk=<translation_key>` and `POST /comments` (`uploader/src/comments-public.ts`,
issue #206) are the app's first **unauthenticated write surface** besides `/login` and first-run
`/setup`, and the first routes that store reader-authored data. Design, misuse cases and the
ASVS L1 exception record: `docs/superpowers/specs/2026-09-14-comments-design.md`.

- **No session preHandler on either route** (#129). Not even `optionalAuth`: a forged or real
  `sid` cookie on a public comment request costs no session lookup and cannot 500 the story page
  when Postgres is down. Pinned by a route test that spies on `sessions.find`.
- **What the public JSON contains — and nothing else.** `GET` answers
  `{ enabled, comments[] }` where each item is exactly `{ id, authorName, body, createdAt,
  isAuthor, postedLocale }`, **approved rows only**, oldest first, capped at 500. Never `status`,
  never a pending/rejected row, never an email (none is collected), never an IP. The key set is
  pinned by a test, not the wording. `enabled` is `settings.commentsEnabled && post
  comments_enabled`; when false the approved thread is still readable (closed, not hidden) and
  `POST` answers 409 `comments_disabled`. `GET` 404s for an unknown key and for a draft-only
  key with the same body, so it cannot enumerate unpublished posts. Response is `no-store`.
- **`POST` order of checks is load-bearing** and pinned by tests: (1) per-IP rate limit → 429,
  no insert; (2) **honeypot** — a non-blank `website` field answers **204 with an empty body**,
  no row, no log line (a 400 would train the bot; 204 does not look like the real 201);
  (3) **Origin check** — the `Origin` header, else the origin of `Referer`, must equal
  `new URL(PUBLIC_BASE_URL).origin` by **origin equality, never a prefix match** (the gallery
  allow-list lesson: `https://simonswanderlust.com.evil.example` must fail); missing both,
  unparsable, or mismatched → 403; (4) validation → 400 with the generic code `invalid_comment`,
  never the store's wording; (5) published pair → 404; (6) global or per-post flag off → 409;
  (7) insert as **`pending`** → 201 `{ ok: true }` — the new id is not echoed, so a caller cannot
  probe moderation. JSON body capped at 4 KiB; unknown fields (`email`, `parentId`, `status`)
  are ignored, never stored.
- **Hold-for-moderation.** Every accepted comment is `pending`; nothing is public until an admin
  approves it on `/admin/comments.html` (`requireAdmin`, see below). Deletion is erasure.
- **Rate limit:** 5 `POST`s per address per 15 minutes plus a process-wide 200 per hour, keyed on
  `req.ip` under `trustProxy: 1` — never on the reader-chosen name, which would let anyone DoS a
  name. See *Rate limiting* for why these maps are separate from the login limiter.
- **Nothing on the public comment path logs a comment field** — not the name, body, honeypot
  value or translation key (spec invariant 11). A store failure is caught in the route and logged
  as the driver message only, because the global error handler logs `req.url`, which on `GET`
  carries the key. The client still gets the sanitized 500.
- **Not done by design:** no `workLock`, no rebuild (comments are runtime, never baked), no
  `safeFetch` or any outbound call, no markdown/HTML, no `parentId`.

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
leave a partial variant set with no complete record. The incremental images archive — the
largest single writer on the volume — applies the same reserve on its way in (#113): it refuses
when its estimated size would not leave that room. Failed output is removed only after its
writer settles; exit cleanup is best-effort and SIGKILL leftovers are swept on the next run.
An unlink failure is logged for the next sweep, not reported as a successful archive. Free space
is also reported on `/health` — **only to an admin session** (#132): the route itself is public
because the compose healthcheck polls it without a cookie, but `free`/`total` for `/data` would
let anyone on the internet watch the volume fill up and time a disk-exhaustion attempt against
`/upload` with a stolen session. Anonymous and author callers get `ok`/`db`/`release` only. And
**never as a health verdict**: a low-space 503 would trigger a restart loop, which makes a full
disk strictly worse.

Image archives exclude unfinished storage `.part-*` files and use mtime **or rename ctime**
against an inclusive boundary obtained from an empty, exclusive-created `0600` marker on the
images filesystem (#335). The marker is removed before enumeration; crash leftovers are
ignored, never treated as originals. Marker/read/strict-tar failures preserve the prior cutoff.
The source must be writable and use the supported local Linux/macOS filesystem semantics;
clock rollback, foreign nested mounts and arbitrary network filesystems are outside this
timestamp protocol. Legacy, missing or corrupt cutoff provenance forces a full archive with
the existing reserve, retaining old archives rather than guessing from filenames. Admin-only
backup access, private original/EXIF handling, storage ownership and key guards are unchanged.

Writer settlement was reconfirmed for #430 (2026-10-28): an owned tar pack and Node destination
pipeline await destination open/write/close before failure cleanup or successful activation.
Cancellation cannot activate the archive or advance its cutoff, and backup quiescence waits
for that settlement before storage ownership is released. Tar may finish admitted **read-only**
input work after its pack is destroyed; pipeline error listeners remain installed and the closed
destination cannot receive further bytes. This does not claim every private tar input descriptor
has closed at rejection. Prior completed archives, originals, dumps and route companions are
not failure-cleanup targets. Authorization, restore validation and persisted formats are unchanged.

`POST /import` has the same precondition (issue #94), with the same 507 and the same reserve, but
sized from a **count** rather than a byte total — a WXR declares URLs, not sizes — using the
measured ~17.5 MB whole cost of one re-hosted photo. The count is the photos the run will actually
*fetch*: `importWxr` asks the disk-derived resume index about every key it is about to write and
charges only the misses, so the post-ENOSPC re-run (the documented recovery path) is judged on the
remainder rather than refused for the export it has mostly already re-hosted. The check runs
after the distinct-image cap and before any fetch; the message names the count and rounded sizes,
never the path, and the raw numbers go to stdout. An unreadable statfs skips the check, as on
`/upload`.

Encoding runs in a bounded background queue: at most 2 concurrent encodes, a backlog cap that
returns **429** rather than accepting unbounded work, and a shared lock (`work-lock.ts`) that
makes a site build and image encoding mutually exclusive so the container cannot OOM with both
running — the WordPress importer's per-image encodes are lock participants too (#95), so a
multi-minute import cannot run `sharp` beside `astro build` either; only its network fetches run
outside the lock. Encode failures are recorded as a **fixed enum** (`decode_failed`, `encode_failed`,
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
brute-force attempts: **10 requests per address per 15 minutes**. All three share the same per-IP
bucket, so failed current-password guesses also count against login attempts from that IP. The
per-IP key is `req.ip` derived under `trustProxy: 1`: the address the single trusted reverse
proxy appended to `X-Forwarded-For`; client-supplied (leftmost) entries are ignored, so rotating
the header does not open a fresh bucket.

`/login` additionally keeps a **per-account failure budget across all sources** — the defence
against a guess spread over many addresses, which the per-IP bucket cannot see — and checks it
*before* running scrypt, so a locked account costs no hashing work. The budget is **100 failures
per 15 minutes**, deliberately ten times the per-IP budget: one address is cut off at 10 requests
long before it can lock anyone, so locking the admin out requires a sustained attack from ten or
more addresses, while 100 guesses per 15 minutes against a 12+ character password is no threat
(NIST SP 800-63B §5.2.2 allows up to 100). A successful login clears the counter. Before #109 the
budget was 5, which let any unauthenticated client lock the admin out indefinitely with five
requests every 15 minutes. The residual — a distributed attacker keeping the account locked — is
accepted for a single-admin L1 deployment; the lock lives in process memory, expires 15 minutes
after the last failure, and `docker compose restart app` clears it. Design and alternatives:
`docs/superpowers/specs/2026-09-05-login-lockout-design.md`.

`POST /users/me/password` has its own per-account failure limiter (5 per 15 minutes) keyed on the
session's user id, so a hijacked session cannot brute-force the current password across many
addresses — and only the caller can ever fill that bucket.

`POST /comments` (#206) is a **third bucket, not shared with `/login`**: `commentLimiters()`
builds its own per-IP map (5 per address per 15 minutes) and its own single-key process-wide map
(200 per hour), both bounded like the rest. Separate maps are the point — a comment flood must
not lock the owner out of the admin, and a login brute-force must not take comments down. The
key is `req.ip`, never the reader-chosen `authorName`. A route test proves the maps are distinct.

Every limiter map is **bounded**: at most 10 000 tracked keys, with expired windows swept first and
the earliest-expiring live window evicted at the cap (amortised O(1) — there is no full sweep an
attacker can trigger per request). Eviction can only forget a counter, never refuse a request, so
a flood of distinct usernames cannot lock anyone out. Key length is bounded too: new usernames are
capped at 64 characters, and the account limiter stores anything longer under its SHA-256 hex, so
a 1 MiB submitted name costs the map 64 characters — while an account that predates the cap keeps
signing in and keeps its own budget. All of it is in-memory and dependency-free
(`uploader/src/rate-limit.ts`); with a single container that is sufficient. (If ever scaled to
multiple replicas, limits would be counted per replica.)

## Input validation

- **Storage keys** pass `assertSafeKey` in `storeOriginal` — the central chokepoint for every write
  path (direct upload *and* the WordPress re-host path). Keys must match `^[a-z0-9][a-z0-9/_-]*$`
  with no `..` or `//`, so a write can never escape `STORAGE_DIR` (path-traversal defense), and
  are capped at **200 characters / 8 path segments** (`MAX_KEY_LEN`, `MAX_KEY_DEPTH`, #133) so a
  client-chosen key can neither `mkdir -p` an arbitrarily deep tree nor fail with `ENAMETOOLONG`
  after passing the regex. `POST /upload` validates the folder and the versioned key before any
  write, so a refused upload leaves no orphan original for the reconcile to adopt.
- **Media text fields** (`title`, `alt`, `caption`) strip `\p{C}` before the length cap, like tags
  and EXIF strings, so a NUL can never reach Postgres `text` (which rejects it with a 500).
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
keep their full metadata; they are never served (the static mount admits only
finished filenames matching `VARIANT_FILE_RE`, excluding originals and temporary files).
Public variant file responses alone carry `Access-Control-Allow-Origin: *`, allowing
credential-free browser reads for gallery captioning from a separate admin origin.
This includes HEAD, byte ranges and cache revalidation; it does not enable credentialed
CORS or add CORS headers to admin/API routes, blog responses or refused image paths.

The admin-only **Image conversion** setting does not weaken this boundary. With conversion
off, JPEG inputs are re-encoded as responsive `.jpeg` variants through the **same** orientation
correction and EXIF allow-list, never served as untouched originals. Other inputs continue
producing AVIF/WebP. The per-image format is validated at save/render boundaries; it is not an
arbitrary file extension. Persisted encoding profiles keep retries/recovery independent of
later settings changes. New upload keys include the encoding profile, preventing a quality
or format change from overwriting an existing immutable URL.

The admin-only **Compare quality** preview (`POST /settings/image-preview`) encodes a test photo
through the same `encodeVariant` helper, in memory only: nothing reaches `/data` or Postgres, no
filename is logged, and the returned image carries **no** EXIF at all (not even the allow-list),
so an uploaded original's GPS never leaves the request. It reuses `/upload`'s multipart limits
(25 MiB, one file part), runs under the shared work-lock so a site build preempts it, and is
single-flight (a concurrent preview gets 429), bounding sharp's memory under `mem_limit`.

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

## Editor location lookup

Owner-approved external editor lookup (2026-10-16): authenticated `POST /geocode`
accepts only a place-name query (2–200 characters, no control characters; 2KiB
request body limit). The app contacts Nominatim; the provider sees the query and
server IP, never the editor's session. Public maps make no additional requests.
The query is a JSON body, not an incoming logged URL; neither queries nor upstream
errors are logged by the lookup implementation.

Only admins may change `geocodingSearchUrl` through the existing settings API.
It must be HTTPS without credentials, query or fragment; empty disables lookup.
Authors cannot supply a destination. `safeFetch` enforces the existing IP/DNS
SSRF guards, a 10-second deadline and a 256KiB response cap. Redirects are refused,
so one admitted lookup cannot generate several provider requests. The existing
DNS rebinding limitation below remains; no guard was weakened.

One app-wide request at a time, starts at least 1100ms apart, no queue or retries.
Successful searches are cached for 24h in a 100-entry memory cache, including
empty results. The limit assumes the existing single app container. Results
contain only bounded labels and finite in-range coordinates; labels are rendered
as text. Stable failure codes disclose no upstream errors. Manual coordinates
remain usable during failures; setting the endpoint to empty contains the feature
without changing stored content. See the
[design and recovery plan](docs/superpowers/specs/2026-10-16-waypoint-location-lookup-design.md).

## SSRF protection (WordPress import)

The importer fetches image URLs taken from an uploaded export — attacker-influenced input. All such
fetches go through `safeFetch` (`uploader/src/safe-fetch.ts`), which:

- allows only `http`/`https` and rejects URLs with embedded credentials;
- rejects **internal address literals** — loopback, RFC1918, CGNAT, link-local (including the
  cloud-metadata endpoint `169.254.169.254`), multicast/reserved, and the IPv6 equivalents
  (`::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped forms like `::ffff:127.0.0.1`) plus every other
  IPv6 form that embeds or stands in for an IPv4 address and is blocked wholesale because the
  embedded address is not unpacked — NAT64, the IPv4-compatible `::/96`, 6to4 `2002::/16` — and
  site-local, documentation and discard space (issue #144) — one `net.BlockList` is the single
  source of truth; the WHATWG `URL` parser canonicalises decimal/hex/octal IPv4 spellings before
  the check sees them;
- **resolves every hostname before connecting** (`dns.lookup`, all records) and refuses if *any*
  address it resolves to is internal — so `localhost`, the compose-internal `db`, or an attacker's
  hostname with a private A record are refused, and a split public+private record does not let the
  attacker pick the connect target;
- **follows redirects by hand** (`redirect: 'manual'`, issue #93) — each `Location` is resolved
  against the current hop and put through the same scheme/credential/literal/resolution checks
  *before* it is fetched, with a hop cap (`maxRedirects`, default 5); a redirect into internal
  space is refused with the internal host never contacted, and a redirect to `ftp:`/`file:`/`data:`
  is refused as an unusable URL. WordPress media URLs legitimately redirect (CDN, HTTPS upgrade,
  resized-variant handlers), which is why hops are followed at all — judged first, then fetched;
- enforces a hard **timeout** (AbortController) that spans every lookup and every hop of a chain,
  so a slow chain cannot exceed it by splitting time across hops; and
- **caps the download size while streaming**, so a huge or never-ending response cannot be buffered
  fully into memory. Redirect bodies and non-2xx bodies are cancelled unread (issue #144: an
  export whose photos mostly 404 used to hold one socket per failed attempt for the length of the
  import); the cap applies to the final body.

Design and misuse cases: `docs/superpowers/specs/2026-09-05-safe-fetch-redirects-design.md` and
`docs/superpowers/specs/2026-09-06-safe-fetch-literals-and-body-cancel-design.md`.

AI inference is **browser-direct**, not a server remote-fetch path. Alt-text suggestions
(local LM Studio or an admin-selected remote vision provider), editorial review, and excerpt
generation never call `safeFetch` or a server inference proxy. `src/editorial-review.ts`
contains only the review contract, schema, prompt and parser.

Review, excerpt, caption and model-discovery clients scope optional Bearer keys to individual
requests; local LM Studio receives none. Excerpts reuse the review provider/model/timeout and
the existing `/ai-config` authorization contract. The only other secret read is the admin-only
`GET /ai-providers/:id/credential` behind the Settings page's model lookup and Test. Since the provider
registry (2026-10-19) each provider has its own encrypted key, so Story review and Photo
descriptions on different providers send different keys, each only to its own provider's URL
(this replaces the 2026-10-17 shared-key approval, §13 of the #214 spec). Requests omit cookies/referrers and refuse redirects,
preventing credentials from being forwarded to a different endpoint. OpenRouter attribution uses
exact URL hostname equality, not a string/prefix match. Provider errors and abort reasons
are not surfaced verbatim, since they may echo credentials or unpublished content.
Review and excerpt requests share an abortable deadline covering attempts and body reads;
only an HTTP 400 explicitly naming unsupported `response_format` permits one retry without
that parameter.

Model output is untrusted: both review parsers validate required fields, types and statuses,
reject extra properties, strip Unicode controls, and cap text/list lengths. This is not
HTML sanitization: the editor drawer renders results through `textContent`/input values,
never `innerHTML`. The prompt treats the draft as data and asks for missing facts to verify,
not invented facts or links. Reviews grant no write/publish authority: only explicit
title/excerpt application changes form fields, and saving/publishing remains separate.
The drawer does not persist results or credentials. It aborts and invalidates work when
the reviewed draft changes or the drawer closes; late results cannot mutate another
locale/post. Cancellation does not retract a snapshot already received by the provider.
Deterministic checks remain usable when remote review fails.

The excerpt generator sends only the active locale's unsaved title and manuscript, not the
current excerpt. Its parser accepts only a bounded `{"excerpt":"…"}` object, rejects extra
properties/markup, and strips control characters. Results are plain text, require explicit
acceptance, and never save/publish automatically. A draft/locale/post change invalidates pending
and presented results; acceptance checks the snapshot again. `/ai-config` has a separate
15-second abortable read deadline. Suggestions and keys are not persisted.

Media-library photo details (title, DE/EN alt and caption, tags) use the caption
provider, config and request-local key; there is no additional secret or route. Only a
`ready` display variant on the configured image origin or the page origin, without
credentials, is downloaded (cookies and referrer omitted, redirects refused) and
re-encoded on a canvas, so no EXIF/GPS reaches the provider. The parser bounds the reply
like the review parsers, strips controls, caps every field and normalizes tags; the UI
renders it with `textContent`/input values only. This is the one AI path that saves
without per-item acceptance: the bulk dialog writes through the existing session-level
`PATCH /media/items/*` (the same authority as typing the text by hand, and server-side
`cleanText`/`normalizeTags` still apply). Its scope, destination and an explicit,
never-remembered overwrite choice are stated before it runs; without overwrite it fills
only fields that are empty on the row re-read just before each save; it never clears a
field; Stop sends no further save; three consecutive failures stop it. Library metadata
reaches a story only when an author inserts the photo and saves. See
`docs/superpowers/specs/2026-10-18-media-ai-details-design.md`.

Country-derived article coordinates use a bundled public-domain country-label-point table,
not an automatic request to `/geocode`. Saved/manual coordinates are not overwritten by
country edits. The separate, explicit waypoint-search boundary is unchanged.

### Retry widened the per-URL window (issue #85, 2026-07-30; narrowed by #93, 2026-09-05)

`POST /import` retries a failed image download up to `importRetries` times. `safeFetch` is
re-entered from scratch on every attempt, so every check above re-runs each time — a test counts
validations per attempt to keep it that way. When #85 landed, two **single-shot** accepted
weaknesses became multi-shot: `assertFetchableUrl` was a pre-resolution string check, and
`safeFetch` used `redirect: 'follow'`, so neither a private DNS answer nor a redirect hop was ever
inspected. `redirect: 'manual'` was considered then and **declined** — WordPress media URLs
legitimately redirect, and breaking the importer inside a larger change was the wrong trade
(PR #90). #93 implemented it on its own, with real redirect shapes tested: hops are now
re-validated and hostnames resolved before every connect (see above). What retry still multiplies
is the **DNS-rebinding residual** in *Known limitations* — a zero-TTL flip between the check and
undici's own connect-time lookup — and that window now gets `importRetries + 1` attempts per URL
instead of one. Compensating controls, all in `uploader/src/wp-import.ts`:

- **`retryBudget`** (default 200) caps *retry* attempts across an entire import, so the extra load
  this feature can generate is bounded at +200 fetches per import regardless of export size — not
  `retries × N`.
- **A per-host consecutive-failure breaker** (default 20) abandons a host for the rest of the run.
  This bounds *first* attempts against a **failing** host, and it matters: because the re-host
  cache is scoped per translation pair, one attachment URL referenced from N groups is fetched N
  times, which a 25 MiB export can push to roughly 40,000 requests against a single third-party
  URL. The breaker reduces that to ~20 whenever the target is failing.
- **A per-import cap on distinct images** (default 20,000) bounds *first* attempts against a host
  that **keeps answering** — the case the breaker cannot reach. Before running, `importWxr` counts
  the distinct (pair, url) re-host operations the import would perform and, if that exceeds
  `maxImages`, throws `ImportTooLargeError` without fetching anything; the route maps it to a 400
  naming the count. This is what closes the ~40,000-fetch exposure when the target returns 200.
- **Single-flight** — `POST /import` returns 409 while an import is running. The pacing gate is
  per-run state, so without mutual exclusion K concurrent imports give the victim K× the configured
  request rate and the throttle provides no aggregate guarantee at all. Since #92 the rule is
  owned by the import job runner (`import-jobs.ts`): the pre-flight (parse, cap, free space) stays
  on the request path with its status codes, the run is a background job, and the admin-only
  `GET /import/status` returns its counters plus the same capped, vague summary the old 200
  carried — no new disclosure.
- **Only transient fetch failures are retried.** The SSRF refusal (`kind: 'blocked'`), an unusable
  URL, an oversized response, a 4xx other than 429, a permanently unresolvable host
  (`ENOTFOUND`), and *anything that is not a `FetchError`* are never retried. In particular a
  `sharp` decode failure or an `ENOSPC` is not — re-downloading the same bytes to feed sharp again
  is memory pressure, not recovery.

**Bounded by the per-import cap:** the count of *successful* fetches against a host that keeps
answering. Pacing (`delayMs`) makes them polite; the distinct-image cap makes them few — an export
that would re-host more than `maxImages` (default 20,000) distinct (pair, url) images is rejected
with a 400 before any fetch, so the ~40,000-fetch attack above no longer has a path against a host
that answers.

### Import failure reasons are deliberately vague

`safeFetch` refuses internal addresses, and a refusal is itself a signal. `POST /import` has been
`requireAdmin` since #97, so the residual oracle below is reachable only by an admin — who already
has `/settings` and `/backups` — but the response stays vague regardless (defense in depth).
Before #85 a failed image returned the raw undici text to
the author — `connect ECONNREFUSED 10.0.0.5:8080` — a working internal-network mapping and
service-fingerprinting oracle. Import warnings now carry a stable reason ("network error", "blocked
address", "download failed", …) plus the URL the author supplied themselves; the underlying message,
HTTP status and error code go to **stdout only**. `failureReason` in `uploader/src/wp-import.ts`
carries an `@ai-warning` against widening it, and the warning list is capped so a dead CDN cannot
return >1,300 URL-bearing strings in one response.
The same split holds one tier up (issue #143, 2026-09-06): a group whose `upsertDraft` throws
reports the `PostError` message (a validation verdict worded for the author) but maps any other
throw — a pg `invalid byte sequence` or `connect ECONNREFUSED db:5432`, a missing relation — to a
fixed "could not be saved (see server logs)", the detail going to stdout. A malformed upload is a
400 (`WxrParseError`, fixed message; the parser's offset-and-context detail is logged only), never
a 500 with a stack.

### A partial import cannot be published (issue #91, 2026-09-06)

A failed re-host leaves the source URL in the draft body. Rendering would then hot-link the old
domain (an inline image with no `images` entry passes through unchanged) or drop the photo (a
gallery line fails the origin allow-list), and after the DNS cutover both 404. `POST
/posts/:tk/publish` and the bulk `publish` action therefore refuse while the **rendered** body of
either locale would emit an `<img>` — or contains a gallery line — whose **origin is not the image
host** (`analyzeBodyContent`, `uploader/src/publish-gate.ts` — origin equality, never a prefix, the
gallery allow-list's rule). Each candidate is resolved against the image host first, because a
browser gives a reference with no origin of its own the page's: `//old.example/a.jpg` (and its
`&#47;&#47;` and `\\` spellings) is a foreign hot-link the sanitizer keeps, while
`https:old.example/a.jpg` is a path on our own host and refusing it would be a false refusal.
The gate renders the body with the build's own `renderMarkdown` and
reads `img`/`source` sources and gallery lines from the sanitized hast tree itself
(`analyzeRenderedBody` in `site/src/lib/body-images.ts`, before any `images` resolution), so every Markdown/HTML subtlety — escapes,
`<…>` destinations, character references, code spans, backticks inside attributes — is decided
by the one parser that decides it for readers; a text scanner cannot be kept in agreement with
the renderer, and three review rounds proved it. No fetch, no DNS, no file access; the rendered
HTML is discarded. The 409 echoes up to five of the offending URLs — which the admin wrote or
imported themselves — so nothing new is disclosed. Cost is one render per locale, the work the
author-level preview route already does per request, so the gate (admin-only) adds no new
surface; the renderer's superlinear worst case on adversarial backtick bodies is pre-existing and
bounded by the 1 MiB request limit. See
`docs/superpowers/specs/2026-09-06-publish-gate-foreign-images-design.md`.

**Readiness follows actual rendered references** (#334, 2026-10-25). Single and bulk publishing
render each locale once, preserve the pre-transform foreign-origin check above, and derive media
readiness keys from the actual sanitized/transformed body image sources, plus heroes and title
images. Direct AVIF/WebP/JPEG variants count without metadata; obsolete unused `images` entries
do not. Known `processing`, `failed`, and `missing` rows refuse publication before snapshots or
builds change. No-row legacy body/hero references remain allowed; title images still require a
known ready library row. URL resolution uses origin equality and hosted path boundaries, with
body-relative URLs resolved against their public locale story URL. There is no remote fetch or
filesystem probe. Existing admin authorization, publish concurrency checks, sanitization,
gallery URL/dimension guards, preview CSP, and EXIF/privacy controls are reconfirmed unchanged.
See [the approved readiness specification](docs/superpowers/specs/2026-10-25-publish-readiness-references-design.md)
for failure recovery, rollback, and verification.

**Story heading semantics share this analysis** (#375). `publicationBody` uses the same
render per locale to refuse any surviving sanitized HAST `h1` element at any depth.
Single publish returns the expected locale-specific 400; bulk retains its per-pair failure
envelope and publishes/rebuilds only successful pairs. Renderer failures remain internal errors,
not H1 refusals or successes. The refusal precedes snapshot writes, exports and builds.
`validateForPublish` remains synchronous structural validation, not the complete eligibility gate.
No Markdown is rewritten and About/page publication gains no H1 restriction. Pre-transform
foreign sources and post-transform readiness references retain their existing policies.
See [the approved heading contract](docs/superpowers/specs/2026-10-27-rendered-body-h1-gate-design.md).

**Gallery partition availability** (#356, owner-approved 2026-10-28). Preview and
publication analysis await the same exact legal-edge optimizer used by static builds.
Reachability and conservative height intervals prune impossible/noncompetitive counts;
request callers inject `node:timers/promises.setImmediate` after at most 4096 accounted
edge/state/photo operations, including preparation and reconstruction. Builds drain that
same kernel without scheduling. The synchronous HAST visitor only queues request-local
gallery replacements; every replacement is awaited before serialization.

This does not change accepted photos, row order, the evenness/square objective, ties or
the height floor. Origin equality, dimension/format guards, string coercion/escaping,
sanitization order, preview CSP, authorization and EXIF policy are reconfirmed unchanged.
Remaining total work is **O(n³ B)** (bounds O(n² B), B the legal row-length bound), with
O(n² + nB) peak optimizer memory. A scheduling quantum is not a wall-clock or memory cap:
allocation/GC, Markdown parsing, sanitization and HTML emission remain outside this
optimizer's cooperative-work guarantee. No content cap or approximate fallback was added.
Authenticated disposable 400-photo preview and actual publication/build returned 200;
an unrelated static HTTP 200 completed before the last partition yield in both cases.
See [the exact-search specification and measured evidence](docs/superpowers/specs/2026-10-27-gallery-partition-work-design.md).

**Gallery grammar and source provenance** (#354, owner-approved 2026-10-28).
`gallery-identity.ts` owns the unchanged sanitize-first gallery predicate and body
schema. Satteri source analysis uses the same explicit parser features as Astro and
preview; save/import/export/audit and browser tools consume its logical lines and
UTF-16 source spans, including nested fences and raw HTML. HTML entities remain a
text layer, never trusted markup. Source-map failures refuse the operation; there
is no lexical-parser fallback or automatic content migration.

`POST /gallery/analyze` requires a session and the existing post JSON size ceiling.
It analyzes only the submitted unsaved body, returns `Cache-Control: no-store`, and
does not read private metadata, fetch remote resources, write content/revisions,
publish, or log source text. Browser results are tied to the exact request snapshot;
failed/stale analysis cannot edit the manuscript. Both locales are normalized before
store writes, and both export documents are prepared before either file is written.
The warning-only alt audit is prepared before publication side effects.

Content injected after sanitize retains origin equality, HTTP(S)-only image URLs,
dimension/format validation, string coercion/escaping and library-description
precedence. Publish image guards still inspect the actual rendered tree. Preview
CSP, authorization, EXIF/private-original policy and #356's awaited rendering and
scheduling contract are unchanged. Recovery: stop gallery mutations/export if
mapping is defective, retain the prior static release, and roll forward a targeted
mapping fix; do not restore the lossy scanners or rewrite owner content silently.
See [the approved grammar contract](docs/superpowers/specs/2026-10-27-gallery-grammar-agreement-design.md).



## Output sanitization (stored XSS)

Post bodies are DB-stored Markdown rendered to HTML at build time. Before that HTML reaches the
public site it is run through **`rehype-sanitize`** (`site/src/lib/body-images.ts`), stripping
`<script>`, inline event handlers, `javascript:` URLs, and `iframe`/`object`/`svg`. The schema is
tuned so it does **not** break legitimate output: heading `id`s stay un-prefixed (so the table of
contents `#anchor` links resolve) and `class` survives everywhere. Verified end-to-end against a
published post carrying an XSS payload.

The #375 H1 predicate reads the shared sanitize-first tree; it does not relax the
schema, image injection guards, preview CSP or photo privacy controls. Enforcing one
story H1 is a document-semantics rule, **not an XSS protection**.

**No element may carry `style`** (#124). Astro's Markdown renderer passes raw HTML through, so the
sanitizer cannot distinguish a Shiki `<span style="color:…">` from an author-typed one — and an
author-typed `style="position:fixed;inset:0;background:url(https://evil/…)"` would overlay every
reader page (defacement) and fire a third-party request per view (reader IP leak), on the draft
preview as well, so publish review would not catch it. Shiki therefore no longer emits inline
styles at all: `site/src/lib/shiki-classes.ts` registers a transformer (in both
`astro.config.mjs` and `MARKDOWN_OPTIONS`, lockstep-tested) that rewrites each colour into a
class, and `SHIKI_CSS` — generated from the same theme object — is inlined by `Base.astro` and
by the draft preview. `style` is off the schema for every element; the gallery `--r` ratios and
the hero focal point are the only inline styles on a page, and both are injected post-sanitize
from computed numbers.

**The hero focal point does not weaken that** (2026-09-18). `heroImage.focus` lets an author pick
the `object-position` a `cover` crop keeps in frame, which is an inline style on a component's own
`<img>` — never on author markup, and never a value passed through. `focusPosition`
(`site/src/lib/images.ts`) is the single producer: it accepts only two numbers, clamps them to
0–100, rounds them, and emits nothing at all for anything else, so a hostile string in the
`posts.hero_image` jsonb column yields no attribute rather than a declaration. It is validated on
the way in as well, at the store chokepoint (`heroImageError` in `uploader/src/body-content.ts`),
because the WordPress importer bypasses `validateDraft`. `site/src/lib/images.test.ts` pins the
clamp and the hostile-input case.

**Optional story title images** (2026-10-16) reuse the hero image validator and focal-point
renderer; `posts.title_image` introduces no raw markup or remote-fetch path. The store rejects
invalid dimensions, format, focus and URL shape; publishing additionally requires nonblank alt
text, the configured image origin, and a known `ready` media item. Single and bulk publication
apply the same checks. Working and published title references both participate in media usage
and deletion protection, so replacing a draft banner cannot orphan the live banner.
Existing upload authorization, EXIF filtering and preview CSP remain unchanged. The
`/admin/editor-image-copy.js` asset contains only public DE/EN interface strings, never
post data or credentials. Schema and v9 backup recovery are documented in the
[approved title-image spec](docs/superpowers/specs/2026-10-16-story-title-image-design.md).

> We deliberately use a maintained, allow-list sanitizer rather than hand-rolled escaping — the
> cardinal rule of XSS defense.

### Reader comments are plain text, never markup

Comment bodies and display names (#206) are **untrusted reader text**, a stricter class than the
author's Markdown: their allow-list is *none*. They are `\p{C}`-stripped, trimmed and
length-capped at the store boundary (`cleanName` / `cleanBody`, name 1–80, body 1–2000) and
stored and returned as plain text — the public API contract is already text, not HTML. No
markdown, no autolink, no `set:html`. Every surface that paints them must use `textContent` /
`document.createTextNode`: the admin moderation page already does; the story-page island (#208)
must, and its tests pin it. `rehype-sanitize` is deliberately **not** reused for reader input —
that path is load-bearing for the author's body (#124, #91), and feeding it anonymous text would
double its attack surface.

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
- **Gallery-local captions are fence text, rendered as text** (2026-10-19, owner-approved). A
  photo line's `caption-override="…"` and the fence's `#captions: hidden` directive are read by
  `readCaptionOverride` / `readCaptionsVisible` in `site/src/lib/gallery-layout.ts` — the same
  readers the save normalizer and MDX exporter in `uploader/src/body-content.ts` use. The override
  is author-controlled text the sanitizer never sees, so it only ever becomes a hast **text node**
  (`String()`-coerced, entity-escaped on output): HTML or fence syntax in it renders literally.
  On the line it is stored `escapeMeta`-encoded and capped at 1,000 characters, so it can neither
  end the photo line, add a `|` field, nor fake a directive line. It changes only the caption:
  the URL is still read from the line's first field and passes the same origin, dimension and
  format guards before any override is consulted, and alt stays library/`images`-map
  authoritative. It is never lifted into the URL-keyed `images` map, so it cannot leak into
  another gallery using the same photo, and it creates no Media write. Precedence: hidden
  gallery → no caption (and so none in the lightbox, which reads `.jgal__cap` back out of the
  figure); line override (empty included) → that text; otherwise library caption, then the
  stored one. Body-wide image passes run only outside parser-established gallery ranges,
  through `rewriteOutsideGalleries` (which `markdownImages` itself uses): the save-time
  `<BodyImage>` conversion, the MDX exporter's inline pass, the WXR importer's re-host scan,
  pre-flight count and merge substitution, the alt audit and media-sync's alt backfill. Gallery
  text that looks like an image or a tag therefore keeps its exact text through save, export,
  re-import and import re-runs, and is never fetched, audited or copied into Media.

Why this is not merely theoretical: `GET /posts/:tk/preview` is `requireAuth` (**any** author, not
just admins), runs the identical transform, and is served same-origin with `/admin/*`. A non-admin
author storing a payload in a draft that an admin then previews would run script with the admin's
cookie against `POST /users`, `GET /backups/*` and `POST /posts/:tk/publish`. Since #124 the
preview reply carries a deny-by-default **Content-Security-Policy** (`previewCsp` in
`uploader/src/preview.ts`): `default-src 'none'; img-src 'self' <PUBLIC_BASE_URL origin>;
style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The page
is static markup with one inline `<style>` and no scripts, so a sanitizer regression that lets a
`<script>` through becomes a blocked no-op on the admin origin rather than session XSS. Side
effect, accepted: a draft that references an image on any other origin shows it broken in the
preview even though the live site would load it.

## Transport, headers & proxy

- Every response carries `X-Content-Type-Options: nosniff`. `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer` are added on every matched route that is not one of the public
  static mounts (the blog and image-host `/*` wildcards and the `/map/*` basemap), and withheld
  from the not-found handler (the blog's 404 page, legacy 301s, the 503 "building" page); public
  blog pages therefore carry only `nosniff`, at parity with the old nginx config. The rule is
  derived from the matched route, not from a prefix list — the old list had drifted in both
  directions (#130), so `/api/*` shipped without the headers. (CSP is
  intentionally omitted on the admin pages because they use inline scripts; a strict policy would
  need nonces. The one exception is `GET /posts/:tk/preview`, which renders author markup and has
  no scripts — see *Output sanitization*.)
- The app sets `trustProxy: 1` (exactly one trusted hop), so it reads `X-Forwarded-*` as set by
  that one reverse proxy for the client IP (rate limiting) and the cookie `Secure` flag. **It must
  run behind a TLS-terminating reverse proxy that sets `X-Forwarded-Proto`**; the compose file
  publishes port 3000 on `127.0.0.1` only, so the host proxy is the sole ingress. A second proxy
  layer needs the hop count raised to `2` — never `true`, which trusts client-supplied entries.
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
- **AI provider credentials (#214, registry 2026-10-19):** one `app_secrets` row per remote
  provider, `ai_provider_key:<id>`, AES-256-GCM with random 12-byte IVs and 16-byte
  authentication tags. Slot names are built only from a server-assigned, regex-validated id
  that exists in the registry — never from a client string. Hex-encoded envelopes are stored
  in Postgres; the 32-byte `ENCRYPTION_KEY` stays in private bootstrap configuration. Missing
  encryption configuration leaves local workflows available; malformed supplied values
  stop boot before schema work. Wrong keys/tampering fail closed with fixed sanitized
  errors, without logging raw crypto/driver errors or credential-bearing request bodies.
- **Keys are bound to their provider:** each provider (name, kind, base URL in
  `settings.json`) owns its own key, and `/ai-config` only ever returns a key together with
  the base URL of the provider that owns it. Switching a use case to another provider sends
  that provider's key, never the previous one. A key moves only when an admin edits its
  provider's base URL, which the UI warns about and confirms, naming both URLs. Local LM
  Studio providers cannot hold a key (400). The provider is deletable only when it is neither
  the default nor assigned; deleting it removes its key first.
- **Author disclosure is deliberate:** admin-only routes (`POST/PUT/DELETE /ai-providers*`,
  `POST /settings`) manage providers and keys, while authenticated `GET /ai-config` and
  `?purpose=caption` return plaintext in browser memory for the provider assigned to Story
  review or Photo descriptions when it is remote — up to two different keys, never the key of
  an unassigned provider. Admin-only `GET /ai-providers/:id/credential` returns one remote
  provider's key to the admin's browser for Settings' model dropdowns and **Test**; opening the AI
  models tab looks up models automatically for each assigned provider (owner decision 2026-10-19),
  calling only that provider's `/models`, never a completion. `GET/POST /settings`
  return presence (`hasApiKey` per provider) only, never key/ciphertext; `POST /settings`
  refuses `aiApiKey` and `aiProviders` with 400. All use `Cache-Control: no-store`.
  Never persist keys in browser storage, draft backups, URLs, logs, or rendered output.
  TLS at the proxy remains required.
  Every author can copy a returned key; session revocation cannot retract it. Revoke at
  the provider after suspected exposure and use provider-side access/spend limits.
- **No server AI egress:** the server never fetches provider URLs. The caption-only query
  `GET /ai-config?purpose=caption` resolves the photo provider. For a local provider it
  performs no secret lookup or wait, so remote crypto failures do not disable local alt
  text. Remote captions send a resized JPEG and prompt from the browser with that provider's
  key; remote config fails closed on secret errors. Presets and custom HTTP(S) destinations
  are admin authority. Custom HTTP can expose key/content on the network; prefer HTTPS and
  never add a proxy to work around CORS/mixed-content failures.
- **Settings failure residual:** settings.json and Postgres cannot commit together. Every
  serialized provider/settings write prevalidates everything, commits the secret first, then
  writes settings. A subsequent failure can leave a new key with the old URL, or a removed key
  on a provider that still exists; responses explicitly report partial or unknown outcomes.
  Reload and deliberately reconcile before inference. The UI clears its typed key, reloads
  presence/settings, and never runs inference on save.
- **Registry migration:** the first boot of the registry release copies the legacy shared
  `ai_api_key` envelope to every provider that already received it (the remote providers the
  two features had selected) and deletes the legacy row, in one Postgres transaction, without
  decrypting; then it writes `settings.json.pre-ai-registry` (non-secret rollback copy) and the
  new settings. A legacy row restored later from an old dump is never read.
- Encryption at rest does not isolate secrets from a compromised host/app/browser,
  replay of an older valid DB row, swapping envelopes between provider slots (no AAD binds a
  row to its slot), Docker-inspection privileges, or the existing build child's inherited
  environment. Explicit owner implementation approvals and recovery:
  `docs/superpowers/specs/2026-09-19-encrypted-ai-review-secrets-design.md` and
  `docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md`.

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
- **Bounded build (#110):** the spawned `astro build` runs under the exclusive build/encode lock,
  so a child that never exits would wedge every publish, rebuild and encode until a manual
  restart. `uploader/src/build.ts` therefore SIGKILLs the child after `BUILD_TIMEOUT_MS`
  (15 min) and reports `timed out`, and both Content Layer loaders read through
  `site/src/lib/loader-pool.ts`, whose connection and query timeouts turn a silently hung
  Postgres into a build error within about a minute. The deadline is not request-controlled, and
  every route that starts a build is admin-only, so an author cannot hold the lock by crafting
  content. The last 4 KiB of the child's **stderr** (ANSI-stripped) is appended to the build error
  returned to the authenticated caller so the admin learns which post failed the schema; it is
  build diagnostics (entry ids, schema paths, library file paths), never `DATABASE_URL` — the
  child reads that from the environment and neither astro nor pg echoes it on a query error.
- **`/health` reports `release`** (whether a built site exists) beside free space, and like free
  space it is **information, never a verdict**: a fresh volume legitimately has no release for
  the first minutes, a persistent build failure is healed by a publish rather than a container
  restart, and a 503 there would mask a real DB outage. The public blog already answers 503
  "site is building" in that state, so the flag discloses nothing new.

### Backups

- Backup dumps (`/data/backup/db/db-*.json.gz`) contain the `users` table **including scrypt
  password hashes** — treat backup files as sensitive, same as the database itself. `sessions` are
  **never** dumped (disposable, and token hashes don't belong in a backup).
- Version 6 also captures encrypted `app_secrets` in the same repeatable-read snapshot,
  never plaintext/master keys. Retain the matching master key separately for every backup
  generation. An absent secrets field in v1–v5 (or v6) preserves live rows; a present array
  replaces them, including an intentional empty array, inside the restore transaction.
  The CLI's pre-dump includes secrets and its summary distinguishes preserve/replace.
  Reconcile settings.json and the matching master key before resuming remote review:
  logical dumps do not capture the settings file. A lost master key requires reissuing
  the provider credential, not bypassing encryption. Removing a row does not revoke the
  key externally or remove copies in old backups.
- Image archives (`/data/backup/db/images-*.tar`) contain no password hashes — only the already
  publicly served image files — but their download route stays behind the same admin gate and
  strict filename validation as the dumps.
- The download route (`GET /backups/:name`) is **admin-only** and validates the filename against a
  strict pattern (`^db-\d{8}-\d{6}\.json\.gz$` or `^images-\d{8}-\d{6}\.tar$`) before touching the
  filesystem — no path traversal.
- Restore is **CLI-only**
  (`docker compose exec app node --import tsx src/cli.ts restore [--yes] /data/backup/db/<file>`
  — the shell-less runtime image requires invoking `node` directly), never a web route, because
  it's destructive: it deletes and re-inserts `users`, `posts`, media, and `pages` in one
  transaction (`pages` only when present in the dump — v1 dumps predate them and leave existing
  pages untouched). Deleting `users` cascades to `sessions`, so a restore invalidates every login.
  The CLI is guarded against operator mistakes, not attackers (#114): the file name must match
  the dump pattern, the operator confirms against a summary of the dump and of the live rows
  (`--yes` for scripts; the printed target is `host:port/dbname` — the `DATABASE_URL` password is
  never echoed), and a **pre-restore dump** of the current state is written into the backup
  directory first — the restore aborts if that dump fails, so a restore that cannot be undone is
  never run.
- In-app backups live on the **same disk** as the live data; disaster recovery requires an
  offsite host-level backup of `./uploader/data` — see
  [ARCHITECTURE.md](ARCHITECTURE.md#backups--disaster-recovery).

## Known limitations

- SSRF filtering resolves every hostname and refuses internal answers, but it cannot pin that
  answer into the connection: undici resolves the name again when it connects, so a zero-TTL DNS
  rebinding flip between the check and the connect still lands one request. Closing it needs a
  custom `undici` `Agent` with `connect.lookup` — a new dependency, declined for the trusted,
  single-tenant deployment (`docs/superpowers/specs/2026-09-05-safe-fetch-redirects-design.md`).
- The rate limiter and (non-pg) session/user fallbacks are per-process/in-memory.
- No Content-Security-Policy on the admin app (inline scripts), except on the draft preview.

## Reporting

This is a personal project. If you find a security issue, contact the maintainer privately rather
than opening a public issue.
