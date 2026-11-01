# Project Reference

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Content Pipeline and Uploader

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
Simon's own server, in one container. AI inference remains **browser-direct**:
editor-integrated alt-text suggestions (local by default, optional remote providers) and the **Review Story** drawer, which combines
deterministic checks with optional provider-backed suggestions (#212–#215). It reviews
unsaved active-locale content without autosaving or gating Publish. The Media page also
suggests photo details (title, DE/EN alt + caption, tags) for one photo, or fills empty
fields in bulk — the one AI path that saves, with opt-in overwrite
(`docs/superpowers/specs/2026-10-18-media-ai-details-design.md`). The server never
contacts a model.
See `docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md`. (An earlier
standalone batch-uploader variant was removed in July 2026 and restored in this slimmer,
editor-integrated form; the 2026-06-22 spec is historical.) See `uploader/README.md`,
`ARCHITECTURE.md`, and the specs
`docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md` +
`docs/superpowers/specs/2026-07-03-single-app-container-design.md`.

## Design Tokens, Dependencies and Containers

### Design Tokens (`site/src/styles/global.css`, Tailwind 4 `@theme`)

- `--color-canvas: #fbfbfd` (page bg) · `--color-navy: #142a42` (brand/structure)
- `--color-ink: #16212e` (body text) · `--color-brand-red: #d23b30` (accent/CTA)
- `--color-brand-red-light: #ff5a4e` (accent on dark/photo backgrounds)
- `--font-sans: Inter Variable` · `--font-mono: IBM Plex Mono`

### Dependency Integrity

- Verify a package exists and is the intended one before installing (typosquatting).
- Both trees have committed `package-lock.json`; use `npm ci` in reproducible contexts and review
  lockfile diffs.
- Do not use `--force` / `--legacy-peer-deps` unless strictly necessary and explained.
- Review new dependencies for maintenance status, provenance, license, and transitive risk. This
  project deliberately runs a small dependency surface — prefer the platform (`node:crypto`,
  `node:fs`) over a package.

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
| `app` (Fastify: blog + admin + images) | `3000` | **Loopback** (`127.0.0.1:3000`) — the only published port; one host TLS proxy, with immediate-peer address validation (#108, #369) |
| `db` (Postgres 18) | `5432` | **Internal** — compose network only; never published to the host |
| Astro dev server | `4321` | **Loopback** — local development only |

Compose sets `TRUSTED_PROXY: docker-gateway` literally, not through `.env`. It trusts loopback
and the discovered default gateway at hop zero only; missing/ambiguous discovery refuses boot.
Changing bridge/proxy topology or adding a CDN requires a new spec. Docker Desktop TCP evidence
does not replace the target-VPS peer/header/two-external-network checks before DNS cutover.

## Accessibility and High-Impact Actions

- Target **WCAG 2.2 Level AA** for both the public blog and the admin UI.
- Use semantic elements, keyboard-operable controls, visible focus, sufficient contrast, accessible
  names, and reduced-motion support. The travel map is progressive enhancement — the text/link
  fallback MUST stay functional.
- Colour MUST NOT be the only signal. Media/post status badges pair colour with text.
- Destructive or irreversible admin actions (delete post, delete media, delete folder, bulk
  operations, restore) MUST show their scope and require confirmation. Reversibility, not blast
  radius, decides whether an action is admin-only — see `SECURITY.md`.

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
The hero image is the same trap in **three** places: `HeroImage` (`uploader/src/posts.ts`),
`RemoteHeroImage` (`site/src/lib/images.ts`) and the Zod schema (`site/src/content.config.ts`).
Its optional `focus` (`{ x, y }` percentages driving `object-position`) is pinned by a round-trip
through the real editor markup in `uploader/test/editor-dom.test.ts`, since a one-sided widening
type-checks clean while an author's framing is dropped on save.

### 3. Contextual Markers

- `@ai-note` — a non-obvious invariant or business rule.
- `@ai-context` — points to a related spec or implementation entry point.
- `@ai-warning` — a dangerous side effect, compatibility constraint, or legacy trap.

Markers must explain **why** and point to durable evidence. Update or remove them when the code
changes; they do not substitute for tests, types, or specs.

### 5. Verify Before Use (Prevent Hallucinations)

- **Dependencies and APIs** — Never assume a package is installed or a method exists. Check
  `site/package.json` / `uploader/package.json` and the actual exported API before calling.
- **Documentation lookup** — Fetch official/current docs for Astro 7, Tailwind 4, Fastify 5, etc.
  via a docs MCP (priority: **Ref** → DeepWiki → other) rather than relying on memory. Record the
  source and version when it affects a decision.
- **Internal functions** — Read the target file to confirm a helper's name, args, and return type
  before calling it (especially `paths.ts` / `trips.ts`).

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
│       │   ├── journey-snapshot.ts             #   strict shared journey snapshot/hero boundary (uploader, recovery and site)
│       │   ├── body-images.ts                  #   transforms Markdown body: <BodyImage> → <picture>, ```gallery → gallery
│       │   ├── gallery-layout.ts               #   justified-row partition + #layout: directive reader (pure; also runs under tsx)
│       │   └── map-data.ts                     #   export tripPins() and tripGeometry() for map layers
│       ├── components/pages/                   # shared per-page components
│       ├── pages/                              # one dynamic route ([...path].astro) + [...locale]/rss.xml.ts, fed by lib/public-routes.ts for the enabled locales
│       ├── scripts/travel-map.ts               #   MapLibre GL island; initializes full map and mini-maps
│       ├── scripts/gallery-lightbox.ts         #   <dialog> lightbox + slider controls; loaded via GalleryIsland.astro
│       └── layouts/  ·  styles/  ·  assets/
└── uploader/                      # self-hosted app: CMS + image service + blog serving (Node/Fastify/sharp)
    ├── src/                       #   variants · pipeline · storage · db · users · sessions · authn · server · main · cli · settings · posts · pages · body-content · build · backup · export · preview · wxr-parse · wp-content · wp-images · wp-import
    │                              #   media-files (disk) · media-store (database) · media-sync (reconcile) · encode-queue · work-lock · disk · exif
    │                              #   journeys · journey-cleanup · journeys-admin (working copies, snapshots and language-first cleanup)
    ├── public/                    #   index.html (hero upload) · import.html (WordPress import) · editor/posts/about/settings/users
    │                              #   media.html + media-api/media-ai/media-ai-dialog/media-browser/media-picker.js · posts-filter.js
    │                              #   journeys.html · journey-editor.html (ordered, bilingual journey authoring)
    ├── test/                      #   Vitest suites (integration suites run when TEST_DATABASE_URL is set)
    └── .env.example · README.md
```
