# CLAUDE.md

Guidance for AI coding assistants (Claude, Gemini, Codex) working in this repository.
Derived from `../TEMPLATE.md`, tailored to this project. This repo is a **monorepo** with two
parts: `site/` is an Astro 6 **static site** (the template's auth/RBAC and SRE sections do not
apply to it — it builds to a static `dist/`; content is loaded from Postgres at build time);
`uploader/` is a small self-hosted **Node/Fastify + sharp image service** (Docker and a server
runtime DO apply there). The static-site rules below describe `site/` unless a rule names
`uploader/` explicitly.

## Project Overview

**Simon's Wanderlust** (`simonswanderlust.com`) — a bilingual (DE/EN) personal travel blog.
This repo is the **Astro 6 static-site rebuild** of the current WordPress + Elementor site.

**Architecture:** The blog is a single Astro 6 project under `site/`. It is **self-hosted via
Docker** alongside the uploader; both are wired in the root `docker-compose.yml`. UI is Astro
components + Tailwind 4.

**Content pipeline (Phase A + B):** `trips` content is authored via the **in-admin editor**
(`/admin/posts.html` + `/admin/editor.html`) and stored in **Postgres** — not edited as MDX in
git. The Astro Content Layer loader (`site/src/lib/postgres-loader.ts`) reads from Postgres at
build time; the Zod schema and entry `id`s (`de/<slug>` / `en/<slug>`) are unchanged, so
`paths.ts`/`trips.ts` work unmodified. Post bodies are Markdown; body images render as
responsive `<picture>` via `site/src/lib/body-images.ts`. The blog is **not** built at Docker
image-build time — a long-running **`blog-builder`** service (`site/build-server.mjs`) runs
`astro build` from Postgres at runtime, writing the static output into a shared **`blog-dist`**
volume that the `blog` nginx container serves. The in-admin **Publish** button triggers a
rebuild automatically; MDX backups can be exported to `/data/backup` via **Export all**. Required
env vars for the blog stack: **`DATABASE_URL`** and **`BUILD_SECRET`** (see
`uploader/.env.example`). Consequence: `npx astro check` and `npm run build` both require a
reachable Postgres.

A separate **image uploader** (Node 22 + Fastify 5 + sharp, Dockerized) lives under `uploader/`:
it optimizes uploaded photos into responsive AVIF/WebP variants and returns paste-ready
`heroImage` / `<RemoteImage>` / `<BodyImage>` snippets (with optional local-AI alt text via LM
Studio). Access is gated by username/password accounts stored in Postgres, with HttpOnly session
cookies. Both run on Simon's own server. See `uploader/README.md` and the specs
`docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md` +
`docs/superpowers/specs/2026-06-22-ai-batch-image-uploader-design.md`.

**Design language:** Editorial magazine + "refined brand" voice, with an "Expedition Log"
flavor layer (mono coordinates from frontmatter, N°XX entry numbers, contour textures,
arrival stamps, dashed route dividers). See `docs/superpowers/specs/2026-06-11-blog-redesign-design.md`.

## Mandatory Rules (The "Golden Rules")

1.  **Tests Required** — Logic in `site/src/lib/` and `site/src/i18n/` is covered by Vitest;
    add/extend tests for any change there. Run `npm test` and `npx astro check` before claiming done.
2.  **SEO Slug Contract (Critical)** — Live WordPress slugs MUST be preserved exactly:
    DE at root, EN under `/en/`. This is encoded and tested in `site/src/lib/paths.ts` and
    `trips.ts`, and mirrored by MDX filenames. **Never rename a slug or route** without
    explicit authorization — it breaks live URLs and SEO.
3.  **No Binaries in Git** — Images and other binaries are gitignored. Hero images are hosted on the image server and referenced by URL in `heroImage` (see `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md`). Root screenshots/`.jpeg`/`.png` are ignored too.
4.  **No Secrets** — Never commit `.env`, API keys, or credentials.
5.  **No Hardcoded UI Strings** — ALL user-facing copy lives in `site/src/i18n/ui.ts` for both
    locales (completeness-tested — this guards against the old site's German-in-English-footer bug).
6.  **Strict Typing** — `tsconfig` extends `astro/tsconfigs/strict`. No `any`, no `@ts-ignore`,
    no `astro check` suppressions to force a pass. Fix the underlying type issue.
7.  **Ask Before Assuming** — If a request is ambiguous or conflicts with the design spec/plans
    in `docs/superpowers/`, ask first.

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
| **Deploy target** | Self-hosted Docker: `site/` built + served by nginx, `uploader/` Fastify — both via root `docker-compose.yml` |

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

All commands run from `site/`. No containers needed for the static toolchain itself.

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

## Repository Structure

```
blog/
├── CLAUDE.md                       # this file
├── docs/superpowers/              # design spec + phase plans (source of truth for scope)
├── *.md                           # blog platform research (WordPress vs Astro, etc.)
├── site/                          # the Astro project (static blog)
│   ├── build-server.mjs           #   runtime build server (blog-builder service; secret-gated trigger → astro build)
│   ├── scripts/migrate-stub-posts.mjs  # one-off: import MDX stubs into Postgres
│   └── src/
│       ├── content/trips/{de,en}/<slug>.mdx   # MDX source files (authoring reference; content served from Postgres)
│       ├── content.config.ts                   # Zod schema for trips (unchanged from MDX era)
│       ├── i18n/ui.ts                          # ALL UI strings, both locales (completeness-tested)
│       ├── lib/                                # tested helpers: paths, trips, format, images
│       │   ├── postgres-loader.ts              #   Astro Content Layer loader — syncs trips from Postgres at build time
│       │   └── body-images.ts                  #   transforms Markdown body: renders <BodyImage> as responsive <picture>
│       ├── components/pages/                   # shared per-page components
│       ├── pages/                              # thin locale routes (de at root, en under /en/)
│       └── layouts/  ·  styles/  ·  assets/
└── uploader/                      # self-hosted image service (Node/Fastify/sharp, Docker)
    ├── src/                       #   variants · pipeline · storage · db · users · sessions · authn · server · main · cli · caption · settings · posts · publish · export · wxr-parse · wp-content · wp-images · wp-import
    ├── public/                    #   index.html (hero upload) · batch.html (AI batch uploader) · import.html (WordPress import)
    ├── test/                      #   Vitest suites (no live LM Studio needed)
    └── Dockerfile · docker-compose.yml · README.md
```

- **Logical boundaries over line counts** — keep cohesive logic together; don't fragment files.
- **One primary component per file** for components.

## AI Assistant Security Guidelines

These apply to YOU, the assistant, while working here:
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
- **Output Safety** — Escape/sanitize any external content rendered into pages (avoid XSS even
  in a static context, e.g. via `set:html`).

## AI Collaboration & Workflow

This repo uses the **superpowers** workflow: specs and phase plans live in
`docs/superpowers/` and are the source of truth for what's in scope. Read the relevant
plan before implementing.

**Authoring a post?** See `docs/authoring-workflow.md` — how to upload photos via the
uploader and write/publish via the in-admin editor (Postgres is the source of truth; MDX files
are export-only backups).

### Verify Before Use (Prevent Hallucinations)
- **Dependencies & APIs** — Never assume a package is installed or that a method exists. Check
  `site/package.json` and the actual exported API (local types/source) before calling.
- **Documentation Lookup** — Fetch official/current docs for Astro 6, Tailwind 4, etc. via a
  docs MCP (priority: Ref → DeepWiki → other) rather than relying on memory.
- **Internal Functions** — Read the target file to confirm a helper's name, args, and return
  type before calling it (especially `paths.ts` / `trips.ts`).

### Automated Verification Loop (after edits)
1. **Type-check:** `npx astro check`
2. **Test:** `npm test`
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
- **Commits** — Conventional style: `type(scope): description` (e.g. `feat(home): add route divider`).
- **Pushing** — Commits are local by default; the user pushes manually unless they ask otherwise.
- **No binaries / no secrets** — see Golden Rules 3 and 4.

## Project Status & Remaining Phases

- **Done:** Phase 1 (skeleton) + Phase 1b (expedition-log layer) — merged to `main`.
- **Done:** Phase A (Postgres CMS foundation) — Postgres Content Layer loader, body-image
  pipeline, runtime `blog-builder` service, compose/volume wiring — merged to `main`.
- **Done:** Phase B (in-admin editor) — DE/EN tabbed editor (EasyMDE), slug-lock, inline photo
  upload, Save draft, Publish (triggers rebuild), Export all (MDX backups to `/data/backup`) —
  merged to `main`.
- **Done:** Phase 2 (WordPress import) — in-admin WXR importer; upload WP export → draft posts
  created with slugs preserved and images re-hosted.
- **Remaining:** Phase 3 = MapLibre travel map (`/karte/` + `/en/map/`); Phase 4 = DNS
  cutover. Each phase gets its own plan in `docs/superpowers/plans/`.
