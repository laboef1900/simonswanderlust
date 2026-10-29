# Basic pages, route reservation and navigation contract (issue #287)

**Date:** 2026-10-27 · **Risk:** high (shared root URL namespace, Golden Rule 2, `db.ts` schema,
dump version, a new author-controlled URL sink in `Nav.astro`/`Footer.astro`) · **Size:** large

**Status: OWNER APPROVED, 2026-10-27.** The owner selected **“Approve proposed page contract”**
for PR #407 at `dcf775e25034547764e9c9e48a2c94feb6e78413`: fixed page kinds, About's existing
URLs and undeletable status, reserved-route/cross-content guards, Postgres navigation, and
published pages continuing to save live. Story-slug reservation and grandfathering remain in
scope. The independent review subsequently requested corrections (F7–F9), not a replacement
approval. F7/F9 below clarify that approved scope. The owner additionally selected
**“Prepare translations before activation”** on 2026-10-27 for Q12 / #283 Q18, approving
D5.1 option A's explicit inactive-locale preparation and activation preflight.

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
  `SLUG_RE` as stories. `''` means "unset": permitted in drafts and retained inactive locale
  rows, never in an enabled published non-About row. Pair-level `published` does not make an
  inactive translation public (D5 and the approved activation transition D5.1).
- **Slug lock:** each locale's slug locks at its first publication (`published_at`, 409
  `page_slug_locked`); a never-public inactive translation is not locked just because its pair
  is published (D5.1). Unpublishing does not clear the timestamp or unlock
  an existing URL. Moving that URL requires explicit owner authorization, not a mode change;
  delete/recreate is a separately confirmed destructive action. There are no automatic redirects.
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
  - `RESERVED: Record<Namespace, ReadonlyArray<{ segment: string; owner: 'app' | 'site' | 'locale' | 'legacy'; pageKind?: 'about' }>>`
  - `reservation(namespace, slug): { owner, segment, pageKind? } | null`, which covers **static**
    reservations only. The About site reservation carries `pageKind: 'about'`: it identifies
    the legitimate fixed-route owner, not a second page claiming that segment.
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
| C1 | non-About page save (`PUT /pages/:key`) | `reservation(N, s)` is not null | no (pages are new) |
| C2 | page save | a story in `N` holds `s`: the working copy **or** the published snapshot of any post | no |
| C3 | page save | another page in `N` holds `s` (the unique index, mapped to 409) | no |
| C4 | story save (`upsertDraft`: editor, bulk, WXR) | `reservation(N, s)` is not null **and** `s` is new or changed for this row | **yes**, see D2.5.1 |
| C5 | story save | a page in `N` holds `s` (draft or published) **and** `s` is new or changed | yes, same rule |
| C6 | story save | another story holds `s` | existing `duplicate_slug`, unchanged |

About supplies no slug claim: its stored slug must be `''`, and its path is the fixed
reservation owned by `page:about` in that namespace. This is an exact owner identity, not a
general reserved-slug exemption: another page or story cannot claim About's path.

Response body: `{ error, code: 'reserved_slug', owner: { type, name } }`. `name` is the reserved
segment or the page **kind**. It never contains a draft page's title or a draft story's title, so
an author-level story save cannot read unpublished admin content through the error.

**Race:** posts and pages are different tables, so no database constraint can hold the
cross-table rule. Every writer that checks C1–C5 takes a **namespace advisory lock**
(`pg_advisory_xact_lock` on a fixed key, distinct from the pair lock and the app/restore lock)
inside its transaction before checking. With #283 installed, take the singleton language row
lock **first**, then content locks (post `lockPostPair`, deterministic key order for batches),
then namespace locks in deterministic order. Page/nav writes join this order when taking these
locks; never acquire language after namespace. Without #283, preserve content-before-namespace
ordering. The build guard (D2.7) remains the backstop.

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

The site build collects every path it will emit (stories, pages, fixed routes, region pages)
into a catalogue keyed by normalized full path and carrying resource identity, namespace and
namespace-relative slug:

- Register About **once per enabled locale**, as resource `page:about:<locale>` owning its
  fixed site reservation. The route file and the About database row are two inputs to that
  same output, not two competing claims. Its empty stored slug is not a dynamic route.
- **Fail** with both owners named if distinct resources produce the same full path. A second
  page or story claiming `/uber-mich/` or `/en/about-me/` still fails; never deduplicate merely
  because the paths match.
- For a non-About page, check `reservation(namespaceOf(locale, mode), slug)`, not the first
  segment of the full URL. For `/en/contact/`, `en` selects the namespace and `contact` is the
  candidate slug; the legitimate locale prefix is not a collision. A reservation not owned
  by that page is a failure. Pages have no grandfathering, so this signals a restore or hand
  edit bypassing C1–C3. A failed build keeps the previous release serving (`build.ts` swap).
- **Fail** if a story claims a fixed **site** route or the locale-root path itself (e.g.
  `/en/`), not merely because a story legitimately lives below `/en/`. That output would lose
  a file or shadow the namespace root.
- **warns but does not fail** for a story whose slug equals an **app** or **legacy** segment. Such
  a story can only be grandfathered, and failing the build would break Publish for every other
  post.

[INFERENCE, not measured] Astro may already warn on a dynamic path that duplicates a static route.
The guard does not rely on that.

#### D2.8 *Conditional on #283*: reservations in other modes

These apply to #283's four approved modes once implemented: primary locale at root, secondary
under its own prefix, `de` and `en` reserved at root in every mode. After publication the primary
is locked; enabling a secondary is additive, subject to the approved page preflight in D5.1.

| Mode | Locale in `root` | Prefixed namespace and its `site` segments | `site` segments in `root` (besides `404`) |
|---|---|---|---|
| DE+EN DE-primary | DE | `en`: `map`, `destinations`, `about-me` (D2.3) | `karte`, `reiseziele`, `uber-mich` (D2.3) |
| DE-only | DE | none | `karte`, `reiseziele`, `uber-mich` |
| DE+EN EN-primary | EN | `de`: `uber-mich`, `karte`, `reiseziele` (`rss.xml` format-excluded) | `about-me`, `travel-map`, `destinations` |
| EN-only | EN | none | `about-me`, `travel-map`, `destinations` |

In every mode, `root` also reserves all `app` segments (including `map`), all root `legacy`
segments, and the locale prefixes `de` and `en`. In every prefixed namespace, the matching
`legacy` segments (today only under `en`) are reserved too.

App and legacy reservations always apply to `root`. In EN-at-root modes, English app words
(`posts`, `media`, `login`, `settings`, `comments`) become likely slug candidates, so C4/C5 matter
more there. #283 refuses a primary/namespace reassignment after publication, so enabling a
secondary does not move existing grandfathered primary slugs. A fresh install has none.

### D3 — Draft, preview and publish for pages

**Recommendation: a publish gate without snapshot isolation.** Pages get a pair-level status, but
published pages keep About's "Save = live" behaviour:

- Schema (additive, both `CREATE TABLE` and `ALTER … ADD COLUMN IF NOT EXISTS`):
  - `pages.slug text NOT NULL DEFAULT ''`
  - `pages.status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published'))`
  - `pages.published_at timestamptz`: per-locale first-publication marker, retained on unpublish.
    D5.1 specifies the approved activation treatment of never-public inactive rows.
  - Partial unique index `(locale, slug) WHERE slug <> ''`.
  - Boot backfill, idempotent: `UPDATE pages SET status='published', published_at=COALESCE(published_at, updated_at) WHERE key='about' AND status='draft'`.
    Other existing keys stay `draft`. None of them is rendered today, so nothing public changes.
  - The About seed inserts `status='published'` explicitly.
- States: `draft → published` (`POST /pages/:key/publish`, admin) and `published → draft`
  (`POST /pages/:key/unpublish`, admin, refused for `about`). The status is written to both
  locale rows in one transaction. This is pair-level page status, not proof that an inactive
  locale has ever been public; its first-publication marker is separate (D5.1).
- **Save on a draft page** stores it and does **not** rebuild. **Save on a published page**
  first passes the publication validation below, then stores and rebuilds, retaining About's
  live-save model (`server.ts:1965-1966`). Publish, unpublish, delete of a published page, and
  nav saves each rebuild once. An invalid save commits nothing and starts no rebuild.
- **Publication validation is a write invariant, not just a Publish-button check.** Apply it
  before every mutation whose resulting stored pair status is `published`: first Publish,
  subsequent PUT (including restoring a revision through PUT), and locale activation against
  the candidate enabled set (D5.1). Read status and language state server-side;
  a caller-supplied status must not bypass it. Every enabled non-About locale needs a trimmed
  non-empty title and body and a non-empty slug. Recheck C1–C3 and slug locks in the transaction.
- **Image safety on every such write:** use the actual
  `analyzeBodyImages(bodyMarkdown, images, imageOrigin)` API from `publish-gate.ts`, on each
  enabled locale's normalized candidate body and validated images map. Its return shape is
  `{ foreign: string[], sources: string[] }`; a non-empty `foreign` refuses the write with
  409 carrying `error`, `locale`, `foreignImageCount` and `foreignImages` (at most five examples).
  The count/examples fields follow the existing post gate; `locale` identifies the page row.
  Do not call the removed `foreignImageUrls` API, scan Markdown, or treat sanitization as this
  check. Analysis failure refuses the write, never falls back to unvalidated publication.
  The `sources` result is not itself a readiness verdict; this spec adds no new media-readiness
  policy. Existing `imagesMapError` validation remains mandatory for both stored locale maps.
- **About compatibility exception, completeness only:** the existing seed/editor accepts empty
  title/body and `AboutPage.astro:17-24` supplies its localized heading/description fallback.
  Preserve that behaviour: About stays published on its fixed route, with `slug = ''`, even
  when its title or body is empty. It has **no exception** to images-map validation, rendered
  foreign-image analysis, sanitization, concurrency or owner/path checks. This avoids making
  a previously valid empty About seed unbuildable while protecting all subsequent live writes.
- **Transaction boundary:** with #283 installed, every page save/publish/unpublish/delete takes
  `SELECT ... FROM site_language WHERE id = true FOR UPDATE` before page/namespace locks, matching
  #283's language/publication protocol. Validate the exact candidate saved under those locks,
  including its enabled set and current status; retain optimistic concurrency and revision
  capture. Invoke ordinary `builder.build()` only after commit and lock release. Never hold
  the non-reentrant work lock around a call that acquires it again.
- **Loader isolation:** select published registry kinds **and enabled locales**. Revalidate
  enabled published non-About completeness and image safety at the build boundary; invalid
  restored/hand-edited live data fails the build rather than silently dropping an existing
  route. About retains only the completeness exception above. Draft, inactive and unknown-key
  rows never reach rendered output.
- **Failure/recovery:** validation/conflict failure leaves rows, revisions and public release
  unchanged. A build failure **after** commit leaves the new database content saved while the
  previous static release serves; report saved-but-not-rebuilt and allow rebuild after repair.
  Restoring a valid revision is another validated PUT, not a bypass or an automatic rollback.
  Database commit and static release swap are not one atomic operation.
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
  a `page` present in the validated emitted-path catalogue (About included), a `builtin` that
  exists in that locale, or a `path`/`external` with both `href[locale]` and `label[locale]`.
  Physical page rows or pair-level published status alone do not prove a public route exists.
  An item that does not resolve is skipped; it is never rendered as a broken link.
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
  #273's `SITE_IDENTITY_JSON`. Nav, pages and gallery metadata import the same exported
  PostgreSQL build snapshot as language/identity and trips (#273 §6.1 / #283 §10.2), using the
  shared loader connection helper. A separate fresh `pool.query` would violate this boundary.
- **Dump:** `site_nav` joins the dump (`tables.site_nav`). `pages` gains `slug`, `status` and
  `published_at` in the dump. This takes **the next free `DUMP_VERSION`** at landing. #273 and #283
  also propose a bump; whichever lands first takes 11. `SUPPORTED_DUMP_VERSIONS` is widened in the
  same change.
  Record that introduction as `PAGES_NAV_DUMP_VERSION`; older identity-only/language-only
  intermediate formats must remain restorable, not be mistaken for malformed new-format dumps.
- **Restore** (one transaction, as today) replaces `pages` and `site_nav` together. For older
  dumps:
  - **no `pages` key (v1):** pages and nav are left untouched, as today.
  - **supported pre-navigation version (`version < PAGES_NAV_DUMP_VERSION`):** nav is left
    untouched. This includes v≤10 and supported identity/language-only intermediate versions.
    Do not infer this branch merely from a missing `site_nav` key.
  - **pre-navigation pages:** the D3 backfill rule applies: `about` becomes published, every
    other key becomes draft with an empty slug.
  - **navigation-capable versions:** require `site_nav` and the version's complete page fields;
    missing tables/fields refuse the whole restore rather than silently preserving old state.
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

- **Today (DE+EN, DE-primary), unconditional:** every non-About page needs **both** locales
  (title, body, slug) to publish **and to save while published**. There is no per-page opt-out.
  About uses D3's existing completeness fallback, not an image-safety exemption.
  `hreflang`/`x-default` follow actual built alternates (today x-default is DE).
  Pages enter the sitemap automatically (`@astrojs/sitemap`, no filter) only once published;
  they are **not** in RSS and never have comments.
- ***Conditional on #283:*** pages are built only in enabled locales. Both rows are retained;
  inactive content is never wiped and an active-locale save must preserve omitted inactive
  payload fields rather than defaulting them to empty. Publication validation requires enabled
  locales only. Non-About pages are never built empty; About's explicit D3 compatibility
  exception remains. A nav target must be built (D4.2). A page without an alternate uses
  #283's other-locale-home fallback, not a fabricated page URL.

#### D5.1 Approved Q12 — prepare translations before secondary activation (review F8)

**The owner approved option A on 2026-10-27, supplementing the prior approval.** Example: DE-only has a
published `contact` pair with complete DE content at `/kontakt/`, but empty EN title/body/slug.
Both physical rows have pair status `published`; EN has never been public. Simply flipping the
mode must neither build an empty EN page, silently remove `/kontakt/`, nor invent a translation.
The mirror case is EN-only → DE+EN EN-primary. #283 must apply the same chosen policy.

**Approved A: refuse activation until translations are prepared.** This preserves the approved
pair-status/live-save model and bilingual completeness without adding per-page omission state.
The transition is:

1. Under #283's shared language-row-first transaction protocol, preflight **every published
   registry page** against the candidate enabled set. Non-About secondary rows need title,
   body, slug, C1–C3 and image validation; About needs its fixed path and image validation but
   may use its existing empty-content fallback. Draft/unknown pages do not block activation.
   On incomplete/invalid candidates return **409 `language_pages_incomplete`** with admin-only
   page-kind, locale and field/reason entries; no language/page/status/nav mutation or rebuild.
2. The refusal links to **Language Settings → Prepare EN pages** (or DE). This explicit
   activation-preparation flow reuses the page editor in a **single candidate-locale view**,
   labelled "Not public until English is enabled", with normal preview and save. It is not a
   hidden requirement to use SQL or to enable a locale before editing it. Ordinary single-mode
   editing still shows only the active locale, as #283 requires; the preparation view is the
   narrow, owner-visible exception approved under Q12. Existing PUT and `updatedAt` are
   reused, preserving active content and accepting incomplete inactive fields in stages.
   Validate inactive field shapes/non-empty slug reservations at save; enabled live content
   still passes D3. Saving this published pair rebuilds the **current single-language mode**
   only, so neither an unfinished translation nor an EN nav item/alternate becomes public.
3. An inactive row's pair status is not proof its slug was published. Retain per-row
   `published_at = NULL` until that locale first becomes publicly eligible; its prepared slug
   remains editable until activation. First publication sets timestamps only for enabled
   locales. Activation sets the newly enabled published rows' first timestamps and thus their
   slug locks in the same transaction as the mode change. About remains fixed independently.
   No new per-locale status or snapshots are added. Existing DE+EN rows retain their timestamps.
4. Retry activation after preparing all blockers. Re-read/validate under the shared lock;
   concurrent live saves, Publish, unpublish and delete take that same language lock first.
   Do not trust a successful earlier UI preflight. Commit the new language state and timestamps
   together, retaining both statuses, page content and nav configuration. Then release database
   locks and call the ordinary builder. On successful build the old DE URLs remain, complete
   EN routes are added, and EN nav/alternates/sitemap resolve only to emitted pages. Subsequent
   live saves require both locales complete (About exception unchanged).
5. A post-commit build failure is **saved configuration, old release still serving**, not an
   atomic activation rollback. Report that state; retry rebuild after fixing the failure.
   Never delete primary routes, revert language state automatically, or tell the owner the
   secondary is already live. A repeated activation of the now-current mode must still offer
   the existing Rebuild action; it must not strand recovery behind a no-op mode response.
   Restored candidate content is subjected to the same validation before activation/build.

**Rejected alternative B: enable now, omit incomplete secondary pages until valid.** This is not just
skipping loader rows. It requires an explicit per-locale publication/eligibility contract:
keep the primary public and pair published, mark the secondary not public, omit its nav,
alternate and sitemap path, then first publish that locale only on a validated admin live-save
after all fields pass. Once public, invalid later saves must refuse rather than hide it.
Persist that first-public state across dump/restore and keep its slug locked. This adds a
documented **exception to bilingual completeness** (an untranslated page may remain absent
indefinitely), unlike A. About still always renders its fixed fallback and never gets omitted.
Choose B only with explicit approval of this wider per-locale lifecycle, not as silent build
filtering under the existing pair-level contract.

**Rejected alternative C: explicitly unpublish each incomplete non-About pair before enabling.** Existing
unpublish confirmation must name the DE URLs removed and affected navigation. This needs no
preparation UI, but `/kontakt/` disappears until both translations are complete and republished;
it is **not** the additive activation guarantee. Never do it automatically or present it as
URL-preserving; it is not recommended. About cannot be unpublished.

**Owner selection:** **“Prepare translations before activation”**, option A. Existing primary
URLs remain live while the secondary translation is prepared and validated. The owner did not
select B's per-locale publication exception or C's whole-page unpublication.

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
| `PUT /pages/:key` | `requireAdmin` | refuses unknown kinds; C1–C3; slug lock; D3 validation before every published save, including revision PUT; preserves omitted inactive fields; rebuilds only if published |
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
| A live page PUT or revision restore empties an enabled non-About body or adds a foreign image | Refused before commit/rebuild by D3; no new revision or public change. About may be empty but cannot bypass image safety |
| The seeded About route meets its own reservation | One legitimate catalogue owner, not a collision; another resource at that path fails |
| DE-only published contact has empty EN and activation is requested | Approved A refuses without changing mode/routes and provides the explicit inactive-translation preparation flow |

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
8. Every published-page mutation passes D3 for the enabled set before commit; a revision restore
   is not exempt. About's completeness fallback does not weaken image safety.
9. About owns its fixed reservation once per enabled locale. A namespace prefix is not an
   ordinary page slug. Secondary activation must not silently remove an existing page route;
   approved Q12 option A prepares incomplete translations before activation.

## Compatibility, migration and rollback

- **Migration:** additive and idempotent in `ensureSchema`: three `pages` columns, a partial
  unique index, the About status backfill, the `site_nav` table with its seeded default, and the
  `page_revisions` orphan sweep. The existing About rows are not rewritten except for
  `status`/`published_at`. **Built output on the existing install is unchanged:** the seeded nav
  reproduces today's header and footer links, and #274 has already replaced Instagram. #289's
  test compares built header and footer link sets before and after.
- **Before deploying #288:** capture a complete recovery set immediately before the migration,
  using the then-current `dumpDatabase()` format, plus its settings, media/assets, required
  escrowed key material and serving-release identity under #283's recovery rules. Record that
  dump version and a compatible, security-fixed restore image; do not demand v10 or substitute
  an older dump that omits identity/language state. Run the D2.6 collision query read-only
  against production and record its result before deployment.
- **Rollback:** prefer a fixed-forward image. A previous image is eligible only if it retains
  the required security fixes and understands the identity/language state in that recovery set.
  A compatible pre-pages image ignores the additive page columns/table, renders only `about`,
  and uses its existing navigation; non-About rows do not acquire routes merely because its
  loader reads them. The serving release remains unchanged until an explicit successful build.
  Restore, when necessary, uses the captured pre-migration recovery set and its actual format,
  never an arbitrary v10 dump or an unconditional image downgrade. A logical restore does not
  reverse schema migrations; the additive columns/table may remain only where compatible with
  that explicitly selected recovery image.
  **Containment:** a page or nav problem is fixed by unpublishing or deleting the page, or by
  resetting the nav document to the default, then rebuilding. None of these touches stories.
  About cannot be unpublished: repair its content or restore a valid revision through PUT.
  On a failed post-commit page save/activation build, preserve the last release and explicitly
  retry rebuild after repair; neither the DB transaction nor a logical dump makes the release
  swap atomic with language state. Q12's selected policy must also govern restored inactive rows.
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
- First Publish, live PUT and revision PUT all reject enabled incomplete non-About content and
  foreign inline/gallery images, including image-map normalization cases; rejection preserves
  rows/revisions and performs no build. About empty title/body survives, but foreign images fail.
- Build error after a valid live save reports saved-but-not-rebuilt and retains the old release;
  a valid revision PUT and subsequent rebuild recover without bypassing the gate.
- **Approved Q12 A:** DE-only published contact with empty EN → activation 409 with
  unchanged mode/status/nav/routes; prepare EN in explicit inactive-only view, save partially,
  preview, finish, then activate. Inactive saves preserve DE and never emit EN. Repeat with
  EN-primary. Include draft pages (not blockers), empty About (fallback), and invalid About
  images (blocker). Ordinary single-mode editor remains single-locale.
- Race activation against page save/publish/unpublish/delete; recheck under the language lock,
  no invalid candidate commits, no recursive work-lock acquisition. Inactive slug can be filled
  before activation and locks when first publicly eligible. Dump/restore preserves timestamps.
- Activation commit followed by build failure keeps the previous URL set serving and reports
  saved-but-not-live; rebuild retry recovers. Do not assert database/release atomicity.
- Author 403 on every admin route.
- URL policy table (each misuse row).
- Dump/restore round-trip of the new shape; v10/v1 and each supported intermediate identity/
  language-only format follow their introduction-version rules (backfill, nav untouched,
  orphan revisions removed). Missing metadata in a navigation-capable format fails atomically.
- Boot collision report.

**#289 (site):**
- Pages-tree equality for site reservations; format guard.
- Build guard fails on page collision and on story-vs-site-route, warns on grandfathered app
  collisions.
- Seeded About registers once and builds at its existing two paths; a competing page/story at
  either path fails. `/en/contact/` and `/de/kontakt/` pass in their legitimate namespaces;
  root-slug `en`/`de` and namespace-relative reserved slugs fail. Cover all four approved modes.
- Invalid enabled published page data introduced by restore fails closed without silently
  removing a route. About's existing empty fallback still builds, with image safety retained.
- Q12 A: before activation no secondary page/nav/alternate/sitemap entry; after a
  successful activation build complete secondary entries appear and primary paths are unchanged.
- Pause an old bilingual build after snapshot capture, disable the secondary while unlocked,
  then prepare new inactive page text before its loader reads. The old release candidate must
  contain only pre-capture text/nav, never the private preparation; also fail the queued rebuild
  and verify no leak. Snapshot import failure prevents release promotion and releases all connections.
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
- *"Immediate publish for published pages is unsafe"*: it retains today's admin-only About flow
  with revisions and conflict handling, but D3 now explicitly gates every live save and revision
  PUT. Empty About remains compatible; unsafe images do not. Staged edits remain an owner option.
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
12. **Q12 (D5.1, APPROVED 2026-10-27):** Option A: preflight refusal plus explicit
    inactive-translation preparation. Exact answer: **“Prepare translations before activation”**.
    The supplementary approval applies to both #287 and #283; B/C were not selected.

## Approval record

| Item | Status |
|---|---|
| Owner approval of this spec | Approved: **“Approve proposed page contract”**, PR #407 at `dcf775e25034547764e9c9e48a2c94feb6e78413` |
| #283 contract approval (conditional sections) | Approved in the same interactive decision batch; implementation still required |
| `SECURITY.md` reconfirmation | Required during implementation (#288/#289) |
| Approver / date | Repository owner, interactive implementation session, 2026-10-27 |
| Independent review F7/F9 | Correctness clarifications incorporated; not a claim that the earlier review was clean |
| Q12 / review F8 | Approved **“Prepare translations before activation”** after PR #407 head `93619a0ccb665c27152dff67fce496b779a3b38d` and PR #406 head `8542d78fa1f9168c0313d2cffdef3d17830eba6d`; option A only |

## #288 implementation interface and scoped qualification

This appendix records the implemented storage/CMS boundary for downstream #289 and
#309. It does not change the approved scope or claim that public generic routes,
navigation settings or a production migration have been exercised.

### Shared modules and stored representation

- `site/src/lib/page-kinds.ts`: `PAGE_KINDS`, `PageKind`, `isPageKind`. Each registry
  entry supplies `slugs.{de,en}`, `deletable`, `unpublishable`, and default `slots`.
  About's registry paths are fixed; its stored slug is always `''`. New-page
  defaults are suggestions in the editor, not silently assigned route claims.
- `site/src/lib/navigation.ts`: `Navigation` (`version: 1`, `header/footer/legal`),
  the discriminated `NavItem` union, `NavLocaleText`, `NAV_SLOTS`, `DEFAULT_NAVIGATION`,
  `validateNavigation`, `PageNavReference`, `pageNavReferences`,
  `withoutPageNavigation`. The validator is pure and Astro-free. It validates
  structure/URL safety/limits, not emitted-path eligibility: #289 must resolve
  against actual emitted paths in the captured build mode and validate active
  locale labels/destinations at its save boundary.
- `pages`: existing `(key, locale)` primary key, new `slug text NOT NULL DEFAULT ''`,
  `status text NOT NULL DEFAULT 'draft' CHECK ('draft','published')`, nullable
  `published_at timestamptz`; existing `updated_at` is the optimistic pair token
  (maximum row timestamp). The nonempty partial `(locale,slug)` index supplements
  transactional cross-table checks. The pair shares status, not first-public time.
- `site_nav`: singleton integer `id=1`, `config jsonb`, `updated_at timestamptz`.
  Bootstrap seeds the shared default only when absent. #289 should update this
  row in place with its stale-write guard, not introduce settings.json navigation.
  Page deletion locks this row after language/content/namespace locks.

### Store and API contract

`uploader/src/pages.ts` remains the sole page store. `StoredPagePair` carries
`key`, `status`, `updatedAt`, and `de/en` content with `slug` and `publishedAt`.
`PageUpdate` is a partial locale update; `PageSaveOptions.prepareLocale` names an
inactive locale explicitly. Omitted and ordinary inactive content is retained.
`configureImageOrigin` binds the real server image origin before mutation; stores
default fail-closed rather than infer an origin from untrusted content.

`PageStore` exposes `get`, `keys`, `save`, `publish`, `unpublish`, `removalInfo`,
`remove`, `listRevisions`, `getRevision`, and `prepareActivation`.
`validatePublishedPage` is the shared uploader eligibility/image gate;
`pagePairFromRows`/`PageRow` decode current database rows. #289's loader must
select published registry kinds only and revalidate its own untrusted DB/build
boundary; it must preserve About's existing fixed-route fallback and sanitization.

| Route | Permission / result |
|---|---|
| `GET /pages` | Session; `{pages, language}` with registry defaults, existence/status/token, paths and locale title/slug/history; no bodies |
| `GET /pages/:key` | Session; saved pair, or unsaved empty pair with `updatedAt: null` |
| `PUT /pages/:key` | Admin; `{de?,en?,updatedAt?,prepareLocale?}`; locale fields `title/bodyMarkdown/images/slug`; caller history/status never changes lifecycle |
| `POST /pages/:key/publish`, `/unpublish` | Admin; optional `{updatedAt}`; pair lifecycle operation |
| `GET /pages/:key/preview?locale=de\|en` | Session; saved selected locale including inactive, real sanitized HTML, preview CSP, `no-store` |
| `GET /pages/:key/revisions[/:id]` | Session; bounded history; 404 when page is absent |
| `GET /pages/:key/deletion` | Admin; `{key,titles,paths,revisions,navigation,bodyReferences,updatedAt,published}` |
| `DELETE /pages/:key` | Admin; optional `{updatedAt}`; same deletion impact as committed result |

Successful mutations return `{saved,build}`, where `build:null` means no rebuild
(draft save/deletion). A post-commit build failure returns HTTP 502,
`code:"page_build_failed"`, `persisted:true`, `saved`; clients must adopt that token
and report the prior release remains served. Validation/stale failures commit no
revision. Reserved claims return HTTP 409 `reserved_slug` with `{owner:{type,name}}`;
unknown kinds return 400 `unknown_page_kind`; fixed About operations and sticky
slug edits return 409. A stale token for a deleted page returns 404, not recreation.
Explicit inactive preparation requires the loaded token and rejects active-locale
edits in the same payload. The existing editor URL defaults to About, with
`?key=contact|privacy|legal` selecting others and `&prepareLocale=…` entering preparation.

### Concurrency and downstream activation

`content-namespace.ts` provides `lockContentNamespaces(client)` after the
language singleton and content locks. Postgres holds namespace keys in a stable
order. Memory stores share a `LanguageStore` instance plus registered working and
retained snapshot claims; fixtures must inject that same language store into both.
New/changed story claims call `PostStore.pageSlugOwner`; WXR uses the same boundary
before fetch. Grandfathering remains based only on the same existing story row.

`PageStore.prepareActivation(candidate, client?, validate?)` is called from the
existing language-update preflight. Postgres requires that transaction's client,
locks all published page rows and stamps newly enabled rows before the mode commit.
Memory returns a commit closure, which the language store invokes only after every
transition handler accepts; a later refusal cannot partially stamp a locale.
The optional validation callback preserves About's incumbent media-readiness gate.
`LanguageError("language_pages_incomplete")` carries page/locale blockers. Ordinary
inactive saves do not claim public eligibility; activation rechecks under lock.
#309 should reuse these blocks/actions, not add an independent activation protocol.

### Migration and recovery

`ensureSchema` adds columns/index/nav idempotently, keeps About text/URLs, marks
About published once, and sweeps orphan page revisions. Unknown old keys are
retained inert and reported by `reportNamespaceCollisions`; admins can delete them.
The boot pre-migration capture extends the inherited recovery prerequisite to
missing `site_nav`. It never manufactures a lower-version dump from new page data.
Dump format 13 independently records page/nav introduction after language v12 and
identity v11. New metadata is mandatory and validated before replacement, including
sticky first-public timestamps for enabled published registry rows.

Restore replaces new page/nav data together, preserves first-public history, and
retains inherited identity/language/GPX handling. Pre-v13 page rows explicitly
normalize to empty slugs, About published, others draft; absent v1 pages survive.
Live navigation survives pre-v13 restores. `pageRecoverySummary` takes retained
live context for those versions, reporting unresolved items and page/story/static
collisions without deleting anything. Revision orphans are swept; surviving
histories are not represented as recoverable dump content. Page mutation tokens
are refreshed during restore so an open pre-restore editor cannot overwrite it.
Containment is unpublish/delete (not About), or repair/rebuild; preserve the last
successful release and the approved compatible recovery image/set.

### Observed #288 acceptance evidence (2026-10-29)

Complete uploader/PostgreSQL suites and TypeScript, site suites, Astro check and
real build passed after the cancellation-focus regression fix
(`wave-two-results-1793284517645_74185.json`).

Actual `main.ts`, desktop/320px managed-browser and CLI scenarios covered catalog
permissions, reserved/reverse/grandfathered claims, no-fetch WXR refusal, page
history/conflicts/deletion scope, inactive translation preparation/activation,
post-commit build failure and explicit recovery, restart preservation, and real
v13 dump/restore with separately synthetic v12/v11/v10/v1 compatibility inputs.
The corrected source `c90f1142befaf6ac5529462f96c3ec4375aa2e7c` restores enabled
Delete-button focus after both Escape and Cancel; cancelled operations preserve
exact page/revision state. Uploaded responsive media was rendered successfully.

The canonical ignored evidence index is `issue-288-runtime-final.json` under
`.local/backlog-execution-2026-10-27/`. Earlier successful phases retain their
`a4acb88` source attribution. Earlier `/about-me/` equal-404 comparisons are
explicitly excluded: supplemental failure proof requires actual `/uber-mich/`
HTTP 200 with identical SHA-256 and byte length while the prior release remains.
Fixtures and private recovery sets were retained; only owned services/browsers
were stopped. No owner content or data was changed.

This qualifies the CMS boundary, not #285's public language-mode routes or #289's
non-About rendering/navigation. Those downstream public build/browser checks,
independent actual-PR review, exact-head CI and stack integration remain distinct
gates. Successful CMS publication alone does not establish the new public routes.


Independent PR review subsequently found two additional UI defects: lifecycle
responses could clear edits typed during rebuilding, and catalogue Delete
cancellation lost focus. Both regressions failed before the repair and pass with
the real DraftGuard/native confirmation implementations. Complete suites/type
checks/Astro build passed at `c18f516` (wave `1793287726371_82151`).
The actual-main/browser supplement `issue-288-runtime-c18f516-supplement.json`
held genuine Publish and Unpublish acknowledgements after real builds: unsent
titles, recovery stashes and native unload warnings survived both responses,
while persisted titles stayed unchanged. Catalogue Escape and Cancel restored
enabled-opener focus at 1440px and 320px without page/history mutations.
Independent re-review found no remaining findings; both required CI jobs passed
on `c18f516`. Final documentation CI and eventual stack qualification remain
separate from this exact-source evidence.

## #289 public-output and navigation interface

The implementation extends the existing #285 `[...path].astro` catalogue, not
parallel fixed route files. `pages` and `navigation` Content Layer collections
import the same exported snapshot already used by trips/identity/language.
Eligibility is applied before row parsing; Zod then rejects malformed published
registry rows, missing enabled counterparts and invalid images. The original
sanitized body is checked for foreign image origins before portability rewriting
and guarded responsive-picture/gallery rendering. About stays the existing
resource and fixed localized route exactly once, including its fallback text.
Generic pages have canonical/sitemap/actual-counterpart hreflang, not story feeds.
The existing #288 sanitized saved-draft preview remains the preview surface.

`publicRoutes` is the one full emitted HTML catalogue. Its deterministic guard
names both competing owners and rejects page/story/static/locale collisions
regardless of input creation order. Page reservations are strict; grandfathered
app/legacy story names retain the approved warning policy. Navigation accepts only
the existing version-1 schema, resolves each enabled locale against this catalogue
(plus actual RSS/sitemap/error artifacts), omits unavailable page targets and warns
on non-emitted relative paths. External URLs retain only the validator's HTTPS
form and render escaped labels with the approved new-tab semantics. Footer legal
links are optional; the existing identity social slot remains separate.

### Owner editing and response contract

- `GET /settings/navigation`: admin-only/no-store; `{ config, updatedAt, language,
  socialLinks }`. `socialLinks` is the current read-only identity list, not a second
  navigation setting.
- `PUT /settings/navigation`: admin-only/no-store; strict `{ config, updatedAt }`
  payload. Lock `site_language` first, then `site_nav`, validate the complete
  document and active-locale URL/label pairs against that locked mode, compare the
  optimistic token, save and commit. No model/provider/browser-storage involvement.
- After commit and lock release, build once. Success is `{ saved, build }`; failed
  returned or thrown builds are `502 { code: "navigation_build_failed",
  persisted: true, saved, error }`, retaining the last successful release. Invalid
  input is 400; stale token is 409 with no write/build.
- Settings → Navigation edits header/footer/legal in stored order, bounded by
  5/8/4 items, with all four kinds, target choice and enabled-locale label/URL
  fields. Disabled-locale values survive ordinary edits. Move actions preserve
  focus; removal/reload/rebuild use the existing confirmation helper. Missing
  targets are author notices. Failed-build acknowledgements adopt the saved token;
  conflicts or unacknowledged transport failures retain edits and require reload.
  Retry rebuild does not resave. Social links link back to Site identity.

### Deterministic evidence matrix for integration owner

No checks/builds were run by the implementation worker. Run the full affected site
and uploader suites/type checks once after integration, with `TEST_DATABASE_URL`
set for actual PostgreSQL coverage. New focused suites cover page schema/filtering,
all-mode routes/collisions, malicious navigation URLs, loader snapshot rejection,
sanitized image rendering, navigation API roles/tokens/failure acknowledgement,
memory/Postgres writer races and the real Settings DOM.

`navigation-snapshot.integration.test.ts` uses a disposable schema and real exported
snapshot for both primary languages. Its builder seam pauses after capture,
mutates live page/navigation/identity/language rows, then imports the captured
snapshot through actual page/navigation/trip loaders. A queued failed successor
must preserve the earlier release; an expired supplied snapshot must fail without
new-row fallback. This is a real database/loader/release test, not a claim that an
Astro subprocess or browser has been exercised.

For actual Astro output, build `BUILT_PAGE_CONTRACT_ROOT/<mode>/{seed,configured}`
for `de-bilingual`, `en-bilingual`, `de-only`, `en-only`. Use the same disposable
identity/trips as the #285 fixture matrix, plus:

1. About keeps its existing row, empty slug and fixed route. Publish Contact
   (`de: kontakt`, `en: contact`) and Legal (`de: impressum`, `en: legal`) with
   nonempty localized title/body. Keep Privacy draft (`datenschutz`/`privacy`) with
   `PRIVATE289` in its body. In single-locale builds put `PRIVATE289` in every
   retained inactive page title/body, not enabled content. No real legal text.
2. Identity social links contain `{ label: "Author", url:
   "https://social.example/author" }`. No provider credentials or owner data.
3. `seed` uses `DEFAULT_NAVIGATION`; configured header is Contact page, a relative
   path to the locale's actual map URL, then external
   `https://example.org/source?lang=<locale>` labeled literally
   `<img src=x onerror=alert(289)> & source` in each locale. Configured footer keeps
   About plus a missing relative `/missing-289/` and draft Privacy target; legal
   contains Legal plus draft Privacy. Give relative paths nonempty localized
   labels. Respect each slot's schema bounds.
4. Run `BUILT_PAGE_CONTRACT_ROOT=... npx vitest run --config
   vitest.built.config.ts test/built/pages.test.ts`. This project deliberately
   refuses missing artifacts. Existing #285 route inventory tests use their own
   `BUILT_ROUTE_CONTRACT_ROOT` without the new generic-page fixture; run separately
   or supply both roots when running the entire built project.

The actual-output suite asserts emitted/sitemap equality, all enabled page paths,
no private bytes, one About/title per locale, correct canonical/alternate links,
seed link preservation, escaped hostile labels, external attributes/indicator,
current-page semantics, absent dangling/draft links and the preserved social slot.
The implementing worker did not run these checks. The parent and separate runtime
worker subsequently exercised the matrix below, using the current DESIGN/spec and
independent synthetic content. No incumbent owner content was changed.

### Observed #289 qualification (2026-10-29)

Product source `7c0d21457b8be3ccfdffd5243db1d305aec10848` passed uploader
type checking and the complete PostgreSQL-enabled suite, Astro check, the complete
site suite and a real Astro build (`wave-two-results-1793288559109_86513.json`).
The runtime worker then built all eight real artifact sets through `createSiteBuilder`
and its exported PostgreSQL snapshot. The parent ran the built-page contract against
those retained outputs: all four mode cases passed. All 452 artifact files were
scanned without `PRIVATE289` bytes.

Four actual main-process instances supported 36 Contact/Legal/About browser captures
over enabled locales at 1440px and 320px. Actual sitemap-listed HTML routes and six
RSS endpoints returned 200. Canonical/alternate links, literal hostile labels,
responsive pictures, optional legal links, keyboard navigation, long labels and
horizontal fit were exercised; screenshot contact sheets were visually inspected.

Settings browser scenarios exercised navigation creation/editing/reorder, persisted
order, scope confirmation, Escape/Cancel focus, stale-token 409 with explicit reload,
invalid-scheme 400, author GET/PUT 403, inactive-field retention and transport failure.
A real `/karte/` collision (`page:legal:de` versus `site:map:de`) failed the build after
navigation committed, returning 502 with `persisted: true`. The previous `/kontakt/`
still returned 200 with identical 12,148 bytes and SHA-256. Explicit UI Rebuild then
recovered with 200 without resaving navigation.

Canonical evidence: `issue-289-runtime-final.json` in the ignored execution ledger;
the eight outputs remain under the issue worktree's `.issue-runtime/page-artifacts`.
Only owned services/browsers were stopped; four private synthetic databases and
recovery evidence remain retained. Reserved verification databases, earlier fixtures
and owner content were untouched.

This source retains the incumbent fixed canonical origin; #276 integration is a
separate dependency qualification, not claimed by this proof. Likewise, manual
screen-reader assessment, actual-target collision/deployment qualification,
independent implementation-PR review, exact-final-head CI and resulting-stack
qualification remain distinct. No merge, release or deployment is authorized.
