# CLAUDE.md

Guidance for AI coding assistants (Claude, Gemini, Codex) working in this repository.
Derived from `../TEMPLATE.md` and kept in sync with it, tailored to this project.

This repo is a **monorepo** with two parts, and most rules below apply to only one of them:

- **`site/`** — an Astro 7 **static site**. It builds to a static `dist/` (content is loaded from
  Postgres at build time), so the template's auth/RBAC, SRE, resilience, and container rules do
  **not** apply to it directly. Its risks are output safety (XSS via `set:html`), the SEO slug
  contract, and i18n completeness.
- **`uploader/`** — a small self-hosted **Node 26 + Fastify 5 + sharp** app (CMS + image service +
  blog serving). Docker, a server runtime, and every Security/Privacy/Operations section below DO
  apply here.

Unqualified rules describe both; where they differ, the tree is named explicitly.

## Project Overview

**Simon's Wanderlust** (`simonswanderlust.com`) — a bilingual (DE/EN) personal travel blog.
This repo is the **Astro 7 static-site rebuild** of the current WordPress + Elementor site.

- **Architecture:** One Astro 7 project under `site/`, **self-hosted via Docker** as a **single
  `app` container** (WordPress-style) alongside Postgres, wired in the root `docker-compose.yml`.
  The uploader serves the blog itself, in addition to being the admin CMS and image service.
  UI is Astro components + Tailwind 4.
- **Primary users:** One admin/author (the owner). Public readers consume only the static blog
  output; they never reach an authenticated surface.
- **Risk level:** **Normal.** No third-party accounts, no payments, no customer PII. Elevated only
  where the uploader touches remote fetches (WXR import), untrusted markup (body HTML), and photo
  metadata (EXIF/GPS).
- **Sensitive data:** Admin account credentials (scrypt hashes) and session records in Postgres;
  photo EXIF including GPS coordinates in the media library. Everything else is public content.
- **Enabled profiles:** Web/API · Frontend · Database · Containers · AI (one narrow feature).
- **Authoritative product documentation:** `docs/superpowers/specs/` (design specs) and
  `docs/superpowers/plans/` (phase plans) are the source of truth for scope.
- **Architecture decisions:** No separate ADR directory. The dated specs in
  `docs/superpowers/specs/` serve that role; `ARCHITECTURE.md` holds the current-state overview.

If a request conflicts with a spec in `docs/superpowers/`, a safety rule, or an explicit project
constraint, stop and ask instead of guessing.

**Content pipeline (Phase A + B + single-app-container):** `trips` content is authored via the
**in-admin editor** (`/admin/posts.html` + `/admin/editor.html`) and stored in **Postgres** — not
edited as MDX in git. The Astro Content Layer loader (`site/src/lib/postgres-loader.ts`) reads
from Postgres at build time; the Zod schema and entry `id`s (`de/<slug>` / `en/<slug>`) are
unchanged, so `paths.ts`/`trips.ts` work unmodified. Post bodies are Markdown; body images render
as responsive `<picture>` via `site/src/lib/body-images.ts`. The blog is **not** built at Docker
image-build time — the `app` container (`uploader/src/build.ts`) spawns `astro build` **in-process,
via plain node** (no npx/shell) from Postgres at runtime, writing the static output into
**`/data/site`** (releases + a `current` symlink), which the same process serves directly. The
in-admin **Publish** button awaits the rebuild synchronously; MDX backups can be exported to
`/data/backup` via **Export all**, and the database itself (`users` + `posts` + `pages`) can be
backed up on a schedule to `/data/backup/db` (admin settings page; restore is CLI-only — see
`ARCHITECTURE.md`).
Required env var for the app: **`DATABASE_URL`** (see `uploader/.env.example`). Consequence:
`npx astro check` and `npm run build` both require a reachable Postgres.

The same **`uploader/`** app also optimizes uploaded photos into responsive AVIF/WebP variants and
returns paste-ready `heroImage` / `<RemoteImage>` / `<BodyImage>` snippets. Access is gated by
username/password accounts stored in Postgres, with HttpOnly session cookies. Everything runs on
Simon's own server, in one container. The blog has **one** small AI feature: **editor-integrated
alt-text suggestions** via a local LM Studio vision model, called **directly from the browser**
(the server never contacts the model; no new server SSRF surface). See
`docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md`. (An earlier
standalone batch-uploader variant was removed in July 2026 and restored in this slimmer,
editor-integrated form; the 2026-06-22 spec is historical.) See `uploader/README.md`,
`ARCHITECTURE.md`, and the specs
`docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md` +
`docs/superpowers/specs/2026-07-03-single-app-container-design.md`.

**Design language:** Editorial magazine + "refined brand" voice, with an "Expedition Log" flavor
layer (mono coordinates from frontmatter, N°XX entry numbers, contour textures, arrival stamps,
dashed route dividers). See `docs/superpowers/specs/2026-06-11-blog-redesign-design.md`.
(This replaces the template's "Glass & Bento" house style — do not reintroduce glassmorphism,
bento grids, or a dark-by-default theme here.)

## Requirement Language and Exceptions

- **MUST / MUST NOT:** Mandatory. Enforce automatically where practical.
- **SHOULD / SHOULD NOT:** The default; deviation requires a documented reason.
- **MAY:** Optional.

An exception to a MUST requires explicit owner approval and a record containing the waived rule,
reason, risk, compensating controls, approver, and review or expiry date. Never create an
exception merely to make a check pass. Record accepted exceptions in the relevant spec under
`docs/superpowers/specs/`, next to the decision they qualify.

## Mandatory Rules (The "Golden Rules")

1. **Tests Required** — Every behavioral change MUST add or update automated tests. Logic in
   `site/src/lib/` and `site/src/i18n/` is covered by Vitest; `uploader/` logic by its own Vitest
   suites in `uploader/test/`. Run `npm test` and `npx astro check` before claiming done.
   Non-behavioral changes (docs, formatting) require proportionate evidence instead.
2. **SEO Slug Contract (Critical)** — Live WordPress slugs MUST be preserved exactly: DE at root,
   EN under `/en/`. Encoded and tested in `site/src/lib/paths.ts` and `trips.ts`, and mirrored by
   MDX filenames. **Never rename a slug or route** without explicit authorization — it breaks live
   URLs and SEO.
3. **Data Safety (Critical)** — Postgres is the content source of truth (`posts`, `pages`,
   `users`), and `/data` (bind-mounted from `uploader/data`) holds image originals/variants, site
   releases, and backups. NEVER wipe persistent data without explicit user authorization: no
   `docker volume rm` (`pgdata`), no `DROP DATABASE`/`TRUNCATE`, no deleting `uploader/data` as a
   shortcut. Propose targeted `UPDATE`/`DELETE` instead, and back up first.
4. **Branching Model** — `dev` (integration) and `main` (release) are both protected. Work on
   `feature/*` branches and merge via PR with green CI. Never push directly to either.
   See [Git Workflow](#git-workflow).
5. **No Binaries in Git** — Images and other binaries are gitignored. Hero images are hosted on the
   image server and referenced by URL in `heroImage` (see
   `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md`). Root
   screenshots/`.jpeg`/`.png` are ignored too.
6. **No Secrets** — Never commit `.env`, API keys, or credentials. Production secrets MUST come
   from a cryptographically secure generator, be independently rotatable, and never be logged.
7. **No Hardcoded UI Strings** — ALL user-facing copy lives in `site/src/i18n/ui.ts` for both
   locales (completeness-tested — this guards against the old site's German-in-English-footer bug).
8. **Strict Typing and Validation** — `tsconfig` extends `astro/tsconfigs/strict`. No `any`, no
   `@ts-ignore`, no `astro check` suppressions to force a pass. Fix the underlying type issue.
   Validate untrusted data at every boundary (Zod for content; explicit checks on uploader payloads).
9. **Ask Before Assuming** — Ask when ambiguity would materially change behavior, architecture,
   safety, data, cost, or external side effects — especially where a request conflicts with the
   specs in `docs/superpowers/`. Otherwise make a conservative, clearly stated assumption.
10. **No AI Issues** — Refuse to work on issues explicitly marked `NO AI`.
11. **No Disabled Guardrails** — Do not suppress tests, linters, type checks, authorization, or
    security controls to make an implementation pass. Fix the underlying problem.

## Change Risk and Required Rigor

Classify a change before implementing it:

- **Low risk:** Documentation, formatting, comments, or a behavior-preserving mechanical change.
- **Normal risk:** Ordinary features, bug fixes, refactors, dependency updates.
- **High risk (in this repo):** Anything touching authn/authz or sessions, the `images`-map and
  body-HTML render path, gallery URL allow-listing, `safeFetch`/WXR import, path-traversal guards,
  EXIF/GPS handling, the schema in `uploader/src/db.ts`, backup/restore, the build/publish
  pipeline, `/data` layout, or **any slug or route change**.

| Risk | Design and specification | Verification | Review and recovery |
| --- | --- | --- | --- |
| **Low** | A short intent statement | Focused checks | Normal PR review |
| **Normal** | Approach, acceptance criteria, edge cases | Affected Vitest suites + `astro check` | Normal PR review; rollback considered |
| **High** | Written spec in `docs/superpowers/specs/`, trust boundaries, misuse cases, explicit invariants | Full affected suite incl. integration tests, plus failure/recovery tests | Explicit human approval and a documented rollback or containment plan |

## Tech Stack and Conventions

| Layer | Technology |
|-------|-----------|
| **Framework** | Astro 7 (static output, `trailingSlash: 'always'`) |
| **Backend** | Node 26 + Fastify 5 + sharp (`uploader/`) |
| **Styling** | Tailwind 4 (via `@tailwindcss/vite`), `@tailwindcss/typography` |
| **Database** | Postgres 18 |
| **Content** | Postgres (loaded at build time by `site/src/lib/postgres-loader.ts`); authored in the in-admin editor — MDX files are export-only backups (the original stubs were imported once via `site/scripts/migrate-stub-posts.mjs`) |
| **i18n** | Astro i18n routing — `defaultLocale: 'de'` (no prefix), `en` under `/en/` |
| **Fonts** | Inter Variable (sans), IBM Plex Mono (expedition-log accents) |
| **Markdown** | Shiki syntax highlighting (`syntaxHighlight: { type: 'shiki', excludeLangs: ['math', 'gallery'] }`) — keep `site/astro.config.mjs` and `MARKDOWN_OPTIONS` in `site/src/lib/render-markdown.ts` in lockstep; `render-markdown.test.ts` asserts they agree |
| **Testing** | Vitest (both trees); `@astrojs/check` (`astro check`) for types |
| **Infrastructure** | Self-hosted Docker: one `app` image (repo-root `Dockerfile`) runs `uploader/` Fastify, which builds `site/` in-process and serves it — plus `db` (Postgres), via root `docker-compose.yml` |

### Design Tokens (`site/src/styles/global.css`, Tailwind 4 `@theme`)

- `--color-canvas: #fbfbfd` (page bg) · `--color-navy: #142a42` (brand/structure)
- `--color-ink: #16212e` (body text) · `--color-brand-red: #d23b30` (accent/CTA)
- `--color-brand-red-light: #ff5a4e` (accent on dark/photo backgrounds)
- `--font-sans: Inter Variable` · `--font-mono: IBM Plex Mono`

### Naming and Code Organization

- `camelCase` for TS variables/functions, `PascalCase` for types and Astro components.
- Filenames in `src/content/trips/{de,en}/` ARE the live WP slugs — match them exactly.
- Prefer named exports over default exports.
- Match the conventions of surrounding files.
- **Logical boundaries over line counts** — split at responsibility, dependency, or testing
  boundaries; never to satisfy an arbitrary line count, and never keep an oversized module with
  several independent reasons to change just to keep context together.
- **One primary component per file**; small private helpers MAY be colocated.

### Dependency Integrity

- Verify a package exists and is the intended one before installing (typosquatting).
- Both trees have committed `package-lock.json`; use `npm ci` in reproducible contexts and review
  lockfile diffs.
- Do not use `--force` / `--legacy-peer-deps` unless strictly necessary and explained.
- Review new dependencies for maintenance status, provenance, license, and transitive risk. This
  project deliberately runs a small dependency surface — prefer the platform (`node:crypto`,
  `node:fs`) over a package.

## Build and Development

Static-site commands run from `site/`. No containers are needed for the static toolchain itself.

```bash
npm install                         # install deps (Node >= 26)
npm run dev                         # dev server at http://localhost:4321
npm run build                       # build static site to ./dist/ (requires DATABASE_URL)
npm run preview                     # preview the production build
npm test                            # Vitest suites (i18n, paths, trips, format)
npx astro check                     # type-check .astro/.ts (requires DATABASE_URL — loader runs)
```

`uploader/` commands run from `uploader/`: `npm test` (Vitest) and `npx tsc --noEmit`.
Integration suites run only when `TEST_DATABASE_URL` is set — without it they silently skip, so a
green local run does **not** prove the Postgres-backed paths work. CI sets it.

> **Note:** `npm run build` and `npx astro check` both invoke the Postgres Content Layer loader,
> so a reachable Postgres instance with `DATABASE_URL` set is required. Unit tests (`npm test`)
> do not hit the database.

### Container Workflow (container-first, deployed stack)

The deployed stack is **container-first** on **Docker Hardened Images (DHI)**: one `app` container
(Fastify serves blog + admin + images and builds the site in-process) plus `db` (Postgres 18).
Compose only RUNS the published GHCR image — it does not build it.

```bash
docker compose pull && docker compose up -d   # run the released image (pin via IMAGE_TAG in .env)
docker compose logs -f                        # tail logs (both services log to stdout)
docker build .                                # rebuild the app image from the repo root (DHI bases)
```

Rebuilding or redeploying the image does not regenerate the blog's static output — that lives on
the `/data` volume and only changes via Publish, **Rebuild site now**, or `POST /rebuild`
(`docs/authoring-workflow.md`, Stage 3).

| Service | Port | Exposure |
| --- | --- | --- |
| `app` (Fastify: blog + admin + images) | `3000` | **Loopback** (`127.0.0.1:3000`) — the only published port; the host's reverse proxy is the sole ingress (#108) |
| `db` (Postgres 18) | `5432` | **Internal** — compose network only; never published to the host |
| Astro dev server | `4321` | **Loopback** — local development only |

## Accessibility and High-Impact Actions

- Target **WCAG 2.2 Level AA** for both the public blog and the admin UI.
- Use semantic elements, keyboard-operable controls, visible focus, sufficient contrast, accessible
  names, and reduced-motion support. The travel map is progressive enhancement — the text/link
  fallback MUST stay functional.
- Colour MUST NOT be the only signal. Media/post status badges pair colour with text.
- Destructive or irreversible admin actions (delete post, delete media, delete folder, bulk
  operations, restore) MUST show their scope and require confirmation. Reversibility, not blast
  radius, decides whether an action is admin-only — see `SECURITY.md`.

## Security, Privacy, and Robustness

Full security model: `SECURITY.md`. These patterns MUST be preserved when changing `uploader/`.

- **Security verification target:** **OWASP ASVS 5.0, Level 1.** L1 matches the risk profile
  (single admin, no third-party users, no payments, no customer PII). Raise to L2 if the app ever
  gains multi-tenant accounts or stores reader data.
- **RASP:** deliberately **not enabled**. In-process attack detection/blocking was considered and
  declined — it adds a dependency and runtime overhead to a single-container, single-admin
  deployment whose exposure is already narrowed by session auth, rate limiting, and one published
  port. Revisit only if the app gains untrusted users.

### 1. API and Configuration (secure by default)

- **Authentication** — All mutating uploader endpoints require a valid session (HttpOnly cookie;
  username/password accounts in Postgres). The only exceptions are `POST /login` and first-run
  `POST /setup` (guarded by a zero-users check, a setup lock, and the login rate limiter). Never
  infer safety from the HTTP method.
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
- **Configuration** — Do NOT grow `.env`. App settings live in a JSON settings store on the data
  volume (`uploader/src/settings.ts`, atomic-rename writes) managed via the admin Settings page;
  `.env` is reserved for bootstrap values (`DATABASE_URL`/`POSTGRES_PASSWORD`, `PUBLIC_BASE_URL` —
  see `uploader/.env.example`).

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

- The **only** AI feature is browser-direct alt-text suggestion against a local LM Studio vision
  model. The server never contacts the model. **Keep it that way** — do not proxy the model through
  the server or through `safeFetch`; doing so would create a new outbound-fetch surface.
- Treat model output as untrusted: it lands in an alt-text field, is validated like any other user
  input, and MUST NOT reach commands, queries, or authorization decisions.
- `GET /ai-config` is read-only and available to non-admin authors; write access to LM settings is
  admin-only.

### 5. Rules for AI Coding Assistants

These apply to YOU, the assistant, while working here:

- **OWASP Integration** — Develop with the **OWASP Top 10** in mind: SQLi, XSS, and SSRF are the
  live risks here (the WXR importer's remote fetches and the sanitized body-HTML render path).
- **Secret Protection** — Never log, print, or echo secrets/keys in responses or tool output. If
  editing a file with secrets, preserve them exactly.
- **Command Execution Safety** — Do NOT run blindly downloaded scripts (`curl ... | bash`) or
  unknown binaries without explicit permission.
- **System Isolation** — Confine file operations to this project and authorized worktrees. Do NOT
  read or modify system-sensitive dirs (`~/.ssh/`, `~/.aws/`, etc.).
- **No Hacky Workarounds** — Don't disable linters/type-checkers or add `any`/`@ts-ignore` to make
  a build pass. Fix the root cause.
- **No Unrequested Scope** — Do not expand scope or perform destructive/external side effects
  (pushing, publishing, posting, deploying) without authorization.

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

## AI Collaboration and Workflow

This repo uses the **superpowers** workflow: specs and phase plans live in `docs/superpowers/` and
are the source of truth for what's in scope. Read the relevant plan before implementing.

**Authoring a post?** See `docs/authoring-workflow.md` — how to upload photos via the uploader and
write/publish via the in-admin editor (Postgres is the source of truth; MDX files are export-only
backups).

### 1. Proportionate Design, Specification, and Review

- **Low-risk changes:** State intent and verify the focused result.
- **Normal changes:** Define approach, behavior, edge cases, error handling, and acceptance
  criteria before implementing. Critically review material assumptions.
- **High-risk changes:** Write the spec into `docs/superpowers/specs/` first, identify trust
  boundaries and misuse cases, define invariants and recovery, and self-review as a devil's
  advocate (logical gaps, untested assumptions, security flaws) before coding. Resolve findings or
  record explicitly accepted residual risk.

### 2. Contract-First Boundaries

Before implementing a new or changed boundary, define the contract first — the Zod content schema
(`site/src/content.config.ts`), table shapes in `uploader/src/db.ts`, and the TS types derived from
them — then code against those types. Specify limits, error shapes, and idempotency, and add tests
at the contract.

**@ai-warning** Some shapes are declared independently in both trees because they have separate
tsconfigs (`ImageMeta` in `uploader/src/body-content.ts` vs `ImageDims` in
`site/src/lib/body-images.ts`). Optional fields mean a one-sided widening keeps *both* `tsc` and
`astro check` green while galleries silently lose alt and captions. `uploader/test/body-content.test.ts`
pins them with a compile-time assertion — extend it rather than trusting the type-checker alone.

### 3. Contextual Markers

- `@ai-note` — a non-obvious invariant or business rule.
- `@ai-context` — points to a related spec or implementation entry point.
- `@ai-warning` — a dangerous side effect, compatibility constraint, or legacy trap.

Markers must explain **why** and point to durable evidence. Update or remove them when the code
changes; they do not substitute for tests, types, or specs.

### 4. Automated Verification Loop (after edits)

1. **Type-check:** `npx astro check` (site) · `npx tsc --noEmit` (uploader)
2. **Test:** `npm test` in whichever tree changed
3. For visual changes, run `npm run dev` and verify the rendered page.

Run the complete affected suite before opening or updating a PR. Remember that uploader integration
tests skip without `TEST_DATABASE_URL` — CI is the authoritative signal for Postgres-backed paths.

### 5. Verify Before Use (Prevent Hallucinations)

- **Dependencies and APIs** — Never assume a package is installed or a method exists. Check
  `site/package.json` / `uploader/package.json` and the actual exported API before calling.
- **Documentation lookup** — Fetch official/current docs for Astro 7, Tailwind 4, Fastify 5, etc.
  via a docs MCP (priority: **Ref** → DeepWiki → other) rather than relying on memory. Record the
  source and version when it affects a decision.
- **Internal functions** — Read the target file to confirm a helper's name, args, and return type
  before calling it (especially `paths.ts` / `trips.ts`).

## Git Workflow

- **Selected flow:** `feature/* → dev → main`.
  - **`dev`** is the **integration** branch and the repository default, so new PRs target it
    automatically. Day-to-day work lands here.
  - **`main`** is the **release** branch. It only ever advances by a release PR from `dev`, and
    version tags (`v*.*.*`) are cut from it.
- **Protected branches** — Both `dev` and `main` require a PR with passing CI (`site · tests +
  astro check` and `uploader · typecheck + tests`), and block force-pushes and deletion. Admin
  bypass is disabled, so this applies to the owner too. **Never push directly to `dev` or `main`**,
  including for merges. Zero approvals are required, so a solo maintainer can self-merge.
- **Feature development** — Branch off `dev` as `feature/<desc>`. For work needing isolation from
  the current workspace (or parallel agents), use a worktree:

  ```bash
  git fetch origin
  git worktree add ../<desc> -b feature/<desc> origin/dev
  ```

- **PR flow** — Open PRs into `dev` (the default base); required CI must pass before merge.
  High-risk changes require explicit human approval. AI review MAY supplement but never replaces a
  required human security decision.
- **Stacked PRs** — When one feature builds on another, base the child PR on the parent branch, and
  **retarget every child to `dev` before merging** — otherwise only the bottom PR closes as merged
  and the rest are left open against branches that never advance.
- **Cleanup** — Only after the PR is merged and the changes are safe on the remote:

  ```bash
  git worktree remove ../<desc>
  git branch -d feature/<desc>
  ```

- **Commits** — Conventional style: `type(scope): description` (e.g. `feat(home): add route divider`).
- **Pushing** — Commits are local by default; the user pushes manually unless they ask otherwise.
- **Issues** — Use `Closes #<issue>` when a corresponding issue exists; never invent one.
- **Releases** — Open a release PR `dev → main`, let CI run, and merge it; then tag `v*.*.*` on
  `main`. `.github/workflows/release.yml` builds and publishes the GHCR app image and cuts a GitHub
  Release. Deploy by bumping `IMAGE_TAG` in the server's `.env`. Never fast-forward `main` by
  pushing to it — that would require disabling its protection.
- **No binaries / no secrets** — see Golden Rules 5 and 6.

## Definition of Done

A change is done only when:

- Acceptance criteria and documented invariants are satisfied.
- `astro check` / `tsc --noEmit` and the affected Vitest suites pass, and CI is green.
- Behavioral changes have regression coverage; critical failure paths are tested.
- Security, privacy, accessibility, and operational effects were considered in proportion to risk.
- Affected docs are updated — `SECURITY.md` for security-model changes, `ARCHITECTURE.md` for
  structural ones, the relevant spec in `docs/superpowers/`, and this file when a rule changes.
- High-risk changes have explicit human approval and a credible rollback plan.
- No unresolved placeholders, secrets, temporary bypasses, or unexplained warnings remain.

## Repository Structure

```
blog/
├── CLAUDE.md                       # this file
├── Dockerfile                      # single multistage image (uploader + site trees, DHI runtime); repo-root context
├── docker-compose.yml              # app + db (WordPress-style, two services)
├── .github/workflows/ci.yml        # every PR + push to dev/main: typecheck + tests (both apps) + astro check/build, vs a Postgres service
├── .github/workflows/release.yml   # tag v*.*.* → build & push GHCR image + GitHub Release
├── docs/superpowers/              # design specs + phase plans (source of truth for scope)
├── *.md                           # blog platform research (WordPress vs Astro, etc.)
├── site/                          # the Astro project (static blog; built in-process by uploader/src/build.ts)
│   ├── scripts/migrate-stub-posts.mjs  # one-off: import MDX stubs into Postgres
│   └── src/
│       ├── content/trips/{de,en}/<slug>.mdx   # MDX source files (authoring reference; content served from Postgres)
│       ├── content.config.ts                   # Zod schema for trips (unchanged from MDX era)
│       ├── i18n/ui.ts                          # ALL UI strings, both locales (completeness-tested)
│       ├── lib/                                # tested helpers: paths, trips, format, images, map data
│       │   ├── postgres-loader.ts              #   Astro Content Layer loader — syncs trips from Postgres at build time
│       │   ├── body-images.ts                  #   transforms Markdown body: <BodyImage> → <picture>, ```gallery → gallery
│       │   ├── gallery-layout.ts               #   justified-row partition + #layout: directive reader (pure; also runs under tsx)
│       │   └── map-data.ts                     #   export tripPins() and tripGeometry() for map layers
│       ├── components/pages/                   # shared per-page components
│       ├── pages/                              # thin locale routes (de at root, en under /en/)
│       ├── scripts/travel-map.ts               #   MapLibre GL island; initializes full map and mini-maps
│       ├── scripts/gallery-lightbox.ts         #   <dialog> lightbox + slider controls; loaded via GalleryIsland.astro
│       └── layouts/  ·  styles/  ·  assets/
└── uploader/                      # self-hosted app: CMS + image service + blog serving (Node/Fastify/sharp)
    ├── src/                       #   variants · pipeline · storage · db · users · sessions · authn · server · main · cli · settings · posts · pages · body-content · build · backup · export · preview · wxr-parse · wp-content · wp-images · wp-import
    │                              #   media-files (disk) · media-store (database) · media-sync (reconcile) · encode-queue · work-lock · disk · exif
    ├── public/                    #   index.html (hero upload) · import.html (WordPress import) · editor/posts/about/settings/users
    │                              #   media.html + media-api/media-browser/media-picker.js · posts-filter.js · posts-duplicate.js
    ├── test/                      #   Vitest suites (integration suites run when TEST_DATABASE_URL is set)
    └── .env.example · README.md
```

## Project Status and Remaining Phases

- **Done:** Phase 1 (skeleton) + Phase 1b (expedition-log layer) — merged to `main`.
- **Done:** Phase A (Postgres CMS foundation) — Postgres Content Layer loader, body-image pipeline,
  runtime `blog-builder` service, compose/volume wiring — merged to `main`.
- **Done:** Phase B (in-admin editor) — DE/EN tabbed editor (EasyMDE), slug-lock, inline photo
  upload, Save draft, Publish (triggers rebuild), Export all (MDX backups to `/data/backup`).
- **Done:** Phase 2 (WordPress import) — in-admin WXR importer; upload WP export → draft posts
  created with slugs preserved and images re-hosted.
- **Done:** Phase 3 (MapLibre travel map) — map page (`/karte/` + `/en/map/`) plotting all trips as
  pins with popups; homepage `MapTeaser` wired to the map; per-story lazy mini-maps (pin + stops);
  self-hosted PMTiles basemap (zero third-party requests), served at `/map/` by the app;
  progressive enhancement with text/link fallback.
- **Done:** Security hardening — auth rate-limiting, admin-only publish, SSRF/timeout/size-cap on
  remote fetches, path-traversal guards, body-HTML sanitization, security headers. See `SECURITY.md`.
- **Done:** Single-app-container merge + DB backup — collapsed the 4-container stack (nginx /
  blog-builder / uploader / db) into 2 services (`app` / `db`); the `app` container serves the blog,
  admin, and images from one process and runs `astro build` in-process; added a scheduled/on-demand,
  retention-pruned Postgres backup feature (CLI-only restore). See `ARCHITECTURE.md` and
  `docs/superpowers/specs/2026-07-03-single-app-container-design.md`.
- **Done:** Editable About page + baked-in travel map basemap (v0.5.0).
- **Done:** AI feature removal + conformance hardening (July 2026) — removed the LM Studio
  caption/batch-uploader feature entirely; settings endpoints became admin-only; a global error
  handler logs unexpected errors server-side and returns sanitized 500s; PR CI added.
- **Done:** AI alt-text restored (2026-07-05) — editor-integrated "Suggest alt text" buttons
  (DE/EN hero + body) + photo uploader, browser-direct to local LM Studio; LM config in the JSON
  settings store; read-only `GET /ai-config` for non-admin authors. See
  `docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md`.
- **Done:** Stack upgrade (July 2026) — Node 22 → 26 (DHI images, engines, CI), Postgres 17 → 18,
  Astro 6 → 7 (+ `@astrojs/mdx` 7; `compressHTML: 'true'` kept for v6 whitespace behavior), Fastify
  plugins (`multipart` 10, `static` 9.1.3 — security fix), sharp 0.35, TypeScript 6 + Vitest 4 in
  both apps; CI now also runs the full `astro build`.
- **Done:** Phase 0 of the media-library work (2026-07-26) — published image variants now carry an
  EXIF allow-list instead of full metadata (no GPS/XMP/IPTC), `POST /upload` rejects multi-file
  requests with 413 instead of silently dropping files, an explicit `requestTimeout` is set, and a
  new `audit-exif` CLI subcommand reports the stored corpus's actual EXIF/GPS exposure (found 102
  variants with EXIF, zero with GPS). A `strip-gps` remediation subcommand was deliberately **not**
  built, and its trigger never fired. The "server corpus unaudited" caveat was retired 2026-07-29
  (#68 closed as obsolete): there is no production deployment, and the WXR importer re-hosts via
  `processImage`, so imported photos clear `allowedExif()` at encode time — the allow-list is
  **upstream** of the importer. The 2026-07-29 WXR import then re-hosted 665 photos from other
  devices/years through it. See
  `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md`.
- **Done:** Backend rework, epic #69 (2026-07-28) — four approved issues, landed as PRs #76–#79:
  - **#65 galleries** — a fenced ```gallery block rendered as a photo grid, with per-line
    `| WxH | alt="…" | caption="…"` metadata lifted into the `images` map on save and re-attached by
    the MDX exporter. Gallery URLs are allow-listed by **origin equality** (never a prefix match)
    because the markup is injected *after* `rehype-sanitize`; the `images` map is validated at the
    `posts.ts`/`pages.ts` store chokepoint rather than in `validateDraft`, since the WXR importer
    bypasses the latter.
  - **#63 posts list** — hero thumbnails, client-side search/filter/sort (extracted to
    `public/posts-filter.js` so it is testable), and `POST /posts/bulk` with one rebuild per batch
    and per-post failure reporting. Also fixed a live bug: `pgPostStore` formatted the `date` column
    with `toISOString()`, walking a post's trip date back a day per re-save on any host east of UTC.
  - **#64 + #73 media library** — `media`/`media_folders` tables, virtual folders, bulk
    drag-and-drop upload with an **async encode queue** (concurrency 2), a shared build/encode mutex
    (`work-lock.ts`) where a build preempts the encode backlog, a publish gate that refuses while a
    referenced photo is not `ready`, disk↔database reconciliation, backup dump **v3**, `GET /media`
    at session level **with GPS/uploader redaction for non-admins**, a `/data` free-space
    precondition (507) and `mem_limit`/`memswap_limit` on the app container.
  - **#70 duplicate post** — "New from this one": structure copies, identity resets, slugs asked for
    up front. Zero server change.
  - **Review fixes** — nine findings from the PR re-review: the gallery fence normalizer became a
    line scanner (the old regex rewrote a nested ```gallery example and missed CommonMark's
    longer-closing-fence rule), the media-sync missing-file sweep now paginates past the 200-row
    page cap, `mediaSync.run()` is sequenced before `encodeQueue.recover()`, `POST /media/retry`
    rolls back its status flip on a failed enqueue, `memoryMediaStore.upsert` mirrors the pg
    `ON CONFLICT` clause, and `duplicatePayload` deep-copies the structures it carries.
- **Done:** #75 gallery picker (2026-07-28) — "Insert / edit gallery" on both locale tabs of the
  editor opens the media library in multi-select mode with an ordering strip, and writes the same
  ```gallery text an author would type by hand (no server change; `normalizeGalleryFences` still
  lifts the metadata at the store chokepoint). Two invariants carry the weight, both with
  `@ai-warning`s and tests: the picker seeds its selection from the POST, not from whichever library
  page is loaded, or editing an older post's gallery silently drops the photos the library never
  paged into view; and `public/gallery-fence.js`'s fence scanner must agree with `rewriteFences` in
  `src/body-content.ts` about what a gallery is and where it ends — `test/gallery-fence-parity.test.ts`
  runs both over one corpus, and is the only thing keeping the duplicated rule honest.
- **Done:** #66 gallery polish (2026-07-29) — three layout modes selected by a `#layout:` line
  **inside** the fence (an info-string argument on the opener is unimplementable: the info string
  is discarded before `body-images.ts` ever sees it), plus a `<dialog>` lightbox on all three.
  `site/src/lib/gallery-layout.ts` holds the justified-row partition and the directive reader,
  pure and `astro:`-free because draft preview runs it under `tsx`. An unknown or missing mode
  falls back to `breakout`, so pre-#66 galleries render unchanged. The last row is capped at the
  height of the row **above** it, emitted as a container percentage — a fixed-pixel cap computed
  at the design width left the remainder 450px tall beside 210px rows on a tablet. The mode is
  chosen in #75's picker (`layouts`/`layout` options; `GalleryFence.layoutOf`/`withLayout`), whose
  directive round-trip is the risk the #66 review named and is now tested against the renderer's
  own reader. `preview.test.ts`'s CSS parity guard was **strengthened**, not weakened: it now
  scrapes selectors nested inside `@container` blocks too, where the new breakpoints live.
  Lightbox CSS lives with its island rather than in `global.css`, so it is not dead CSS
  hand-mirrored into `preview.ts` — the lightbox does not run in draft preview at all.
- **Done:** WordPress content import (2026-07-29) — the real WXR export imported: 9 DE/EN pairs,
  **665 photos re-hosted**, all under their live WordPress slugs. Required fixing the importer,
  which silently dropped every gallery: Elementor renders galleries as bare `<a href>` anchors with
  no usable `<img>`, so Turndown produced empty `[](url)` links that the re-host pass never matched.
  `wp-content.ts` now folds Elementor slideshows into ```gallery fences using the widget's own
  `data-elementor-lightbox-slideshow` (grouping) and `-title` (alt), and re-hosts once per
  translation pair. Ten published stub posts were deleted first — eight were fictional placeholders
  with no WordPress counterpart, and two carried **wrong EN slugs** (`4-days-in-bucharest`,
  `sun-and-adventure-rhodes`) that violated the SEO slug contract; the import restored the real
  ones. Imported posts are drafts with placeholder `country`/`region`/`coordinates` that
  `validateForPublish` rejects until an author completes them.
- **Done:** #87 fix — `country` and `keyFacts` moved from `PostShared` to `PostLocale`
  (2026-07-30). Both were app-layer fields shared across the DE/EN pair even though the `posts`
  table already stores them per row, so `upsertDraft`'s two `writeLocale` calls always wrote
  whichever locale saved last into both rows, and `get()` read the DE row's values back for both —
  the English page silently showed the German country name after any save. `stops[].name` stays
  shared for now: unlike `country`/`keyFacts`, it mixes geographic (non-prose) lat/lng with a
  translatable name in one array, and a correct per-locale split needs either duplicated
  coordinates (drift risk) or index-parallel per-locale name arrays (desync risk on reorder) — a
  bigger design decision than this fix, left for a follow-up if it's ever prioritized. The
  `posts` table and the Astro loader (`postgres-loader.ts`) were already per-row/per-locale;
  only the uploader's `PostShared`/`PostLocale` split, the editor UI, MDX export, and the WXR
  importer's placeholder needed to change.
- **Done:** #85 WXR importer hardening (2026-07-30) — the importer survives a real export.
  Four decorators around the existing `rehost` seam, in a load-bearing order pinned by tests:
  `sharedRehost( resume+tally( retry( pace( rehostImage ) ) ) )`. Retry and pacing MUST stay below
  `sharedRehost`, which memoises **rejected** promises. Pacing is an **elapsed gate**, so a
  fetch+encode that already outlasted the delay pays nothing. Retry covers only transient
  `FetchError`s, classified off new additive `kind`/`status`/`code` tags rather than message text —
  never a `sharp` decode or an `ENOSPC`, and never `ENOTFOUND`.
  **Resumability is derived from disk, with no state file**: the importer's keys are deterministic
  and un-hashed (every other write path appends `-<hash8>` via `contentHashKey`), so
  `/data/images` *is* the record and `walkStorageKeys` already indexes it. Fail-closed on a partial
  variant set; the hero slot is never resumed because its key encodes no URL identity. Blast radius
  is bounded by `retryBudget` (retries only, so a large export still works), a per-host
  consecutive-failure breaker, and a single-flight 409 on `POST /import` — needed because "run it
  again" is now the documented recovery path. Warnings come from one place instead of three, carry a
  stable reason instead of the raw undici message (which leaked an RFC1918 oracle to non-admin
  authors), and are capped. See
  `docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md` and `SECURITY.md`.
- **Done:** #96 per-import cap on distinct images (2026-08-25) — bounds the first-attempt
  amplification that #85 deliberately did not claim to cover. The re-host cache is scoped per
  translation pair, so one attachment URL referenced from N groups is fetched N times, and a 25 MiB
  export can reach roughly 40,400 fetches of one third-party URL that **keeps answering** (the
  per-host breaker cuts that to ~20 only when the target is *failing*). `importWxr` now counts the
  distinct (pair, url) re-host operations BEFORE fetching anything and, if the total exceeds
  `maxImages` (default 20,000), throws `ImportTooLargeError` — no work performed, no partial state;
  the `/import` route maps it to a 400 naming the count. 20,000 sits well above a legitimate export
  (the real one was 665 photos) and well below the attack. See `SECURITY.md` (SSRF section).
- **Done:** #100 honest post-tier counters in `ImportSummary` (2026-08-25) — the old single
  `skipped` conflated four unrelated outcomes, so a re-run of an already-published export read
  the same as an export rejected at the import boundary. The summary now names each bucket —
  `imported`, `updated`, `skippedPublished`, `rejected` (a missing translation or an unsafe
  slug, i.e. the path-traversal defence firing), `failed` (a thrown `upsertDraft`) — and every
  group lands in exactly one, so the buckets sum to the group count. `POST /import` 400s only
  when the export yields no groups at all: an all-published re-run is a 200 with
  `skippedPublished`, and `import.html` shows each bucket by name with a dedicated callout for
  `rejected` — the same treatment #85 gave un-hosted photos.
- **Remaining:** Phase 4 = DNS cutover. See `docs/superpowers/plans/` for phase details. Not
  started, deliberately: #67 (AI authoring — design spec landed 2026-07-28, implementation not
  started), #72 (Traefik timeouts). #68 (production EXIF audit) was **closed as obsolete**
  2026-07-29. See `docs/superpowers/plans/IMPLEMENTATION-PROMPT.md` for why each is excluded.
- **Filed out of #85 and deliberately excluded from it** (each with its reason in the §Scope table of
  `docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md`):
  - **#91 publish gate rejects leftover `wp-content` URLs** — *the one that matters most.* A partial
    import is now **visible** but still **publishable**: `validateForPublish` checks only the hero
    `src`, and `notReadyPhotos` reports clean because `srcToKey` returns `null` for a foreign origin.
    Body images hot-link the old WordPress domain and gallery photos vanish at render — and after
    Phase 4's DNS cutover both 404.
  - **#92 move the import off the request path** onto `encode-queue.ts`/`work-lock.ts` with a progress
    endpoint (#85's "Better" option). Progress state that survives a restart likely means a new table,
    so it is a schema change and high-risk in its own right.
  - **#93 `safeFetch` re-asserts on redirect hops** (`redirect: 'manual'`). Declined in #90 because WP
    media URLs legitimately redirect. See `SECURITY.md` — retry widened this per-URL window.
  - **#94 `/data` free-space precondition on `/import`** (`/upload` has one; an import writes ~11 GB).
  - **#95 import encodes take `work-lock`**, so sharp cannot run beside `astro build`.
  - **#97 `/import` → `requireAdmin`** (every comparable surface already is).
  - **#98 `nameFromUrl` non-injectivity** — `foo.jpg`/`foo.png` collide on one key. Any fix must keep
    keys deterministic; #85's disk-derived resume depends on that.
  - **#99 `bySlug` flattens DE and EN slugs** — a group can bind to the wrong `translationKey` and
    `upsertDraft` then overwrites the wrong post. Touches Golden Rule 2.

Architecture overview: `ARCHITECTURE.md` · security model: `SECURITY.md` · top-level guide: `README.md`.
