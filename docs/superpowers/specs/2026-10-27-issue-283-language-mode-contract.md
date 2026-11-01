# Language modes and the primary-language contract (issue #283)

**Status: OWNER APPROVED, 2026-10-27.** The owner selected **“Approve four-mode contract”**
for PR #406 at `85ee0ddfc4eea053a0f51c1a8ad370f2e6f5aea6`, expressly including §4.4's
Golden Rule 2 authorization. The recommended route, omitted-locale, freeze and recovery
contract is approved. This design PR changes no runtime routes; #284/#285 must implement
the contract, its collision guards and the rule/documentation amendments together.

Independent review requested changes; the correctness clarifications below do not replace that
review with a clean verdict or revoke the recorded approval. The owner additionally selected
**“Prepare translations before activation”** on 2026-10-27 for Q18 / #287 Q12 (§8.1), approving
the explicit inactive-locale preparation flow and activation preflight.

- **Issue:** #283 (parent epic #282). Blocks #284, #285, #287 and #308.
- **Baseline:** `origin/dev` at `11e16d1` (after #271 and the v10 dump with private GPX archives).
  The issue was written against `9e400f9`. Two of its references are stale: `DUMP_VERSION` is now
  **10**, not 9 (`uploader/src/backup.ts:37-39`), and the doc comments it cites in `paths.ts`
  now sit at `:20-27` (`@ai-warning` on `regionSlugs`) and `:38-56` (the path helpers).
- **Risk:** High (routes, slug contract, schema, backup/restore, publish pipeline, public comment
  route).
- **Out of scope:** implementation, languages other than DE/EN, machine or AI translation, admin UI
  localization.

---

## 0. Recommendation in one paragraph

An install has a **primary locale**, served at the site root, and optionally one **secondary
locale**, served under its own prefix (`/en/` when DE is primary, `/de/` when EN is primary). The
four modes are the four combinations: DE+EN DE-primary (today, byte-identical), DE+EN EN-primary,
DE-only and EN-only. Each locale keeps its own slugs (German route words in DE, English in EN) in
every mode. Only the prefix depends on the mode. The primary locale is **locked at the first story
publish**. After that, the only mode change allowed is *adding* the secondary locale, which adds
URLs and moves none. Published basic pages follow the approved prepare-before-activation
transition in §8.1. Every other change is refused with a named error, so no redirect machinery
is needed.

Both locale rows of a story always exist, as today. An intentionally absent locale is the existing
row plus a new `omitted` flag, and a database CHECK makes an omitted row unpublishable. In DE+EN
mode the primary locale is required and the secondary is optional per story. The mode lives in
Postgres, so it travels inside DB dumps. `build.ts` hands it to the `astro build` child.

---

## 1. Terms

| Term | Meaning |
|---|---|
| **Primary locale** | The locale served at `/`. It is `x-default` and the locale that every published story must have. |
| **Secondary locale** | The other locale, when enabled. It is served under `/<locale>/`. |
| **Enabled locales** | `{primary}` or `{primary, secondary}`. |
| **Mode** | `(primary_locale, enabled_locales)`: DE+EN/DE-primary = `('de', {de,en})`; DE+EN/EN-primary = `('en', {en,de})`; DE-only = `('de', {de})`; EN-only = `('en', {en})`. |
| **Requested locale set of a story** | Enabled locales whose working row is not `omitted`. Publish validates this set; saving it does not publish it. |
| **Committed published locale set of a story** | Enabled locales whose stored row has `status = 'published'` **and** a non-null `published_snapshot`. This is the authoritative public projection, independent of unsaved or saved working coverage requests. |
| **Snapshot-bearing locale set** | Locales with a retained non-null `published_snapshot`, including an unpublished story's retained snapshots. Used for backup/GPX validation, not public visibility (§8.5). |
| **Lock** | Holds once any story has ever been published, defined in §7.1. After the lock, the primary locale never changes. |
| **Published URL set** | The set of public HTML/XML paths in the live release (`/data/site/current`). |

---

## 2. Verified baseline (what assumes a DE+EN pair today)

**Site**
- `site/src/i18n/ui.ts:1-3`: `locales = ['de','en']`, `defaultLocale = 'de'`.
- `site/astro.config.mjs:18-22`: i18n `defaultLocale: 'de'`, `prefixDefaultLocale: false`. `:35`
  has `sitemap()` with no filter and no i18n option.
- `site/src/lib/paths.ts:38-56`: `homePath`/`aboutPath`/`mapPath`/`regionsIndexPath`/`regionPath`
  are hard-coded `en ? '/en/…' : '/…'`. `regionSlugs` (`:28-36`) are per locale and frozen
  (`@ai-warning` at `:22-27`).
- `site/src/lib/trips.ts:7-11` (`localeOf`, two-locale assumption), `:18-22` (`pathOf`, "DE at
  root, EN under /en/"). `byLocale`, `liveRegions` (`:112`), `tripStats` and `entryNumberOf`
  are already **per locale**.
- Pages are hand-placed files: `src/pages/{index,karte,uber-mich}.astro`, `reiseziele/`,
  `[slug].astro`, `rss.xml.js`, and their twins under `src/pages/en/`. `404.astro` is
  bilingual and links `/` and `/en/` literally.
- `site/src/layouts/Base.astro`: the RSS `<link>` picks `/en/rss.xml` vs `/rss.xml` (`:60-64`),
  hreflang `de`/`en`/`x-default → alternates.de` (`:71-73`) and `og:locale:alternate` (`:83`).
  `HomePage.astro:56` passes literal `{ de: '/', en: '/en/' }`.
- **Untranslated stories already degrade correctly on the site.** `StoryPage.astro:30-43` sets
  `alternates = undefined` when `translationOf` finds no counterpart. `LangSwitcher.astro:13` then
  links the other locale's home. `RegionPage.astro:24-31` emits alternates only when the other
  locale's region page is built (`liveRegions`).
- `site/src/lib/postgres-loader.ts:107-109` loads only
  `status = 'published' AND published_snapshot IS NOT NULL` rows, one entry per row, with id
  `${locale}/${slug}` (`:59`). `pages-loader.ts:41` loads every `pages` row.
- `site/public/robots.txt` hard-codes the sitemap URL. That belongs to #273/#276.

**Uploader**
- `uploader/src/db.ts:95-107` creates `posts` with `locale CHECK IN ('de','en')`. `:112` has the
  partial unique index `(locale, slug) WHERE slug <> ''` (#119). `:121,144` add `published_at`
  and backfill it for published rows. `:351` defines unique `(translation_key, locale)`. The
  `pages` (`:193`) and `comments` (`:420`) tables have the same locale CHECK.
- `uploader/src/posts.ts:77-80`: `PostPair { shared; de; en }`. `:815-824`:
  `postPairFromRows` returns **null if either row is missing**, and pair status is the **DE
  row's** status. `:320`: a draft needs a **German** title. `:368-384`: `validateForPublish`
  validates both locales. `:621,951`: the slug lock is pair-level
  (`existing.status === 'published'`). `:1007`: publish writes status and snapshot to **every**
  row of the key.
- `uploader/src/comments-public.ts:54-55,98-101,115-116,149,165`: the thread is merged over both
  locales, and `postedLocale ∈ {de,en}` is checked against nothing else.
- `uploader/src/backup.ts:37-39`: `DUMP_VERSION = 10`, with an allow-list of supported versions.
- `uploader/src/build.ts:96`: the child inherits `process.env` and gets no mode input.
- `uploader/src/wxr-parse.ts:50-52` skips any item without a Polylang `language` +
  `post_translations` category. `wp-import.ts:789` rejects a group that lacks either locale.
- `uploader/src/export.ts:89-97` writes `trips/<locale>/<slug>.mdx` for both locales and skips `''`.
- `uploader/src/redirects.ts:33-59` holds the legacy WP map: DE feed/category at root, EN under
  `/en/`.
- `uploader/src/server.ts:387` mounts **the basemap at `/map/*`** as a public route (`:243`).
  The not-found handler applies `legacyRedirect` (`:2194`).
- The uploader duplicates URL knowledge in three admin files. `uploader/public/editor.html:249`
  (`simonswanderlust.com/en/`), `admin-confirm.js:9` (`/en/<slug>/` in the slug-change confirm)
  and `about.html:179` (`/uber-mich/` · `/en/about-me/`).
- `uploader/public/desk.js:38-39` shows the "English body started / not started" hint.

---

## 3. Design point → recommendation index

| # | Issue decision | Recommended contract | Section |
|---|---|---|---|
| 1 | Route model per mode | Primary at root, secondary under its own prefix. Full table in §4. EN-only at root. | §4 |
| 2 | Absent-locale storage | Rows always exist. New per-row `omitted` flag plus a CHECK. `''` alone never means absent. | §5 |
| 3 | One-language story in DE+EN | Primary required, secondary optional per story via `omitted`. | §6 |
| 4 | Mode change on an existing install | Lock at the first story publish. After that, only "enable secondary" is allowed. Everything else is refused (409). No redirect migration. | §7 |
| 5 | Pages, comments, regions, WXR, MDX, dumps | §8, rule per surface | §8 |
| 6 | Admin surfaces | Only enabled locales are shown. An omit control on the secondary tab. Gate messages per locale. | §9 |
| 7 | Where the mode lives; how the build reads it | Postgres `site_language` (in dumps). `build.ts` passes `SITE_LANGUAGE_JSON` to the child. | §10 |

---

## 4. Decision 1 — route model

### 4.1 Recommended model

`localePrefix(locale) = locale === primary ? '' : '/' + locale`. Every public path in a locale is
`localePrefix(locale) + <that locale's own route word or slug>`. Route words and region slugs are
fixed per locale (`regionSlugs`, the About/map/destinations words) and **never** depend on the
mode, with one exception. The EN map page cannot be at root `/map/` because the app already owns
`/map/*` for the basemap (`server.ts:387`), so EN-at-root needs its own map word (§4.3, owner
choice O4).

### 4.2 Route table, all four modes

`—` = not built, not linked, not in the sitemap or any feed.

| Route | DE+EN, DE-primary (today, unchanged) | DE+EN, EN-primary | DE-only | EN-only (recommended: root) |
|---|---|---|---|---|
| Home | DE `/` · EN `/en/` | EN `/` · DE `/de/` | `/` | `/` |
| Story | DE `/<slug>/` · EN `/en/<slug>/` | EN `/<slug>/` · DE `/de/<slug>/` | `/<slug>/` | `/<slug>/` |
| About | `/uber-mich/` · `/en/about-me/` | `/about-me/` · `/de/uber-mich/` | `/uber-mich/` | `/about-me/` |
| Map page | `/karte/` · `/en/map/` | `/travel-map/`* · `/de/karte/` | `/karte/` | `/travel-map/`* |
| Regions index | `/reiseziele/` · `/en/destinations/` | `/destinations/` · `/de/reiseziele/` | `/reiseziele/` | `/destinations/` |
| Region page | `/reiseziele/<de>/` · `/en/destinations/<en>/` | `/destinations/<en>/` · `/de/reiseziele/<de>/` | `/reiseziele/<de>/` | `/destinations/<en>/` |
| RSS | `/rss.xml` (DE) · `/en/rss.xml` | `/rss.xml` (EN) · `/de/rss.xml` | `/rss.xml` | `/rss.xml` |
| 404 | `/404.html`, DE then EN copy, links `/`, `/en/` (unchanged) | EN then DE copy, links `/`, `/de/` | DE copy only, link `/` | EN copy only, link `/` |
| Sitemap | `/sitemap-index.xml` (+ `-0`), every built page | same | same | same |
| `x-default` | DE URL | EN URL | none emitted | none emitted |
| Language switcher | DE ⇄ EN | EN ⇄ DE | not rendered | not rendered |
| Legacy WP redirects (`redirects.ts`) | all 18 entries (unchanged) | none (§8.7) | the 9 DE entries only | none |
| Basemap (app, not built) | `/map/*` | `/map/*` | `/map/*` | `/map/*` |

\* `/travel-map/` is the recommended EN-at-root map word (owner choice O4). Region slugs, story
slugs and the About word are those of the locale itself.

**Alternative EN-only layout B (not recommended): EN under `/en/`.** All EN routes would be exactly
as in the DE-primary column's EN side (`/en/`, `/en/<slug>/`, `/en/about-me/`, `/en/map/`, …).
`/` would then have to serve something. A 301 to `/en/` is browser-cached indefinitely and would
shadow a DE root added later. A neutral static landing page is a thin, indexable root. The case
for B is that it keeps "EN under `/en/`" literally true, and EN-only → DE+EN DE-primary would
then move nothing. The case against B: EN-primary is already in scope (owner decision
2026-10-19), so the Golden Rule 2 exception is needed anyway (§4.4) and B saves no
authorization. B gives an English-only blog permanent `/en/` URLs and a root it cannot use. It
makes EN-only → EN-primary a move of every URL. It needs a fifth layout ("primary not enabled")
that the rest of this contract does not otherwise need. Storage (§10) supports B unchanged if the
owner picks it.

### 4.3 Collisions the route model creates (input to #287)

- **`/map/` is taken by the basemap** (`server.ts:243,387`, a public static mount). A story or page
  at `/map/` can never be served. Today that is only a latent story-slug hazard. In EN-at-root
  modes it would also hit the EN map page. Options for O4: `/travel-map/` (recommended),
  `/world-map/`, or moving the basemap to a non-word prefix in every mode. The last option is
  rejected. It changes asset URLs baked into existing releases and the DE+EN output, which #285
  requires to be byte-identical.
- **Root namespace in EN-at-root modes.** EN story slugs share `/` with the app's top-level Fastify
  routes (`/posts`, `/media`, `/settings`, `/login`, `/logout`, `/setup`, `/users`, `/comments`,
  `/health`, `/upload`, `/export`, `/import`, `/backups`, `/rebuild`, `/pages`, `/geocode`,
  `/api/*`, `/moderation/*`, `/admin/*`, `/auth/*`, `/ai-config`, `/ai-providers`, `/map/*`).
  English story titles collide with these far more often than German ones. They also share `/`
  with the EN fixed words (`about-me`, `travel-map`, `destinations`) and with `de`.
  **Contract:** an EN-at-root mode must not become selectable before #287's reserved-route check
  rejects every one of these as a root slug in the primary locale. The reserved list is derived
  from or tested against the registered Fastify route table, per #287.
- **`de` and `en` are reserved first segments in every mode.** A primary-locale story slug may
  never be `de` or `en`, even while the install is single-language, because adding the secondary
  locale later would then collide. Grandfathering of existing slugs follows #287.

### 4.4 Golden Rule 2 — statement, authorized exception and implementation amendment

**Statement.** The DE+EN DE-primary route set, and therefore every URL of simonswanderlust.com, is
unchanged by this contract. No mode change can move it (§7). Golden Rule 2 as written
(`CLAUDE.md:105-108`: "Live WordPress slugs MUST be preserved exactly: DE at root, EN under
`/en/` … Never rename a slug or route without explicit authorization") is a universal layout
statement. Serving EN at root on **any** install contradicts its text, and so do the matching doc
comments at `paths.ts:22-27`, `paths.ts:38-56` and `trips.ts:18`. The recommended EN-primary and
EN-only modes therefore **require owner authorization and an amendment of the rule in the same
change that ships them** (#285). This spec does not amend anything.

**Owner-authorized exception (approved through §20 on 2026-10-27).**
> I authorize that an install whose primary language is English — DE+EN EN-primary, or EN-only —
> serves English at the site root and, when enabled, German under `/de/`, per the route table in
> `docs/superpowers/specs/2026-10-27-issue-283-language-mode-contract.md` §4.2. The primary language
> is chosen before the install's first story is published and is locked thereafter. This
> authorization does not permit any change to the URLs of simonswanderlust.com or of any install
> whose primary language is German, and it does not authorize renaming any slug.

**Exception record fields** (per `CLAUDE.md` "Requirement Language and Exceptions"):
- **Waived:** the universal "DE at root, EN under `/en/`" clause of Golden Rule 2, for EN-primary
  installs only.
- **Reason:** owner decision 2026-10-19 put EN-primary in scope (#282).
- **Risk:** EN-root slugs collide with app routes, and an install's URLs move if its primary ever
  changes.
- **Compensating controls:** the primary lock (§7.1) and the 409 refusals (§7.2); the reserved
  root namespace (§4.3, #287); the byte-identical DE+EN route snapshot (#285); and the URL-set
  invariant test (§7.4).
- **Approver/date:** repository owner, interactive implementation session, 2026-10-27.
- **Review:** at the first EN-primary production install or 2027-10-27, whichever comes first.

**Draft amendment of `CLAUDE.md:105-108`** (to be applied by #285 only after the authorization is
signed):
> 2. **SEO Slug Contract (Critical)** — Published slugs and routes MUST be preserved exactly.
>    simonswanderlust.com, and every install whose primary language is German, keep the live
>    WordPress layout: DE at root, EN under `/en/`. An install whose primary language is English
>    (EN-only, or DE+EN EN-primary; owner-authorized <date>, see
>    `docs/superpowers/specs/2026-10-27-issue-283-language-mode-contract.md`) serves EN at root and
>    DE under `/de/`. The primary language is locked at the first publish
>    (`language_primary_locked`); no language-mode change moves a published URL. Encoded and tested
>    in `site/src/lib/paths.ts` and `trips.ts`, and mirrored by MDX filenames. **Never rename a slug
>    or route** without explicit authorization — it breaks live URLs and SEO.

**Draft doc-comment changes** (also #285, after authorization):
- `trips.ts:18` becomes "URL of a story: the primary locale at root, the secondary under
  `/<locale>/`. DE-primary is the live WP structure (DE root, EN `/en/`) — Golden Rule 2."
- `paths.ts:22-27` keeps its `@ai-warning` text and adds: "slugs are per locale and
  mode-independent; only `localePrefix` varies with the primary locale."
- The `paths.ts:38-56` helpers gain the same `@ai-warning`.
- `redirects.ts:6-9` adds "the map encodes the DE-primary WordPress layout; see §8.7".

**Alternatives if the owner declines the authorization:**
- (a) **No EN at root anywhere.** EN-primary leaves scope (the owner must reverse the 2026-10-19
  decision). EN-only uses layout B (§4.2). No amendment is needed.
- (b) **EN-primary authorized, EN-only under `/en/`.** The amendment is still needed, and the
  model gets two EN layouts. Rejected as incoherent.
- (c) **Recommended:** authorize both, as drafted.

---

## 5. Decision 2 — storage of an absent locale

### 5.1 Recommended: rows always exist, plus an explicit `omitted` flag

- Every story keeps **both** `posts` rows, as today. A row for a locale the story does not
  publish is the existing row with `slug = ''` (#119 sentinel) and **`omitted = true`** (new
  column, `boolean NOT NULL DEFAULT false`). Existing rows read `false`, which is exactly today's
  behaviour.
- **DB-level invariant (new CHECK, additive):**
  `CONSTRAINT posts_omitted_unpublished CHECK (NOT omitted OR (status = 'draft' AND published_snapshot IS NULL AND published_at IS NULL))`.
  Every existing row has `omitted = false`, so the constraint validates against existing data
  without rewriting it.
- Because the site loader reads only `status = 'published' AND published_snapshot IS NOT NULL`
  (`postgres-loader.ts:107-109`), an omitted row can **never** reach a build. The database
  enforces this, not the application.
- When a row is created:
  - **Single-language install:** the row for the disabled locale is created `omitted = true`,
    `slug = ''`, with empty content.
  - **DE+EN install:** the secondary row is created `omitted = false`. A translation is expected,
    and the author opts out explicitly.
  - **Primary row:** never omitted, in any mode (enforced by the application, since the primary
    lives in `site_language`).
- **Disabling the secondary locale** (allowed only before the lock, §7) sets `omitted = true` on
  every secondary row. All of them are unpublished-ever, so the CHECK holds. Draft text in those
  rows is **kept**, never wiped (Golden Rule 3). **Enabling** the secondary locale leaves existing
  stories' `omitted` values as they are. Those stories stay one-language until an author
  un-omits and publishes the translation.
- **`''` alone is never "absent".** A row with `omitted = false` and `slug = ''` is a
  not-yet-translated draft. Publish refuses it exactly as today (`checkSlug` in `validateLocale`).
  The distinction guards against a story silently going live in one language because the author
  forgot a slug.

### 5.2 Effects on identity, revisions and the snapshot

- **`translationKey`:** unchanged. It names one story, whatever its locale count. The
  `(translation_key, locale)` unique index and every `WHERE translation_key` reader keep working.
- **Pair status:** becomes the **primary** row's status (today: the DE row's, `posts.ts:820`).
  Publish validates the **requested** set under §10.1's transaction protocol, then writes
  `status = 'published'`, `published_at` and snapshots only to those rows. Other rows remain
  `draft` with no snapshot. Save never promotes a draft secondary merely because the primary is
  published. Unpublish writes `draft` to every row but retains existing snapshots and history.
  `hasUnpublishedChanges` includes requested-versus-committed coverage differences as well as
  working edits to requested rows; un-omit + Save must show pending changes.
- **Slug lock:** moves from pair-level (`existing.status === 'published'`, `posts.ts:621,951`)
  to **per row**. A row's slug is locked once that row's `published_at IS NOT NULL`. Filling the
  `''` slug of a never-published secondary row on a published story is therefore allowed. Today it
  would hit `slug_locked`, because `'' !== newSlug`.
- **Revisions:** the snapshot shape `{status, shared, de, en}` is unchanged. `PostLocale` gains
  `omitted?: boolean`, read as `false` when absent, so older revision rows stay readable.
  Restoring a revision goes through `upsertDraft`'s validation. A revision that would re-omit a
  since-published row is refused by the freeze rule (§7.3), never applied around it.
  `RevisionSummary.titleDe` becomes the primary-locale title (clean cutover of the field name in
  #284).
  Draft-slug-change consent considers enabled locales only: an older revision's disabled
  locale payload cannot demand confirmation for a value the save will ignore. Retained disabled
  slug/body values stay unchanged; enabled draft renames still require consent and published
  locale slugs stay locked.
  The route passes the language token used for this consent check into `upsertDraft`.
  Both stores recheck it under the language lock before writing. If activation enables the
  submitted secondary between route precheck and transaction, Save returns 409 without changing
  either locale; it cannot apply that newly enabled slug without the required confirmation.
- **Published snapshot (#20):** unchanged per row. Omitted rows never get one (CHECK).
  A never-published, non-omitted secondary may also have no snapshot: it is a requested draft,
  not committed publication. A draft save leaves existing published snapshots/status unchanged.
- **Draft start:** "a German title is required to start a draft" (`posts.ts:320`) becomes "a
  title in the primary locale is required".

### 5.3 Rejected alternatives

- **Absent rows (no row for an absent locale).** `postPairFromRows` returns `null` when a row is
  missing (`posts.ts:818`). Every reader (`get`, publish state, `list`, comments `publishedPair`,
  export, media usage, revisions, WXR pair identity, bulk publish) would need an optional-locale
  rewrite. The memory and pg stores would have to agree on it, and dumps would carry a new shape.
  Enabling the secondary later would need row creation on every story. The gain is nothing the
  CHECK does not already give: leakage-freedom is just as structural with the flag.
- **`''` slug as the absence marker (no flag).** This conflates "forgot to translate" with "not
  published in this language". In DE+EN mode, a forgotten EN slug would silently publish a
  story DE-only. There would also be no database-level guarantee, only application code.
- **Per-pair (`shared`) locale list instead of a per-row flag.** It is equivalent in meaning. But
  the CHECK needs the flag on the row it constrains, and a shared value is written twice
  (`upsertDraft`), which risks drift.

---

## 6. Decision 3 — one-language stories in DE+EN mode

### 6.1 Recommended

A story in a DE+EN install is publishable when its **primary** row is complete. The **secondary**
row is either complete (published in both languages) or explicitly `omitted` (primary only). A
story that exists only in the secondary locale is **not** publishable. An incomplete,
non-omitted secondary still refuses publish, exactly as today.

Why the primary is required: the root then always lists the complete catalogue, `x-default` is
always resolvable, and N° numbers stay gap-free in the primary log. It is also what makes
"enable secondary" a purely additive change (§7), because single-language stories are a state
DE+EN mode already supports.

### 6.2 Consequences (each already locale-scoped in code unless marked)

| Surface | Behaviour for a primary-only story in DE+EN |
|---|---|
| Story URL | Only the primary URL exists. No secondary URL, not even an empty one. |
| `hreflang` / `og:locale:alternate` | None on that story (`StoryPage.astro:39-43` already yields `undefined`). |
| Language switcher | Links the secondary home (`LangSwitcher.astro:13`, existing behaviour). |
| StoryHero translation link | Not rendered (no `translationOf`). |
| RSS | In the primary feed only (`byLocale`). |
| Sitemap | Only the built primary URL. |
| Map pins / homepage map teaser | In the primary locale's map only (`tripPins(…, locale)`). |
| Region pages (`liveRegions`) | Count the story only in the primary locale. A region whose only stories are primary-only is not built in the secondary (existing rule, `trips.ts:112`). |
| Stats line | Per locale, so DE and EN counts may differ. `tripStats`'s comment "the DE and EN sets mirror each other" (`trips.ts:69-70`) must be corrected in #285. |
| N° entry numbers | Per-locale chronology (recommended, owner choice O15). The same story can be N°07 in DE and N°06 in EN. Alternative: number by primary chronology, which leaves gaps in the secondary log. |
| Homepage cover (`featured`) | Newest flagged story **in that locale**. |
| JSON-LD | `inLanguage` = the page locale (`seo.ts:71`), unchanged. |
| Comments | Thread visible on the primary page. POSTs claiming the secondary are refused (§8.2). |

**Alternatives:**
- (a) **Both locales required** (status quo). This blocks single-language stories in bilingual
  installs. It also makes DE-only → DE+EN leave every existing story unpublishable-as-is, and
  conflicts with the additive transition in §7.
- (b) **Either locale alone.** This adds secondary-only stories, `x-default` pointing to a
  prefixed URL, and a root catalogue that is not complete. Rejected.

---

## 7. Decision 4 — mode changes on an existing install

### 7.1 The lock

The install is **locked** when either condition holds:
- `site_language.locked_at IS NOT NULL`. `locked_at` is set in the same transaction as the
  first successful story publish (`COALESCE(locked_at, now())`).
- Some `posts` row has `published_at IS NOT NULL`. `published_at` survives unpublish
  (`posts.ts:1028` writes only `status`), and `db.ts:144` backfills it for upgraded installs.

There are two sources so that a lost or restored `site_language` row cannot unlock an install
whose content was published, and deleting every post cannot unlock one either. An upgraded
installation (simonswanderlust.com) is therefore locked to DE+EN DE-primary at first boot.

### 7.2 Allowed transitions

| From → To | Unlocked | Locked |
|---|---|---|
| Change primary (any DE-primary mode ⇄ any EN-primary mode) | allowed | **409 `language_primary_locked`** |
| Enable secondary (DE-only → DE+EN DE-primary; EN-only → DE+EN EN-primary) | allowed after published-page preflight (§8.1) | **allowed** after the same preflight: adds URLs, moves none |
| Disable secondary (DE+EN → single) | allowed (secondary rows set `omitted`, §5.1) | **409 `language_locale_published`**: the secondary home, About, map, regions index and feed are published URLs |
| Same mode | no-op 200 | no-op 200 |

Pre-lock residual (owner choice O17): a pre-launch install that never published a story can still
change mode, and its fixed pages (home, About, map, regions index, feed) move. No story content
was ever published, so this is accepted as "not yet launched". The alternative is to lock at the
first release build. But the boot build (`bootstrapRelease`) creates a release on a fresh volume
before the installer can choose, so that would lock every install on DE+EN DE-primary.

### 7.3 Freeze rules after publish (per story)

- A row's slug is locked once that row has been published (§5.2).
- A secondary row may be omitted only if it has never been published. Otherwise the change is
  refused with `409 locale_published` (owner choice O7). To take a story's secondary URL offline,
  unpublish the story; the existing admin-only, confirmed action removes all of its URLs and moves
  none. Alternative: allow omitting a published row with a confirmation that names the URL, which
  then 404s. It was rejected because it creates a second, per-locale unpublish path that also has
  to handle comments.
- The primary row can never be omitted (400 `invalid_post`).

### 7.4 Published-URL-set invariant and the test that pins it

> **Invariant.** On an existing install, a language-mode change never removes or moves a path of
> the published URL set. Every change is either refused with a named error and the URL set is
> byte-identical afterwards, or it is "enable secondary" and the URL set after is a superset of the
> URL set before. No 301 is introduced by any mode change.

Tests:
1. **`uploader/test/language-mode.integration.test.ts`** (`TEST_DATABASE_URL`, #284).
   - Seed a published DE+EN story. For each refused transition, assert the 409 code, an unchanged
     `site_language` row, and an unchanged `publicUrlSet(config, rows)`.
   - Seed a DE-only install with a published story. Enable EN and assert that the old set is a
     subset of the new set.
   - Assert that the CHECK refuses `omitted ∧ published` with SQLSTATE `23514`.
   - `publicUrlSet` is the uploader's URL mirror (§11).
2. **Cross-tree parity:** `uploader/test/public-paths-parity.test.ts` runs the uploader mirror and
   `site/src/lib/paths.ts`/`trips.ts` over one fixture corpus in all four modes. This follows the
   `gallery-fence-parity` precedent, because the trees cannot share code.
3. **Built route snapshot** (#285): the sorted list of HTML/XML files in a DE+EN DE-primary build,
   compared byte-for-byte with a baseline captured on `dev` **before** any #285 code lands. There
   is also one snapshot per new mode.
4. **Runtime smoke** (#284/#285): build a release, attempt a refused `PUT /language`, rebuild, and
   diff the `releases/<stamp>` file lists. They must be identical.
5. **Publication/mode race:** barrier-controlled Postgres tests for both single and bulk publish
   versus primary change, secondary disable and secondary enable. Assert §10.1's lock order,
   mode/coverage revalidation, atomic snapshots plus `locked_at`, and valid serial outcomes;
   no publish validated under one mode may commit under another. Include stale post/GPX tokens,
   rollback on failed validation and failed build after commit. Assert exactly one ordinary
   rebuild per bulk batch and no recursive acquisition of the non-reentrant work lock.

### 7.5 Rejected: guided migration with 301s

A redirecting migration needs a persistent redirect table. `redirects.ts` is a static code map,
and the table would have to be in the DB and in dumps. It would have to cover every story, the
fixed pages, every region page, both feeds and the sitemap, plus an hreflang flip, all under one
transaction with a rebuild. 301s are cached aggressively, so a rollback would leave readers'
browsers on the new layout: the change is effectively irreversible. Demand is speculative, since
EN-primary exists for new installs (#282). Refusal can be relaxed later by a separate high-risk
spec. A redirect migration, once shipped, cannot be undone.

---

## 8. Decision 5 — per-surface rules

### 8.1 Pages (About)

- `pages` keeps both rows (`PagePair` unchanged). Content of a disabled locale is kept, never
  wiped.
- About is **built only in enabled locales**, at the route in §4.2. In DE+EN, both are built, as
  today, with no per-page omission in this contract. #287 requires complete enabled-locale
  content for published non-About pages and does not approve per-page locale omission. The
  interaction with enabling another locale follows the approved preparation/preflight transition
  below, not an exception to either contract.
- Enabling the secondary builds the secondary About from stored content. If that body is empty, the
  page uses `AboutPage.astro`'s existing fallback heading. That is the installer's explicit choice
  and is named in the confirm copy (§9).
- `about.html:179`'s "Live:" URLs come from the uploader mirror (§11).

**Q18 / #287 Q12 — approved: prepare translations before activation.**
DE-only can have a published contact page with empty retained EN fields. Enabling EN cannot
simultaneously promise immediate rebuilding, complete bilingual pages and no empty pages without
an explicit transition rule.

- **Approved:** preflight every published registry page's candidate locale.
  Non-About pages require complete secondary title/body/slug and the image gate; About requires
  its fixed route and image safety, but may retain its empty-title/body fallback. Refuse
  `PUT /language` with `409 language_pages_incomplete` and admin-only page/locale/field-reason
  blockers until all pass; no mode,
  page status, current URL or navigation change on refusal. An explicit **Language Settings →
  Prepare EN pages** flow (DE when EN-primary) exposes only the candidate inactive locale in the
  page editor, clearly marked not public. Ordinary single-language editing remains primary-only.
  Preparation reuses PUT plus `updatedAt`, preserves the active locale when omitted from the
  payload, permits incomplete inactive fields even on a published pair, and rebuilds only the
  current mode. Per-locale page `published_at` remains NULL while inactive, allowing an empty
  secondary slug to be filled despite pair-level published status. Activation rechecks the whole
  candidate set inside §10.1's transaction, stamps newly exposed page locales' publication
  history/slug locks and changes the mode without changing pair statuses (§D5.1 of #287).
  It commits before requesting a rebuild. Navigation resolves the new locale only after successful
  release activation; existing primary links remain unchanged.
- **Rejected alternative:** omit incomplete secondary pages until valid. This requires a new per-locale
  public-eligibility rule and an explicit exception to #287's bilingual completeness rule, with
  eligibility sticky once public. It is not already approved story omission semantics.
- **Rejected alternative:** require explicitly confirmed whole-page unpublication
  **before** activation. Never unpublish automatically. This separate action removes primary URLs;
  it cannot itself be claimed as §7.4's additive language transition.
- The owner approved the preparation/preflight option, not omission or automatic unpublication.
  Test the DE-only published-page → bilingual transition (and EN mirror), incomplete
  retained fields, image refusal, active-content preservation, navigation, concurrent page saves
  and build failure. After a committed activation whose build fails, the prior release stays
  live; retry rebuild under the committed mode, never silently roll metadata back.

### 8.2 Comments (public route: high risk)

- **One thread per story, merged across the committed published locale set.** This preserves the
  2026-09-14 comments spec decision 4 for DE+EN stories published in both languages, byte-for-byte.
- Replace `comments-public.ts`'s working-copy `posts.get()`/pair-status inference with an explicit
  `PostStore.getPublishedLocales(translationKey)` read in both pg and memory stores. It returns
  the committed locale set from enabled mode plus each row's status/snapshot in one consistent
  read; it exposes neither bodies nor private route data. No committed primary means no public
  story (404). The existing comment-enabled flags remain a separate check; do not change their
  semantics merely to obtain locale membership.
- **`POST /comments`:** `postedLocale` must be in the committed published locale set. Otherwise the
  route answers `400 invalid_comment`, the same generic code, so the route is no oracle for
  draft/omitted rows. This check sits after the existing published-pair check (404) in the
  documented order, which becomes "… → published pair (404) → posted locale in published set
  (400) → flags (409) → …".
- **`GET /comments`:** queries/returns approved comments only in the committed published locale set,
  then preserves the existing merge order, result cap and serialization.
  Comments outside that set may remain after unpublish or from legacy/cross-mode restored data.
  They are **not deleted**. They stay visible in the admin moderation queue with a "not shown
  publicly — <locale> not published for this story" label. Nothing is silently hidden from the
  admin, and nothing is exposed publicly.
- Author replies (`comments.ts:277`, default `'de'`) default to the **primary** locale.
- `comments.locale` CHECK unchanged. Public JSON shape unchanged.
- Un-omitting a secondary and saving **without Publish** must leave secondary POSTs refused and
  approved legacy/restored secondary comments hidden. Only successful publication admits that
  locale; failed validation, stale publish tokens or transaction rollback do not. Unpublish
  removes public eligibility even though snapshots remain. Pin these transitions in both store
  contracts, `comments-public.test.ts` and Postgres integration; preserve rate-limit, honeypot,
  Origin/Referer ordering, generic errors and the exact public JSON key set.

### 8.3 Region slugs

Fixed per locale (`regionSlugs`), identical in every mode. Only the prefix varies.
`liveRegions` is unchanged.

### 8.4 WXR import (`wxr-parse.ts`, `wp-import.ts`)

- **Polylang-tagged items** whose locale is **not enabled** are skipped and counted in a new
  `skippedLocale` bucket with a warning. They are never stored. The #100 bucket invariant
  ("every group lands in exactly one bucket") gains that bucket.
- **Group missing the primary member:** `rejected`, as today.
- **Group missing the secondary member (DE+EN):** imported as a draft with an empty, non-omitted
  secondary row. The author translates the story or omits the secondary. Today this group is
  `rejected` (`wp-import.ts:789`). Owner choice O14.
- **Untagged items** (no Polylang `language`/`post_translations`): today they are silently skipped
  at parse (`wxr-parse.ts:52`). In a **single-language** install they are imported as
  primary-locale single-member groups, keyed by the WP post id. In **DE+EN** they are counted as
  `rejected` with reason "no language", because which locale they belong to is ambiguous.
- **Pair identity (#99):** the identity tuple treats `''` as "no slug", so a primary-only group
  matches a stored story by its primary slug, and only if that story's secondary slug is `''`.
  Every other overlap stays `rejected`. #284 must extend the #99 identity tests to this case.
- The re-host key namespace `trips/<slug>/…` is unchanged and has no locale segment.

### 8.5 MDX export (`export.ts`)

A row is written iff its locale is enabled, it is not omitted, and its slug is non-empty.
This is a **working-content backup filter**, not proof that the row has been published; a
non-omitted translation saved without Publish may be exported but not built or commented on.
The DB dump stays the complete backup, including omitted rows and disabled-locale content.

**GPX projection contract (all consumers must migrate together).** `published-track.ts` currently
requires matching DE and EN snapshots. Replace that unconditional two-snapshot assumption with
validation of the **actual permitted snapshot-bearing locale set**, not the requested working
set or the currently public set. Both physical locale rows still exist. An omitted row must
satisfy the CHECK; a never-published secondary may have no snapshot even after it is un-omitted.
A retained snapshot on an unpublished row remains a last-published artifact, not a live route.
For the new format, reject a snapshot in a disabled/omitted locale, a missing primary snapshot
when any secondary snapshot exists, or a missing snapshot for a row claiming publication history.
Validate the enclosing row/mode state before treating a missing counterpart as legitimate.

If no permitted snapshot contains `track`, the public track is absent. If any contains it,
**every snapshot-bearing locale** must contain a valid closed-schema `PublicTrack` and all
projections must agree (coordinate order and run boundaries included). A counterpart snapshot
containing `{}` instead of the shared track remains corrupt, as do private fields, malformed
tracks and disagreeing projections. Do not fill any missing snapshot or track from working
`post_routes`, private geometry, an original GPX archive, another locale or current draft fields.
Pre-snapshot legacy content backfill remains route-free; it is not permission to synthesize GPX.

Required clean cutover: `PublishedTrackRow`/`publishedTrackOf`; pg and memory
`PostStore.getPublishedTrack`; `backup.ts` capture query and `validatePublishedTracks`, `readDump`
and restore validation; `export.ts` `exportAll`/`exportPost`; and `server.ts`'s single publish,
bulk publish and Export all callers. Carry the mode plus per-row status/history/omission and
snapshot membership needed for validation; a bare shared track must not accidentally stamp a
never-published secondary MDX export. Attach `track` only to exported locales having that validated
snapshot. Resolve/validate the complete artifact set before writing a pair's MDX files.
`readDump` callers for CLI previews, recovery-set retention/pruning, archive pins and recovery
summaries must receive the same version-aware validation, not a second looser reader.

Required GPX cases: DE-only, EN-only, bilingual-with-omitted-secondary, un-omit + Save without
Publish, successful secondary publication, unpublish with retained snapshots, and draft
route edit/detachment. Exercise dump capture → read → restore, single/bulk automatic MDX backup
and Export all. Extend `gpx-backup.integration.test.ts` without removing its private-field,
different-route or missing-track-in-an-existing-counterpart refusal assertions. A genuinely
absent permitted secondary snapshot succeeds; a corrupt claimed published snapshot still fails
before destructive restore SQL or pair export writes. Private recovery archives retain their
existing safety/ownership guarantees and never become public projection inputs.

### 8.6 Dump / restore across modes (`backup.ts`)

- **New dump version = next free integer** (11, unless #273's identity row lands first, in which
  case 12; coordinate). Added to the dump:
  - `tables.site_language`, one row: `primary_locale`, `enabled_locales`, `locked_at`.
  - `posts[].omitted`.
  
  `SUPPORTED_DUMP_VERSIONS` keeps all existing supported versions, including any intermediate
  #273 identity-only version. Older apps refuse the new dump through their allow-list. Identify
  formats by their declared version, not by permissively accepting missing language metadata.
- **Validation before any `DELETE`** (in `readDump`):
  - the `site_language` shape and values;
  - every posts row satisfies the omitted CHECK;
  - the primary row of each `translation_key` is not omitted;
  - both physical locale rows and their status/snapshot/history obey §5 and §8.5, using the
    dump's mode rather than the live destination's; GPX public projection agreement and
    private-field rejection hold across the permitted snapshot-bearing set.
  
  A violation raises `BackupError`, and nothing is deleted.
- **Legacy formats predating language metadata (v1–v10, plus an identity-only intermediate
  version if #273 lands first):** normalize `omitted = false` on every row and explicitly
  replace `site_language` with DE+EN DE-primary. Derive `locked_at` from the restored publication
  history after the existing route-free legacy snapshot/history backfill, not from the former
  live database. Restore these normalized rows and matching mode in the **same transaction**.
  A failed restore leaves both live content and live language metadata unchanged. Legacy formats
  retain their old two-locale GPX requirement; an absent new field must not legalize corrupt
  historical snapshots. A new-format dump missing required language metadata is rejected.
- **Restoring into a different mode:** content and its language config travel together. The
  dump's `site_language` **replaces** the live row, because restoring content under another
  layout would itself move every URL.
  - The `restore` CLI preview (#114) prints the dump's and the live mode.
  - When they differ **and** the live install is locked, the CLI additionally requires
    `--accept-language-change` beside `yes`/`--yes` (owner choice O11).
  - The pre-restore dump (#114) captures the live `site_language`, because it lives in
    Postgres, so the change is undone by restoring that dump.
  - Restore is outside the §7.4 invariant by design: it is a wholesale replacement the admin
    confirms.

### 8.7 Legacy WordPress redirects (`redirects.ts`)

The map encodes the DE-primary Polylang layout of simonswanderlust.com. Eligibility is controlled
only by the language layout, not by whether a target file currently exists:
- **DE+EN DE-primary:** all entries (unchanged).
- **DE-only:** the 9 DE entries only. The `/en/…` entries would 301 into a 404.
- **EN-primary and EN-only:** none. No WP layout is known for them, and a 301 to the wrong
  language's feed is worse than a 404.

Identity/canonical-domain changes (#273) never gate, add, remove or retarget these eligible
entries; there is no WordPress-install flag. Eligible category redirects remain active even for
empty regions whose target is not built (`redirects.ts:52–54`); the existing 301→404 is preserved.
There is no per-content existence probe. Test all 18 entries in every mode, including an empty
region, `/feed`, `/en/feed`, and an identity/domain change with unchanged language eligibility.

---

## 9. Decision 6 — admin surfaces (Editorial desk style retained; admin UI stays English)

- **Editor:** locale tabs are rendered only for enabled locales. In a single-language install there
  is no tab strip, just the one locale's fields. In DE+EN the secondary tab carries a checkbox
  "Publish this story in <German|English>" (checked = not omitted). It is disabled with an
  explanation once the row has been published (§7.3). The slug preview (`editor.html:249`) and
  the slug-change confirm (`admin-confirm.js:9`) show the URL from the uploader mirror (§11), never
  a literal `/en/`.
- **Desk:** the "English body not started" hint (`desk.js:38-39`) becomes "<secondary language> body
  not started". It is shown only in DE+EN and only for non-omitted secondaries. In single-language
  installs it is not shown.
- **Posts list:** columns per enabled locale. The `PostSummary` fields `titleDe`, `slugDe`,
  `slugEn` and `hasEnBody` are replaced by a primary-locale title, a per-locale slug map and
  `secondaryStatus: 'none' | 'omitted' | 'empty' | 'started'` (clean cutover in #284, with every
  caller migrated).
- **Publish gate messages** (`validateForPublish`, `publish-gate.ts`): checks and messages run over
  the **requested** locale set only, rechecked under §10.1's transaction. The format is
  `"German: title required"` (locale named). A
  disabled or omitted locale never produces a message. Foreign-image and not-ready-photo gates run
  over the same rows.
- **Settings → language section** (admin-only): shows the mode, the lock state and its reason
  ("Locked since <date>: stories have been published"). Allowed changes are offered with a
  confirmation that names their scope:
  - "Adds /en/ (home, About, map, destinations, feed). No existing URL changes." Name the
    About empty-body fallback when relevant. Published basic pages must pass Q18's preflight;
    show its explicit preparation flow when translations are incomplete, not a promise of immediate activation.
  - Refused transitions are shown disabled with the error's text.

---

## 10. Decision 7 — where the mode lives and how the build reads it

### 10.1 Recommended: Postgres, inside DB dumps

```sql
CREATE TABLE IF NOT EXISTS site_language (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  primary_locale  text NOT NULL CHECK (primary_locale IN ('de','en')),
  enabled_locales text[] NOT NULL
    CHECK (cardinality(enabled_locales) BETWEEN 1 AND 2 AND enabled_locales <@ ARRAY['de','en']),
  locked_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Recommended layout (A) additionally: CHECK (primary_locale = ANY (enabled_locales))
-- (dropped only if the owner picks EN-only layout B, §4.2).
```

- **Boot (idempotent).** `INSERT … ('de', '{de,en}', (SELECT min(published_at) FROM posts)) ON
  CONFLICT DO NOTHING`. An existing install is recorded as DE+EN DE-primary, locked when anything
  was ever published.
- **API (#284).**
  - `GET /language`: `requireAuth`, because the editor needs the enabled locales.
  - `PUT /language`: `requireAdmin`. It uses the shared **database transaction protocol** below,
    not the build work lock, to serialize mode changes with publication. It applies §7.2 and is
    refused with `400 invalid_language`, `409 language_primary_locked` or
    `409 language_locale_published`, or `409 language_pages_incomplete` under §8.1.
  - On success it commits first, releases database locks, then awaits the ordinary builder
    (owner choice O16). It must not wrap `builder.build()` in `workLock.runExclusive`: that
    method already acquires the non-reentrant lock. Build failure preserves the prior release
    and reports persisted-mode/build-failed distinctly; retry rebuild, not an implicit DB undo.
  - Responses are `no-store`.
- **One database lock/order for mode mutation and publication.** Begin transaction; acquire
  `SELECT … FROM site_language WHERE id = true FOR UPDATE` **first**; then acquire existing post
  pair/content locks (sorted keys for multi-key work), then route-version locks. Re-read the
  mode, publication-history lock, requested locales, current post and exact publish tokens under
  those locks. Validate completeness and publication gates against that mode/current content,
  then atomically commit snapshots/status/history and `COALESCE(locked_at, now())`.
  Expensive GPX projection may still be prepared outside the transaction, but its exact
  post/route tokens must be rechecked inside; never commit a projection for different inputs.
  Single Publish and every bulk-publish item use this same store operation. Bulk retains its
  existing per-item success/failure transactions and one rebuild after the batch, not an
  all-or-nothing redesign. Mode-changing omission updates also happen within this protocol.
  Draft saves/revision restoration/import writes that validate or change locale coverage acquire
  the language row before pair locks too; no path may invert that order or validate against a
  cached mode. #287 page publish, published PUT and page mutations affecting activation preflight
  join the same language-first order so preflight cannot race a page save.
  Publication/About image-readiness and activation-validation callbacks reuse that transaction's
  checked-out client, including title-image existence checks. They never acquire a second pool
  connection while holding the language row: other writers can consume the remaining pool
  connections waiting for that row, otherwise deadlocking the validating writer.
- No transaction above acquires or waits for the build/encode work lock. Release DB locks before
  calling the builder, which acquires the work lock **once**, opens the shared exported
  read snapshot below, and builds. The current work lock protects build/encode resource use;
  it does **not** serialize `posts.publish`'s earlier DB writes (`server.ts:1647,1735`, `build.ts:244`).
  Memory stores must model the same serial outcomes; Postgres barrier tests are the race proof.
- **Why not `settings.json`:** `settings.json` is not in DB dumps (`ARCHITECTURE.md`, Backups).
  The mode decides the URL of every published row. A dump restored into a fresh install would
  build its content under the default layout, which moves every URL of an EN-primary install. It
  would also put the lock beside the content it protects only by convention. Losing identity
  settings is cosmetic; losing the mode moves URLs.
- **#273 alignment** (advisory, no native link): DesignIdentity273 has confirmed that #273's
  proposal also moves identity to a single-row Postgres table in the dump. It uses the same
  propagation shape, with language, identity/assets and every database content loader bound
  to one exported PostgreSQL snapshot inside the build's exclusive lock, after mutation
  transactions release their locks. Stored identity maps may retain disabled-locale values.

### 10.2 Build propagation

- `build.ts` opens a dedicated `REPEATABLE READ READ ONLY` transaction inside
  `lock.runExclusive`, calls `pg_export_snapshot()`, and reads language/identity/assets from
  that same connection. It supplies `SITE_LANGUAGE_JSON={"primary":"de","locales":["de","en"]}`
  and internal `SITE_DATABASE_SNAPSHOT` to the child unconditionally. These are programmatic,
  **not** operator `.env` knobs.
- Every trips/pages/media-metadata/navigation loader imports that snapshot on a checked-out
  connection before its first query and keeps all related reads on that connection. Use
  #273 §6.1's shared `loader-pool.ts` helper. The exporter stays open until the child exits and
  is always released in `finally`, bounded by the existing build deadline. No fresh-read
  fallback on invalid/expired snapshot; no imported snapshot for live ownership checks/writes.
  PostgreSQL 18 requires `SET TRANSACTION SNAPSHOT` before the first query:
  [official contract](https://www.postgresql.org/docs/18/sql-set-transaction.html).
- A configuration-only parent snapshot is insufficient: after a bilingual build captures its
  mode, an unlocked install could disable EN and save private inactive EN page text before
  the child's loader query. Importing the same database snapshot prevents that text entering
  the old bilingual output, even if the queued replacement build fails. Barrier-test this
  interleaving and its EN-primary mirror, plus snapshot failure/timeout cleanup. Normal
  mutations may still commit while the older immutable build runs; no writer/build-lock cycle.
- `astro.config.mjs` and `site/src/lib/` validate `SITE_LANGUAGE_JSON` with Zod.
  - **Absent** means DE+EN DE-primary, so `npm run dev`, `astro check` and CI stay byte-identical.
  - **Present but invalid** fails the build. Integrity failures never fall back to a weaker
    default, and the previous release stays live.
- **Defense in depth:** the trips loader also drops rows whose locale is not enabled and logs the
  count. Omitted rows are already excluded by the CHECK plus the existing query.
- Route generation in #285 must come from one route table keyed by `(locale, kind)` plus
  `localePrefix`. The hand-placed `src/pages/en/*` twins cannot express EN-primary and become
  dynamic routes. `ui.ts` keeps both dictionaries complete (completeness test unchanged); a
  single-language build simply never renders the other one.

---

## 11. Contracts for dependents

| Consumer | Contract |
|---|---|
| **#284** | `site_language`, boot/API and §10.1's shared transaction protocol for single/bulk publication and coverage writes. Requested versus committed locale sets, explicit public-comment projection, `posts.omitted` CHECK, primary-row pair status, per-row slug lock and primary-title draft rule. WXR buckets. Every §8.5 GPX dump/export/restore consumer. Version-aware atomic language/content restore and CLI flag. Uploader URL mirror `publicPath(lang, locale, kind, slug?)` / `publicUrlSet(lang, rows)` replacing editor/confirm/About literals. Tests §7.4 (1)(2)(5); approved Q18 preparation/preflight transition. |
| **#285** | `SITE_LANGUAGE_JSON` parsing. `localePrefix`, the route table §4.2, hreflang/`x-default`/`og:locale:alternate`, switcher, feeds, 404, legacy redirects §8.7. Tests §7.4 (3)(4). Owns the Golden Rule 2 amendment and doc comments, conditional on §20. |
| **#287** | Reserves `de`/`en`, locale fixed words in their namespaces and every top-level Fastify route (including new `/language`) plus `/map/` at root before EN-at-root is selectable. About retains its DE-primary routes. Published non-About pages require complete enabled locales; secondary activation follows approved Q18 / #287 Q12 (§8.1). Page writes join the language-first transaction protocol. |
| **#308** | Journey routes use `localePrefix(locale) + <locale's journey word>/<slug>/`. A journey page in a locale lists only member stories published in that locale. Journey routes are built only in enabled locales. |
| **#281** | Offers the language choice only while unlocked. Once locked, the choice is read-only, showing the lock reason. |
| **#273** | Same storage family (Postgres, in dumps) and the same env handoff. Identity per-locale validation reads `enabled_locales`. The dump version bump is coordinated. |

---

## 12. Trust boundaries and misuse cases

| Boundary / actor | Misuse | Control |
|---|---|---|
| Anonymous reader → `POST /comments` | Posts into an omitted/disabled or un-omitted-but-unpublished locale, or probes for draft rows | Explicit committed published-locale read; never infer from working pair status/coverage. Same `400 invalid_comment`; published-story 404 unchanged. |
| Anonymous reader → static blog | Guesses `/en/<slug>/` of an omitted or draft translation | Never built: CHECK plus loader filter plus enabled-locale filter. |
| Author (non-admin) | Changes mode, or publishes a primary-only story | `PUT /language` is admin-only. Publish is already admin-only. Authors may toggle `omitted` on drafts only (it changes no public state until an admin publishes). |
| Admin | Swaps primary after launch (moves every URL) | `409 language_primary_locked`. The lock has two sources (§7.1). |
| Admin | Disables the secondary after launch | `409 language_locale_published`. |
| Admin | Omits an already-published translation | `409 locale_published`. |
| Admin via restore CLI | Restores a dump from another mode by accident | Mode diff in the preview, `--accept-language-change`, and the pre-restore dump. |
| Crafted dump | Omitted-and-published rows, an omitted primary, a bad `site_language` | `readDump` validation refuses before any `DELETE`. |
| Crafted WXR | Items in a disabled locale; untagged items in DE+EN | Skipped with the `skippedLocale` count, or `rejected`. Slug safety checks unchanged. |
| EN-at-root story slug | Squats `/posts`, `/login`, `/map`, `de`, … | Reserved namespace (#287) before EN-at-root is selectable. |
| Build env | Malformed `SITE_LANGUAGE_JSON` | Build fails. The previous release stays live. |

---

## 13. Invariants

1. The DE+EN DE-primary route set and its output are byte-identical to the pre-change baseline.
2. An omitted row is never `published`, never has a `published_snapshot` and never has a
   `published_at` (CHECK).
3. The primary row of a published story is complete and never omitted.
4. After the lock, the primary locale never changes, and the published URL set changes under a
   mode change only by growing (§7.4).
5. No locale outside `enabled_locales` appears in any built route, link, hreflang,
   `og:locale:alternate`, feed, sitemap entry, language switcher or public comment.
6. No migration, mode change or restore preview modifies an existing slug (#284 slug-set test).
7. Content of a disabled or omitted locale is never deleted by a mode change.
8. Comments are never deleted by a mode or coverage change. Public visibility follows the committed
   published set, never the requested working set; admin visibility is total.
9. Publication and language mutations use one language-first DB lock order; committed snapshots
   and `locked_at` agree with the mode validated in that transaction.
10. GPX validation uses permitted snapshot-bearing locales, preserves projection agreement and
    private-field rejection, and never synthesizes public tracks from working/private data.
11. Restore replaces content and matching language metadata atomically; logical dumps do not
    remove additive schema objects.

---

## 14. Leakage review (AC 3)

- **Drafts:** unchanged. Only `published_snapshot` reaches the build.
- **Absent locale:** the CHECK, the loader filter and the enabled-locale filter are three layers.
  The site emits no link to an unbuilt locale page: alternates are computed from built
  counterparts only (`StoryPage`, `RegionPage`, `liveRegions`).
- **Other-locale content:** a single-language build renders only the enabled locale's
  dictionaries, collections and feeds. The 404 page is single-language.
- **Comments:** POST refusal and GET filter (§8.2). Moderation remains admin-only (`requireAdmin`).
- **Admin APIs:** `GET /language` reveals the mode, which is public anyway from the URLs, and only
  to authenticated authors.
- **Test (#285):** build each single-language mode with the absent locale's rows holding a unique
  marker string in title, body and slug. Grep `dist/` for the marker, for `hreflang="<absent>"`
  and for `/<absent>/`. All must be absent.

## 15. SEO review

- **Canonical:** self-referencing, unchanged (`Base.astro`: `new URL(pathname, site)`).
- **hreflang:** emitted only when both counterparts are built. `x-default` points to the primary
  URL (DE in DE-primary, unchanged; EN in EN-primary). None in single-language builds, where a
  lone self-reference adds nothing.
- **`og:locale:alternate`:** only with built alternates.
- **Feeds:** one per enabled locale. The primary feed is at `/rss.xml` and the secondary at
  `<prefix>/rss.xml`. The `<language>` element and `site` link follow the locale. The
  `<link rel=alternate type=application/rss+xml>` points to the page locale's feed.
- **Sitemap:** unchanged integration. It lists exactly the built pages, so it is correct per mode
  without an i18n option. Adding sitemap hreflang is out of scope, to keep DE+EN output
  byte-identical.
- **`robots.txt` origin:** #273/#276.
- **Legacy 301s:** §8.7.

## 16. Compatibility and migration

- **Schema** (additive and idempotent, in `db.ts`):
  - `CREATE TABLE IF NOT EXISTS site_language`, plus the boot row.
  - `ALTER TABLE posts ADD COLUMN IF NOT EXISTS omitted boolean NOT NULL DEFAULT false`.
  - Add `posts_omitted_unpublished` only if `pg_constraint` lacks it. All existing rows satisfy
    it.
  - No locale CHECK, index or existing column changes.
- **Pre-migration dump:** #284 writes a `dumpDatabase` pre-dump before the first boot that adds the
  column or constraint. The updated reader restores it through §8.6's explicit legacy mapping;
  an older reader alone cannot reset newly introduced language metadata.
- **API:** `PostSummary`/`RevisionSummary` field cutover (§9, §5.2) with every caller migrated. The
  public comment JSON is unchanged.
- **Existing installs:** recorded as DE+EN DE-primary and locked. No observable change.

## 17. Rollback and containment

- **Containment, not blind image downgrade:** stop authoring/publish/rebuild operations and retain
  the last known-good static release and a complete current recovery set. An older image ignores
  `site_language`/`omitted`, derives pair status from DE, and can rebuild EN-primary or EN-only
  content under the wrong layout. Even DE-primary single-language/omitted stories are not
  behaviorally compatible: old pair publication fails the omitted CHECK and old GPX readers
  require two snapshots. Do not describe DE-primary rollback as universally safe.
- **Supported data recovery:** use the updated, security-fixed restore reader/CLI, its offline
  restore ownership safeguards, required pre-restore dump and existing archive validation.
  Inspect the live/dump mode and confirm the exact recovery set; require
  `--accept-language-change` when locked and different. Restore the pre-change dump using
  §8.6's version-aware normalization. In one transaction restore content, explicit omission
  defaults and matching DE+EN DE-primary language metadata, deriving history from restored data.
  New-format recovery instead restores its own recorded mode. Failure rolls back both.
- **Schema remains upgraded.** Logical dump restore replaces known row data; it does not drop
  `site_language`, the `omitted` column or CHECKs. Boot's `ON CONFLICT DO NOTHING` must see the
  intentionally restored mode, not a stale EN-primary row left by an older restore. Test restart
  after legacy restore into an upgraded EN-primary database, including a failure before commit.
- Validate/rebuild the restored state with the updated compatible image before serving a new
  release. Keep the old static release if that build fails. A code rollback needs a separately
  assessed compatible, security-fixed image; **never roll back #347's security fixes** to obtain
  an older dump reader. New dump versions remain refused by old readers.
- **Mode rollback:** before the lock, use `PUT /language` back. After the lock, undoing secondary
  activation means confirmed restoration of the pre-change content/config recovery set; it is
  not an in-place locale disable or a schema rollback. Q18's post-commit build failure normally
  recovers by rebuilding the committed mode, without data rollback.

## 18. Acceptance verification (what the implementing children must show)

| Check | Owner |
|---|---|
| Route-list snapshot: DE+EN DE-primary identical to the pre-change baseline | #285 |
| Full `astro build` in all four modes against Postgres, with route lists matching §4.2 | #285 |
| Leakage marker test (§14) for DE-only and EN-only | #285 |
| `paths.test.ts`/`trips.test.ts` slug-contract cases unchanged and green, plus per-mode cases | #285 |
| `language-mode.integration.test.ts` (§7.4 (1)), including CHECK `23514` | #284 |
| Cross-tree path parity test (§7.4 (2)) | #284 |
| Slug set before/after migration identical | #284 |
| Dump: coordinated/intermediate versions; atomic content+mode round-trip; legacy restore into upgraded EN-primary then restart; failure rollback; crafted-dump rejection before DELETE; older app refuses new version | #284 |
| GPX: §8.5 single-language/omitted/un-omitted/unpublished lifecycle through dump capture/read/restore, automatic single/bulk MDX and Export all; agreement/private-field/missing-counterpart failures retained | #284 |
| Comments: un-omit + Save without Publish stays private, successful Publish admits, failed Publish changes nothing, unpublish with retained snapshots hides; GET filter/POST 400, merged DE+EN thread and moderation label | #284 |
| Barrier races: single/bulk publication and mode changes, mode/coverage/token recheck under DB lock, atomic `locked_at`, no recursive work lock; build-failed-after-commit recovery | #284 |
| Legacy redirects: language-layout matrix, empty-region 301 retained, identity/domain changes leave eligible map unchanged | #285 with #273 |
| Secondary activation with published pages, preparation/validation/nav/races/build failure: implement and test only the explicitly selected Q18 / #287 Q12 outcome | #284/#287 |
| WXR: `skippedLocale` bucket. Primary-only group → draft. Untagged-item rules. #99 identity with `''` | #284 |
| Runtime smoke per mode: switcher, feeds, comment island, map, region pages, refused-change release diff | #284/#285 |
| `SECURITY.md` (Public comments, Backups, Known limitations: image rollback), `ARCHITECTURE.md` (Data model, Content pipeline, Database dumps), `DESIGN.md` (language switcher per mode) | #284/#285 |
| `CLAUDE.md` Golden Rule 2 amendment and doc comments (§4.4), only if §20 authorization is signed | #285 |

## 19. Documentation impact (drafted here, applied by the children)

- **`SECURITY.md`:**
  - *Public comments:* committed-locale projection, posted-locale rule and new order step.
  - *Backups:* cross-mode flag, atomic legacy language reset and snapshot-bearing GPX validation.
  - *Known limitations:* image rollback compatibility; retain #347 security fixes and upgraded schema.
  - *Authorization:* `PUT /language` is admin-only.
- **`ARCHITECTURE.md`:** `site_language` in *Data model*, the `SITE_LANGUAGE_JSON` handoff in
  *Content pipeline*, the dump version in *Database dumps*.
- **`DESIGN.md`:** the language switcher is absent in single-language modes and its order follows
  the primary.
- **`CLAUDE.md`:** Golden Rule 2 (§4.4), Project Status, and the high-risk list gains
  "language mode / `site_language`".

---

## 20. Owner decisions to batch, and approval record

| # | Decision | Recommended | Alternatives |
|---|---|---|---|
| O1 | Model: primary at root, secondary under its prefix; EN-primary route table §4.2 | approve | — |
| O2 | EN-only location | root (layout A) | `/en/` (layout B, §4.2) |
| O3 | Sign the Golden Rule 2 authorization (§4.4) | sign as drafted | decline → alternative (a) or (b) |
| O4 | EN-at-root map page path | `/travel-map/` | `/world-map/`; moving the basemap (rejected) |
| O5 | Absent-locale storage | rows always exist + `omitted` + CHECK | absent rows; `''` only |
| O6 | One-language stories in DE+EN | primary required, secondary optional | both required; either |
| O7 | Omitting a once-published translation | refused (`locale_published`) | allowed with a confirm, URL 404s |
| O8 | Mode change after first publish | refuse all except enabling the secondary | redirecting migration; freeze everything |
| O9 | Lock trigger | first story publish (two sources) | first release build |
| O10 | Mode storage | Postgres `site_language`, in dumps | `settings.json` |
| O11 | Cross-mode restore | dump config replaces live; extra `--accept-language-change` when locked and different | `yes` only; refuse cross-mode |
| O12 | Comments | thread merged over published set; non-published-locale comments kept, admin-visible only | show all (contradicts the epic leakage AC) |
| O13 | Legacy WP redirects | language-layout eligibility only (§8.7), not per-content target existence | unconditional in every language mode |
| O14 | WXR: group missing the secondary in DE+EN | import as draft | reject (today) |
| O15 | N° numbering | per locale | primary chronology with gaps |
| O16 | `PUT /language` publishes immediately | awaits a rebuild | persist only |
| O17 | Pre-launch fixed pages may move before the lock | accept | lock earlier (O9 alternative) |

**Additional decision Q18 (same as #287 Q12), approved 2026-10-27:** the repository owner
selected **“Prepare translations before activation”** after the corrected contracts were pushed
to PR #406 at `8542d78fa1f9168c0313d2cffdef3d17830eba6d` and PR #407 at
`93619a0ccb665c27152dff67fce496b779a3b38d`. This approves §8.1's explicit inactive-locale
preparation and activation preflight, preserving primary URLs and pair-level page lifecycle.
It does not approve per-locale page omission, automatic unpublication or existing URL migration.
F2–F6 remain correctness clarifications of the approved invariants, not new product choices.

**Approval record: approved.**
- **Approver/date:** repository owner, interactive implementation session, 2026-10-27.
- **Evidence:** **“Approve four-mode contract”**, linked to PR #406 at
  `85ee0ddfc4eea053a0f51c1a8ad370f2e6f5aea6`.
- **Decisions:** the recommended four-mode contract, including O1–O17, with no requested deviation.
- **Golden Rule 2 authorization:** expressly approved as stated in §4.4; no existing
  simonswanderlust.com URL or slug may be renamed.
- **Review:** first EN-primary production install or 2027-10-27, whichever comes first.
- Release, deployment and production/owner-content changes remain outside this authorization.

## 21. #284 implementation qualification (2026-10-29)

The isolated current-source qualification exercised all four language modes through the real
authoring, publication and recovery paths. Retained evidence separates the original baseline
(361 HTTP records / 48 screenshots), corrected phase (481 / 54), and final phase (210 / 12);
the earlier evidence is not relabelled as proof of later fixes.

- Readiness validation reuses the locked transaction client. Concurrent activation cannot bypass
  draft-slug consent: both stores recheck the route's captured language token under that lock.
- Mirrored first About preparation preserves an explicit `updatedAt: null`; actual browser saves
  returned 200, preserved active content and did not activate the candidate. Stale replay returned
  409. Ordinary boot seeds About rows, so the null boundary was exercised in backed-up synthetic
  database clones with only their cloned default About rows removed—not called a fresh-boot state.
- The final phase exercised GPX publication/export/archive/restore/restart in all four modes,
  actual current CLI restores of dump formats 1–11, patched older-v10 reader rejection, populated
  pre-language migration and public-comment/moderation locale workflows. Historical reader proof
  is limited to patched v10; restoring older formats with the current CLI is not an older-binary test.
- Uploader TypeScript and its complete PostgreSQL-enabled suite, site tests, Astro check and an
  actual build passed after the null-token correction. Eight public desktop/mobile axe audits
  reported zero violations; retained shared-shell best-practice and incomplete-audit observations
  mean this is not a blanket WCAG claim.

Reports and synthetic fixtures remain in the gitignored execution ledger. Final PR review/CI and
downstream combined-source qualification are separate gates. Public routing belongs to #285,
canonical origins to #276, and the page registry/navigation to #288/#289; this record does not
claim those dependent stacks are merge-ready or authorize production changes.

## 22. #285 public-output qualification (2026-10-29)

The actual-build matrix compares a pre-change DE-primary bilingual baseline with all
four approved modes using synthetic published stories and retained inactive-locale
content. Five built-route contract cases pass, covering HTML/RSS inventories, locale
links, SEO, comments configuration and absence of inactive content. The RSS endpoint
uses Astro's URL-derived `currentLocale`: actual prerendering reused primary-locale
endpoint props for the secondary feed, which the real-build assertion caught.

Managed-browser qualification of those outputs passed 138 desktop/mobile page cases,
48 reciprocal switcher round trips and 62 HTTP cases; 208 image instances decoded
without horizontal overflow or unexpected network failures. Eight map fallback links
were exercised. Evidence is retained under
`.local/backlog-execution-2026-10-27/issue-285-runtime/` (`results.json`,
`browser-results.json` and screenshots). The fixture serves real build output with
production PostgreSQL comment stores and the production redirect resolver; it is not
a full `buildServer`/authentication/deployment proof, and intentionally absent basemap
assets do not establish rendered-basemap qualification.

Existing singular-count copy (“1 COMMENTS” / “1 KOMMENTARE”) was also observed on the
baseline and is not a routing regression. #284's independent authoring/publishing
qualification, final PR review and required CI remain separate gates.

### Unit-test configuration boundary (#285, 2026-10-29)

CI exposed a unit test importing the now database-backed `astro.config.mjs`.
Astro and the standalone Markdown renderer now consume the same `MARKDOWN_OPTIONS`
object instead of comparing two copies. The obsolete configuration-value assertions
are removed; rendered gallery markers, highlighted classes and sanitization regressions
remain. A database-free focused run passed all eight Markdown cases; full site tests,
Astro check and the real build passed in wave `1793274723357_17653`. Build language still
requires PostgreSQL; no fallback, skip or production guard was added.

## 23. #284 current-dev integration (2026-11-01)

Merged onto `dev` 65b110d (dump v11 → this change's v12). Decisions taken while
integrating, each pinned by an updated or retained test:

- **Namespace rollout (D2.6).** The read-only reverse-collision query ran against the
  owner-confirmed content target on 2026-10-31: no story (working or published
  snapshot) or page holds any reserved or newly proposed segment in DE-primary or
  EN-primary mode. `dev` meanwhile gained the top-level `POST /gallery/analyze` route
  (#354); the route-equality test therefore reserves `gallery` in `APP_SEGMENTS`, and the
  same read-only query found no holder.
- **Untranslated WXR items (#387).** In bilingual mode an item with a language but no
  translation group stays an individually reported `untranslated` rejection; only an
  item with no language at all is `no language`. Single-language mode still keys untagged
  items by WordPress id. A group holding the primary imports primary-only.
- **Publication body gate (#375).** The rendered-body analysis runs once per requested
  locale on the reviewed pair before any mutation (H1 → 400, foreign images → 409). Under
  the language lock only media readiness is re-read; the publish tokens prove the locked
  pair is the analyzed one.
- **Page saves (#344).** The Postgres store takes the shared language row first, then the
  page's advisory lock, then reads; the memory store serializes saves on the language
  queue. Saves of a language-limited payload return only the sent locales' gallery
  warnings and leave the other locale's advisory state unchanged.
- **Drafts.** Gallery normalization runs inside the post-pair lock, because a disabled
  locale keeps the stored row read under that lock; its slug is not re-validated.

## 24. #285 current-dev integration (2026-11-01)

Merged `dev` after #284 landed. `astro.config.mjs` keeps this change's `MARKDOWN_OPTIONS`
import (build and preview cannot diverge), so the lockstep test now pins the processor
wiring and gallery exclusion instead of comparing two option objects. The About loader keeps
dev's prose-description extraction and per-locale inline image sizes and applies them only to
enabled locales, after the language assertion inside the loader snapshot. `byLocale` keeps
dev's total `translationKey` tie-break and returns nothing for a disabled locale.

Verification at the merge: site tests 668/668, `astro check` 0 errors, `astro build` and the
uploader typecheck pass; the PostgreSQL-enabled uploader suite passed except one heavy test per
run (`build-snapshot` once, `gpx-worker` once), neither touched by this change and both passing
in isolation. A real app booted from this worktree published a bilingual DE-primary story (DE
at root, EN under `/en/`, reciprocal `hreflang`, per-locale RSS) and refused both a primary
change and removal of a published locale with 409; a fresh EN-primary instance served an
EN-only story at root, 404 under `/en/`, `lang="en"` and no alternate.

## Pre-route databases at first boot (2026-11-01)

The boot-time pre-language recovery set read `post_routes` unconditionally. A
database older than private routes (v10) — the owner's current production
schema, which also predates site identity — therefore crashed boot with
`relation "post_routes" does not exist` before any migration ran. Found while
booting the held #289 stack against an isolated restored copy of the owner
database (G1 plan; the owner database itself was only read by `pg_dump`).

`dumpDatabase` with `preLanguageMigration` now checks `to_regclass('post_routes')`.
When absent, the set is labelled v9 (`ROUTES_DUMP_VERSION - 1`) and carries no
`post_routes` key, which is exactly what `readDump` requires below v10; identity
metadata without the route schema is refused rather than mislabelled. Outside the
pre-migration path the table stays mandatory.

Evidence: `backup.test.ts` covers both shapes (failing before the change); the
owner copy booted to `/health` ok with a built release, the v9 set passed
`readDump`, and `restoreDatabase` restored it into a freshly migrated schema
(18 posts, 2 pages, 698 media rows, language defaulted to `de`).
