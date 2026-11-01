# CLAUDE.md

Guidance for AI coding assistants (Claude, Gemini, Codex) working in this repository.
Derived from `../TEMPLATE.md` and kept in sync with it, tailored to this project.

This repo is a **monorepo** with two parts, and most rules below apply to only one of them:

- **`site/`** — an Astro 7 **static site**. It builds to a static `dist/` (content is loaded from
  Postgres at build time), so the template's auth/RBAC, SRE, resilience, and container rules do
  **not** apply to it directly. Its risks are output safety (XSS via `set:html`), the SEO slug
  contract, and i18n completeness.
- **`uploader/`** — a small self-hosted **Node 26 + Fastify 5 + sharp** app (CMS + image service +
  blog serving). Docker, a server runtime, and every Security/Privacy/Operations section in `docs/claude/security-and-operations.md` DO
  apply here.

Unqualified rules describe both; where they differ, the tree is named explicitly.

## Project Overview

**Simon's Wanderlust** (`simonswanderlust.com`) — a bilingual (DE/EN) personal travel blog.
The platform itself supports four language modes (DE+EN DE-primary — the live site — DE+EN
EN-primary, DE-only, EN-only; see Golden Rule 2); every rule below that says "DE/EN" means
"each enabled locale" on another install.
This repo is the **Astro 7 static-site rebuild** of the current WordPress + Elementor site.

- **Architecture:** One Astro 7 project under `site/`, **self-hosted via Docker** as a **single
  `app` container** (WordPress-style) alongside Postgres, wired in the root `docker-compose.yml`.
  The uploader serves the blog itself, in addition to being the admin CMS and image service.
  UI is Astro components + Tailwind 4.
- **Primary users:** One admin/author (the owner). Public readers consume only the static blog
  output; they never reach an authenticated surface.
- **Risk level:** **Normal.** No third-party accounts, no payments. The only reader data is
  **reader comments** (a self-chosen display name + a plain-text body, submitted for
  publication); no email is collected and no IP is persisted. Elevated where the uploader
  touches remote fetches (WXR import), untrusted markup (body HTML), photo metadata (EXIF/GPS),
  and the **public comment routes** (`GET`/`POST /comments`, the one unauthenticated write
  surface besides `/login`/`/setup`).
- **Sensitive data:** Admin account credentials (scrypt hashes) and session records in Postgres;
  photo EXIF including GPS coordinates in the media library; reader comments (display name +
  body — email is not collected, IP is not stored) in the `comments` table and in DB dumps.
  Everything else is public content.
- **Enabled profiles:** Web/API · Frontend · Database · Containers · AI (one narrow feature).
- **Authoritative product documentation:** `docs/superpowers/specs/` (design specs) and
  `docs/superpowers/plans/` (phase plans) are the source of truth for scope.
- **Architecture decisions:** No separate ADR directory. The dated specs in
  `docs/superpowers/specs/` serve that role; `ARCHITECTURE.md` holds the current-state overview.

If a request conflicts with a spec in `docs/superpowers/`, a safety rule, or an explicit project
constraint, stop and ask instead of guessing.

**Design language:** Editorial magazine + "refined brand" voice, with an "Expedition Log" flavor
layer (mono coordinates from frontmatter, N°XX entry numbers, contour textures, arrival stamps,
dashed route dividers). See `docs/superpowers/specs/2026-06-11-blog-redesign-design.md`.
(This replaces the template's "Glass & Bento" house style — do not reintroduce glassmorphism,
bento grids, or a dark-by-default theme here.)

## Read these when relevant

- `docs/claude/security-and-operations.md`: REQUIRED before changing auth, sessions,
  comment routes, fetches, EXIF, AI credentials, the schema, backups or the app runtime.
- `docs/claude/project-reference.md`: content pipeline, containers, accessibility,
  contract-first rules, repo structure, superpowers workflow and authoring guide.
- `docs/claude/project-status.md`: what shipped and why. Add new status entries here.

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
2. **SEO Slug Contract (Critical)** — Published slugs and routes MUST be preserved exactly.
   simonswanderlust.com, and every install whose primary language is German, keep the live
   WordPress layout: DE at root, EN under `/en/`. An install whose primary language is English
   (EN-only, or DE+EN EN-primary; owner-authorized 2026-10-27, see
   `docs/superpowers/specs/2026-10-27-issue-283-language-mode-contract.md`) serves EN at root and
   DE under `/de/`. The primary language is locked at the first publish
   (`language_primary_locked`); no language-mode change moves a published URL. Encoded and tested
   in `site/src/lib/paths.ts` and `trips.ts`, and mirrored by MDX filenames. **Never rename a slug
   or route** without explicit authorization — it breaks live URLs and SEO.
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
7. **No Hardcoded UI Strings** — Interface copy and neutral fallbacks live in `site/src/i18n/ui.ts`
   for both locales (completeness-tested). Owner-authored identity text lives in Postgres, not
   the translation dictionary; exact upgrade-only brand values live in `site-identity-legacy.ts`.
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
- **High risk (in this repo):** Anything touching authn/authz or sessions, the **public comment
  routes** (`uploader/src/comments-public.ts` — unauthenticated write surface, Origin check,
  honeypot, comment limiter, the public JSON shape), the `images`-map and
  body-HTML render path, gallery URL allow-listing, `safeFetch`/WXR import, path-traversal guards,
  EXIF/GPS handling, the schema in `uploader/src/db.ts`, backup/restore, the build/publish
  pipeline, the site identity tables and exported identity/content build snapshot, the
  **language mode** (`site_language`, `posts.omitted`, `PUT /language`, the `SITE_LANGUAGE_JSON`
  hand-off and the published-URL-set invariant), the
  journey tables, published snapshots and transactional membership cleanup,
  canonical-origin/comment-origin roles, `/data` layout, AI credentials (the provider registry,
  `app_secrets` slots, `/ai-providers*` and `/ai-config`), or **any slug or route change**.

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
| **i18n** | Astro i18n routing, configured per install from the Postgres `site_language` singleton (`site/astro.config.mjs` → `resolveBuildLanguage`): `defaultLocale` = the primary locale (no prefix), the optional secondary under `/<locale>/`. Four modes — DE+EN DE-primary (simonswanderlust.com: `de` at root, `en` under `/en/`), DE+EN EN-primary (`en` at root, `de` under `/de/`), DE-only, EN-only. `ui.ts` keeps both dictionaries complete in every mode; a single-language build never renders the other one |
| **Fonts** | Inter Variable (sans), IBM Plex Mono (expedition-log accents) |
| **Markdown** | Shiki syntax highlighting (`syntaxHighlight: { type: 'shiki', excludeLangs: ['math', 'gallery'] }`) — `site/astro.config.mjs` imports `MARKDOWN_OPTIONS` directly from `site/src/lib/render-markdown.ts`; `render-markdown.test.ts` exercises gallery markers and class-based highlighting without loading database-backed build configuration |
| **Testing** | Vitest (both trees); `@astrojs/check` (`astro check`) for types |
| **Infrastructure** | Self-hosted Docker: one `app` image (repo-root `Dockerfile`) runs `uploader/` Fastify, which builds `site/` in-process and serves it — plus `db` (Postgres), via root `docker-compose.yml` |

### Naming and Code Organization

- `camelCase` for TS variables/functions, `PascalCase` for types and Astro components.
- Filenames in `src/content/trips/{de,en}/` ARE the live WP slugs — match them exactly.
- Prefer named exports over default exports.
- Match the conventions of surrounding files.
- **Logical boundaries over line counts** — split at responsibility, dependency, or testing
  boundaries; never to satisfy an arbitrary line count, and never keep an oversized module with
  several independent reasons to change just to keep context together.
- **One primary component per file**; small private helpers MAY be colocated.

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

## Rules for AI Coding Assistants

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


## Automated Verification Loop (after edits)

1. **Type-check:** `npx astro check` (site) · `npx tsc --noEmit` (uploader)
2. **Test:** `npm test` in whichever tree changed
3. For visual changes, run `npm run dev` and verify the rendered page.

Run the complete affected suite before opening or updating a PR. Remember that uploader integration
tests skip without `TEST_DATABASE_URL` — CI is the authoritative signal for Postgres-backed paths.


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
- New status entries go in `docs/claude/project-status.md`, not here.
- High-risk changes have explicit human approval and a credible rollback plan.
- No unresolved placeholders, secrets, temporary bypasses, or unexplained warnings remain.

Architecture overview: `ARCHITECTURE.md` · security model: `SECURITY.md` · top-level guide: `README.md`.
