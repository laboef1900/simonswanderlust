# CLAUDE.md

Guidance for AI coding assistants (Claude, Gemini, Codex) working in this repository.
Derived from `../TEMPLATE.md`, tailored to this project. This is a **static site** — the
template's backend, Docker, database, auth/RBAC, and SRE sections do not apply and were
intentionally omitted to avoid misinforming future sessions.

## Project Overview

**Simon's Wanderlust** (`simonswanderlust.com`) — a bilingual (DE/EN) personal travel blog.
This repo is the **Astro 6 static-site rebuild** of the current WordPress + Elementor site.

**Architecture:** Single Astro 6 project under `site/`. No backend, database, or server
runtime — `npm run build` emits a static `dist/` deployed to a CDN (target: Cloudflare Pages).
Content is authored as MDX content collections; UI is Astro components + Tailwind 4.

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
3.  **No Binaries in Git** — Images and other binaries are gitignored. Hero images are fetched
    by `site/scripts/fetch-sample-images.sh`. Root screenshots/`.jpeg`/`.png` are ignored too.
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
| **Content** | MDX content collections (`@astrojs/mdx`) under `src/content/trips/{de,en}/` |
| **i18n** | Astro i18n routing — `defaultLocale: 'de'` (no prefix), `en` under `/en/` |
| **Fonts** | Inter Variable (sans), IBM Plex Mono (expedition-log accents) |
| **Tests** | Vitest |
| **Type-check** | `@astrojs/check` (`astro check`) |
| **Deploy target** | Static `dist/` → Cloudflare Pages (Phase 4) |

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

All commands run from `site/`. No containers — this is a static toolchain.

```bash
npm install                         # install deps (Node >= 22.12)
./scripts/fetch-sample-images.sh    # one-time: download gitignored hero images
npm run dev                         # dev server at http://localhost:4321
npm run build                       # build static site to ./dist/
npm run preview                     # preview the production build
npm test                            # Vitest suites (i18n, paths, trips, format)
npx astro check                     # type-check .astro/.ts
```

## Repository Structure

```
blog/
├── CLAUDE.md                       # this file
├── docs/superpowers/              # design spec + phase plans (source of truth for scope)
├── *.md                           # blog platform research (WordPress vs Astro, etc.)
└── site/                          # the Astro project
    ├── src/
    │   ├── content/trips/{de,en}/<slug>.mdx   # one story per language; filename = live WP slug
    │   ├── i18n/ui.ts                          # ALL UI strings, both locales (completeness-tested)
    │   ├── lib/                                # tested helpers: paths, trips, format
    │   ├── components/pages/                   # shared per-page components
    │   ├── pages/                              # thin locale routes (de at root, en under /en/)
    │   ├── layouts/  ·  styles/  ·  assets/
    └── scripts/fetch-sample-images.sh
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
- **Remaining:** Phase 2 = WordPress content migration (18 posts via the open REST API);
  Phase 3 = MapLibre travel map (`/karte/` + `/en/map/`); Phase 4 = Cloudflare Pages deploy
  + DNS cutover. Each phase gets its own plan in `docs/superpowers/plans/`.
