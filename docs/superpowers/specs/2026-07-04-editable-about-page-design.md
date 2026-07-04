# Design — Editable "About me" Page (backend-managed static page)

**Date:** 2026-07-04
**Status:** Approved (brainstorming) — ready for implementation planning
**Relates to:** Makes the About page (`/uber-mich/`, `/en/about-me/`) editable from the admin CMS
instead of being hardcoded in `site/src/components/pages/AboutPage.astro`. Introduces a small,
general `pages` table so other static pages (imprint, privacy) could follow later — but only the
About page is in scope here.

## Problem

The About page text lives as a hardcoded DE/EN string literal in
`AboutPage.astro:12-15` — still the Phase-2 placeholder ("…wird in Phase 2 … migriert"). Editing it
means changing source and rebuilding from code. Trips are already authored in the admin and stored
in Postgres; the About page should be editable the same way.

## Goals

- Author the About page's **heading** and **Markdown body (with inline photos)**, per locale, from
  a page in `/admin/`.
- Store the content in Postgres; render it through the **existing** markdown → sanitize →
  responsive-`<picture>` pipeline used for trips (so XSS protection and body-image handling are
  reused, not reimplemented).
- **Save = rebuild live**: one Save writes the content and triggers a site rebuild (admin-only),
  exactly like publishing a post.
- Nothing regresses on first deploy: the table is seeded with the current placeholder text.

## Non-Goals (YAGNI)

- No generic "pages CMS" UI — only the About page (`key='about'`). The table shape is general, but
  no imprint/privacy pages, no page-creation UI.
- No dedicated hero image for About (inline body photos cover images on the page). Can be added later.
- No draft/publish two-step for pages — Save rebuilds directly.
- No change to trips, the `posts` table, slugs, or the map.

## Key Decisions

1. **Dedicated `pages` table, not `posts`.** `posts` is loaded with trip-only NOT-NULL columns
   (`country`, `country_code`, `region`, `coordinates`, `date`) and `validateForPublish`
   (`posts.ts:71-88`) enforces them; the loader turns rows into trip-URL collection entries. Reusing
   it for About would mean faking trip fields and wrong URL/collection semantics. A `pages` table is
   the honest fit.
2. **Reuse the trips rendering pipeline via a second Content Layer loader.** Astro's `renderMarkdown`
   is only available inside a loader; to render About identically to trips (same
   `transformBodyImages` sanitize + `<picture>` injection), About becomes a tiny content collection
   with its own loader that mirrors `postgresTripsLoader` (`postgres-loader.ts:37-64`). One markdown
   pipeline, one sanitizer.
3. **Editable heading; nav label stays in i18n.** The page `<h1>` comes from the DB `title` (falling
   back to `about.title` from `i18n/ui.ts` when blank). The nav link label is unchanged (i18n).
4. **Seed on schema creation.** `ensureSchema` idempotently inserts the two `about` rows with the
   current DE/EN placeholder text (`INSERT … ON CONFLICT (key, locale) DO NOTHING`), so the page is
   populated on first run and the author has something to edit.

## Architecture

### Data model (Postgres) — new table in `uploader/src/db.ts` `ensureSchema`

```sql
CREATE TABLE IF NOT EXISTS pages (
  key           text NOT NULL,
  locale        text NOT NULL CHECK (locale IN ('de','en')),
  title         text NOT NULL DEFAULT '',
  body_markdown text NOT NULL DEFAULT '',
  images        jsonb NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, locale)
);
```

Seed (idempotent, after the CREATE): two `('about','de'|'en')` rows with the current placeholder
`title` (`Über mich` / `About me`) and the placeholder body text from `AboutPage.astro`,
`ON CONFLICT (key, locale) DO NOTHING`.

Backups: `pages` is content (like `posts`), not auth. The DB backup feature dumps `users` + `posts`
today; **add `pages` to the dump/restore** (`uploader/src/backup.ts`) so About content is backed up
too (`sessions` stays excluded). This changes the dump format: bump `DUMP_VERSION` 1 → 2 (new dumps
carry `tables.pages`). Restore must stay **backward-compatible**: accept both v1 (no `pages` — skip
it) and v2 dumps, so existing backups still restore.

### Store — new `uploader/src/pages.ts` (mirrors `posts.ts`)

```ts
export type Locale = 'de' | 'en';
export interface ImageDims { width: number; height: number }
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims> }
export interface PagePair { key: string; de: PageContent; en: PageContent }
export class PageError extends Error {}

export interface PageStore {
  get(key: string): Promise<PagePair>;      // returns empty-but-valid pair if rows absent
  save(pair: PagePair): Promise<PagePair>;  // upserts both locales, bumps updated_at
}
export function memoryPageStore(): PageStore   // for tests
export function pgPageStore(pool: DbPool): PageStore
```

- `save` validates `key` (`^[a-z0-9][a-z0-9-]*$`) and `locale`; upserts both rows
  `ON CONFLICT (key, locale) DO UPDATE`. Title/body may be empty (About can be short).
- `get('about')` returns the pair; if a locale row is missing it returns an empty `PageContent`
  (`title:'', bodyMarkdown:'', images:{}`) so callers never see null.

### Server routes — `uploader/src/server.ts` (`ServerConfig` gains `pages: PageStore`)

- `GET /pages/:key` — `requireAuth` → `PagePair` (the editor loads current content).
- `PUT /pages/:key` — `requireAdmin` (writes to the public site) → `pages.save(pair)`, then
  `cfg.builder.build()`; responds `{ saved: PagePair, build: BuildOutcome }` (mirrors the publish
  route at `server.ts` `POST /posts/:tk/publish`). `:key` validated; body shape validated → 400 on
  bad input.
- Inline images reuse the existing `POST /upload` with keys like `pages/about/<name>` (passes the
  current `KEY_RE`/`assertSafeKey`). No new upload route.
- `PUT` (and `/pages`, `/upload`) are already covered by the admin security-header scoping added in
  the single-app-container work (`ADMIN_PREFIXES` includes `/pages`? — add `/pages` to that list).

### Editor — new `uploader/public/about.html`

Reuses `editor.html` patterns: DE/EN tabbed **EasyMDE**, a `title` input per locale, inline image
upload (same helper the post editor uses, keyed `pages/about/…`), and one **Save** button that
`PUT`s `/pages/about` and shows the rebuild result. Admin-only in the UI (Save hidden/disabled for
non-admins; the route enforces `requireAdmin` regardless). Add an **"About"** link to the admin nav
(the shared `#mainnav` / `auth.js` header used by the other admin pages).

### Rendering (Astro) — new `pages` collection

- New loader `site/src/lib/pages-loader.ts` — `postgresPagesLoader()`, mirroring
  `postgresTripsLoader`. Reads `SELECT key, locale, title, body_markdown, images FROM pages`; for
  each row: `id = "${key}/${locale}"` (e.g. `about/de`), `renderMarkdown(body_markdown)`, then
  `rendered.html = transformBodyImages(rendered.html, images)`; `store.set(...)`. Include a pure
  `rowToPageEntry(row)` export (like `rowToEntryInput`) for unit testing.
- `site/src/content.config.ts` — register a `pages` collection:
  ```ts
  const pages = defineCollection({
    loader: postgresPagesLoader(),
    schema: () => z.object({ title: z.string() }),
  });
  export const collections = { trips, pages };
  ```
- `site/src/components/pages/AboutPage.astro` — remove the hardcoded `intro`. Load
  `getEntry('pages', 'about/' + locale)`; render its `<Content />` (the rendered body HTML) inside
  the existing `.prose` container; H1 = `entry?.data.title || t('about.title')`; page
  `description` = a text excerpt of the body (or `t('about.title')` fallback). If the entry is
  missing (shouldn't happen post-seed), fall back to `t('about.title')` + empty body so the build
  never fails.

### Content pipeline (keyboard → published About page)

1. Admin opens `/admin/about.html`, edits DE/EN heading + Markdown, uploads inline photos
   (→ `/upload`, keyed `pages/about/…`, returns Markdown image snippet + dims).
2. **Save** → `PUT /pages/about` (admin) upserts both `pages` rows, then triggers `builder.build()`.
3. Build: the `postgresPagesLoader` reads the rows, renders + sanitizes + injects `<picture>`; the
   `about/<locale>` entries populate the `pages` collection.

Page `<meta description>`: derive it from the rendered body — strip tags to plain text and
`slice(0, 150)` (matching today's `intro.slice(0, 150)` in `AboutPage.astro:20`); fall back to
`t('about.title')` when the body is empty.
4. `AboutPage.astro` renders the entry; the atomic release swaps in the updated page.

## Error handling

- Blank title → i18n fallback at render; blank body allowed.
- Bad `key`/locale/body shape → 400 from `PUT`/`save`.
- Build failure after save → returned in the response and shown in the editor; the previous release
  keeps serving (atomic symlink only flips on success).
- Missing `pages` rows at build time → AboutPage falls back; build never breaks.
- Upload keys validated by the existing `assertSafeKey` (no traversal).

## Testing (Vitest, per Golden Rule 1)

- **uploader** — `pages.ts`: `memoryPageStore` get/save; key/locale validation (`PageError`);
  `pgPageStore` round-trip gated on `TEST_DATABASE_URL` (like `pg.integration.test.ts`); `get`
  returns empty pair when rows absent. `server.ts`: `PUT /pages/:key` 401 (unauth) / 403 (non-admin)
  / 200 (admin, triggers build via a stub builder); `GET /pages/:key` returns the pair. `backup.ts`:
  dump/restore now includes `pages`.
- **site** — `pages-loader.ts`: `rowToPageEntry` pure mapping (id `about/de`, body, title, images);
  a test that the loader path applies `transformBodyImages` (sanitize + `<picture>`), reusing the
  existing body-images fixtures. `npx astro check` stays clean (requires a reachable Postgres, as
  today).
- Unchanged: all existing suites; `transformBodyImages` sanitization tests now also guard About.

## Files

- `uploader/src/db.ts` — `pages` DDL + idempotent seed in `ensureSchema`.
- `uploader/src/pages.ts` (new) — `PageStore` (memory + pg), types, validation.
- `uploader/src/server.ts` — `GET`/`PUT /pages/:key`; `ServerConfig.pages`; `/pages` in `ADMIN_PREFIXES`.
- `uploader/src/main.ts` — wire `pgPageStore(pool)`.
- `uploader/src/backup.ts` — include `pages` in dump + restore.
- `uploader/public/about.html` (new) — the editor; admin-nav "About" link.
- `site/src/lib/pages-loader.ts` (new) — `postgresPagesLoader` + `rowToPageEntry`.
- `site/src/content.config.ts` — register the `pages` collection.
- `site/src/components/pages/AboutPage.astro` — render from the collection; H1 from DB title.

## Migration & rollout

1. Feature branch `feature/editable-about-page`.
2. `ensureSchema` creates + seeds `pages` on next app start (safe on the existing DB; additive).
3. After deploy, the About page renders the seeded placeholder (identical text to today) until the
   author edits it in `/admin/about.html` → Save → live.
4. Rollback: dropping the feature reverts `AboutPage.astro` to the hardcoded text; the `pages` table
   is harmless if left in place.

## Out of scope

- Imprint/privacy or any other static page; page-creation UI; hero image for About; draft/publish
  for pages; the travel-map issue (tracked separately).
