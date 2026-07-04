# CLAUDE.md

Guidance for AI coding assistants (Claude, Gemini, Codex) working in this repository.
Derived from `../TEMPLATE.md` and kept in sync with it, tailored to this project. This repo is a
**monorepo** with two parts: `site/` is an Astro 6 **static site** — it builds to a static
`dist/` (content is loaded from Postgres at build time), so the template's auth/RBAC, SRE, and
container rules do not apply to it directly; `uploader/` is a small self-hosted **Node/Fastify +
sharp app** (CMS + image service + blog serving) where Docker, a server runtime, and the
Security/Operations sections below DO apply. The static-site rules describe `site/` unless a
rule names `uploader/` explicitly.

## Project Overview

**Simon's Wanderlust** (`simonswanderlust.com`) — a bilingual (DE/EN) personal travel blog.
This repo is the **Astro 6 static-site rebuild** of the current WordPress + Elementor site.

**Architecture:** The blog is a single Astro 6 project under `site/`. It is **self-hosted via
Docker** as a **single `app` container** (WordPress-style) alongside Postgres, wired in the root
`docker-compose.yml` — the uploader (Node 22 + Fastify 5 + sharp) serves the blog itself, in
addition to being the admin CMS + image service. UI is Astro components + Tailwind 4.

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
`/data/backup` via **Export all**, and the database itself (`users` + `posts`) can be backed up on
a schedule to `/data/backup/db` (admin settings page; restore is CLI-only — see `ARCHITECTURE.md`).
Required env var for the app: **`DATABASE_URL`** (see `uploader/.env.example`). Consequence:
`npx astro check` and `npm run build` both require a reachable Postgres.

The same **`uploader/`** app (Node 22 + Fastify 5 + sharp, Dockerized) also optimizes uploaded
photos into responsive AVIF/WebP variants and returns paste-ready `heroImage` / `<RemoteImage>` /
`<BodyImage>` snippets. Access is gated by username/password accounts stored in Postgres, with
HttpOnly session cookies. Everything runs on Simon's own server, in one container. **This project
does not use LM Studio or any AI features** — the former AI caption/batch-uploader feature was
removed in July 2026 (the 2026-06-22 spec is historical). See `uploader/README.md`,
`ARCHITECTURE.md`, and the specs
`docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md` +
`docs/superpowers/specs/2026-07-03-single-app-container-design.md`.

**Design language:** Editorial magazine + "refined brand" voice, with an "Expedition Log"
flavor layer (mono coordinates from frontmatter, N°XX entry numbers, contour textures,
arrival stamps, dashed route dividers). See `docs/superpowers/specs/2026-06-11-blog-redesign-design.md`.
(This replaces the template's "Glass & Bento" house style.)

## Mandatory Rules (The "Golden Rules")

1.  **Tests Required** — Logic in `site/src/lib/` and `site/src/i18n/` is covered by Vitest;
    add/extend tests for any change there. `uploader/` logic is covered by its own Vitest suites
    in `uploader/test/`. Run `npm test` and `npx astro check` before claiming done.
2.  **SEO Slug Contract (Critical)** — Live WordPress slugs MUST be preserved exactly:
    DE at root, EN under `/en/`. This is encoded and tested in `site/src/lib/paths.ts` and
    `trips.ts`, and mirrored by MDX filenames. **Never rename a slug or route** without
    explicit authorization — it breaks live URLs and SEO.
3.  **Data Safety (Critical)** — Postgres is the content source of truth (`posts`, `pages`,
    `users`), and `/data` (bind-mounted from `uploader/data`) holds image originals/variants,
    site releases, and backups. NEVER wipe persistent data without explicit user authorization:
    no `docker volume rm` (`pgdata`), no `DROP DATABASE`/`TRUNCATE`, no deleting `uploader/data`
    as a shortcut. Propose targeted `UPDATE`/`DELETE` instead, and back up first.
4.  **No Binaries in Git** — Images and other binaries are gitignored. Hero images are hosted on the image server and referenced by URL in `heroImage` (see `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md`). Root screenshots/`.jpeg`/`.png` are ignored too.
5.  **No Secrets** — Never commit `.env`, API keys, or credentials.
6.  **No Hardcoded UI Strings** — ALL user-facing copy lives in `site/src/i18n/ui.ts` for both
    locales (completeness-tested — this guards against the old site's German-in-English-footer bug).
7.  **Strict Typing** — `tsconfig` extends `astro/tsconfigs/strict`. No `any`, no `@ts-ignore`,
    no `astro check` suppressions to force a pass. Fix the underlying type issue. Enforce
    validation at input boundaries (Zod for content; validate uploader request payloads).
8.  **Ask Before Assuming** — If a request is ambiguous or conflicts with the design spec/plans
    in `docs/superpowers/`, ask first.
9.  **No AI Issues** — Refuse to work on issues explicitly marked `NO AI`.

## Tech Stack & Conventions

| Layer | Technology |
|-------|-----------|
| **Framework** | Astro 6 (static output, `trailingSlash: 'always'`) |
| **Styling** | Tailwind 4 (via `@tailwindcss/vite`), `@tailwindcss/typography` |
| **Content** | Postgres (loaded at build time by `site/src/lib/postgres-loader.ts`); MDX files remain the authoring source and are migrated into Postgres via `site/scripts/migrate-stub-posts.mjs` |
| **i18n** | Astro i18n routing — `defaultLocale: 'de'` (no prefix), `en` under `/en/` |
| **Fonts** | Inter Variable (sans), IBM Plex Mono (expedition-log accents) |
| **Tests** | Vitest |
| **Type-check** | `@astrojs/check` (`astro check`) |
| **Deploy target** | Self-hosted Docker: one `app` image (repo-root `Dockerfile`) runs `uploader/` Fastify, which builds `site/` in-process and serves it — plus `db` (Postgres), via root `docker-compose.yml` |

### Design Tokens (`site/src/styles/global.css`, Tailwind 4 `@theme`)
- `--color-canvas: #fbfbfd` (page bg) · `--color-navy: #142a42` (brand/structure)
- `--color-ink: #16212e` (body text) · `--color-brand-red: #d23b30` (accent/CTA)
- `--color-brand-red-light: #ff5a4e` (accent on dark/photo backgrounds)
- `--font-sans: Inter Variable` · `--font-mono: IBM Plex Mono`

### Naming Conventions
- `camelCase` for TS variables/functions, `PascalCase` for types and Astro components.
- Filenames in `src/content/trips/{de,en}/` ARE the live WP slugs — match them exactly.
- Prefer named exports over default exports.
- Match the conventions of surrounding files.

## Build & Development

All static-site commands run from `site/`. No containers needed for the static toolchain itself.

```bash
npm install                         # install deps (Node >= 22.12)
npm run dev                         # dev server at http://localhost:4321
npm run build                       # build static site to ./dist/ (requires DATABASE_URL)
npm run preview                     # preview the production build
npm test                            # Vitest suites (i18n, paths, trips, format)
npx astro check                     # type-check .astro/.ts (requires DATABASE_URL — loader runs)
```

> **Note:** `npm run build` and `npx astro check` both invoke the Postgres Content Layer loader,
> so a reachable Postgres instance with `DATABASE_URL` set is required. Unit tests (`npm test`)
> do not hit the database.

### Container Workflow (Container-First, deployed stack)

The deployed stack is **container-first** on **Docker Hardened Images (DHI)**: one `app`
container (Fastify serves blog + admin + images and builds the site in-process) plus `db`
(Postgres 17). Compose only RUNS the published GHCR image — it does not build it.

```bash
docker compose pull && docker compose up -d   # run the released image (pin via IMAGE_TAG in .env)
docker compose logs -f                        # tail logs (both services log to stdout)
docker build .                                # rebuild the app image from the repo root (DHI bases)
```

**Ports:** app `3000` (the only published port) · Astro dev server `4321` · Postgres `5432`
(compose-internal only — never published to the host).

## Repository Structure

```
blog/
├── CLAUDE.md                       # this file
├── Dockerfile                      # single multistage image (uploader + site trees, DHI runtime); repo-root context
├── docker-compose.yml              # app + db (WordPress-style, two services)
├── .github/workflows/ci.yml        # PR/push: typecheck + tests (both apps) + astro check, vs a Postgres service
├── .github/workflows/release.yml   # tag v*.*.* → build & push GHCR image + GitHub Release
├── docs/superpowers/              # design spec + phase plans (source of truth for scope)
├── *.md                           # blog platform research (WordPress vs Astro, etc.)
├── site/                          # the Astro project (static blog; built in-process by uploader/src/build.ts)
│   ├── scripts/migrate-stub-posts.mjs  # one-off: import MDX stubs into Postgres
│   └── src/
│       ├── content/trips/{de,en}/<slug>.mdx   # MDX source files (authoring reference; content served from Postgres)
│       ├── content.config.ts                   # Zod schema for trips (unchanged from MDX era)
│       ├── i18n/ui.ts                          # ALL UI strings, both locales (completeness-tested)
│       ├── lib/                                # tested helpers: paths, trips, format, images, map data
│       │   ├── postgres-loader.ts              #   Astro Content Layer loader — syncs trips from Postgres at build time
│       │   ├── body-images.ts                  #   transforms Markdown body: renders <BodyImage> as responsive <picture>
│       │   └── map-data.ts                     #   export tripPins() and tripGeometry() for map layers
│       ├── components/pages/                   # shared per-page components
│       ├── pages/                              # thin locale routes (de at root, en under /en/)
│       ├── scripts/travel-map.ts               #   MapLibre GL island; initializes full map and mini-maps
│       └── layouts/  ·  styles/  ·  assets/
└── uploader/                      # self-hosted app: CMS + image service + blog serving (Node/Fastify/sharp)
    ├── src/                       #   variants · pipeline · storage · db · users · sessions · authn · server · main · cli · settings · posts · build · backup · export · wxr-parse · wp-content · wp-images · wp-import
    ├── public/                    #   index.html (hero upload) · import.html (WordPress import) · editor/posts/about/settings/users
    ├── test/                      #   Vitest suites (integration suites run when TEST_DATABASE_URL is set)
    └── .env.example · README.md
```

- **Logical boundaries over line counts** — keep cohesive logic together; don't fragment files.
- **One primary component per file** for components.

## Security & Robustness Patterns

Full security model: `SECURITY.md`. These patterns MUST be preserved when changing `uploader/`.

### 1. API & Configuration (Secure by Default)
- **Authentication** — All mutating uploader endpoints require a valid session (HttpOnly cookie;
  username/password accounts in Postgres); the only exceptions are `POST /login` and first-run
  `POST /setup` (guarded by a zero-users check, a setup lock, and the login rate limiter).
  Publish, rebuild, page edits, settings, backups, and user management are **admin-only**.
  Auth endpoints are rate-limited.
- **Infrastructure Isolation** — Only the app's port `3000` is published; Postgres is reachable
  solely on the compose-internal network.
- **Hardened Remote Fetches** — WP-import fetches go through `safeFetch` (SSRF guard, timeout,
  streamed size cap). File access goes through path-traversal guards. Keep these intact when
  touching that code.
- **Configuration Management** — Do NOT grow `.env`. App settings live in a JSON settings store
  on the data volume (`uploader/src/settings.ts`, atomic-rename writes) and are managed via the
  admin Settings page; `.env` is reserved for bootstrap values
  (`DATABASE_URL`/`POSTGRES_PASSWORD`, `PUBLIC_BASE_URL` — see `uploader/.env.example`).

### 2. Framework & Output Safety
- Treat every Fastify route as a public HTTP endpoint: authenticate/authorize *inside* the
  handler chain and validate input payloads immediately.
- Post body HTML is sanitized before rendering. Anything injected via `set:html` in `site/`
  must be escaped/sanitized — XSS applies even to a static site.
- Never return raw database errors to clients — log the detail server-side and return a
  sanitized message.

### 3. AI Assistant Security Guidelines
These apply to YOU, the assistant, while working here:
- **OWASP Integration** — Actively develop with the **OWASP Top 10** in mind: defend against
  SQLi, XSS, and SSRF (most relevant here: the WXR importer's remote fetches and the sanitized
  body-HTML render path). The project deliberately contains no AI/LLM features.
- **Secret Protection** — Never log, print, or echo secrets/keys in responses or tool output.
  If editing a file with secrets, preserve them exactly.
- **Command Execution Safety** — Do NOT run blindly downloaded scripts (`curl ... | bash`) or
  unknown binaries without explicit permission.
- **Dependency Integrity** — Verify package names before `npm install` (typosquatting). Do not
  use `--force`/`--legacy-peer-deps` unless strictly necessary and explained.
- **System Isolation** — Confine file operations to this project. Do NOT read or modify
  system-sensitive dirs (`~/.ssh/`, `~/.aws/`, etc.).
- **No Hacky Workarounds** — Don't disable linters/type-checkers or add `any`/`@ts-ignore` to
  make a build pass. Fix the root cause.

## Runtime & Operations (`app` container)

Tailored from the template's SRE section — applies to the `uploader/` runtime; `site/` is static
output and exempt.

- **State in backing services** — Durable data lives in Postgres or under `/data` (releases,
  images, backups), never only in process memory or the container filesystem.
- **Logs as event streams** — Log to `stdout`/`stderr` only (Docker captures them); no log files.
- **Health & resilience** — The app exposes `/health` (used by the compose healthcheck);
  `restart: unless-stopped` covers crashes. Degrade gracefully when an optional dependency is
  down — never crash the app over one.
- **Schema changes** — `uploader/src/db.ts` owns the schema via idempotent
  `CREATE TABLE IF NOT EXISTS` bootstrap; evolve it there (additive, idempotent). No hand-run
  SQL against the live DB.
- **CI/CD & immutable artifacts** — `.github/workflows/ci.yml` runs the Automated Verification
  Loop (typecheck + tests for both apps + `astro check`, against a Postgres service container)
  on every PR and push to `main`. `.github/workflows/release.yml` builds the app image ONCE
  per version tag (`v*.*.*`) and pushes it to GHCR; deploys promote that immutable image by
  bumping `IMAGE_TAG` in `.env` — never rebuild on the server.
- **Backups** — Postgres backups run scheduled/on-demand to `/data/backup/db` with retention
  pruning (admin Settings page); restore is CLI-only — see `ARCHITECTURE.md`.

## AI Collaboration & Workflow

This repo uses the **superpowers** workflow: specs and phase plans live in
`docs/superpowers/` and are the source of truth for what's in scope. Read the relevant
plan before implementing.

**Authoring a post?** See `docs/authoring-workflow.md` — how to upload photos via the
uploader and write/publish via the in-admin editor (Postgres is the source of truth; MDX files
are export-only backups).

### Design → Spec → Review (non-trivial features)
For non-trivial work, follow the superpowers pipeline before coding: brainstorm/design the
approach, write the spec/plan into `docs/superpowers/`, and critically self-review both
(play devil's advocate for logical gaps, untested assumptions, and security flaws) before
implementation begins.

### Contract-First
Before implementing logic, define or extend the data contracts first — the Zod content schema
(`site/src/content.config.ts`), table shapes in `uploader/src/db.ts`, and the TS types derived
from them — then code against those types. This prevents hallucinated property names later.

### Verify Before Use (Prevent Hallucinations)
- **Dependencies & APIs** — Never assume a package is installed or that a method exists. Check
  `site/package.json` / `uploader/package.json` and the actual exported API (local types/source)
  before calling.
- **Documentation Lookup** — Fetch official/current docs for Astro 6, Tailwind 4, Fastify 5,
  etc. via a docs MCP (priority: Ref → DeepWiki → other) rather than relying on memory.
- **Internal Functions** — Read the target file to confirm a helper's name, args, and return
  type before calling it (especially `paths.ts` / `trips.ts`).

### Automated Verification Loop (after edits)
1. **Type-check:** `npx astro check`
2. **Test:** `npm test` (in `site/` and/or `uploader/`, whichever changed)
3. For visual changes, run `npm run dev` and verify the rendered page.

### Contextual Markers
Use comments to leave hints for future sessions:
- `@ai-note` — a non-obvious business rule (e.g. why a slug is shaped a certain way).
- `@ai-context` — points to a related file or the design spec/plan.
- `@ai-warning` — a side-effect or legacy trap (e.g. the SEO slug contract).

## Git Workflow

- **Branching** — `main` is the integration branch. Branch off `main` as
  `feature/<desc>` for non-trivial work; merge back when reviewed and tests pass.
  Avoid committing directly to `main` for substantial changes.
- **Worktrees** — For feature work that needs isolation from the current workspace (or parallel
  agents), check the branch out into a separate worktree
  (`git worktree add ../<desc> -b feature/<desc>`) and remove it after the merge.
- **Commits** — Conventional style: `type(scope): description` (e.g. `feat(home): add route divider`).
- **Pushing** — Commits are local by default; the user pushes manually unless they ask otherwise.
- **Releases** — Tag `v*.*.*` on `main`; `.github/workflows/release.yml` builds and publishes
  the GHCR app image and cuts a GitHub Release. Deploy by bumping `IMAGE_TAG` in the server's `.env`.
- **No binaries / no secrets** — see Golden Rules 4 and 5.

## Project Status & Remaining Phases

- **Done:** Phase 1 (skeleton) + Phase 1b (expedition-log layer) — merged to `main`.
- **Done:** Phase A (Postgres CMS foundation) — Postgres Content Layer loader, body-image
  pipeline, runtime `blog-builder` service, compose/volume wiring — merged to `main`.
- **Done:** Phase B (in-admin editor) — DE/EN tabbed editor (EasyMDE), slug-lock, inline photo
  upload, Save draft, Publish (triggers rebuild), Export all (MDX backups to `/data/backup`) —
  merged to `main`.
- **Done:** Phase 2 (WordPress import) — in-admin WXR importer; upload WP export → draft posts
  created with slugs preserved and images re-hosted.
- **Done:** Phase 3 (MapLibre travel map) — map page (`/karte/` + `/en/map/`) plotting all trips as
  pins with popups; homepage `MapTeaser` wired to the map; per-story lazy mini-maps (pin + stops);
  self-hosted PMTiles basemap (zero third-party requests), served at `/map/` by the app;
  progressive enhancement with text/link fallback — merged to `main`.
- **Done:** Security hardening — auth rate-limiting, admin-only publish, SSRF/timeout/size-cap on
  remote fetches, path-traversal guards, body-HTML sanitization, security headers (branch
  `feature/security-hardening`). See `SECURITY.md`.
- **Done:** Single-app-container merge + DB backup — collapsed the 4-container stack (nginx /
  blog-builder / uploader / db) into 2 services (`app` / `db`); the `app` container serves the
  blog, admin, and images from one process and runs `astro build` in-process; added a
  scheduled/on-demand, retention-pruned Postgres backup feature (CLI-only restore). See
  `ARCHITECTURE.md` and `docs/superpowers/specs/2026-07-03-single-app-container-design.md`
  (branch `feature/single-app-container`).
- **Done:** Editable About page + baked-in travel map basemap (v0.5.0).
- **Done:** AI feature removal + conformance hardening (July 2026) — removed the LM Studio
  caption/batch-uploader feature entirely (`/suggest`, `caption.ts`, `batch.html`, LM settings);
  settings endpoints are now admin-only; a global error handler logs unexpected errors
  server-side and returns sanitized 500s; PR CI added (`.github/workflows/ci.yml`); site tests
  consolidated next to their modules (branch `feature/remove-ai-and-harden`).
- **Remaining:** Phase 4 = DNS cutover. See `docs/superpowers/plans/` for phase details.

Architecture overview: `ARCHITECTURE.md` · security model: `SECURITY.md` · top-level guide: `README.md`.
