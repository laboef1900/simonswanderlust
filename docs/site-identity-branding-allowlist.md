# Fresh-install branding scan: #274 allow-list

Scope: scan a **fresh database with deliberately non-owner identity/content** after building,
plus served admin HTML and its copy script, for `Simon|simonswanderlust|Wanderlust`.
This is a bounded exception list, not a blanket exemption for those expressions. A match
must be attributable to the named surface below. The isolated runtime scan recorded below
exercised this list; it is not an exemption for future, unclassified matches.

The approved [#273 contract](superpowers/specs/2026-10-27-issue-273-site-identity-design.md)
splits text identity (#274), assets (#275), canonical/origin behaviour (#276), software
branding (#291), and bootstrap host defaults (#293). #274 must not silently implement the
other children merely to make the scan empty.

## Software identity exceptions — owned by #291

| Exact remaining value | Source / possible output | Owner and expiry |
| --- | --- | --- |
| `Wanderlust Studio` | `site/src/i18n/ui.ts` `editor.chrome.studioName`, exposed through `EditorCopy` and painted into the admin shell; comments in served `uploader/public/admin.css` | #291 decides the software name; not the site's configurable name or descriptor |
| `SimonsWanderlust` | Product token in `uploader/src/geocoding.ts`'s Nominatim User-Agent | #291 decides the product token; #276 owns origin/version formatting |
| `simonswanderlust-app` | GHCR image reference in `docker-compose.yml` (not public page content) | #291 package/image naming |
| `simonswanderlust-images` | `uploader/package.json` package name (not public page content) | #291 package naming |

## Temporary origin exceptions — owned by #276 / #293

These are **not** text-identity regressions and must be removed from this list when their
owning child lands. #274 does not claim a fully neutral canonical/SEO deployment.

| Remaining match / exact scope | Source / output | Owner |
| --- | --- | --- |
| `https://simonswanderlust.com` as canonical base | `site/astro.config.mjs`, `site/src/lib/seo.ts` `PROD_SITE`; canonical, hreflang, OpenGraph URLs, JSON-LD URLs, sitemap and RSS link URLs derived from those bases | #276 |
| `Sitemap: https://simonswanderlust.com/sitemap-index.xml` | `site/public/robots.txt` | #276 |
| `simonswanderlust.com/` and `simonswanderlust.com/en/` | The two `.slug-base` preview spans in served `uploader/public/editor.html` | #276 |
| `https://img.simonswanderlust.com` | `site/src/lib/images.ts` `PROD_IMAGE_ORIGIN`, uploader `main.ts`/`cli.ts` image-origin defaults; preconnect/image URLs only when that fallback is actually selected | #276; production bootstrap defaults/examples in compose and `.env.example` belong to #293 |
| `https://simonswanderlust.com` in outbound identification | Nominatim User-Agent in `uploader/src/geocoding.ts`, OpenRouter `HTTP-Referer` in `uploader/public/llm.js` | #276 |
| `SimonsWanderlust` in OpenRouter `X-Title` | `uploader/public/llm.js` | #276 replaces the site-title header independently of #291's product-token decision |

## Source-only or intentionally restored values

- `uploader/src/site-identity-legacy.ts` is the exact **upgrade / pre-identity-restore seed**,
  never a fresh-install default. Its site/author names, tagline, role, gear, studio descriptor,
  social link and historical review-prompt first line are expected in source and in legacy
  recovery fixtures, but **not exempt in fresh-install output**.
- Test fixtures deliberately include legacy/hostile names and URLs. They are not deployed
  content and are outside the output scan; a bundled fixture would be a defect, not an exception.
- `simonswanderlust:style-to-class` is Shiki's internal transformer name in
  `site/src/lib/shiki-classes.ts`, not emitted markup. There is no output exemption for it.
- Historical MDX files under `site/src/content/trips/` are authoring references, not the
  Postgres loader's source of truth. The fresh-install scan must not import owner content.
- Existing About body text, post bodies, photo metadata and old comment names are owner/reader
  content, not identity settings. #274 never rewrites them. #286/#289 own basic-page content
  migration; a fresh-install fixture that intentionally imports owner content is not a valid
  test of neutral defaults.

## Never allow-listed

Fresh configured output must use the configured site name for title suffixes, RSS titles,
`og:site_name`, nav/footer names and admin title suffixes; the configured author for About
headings, JSON-LD authors and new replies; and configured localized taglines, role/gear,
studio descriptors and social links. The neutral review-prompt default must not mention the
legacy brand. These surfaces are #274's responsibility and cannot be waived by this document.

The main verification run should record every residual match against the exact surface above,
not simply filter all matching domains or words. Existing-install rendered comparisons use a
separate legacy-seeded fixture; they must not be confused with the fresh-install scan.

## Isolated runtime proof — 2026-10-28

The real app on `localhost:33374`, backed only by `swl_274_dev` on
`127.0.0.1:55427`, started with a neutral identity and no users, posts or comments.
Synthetic accounts, a generated image, a DE/EN story and synthetic About content were
created through the application. The runtime explicitly overrode the fixture's generic
image origin with `PUBLIC_BASE_URL=http://localhost:33374` and
`IMG_HOST=localhost:33374`; the builder inherited those same values.

After configuring **Atlas & Ember `<Journal>` / Mira Vale**, real Publish and Rebuild
produced release `1793181299422-31938-0006`. A byte scan of all **54 release files**
(including scripts, styles and fonts), all **10 served admin HTML pages** (HTTP 200),
and the served `editor-image-copy.js` found **88 matches**, each classified:

| Actual remaining surface | Matches | Existing exception |
| --- | ---: | --- |
| Canonical / hreflang / OpenGraph URL attributes | 62 | #276 |
| Sitemap and RSS URL elements | 19 | #276 |
| JSON-LD `mainEntityOfPage` URLs | 2 | #276 |
| `robots.txt` sitemap URL | 1 | #276 |
| Editor `.slug-base` preview spans | 2 | #276 |
| DE/EN `studioName: "Wanderlust Studio"` in the copy script | 2 | #291 |

**Unclassified matches: zero.** This scans the deployed release, not a potentially stale
standalone `site/dist`. The full per-file inventory, offsets, match contexts and classifications
are retained locally in `.issue-runtime/identity-branding-scan.json`.

The same runtime also demonstrated:

- Browser editing/saving, explicit next-build messaging, hash-selected Settings tab, and
  admin title changes on the next page load; DE/EN public pages at desktop and phone widths.
- Admin identity responses `200` with `no-store`; non-admin GET/PUT `403`, anonymous GET
  `401`, fifteen invalid input cases `400`, and stale revisions `409`, including browser
  conflict/reload recovery. Controls, bidi/zero-width/private-use characters and leading
  tabs/trailing newlines were refused rather than silently trimmed.
- Real built titles, OpenGraph, RSS, JSON-LD author, About profile, footer and ordered social
  links. Hostile image/script-shaped text remained text; RSS/XML and JSON-LD escaped it,
  with no injected attacker image or script. Links retained `noopener noreferrer`.
- A live exporter transaction was observed before an identity save during a rebuild.
  That release retained the old captured identity; the next browser-triggered rebuild used
  the new one. Saving did not implicitly rebuild.
- Author replies stored **Mira Vale**, then **Ari Rowan** immediately after changing the author.
  Both names remained unchanged in Postgres and public comment JSON after later identity edits;
  neither exposed the admin login name.
- Configuring the exact legacy values and rebuilding reproduced both locales' expected title,
  OpenGraph/RSS names, JSON-LD author, About heading/role/gear, footer tagline/gear and Instagram
  link. The fresh fixture's effective review prompt was brand-neutral.

Detailed observations and screenshots are retained in
`.issue-runtime/identity-runtime-evidence.json` and `.issue-runtime/identity-*.png`.
These are private local evidence, not committed binaries. This smoke did **not** boot a
pre-upgrade executable, replay legacy migration/restore, or inject exporter loss/timeouts;
the parent-run integration/rendered suites and dedicated recovery checks supply that separate
evidence. No production content or external AI/provider calls were used.
