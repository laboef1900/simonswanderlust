# Security model

This documents how the self-hosted CMS + image service (`uploader/`) and the static blog (`site/`)
are protected. The static site itself is just files served by nginx; the interesting surface is the
**uploader** (auth, uploads, database, remote fetches) and the **build pipeline**.

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

## Authorization

- `requireAuth` gates all CMS/editor/upload/import endpoints.
- `requireAdmin` gates **user management** and, importantly, **publishing**
  (`POST /posts/:tk/publish`). Non-admin authors may create and edit drafts but **cannot push
  content to the public site or change a published slug** — only admins publish.

## Rate limiting

A per-client-IP fixed-window limiter throttles the unauthenticated auth endpoints (`/login`,
`/setup`) to slow brute-force attempts. It is in-memory and dependency-free
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

The LM Studio settings endpoints intentionally allow private/localhost targets (that is where a
local model runs) and are admin-operated.

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

- Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
  `Referrer-Policy: no-referrer`. (CSP is intentionally omitted because the admin pages use inline
  scripts; a strict policy would need nonces.)
- The app sets `trustProxy`, so it reads `X-Forwarded-*` for the client IP (rate limiting) and the
  cookie `Secure` flag. **It must run behind a TLS-terminating reverse proxy that sets
  `X-Forwarded-Proto`**, and port 3000 must not be exposed directly to the internet.

## Secrets

- `DATABASE_URL` and `BUILD_SECRET` are provided via environment (compose `.env`), never committed.
  `.env`, credentials, and binaries are git-ignored.
- The rebuild trigger (`POST /build`) is authorized by a **constant-time** comparison of
  `x-build-secret` (`timingSafeEqual`); an unset secret fails closed (builds cannot be triggered).

## Known limitations

- SSRF filtering blocks literal internal IPs but does not resolve DNS, so a hostname that resolves
  to a private address is not caught (DNS-rebind-proof filtering is out of scope for the trusted,
  single-tenant deployment).
- The rate limiter and (non-pg) session/user fallbacks are per-process/in-memory.
- No Content-Security-Policy on the admin app (inline scripts).

## Reporting

This is a personal project. If you find a security issue, contact the maintainer privately rather
than opening a public issue.
