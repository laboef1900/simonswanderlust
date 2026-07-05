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
  retention), **backups**, **rebuild**, **page edits**, and, importantly, **publishing**
  (`POST /posts/:tk/publish`). Non-admin authors may create and edit drafts but **cannot push
  content to the public site or change a published slug** — only admins publish.

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

- **Storage keys** pass `assertSafeKey` in `storeVariants` — the central chokepoint for every write
  path (direct upload *and* the WordPress re-host path). Keys must match `^[a-z0-9][a-z0-9/_-]*$`
  with no `..` or `//`, so a write can never escape `STORAGE_DIR` (path-traversal defense).
- **Imported slugs** are validated at the WordPress-import boundary; a group with an unsafe slug is
  skipped with a warning and never reaches the database, the storage path, or the MDX export.
- **Coordinates** are bounded on publish (`lat ∈ [-90,90]`, `lng ∈ [-180,180]`, finite).
- **SQL** is parameterized throughout (`pg` placeholders) — no string-built queries.

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

### Database backups

- Backup dumps (`/data/backup/db/db-*.json.gz`) contain the `users` table **including scrypt
  password hashes** — treat backup files as sensitive, same as the database itself. `sessions` are
  **never** dumped (disposable, and token hashes don't belong in a backup).
- The download route (`GET /backups/:name`) is **admin-only** and validates the filename against a
  strict pattern (`^db-\d{8}-\d{6}\.json\.gz$`) before touching the filesystem — no path traversal.
- Restore is **CLI-only** (`tsx src/cli.ts restore <file>`, run inside the container), never a web
  route, because it's destructive: it deletes and re-inserts `users` and `posts` in one
  transaction. Deleting `users` cascades to `sessions`, so a restore invalidates every login.

## Known limitations

- SSRF filtering blocks literal internal IPs but does not resolve DNS, so a hostname that resolves
  to a private address is not caught (DNS-rebind-proof filtering is out of scope for the trusted,
  single-tenant deployment).
- The rate limiter and (non-pg) session/user fallbacks are per-process/in-memory.
- No Content-Security-Policy on the admin app (inline scripts).

## Reporting

This is a personal project. If you find a security issue, contact the maintainer privately rather
than opening a public issue.
