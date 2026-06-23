# Design — Postgres-Backed Authoring CMS for the Blog

**Date:** 2026-06-23
**Status:** Approved (brainstorming) — ready for implementation planning (phased)
**Relates to:** Builds on the uploader auth feature (`feature/uploader-auth`, PR #3 — username/password
+ Postgres). This turns the uploader into a small **headless CMS** for the static blog. It changes
the blog's content pipeline, so it touches `site/` as well as `uploader/`.

## Problem

Today, publishing a post is a manual three-stage chore (see `docs/authoring-workflow.md`): upload
photos in the admin, **hand-write two MDX files in GitHub**, then **rebuild the blog container on the
server**. Stages 2 and 3 are friction: they require editing raw MDX/frontmatter by hand and a manual
server rebuild. We want to author and publish posts entirely from the admin panel.

## Goals

- Author DE/EN posts from the uploader admin (the one behind the username/password login).
- **Postgres is the single source of truth** for post content (drafts and published).
- The static site **builds its content from Postgres**; publishing is a button, not a manual rebuild.
- Keep the site **fully static** (nginx-served) — no SSR, no per-request rendering.
- **No GitHub, no GitHub Actions, no Docker socket** in the publish path. Backup is an MDX **export**.
- Preserve the **SEO slug contract** (DE at root, EN under `/en/`, slugs never renamed) and keep the
  existing tested helpers (`paths.ts`, `trips.ts`, i18n) working unchanged.

## Non-Goals (YAGNI)

- No delete-from-admin in v1 (rare; removing a live URL has SEO consequences — stays a manual op).
- No multi-author roles beyond the existing admin/author split, no per-post permissions, no workflow
  approvals.
- No WYSIWYG/MDX-component editor — bodies are **Markdown**; the only rich element is the responsive
  image, handled by a build transform.
- No SSR / on-demand rendering (rejected — keeps the static model).
- No GitHub integration of any kind (removed deliberately; replaced by MDX export).

## Key Decisions (from brainstorming)

1. **Custom editor inside the uploader**, not an embedded CMS (Keystatic/Sveltia) — reuses the
   existing auth + image-upload flow, one unified admin.
2. **Scope v1 = create + edit** posts (no delete).
3. **Postgres is canonical**; the build reads content **directly from Postgres** via a custom Astro
   Content Layer loader (true headless CMS).
4. **GitHub removed**; backup is an **MDX export** to the `/data` volume (and/or downloadable zip).
5. **Body = Markdown** stored in Postgres; a build-time **rehype transform** renders each image as the
   existing responsive `<picture>` (AVIF/WebP).
6. **Drafts live in Postgres**; **Publish** flips status and triggers a build.
7. **Build in-stack, no socket/Actions:** a small **internal, secret-gated build endpoint co-located
   with the blog** (it has the Astro toolchain) runs `astro build` from Postgres into a temp dir, then
   **atomic-swaps** into the shared volume nginx serves. The uploader calls it over the internal Docker
   network.
8. **Phased delivery:** Phase A (pipeline swap, invisible to users) before Phase B (the editor).

## Architecture

```
Author → [uploader admin: editor]  --save draft-->  Postgres(posts)
                                    --publish------>  set status=published
                                                       │  (internal, secret-gated HTTP, docker net)
                                                       ▼
                                        [blog builder]  astro build (reads Postgres) → /tmp/dist
                                                       │  atomic swap
                                                       ▼
                                        [blog nginx]  serves shared `blog-dist` volume  → live
Backup:  uploader "Export" → MDX files on /data/backup (and/or .zip download)
```

Components, each with one responsibility:

| Unit | Responsibility | Location |
|------|----------------|----------|
| `posts` schema + `postStore` | CRUD for posts, draft/publish status, slug-lock | uploader (`src/posts.ts`, Postgres) |
| editor pages | DE/EN frontmatter form + EasyMDE body + image insert | uploader (`public/editor.html`, list page) |
| post routes | `GET/POST/PUT /posts*`, `POST /posts/:tk/publish`, `GET /export` | uploader (`src/server.ts`) |
| publish/build client | calls the blog builder endpoint over the internal network | uploader (`src/publish.ts`) |
| blog builder | secret-gated endpoint; runs `astro build` from Postgres; atomic swap | blog side (new small service) |
| Postgres content loader | Astro Content Layer loader reading `posts` at build | site (`src/content.config.ts`, `src/lib/postgres-loader.ts`) |
| responsive-image transform | rehype plugin: markdown image → `<picture>` | site (`src/lib/`) |
| MDX export | render every post to MDX on the `/data` volume | uploader (`src/export.ts`) |
| migration | one-time: 18 MDX files → `posts` rows | script (`uploader/scripts/` or `site/scripts/`) |

### Data model (Postgres)

One row **per locale**, linked by `translation_key` (mirrors the two-MDX-files model):

```sql
CREATE TABLE IF NOT EXISTS posts (
  id              uuid PRIMARY KEY,
  translation_key text NOT NULL,
  locale          text NOT NULL CHECK (locale IN ('de','en')),
  slug            text NOT NULL,
  title           text NOT NULL,
  date            date NOT NULL,
  country         text NOT NULL,
  country_code    text NOT NULL CHECK (char_length(country_code) = 2),
  region          text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
  excerpt         text NOT NULL,
  hero_image      jsonb NOT NULL,         -- { src, width, height, alt }
  coordinates     jsonb NOT NULL,         -- { lat, lng }
  stops           jsonb,                  -- [{ name, lat, lng }] | null
  route           text,
  key_facts       jsonb,                  -- { label: value } | null
  body_markdown   text NOT NULL,
  images          jsonb NOT NULL DEFAULT '{}',  -- { "<image-url>": { width, height } } for body images
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug);
CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key);
```

Rules: `slug` is **immutable once a row reaches `published`** (enforced server-side). A logical "post"
is the DE+EN pair sharing `translation_key`; the editor edits both locales together.

### Build-from-Postgres (the site pipeline change)

`site/src/content.config.ts` swaps `glob(...)` for a **custom loader** that:
- connects to Postgres at build time (`DATABASE_URL`),
- selects `status='published'` rows,
- emits one entry per row with **`id = `${locale}/${slug}``** and `data` matching the **existing zod
  schema unchanged** (camelCase mapping from snake_case columns), and the markdown `body`.

Because `trips.ts`/`paths.ts` operate purely on `entry.id` (`(de|en)/slug`) and `entry.data`, **they
and their tests are unchanged.** The body renders via Astro's markdown pipeline; a **rehype transform**
rewrites each markdown image into the existing responsive `<picture>` (the current `BodyImage` markup).
Body images are authored as plain markdown (`![alt](url)`); the responsive variant **widths/heights**
come from the post's **`images` map** (`url → { width, height }`), which the loader provides to the
transform per entry. `StoryPage.astro` renders the markdown body in place of the MDX `<Content/>`.

### Publish + build (no socket, no Actions)

On **Publish**, the uploader (1) sets the locale rows to `status='published'`, (2) POSTs to the blog
**builder endpoint** (internal Docker network, shared-secret header). The builder runs `astro build`
(reading Postgres) into a temp directory and, on success, **atomically swaps** it into the `blog-dist`
volume nginx serves (rename/symlink swap) — nginx keeps serving the old build until the swap, so a
failed build never yields a partial site. Builds are **serialized** (a lock); a build already running
queues the next. Result/errors are surfaced in the admin.

### Backup = MDX export

An **Export** action renders every post (both locales) to MDX (frontmatter + body, each `<BodyImage>`
reconstructed from its markdown image ref plus the `images`-map dimensions) and writes them under
`/data/backup/trips/{de,en}/<slug>.mdx`
(and offers a `.zip` download). Optionally the changed post is exported on each publish. This is the
durable, human-readable safety net that replaces git history.

## Migration (one-time, Phase A)

A script reads `site/src/content/trips/{de,en}/*.mdx`, parses frontmatter + body, converts each
`<BodyImage src w h alt/>` tag to a markdown image reference (`![alt](src)`) and records its
`width`/`height` into the row's `images` map, and inserts per-locale `posts` rows with the
**exact existing slugs and translation keys**, `status='published'`. Acceptance: row count = 2×posts,
every original slug present for its locale, and a build from Postgres renders the same routes as the
current MDX build. The original MDX stays in git until this is verified.

## Error handling

- Build endpoint: missing/invalid secret → 401; build failure → non-zero, keep previous `dist`, return
  the build log tail to the admin; DB unreachable at build → fail loudly (the site stays on last good
  build).
- Editor: validation mirrors the zod schema (required fields, 2-char country code, region enum, valid
  coordinates, non-empty alt); duplicate `(locale, slug)` → 409; attempt to change a published slug → 409.
- Publish is idempotent; a second publish while one is building → queued, not parallel.

## Testing

- **uploader (Vitest, in-memory store):** post CRUD, draft↔publish, slug-lock/immutability, validation,
  MDX export rendering (round-trips a known post), publish→build orchestration with a mocked builder.
- **site (Vitest):** the Postgres loader emits correct `id`/`data` from fixture rows; the responsive-image
  rehype transform; existing `trips`/`paths`/i18n/format suites stay green.
- **migration:** idempotent and slug-preserving; run against the real 18 and diff routes vs the current
  MDX build before cutover.
- Gates: `npm test` + `npx astro check` (site) and `npm test` + `npm run typecheck` (uploader).

## Phasing

- **Phase A — pipeline swap (no user-visible change):** posts schema + migration of the 18 posts +
  Postgres Content Layer loader + responsive-image transform + `StoryPage` markdown rendering + build
  wiring so the site builds identically from Postgres. Verifiable by diffing the built site against the
  current MDX build. Ships independently.
- **Phase B — authoring:** editor pages (list + DE/EN form + EasyMDE + image insert that records
  dimensions into the `images` map + slug-lock),
  post routes, publish→build endpoint + atomic swap, MDX export, and authoring-workflow docs.

Each phase gets its own implementation plan.

## Risks & roadmap impact

- **Postgres becomes a build-time dependency** — the site build fails if the DB is down (mitigated:
  nginx keeps serving the last good build; export provides recovery).
- **Divergence from the documented static/MDX roadmap** (CLAUDE.md Phase 2). This supersedes the
  "hand-write MDX" authoring model; `docs/authoring-workflow.md` and CLAUDE.md will be updated in Phase B.
- **The blog side gains the Astro build toolchain** at runtime (bigger image / a builder service).
- **MDX→Markdown body conversion** for the 18 posts is the one near-irreversible step — gated by keeping
  the original MDX in git until the Postgres build is verified route-for-route.
- **SEO slugs** must survive migration exactly (golden rule #2) — explicit acceptance check.
