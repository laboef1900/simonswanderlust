# Design Spec: simonswanderlust.com Rebuild

Date: 2026-06-11
Status: Approved direction; pending final user review of this document
Supersedes: execution plan in `CONCLUSION.md` (Feb 2026) — platform decision (Astro) unchanged, subdomain map pilot dropped
Inputs: `site-analysis-and-recommendations.md` (June 2026 audit), visual companion session (mockups in `.superpowers/brainstorm/58521-1781154967/content/`)

## 1. Goal

Replace the WordPress/Elementor site at simonswanderlust.com with a self-built Astro site that:
- looks hand-crafted and current instead of templated (user's core complaint: "feels outdated")
- adds the long-wanted Polarsteps-style travel map
- eliminates the DE/EN localization leaks by construction
- preserves SEO (exact slugs, hreflang)
- reduces hosting cost to ~$0/month and removes the WordPress maintenance treadmill

## 2. Decisions made (with user, June 11 2026)

| Decision | Choice |
|---|---|
| Overall direction | **B — Editorial magazine**: photography-first, full-bleed hero, asymmetric grid |
| Visual voice | **3 — Refined brand**: existing navy + red logo colors on a light canvas, bold modern sans (Inter) |
| Map placement | All three: dedicated map page **+** homepage teaser strip **+** per-story mini-map |
| Map data | Hand-placed pin coordinates in frontmatter for v1; per-trip route lines later via Polarsteps export ("Download my data") |
| Build approach | Analysis → spec → plan → implement with Claude; no code before plan approval |

## 3. Visual design system

- **Canvas:** light background (#FBFBFD), near-black/navy text
- **Brand colors:** navy `#142A42` (primary), red `#D23B30` (accent; final value tuned to match the existing logo during implementation). Existing logo is kept.
- **Typography:** Inter — extra-bold for headlines, regular 18px+ for body, left-aligned (never justified). Wide-tracked small caps for labels (dates, countries).
- **Photography:** always full color (no greyscale filters), full-bleed where possible, no autoplay carousels anywhere.
- **Texture details:** photo-popup map pins, key-facts info boxes, section TOC — carried over from the current site as redesigned components.

## 4. Site structure

Locale model: German is the default locale at root (no prefix); English under `/en/`. This mirrors the current Polylang URL structure exactly.

| Page | DE URL | EN URL |
|---|---|---|
| Home | `/` | `/en/` |
| Map | `/karte/` | `/en/map/` |
| Story (×9) | current root slugs, e.g. `/reisebericht-4-tage-bukarest/` | current `/en/` slugs, e.g. `/en/4-day-travel-report-bucharest/` |
| About | current slug preserved | current slug preserved |
| 404 | localized | localized |

**Slug preservation is a hard requirement.** All 18 existing post URLs and the about/page URLs resolve identically on the new site. Any URL that cannot be preserved gets a 301 redirect. hreflang pairs are generated for every DE/EN pair. Sitemap + RSS generated at build.

**Removed:** the "Destinations by region" page tree. Replaced by region filtering on the home story grid (client-light: pre-rendered filter, no framework needed). Old region page URLs get 301s to the home grid.

### Homepage composition (top to bottom)
1. Slim nav: logo · Stories · Map · About · DE/EN switcher
2. Full-bleed featured story hero (newest story), title + country/date label overlaid on gradient
3. Map teaser strip: wide static-feel map snapshot with pins, "9 trips · 4 continents — view the map →" linking to `/karte/`
4. Story grid: asymmetric editorial grid of all trips (one large card per row-group, smaller satellites), region filter chips above
5. About teaser (photo + two sentences + link), footer (localized strings only, Instagram link)

### Story page composition
1. Full-bleed hero image, title + label overlaid
2. Intro + key-facts box (country stats, as today) + section TOC
3. Body: prose sections, image galleries (grid + lightbox-free enlarged view; no JS lightbox in v1), tables where present
4. Mini-map of this trip (pin(s); route line when data exists)
5. Prev/next story navigation, link to the other language version

## 5. Technical architecture

| Concern | Choice |
|---|---|
| Framework | Astro 5.x, static output |
| Content | Astro content collections, MDX, zod-typed frontmatter |
| Styling | Tailwind CSS 4 |
| Interactivity | MapLibre GL JS as the only JS island (map page + mini-maps); everything else zero-JS |
| Images | `astro:assets` (sharp): responsive sizes, AVIF/WebP, lazy loading |
| i18n | Astro built-in i18n routing; `defaultLocale: 'de'` (no prefix), `en` prefixed. UI strings in per-locale dictionaries (`src/i18n/de.ts`, `en.ts`) — no hardcoded UI text in components |
| Hosting | Cloudflare Pages free tier, Git-connected deploys (user pushes manually per git policy) |
| Analytics | Cloudflare Web Analytics |
| Repo layout | This folder (`localGIT/blog`) becomes the project repo; Astro app in `site/`; research docs and specs stay at root. Repo stays private when pushed. |

### Content model

One MDX file per trip per language: `src/content/trips/{locale}/{slug}.mdx`

```yaml
title: string
date: date                # trip publication date
country: string           # localized display name
countryCode: string       # ISO 3166-1 alpha-2, for flags/filtering
region: enum              # europe | north-america | south-america (extend as new regions are visited)
translationKey: string    # shared DE/EN id → hreflang + language switcher
excerpt: string
heroImage: image
coordinates: { lat, lng } # primary pin
stops: [{ name, lat, lng }]   # optional, extra pins
route: string             # optional, path to GeoJSON line (Polarsteps later)
keyFacts: { population, capital, area, ... }  # optional, renders facts box
```

The map page and homepage teaser derive all pins from the collection — adding a story automatically adds its pin. No separate map data file.

### Error handling
- Frontmatter schema violations fail the build (zod), so broken content can't deploy.
- Missing translation pair: build warning; language switcher falls back to the other locale's home.
- Map island failure (no JS / tile error): teaser and mini-maps render a static fallback image with a link; map page shows pin list as text fallback.

## 6. Migration plan

1. **Export:** script pulls all posts/pages/media metadata via the open WP REST API (`/wp-json/wp/v2/...`).
2. **Convert:** HTML → MDX; Elementor patterns mapped to components (key-facts box, galleries, TOC). Manual review pass per story (9 stories × 2 — feasible).
3. **Media:** download only images referenced by content (subset of the 976 media items) into the repo; pipeline re-optimizes them.
4. **Parity check:** crawl old sitemap, verify every URL returns 200 with equivalent content on the new build; diff title/meta/hreflang.
5. **Cutover:** point DNS to Cloudflare Pages. WordPress hosting stays live (unlinked) as fallback until post-cutover checks pass, then can be cancelled.

## 7. Out of scope for v1

- Site search (9 stories; revisit at ~25+)
- Comments (none exist today; Giscus is the candidate if ever wanted)
- Contact form (Instagram link remains the contact channel)
- Polarsteps route-line import (data model supports it; not blocking)
- New content authoring (recommended alongside launch, but separate from the rebuild)

## 8. Verification & success criteria

- All 18 old post URLs + pages return 200 with preserved slugs; hreflang pairs validate
- Zero untranslated UI strings on either locale (the current footer/TOC leaks are the regression test)
- Lighthouse (mobile): Performance ≥ 90, SEO ≥ 95 on home and one story page
- Map: pins for all 9 trips, popups link to correct story in the active language
- Build + deploy pipeline green from a clean clone
- Visual sign-off by Simon on home, map, one story page, both locales

## 9. Risks

| Risk | Mitigation |
|---|---|
| SEO regression | Slug preservation, 301s, hreflang, parity crawl before DNS cutover; WP kept as instant fallback |
| Elementor HTML converts messily | Only 9 stories; manual review pass is budgeted in the plan |
| Image weight regression | `astro:assets` enforces responsive sizes; Lighthouse gate |
| Map adds JS bloat | MapLibre loads only on interaction-relevant pages; static fallback elsewhere |

## 10. Next step

After user review of this spec: create the implementation plan (superpowers writing-plans), phased as (1) skeleton + design system, (2) content migration, (3) map, (4) polish + cutover. Implementation starts only after plan approval.
