# Design — WordPress → Postgres Content Import (Phase 2)

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — ready for implementation planning
**Builds on:** Phase A (Postgres content pipeline) + Phase B (in-admin editor, `posts` table,
`postStore`, image pipeline). Brings the real blog content in; the migrated drafts are refined and
published with the Phase B editor.

## Problem

The blog renders from Postgres, but Postgres only holds 2 stub posts. The real content — **9
bilingual travel posts (18 DE/EN rows)** — still lives in the legacy WordPress site (Hello Elementor
theme + Elementor 4.1.2 + Polylang). We need to import it into Postgres without hand-retyping, while
**preserving the live SEO slugs exactly**.

## Goals

- Import the WordPress posts into Postgres as **draft** `PostPair`s, **from the admin UI** (upload a
  WordPress export file).
- Extract **the data, not the Elementor layout**: clean Markdown (headings, paragraphs, lists, links,
  images) — Elementor wrappers/styling/buttons discarded.
- **Re-host images** through the existing uploader pipeline (optimized variants + img-server URLs +
  dimensions).
- **Preserve the live slugs** exactly (DE at root, EN under `/en/`) and the DE↔EN pairing.
- Be **idempotent** (re-runnable as we tune conversion) and **never touch published posts**.
- Leave the migrated posts as drafts to **refine + enrich (country/region/coordinates/keyFacts) in
  the Phase B editor**, then Publish.

## Non-Goals (YAGNI)

- No attempt to reproduce Elementor's visual layout (columns, styled fact-boxes, CTA buttons).
- No auto-extraction of the structured travel fields (country/countryCode/region/coordinates/keyFacts)
  — those are filled in the editor.
- No live WordPress API dependency — input is an **export file** the user uploads.
- No comments/categories/tags/menus/pages import — **posts only**.
- No automatic publish — import produces drafts; publishing stays a deliberate editor action.

## Source facts (verified against the real export, `uploader/tmp/*.xml`, gitignored)

- WXR 1.2 export, 1061 items; **18 `post` items with status `publish` = 9 DE/EN pairs**.
- **Language** per item: `<category domain="language" nicename="de|en">`.
- **DE↔EN pairing:** both translations share a `<category domain="post_translations" nicename="pll_…">`
  group value (e.g. `pll_64271b55a257e` → `yucatan-tauchen-und-abenteuer` (de) / `yucatan-diving-and-adventure` (en)).
- **Body text** is in `content:encoded` as real HTML (`<h2>/<p>/<ul>/<img>`) wrapped in Elementor
  markup — so HTML→Markdown works directly; `_elementor_data` (also present) is a fallback only.
- **Slug** = `wp:post_name` (DE and EN distinct); **date** = `wp:post_date`.
- **Hero** = `_thumbnail_id` postmeta → the matching `attachment` item's `wp:attachment_url`
  (e.g. `https://simonswanderlust.com/wp-content/uploads/2021/02/Featured-…webp`).
- **Body images** = `<img src="https://simonswanderlust.com/wp-content/uploads/…">` in `content:encoded`.

## Architecture

All in the **uploader** (behind the login). A multipart upload of the `.xml` to a new endpoint runs
the importer in-process, reusing the Phase A/B `postStore` and image pipeline.

| Unit | Responsibility | Location |
|------|----------------|----------|
| `wxr-parse` | Parse the WXR XML → `{ attachments: Map<id,url>, posts: ParsedPost[] }`; group DE/EN by `post_translations`; read language/slug/date/title/excerpt/content/thumbnailId/body-img URLs | `uploader/src/wxr-parse.ts` |
| `wp-content` | HTML → clean Markdown (turndown), discard Elementor chrome; rewrite body `<img>` to placeholders the importer fills after re-hosting | `uploader/src/wp-content.ts` |
| `wp-images` | Download a WP media URL, run it through `processImage`/`storeVariants`, return `{src,width,height}` | `uploader/src/wp-images.ts` |
| `wp-import` | Orchestrate: pair → convert → re-host hero + body images → assemble draft `PostPair` → upsert via `postStore` (idempotent by slug) → collect a summary | `uploader/src/wp-import.ts` |
| `POST /import` | `requireAuth`, multipart; receives the `.xml`, runs `wp-import`, returns the summary | `uploader/src/server.ts` |
| import page | Upload form + result summary; linked from Posts | `uploader/public/import.html` |

### ParsedPost (from `wxr-parse`)

```
interface ParsedPost {
  group: string;            // post_translations nicename (DE/EN share it)
  locale: 'de' | 'en';      // language category nicename
  slug: string;             // wp:post_name
  title: string;
  date: string;             // YYYY-MM-DD from wp:post_date
  excerpt: string;          // excerpt:encoded, else ''
  contentHtml: string;      // content:encoded
  thumbnailId: string | null;     // _thumbnail_id
  bodyImageUrls: string[];  // <img src> from content (wp-content/uploads…)
}
```

### Conversion (`wp-content`) — data, not layout

`htmlToMarkdown(html)` uses **turndown** to extract headings, paragraphs, lists, links, blockquotes,
and images, **dropping** Elementor wrapper `<div>`s, inline styles, icon/CTA widgets, and empty
nodes. Output is clean Markdown. Body images are converted to `![alt](ORIGINAL_WP_URL)` first; the
importer then rewrites each `ORIGINAL_WP_URL` to the re-hosted img-server URL and records dims in the
`images` map. (Fallback: if `content:encoded` has no real text, walk `_elementor_data` text/heading/
image widgets — guarded; not expected for the current 18.)

### Image re-hosting (`wp-images`)

For the hero (`thumbnailId` → attachment URL) and each body image URL: **download** the bytes from
the WP media URL, run `processImage` + `storeVariants` under key `trips/<slug>/<name>` (name derived
from the original filename, slugified), yielding `{ src, width, height }`. Hero → `heroImage`
(alt defaults to the post title until edited); body → the markdown `![alt](src)` + `images[src] =
{width,height}`. **Requires the WP media URLs to be reachable** during import (the live site, or an
`uploads/` mirror). A failed image download is logged as a warning and that image is skipped (the
draft still imports).

### Assembly + write (`wp-import`)

Pair DE+EN by `group`. For each pair, build a draft `PostPair`:
- `de`/`en`: `slug` (from `wp:post_name`), `title`, `excerpt`, `heroImage`, `bodyMarkdown`, `images`.
- `shared`: `date`; **placeholders** for `country=''`, `countryCode='XX'`, `region='europe'`,
  `coordinates={lat:0,lng:0}`, no `stops`/`route`/`keyFacts`. (Empty `country` makes
  `validateForPublish` fail until enriched, so placeholder geo can't be published by accident.)
- Upsert as **draft** via `postStore.upsertDraft` (idempotent by `(locale, slug)`; a published post
  is left untouched — slug-lock).
A pair missing one locale, or a post missing required pieces, is recorded as a **warning/skip**, not a
crash. Returns `{ imported, updated, skipped, warnings: string[] }`.

### Endpoint + UI

`POST /import` (`requireAuth`, multipart): reads the uploaded `.xml`, calls `wp-import`, returns the
summary JSON. Synchronous (≈1–2 min for 9 pairs + images — matches the Publish UX; the page shows an
"Importing…" state). `public/import.html`: a file input (`.xml`), an **Import** button, and a result
panel listing imported/updated/skipped counts + warnings; a link to **Posts** to refine the drafts.

## Error handling

- Not a valid WXR / no posts → `400 {error}` with a clear message.
- Per-post conversion error → skip that post, add a warning; the rest proceed.
- Image download/processing failure → skip that image, warn; the draft still imports.
- DB/`PostError` (e.g. a slug already used by a *published* post) → skip with a warning (never
  overwrite published content).
- `/import` is `requireAuth`; anonymous → 401 (the page redirects to `/login`).
- Multipart size: the export is ~7.6 MB; the uploader's 25 MB limit covers it.

## Testing

Vitest (no live services; a trimmed real-export fixture under `uploader/test/fixtures/`):
- `wxr-parse`: extracts language/slug/date/title/excerpt/content/thumbnailId/body-img URLs; groups DE/EN
  by `post_translations`; ignores non-post items; resolves attachment id→url.
- `wp-content`: Elementor HTML snippet → clean Markdown (headings/paragraphs/lists/images kept,
  wrapper divs/styles/buttons dropped); body `<img>` → `![alt](url)`.
- `wp-images`: with an injected downloader + a stub image pipeline, returns `{src,width,height}` and
  the importer rewrites refs + records dims (no real network in tests).
- `wp-import`: with in-memory `postStore` + stubbed image step, a fixture export yields the expected
  draft `PostPair`s (paired, placeholders set, slugs preserved); idempotent re-run updates not
  duplicates; a published-slug collision is skipped with a warning.
- `POST /import` via `inject`: `requireAuth` gating; a fixture `.xml` upload returns the summary.

Gates: `npm test` + `npm run typecheck` (uploader). No `any`/`@ts-ignore`.

## Workflow after import (for the operator)

1. Admin → **Import** → upload the WP export → drafts created.
2. Admin → **Posts** → open each draft → fix any conversion artifacts, fill country/region/
   coordinates/keyFacts (+ hero alt), verify slugs → **Publish** (builds + exports).

## Dependencies

- New uploader deps: **turndown** (HTML→Markdown) and **fast-xml-parser** (WXR parsing) — both small,
  widely used, dependency-light.

## Risks

- **Image reachability:** re-hosting downloads from `simonswanderlust.com/wp-content/uploads/…`; the
  live media must be up during import (or provide an `uploads/` mirror). Failures degrade to warnings.
- **Conversion artifacts:** Elementor→Markdown will leave some rough edges; acceptable because each
  post is reviewed in the editor before publish. `_elementor_data` fallback covers thin-content posts.
- **Slug contract:** slugs come verbatim from `wp:post_name`; the importer never renames, and never
  overwrites a published post.
- **Synchronous import duration:** ~1–2 min held request; fine for a one-time admin action (a
  background job is a future option if it grows).
