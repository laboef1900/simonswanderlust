# Site identity contract: storage, build propagation, origins and assets (#273)

**Date:** 2026-10-27
**Issue:** #273 (design child of epic #272; blocks #274, #275, #276)
**Risk:** HIGH. The contract covers the Postgres schema and backups, the in-process build
pipeline, SEO output (`Astro.site`, canonical, `hreflang`, sitemap, RSS, JSON-LD), the public
comment Origin check, and an image upload path.
**Status:** **OWNER APPROVED, 2026-10-27.** The owner selected **“Approve proposed Postgres
contract”** for PR #405 at `4692ecf30785fa911084e6f328345f255263e7d4`. The identity/assets
contract and its upgrade/recovery rules are approved; #274, #275 and #276 may proceed in
dependency order. This design PR itself changes no runtime or owner content. The implementation
must apply the applicable SECURITY.md, ARCHITECTURE.md and CLAUDE.md deltas in §21–§22.
**Baseline:** `origin/dev` at `11e16d1` (v0.17.1, dump version 10 with private GPX archives
after #271). All `file:line` references below were verified at that commit unless marked
`[INFERENCE]`.

---

## 0. Owner decisions to batch

Each row is a choice that only the owner can make. The **Recommended** column is the contract
the rest of this document is written against. If the owner picks an alternative, every section
that cites that row ID changes with it.

| ID | Question | Recommended | Alternatives (rejected, with reason in the cited section) |
|---|---|---|---|
| **O1** | Where does identity live? (decision 1) | **Postgres**: a singleton `site_identity` row plus a `site_identity_assets` table, both carried in DB dumps (§4) | `settings.json` (outside dumps, §4.3 R1); a mix of settings.json for text and files for assets (R2); env vars (R3) |
| **O2** | Fresh vs existing install (decision 9). **This is the key choice: a safe neutral identity on fresh installs vs preserving the existing brand.** | **Evidence-based one-time seed.** At the first boot of the identity version, if the database already has a user or a post, the singleton is seeded with the **legacy brand** (exact current strings, so output is byte-identical). Otherwise it is seeded **neutral** (empty values that render localized neutral fallbacks, no canonical origin). The seed runs exactly once (§12) | (b) always neutral, and the owner re-enters identity after the upgrade; (c) always legacy, so every fresh install inherits "Simon's Wanderlust"; (d) an operator-run `seed-identity --legacy` CLI step before the upgrade (§12.4) |
| **O3** | Restoring a dump from before identity (v≤10) | **Restore sets the legacy brand** (`seed_source = 'restored-legacy'`), because such a dump comes from a version whose output *was* the legacy brand. The CLI says so and points to Settings (§13.2) | Preserve the live identity row (the `app_secrets` v5 precedent). Rejected: disaster recovery onto a fresh host would rebuild the blog neutral and unindexed |
| **O4** | Which origin the comment Origin check uses (decision 4) | **The configured canonical blog origin**, by equality. While it is unset, #319's source applies. With neither, refuse (403) (§7) | The request's own scheme + `Host` (same-origin, as GPX mutations do), §7.4 |
| **O5** | Fresh install with no canonical origin | **Unconfigured mode.** The build uses the reserved placeholder `https://unconfigured.invalid`, every page carries `<meta name="robots" content="noindex">`, and `robots.txt` says `Disallow: /` with no `Sitemap:` line. Settings shows a banner (§8.2) | Block the build until the origin is set (blog answers 503 after setup); omit absolute URLs (many template branches); keep `simonswanderlust.com` as the default (a cross-domain canonical claiming the installer's content for Simon's site) |
| **O6** | Per-locale fields (decision 3) | **Shared:** site name, author name, social link labels. **Per-locale:** tagline, About role, About gear, studio descriptor (§5) | All per-locale (the site name has never differed per locale; `ui.test.ts:38` allow-lists it as identical on purpose); all shared (taglines already differ) |
| **O7** | SVG logo/favicon (decision 6) | **Refuse SVG.** Accept PNG, JPEG and static WebP. Re-encode to PNG with sharp and strip all metadata (§9) | Sanitize SVG (a parser-differential surface on the blog origin, which has no CSP); store the original bytes |
| **O8** | Where logo/favicon bytes live (decision 6) | **`site_identity_assets` (bytea, ≤ 256 KiB per row, in dumps).** The build copies them into each release under `/_identity/` (§9.4) | Media library key on the image host; a `/data/identity/` directory (outside dumps and the images archive) |
| **O9** | Social links (decision 7) | **≤ 6 links**, `https:` only, admin-chosen plain-text label (1–40 characters, shared across locales), rendered `target="_blank" rel="noopener noreferrer"` exactly as today (§10) | Add `rel="me"` (useful for Mastodon verification, but it changes the existing install's markup, so the owner must accept that); allow `mailto:`; a platform allow-list |
| **O10** | Does saving identity rebuild the site? (decision 8) | **Persist only**, following the comments-switch precedent. The response and UI say "public site updates at the next Publish or Rebuild"; Settings offers an admin **Rebuild site now** button. The comment Origin check and author-reply name take effect immediately (§11) | Auto-rebuild on save (each save holds the exclusive lock for up to 15 minutes and preempts encodes) |
| **O11** | Legacy WordPress redirects (decision 5) | **Stay unconditional.** They are root-relative and domain-independent (§8.3) | Gate them behind an "imported from WordPress" flag |
| **O12** | Simon-specific code defaults (decision 5) | The compose `PUBLIC_BASE_URL`/`IMG_HOST` defaults become `:?` in **#293** (owner decision of 2026-10-19, already recorded there). **#276** changes the code fallbacks in `main.ts:76`, `cli.ts:404` and `site/src/lib/images.ts:60` to the neutral `http://localhost:3000`. `.env.example` keeps the owner's hosts as *examples* until #293 rewrites it. No new `.env` knob (§8.4) | Make `PUBLIC_BASE_URL` mandatory in code too (bare `npm run dev` stops working without an env file); keep the Simon fallbacks |
| **O13** | Product token in outbound identification (Nominatim `User-Agent`, OpenRouter `X-Title`) | `User-Agent: <token>/<app version> (+<canonical origin>; editor location lookup)`. The software token is #291's decision; until #291 decides, the token stays `SimonsWanderlust`, allow-listed under #291. `X-Title` = the site name when it is printable Latin-1, otherwise omitted (§8.5) | Use the site name as the UA product token (not a product identifier, and it changes whenever the owner renames the blog) |
| **O14** | Live finding F1: the live author-reply path publishes the admin's **login username** | #274 switches the live path to the identity author name. The owner decides whether F1 also gets its **own bug issue** now, so it does not wait on the #273 approval (§2.2) | Leave it inside #274 |

Approving this spec means approving O1–O14 as recommended, or naming the alternative chosen
for each row in §23.

---

## 1. Why, scope, non-goals

Identity is spread across source constants, a static file and environment defaults:
`site/src/i18n/ui.ts`, `site/src/lib/seo.ts`, `site/astro.config.mjs`,
`site/public/robots.txt`, `site/src/components/{Nav,Footer}.astro`,
`site/src/components/pages/AboutPage.astro`, ten admin HTML `<title>`s, the
`uploader/src/{comments,editorial-review,geocoding,main,cli}.ts` constants,
`uploader/public/llm.js`, and `docker-compose.yml`/`uploader/.env.example`. An installer other
than the owner cannot rename the blog, set its domain, or remove "Simon" without editing source.

**In scope:** one contract that #274 (text identity and social links end to end), #275
(logo/favicon) and #276 (canonical domain and origin roles) can code against.

**Non-goals (from #272/#273):** implementation; theming, custom CSS or fonts; multi-site;
per-author profiles; renaming any slug or route; server-side fetching of remote logos;
automatic old→new domain redirects; DNS/TLS automation. The `Wanderlust Studio` product name and
the `simonswanderlust-app` image/package name belong to #291. The About page *body*
(`pages` table, seeded from `ABOUT_SEED`, `uploader/src/db.ts:8-17`) is profile content owned
by #286/#289, not identity.

---

## 2. Verified starting points

### 2.1 Code facts the contract depends on

- **Settings store.** `uploader/src/settings.ts`: `Settings` (`:13-52`), `defaultSettings()`
  (`:71-95`), and per-field `FIELD_CHECKS` (`:103-146`). The loader merges the file over the
  defaults field by field (`loadSettings`, `:195-254`), so an absent key silently takes the *current code
  default*. `update()` persists the **whole** merged object (`:280-285`). Any admin save
  therefore writes every field, including `reviewPrompt`. The file is not part of DB dumps
  (`ARCHITECTURE.md:503-505`). Restore is offline, and the app is restarted afterwards
  (`uploader/src/cli.ts:72-74`).
- **Build.** `runChildBuild` builds the child env as `{ ...process.env, ASTRO_TELEMETRY_DISABLED }`
  (`uploader/src/build.ts:96`). `runAstroBuild` spawns plain node with cwd `siteAppDir`
  (`:146-149`). Builds run under `lock.runExclusive`, with one-deep coalescing (`:220-270`). A
  release is built into `siteAppDir/.build-tmp/<stamp>` and then staged and renamed
  (`:182-217`). `bootstrapRelease` builds only when no release exists (`:307-330`), so an
  upgrade boot does **not** rebuild the blog.
- **Image origin into the build.** `imageOrigin(import.meta.env.PUBLIC_BASE_URL)`
  (`site/src/layouts/Base.astro:37`, `site/src/lib/images.ts:72-79`) and the loaders'
  `process.env.PUBLIC_BASE_URL` (`site/src/lib/postgres-loader.ts:100`, `pages-loader.ts:36`)
  establish the precedent: build-time configuration reaches the child through the inherited
  environment.
- **Canonical origin.** `site: 'https://simonswanderlust.com'` (`site/astro.config.mjs:9`);
  `PROD_SITE` (`site/src/lib/seo.ts:13`) as the fallback in `Base.astro:26` and
  `StoryPage.astro:46`; static `site/public/robots.txt:4`. No `noindex` exists anywhere in
  `site/src`.
- **Origins at runtime.** Blog and admin are served on any `Host` other than `IMG_HOST`.
  `IMG_HOST` serves variants, and serves the blog only when it is a loopback authority
  (`uploader/src/server.ts:2155-2162`). GPX mutations compare `Origin` with the request's
  scheme and forwarded `Host` (`SECURITY.md:33-36`).
- **Comment Origin.** `allowedOrigin: cfg.commentsOrigin ?? new URL(cfg.baseUrl).origin`
  (`uploader/src/server.ts:1859`). `main.ts` passes no `commentsOrigin` (`buildServer({…})` at `:143`).
  `SECURITY.md:194-196` documents the image-origin rule. This is bug **#319**, still open at
  `11e16d1`.
- **Cross-tree imports exist.** The uploader already imports pure site modules
  (`uploader/src/body-content.ts:25` → `site/src/lib/gallery-layout.js`;
  `uploader/src/preview.ts:12-13`; `uploader/src/gpx-copy.ts:1` → `site/src/i18n/ui.js`).
- **Admin copy script.** `GET /admin/editor-image-copy.js` (`uploader/src/server.ts:1361`)
  has no session preHandler. It serves `window.EditorCopy` from the `editor.chrome.*` keys of
  `ui.ts` (`:1374-1383`), which `auth.js:190-209` and `login.html:39-41` paint with
  `textContent`.
- **Dumps.** `DUMP_VERSION = 10` with an allow-list `SUPPORTED_DUMP_VERSIONS`
  (`uploader/src/backup.ts:37-39`). Table set at `:209`.
- **Global headers.** `X-Content-Type-Options: nosniff` on every response
  (`uploader/src/server.ts:231-245`).
- **Default favicon.** `site/public/favicon.svg` is the stock Astro starter mark with a
  `prefers-color-scheme` style. It carries no owner branding, so it can stay as the
  neutral default, and the existing install keeps it (it has no custom favicon today).

### 2.2 Findings made while verifying (not decided here)

- **F1. The live author-reply path publishes the admin login username.**
  `POST /moderation/comments/:id/reply` calls
  `commentsAdmin.replyAsAuthor(id, req.authUser?.username ?? 'Author', body)`
  (`uploader/src/server.ts:1922`). `pgCommentAdminStore.replyAsAuthor` stores that name in
  `comments.name` (`uploader/src/comments-admin.ts:132-145`), and `GET /comments` serves it to
  readers. The `AUTHOR_NAME = 'Simon'` path the epic names
  (`uploader/src/comments.ts:27,200,282`, `CommentStore.replyAsAuthor`) has **no production
  caller**: a search for `.replyAsAuthor(` outside `uploader/test` finds only `server.ts:1922`.
  Publishing the login username hands an attacker half of the credential pair. **O14.**
- **F2.** `settings.html:374` builds the tab title with a curly apostrophe
  (`Simon’s Wanderlust`), while every static admin `<title>` uses a straight one. Once the
  title comes from `siteName`, the straight apostrophe of the stored value wins. This affects
  admin chrome only; no built output changes.
- **F3.** Because of `update()`'s whole-object persist (§2.1), an install that ever saved
  Settings already holds the literal legacy review prompt. Only an install that has never saved
  Settings would see a changed default. §12.3 covers that case.

---

## 3. Branding surface inventory

"Field" names the identity field from §5 that replaces the hardcoded value. "Legacy seed" is
the exact current value, which the existing install keeps. "Fresh" is what an unconfigured
fresh install shows.

### 3.1 Public site (built output)

| Surface | Location (at `11e16d1`) | Field | Legacy seed | Fresh | Child |
|---|---|---|---|---|---|
| `<title>` suffix, RSS `<link title>`, `og:site_name` | `Base.astro:56,63,77` via `t('site.title')` | `siteName` | `Simon's Wanderlust` | `ui.ts` `site.titleFallback` (DE `Reisejournal`, EN `Travel journal`; new keys, both locales) | #274 |
| Nav home link text | `Nav.astro:46` | `siteName` (#275: logo `<img alt={siteName}>` when a logo is set) | same | fallback | #274/#275 |
| Footer title + tagline | `Footer.astro:47-48` | `siteName`, `tagline[locale]` | DE `Reiseabenteuer & Geschichten`, EN `Travel adventures & stories` | `ui.ts` `site.taglineFallback` (DE `Reisegeschichten`, EN `Travel stories`) | #274 |
| Tagline as home `<h1>`/description, region description | `FeaturedHero.astro:84`, `HomePage.astro:54,72`, `RegionPage.astro:33` | `tagline[locale]` | as above | fallback | #274 |
| Footer gear line | `Footer.astro:60` (`about.gear`) | `aboutGear[locale]` | DE `Leica Q2 · analoge Canon AE-1 · Notizbuch`, EN `Leica Q2 · analog Canon AE-1 · notebook` | line omitted when empty | #274 |
| About heading | `AboutPage.astro:45` (`<h2>Simon</h2>`) | `authorName` | `Simon` | `<h2>` omitted when empty | #274 |
| About role / equipment | `AboutPage.astro:47,71` | `aboutRole[locale]`, `aboutGear[locale]` | DE `Reisender & Autor`, EN `Traveler & Storyteller`; gear as above | role omitted; equipment block omitted | #274 |
| Instagram link | `Footer.astro:99-105` | `socialLinks[]` | `[{ label: 'Instagram', url: 'https://www.instagram.com/simonswanderlust' }]` | no links | #274 |
| JSON-LD `author` | `seo.ts:7,78` | `authorName` | `Simon` | `author` property omitted | #274 |
| RSS channel title/description | `pages/rss.xml.js:9-10`, `pages/en/rss.xml.js:9-10` | `siteName`, `tagline[locale]` | as above | fallbacks | #274 |
| `Astro.site`, canonical, `hreflang`, `og:url`, JSON-LD URLs, sitemap, RSS links | `astro.config.mjs:9`, `seo.ts:13`, `Base.astro:26-27,66-68,81`, `StoryPage.astro:46` | `canonicalOrigin` | `https://simonswanderlust.com` (or #319's source, §12.2) | unconfigured placeholder + `noindex` (O5) | #276 |
| `robots.txt` | `site/public/robots.txt:4` | `canonicalOrigin` | byte-identical to today (`User-agent: *\nAllow: /\n\nSitemap: https://simonswanderlust.com/sitemap-index.xml\n`) | `User-agent: *\nDisallow: /\n` | #276 |
| Favicon `<link>` | `Base.astro:58` → `/favicon.svg` | `assets.favicon` | none (keeps `/favicon.svg`) | `/favicon.svg` | #275 |
| Logo | none today | `assets.logo` | none (text name) | none | #275 |

### 3.2 Admin chrome (served HTML and runtime-painted copy)

| Surface | Location | Field | Child |
|---|---|---|---|
| `<title>` suffix `· Simon's Wanderlust` | line 6 of `about, comments, editor, import, index, login, media, posts, settings, users` `.html`; `settings.html:374` | `siteName`, painted by `auth.js`/`login.html` from `window.SiteIdentity`. The static `<title>` becomes the page name alone (e.g. `Posts`) | #274 |
| Studio descriptor | `ui.ts:54,426` (`editor.chrome.studioDescriptor`), painted at `auth.js:192`, `login.html:41` | `studioDescriptor[locale]`; when empty, falls back to `siteName`, then to the site-name fallback | #274 |
| Studio name `Wanderlust Studio`, `cms-brand-mark` | `ui.ts:53,425`, `auth.js:190-191,209`, `admin.css:2,1350` | **not identity**: #291, allow-listed | #291 |
| Editor slug preview `simonswanderlust.com/` / `…/en/` | `editor.html:171,249` | the host of `canonicalOrigin`, painted with `textContent`. When unset, the preview shows the path only (`/`, `/en/`) | #276 |

### 3.3 Runtime and outbound (not visible to the `dist/` scan)

| Surface | Location | Contract | Child |
|---|---|---|---|
| Author-reply display name | live: `server.ts:1922` → `comments-admin.ts:132-145` (login username, F1); no production caller: `comments.ts:27,200,282` | `authorName`, read from the in-memory identity at request time and **stored per row**; existing rows are never rewritten; empty → the literal `Author`. `AUTHOR_NAME` is deleted and `CommentStore.replyAsAuthor` takes the name as an argument like `CommentAdminStore.replyAsAuthor`; `comments.test.ts:93` asserts the passed name (updated, not deleted) | #274 |
| Review prompt default | `editorial-review.ts:47`, `settings.ts:84` | stays a `settings.json` field. The code default's first line becomes neutral: `You are an editorial and SEO reviewer for a personal travel blog.` The upgrade seed persists the legacy prompt if the file lacks the key (§12.3) | #274 |
| Nominatim `User-Agent` | `geocoding.ts:45` | O13 | #276 |
| OpenRouter `HTTP-Referer` / `X-Title` | `uploader/public/llm.js:243-244` | `HTTP-Referer` = `canonicalOrigin`, omitted when unset; `X-Title` = O13 | #276 |
| Shiki transformer name `simonswanderlust:style-to-class` | `site/src/lib/shiki-classes.ts:105` | internal identifier, never in output. Out of scope | — |
| Image/host defaults | `docker-compose.yml:17,19`, `.env.example:21,25`, `main.ts:76`, `cli.ts:404`, `images.ts:60` | O12 | #276 / #293 |
| Image name, package names | `docker-compose.yml:9`, `uploader/package.json:2` | #291 | #291 |

The mechanical scan that #272 requires (`Simon|simonswanderlust|Wanderlust` over a fresh
configured install's `dist/` and the served admin HTML) passes under this contract, except for
the #291 allow-list entries (`Wanderlust Studio` in `EditorCopy`/`admin.css` comments). #274
commits that allow-list.

---

## 4. Decision 1: storage (O1)

### 4.1 Recommended: Postgres singleton, inside dumps

```sql
CREATE TABLE IF NOT EXISTS site_identity (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  seed_source      text NOT NULL CHECK (seed_source IN ('neutral','legacy','restored-legacy')),
  saved_at         timestamptz,                 -- NULL until an admin saves; never set by a seed
  updated_at       timestamptz NOT NULL DEFAULT now(),
  site_name        text NOT NULL DEFAULT '' CHECK (char_length(site_name) <= 80),
  author_name      text NOT NULL DEFAULT '' CHECK (char_length(author_name) <= 80),
  canonical_origin text CHECK (canonical_origin IS NULL OR char_length(canonical_origin) <= 300),
  localized        jsonb NOT NULL DEFAULT '{}', -- { tagline, aboutRole, aboutGear, studioDescriptor }: { de?, en? }
  social_links     jsonb NOT NULL DEFAULT '[]'  -- [{ label, url }], ≤ 6
);
CREATE TABLE IF NOT EXISTS site_identity_assets (
  role       text PRIMARY KEY CHECK (role IN ('logo','favicon-32','favicon-192','apple-touch-180')),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width      integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height     integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
  bytes      bytea NOT NULL CHECK (octet_length(bytes) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Both tables are additive `CREATE TABLE IF NOT EXISTS` in `ensureSchema`. No existing column
changes. The DB `CHECK`s are a backstop; the authoritative rules are the shared validator
(§5.3).

**Why Postgres:**

1. **One restore path.** The documented `restore` CLI brings identity back together with the
   content it describes. With `settings.json`, a database-only restore would rebuild the blog
   with **no canonical origin**: neutral, and `noindex` under O5. That is a silent SEO outage
   that #296's inventory could only warn about, not prevent.
2. **Consistency with #283.** The #283 proposal (worktree `simonswanderlust-issue-283`, peer
   coordination 2026-10-27) puts the language mode in a Postgres singleton `site_language`
   inside the dump, because it decides published URLs. Per-locale identity values are keyed by
   that mode's enabled locales (§5.2). Keeping both in the same restore unit means a restore can
   never pair one dump's language mode with another install's identity.
3. **Seeding is atomic with its evidence.** The fresh-vs-existing check (§12) reads `users` and
   `posts` in the same database, inside one statement.
4. **Assets get dump coverage for free** (O8). `settings.json` cannot hold binary assets, and a
   `/data` directory is in neither the dump nor the images archive.

**Consequences, stated plainly:** this touches the `db.ts` schema, `backup.ts` (dump version,
restore validation) and the build pipeline. **#274 is therefore High risk**, as the #272/#274
bodies anticipated. #274 is High under every option anyway, because identity has to reach the
in-process `astro build` (§6) and that is the build pipeline.

**Convention deviation (needs owner acknowledgement as part of O1):** CLAUDE.md §Security 1
says "App settings live in a JSON settings store". Identity is closer to *content* (like the
`pages` table that holds the About page) than to an operational setting. The draft CLAUDE.md
delta (§22) narrows the rule: settings.json holds operational settings; site identity, like
content, lives in Postgres.

### 4.2 Read and write path

- **Writes:** only `PUT /settings/identity` (admin), the asset routes (#275, admin), the boot
  seed (§12), and the offline `restore` CLI (§13).
- **Server reads:** a process-local cache, loaded after `ensureSchema` and the seed in
  `main.ts` and replaced after each successful write. The app is the only online writer.
  Restore is offline and followed by a restart (`cli.ts:72-74`), so the cache cannot go stale.
  Request paths that read identity (comment Origin check, reply name, copy script, geocoding
  UA) never query Postgres for it. That keeps #129's rule: blog, image and admin static serving
  never depend on the database.
- **Build reads:** the builder reads the row **fresh from Postgres inside `runExclusive`**,
  not from the cache (§6.1). If that read fails, the build fails, the previous release stays
  live, and the error is reported like any other build failure.

### 4.3 Rejected

- **R1. `settings.json` with `FIELD_CHECKS`** (the conservative draft in the 2026-10-27
  RoadmapIdentity handoff). It needs no schema change, but: identity sits outside every
  restore path (§4.1 point 1); a restored dump and a surviving settings file can disagree with
  #283's Postgres mode; it cannot hold assets; and an absent key silently takes the *code*
  default (`settings.ts:195-254`). That last point is exactly the mechanism that would flip an
  existing install to the neutral brand. If the owner nevertheless picks R1, the restore path
  for identity is "the operator restores `settings.json` from the offsite copy" (#296
  inventory), or #296's settings snapshot if that is approved. §12 would then need a
  settings-file seed instead of a SQL one.
- **R2. Text in settings.json, assets under `/data/identity/`.** Two stores, two restore
  paths, and the assets are outside both the dump and `images-*.tar`.
- **R3. Env vars.** Violates "do not grow `.env`" (CLAUDE.md §Security 1), needs a container
  recreate to rename the blog, and cannot hold assets.

---

## 5. Decision 3: field shape, shared vs per-locale (O6)

### 5.1 Fields

| Field | Scope | Required | Length (after normalization) | Empty means |
|---|---|---|---|---|
| `siteName` | shared | no | 0–80 | render the localized `site.titleFallback` |
| `authorName` | shared | no | 0–80 | omit JSON-LD `author` and the About `<h2>`; replies store `Author` |
| `tagline` | per-locale | no | 0–160 | render `site.taglineFallback` |
| `aboutRole` | per-locale | no | 0–80 | omit the role line |
| `aboutGear` | per-locale | no | 0–200 | omit the footer gear line and the About equipment block |
| `studioDescriptor` | per-locale | no | 0–80 | admin shows `siteName`, else the site-name fallback |
| `socialLinks` | shared, ordered | no | 0–6 entries; label 1–40; URL ≤ 2048 | no links rendered |
| `canonicalOrigin` | shared | no | serialized origin, §7.2 | unconfigured mode (O5) |

No field is required for a build to succeed, so a fresh install's first-boot
`bootstrapRelease` keeps working before any admin exists. #279's onboarding asks for a site
name, author name and canonical origin. It reads "configured" from `saved_at IS NOT NULL`,
never from a seed (§12.1).

### 5.2 Per-locale shape and single-language installs

A per-locale value is `{ de?: string; en?: string }`. Its **only** valid keys are the install's
**enabled locales**. Until #283 lands, that set is the fixed `['de','en']`. After #283, it is
read from #283's language config, in the same build snapshot (§6.1).

- A one-locale install stores and renders **exactly one** value per per-locale field. The form
  shows one input. Nothing requires, stores or renders an empty second locale.
- A value for a locale that is not enabled is **kept but never rendered or validated as
  required**. If #283 ever allows a mode change, switching back restores it. This decision does
  not depend on how #283 resolves mode changes.
- A missing value for an enabled locale renders that field's "empty means" behaviour (§5.1).
  It is never a build error.

### 5.3 Validation: one validator for both trees

The shape and rules live in **one pure, `astro:`-free module, `site/src/lib/site-identity.ts`**.
The uploader imports it (precedent: `gallery-layout.ts`, §2.1), so the two trees cannot drift.
That is the trap the `ImageMeta`/`ImageDims` `@ai-warning` in CLAUDE.md describes. It exports:

- `normalizeIdentity(input: unknown): Identity`, which throws `IdentityError { field, code }`;
- `parseIdentitySnapshot(json: string | undefined): IdentitySnapshot`, used by the build
  (§6.2).

Rules, applied in this order to every text field:

1. It must be a string.
2. Unicode NFC.
3. Strip `\p{C}`. This removes control, format (including bidi overrides and zero-width
   characters), surrogate, private-use and unassigned code points, and also strips newlines.
   It is the same rule as comment names (`2026-09-14-comments-design.md`, rule 9) and
   `cleanText` (#133).
4. Trim.
5. Check the length (§5.1).

The result is stored and rendered as **plain text only**.

---

## 6. Decision 2: build propagation

### 6.1 Snapshot

Inside `runOnce` → `lock.runExclusive`, before `buildAndDeploy` starts the child, the builder:

1. reads `site_identity` and `site_identity_assets` in one `REPEATABLE READ` transaction
   (together with #283's `site_language` once it exists);
2. serializes the **build snapshot**:
   ```ts
   interface IdentitySnapshot {
     v: 1;
     locales: ('de' | 'en')[];               // enabled locales (fixed ['de','en'] until #283)
     canonicalOrigin: string | null;
     siteName: string; authorName: string;
     tagline: Partial<Record<'de'|'en', string>>;
     aboutRole: Partial<Record<'de'|'en', string>>;
     aboutGear: Partial<Record<'de'|'en', string>>;
     socialLinks: { label: string; url: string }[];
     assets: {
       logo: { path: string; width: number; height: number } | null;   // '/_identity/logo-<sha256[0:16]>.png'
       favicon: { png32: string; png192: string; appleTouch180: string } | null;
     };
   }
   ```
   (`studioDescriptor` is admin-only and is not passed);
3. passes it to the child as **one environment variable, `SITE_IDENTITY_JSON`**, which
   `runChildBuild` sets **unconditionally**, overriding anything inherited;
4. after `astro build` succeeds and **before** the staging copy, writes each asset's bytes to
   `<buildTmp>/_identity/<role>-<sha256[0:16]>.png`. The release therefore contains its own
   assets and is served by the existing release mount.

`SITE_IDENTITY_JSON` is **not an operator knob**:

- `main.ts` never reads it;
- `.env.example`, compose and the README never mention it;
- `ARCHITECTURE.md` lists it as internal and builder-set (§22);
- an operator value is overwritten at every spawn.

The snapshot is bounded: the field caps plus six links stay far below Linux's 128 KiB
per-string `MAX_ARG_STRLEN`. Assets are passed as paths, never as bytes.

### 6.2 Site side

- `astro.config.mjs` calls `parseIdentitySnapshot(process.env.SITE_IDENTITY_JSON)` once and
  sets `site: snapshot.canonicalOrigin ?? 'https://unconfigured.invalid'`.
- Components read a module-level `identity` export from the same module. That replaces
  `t('site.title')`, `t('site.tagline')`, `t('about.role')`, `t('about.gear')`, `AUTHOR_NAME`
  and `PROD_SITE`. **`PROD_SITE` and `PROD_IMAGE_ORIGIN`'s Simon value are deleted.** The
  legacy strings exist only in the uploader's seed module (§12.2).
- The name is deliberately **not** `PUBLIC_`-prefixed, so Vite never inlines it into client
  bundles.
- **Absent** (`astro dev`, CI `astro check`/`astro build`) → the neutral development snapshot
  (`canonicalOrigin: null`, empty fields). **Present but malformed or invalid** → throw. The
  build fails, and the previous release stays live (fail closed). The site never treats a
  malformed snapshot as "absent".
- `ui.ts` loses `site.title`, `site.tagline`, `about.role`, `about.gear` and
  `editor.chrome.studioDescriptor`, and gains the fallbacks (`site.titleFallback`,
  `site.taglineFallback`) in both locales. `IDENTICAL_ON_PURPOSE` (`ui.test.ts:38`) drops
  `site.title`. `ui.test.ts:348`'s `Simon` assertion moves to a rendered-output test of the
  About heading.

### 6.3 Rejected

- **A Content Layer collection read from Postgres.** It covers text fields, but `site` in
  `astro.config.mjs` is needed before loaders run. That would mean two read paths and two
  moments in time for one snapshot.
- **The child reads `settings.json` or `/data` directly.** That couples the site to uploader
  storage paths, and a mid-build save would make a release inconsistent.
- **A JSON file written into `siteAppDir`.** It is equivalent to the env var, but it needs
  cleanup and is visible to concurrent sweeps. The env var dies with the child.

---

## 7. Decision 4: origin roles (O4)

### 7.1 The roles

| Role | Source | Used for | Never used for |
|---|---|---|---|
| **Canonical blog origin** | `site_identity.canonical_origin` | `Astro.site`, canonical, `hreflang`, `og:url`, JSON-LD URLs, sitemap, RSS links, `robots.txt`, the comment Origin check (O4), editor slug preview, outbound identification | routing, slugs, image URLs, host routing |
| **Image origin** | `PUBLIC_BASE_URL` (bootstrap env, unchanged) | variant URLs, gallery/body allow-list (`body-images.ts:159-165`, `SECURITY.md:700-705`), publish gate (#91), preview CSP `img-src`, media store | comment Origin, SEO URLs |
| **Image host** | `IMG_HOST` (unchanged) | Fastify host routing of variants; the loopback-only blog arm (`server.ts:2155-2162`) | anything else |
| **Serving/admin origin** | the request's scheme + forwarded `Host` | where blog and admin are actually reached; GPX mutation Origin (`SECURITY.md:33-36`) | SEO output |

### 7.2 Canonical origin validation

The input is parsed with WHATWG `new URL(input)`. It is **refused** unless all of these hold:

- the protocol is `https:`, or `http:` only when the host is loopback (`localhost`,
  `127.0.0.0/8`, `[::1]`, using `isLoopbackAuthority`);
- there is no username or password;
- the pathname is exactly `/` (an installer typing `https://example.com/` is accepted; `/blog`
  is refused, because sub-path deployment is unsupported and every route is root-relative);
- there is no query or fragment;
- the host is not an IP literal, except loopback;
- the serialized origin differs from `new URL(PUBLIC_BASE_URL).origin`, unless both are
  loopback. In production the image host never serves the blog (§2.1).

The value stored is **`url.origin`**. WHATWG lowercases the host, removes the default port, and
converts IDNs to Punycode. Settings displays the stored ASCII form, and shows an explicit
"internationalized domain, check the spelling" notice when any label starts with `xn--`. This
is the homograph mitigation: the admin always sees the bytes that will be compared.

### 7.3 Comment Origin check and #319

- **After #276:** `allowedOrigin = identity.canonicalOrigin` when it is set. Otherwise
  **#319's source** applies (whatever #319 ships: an existing bootstrap value or a
  request-derived rule). With neither, the route refuses (403). Comments default to off
  (`settings.ts:93`), so an unconfigured fresh install loses nothing.
- **The image origin is never accepted.** The current
  `?? new URL(cfg.baseUrl).origin` fallback (`server.ts:1859`) is the #319 defect. Whichever of
  #319 or #276 lands second must not reintroduce it.
- The comparison stays **equality on the serialized origin**: `Origin`, else the origin of
  `Referer`, exactly as `SECURITY.md:194-196` describes, minus the image-origin source. Prefix,
  suffix and userinfo tricks therefore fail by construction.
- `ServerConfig.commentsOrigin` remains as an explicit override (the test seam, and #319's
  wiring if it uses one), with precedence explicit > identity > #319 fallback.
- **Upgrade seed:** if #319's source yields a valid blog origin at the first boot of the
  identity version, `canonical_origin` is seeded from it (§12.2). #319's split-domain test
  therefore passes **unchanged** on a fresh test database (neutral seed, so #319's source
  applies) and on a reused one (seeded from #319's source).
- **#319 stays independently fixable.** Nothing in #319 waits on this spec, and this contract
  only requires that #319's source is a single exact origin or an equality rule.
- **Domain switch order** (operator runbook, #276/#293): move DNS/proxy first, then save the new
  canonical origin, then rebuild. Between the save and the rebuild, comments from the old domain
  are refused (fail closed). This is documented, not engineered around.

### 7.4 Rejected

- **Request-authority same-origin for comments (O4 alternative).** It is equally strong
  against cross-site browser POSTs and keeps comments working during a domain move or on a
  restore-rehearsal host. Rejected as the default because it makes the comment surface accept
  any hostname the proxy forwards, and the identity design exists to say which origin means
  what. The owner may prefer it. Whichever O4 is chosen, the misuse tests in §15 are the same.
- **A set of allowed origins** (old + new, staging). Every entry widens the only
  unauthenticated write surface, and nothing in the product needs more than one.

---

## 8. Decision 5: domain change effects, redirects, defaults

### 8.1 What a canonical-origin change changes (after the next build)

It changes the canonical link, `hreflang` (`x-default` included), `og:url`, JSON-LD
`url`/`mainEntityOfPage`, every sitemap `<loc>`, RSS channel and item links, the `robots.txt`
`Sitemap:` line, and the editor slug preview. The comment Origin check changes
**immediately**.

**It never changes:**

- the built route list (the set of files under `dist/` is identical for two different
  configured origins, which is #276's test);
- slugs (`paths.test.ts`/`trips.test.ts` unchanged);
- image URLs;
- legacy redirect targets;
- host routing.

### 8.2 Unconfigured mode (O5)

`canonicalOrigin === null` →

- `site` = `https://unconfigured.invalid` (`.invalid` is reserved by RFC 6761 and never
  resolves);
- `Base.astro` adds `<meta name="robots" content="noindex">`;
- the `robots.txt` endpoint emits `User-agent: *\nDisallow: /\n`;
- the sitemap is still generated, so the route list does not depend on configuration;
- Settings and the Desk show "Public domain not set: search engines are asked not to index
  this site", with a link to the identity tab.

`robots.txt` becomes a prerendered endpoint, `site/src/pages/robots.txt.ts`. It is the same URL,
and `site/public/robots.txt` is deleted. For a configured origin, its output is byte-identical
to today's file with the origin substituted.

### 8.3 Legacy WordPress redirects (O11)

`uploader/src/redirects.ts` stays **unconditional**:

- its targets are root-relative paths (`/rss.xml`, region pages), so they are
  domain-independent;
- they map URL shapes that a non-WordPress install never receives;
- a 301 to an existing route is harmless.

Gating them would add state that nothing reads.

### 8.4 Defaults (O12)

| Location | Today | After |
|---|---|---|
| `docker-compose.yml:17,19` | `:-https://img.simonswanderlust.com` / `:-img.simonswanderlust.com` | `:?` required. Owned by #293 (owner decision 2026-10-19). Not a new knob |
| `uploader/.env.example:21,25` | owner's hosts as values | #293 rewrites them as `img.example.com` examples |
| `uploader/src/main.ts:76`, `uploader/src/cli.ts:404` | `'https://img.simonswanderlust.com'` | `'http://localhost:3000'` (#276). Production always sets the env (compose `:?` after #293) |
| `site/src/lib/images.ts:60` (`PROD_IMAGE_ORIGIN`) | Simon's image host | renamed `DEV_IMAGE_ORIGIN = 'http://localhost:3000'` (#276). Only dev and CI builds without `PUBLIC_BASE_URL` reach it |

No new `.env` variable is introduced anywhere in this contract.

### 8.5 Outbound identification (O13)

- **Nominatim** (server-side, `geocoding.ts:45`):
  `User-Agent: <token>/<package version> (+<canonicalOrigin>; editor location lookup)`.
  `+<canonicalOrigin>; ` is omitted when unset. `<token>` is #291's product token
  (`SimonsWanderlust` until #291 decides, allow-listed under #291). Nominatim's usage policy
  asks for an identifying UA, and the canonical origin is the deployment's contact point.
- **OpenRouter** (browser-direct, `llm.js:243-244`):
  - `HTTP-Referer` = the canonical origin, omitted when unset;
  - `X-Title` = the site name only if it matches `^[\x20-\x7E\xA0-\xFF]{1,80}$`, otherwise
    omitted. A `fetch` header must be a ByteString: a name with an emoji or a non-Latin-1
    letter would make `fetch` throw `TypeError`, and Story review would fail for a cosmetic
    reason.
  - The values come from `window.SiteIdentity` (§11.2). The server never proxies.

---

## 9. Decision 6: logo and favicon (O7, O8)

### 9.1 Accepted input

- PNG, JPEG or **static** WebP, detected by `sharp(...).metadata().format`, never by file
  name or declared MIME;
- ≤ **2 MiB** per file;
- one file per request (multipart `files: 1`, mirroring `/upload`'s 413);
- `limitInputPixels: 4096 × 4096`;
- `pages > 1` (animated) refused;
- **SVG refused** (O7), and GIF, AVIF, HEIC and TIFF refused;
- minimum source size: favicon 180 × 180, logo 32 px tall.

### 9.2 Normalization (sharp, inside `workLock.runShared()` like #95)

- `rotate()` (apply then drop orientation), convert to sRGB, `png({ compressionLevel: 9 })`,
  **no `withMetadata`/`keepMetadata`**, so EXIF, GPS, XMP, IPTC and ICC are all dropped by
  construction;
- **logo:** fit inside 960 × 240 without enlargement → role `logo`. Rendered at CSS height
  2 rem with intrinsic `width`/`height` attributes (no layout shift);
- **favicon:** `contain` onto a transparent square, then three outputs:
  - `favicon-32` (32 × 32),
  - `favicon-192` (192 × 192),
  - `apple-touch-180` (180 × 180, **flattened** onto `--color-canvas` `#fbfbfd`, because iOS
    renders transparency as black);
- each output's SHA-256 is computed on the encoded bytes. An output over 256 KiB is refused
  with 400 `asset_too_large`. That is unreachable at these sizes, and it is the backstop for
  the column `CHECK`.

### 9.3 Codes

| Code | Status |
|---|---|
| non-admin | 403 |
| more than one file | 413 `too_many_files` |
| file over 2 MiB | 413 `asset_too_large` |
| not PNG/JPEG/WebP, including SVG | 415 `unsupported_image_type` |
| animated | 400 `animated_image` |
| pixel limit exceeded or undecodable | 400 `image_too_large` / `image_invalid` |
| below the minimum size | 400 `image_too_small` |
| `/data` free-space precondition fails (same helper as `/upload`) | 507 |

### 9.4 Storage and serving (O8)

- One upload writes its roles in one transaction: the logo writes one row, the favicon writes
  three. `DELETE` removes the role group in one transaction, and the defaults return. Each
  successful write bumps `site_identity.revision` and `updated_at`.
- The build writes the bytes into the release (§6.1 step 4). They are served from the **blog
  origin** under `/_identity/<role>-<hash16>.png` by the existing release mount, with
  `Content-Type: image/png` and the global `nosniff` (`server.ts:245`).
- Content-hashed names mean a changed asset is a new URL, so caches are never stale. Rollback
  to an older release keeps that release's assets.
- `Base.astro` emits:
  - `<link rel="icon" type="image/png" sizes="32x32">`,
  - `<link rel="icon" sizes="192x192">`,
  - `<link rel="apple-touch-icon">`

  when a favicon is set, and today's `/favicon.svg` link otherwise.
- `Nav.astro` renders `<img alt={siteName || fallback}>` inside the existing home link when a
  logo is set, and the text name otherwise. The visible text and the accessible name stay one
  link target (WCAG 2.4.4/2.5.3), and it is checked at 320 px and with keyboard focus (#275
  acceptance).
- There is no server-side fetch of a remote logo URL, ever.

### 9.5 Rejected

- **Sanitized SVG.** It needs a sanitizer dependency whose parse must match every browser's.
  The blog origin has no CSP, and an SVG opened directly is a document that can run script.
  Expedition Log needs no vector logo for this to be useful.
- **Media library key on the image host.** The asset would sit in the library's lifecycle
  (bulk delete, rescan, encode queue variants 640/1280/1920) where an author could break the
  site chrome. It would be cross-origin to the blog, and EXIF semantics differ (variants keep an
  allow-list, `SECURITY.md:349-353`).
- **Original bytes kept.** That would bring a polyglot/metadata surface into dumps for no
  output benefit.

---

## 10. Decision 7: social links (O9)

- An ordered array of **at most 6** `{ label, url }` entries, shared across locales (platform
  names are proper nouns).
- **URL:** WHATWG-parsed. The protocol must be `https:`. No username or password. The host must
  not be an IP literal or loopback. No `\p{C}` or whitespace. At most 2048 characters. It is
  stored as `url.href`, so IDNs are stored as Punycode and the admin sees what will be linked.
- `javascript:`, `data:`, `vbscript:`, `http:`, `mailto:` and protocol-relative `//host` are
  refused with 400 `{ code: 'invalid_identity', field: 'socialLinks[i].url' }`.
- **Label:** the text rules of §5.3, 1–40 characters.
- **Rendering:** footer "About" column, after the About link, in stored order:
  `<a href={url} target="_blank" rel="noopener noreferrer">{label} ↗</a>`. These are Astro
  attribute and text interpolation, both escaped, never `set:html`. This is byte-identical to
  today's Instagram link for the legacy seed. #287/#289's footer "social slot" consumes this
  list and never stores social URLs itself.
- **Rejected:**
  - `rel="me"` by default (it changes existing markup; owner option in O9);
  - `nofollow` (they are the owner's own profiles);
  - icons (no icon set, and adding one is theming);
  - a platform allow-list (ever-growing and paternalistic; the admin is trusted for
    destinations);
  - `mailto:` (address harvesting, and the comments design deliberately collects no email).

---

## 11. Decision 8: save semantics and HTTP contract (O10)

### 11.1 Routes (all JSON responses `Cache-Control: no-store`)

- `GET /settings/identity`, `requireAdmin` →
  `{ revision, savedAt, seedSource, identity, locales }`.
- `PUT /settings/identity`, `requireAdmin`, body `{ revision, identity }`:
  - validated by `normalizeIdentity` (§5.3) plus the origin rules (§7.2);
  - 400 `{ code: 'invalid_identity', field }` with a fixed message per code. A supplied value
    is never echoed;
  - 409 `{ code: 'identity_conflict' }` when `revision` is stale. This is optimistic
    concurrency, the same family as `2026-09-06-page-concurrency-revisions-design.md`;
  - 200 `{ revision, savedAt, takesEffect: 'next_build' }` on success. It sets `saved_at`,
    bumps `revision`, refreshes the cache, and **never builds or takes the work lock**.
- `PUT`/`DELETE /settings/identity/assets/:role` (#275), `requireAdmin`; `role ∈ {logo, favicon}`.
- Authors (non-admin) get 403 on all of the above.

### 11.2 Public subset

`GET /admin/editor-image-copy.js` (unauthenticated, because the login page needs it) adds
`window.SiteIdentity = { siteName, studioDescriptor, canonicalOrigin }`. These values are
already public on the blog. The author name, social links and assets are not included. The
payload is built with `JSON.stringify` into a JavaScript response, and every consumer paints it
with `textContent`.

### 11.3 Effect timing (stated in the UI)

| Change | Takes effect |
|---|---|
| any built-output field (§3.1) | at the next Publish, bulk publish, or **Rebuild site now** (`POST /rebuild`, admin) |
| `canonicalOrigin` → comment Origin check | immediately. A confirm dialog names this scope, per the CLAUDE.md high-impact action rule |
| `authorName` → new author replies | immediately. Existing replies keep their stored name |
| admin chrome (`siteName`, `studioDescriptor`) | at the next admin page load |

**Rejected:** auto-rebuild on save. A build holds the exclusive lock (up to 15 minutes,
`build.ts`), preempts the encode queue, and editing several fields would chain builds. The
comments switch already established persist-only (`settings.ts:46-50`).

### 11.4 Settings UI

A new vertical tab, **Site identity**, in the existing Editorial desk shell (Settings tabs:
AI models · Images · Comments · **Site identity** · Site & backups). It holds the §5.1 fields,
one input per enabled locale for per-locale fields, an ordered social-link editor, and the
asset uploaders (#275). There is a "Use this browser's address" convenience that **pre-fills**
the canonical origin from `location.origin`; saving remains explicit. The unconfigured banner
from §8.2 also appears here. All copy goes in `ui.ts` (both locales; Golden Rule 7). Status
uses text, not colour alone.

---

## 12. Decision 9: fresh vs existing install (O2)

### 12.1 Mechanism

`seedSiteIdentity(pool, { legacy, bootstrapBlogOrigin })` runs in `main.ts` right after
`ensureSchema` and **before** `listen()` and `bootstrapRelease`:

```sql
-- $1 legacy site name, $2 legacy author, $3 legacy localized jsonb, $4 legacy social_links jsonb,
-- $5 legacy canonical origin, $6 #319 bootstrap blog origin (NULL when #319 supplies none).
INSERT INTO site_identity (id, seed_source, site_name, author_name, canonical_origin, localized, social_links)
SELECT true,
       CASE WHEN e.existing THEN 'legacy' ELSE 'neutral' END,
       CASE WHEN e.existing THEN $1 ELSE '' END,
       CASE WHEN e.existing THEN $2 ELSE '' END,
       COALESCE($6, CASE WHEN e.existing THEN $5 END),
       CASE WHEN e.existing THEN $3::jsonb ELSE '{}'::jsonb END,
       CASE WHEN e.existing THEN $4::jsonb ELSE '[]'::jsonb END
FROM (SELECT EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM posts) AS existing) e
ON CONFLICT (id) DO NOTHING;
```

- **Exactly once per database.** The first boot of the identity version always writes the row,
  neutral or legacy. Later boots, however much content exists by then, hit `ON CONFLICT` and do
  nothing. A fresh install that later gains users and posts can never be "upgraded" into the
  legacy brand.
- **Evidence = at least one user or post.** A pre-identity install with a user or a post has
  been serving the legacy brand, because that brand was compiled in. Seeding it keeps its
  output unchanged. A brand-new database has neither at its first boot (setup happens after
  `listen()`).
- `saved_at` stays `NULL` and `revision = 1`. So #278/#279's `identityConfigured()` is false
  after any seed (§5.1), and onboarding still asks a fresh installer.
- `$6` (`bootstrapBlogOrigin`) is #319's source value when that source is a configured value. It is
  validated by §7.2, and an invalid value is ignored with a log line naming the field, not the
  value.

### 12.2 Legacy seed values (exact, current at `11e16d1`)

These live **only** in `uploader/src/site-identity-legacy.ts`, with an `@ai-warning` that they
are the owner's install seed, never a default:

- `siteName` `Simon's Wanderlust` (straight apostrophe, `ui.ts:172,544`)
- `authorName` `Simon` (`seo.ts:7`, `AboutPage.astro:45`)
- `tagline` DE `Reiseabenteuer & Geschichten`, EN `Travel adventures & stories` (`ui.ts:173,545`)
- `aboutRole` DE `Reisender & Autor`, EN `Traveler & Storyteller` (`ui.ts:250,610`)
- `aboutGear` DE `Leica Q2 · analoge Canon AE-1 · Notizbuch`, EN `Leica Q2 · analog Canon AE-1 · notebook` (`ui.ts:252,612`)
- `studioDescriptor` DE `Simons Reisetagebuch`, EN `Simon’s travel journal` (`ui.ts:54,426`)
- `socialLinks` `[{ label: 'Instagram', url: 'https://www.instagram.com/simonswanderlust' }]` (`Footer.astro:100-104`)
- `canonicalOrigin` `https://simonswanderlust.com` (`astro.config.mjs:9`), unless #319's source supplied one
- no logo, no favicon (keeps `/favicon.svg`)

### 12.3 Review prompt (settings.json)

The neutral code default replaces "Simon's Wanderlust" in `DEFAULT_REVIEW_PROMPT`'s first line.
In the same boot step, if the seed chose `legacy`, **and** `settings.json` loaded cleanly,
**and** the file has no `reviewPrompt` key, the store persists the legacy prompt (one atomic
write, the `completeAiMigration` pattern, `settings.ts:287-306`).

A missing, unreadable or invalid-JSON file is **never** overwritten by this step. In that case
the neutral default applies, and the boot log says so by field name. Per F3, any install that
ever saved Settings already holds the literal prompt, so in practice this branch protects only
never-saved installs.

### 12.4 Rejected (O2 alternatives)

- **(b) Always neutral.** An upgrade boot does not rebuild, but the next Publish, bulk publish,
  or another admin's action would publish a neutral, `noindex` blog on the live domain before
  the owner had entered anything.
- **(c) Always legacy.** Every fresh third-party install inherits "Simon's Wanderlust", a
  canonical pointing at `simonswanderlust.com`, and an Instagram link. That fails #272's done
  criterion and harms the installer's SEO.
- **(d) An operator CLI step before the upgrade.** A forgotten step degrades to (b).

---

## 13. Backups and restore (#296 interaction)

### 13.1 Dump

`site_identity` (one row; `bytes` base64 in `site_identity_assets`) is added to `tables`. This
takes **the next free `DUMP_VERSION`**: 11 if this lands before #283's `site_language`,
otherwise 12. `SUPPORTED_DUMP_VERSIONS` widens in the same change (`backup.ts:701` warning).
Older application versions reject the new dump, which is the existing precedent for v9/v10.
Identity rows are part of the `REPEATABLE READ` dump snapshot.

### 13.2 Restore

- **New dump:** validate every identity field with `normalizeIdentity` and §7.2. Validate
  every asset by its `CHECK`s, re-hash it, and confirm it decodes as a PNG within its role's
  dimensions. **Any violation refuses the whole restore** with a `BackupError` naming the
  field. A crafted dump is the realistic attacker here; refusing is safer than repairing
  (unlike comments, where row-level demotion keeps reader data). Then replace both tables in
  the content-restore transaction.
- **Dump v≤10 (O3):** replace the identity with the §12.2 legacy values, `seed_source =
  'restored-legacy'`, `saved_at = NULL`, no assets, and keep the live `canonical_origin` if one
  is set. The CLI's summary prints "identity: restored legacy brand (dump predates identity).
  Review Settings → Site identity".
- **Pre-restore undo dump:** written by the same `dumpDatabase`, so it includes the live
  identity and assets.
- **After restore:** the operator restarts the app (already required). The cache loads, and
  the old release keeps serving until a rebuild. That is unchanged behaviour.

### 13.3 #296

With O1, identity and assets **do not depend on** #296's open decision about snapshotting
`settings.json`. #296's recovery inventory lists them under "in-app DB dumps". `settings.json`
still holds the review prompt, providers, backup schedule, comments switch and image quality,
so #296's question stays exactly as open as before. If the owner picks R1 instead, identity
joins #296's operator-managed `settings.json` row, and #295's rehearsal must restore that file.

---

## 14. Trust boundaries

1. **Admin → identity write.** `requireAdmin` on every write route. Identity is not
   author-writable. The admin is trusted for *destinations* (social URLs, domain), but not for
   markup. Every value is plain text, escaped at every sink.
2. **Database → build child.** The snapshot crosses a process boundary as env. It is
   re-validated in the site by the same validator (defence in depth against a hand-edited row
   or a restored dump). Malformed input fails the build closed.
3. **Identity → public HTML/XML/JSON.**
   - Astro interpolation (escaped);
   - JSON-LD through `serializeJsonLd` (`<` → `\u003c`, `seo.ts:91-93`);
   - RSS through `@astrojs/rss`;
   - `robots.txt` from a validated `url.origin`, which cannot contain CR or LF;
   - no `set:html` anywhere on these paths.
4. **Identity → admin DOM.** `window.SiteIdentity` is painted only with `textContent`
   (#131 lesson).
5. **Browser → `POST /comments`.** `Origin` equality with the canonical origin (§7.3).
   Unchanged honeypot, limiter and validation order.
6. **Uploaded bytes → sharp → blog origin.** Decode limits, re-encode, metadata dropped, PNG
   only, `nosniff`. No SVG.
7. **Identity → third parties.** The Nominatim UA (server) and OpenRouter headers (browser)
   carry only public values: site name and canonical origin.
8. **Dump file → restore.** It is untrusted input, so the whole restore is refused on any
   invalid identity value.

---

## 15. Misuse cases

| # | Misuse | Mitigation | Test owner |
|---|---|---|---|
| 1 | Social URL `javascript:alert(1)`, `data:text/html,…`, `vbscript:`, ` JaVaScRiPt:` with whitespace or control characters | `\p{C}`/whitespace refusal, then the `https:` protocol check → 400 | #274 |
| 2 | `https://user:pass@evil.test` social or canonical URL | credentials refused | #274/#276 |
| 3 | Canonical `https://example.com.evil.test` set by a confused admin | equality only. Comment POSTs from `https://example.com` are then refused (visible, fail closed) | #276 |
| 4 | `Origin: https://<canonical-host>.evil.test` or `Referer: https://<canonical-host>@evil.test/` | serialized-origin equality → 403 | #319 (baseline) + #276 (changed canonical) |
| 5 | Comment POST from the image origin | the image origin is never an allowed source after #319/#276 → 403 | #319/#276 |
| 6 | Homograph domain (`xn--` label resembling a real one) | stored and displayed as Punycode, with an `xn--` notice | #276 |
| 7 | Canonical with a path, query, fragment, IP literal, `http:` on a public host, or equal to the image origin | 400 with a field-specific code | #276 |
| 8 | Site name `</script><script>…`, or `"><img onerror>` | escaped interpolation; JSON-LD `\u003c`; the admin uses `textContent` | #274 |
| 9 | RTL override or zero-width characters in names | stripped by `\p{C}` | #274 |
| 10 | 81-character name, 7 links, 2049-character URL | 400 per field | #274 |
| 11 | `X-Title` with an emoji crashes `fetch` | Latin-1 check, otherwise omitted | #276 |
| 12 | SVG logo with `<script>`, an SVG renamed `.png`, a PNG/HTML polyglot | content-sniffed format; SVG → 415; output always re-encoded PNG + `nosniff` | #275 |
| 13 | Decompression bomb (tiny file, huge dimensions) or animated WebP | `limitInputPixels` → 400; `pages > 1` → 400 | #275 |
| 14 | Logo carrying GPS EXIF | no metadata written; asserted with the `audit-exif` reader (`exif.ts:35`) | #275 |
| 15 | Multi-file asset upload | `files: 1` → 413 | #275 |
| 16 | Non-admin author calls any identity route | 403 | #274/#275 |
| 17 | Two admins save at once | `revision` → 409 for the loser | #274 |
| 18 | Crafted dump with `javascript:` social URL, oversized asset, or a non-PNG asset | restore refused, nothing changed | #274/#275 |
| 19 | Operator sets `SITE_IDENTITY_JSON` in compose to override the brand | overwritten at every spawn; `main.ts` never reads it | #274 |
| 20 | A bug drops the env in production | the site falls back to the neutral development snapshot: visible as `unconfigured.invalid` + `noindex`, not silent. #274's builder test asserts that the env is always set | #274 |
| 21 | A fresh install that later gains content is "upgraded" to the legacy brand | the seed runs once (`ON CONFLICT DO NOTHING`) | #274 |
| 22 | Admin username leaked through author replies (F1) | the reply name comes from `authorName`; the route test asserts the username never appears | #274 / O14 |

---

## 16. Invariants

1. Changing any identity value never changes the built route list, a slug, an image URL or a
   legacy redirect target.
2. Every origin comparison is equality on WHATWG-serialized origins. Never a prefix match.
3. The image origin is never accepted as a comment Origin.
4. Identity values reach markup only through escaping sinks. No `set:html`.
5. The existing install's built output is byte-identical before and after the identity
   upgrade (same release content for an unchanged database), with only these exceptions:
   - new `/_identity/` paths, which do not exist without assets;
   - the `robots.txt` source moving from a static file to an endpoint, with identical bytes.
6. A fresh install never renders a legacy string from §12.2 unless `restore` of a v≤10 dump put
   it there.
7. Seeding never sets `saved_at`.
8. A release is consistent: identity, assets and content come from one build snapshot taken
   under the exclusive lock.
9. No request path queries Postgres for identity, and blog, image and admin static serving
   stays DB-independent (#129).
10. No new operator `.env` variable.

---

## 17. Compatibility and migration

- **Schema:** two additive tables, created idempotently. Older code ignores them.
- **Upgrade boot:** `ensureSchema` → seed (§12) → optional review-prompt persist → `listen()`.
  No rebuild happens (`bootstrapRelease` skips when a release exists), so the live site is
  untouched until the next build. That build reproduces today's output (invariant 5), which is
  #274's rendered-output test.
- **Dumps:** a version bump with an allow-list widening. v1–v10 restore under O3.
- **Downgrade:** older images keep running against the new schema (additive). They render the
  compiled-in legacy brand, and they reject new dumps (existing precedent).
- **Ordering among children:**
  1. #274 lands the tables, seed, snapshot and text fields;
  2. #275 adds assets on top of the snapshot's `assets` member (`null` until then);
  3. #276 adds `canonicalOrigin` validation, the comment-origin switch, `robots.txt`, defaults
     and outbound identification. #276 needs #319 first.

  The snapshot `v: 1` already contains every member, so #275 and #276 only start filling
  them.

---

## 18. Rollback and containment

- **Bad identity value:** correct it in Settings and rebuild. Earlier releases (3 kept,
  `build.ts:222`) hold the previous output.
- **Bad canonical origin:** comments from the real domain are refused immediately (fail
  closed, no data exposure). SEO output changes only after a rebuild. Recovery: correct it and
  rebuild.
- **Bad asset:** `DELETE /settings/identity/assets/:role` restores the default, then rebuild.
- **Code rollback:** redeploy the previous image tag. The tables are left in place, and the
  compiled-in brand returns. Dumps written meanwhile need the new image to restore. That is the
  same constraint as every dump bump, documented in the release notes per #298.
- **Seed went the wrong way** (an install seeded neutral that should have been legacy, or the
  reverse): the admin enters the values once in Settings. No data is lost, because the seed
  never overwrites a row.
- **Containment:**
  - every identity write is admin-only;
  - every sink escapes;
  - the build fails closed on an invalid snapshot, leaving the previous release live;
  - the asset path never stores original bytes;
  - the comment route's other checks (honeypot, limiter, validation, per-post flag) are
    unchanged.

---

## 19. Acceptance verification (per child; nothing here has been run)

**#274 (High under O1):**

- uploader Vitest + `tsc --noEmit`; site Vitest + `astro check` + full `astro build` against
  Postgres with `TEST_DATABASE_URL`;
- seed tests (fresh → neutral; users-or-posts → legacy; second boot no-op; `saved_at` NULL);
- shared-validator tests for every row of §15 that #274 owns;
- `GET`/`PUT /settings/identity` route tests (400/403/409/200, `no-store`, no echo);
- the builder always sets `SITE_IDENTITY_JSON` and overrides an inherited value;
- a rendered-output comparison proving invariant 5 for title, `og:site_name`, RSS, JSON-LD
  author, About heading, footer role/gear and the Instagram link;
- a fresh-install `dist/` + served-admin-HTML scan with the committed #291 allow-list;
- a `GET /comments` route test showing an author reply carries `authorName`, never the admin
  username, with existing rows unchanged (`comments.test.ts:93` updated, not deleted);
- dump/restore round trip, including v10 → `restored-legacy`;
- a single-locale-config unit test of §5.2;
- a browser smoke of the Settings tab and a built story page.

**#275:**

- §9.3 codes, each with a test;
- EXIF/GPS absence via `readExif`;
- an SVG refusal test, plus SVG-renamed and polyglot cases;
- content type and `nosniff`;
- Nav at 320 px with and without a logo, with keyboard focus on the home link;
- default favicon when unset or removed;
- asset round trip through dump/restore;
- a browser smoke.

**#276:**

- the route list is identical for two configured origins and for unconfigured;
- `paths.test.ts`/`trips.test.ts` unchanged and green;
- #319's split-domain integration test unchanged and green, plus a changed-canonical case;
- §7.2 validation cases (prefix, userinfo, IDN, path, IP, image-origin equality);
- unconfigured `noindex`/`robots.txt`;
- `robots.txt` bytes for the legacy seed;
- the UA and `X-Title` rules;
- a real browser comment POST through a reverse proxy on two hostnames.

**This spec (#273):** docs-only. Checked by review against this baseline; no tests apply.

---

## 20. Dependency contracts

| Issue | Contract |
|---|---|
| **#319** | Ships independently. It must make the comment Origin a single exact blog origin (or an equality rule) and drop the image-origin fallback. Its split-domain test is #276's baseline. If its source is a configured value, §12.1 seeds `canonical_origin` from it, and after #276 that source is a seed and fallback only (documented by #276 in `ARCHITECTURE.md`) |
| **#274** | Owns the tables, seed, snapshot, validator module, text fields, social links, admin chrome, the reply-name fix (F1), the review-prompt default, and the scan allow-list |
| **#275** | Owns the asset routes, normalization, `site_identity_assets` writes, and the `Base`/`Nav` rendering. Starts after #274 |
| **#276** | Owns canonical validation, the comment-origin switch, the `robots.txt` endpoint, unconfigured mode, the code defaults, and outbound identification. Starts after #273 approval and #319 |
| **#283** (advisory) | Its `site_language` config supplies `locales` in the same build snapshot (`SITE_LANGUAGE_JSON` beside `SITE_IDENTITY_JSON`, both read in one transaction). The dump version is whichever is free (§13.1). Identity never decides routes |
| **#287 / #289** | The footer social slot renders `socialLinks`. Nav config never stores social URLs. Whoever lands second rebases `Footer.astro`/`Nav.astro` |
| **#278 / #279** | `identityConfigured()` = `saved_at IS NOT NULL`, an admin-only server read. Seeds never satisfy it |
| **#291** | Owns `Wanderlust Studio`, `simonswanderlust-app`, package names, and the outbound product token (O13). Those strings stay allow-listed until #291 decides |
| **#293** | Compose `PUBLIC_BASE_URL`/`IMG_HOST` → `:?`. The install guide documents setting identity and canonical origin in Settings and the domain-switch order (§7.3) |
| **#295 / #296** | The restore rehearsal checks that identity and assets came back from the dump. #296's inventory lists identity under DB dumps (O1) or under `settings.json` (R1) |

---

## 21. Draft `SECURITY.md` delta (not applied)

- **Public comments, step (3) Origin check:** replace "must equal
  `new URL(PUBLIC_BASE_URL).origin`" with: "must equal the configured **canonical blog
  origin** (`site_identity.canonical_origin`; before it is set, the source #319 introduced; with
  neither, 403) by origin equality, never a prefix match. The image origin (`PUBLIC_BASE_URL`)
  is never accepted."
- **New section "Site identity":**
  - admin-only writes (`/settings/identity*`);
  - one shared validator (`site/src/lib/site-identity.ts`): NFC, `\p{C}` strip, length caps;
  - social URLs `https:` only, no credentials;
  - canonical origin rules (§7.2) with Punycode display;
  - values rendered only through escaping sinks;
  - the build snapshot re-validated in the child and failing closed;
  - the unconfigured `noindex`;
  - `window.SiteIdentity` exposes only public values.
- **New subsection "Logo and favicon":**
  - PNG/JPEG/static WebP only, SVG refused;
  - 2 MiB / 4096² / non-animated;
  - re-encoded PNG with no metadata (EXIF/GPS/XMP/IPTC/ICC dropped);
  - stored in Postgres, ≤ 256 KiB per output;
  - served from the blog origin under content-hashed names with `nosniff`;
  - no server-side remote fetch.
- **Backups:** the dump includes `site_identity` and `site_identity_assets`. Restore refuses
  a dump with an invalid identity value or asset, and a v≤10 dump restores the legacy brand.
- **Gallery allow-list wording:** unchanged. It names the image origin, not the canonical one.
  #276 adds one sentence saying the two are distinct roles.
- **Finding F1:** record that author replies publish the configured author name, not the
  admin's login username.

## 22. Draft `ARCHITECTURE.md` / `CLAUDE.md` deltas (not applied)

- `ARCHITECTURE.md` **Configuration (environment):**
  - add a row "`SITE_IDENTITY_JSON` | build child | **Internal**, set by `build.ts` for each
    `astro build`; not operator-configurable, overwritten if present";
  - add an "Origin roles" table (§7.1);
  - `PUBLIC_BASE_URL`'s example becomes `https://img.example.com` (#293).
- `ARCHITECTURE.md` **Backups:** the dump table list, the new version, and the restore rules
  of §13.2.
- `CLAUDE.md` §Security 1 **Configuration:** "Do NOT grow `.env`. Operational app settings live
  in a JSON settings store on the data volume (`uploader/src/settings.ts`, atomic-rename writes)
  managed via the admin Settings page; **site identity (name, author, taglines, social links,
  canonical origin, logo/favicon) lives in Postgres with the content and travels in DB dumps**;
  `.env` is reserved for bootstrap values."
- `CLAUDE.md` **Change Risk → High:** add "the site identity tables, the identity build
  snapshot, and the canonical-origin/comment-origin roles".

---

## 23. Owner approval record

- **Approver/date:** repository owner, interactive implementation session, 2026-10-27.
- **Evidence:** **“Approve proposed Postgres contract”**, linked to PR #405 at
  `4692ecf30785fa911084e6f328345f255263e7d4`.
- **Approved:** the proposed identity/assets storage, neutral fresh-install and exact legacy
  upgrade seeding, blog origin, noindex-until-configured, re-encoded assets and recovery contract.
- **Settings-store exception:** identity and its assets use Postgres rather than settings.json
  so database recovery preserves a coherent identity. Risks are migration errors and larger
  dumps; bounded validated assets, transactional backup/restore, exact legacy seeding and
  the tests specified here are compensating controls. Review at the first third-party install
  or 2027-10-27, whichever comes first.
- **Still separate:** #291's software/content/brand-rights decisions, #319's independent origin
  fix approval, and any newly discovered issue such as F1. No release, deployment or owner-content
  mutation is authorized by this record.
