# New regions: Asia, Africa, Oceania, Antarctica

**Date:** 2026-10-19
**Risk:** HIGH — new public routes (Golden Rule 2 territory) and a schema constraint change in
`uploader/src/db.ts`.
**Status:** Owner-requested and approved in the implementing session on 2026-10-19 ("Add Asia,
Oceania, Africa and Antarktika DE and EN"), after being shown that each region adds public pages
and a database constraint change.

## 1. Why

A story's `region` is a closed list of three — `europe`, `north-america`, `south-america` —
hard-coded in about ten places. The owner travels beyond them and needs Asia, Africa, Oceania and
Antarctica, in both languages.

## 2. Contract

| key | DE label | DE slug | EN label | EN slug |
|---|---|---|---|---|
| `europe` | Europa | `europa` | Europe | `europe` |
| `asia` | Asien | `asien` | Asia | `asia` |
| `africa` | Afrika | `afrika` | Africa | `africa` |
| `north-america` | Nordamerika | `nordamerika` | North America | `north-america` |
| `south-america` | Südamerika | `suedamerika` | South America | `south-america` |
| `oceania` | Ozeanien | `ozeanien` | Oceania | `oceania` |
| `antarctica` | Antarktis | `antarktis` | Antarctica | `antarctica` |

- The table order is the display order (continents, roughly west-east then south).
- The three existing slugs are the live WordPress slugs and are **unchanged**. The four new
  slugs are new URLs with no WordPress counterpart, so no legacy redirect is added.
- Routes: `/reiseziele/<de-slug>/` and `/en/destinations/<en-slug>/`.
- **No empty region pages are advertised:** a region page is generated, and listed in the
  destination chips, only when the locale has at least one published story in that region.
  The current region on its own page is always shown. The regions index and the sitemap follow
  the generated pages. Today all three existing regions have stories, so nothing visible changes
  for them.
- Stamp shape stays as is: Europe keeps the rectangle, every other region gets the circle.

## 3. Places that change together

- Site: `site/src/lib/paths.ts` (`regions`, `regionSlugs`), `site/src/content.config.ts` (Zod
  enum derived from `regions`), `site/src/i18n/ui.ts` (`region.*` labels in both locales), the
  region pages' `getStaticPaths`, `RegionFilter.astro`, and the `trips.ts` comment.
- Uploader: `src/db.ts` CHECK constraint, `src/posts.ts` `REGIONS`, the editor's region
  `<select>`, `public/posts-filter.js`, and `src/redirects.ts` (comment only, no new entries).

## 4. Schema change

`posts.region` carries `CHECK (region IN ('europe','north-america','south-america'))`.
`ensureSchema` widens it idempotently. In one transaction it looks up the region CHECK
constraint(s) on `posts` in `pg_constraint` by definition, not by name. When the only match is
already `posts_region_check` with all seven values, it does nothing. Otherwise it drops every
match and adds the seven-value check as `posts_region_check`. Fresh installs get the named check
from `CREATE TABLE`. Any error fails boot.

**Invariant:** the change only widens the allowed set, so every existing row stays valid and no
data is rewritten.

## 5. Misuse and failure cases

| Case | Answer |
|---|---|
| A slug collides with an existing route | All new slugs are unique within their locale; `paths.test.ts` asserts it. |
| A region with no stories produces a thin page | Not generated and not linked (§2). |
| Old image after a story uses a new region | Its loader/Zod enum rejects the value and the build fails. Rollback = reassign those stories to an old region first, or stay on the new image. |
| Constraint named differently on some database | The migration looks the constraint up in `pg_constraint` by table and definition, not only by name, and fails boot loudly rather than leaving the old check in place. |

## 6. Verification

Site tests (`paths`, `trips`, region pages), `astro check` and a build. Uploader tests:
validation accepts the new keys and rejects unknown ones, and an integration test where a
database created with the old three-value check accepts `asia` after `ensureSchema` while
existing rows are untouched.
