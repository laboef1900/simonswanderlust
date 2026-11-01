# Security and Operations

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Security, Privacy, and Robustness

Full security model: `SECURITY.md`. These patterns MUST be preserved when changing `uploader/`.

- **Security verification target:** **OWASP ASVS 5.0, Level 1.** L1 matches the risk profile
  (single admin, no third-party users, no payments). The app **does** store reader data since
  #206 (comment display name + body), which this rule says should raise the target to L2; that is
  covered by a **recorded exception** (waived rule, reason, risk, compensating controls, approver,
  review by 2027-03-14) in `docs/superpowers/specs/2026-09-14-comments-design.md`. Raise to L2 at
  the first of: reader accounts, email/notifications, or comments on a non-trip surface.
- **RASP:** deliberately **not enabled**. In-process attack detection/blocking was considered and
  declined — it adds a dependency and runtime overhead to a single-container, single-admin
  deployment whose exposure is already narrowed by session auth, rate limiting, and one published
  port. Revisit only if the app gains untrusted users.

### 1. API and Configuration (secure by default)

- **Authentication** — All mutating uploader endpoints require a valid session (HttpOnly cookie;
  username/password accounts in Postgres). The only exceptions are `POST /login`, first-run
  `POST /setup` (guarded by a zero-users check, a setup lock, and the login rate limiter), and
  the public `GET`/`POST /comments` (#206: no session preHandler by design, Origin equality,
  honeypot 204, its own rate limiter, hold-for-moderation — see `SECURITY.md` *Public comments*).
  Never infer safety from the HTTP method.
- **Authorization** — Authorize the exact action and resource in every handler, reads included.
  Publish, rebuild, page edits, settings, backups, user management, and the irreversible media
  operations (`DELETE /media/items/*`, `PATCH`/`DELETE /media/folders`, `POST /media/rescan`) are
  **admin-only**. Auth endpoints are rate-limited.
- **Password safety** — `uploader/src/users.ts` uses **scrypt** (`node:crypto`) with the cost
  parameters encoded in the stored hash (`scrypt$N$r$p$salt$hash`), which is what makes an upgrade
  path possible. Verification is `timingSafeEqual`. Do not swap the algorithm without a migration
  that can read existing hashes.
- **Infrastructure isolation** — Only the app's port `3000` is published; Postgres is reachable
  solely on the compose-internal network.
- **Hardened remote fetches** — WP-import fetches go through `safeFetch` (SSRF guard, timeout,
  streamed size cap). File access goes through path-traversal guards (`assertSafeKey`,
  `assertSafeFolder`). Keep these intact; re-assert at read boundaries that build paths from
  database content, not just at write boundaries.
- **Configuration** — Do NOT grow `.env`. Operational app settings live in a JSON settings
  store on the data volume (`uploader/src/settings.ts`, atomic-rename writes), managed via
  admin Settings. Site identity (names, localized text, social links and the reserved canonical
  origin/logo/favicon fields) lives in Postgres with content and travels in DB dumps.
  `.env` is reserved for bootstrap values (`DATABASE_URL`/`POSTGRES_PASSWORD`, `PUBLIC_BASE_URL` —
  see `uploader/.env.example`). `SITE_IDENTITY_JSON` and `SITE_DATABASE_SNAPSHOT` are internal,
  unconditionally builder-set values, never operator settings.
- **Identity contract (#274)** — Use the shared `site/src/lib/site-identity.ts` validator for
  full stored DE/EN maps before projecting active locales. Seeds are one-time and leave
  `saved_at` NULL; new author replies use the cached author name, never the login username.
  Saves persist without rebuilding; public text changes on Publish/Rebuild. Dumps v11 include
  identity/assets; pre-identity restores recover legacy text and retain a live canonical origin.
  Asset APIs/rendering remain #275; canonical editing/SEO, comment-origin wiring and unconfigured
  noindex remain #276. Do not widen #274 into those children or claim their controls are active.
  See the approved 2026-10-27 identity spec and `docs/site-identity-branding-allowlist.md`.

### 2. Framework and Output Safety

- Treat every Fastify route as a public HTTP endpoint: authenticate/authorize *inside* the handler
  chain and validate input payloads immediately.
- Post body HTML is sanitized before rendering. Anything injected via `set:html` in `site/` must be
  escaped or sanitized — XSS applies even to a static site.
- **Markup injected after `rehype-sanitize` inherits none of its protections.** The gallery and
  picture nodes are injected post-sanitize, so their guards are load-bearing: allow-list image URLs
  by **origin equality** (never a prefix match), coerce alt/caption with `String()`, and validate
  dimensions before they reach markup arithmetic.
- Serialize explicit response shapes. `GET /media` and the item routes redact GPS and uploader
  identity for non-admins (`redactForNonAdmin`) — never return a raw row.
- Never return raw database, stack, or infrastructure errors. The global error handler logs the
  detail server-side and returns a sanitized message.

### 3. Privacy and Sensitive Data

- **Photo EXIF is the sensitive surface.** Published variants carry an EXIF allow-list, not full
  metadata — no GPS, XMP, or IPTC. Originals retained under `/data` may still hold GPS; that is why
  `GET /media` redacts `lat`/`lng` for non-admins. The `audit-exif` CLI subcommand reports actual
  exposure across the stored corpus.
- Never log secrets, session tokens, password material, or GPS coordinates.
- High-risk changes MUST update or explicitly reconfirm the relevant section of `SECURITY.md`.

### 4. AI/LLM Security

- AI captions and editorial review are browser-direct. The server never contacts a model:
  do not proxy providers through the server or `safeFetch`, which would add an SSRF surface.
- Model output is untrusted; it MUST NOT reach commands, queries, or authorization decisions.
- AI destinations live in the **provider registry** (`settings.json` `aiProviders`, one
  assignment per use case: Story review & excerpts, Photo descriptions). Each remote provider
  owns one encrypted key (`app_secrets` `ai_provider_key:<id>`); slot names come only from
  validated registry ids (`slotFor`). `GET /ai-config[?purpose=caption]` returns a key only
  together with the base URL of the provider that owns it, to authenticated authors in
  request-local browser memory; local providers never hold or read one, and local captions
  never touch the secrets store. Never persist keys in browser storage, logs, or draft
  backups. Config and credential responses are `no-store`.
- Provider/key management (`/ai-providers*`, incl. the admin-only `/credential` read for
  Settings Test) and settings writes remain admin-only. Settings responses expose only key
  presence; `ENCRYPTION_KEY` is separately escrowed. Missing master key allows local
  workflows; malformed supplied values refuse boot.
- Settings.json and Postgres saves can partially commit: secret first, settings second.
  Preserve explicit partial-failure reporting and local caption isolation. See the
  approved #214 spec, the 2026-10-19 provider-registry spec, and `SECURITY.md` for
  key-binding, author-disclosure, migration and recovery risks.


## Runtime and Operations (`app` container)

Applies to the `uploader/` runtime; `site/` is static output and exempt.

### 1. State, Logs, and Schema Changes

- **State in backing services** — Durable data lives in Postgres or under `/data` (releases,
  images, backups), never only in process memory or the container filesystem. In-memory state
  (encode queue, work lock) MUST be reconstructible — `encodeQueue.recover()` re-seeds from
  `status = 'processing'` on boot, and `media-sync` reconciles disk against the database.
- **Logs as event streams** — Log to `stdout`/`stderr` only (Docker captures them); no log files.
- **Schema changes** — `uploader/src/db.ts` owns the schema via idempotent
  `CREATE TABLE IF NOT EXISTS` bootstrap plus additive migrations; evolve it there. No hand-run SQL
  against the live DB. Destructive or irreversible changes require explicit approval, a verified
  backup, and a recovery plan.

### 2. Observability

- Logs are plain text to stdout today, with no correlation IDs, metrics, or traces. That is
  **accepted** for a single-container, single-admin deployment — do not add a telemetry stack
  without a reason tied to an actual operational failure.
- If telemetry is ever added: bounded correlation context only, and never secrets, GPS, or
  unbounded attacker-controlled values as attributes.

### 3. Resilience

- Every external call needs a timeout and defined cancellation behavior — `safeFetch` already
  enforces timeout plus a streamed size cap, and Fastify has an explicit `requestTimeout`.
  **`requestTimeout` bounds only how long the server waits to *receive* a request, not how long a
  handler may run** — long operations (bulk publish, full rebuild) are bounded by the reverse proxy,
  not by this process.
- Retry only transient failures, with bounded attempts. Re-encoding is idempotent (variants
  overwrite the same filenames), which is what makes `POST /media/retry` safe.
- When a status flip precedes a fallible enqueue, **roll it back on failure** — otherwise the row
  is stranded in `processing` with nothing queued.
- Health: `/health` (DB-probing, used by the compose healthcheck); `restart: unless-stopped` covers
  crashes. Degrade gracefully when an optional dependency is down — never crash the app over one.
- Shutdown drains in-flight work best-effort; it can be SIGKILLed mid-drain, so no step may depend
  on the drain completing. `encodeQueue.recover()` heals the remainder on next boot.
- Security, authorization, and integrity failures MUST NOT fall back to weaker defaults.

### 4. CI/CD and Software Supply Chain

- `.github/workflows/ci.yml` runs the Automated Verification Loop (typecheck + tests for both apps
  + `astro check` + full `astro build`, against a Postgres service container) on every PR and on
  every push to `dev` or `main`. It is the authoritative merge gate for both protected branches.
- `.github/workflows/release.yml` builds the app image ONCE per version tag (`v*.*.*`) and pushes
  it to GHCR with least-privilege `permissions:`. Deploys promote that immutable image by bumping
  `IMAGE_TAG` in the server's `.env` — never rebuild on the server.
- **Known gaps against the template, accepted for now.** Record here rather than silently claiming
  compliance; close them when the project's risk justifies the effort:
  - `ci.yml` has no `permissions:` block, so it runs with the default token scope.
  - Third-party actions are pinned by major tag (`@v4`), not immutably by commit SHA.
  - No SBOM, provenance attestation, or image signing on release.
  - No `dependabot.yml`; dependency updates are manual (`npm audit` at upgrade time).
  - No secret scanning or SAST in CI.
- **Backups** — Postgres backups run scheduled/on-demand to `/data/backup/db` with retention
  pruning (admin Settings page); restore is CLI-only — see `ARCHITECTURE.md`.
