# Basic pages, route reservation and navigation contract (issue #287)

**Date:** 2026-10-27 · **Risk:** high (shared root URL namespace, Golden Rule 2, `db.ts` schema,
dump version, a new author-controlled URL sink in `Nav.astro`/`Footer.astro`) · **Size:** large

**Status: OWNER APPROVED, 2026-10-27.** The owner selected **“Approve proposed page contract”**
for PR #407 at `dcf775e25034547764e9c9e48a2c94feb6e78413`: fixed page kinds, About's existing
URLs and undeletable status, reserved-route/cross-content guards, Postgres navigation, and
published pages continuing to save live. Story-slug reservation and grandfathering remain in
scope. Implementation (#288/#289) must preserve every documented invariant.

**Epic:** #286 · **Prerequisite:** #283's language contract (owner-approved 2026-10-27) · **Blocks:** #288
(store/API/editor), #289 (rendering/nav), #308 (journey routes reuse the reserved-route contract)
· **Baseline:** `dev` at `11e16d1`. The issue was planned against `9e400f9`; all the evidence below
was re-checked at `11e16d1`.

## How this spec handles #283

#283 was approved in the same owner decision batch. The applicability labels below distinguish
today's mode from the additional approved modes:

- Everything **not** marked *Conditional on #283* applies to the only mode that exists today:
  **DE+EN, DE-primary**. DE is at the root and EN is under `/en/`. That is unchanged and needs no
  #283 decision.
- Sections marked **Conditional on #283** apply when #283's approved mode support is implemented:
  `docs/superpowers/specs/2026-10-27-issue-283-language-mode-contract.md` on
  `feature/issue-283-locale-contract-design` (PR #406). Any later change to that contract requires
  reconciling these sections before implementation.
- The reservation model is written in terms of **namespaces** (the root, or a locale prefix), not
  locales, so a mode change only reassigns locales to namespaces. The rules stay the same.

## Problem

Only About is editable. `uploader/public/about.html:73` hardcodes `KEY = 'about'`, and its two
routes are fixed files (`site/src/pages/uber-mich.astro`, `site/src/pages/en/about-me.astro`,
`site/src/lib/paths.ts` `aboutPath`). Nav and Footer links are hardcoded:
`site/src/components/Nav.astro` (stories, map, about) and `site/src/components/Footer.astro` (about,
plus a literal Instagram URL). Contact, privacy and legal pages need short URLs, and those URLs
share a namespace with DE story slugs, which `site/src/pages/[slug].astro` renders at the root.

Nothing protects that namespace today:

- `checkSlug` (`uploader/src/posts.ts:240-242`) checks the format only (`SLUG_RE`
  `^[a-z0-9][a-z0-9-]*$`). A DE story can take `karte`, `reiseziele`, `uber-mich`, `en`, `admin`,
  `map`, `feed`, or any app prefix.
- The WXR importer applies the same `isSafeSlug` (`uploader/src/wp-import.ts:793`).
- Fastify matches exact API routes before the `/` static blog mount (`server.ts:373-379`,
  `redirect: true`). So for a story slug `posts`, `/posts` reaches the API instead of the 301 to
  `/posts/`. `/admin/*` (`server.ts:338`) and `/map/*` (`server.ts:385-389`) are static mounts
  that shadow a story at `/admin/` or `/map/` **completely**.
- `legacyRedirect` runs only after every static mount misses (`server.ts:2190-2195`). A story slug
  `feed` would build `/feed/index.html`, and `/feed` would then 301 to `/feed/` instead of to
  `/rss.xml`. That breaks feed subscribers.
- `PUT /pages/:key` (`server.ts:1940-1976`) accepts **any** safe key, saves, and rebuilds. Nothing
  renders a key other than `about`, but such rows are possible.

### Verified starting points (at `11e16d1`)

| Fact | Evidence |
|---|---|
| `pages (key, locale, title, body_markdown, images, updated_at)`, PK `(key, locale)` | `uploader/src/db.ts:190-200` |
| About is re-seeded on every boot, `ON CONFLICT DO NOTHING` | `db.ts:201-208` |
| `page_revisions`, capped at `REVISION_CAP`. The comment says "Pages are never deleted, so no orphan sweep is needed" | `db.ts:209-223`, `pages.ts:170-182` |
| `GET /pages/:key` and the revision reads use `requireAuth`; `PUT` uses `requireAdmin`; `PUT` saves, then `builder.build()` | `server.ts:1934-1991` |
| The page loader loads **every** row, with ids `key/locale` | `site/src/lib/pages-loader.ts:41-51` |
| The only consumer is `getEntry('pages', 'about/<locale>')` | `site/src/components/pages/AboutPage.astro:20` |
| Dump `DUMP_VERSION = 10`. Pages are dumped as `key, locale, title, body_markdown, images`. Restore deletes and reinserts `pages` but **does not touch `page_revisions`** | `backup.ts:37-39,172,897-906` |
| MDX export has no pages | `uploader/src/export.ts` (no reference) |
| `settings.json` is outside the logical DB dump | `ARCHITECTURE.md` §Backups & disaster recovery |
| Media usage counts page bodies (delete guard) | `server.ts:589-590`, `main.ts:108-109` |
| Post slug uniqueness runs in the transaction under `lockPostPair`. A published post's slug is locked (`slug_locked`) | `posts.ts:940-952`, `post-pair-lock.ts:6-8` |
| Draft preview is `requireAuth`, `no-store`, with the deny-by-default `previewCsp` | `server.ts:396,1490-1504`, `preview.ts:154` |
| Body sanitize uses `rehype-sanitize`'s `defaultSchema` (href protocols `http`, `https`, `mailto`, …) | `site/src/lib/body-images.ts:90-95` |

## Scope and non-goals

**In scope (decisions only):** the page set, page slugs and routes, the reserved-route table and
how it is derived, collision rules in both directions (including grandfathering and WXR), page
lifecycle (draft, preview, publish, delete, revisions), the navigation model, nav URL policy, nav
storage and backup, locale coverage, contact and legal page structure, misuse cases, compatibility
and rollback.

**Out of scope:** implementation; forms or any contact backend; email collection or sending; a
block or page builder; arbitrary HTML/JS; legal text or legal advice; cookie banners; social link
storage (owned by #273/#274); changing any existing URL.

## Decisions (each needs owner approval)

### D1 — Page set: a fixed list of kinds

**Recommendation:** a closed registry of **four kinds**, one page per kind: `about`, `contact`,
`privacy`, `legal`. The page `key` **is** the kind, so About keeps key `about` and its rows are
untouched. The registry is a pure constant in a new shared module
`site/src/lib/page-kinds.ts`. The uploader imports it the same way `body-content.ts` already
imports `site/src/lib/gallery-layout.ts`. Each entry declares:

| Kind | Default slug DE / EN (suggested in the editor, editable before first publish) | Deletable | Unpublishable | Default nav slot |
|---|---|---|---|---|
| `about` | fixed `uber-mich` / `about-me` (route files, not stored, never editable) | **no** | **no** | header + footer |
| `contact` | `kontakt` / `contact` | yes | yes | footer |
| `privacy` | `datenschutz` / `privacy` | yes | yes | legal strip |
| `legal` | `impressum` / `legal-notice` | yes | yes | legal strip |

`PUT /pages/:key` refuses a key outside the registry (400 `unknown_page_kind`). Rows that already
exist under a non-registry key (possible today through the open `PUT`) are **kept and inert**.
They are not rendered, not deleted at boot (Golden Rule 3), and listed once in the boot log. An
admin can remove them with `DELETE /pages/:key`.

**Rejected:**
- *Admin-created pages with free keys.* That is an unbounded set of claims on the root namespace,
  a page-builder slope (an epic non-goal), and needs nav and sitemap UX for a set of unknown size.
  The fixed set covers every page the epic names. A fifth kind is a one-line registry change with
  its own review.
- *Pages under a dedicated prefix* (e.g. `/seite/<slug>/`). This removes most collisions, but
  `/impressum/` and `/datenschutz/` are the conventional, expected short URLs on a German site.
  Collision handling is needed anyway, for stories versus fixed routes (owner decision
  2026-10-19), so the prefix buys little. **Owner option:** choose it if short URLs are not wanted.

### D2 — Slugs and the reserved-route contract

#### D2.1 Page slugs

- About has no stored slug. It keeps `/uber-mich/` and `/en/about-me/` as route files. Its rows
  store `slug = ''`, meaning "fixed route", and the store refuses any other value for `about`.
- Other kinds store one slug per locale in a new `pages.slug` column (D3 schema), using the same
  `SLUG_RE` as stories. `''` means "unset" and is allowed only while the page is a draft (#119
  precedent).
- **Slug lock:** a page slug can be changed freely while the page has never been published. After
  the first publish it is locked (409 `page_slug_locked`), as for posts. To move a published
  page, the admin unpublishes or deletes it and recreates it. There are no automatic redirects.
  **Rejected:** a confirmed change like #122's draft rename. A published page URL is a live URL
  (Golden Rule 2), and pages have no redirect table.
- Uniqueness: `CREATE UNIQUE INDEX pages_locale_slug_idx ON pages (locale, slug) WHERE slug <> ''`.

#### D2.2 Namespaces

A **namespace** is the first-path-segment space in which a single-segment slug becomes a URL:

| Namespace | Holds today (DE+EN, DE-primary) |
|---|---|
| `root` (`/<seg>/`) | DE story slugs, DE page slugs, every app route, the DE fixed site routes, locale prefixes, legacy WP paths |
| `en` (`/en/<seg>/`) | EN story slugs, EN page slugs, the EN fixed site routes, the EN legacy WP paths |

A slug is checked against **its own namespace only**. App routes live at the root only, so they
do not constrain EN slugs while EN is under `/en/`.

#### D2.3 Reserved-route table (today, DE-primary)

Reservation is by **first segment**, exact match (slugs are lowercase by `SLUG_RE`, so
case-folding is not needed). The "Effect" column shows why each segment is reserved. Every
segment is reserved regardless of how severe its shadow is.

**Namespace `root`:**

| Segment(s) | Owner type | Source of truth | Effect if a slug held it |
|---|---|---|---|
| `admin` | app (static mount + routes) | `server.ts:331,338` | `/admin/` serves the admin UI: the story is fully shadowed |
| `map` | app (static mount, when `mapDir` set) | `server.ts:384-389` | `/map/*` serves the basemap: fully shadowed |
| `ai-config`, `ai-providers`, `api`, `auth`, `backups`, `comments`, `export`, `geocode`, `gpx`, `health`, `import`, `login`, `logout`, `media`, `moderation`, `pages`, `posts`, `rebuild`, `settings`, `setup`, `upload`, `users` | app (Fastify routes) | the registered route table (`server.ts`, `comments-public.ts`, `gpx-routes.ts`, …) | the bare path `/<seg>` answers the API (JSON, 401/404) instead of the 301 to `/<seg>/`. Deeper app routes (`/media/items/*`, …) can also overlap |
| `karte`, `reiseziele`, `uber-mich`, `404` | site (fixed routes) | `site/src/pages/*` | duplicate output path: one of the two pages is lost |
| `en` | locale prefix | `astro.config.mjs` i18n + `site/src/pages/en/` | `/en/` is the EN home |
| `de` | locale prefix (reserved now for #283) | #283 | free today. Reserved so an EN-primary install never meets a grandfathered `/de/` story |
| `feed`, `category`, `comments` | legacy redirect | `uploader/src/redirects.ts` `LEGACY_REDIRECTS` | the static `/<seg>/` would win over the 301 (`/feed` → `/rss.xml` breaks) |

**Namespace `en`:**

| Segment(s) | Owner type | Source of truth | Effect |
|---|---|---|---|
| `map`, `destinations`, `about-me` | site | `site/src/pages/en/*` | duplicate output path |
| `feed`, `category`, `comments` | legacy redirect | `redirects.ts` (`/en/feed…`, `/en/category/…`, `/en/comments/feed`) | the static page wins over the 301 |

**Pages and stories reserve against each other** in the same namespace (owner types `page` and
`story`). See D2.5.

**Excluded by format, not by table:** `_astro`, `rss.xml`, `robots.txt`, `favicon.svg`,
`sitemap-index.xml`, `sitemap-0.xml`, `404.html`. `SLUG_RE` cannot produce a leading `_` or a `.`.
The tests below still check this, so a future `SLUG_RE` widening cannot slip past it.

The issue's own list of 22 app prefixes plus `/map/` was already stale at this baseline: `gpx`
(`gpx-routes.ts:71-105`) arrived later. That is the concrete reason the list must be derived,
not hand-kept.

#### D2.4 Where the table lives and how it is kept honest ("derived from or tested against")

- **One shared pure module, `site/src/lib/reserved-routes.ts`**, with no `astro:` imports. It is
  imported by the site build and by the uploader (precedent: `body-content.ts` →
  `gallery-layout.ts`). It exports:
  - `RESERVED: Record<Namespace, ReadonlyArray<{ segment: string; owner: 'app' | 'site' | 'locale' | 'legacy' }>>`
  - `reservation(namespace, slug): { owner, segment } | null`, which covers **static**
    reservations only.
  - `namespaceOf(locale, mode)`, which today returns `'root'` for `de` and `'en'` for `en`
    (*Conditional on #283* for other modes).
- The literal lists in that module are kept honest by **equality tests**. A subset test would
  miss a stale entry, and a stale entry needlessly blocks a slug:
  1. **App (uploader test):** build the server with every optional feature enabled (`gpx`,
     `mapDir`). Collect each registered route URL through an `onRoute` hook. Take the first
     segment and drop the root wildcard `/*` of the blog and image mounts. Assert the set
     **equals** the `app` entries. Conditional registrations (`if (cfg.gpx)`, `if (cfg.mapDir)`)
     are reserved unconditionally.
  2. **Legacy (uploader test):** the first segments of `LEGACY_REDIRECTS` sources, per namespace,
     **equal** the `legacy` entries.
  3. **Site (site Vitest):** walk `site/src/pages/**`. For each static file or directory (not
     `[param]`, not `index`), take its first segment per namespace, removing the extension, so
     `rss.xml.js` becomes `rss.xml`. Assert every one is either in `site`/`locale` entries or
     excluded by `SLUG_RE`, and that every `site` entry exists in the tree.
  4. **Format guard:** every format-excluded name in D2.3 fails `SLUG_RE`.
- Adding an app route, a site route or a route family (e.g. #308's `/reisen/` and
  `/en/journeys/`) therefore fails CI until its first segment is added to the module **in the
  same change**. That is the hook for the reverse direction (D2.6).

#### D2.5 Collision rules (both directions)

At save time, a slug `s` in namespace `N` is refused with **409 `reserved_slug`** when any of these
holds:

| # | Writer | Refused when | Grandfathered? |
|---|---|---|---|
| C1 | page save (`PUT /pages/:key`) | `reservation(N, s)` is not null | no (pages are new) |
| C2 | page save | a story in `N` holds `s`: the working copy **or** the published snapshot of any post | no |
| C3 | page save | another page in `N` holds `s` (the unique index, mapped to 409) | no |
| C4 | story save (`upsertDraft`: editor, bulk, WXR) | `reservation(N, s)` is not null **and** `s` is new or changed for this row | **yes**, see D2.5.1 |
| C5 | story save | a page in `N` holds `s` (draft or published) **and** `s` is new or changed | yes, same rule |
| C6 | story save | another story holds `s` | existing `duplicate_slug`, unchanged |

Response body: `{ error, code: 'reserved_slug', owner: { type, name } }`. `name` is the reserved
segment or the page **kind**. It never contains a draft page's title or a draft story's title, so
an author-level story save cannot read unpublished admin content through the error.

**Race:** posts and pages are different tables, so no database constraint can hold the
cross-table rule. Every writer that checks C1–C5 first takes a **namespace advisory lock**
(`pg_advisory_xact_lock` on a fixed key, distinct from the pair lock and the app/restore lock)
inside its transaction and runs the check under it. Lock order: a post save takes `lockPostPair`
**first**, then the namespace lock. Page and nav writers take only the namespace lock. No writer
takes them in the other order, so there is no deadlock cycle. The build guard (D2.7) is the
backstop.

##### D2.5.1 Grandfathering (owner decision 2026-10-19, mechanism proposed here)

- **Identification:** a slug is grandfathered **for a row** when the stored row
  `(translation_key, locale)` **already holds exactly that slug** at the time of the save
  (`existing[locale].slug === s`, read under `lockPostPair` in `upsertDraft`). There is no
  allow-list file and no ship-time snapshot. Because C4/C5 refuse every *new or changed*
  reserved slug, the grandfathered set can only shrink after this ships.
- **Saving:** a grandfathered row saves, publishes and re-publishes normally. Changing its slug
  away from the reserved word is allowed. Changing it back is refused.
- **WXR re-import:** the importer's pair identity (#99, `wp-import.ts:796-808`) binds a group to a
  stored pair only when both slugs match that pair. A matched draft pair merges or overwrites
  through `upsertDraft` with unchanged slugs, so it is grandfathered by the same rule. A matched
  published pair stays `skippedPublished`, as today.
- **First-time WXR import** of a slug that is reserved (no stored pair holds it): **rejected
  before any fetch** (`summary.rejected`, warning `"<de>/<en>: slug reserved by <owner> — rejected,
  nothing written"`). Admitting it would *create* a grandfathered row, which would be a loophole
  in C4, and the shadow it would suffer is real. The checked-in MDX slugs
  (`reisebericht-4-tage-bukarest`, `sonne-und-abenteuer-rhodos`, `4-day-travel-report-bucharest`,
  `sun-and-adventure-on-rhodes`) collide with nothing. [INFERENCE, not verified against the
  production database] The nine imported WordPress pairs are not known to collide either; the
  read-only D2.6 query, run before #288 deploys, verifies this. **Owner question Q4.**
- **Rejected:** grandfathering "any slug that was live on WordPress". The app cannot know that
  for a slug it never stored, and it would turn the importer into a way to claim `admin` or `map`.

#### D2.6 Reverse direction: a new reserved segment vs existing content

When a change adds a reserved segment (new app route, site route, journey prefix), stories or
pages may already hold it:

1. CI (D2.4) forces the module update.
2. **Boot report:** after `ensureSchema`, the app runs one read-only query. It lists every
   story and page slug, working copy and published snapshot, that equals a static reservation in
   its namespace. Each hit is logged as `reserved-route collision: <namespace>/<slug> (<owner>)
   held by story|page`. Slugs are public data, not secrets. Grandfathered stories show up here
   indefinitely, which is intended: the operator can see the shadow.
3. **Rollout rule for any such change:** the PR states the result of the same query run read-only
   against production before merge. If a **published** story holds the new segment, the change
   needs a different segment or explicit owner authorization (Golden Rule 2). The app never
   renames a story.

#### D2.7 Build-time guard (implemented in #289)

The site build collects every path it will emit (stories, pages, fixed routes, region pages) and:

- **fails** with a message naming both owners if two entries produce the same path, or if a
  **page** path's first segment is reserved. Pages have no grandfathering, so this can only mean
  a restore or a hand edit got past C1–C3. A failed build keeps the previous release serving
  (`build.ts` release swap).
- **fails** if a story's path equals a fixed **site** route path or a locale prefix. That output
  is broken in any case: one file is lost.
- **warns but does not fail** for a story whose slug equals an **app** or **legacy** segment. Such
  a story can only be grandfathered, and failing the build would break Publish for every other
  post.

[INFERENCE, not measured] Astro may already warn on a dynamic path that duplicates a static route.
The guard does not rely on that.

#### D2.8 *Conditional on #283*: reservations in other modes

These apply only if #283 is approved as proposed (primary locale at root, secondary under its own
prefix, `de` and `en` reserved as first segments in every mode, mode locked after first publish):

| Mode | Locale in `root` | Prefixed namespace and its `site` segments | `site` segments in `root` (besides `404`) |
|---|---|---|---|
| DE+EN DE-primary | DE | `en`: `map`, `destinations`, `about-me` (D2.3) | `karte`, `reiseziele`, `uber-mich` (D2.3) |
| DE-only | DE | none | `karte`, `reiseziele`, `uber-mich` |
| DE+EN EN-primary | EN | `de`: `uber-mich`, `karte`, `reiseziele` (`rss.xml` format-excluded) | `about-me`, `travel-map`, `destinations` |
| EN-only (root option) | EN | none | `about-me`, `travel-map`, `destinations` |
| EN-only (`/en/` option) | none (root serves only what #283 places there) | `en`: `map`, `destinations`, `about-me` | none |

In every mode, `root` also reserves all `app` segments (including `map`), all root `legacy`
segments, and the locale prefixes `de` and `en`. In every prefixed namespace, the matching
`legacy` segments (today only under `en`) are reserved too.

App and legacy reservations always apply to `root`. In EN-at-root modes, English app words
(`posts`, `media`, `login`, `settings`, `comments`) become likely slug candidates, so C4/C5 matter
more there. Grandfathering only ever matters within a single mode, because #283 refuses mode
changes after first publish. A fresh install in a new mode has no stored slugs to grandfather.

### D3 — Draft, preview and publish for pages

**Recommendation: a publish gate without snapshot isolation.** Pages get a pair-level status, but
published pages keep About's "Save = live" behaviour:

- Schema (additive, both `CREATE TABLE` and `ALTER … ADD COLUMN IF NOT EXISTS`):
  - `pages.slug text NOT NULL DEFAULT ''`
  - `pages.status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published'))`
  - `pages.published_at timestamptz`
  - Partial unique index `(locale, slug) WHERE slug <> ''`.
  - Boot backfill, idempotent: `UPDATE pages SET status='published', published_at=COALESCE(published_at, updated_at) WHERE key='about' AND status='draft'`.
    Other existing keys stay `draft`. None of them is rendered today, so nothing public changes.
  - The About seed inserts `status='published'` explicitly.
- States: `draft → published` (`POST /pages/:key/publish`, admin) and `published → draft`
  (`POST /pages/:key/unpublish`, admin, refused for `about`). The status is written to both
  locale rows in one transaction, the same pair-level semantics as `posts.status`.
- **Save on a draft page** stores it and does **not** rebuild. **Save on a published page** stores
  it and rebuilds, exactly as About today (`server.ts:1965-1966`). Publish, unpublish, delete of a
  published page, and nav saves each rebuild once.
- **Publish validation:** every enabled locale has a non-empty title, a non-empty body and a
  non-empty slug (About: title and body). The slug must pass C1–C3 again under the namespace lock.
  The body passes the existing foreign-image check (`publish-gate.ts` `foreignImageUrls`), the
  same rule as posts (#91).
- **Loader isolation:** `pages-loader.ts` selects `WHERE status = 'published' AND key = ANY(<registry kinds>)`.
  A draft or unknown-key row never reaches a build.
- **Preview:** `GET /pages/:key/preview?locale=` with `requireAuth` (the same boundary as
  `GET /pages/:key`). The response carries `no-store` and **the same `previewCsp(imageBase)`
  value**, renders through the same `renderMarkdown` + `transformBodyImages` path, and shows a
  banner from `ui.ts`. It works for drafts and published pages alike.

**Rejected:**
- *Full snapshot isolation (#20) for pages*, meaning `published_snapshot` plus a working copy and
  an explicit Publish for every edit. It would change About's editing flow, which #288's
  acceptance requires to stay "unchanged". It would also make media-delete honour page snapshots
  (`docs/superpowers/specs/2026-09-05-media-delete-honours-snapshot-design.md`) and double the editor states, for pages edited only
  by the one admin. **Owner option:** pick it if published pages should take staged edits.
- *Keep immediate publish with no status:* a new contact page would go live on its first save,
  half-written.

### D4 — Navigation model

#### D4.1 Slots

| Slot | Where it renders | Max items | Seeded default (reproduces today's output) |
|---|---|---|---|
| `header` | `Nav.astro`, between the site title and `LangSwitcher` | 5 | `builtin:stories`, `builtin:map`, `page:about` |
| `footer` | `Footer.astro` third column (today "About") | 8 | `page:about` |
| `legal` | a new footer bottom strip, rendered only if non-empty | 4 | empty |

**Social links are not nav items.** They render in a **fixed slot** that the nav config cannot
move or contain: inside the footer's third column, **after** the `footer` items, as a separate
`<ul>`. The list and its URLs come from #273/#274's identity settings (proposed: Postgres
`site_identity`, ordered, max 6, `https:` only). The nav editor shows them read-only with a link
to Settings. #274 lands first and replaces the hardcoded Instagram link in that slot. #289 then
adds the configured `footer` items above it. Neither PR moves the other's markup.

The `LangSwitcher` and the site-title link are fixed and not configurable.

#### D4.2 Items

One JSON document, `{ "version": 1, "header": Item[], "footer": Item[], "legal": Item[] }`. Array
order is display order.

```ts
type LocaleText = { de?: string; en?: string };
type Item =
  | { kind: 'builtin'; target: 'home' | 'stories' | 'map' | 'regions'; label?: LocaleText }
  | { kind: 'page'; target: 'about' | 'contact' | 'privacy' | 'legal'; label?: LocaleText }
  | { kind: 'path'; href: LocaleText; label: LocaleText }
  | { kind: 'external'; href: LocaleText; label: LocaleText };
```

- `builtin` URLs come from `paths.ts` (`homePath`, `homePath + '#stories'`, `mapPath`,
  `regionsIndexPath`). `page` URLs come from the page's stored slug, or About's fixed route. They
  are **resolved at build time**, so configuration never stores an internal URL that can go stale.
- Labels: `builtin` and `page` default to `ui.ts` keys (`nav.stories`, `nav.map`, `nav.about`, plus
  new `nav.contact`, `nav.privacy`, `nav.legal` in both locales, per Golden Rule 7). An optional
  per-locale override is author content. `path` and `external` need a label for each locale they
  render in.
- **Per-locale rendering:** an item renders in a locale only if it **resolves** there. That means
  a `page` that is published and has that locale, a `builtin` that exists in that locale, or a
  `path`/`external` with both `href[locale]` and `label[locale]`. An item that does not resolve is
  skipped. It is never rendered as a broken link.
- `aria-current="page"` for `builtin`/`page` items on their own path (the current
  `Nav.astro:14-16` logic, generalised).

#### D4.3 URL policy (validated at save in the uploader **and** again at build in the site)

- **External (`external.href.*`):** parsed with the WHATWG `URL` parser. The protocol must be
  exactly `https:`. No username or password. Non-empty hostname. At most 2048 characters. No ASCII
  control characters or whitespace in the raw input. Stored as `url.href`. Refused: `javascript:`,
  `data:`, `vbscript:`, `file:`, `http:`, `mailto:`, `tel:`, and anything that fails to parse.
- **Site-relative (`path.href.*`):** must match `^/(?![/\\])[A-Za-z0-9\-._~/%?=&#]*$`. It is a
  single leading `/`, not `//` (protocol-relative) and not `/\` (which browsers normalise to `//`).
  At most 512 characters. Additionally, `new URL(href, 'https://h.invalid').origin` must equal
  `'https://h.invalid'`.
- **At build:** the same rules run as a Zod refinement. In addition, a `path` item whose pathname
  (fragment and query removed) is not a path the build emits is **dropped with a build warning**.
  That keeps "no link to a page that does not exist" true for hand-entered paths too.
- **Labels:** strings with `\p{C}` stripped (the same rule as `cleanText`, #133), trimmed,
  1–40 characters, rendered only through Astro's escaped interpolation. There is **no `set:html`**
  anywhere in nav or footer rendering.
- **External link markup:** `rel="noopener noreferrer"`, `target="_blank"` (consistent with the
  current Instagram link), a visible `↗`, and a visually hidden "(opens in a new tab)" from
  `ui.ts`.

**Rejected:** `http:` (mixed security, never needed for a nav link); `mailto:` in nav (the contact
page carries the address in its body, D6). **Owner question Q7** if a `mailto:` nav item is wanted.

#### D4.4 Storage, API and backup

- **Postgres**, single row: `site_nav (id smallint PRIMARY KEY CHECK (id = 1), config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now())`. The default document is seeded with
  `ON CONFLICT DO NOTHING`.
- **API:** `GET /settings/navigation` and `PUT /settings/navigation`, both `requireAdmin`. The PUT
  takes an `updatedAt` echo and returns 409 `conflict` on a stale write; a valid PUT rebuilds. The
  routes sit under the already-reserved `settings` segment **on purpose**, so no new root segment
  is claimed (a `/navigation` route would collide with a possible story slug). The *store* is
  still Postgres, not `settings.json`. That is stated in code next to the route.
- **Build read:** the site reads it through a small Content Layer loader (`postgres-nav`, one
  entry), parsed by the Zod schema of D4.3. If the row is missing (dev or CI without the table),
  the site falls back to the **same default document**, exported from a pure site module, so
  output is unchanged. This mirrors how pages reach the build. **Rejected:** an env var like
  #273's `SITE_IDENTITY_JSON`. Nav and pages must come from the same database read of one build.
- **Dump:** `site_nav` joins the dump (`tables.site_nav`). `pages` gains `slug`, `status` and
  `published_at` in the dump. This takes **the next free `DUMP_VERSION`** at landing. #273 and #283
  also propose a bump; whichever lands first takes 11. `SUPPORTED_DUMP_VERSIONS` is widened in the
  same change.
- **Restore** (one transaction, as today) replaces `pages` and `site_nav` together. For older
  dumps:
  - **no `pages` key (v1):** pages and nav are left untouched, as today.
  - **no `site_nav` (≤ v10):** nav is left untouched.
  - **pages without `slug`/`status`:** the D3 backfill rule applies: `about` becomes published,
    every other key becomes draft with an empty slug.
  - Restore also deletes `page_revisions` whose key is no longer in `pages`, the same intent as
    #137's sweep.
  - The restore CLI's pre-restore summary (#114) adds two lines: the number of nav items that
    would not resolve after restore, and any page slug that collides with a story slug in the
    dump.
- **Coherence invariant:** *a rendered nav never links to a page that is not built.* Database
  integrity cannot guarantee this, because nav items reference page **kinds**, and dangling
  references survive restores of older dumps. It is guaranteed by **build-time resolution**
  (D4.2). The nav editor marks items that do not currently resolve ("page not published",
  "missing EN label").

**Rejected:** `settings.json`. It is outside the dump, so a restore could leave nav pointing at
pages the dump does not have, or drop nav altogether. It is also not transactional with page
deletes.

### D5 — Locale coverage

- **Today (DE+EN, DE-primary), unconditional:** a page needs **both** locales (title, body, slug)
  to publish. There is no per-page opt-out. About already has both. `hreflang`/`x-default` for
  pages follow `Base.astro`'s existing `alternates` (x-default is DE). Pages enter the sitemap
  automatically (`@astrojs/sitemap`, no filter) only once published. Pages are **not** in RSS and
  never have comments.
- ***Conditional on #283:*** pages are built only in the enabled locales. Per #283 §8.1, `pages`
  keeps both rows, and a disabled locale's content is kept, never wiped. Publish validation
  requires only the enabled locales. A page is never built empty. A nav item whose target does
  not exist in a locale is not emitted there (D4.2). The language switcher on a page without an
  alternate follows #283's untranslated-story fallback (the other locale's home).

### D6 — Contact information

**Recommendation: Markdown body only.** The contact page is an ordinary page whose body the admin
writes. It may contain an address or a `mailto:` link, which the existing sanitizer allows
(`defaultSchema` href protocols). There are **no structured fields** (email, phone, address
schema), **no form**, and the app **collects no email**. Nothing new is added to `SECURITY.md`'s
PII inventory: content the owner publishes about himself is public content.

**Rejected:** structured contact fields. That is a second schema, JSON-LD temptations, and a
validation surface, for one page the owner edits rarely.

### D7 — Delete behaviour

- `DELETE /pages/:key`, `requireAdmin`. Refused with **409 `page_fixed`** for `about`, and the UI
  has no delete control for About. This is needed because the boot seed (`db.ts:203-208`) would
  re-create it on the next restart anyway, and because `/uber-mich/` is a live URL. The same
  refusal applies to `unpublish` for About.
- **One transaction**, under the namespace lock:
  1. Delete the key's `pages` rows.
  2. Delete its `page_revisions`. As in #137, these are two statements, not a CTE, so a revision
     committed by a racing save is seen.
  3. Remove every nav item with `kind: 'page'` and `target = key` from `site_nav.config`, bumping
     `updated_at`.
  4. If the page was published, rebuild after commit.
- `GET /pages/:key/revisions[/:id]` returns 404 when the page does not exist. Boot sweep:
  `DELETE FROM page_revisions r WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.key = r.key)`.
  This replaces the `db.ts:213` comment "Pages are never deleted".
- **The confirmation names the scope** through the existing `admin-confirm.js`: page kind and the
  title per locale; the live URLs that will 404 (if published); the number of revisions that will
  be removed; every nav item that will be removed (slot and label); and a best-effort count of
  story and page bodies that contain the page path. That count is informational. Body links are
  not rewritten and become 404s.
- Images uploaded for the page (`pages/<key>/…` keys) stay in the media library. Deleting a page
  never deletes media.
- The slug is free again immediately after delete. A later story or page may take it, so the old
  URL would show new content. This is accepted and noted in the confirmation text.

### D8 — Legal pages: structure only

`privacy` and `legal` are kinds with **no seeded content**. They do not exist until the admin
creates them. The app ships no legal text, no templates and no legal advice. The editor shows a
static, `ui.ts`-sourced note that the content is the site owner's responsibility. The `legal`
footer strip renders only the items configured into it. No cookie banner is added. The app sets
no non-essential cookies on public pages, and this spec adds none.

## API surface (proposed, all under the existing `pages` / `settings` segments)

| Route | Auth | Change |
|---|---|---|
| `GET /pages` | `requireAuth` | **new**: list of kinds with status, slugs and titles (summary only) |
| `GET /pages/:key` | `requireAuth` | unchanged shape plus `slug`, `status`, `publishedAt` per pair/locale |
| `PUT /pages/:key` | `requireAdmin` | refuses unknown kinds; C1–C3; slug lock; rebuilds only if published |
| `POST /pages/:key/publish` · `/unpublish` | `requireAdmin` | **new** |
| `DELETE /pages/:key` | `requireAdmin` | **new**; About refused |
| `GET /pages/:key/preview` | `requireAuth` | **new**; `previewCsp`, `no-store` |
| `GET /pages/:key/revisions[/:id]` | `requireAuth` | 404 when the page is gone |
| `GET`/`PUT /settings/navigation` | `requireAdmin` | **new**; Postgres store |
| `PUT /posts…`, `POST /posts`, WXR import | unchanged auth | add C4/C5 under the namespace lock |

No new root segment is registered, so the app reservation set is unchanged by this design.

## Trust boundaries

- **Admin → page and nav writes.** These are the only writers of page slugs and nav URLs.
  Everything is validated server-side. Model output never reaches them.
- **Author → story saves.** An author can attempt a reserved slug and receives a 409 naming only
  a segment or page kind (no draft titles).
- **Author → `GET /pages*` and preview.** This is the same data `GET /pages/:key` exposes today,
  including drafts, which matches posts, where authors read drafts.
- **Database → build.** Nav and page rows are re-validated at build (Zod), so a restored or
  hand-edited row can never put a disallowed scheme into markup. The build fails closed on page
  collisions.
- **Built HTML → reader.** Nav labels and URLs are escaped interpolation only. Page bodies go
  through the existing `render-markdown` → `rehype-sanitize` → `transformBodyImages` path. No new
  post-sanitize injection is added.

## Misuse cases

| Misuse | Outcome |
|---|---|
| Nav item `javascript:alert(1)`, `JaVaScRiPt:`, `\tjavascript:`, `data:text/html,…` | 400 at save (protocol is not `https:`; control/whitespace refused). Re-refused at build. Never in markup |
| `//evil.example/`, `/\evil.example`, `https://user:pw@host/` | 400 (path grammar / origin check / credentials) |
| A 10 000-character label, NUL or bidi controls in a label | `\p{C}` stripped, length 1–40 enforced, 400 otherwise |
| A page slug `posts`, `admin`, `map`, `karte`, `en`, `de`, `feed` | 409 `reserved_slug` (C1) |
| A page slug equal to a live or draft story slug, and the reverse | 409 (C2, C5), in both creation orders |
| Two tabs saving a page and a story with the same slug concurrently | Serialized by the namespace advisory lock. The build guard is the backstop |
| An author sets a new story slug `settings` | 409 (C4). An existing story already holding a reserved slug keeps saving (grandfathered) |
| WXR first import of a group with DE slug `admin` | rejected before any fetch, nothing written |
| Re-adding a reserved slug after renaming away from it | refused (no longer held by the row) |
| A new app route `/nav` added in a future PR | CI fails until it is added to `RESERVED`. The boot report and the PR rule (D2.6) surface existing holders |
| `DELETE /pages/about`, `POST /pages/about/unpublish` | 409 `page_fixed`. About survives restart unchanged |
| `PUT /pages/anything` with an unknown key | 400 `unknown_page_kind` |
| Restore of a dump whose nav links to a page the dump lacks | Nav is restored. The item does not resolve and is skipped at build; the editor flags it |
| Restore of a dump where a page slug collides with a story slug | Pre-restore summary warns. The build fails closed and the previous release keeps serving until the admin fixes it |
| An author calls `PUT /settings/navigation` or publish/delete | 403 |
| A draft page reaching the public site through an unrelated rebuild | impossible: the loader selects `status = 'published'` only |

## Invariants

1. **Golden Rule 2:** no existing route changes. Every existing story, region, map, feed and About
   URL resolves to the same resource. About keeps `/uber-mich/` and `/en/about-me/`, is always
   published, and cannot be deleted or unpublished. No slug is ever changed by the app.
2. No new page or nav item can shadow, or be shadowed by, a story, a fixed site route, a locale
   prefix, a legacy redirect or an app route. Existing stories that already hold a reserved slug
   are grandfathered and reported, never renamed.
3. The reserved table equals the registered app routes, the legacy redirect sources and the site
   route tree (tested), so it cannot silently drift.
4. A rendered nav never contains a scheme other than `https:` or a site-relative path, and never
   links to an unbuilt page.
5. Page delete removes its revisions and its nav references atomically. No page revision outlives
   its page after a restore or at boot.
6. A draft page never reaches a build. A save of a draft page never rebuilds.
7. Pages and nav are inside the logical dump and restore together in one transaction.

## Compatibility, migration and rollback

- **Migration:** additive and idempotent in `ensureSchema`: three `pages` columns, a partial
  unique index, the About status backfill, the `site_nav` table with its seeded default, and the
  `page_revisions` orphan sweep. The existing About rows are not rewritten except for
  `status`/`published_at`. **Built output on the existing install is unchanged:** the seeded nav
  reproduces today's header and footer links, and #274 has already replaced Instagram. #289's
  test compares built header and footer link sets before and after.
- **Before deploying #288:** take an on-demand v10 dump (an older app cannot read v11), and run the
  D2.6 collision query read-only against production. Record the result in the PR.
- **Rollback:** redeploy the previous image tag. The old code ignores the new columns and table.
  It renders only `about`, and old `pages-loader` loads all rows, but no route of the old code
  renders a non-About key, so drafts stay invisible. The old Nav and Footer are hardcoded. The
  previous release directory keeps serving until the next build. To restore from backup, use the
  pre-change v10 dump. The new columns and table can stay; they are inert to the old code.
  **Containment:** a page or nav problem is fixed by unpublishing or deleting the page, or by
  resetting the nav document to the default, then rebuilding. None of these touches stories.
- **MDX export** stays posts-only. The DB dump is the backup of record for pages and nav. This is
  stated in `ARCHITECTURE.md` when implemented.

## Tests the implementation must add

**#288 (uploader):**
- Route-table equality for app reservations (all optional features on).
- Legacy equality.
- C1–C5 in both creation orders, for both stores (memory and pg).
- Grandfathered story: save, publish, slug change away, change-back refused.
- WXR: a matched draft re-import with a reserved slug succeeds; a first import is rejected with
  no fetch.
- Advisory-lock race (pg integration).
- Unknown kind 400; About delete/unpublish 409 and survival across `ensureSchema`.
- Page delete removes revisions and nav items in one transaction; revision item 404 after delete.
- Slug lock after publish; draft save does not rebuild; published save rebuilds.
- Author 403 on every admin route.
- URL policy table (each misuse row).
- Dump/restore round-trip of the new shape, and restore of v10 and v1 dumps (backfill, nav
  untouched, orphan revisions removed).
- Boot collision report.

**#289 (site):**
- Pages-tree equality for site reservations; format guard.
- Build guard fails on page collision and on story-vs-site-route, warns on grandfathered app
  collisions.
- `javascript:`/`data:` never reach built HTML (Zod and render).
- Unresolved nav items skipped per locale.
- Existing URL set and header/footer links identical on the existing install (built-HTML
  comparison).
- Keyboard and focus at 320px and desktop, both locales.

## Documentation to update when implemented (not before)

- `SECURITY.md`: §Input validation (nav URL policy), §Output sanitization (nav and page
  rendering), §Authorization (new page/nav routes), §Backups (nav in the dump).
- `ARCHITECTURE.md`: pages lifecycle, reserved-route module, nav store, dump version.
- `CLAUDE.md`: the High-risk list (reserved-route module, nav), the Golden Rule 2 note on
  grandfathering, and the D2.6 rollout rule.

## Self-review (devil's advocate)

- *"Grandfathering by the stored row is a loophole"*: only if something can write a reserved slug
  into a row without C4. Every story writer goes through `upsertDraft` (editor, bulk, WXR). The
  WXR first-import case is closed explicitly. **Restore** can write anything, by design. The boot
  report and the build guard make that visible, and pages fail the build closed.
- *"The shared module is still a hand-kept list"*: yes, but every list is under an **equality**
  test against the real source (Fastify registrations, `LEGACY_REDIRECTS`, the pages tree). That
  satisfies "derived from or tested against". A purely generated list would need the uploader at
  site build time, a dependency inversion this repo avoids.
- *"Immediate publish for published pages is unsafe"*: it is today's About behaviour, admin-only,
  with revisions and 409 conflict handling. Staged edits are an owner option (D3).
- *Residual:* a slug freed by a page delete can be taken by new content. Body links to a deleted
  page 404. Grandfathered app-segment stories remain partially shadowed (`/posts` → API) until an
  admin renames them. No such story is known today.

## Owner decisions requested

1. **Q1 (D1):** Approve the fixed set `about`, `contact`, `privacy`, `legal`, or allow
   admin-created pages, or put pages under a prefix instead of the root namespace?
2. **Q2 (D2.1):** Default slugs `kontakt`/`contact`, `datenschutz`/`privacy`,
   `impressum`/`legal-notice` (or `imprint`)? Page slugs locked after first publish?
3. **Q3 (D2.3/D2.4):** Approve the reserved-route table, the namespace model, and its home in
   `site/src/lib/reserved-routes.ts` with equality tests. Reserve `de` now?
4. **Q4 (D2.5.1):** Grandfathering = "the slug the same stored row already holds". First-time WXR
   import of a reserved slug is **rejected**. Approve both?
5. **Q5 (D2.6/D2.7):** The build fails on page collisions and on story-vs-site-route, and only
   warns on grandfathered app/legacy collisions. Approve the PR rollout rule?
6. **Q6 (D3):** Publish gate without snapshot isolation (published pages save live, as About
   today), or full snapshot isolation?
7. **Q7 (D4):** Approve the slots (header ≤ 5, footer ≤ 8, legal ≤ 4), the fixed social slot
   after the footer items, the item kinds (`builtin`/`page`/`path`/`external`), `https:` +
   site-relative only (no `mailto:` in nav), and external links opening in a new tab?
8. **Q8 (D4.4):** Nav stored in Postgres `site_nav` (in the dump), API under
   `/settings/navigation`?
9. **Q9 (D5):** Both locales required for every page in DE+EN. Other modes follow #283?
10. **Q10 (D6/D8):** Contact as Markdown only; legal pages with no seeded content?
11. **Q11 (D7):** Delete semantics as specified, About undeletable and un-unpublishable?

## Approval record

| Item | Status |
|---|---|
| Owner approval of this spec | Approved: **“Approve proposed page contract”**, PR #407 at `dcf775e25034547764e9c9e48a2c94feb6e78413` |
| #283 contract approval (conditional sections) | Approved in the same interactive decision batch; implementation still required |
| `SECURITY.md` reconfirmation | Required during implementation (#288/#289) |
| Approver / date | Repository owner, interactive implementation session, 2026-10-27 |
