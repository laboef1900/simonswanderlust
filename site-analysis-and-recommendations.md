# Site Analysis & Rebuild Recommendations — simonswanderlust.com

Date: June 11, 2026
Scope: Analysis only (no build). Follows up on the February 2026 platform decision (see `CONCLUSION.md`).

## 1. Current State Audit

### Tech stack (observed live)

| Component | Finding |
|---|---|
| CMS | WordPress, Hello Elementor theme + Elementor 4.1.2 page builder |
| Multilingual | Polylang — German at root (`/reisebericht-...`), English under `/en/` |
| Performance plugins | WP-Optimize (minify/cache), performance-lab, webp-uploads |
| Server | Fast: TTFB ~120 ms, HTML ~69 KB |
| Assets (homepage) | ~34 requests: ~12 JS bundles, 4 web fonts (Montserrat + Font Awesome + Elementor eicons), ~20 images |

### Content inventory

- **18 posts** = 9 travel stories × 2 languages (Feb 2021 – Oct 2024): Mexico, Rhodes, Copenhagen, Netherlands houseboat, Costa Rica, Galápagos, Amazon/Cuyabeno, Budapest, Bucharest
- **12 pages** (home, about, destination/region pages × 2 languages)
- **976 media items** in the library (only a fraction referenced by posts)
- Writing quality is good: structured travel reports with sections, key-facts boxes, tables of contents

### What actually feels outdated (from screenshots, desktop + mobile)

1. **Greyscale hero slider.** The homepage opens with a desaturated autoplay image carousel — it washes out travel photography (the strongest asset of a travel blog) and carousels are a dated 2015-era pattern. On mobile it consumes the entire first screen.
2. **Generic Elementor look.** Uniform 3-column card grid, red "READ MORE" buttons, justified text walls — it reads as a template, not a personal site.
3. **Localization leaks.** The English site shows German UI text: footer headings "Neueste Beiträge" and "Über mich", post TOC labeled "Inhalt". This is the single most "unpolished" signal on the site.
4. **Post layout issues.** Title overlaid on busy hero images with weak contrast; a large blank region mid-article (gallery spacing); small body type.
5. **No travel map.** The Polarsteps-style map — the feature you most wanted in February — doesn't exist yet, and nothing on the site communicates "where I've been" at a glance.

**Notably NOT the problem:** raw performance. TTFB is fast, images are WebP, assets are minified. The outdated feeling is design language + polish, not speed. (The slider does load 6 full-size header images upfront, which hurts mobile, but that's a design fix too.)

## 2. Recommendations

### R1 — Confirm the February decision: rebuild on Astro (still correct in mid-2026)

Nothing has changed that would reverse it: 18 posts is a trivially small migration, your workflow preference is Markdown + Git + Claude, and static hosting stays ~$0/month. Astro 5.x adds first-class content collections (typed Markdown/MDX via `content.config.ts`) and built-in i18n routing, both squarely aimed at this exact use case.

### R2 — Revise the February execution plan: skip the subdomain map pilot

The Feb plan (map pilot on subdomain → migrate later) optimized for migration risk. With only 9 stories the migration risk is small, and the bigger pain today is the blog itself. Build one Astro site with the map as a core feature. One repo, one design language, no throwaway subdomain work.

### R3 — Design direction: photography-first, map-centric

- **Kill the carousel.** One strong full-color hero (or the map itself) instead of a greyscale slider.
- **Interactive travel map as the site's signature element** — world map showing visited countries/routes, each marker linking to its story. MapLibre GL (free, no API key, vector tiles) or Leaflet (simpler, raster). This is what makes the site distinctly *yours* rather than another travel-card grid.
- **Magazine-style story index** — varied card sizes / editorial layout instead of a uniform 3-col grid; let the photos breathe full-bleed.
- **Typography refresh** — larger body text, left-aligned (not justified), a serif or distinctive display face for headings instead of Montserrat-everywhere.
- **Strict localization** — every UI string (footer, TOC, dates, labels) localized per language; this fixes the current DE/EN leaks by construction.
- Keep the good parts: key-facts boxes, per-section TOC, structured trip reports — these translate directly to MDX components.

### R4 — Recommended stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Astro 5.x, content collections, MDX | Markdown-native, near-zero JS by default, islands for the map |
| Styling | Tailwind CSS 4 | Fast iteration, no dead CSS, works well with Claude-driven dev |
| Map | MapLibre GL JS (or Leaflet if simpler is preferred) | Free, no API keys, vector styling matches a custom design |
| i18n | Astro built-in i18n routing: DE at root, EN under `/en/` | Mirrors current URL structure → SEO preserved |
| Images | `astro:assets` (sharp) | Responsive sizes, AVIF/WebP, lazy loading at build time |
| Search | Pagefind | Static, no service, runs at build |
| Comments | Skip initially (current site has none visible); add Giscus later if wanted | Zero cost |
| Contact form | Formspree/Web3Forms free tier or mailto | No backend needed |
| Hosting | Cloudflare Pages or Netlify free tier, deploy from Git | $0/month, CDN included |
| Analytics | Cloudflare Web Analytics or Plausible | Lightweight, GDPR-friendlier |

### R5 — Migration approach (when you decide to build)

1. **Export via WP REST API** — it's already publicly enabled (`/wp-json/wp/v2/posts`); script pulls all 18 posts + pages as HTML.
2. **Convert HTML → Markdown/MDX**, mapping Elementor patterns (key-facts boxes, galleries) to small Astro components.
3. **Download only referenced media** (~few hundred of the 976 items), run through the Astro image pipeline.
4. **Preserve slugs exactly** (`/reisebericht-4-tage-bukarest/`, `/en/4-day-travel-report-bucharest/`) plus correct hreflang pairs; 301-redirect anything that must change. This protects existing SEO.
5. **Cutover**: point DNS to the new host once parity is verified; keep the WP site as fallback until confirmed.

### R6 — Effort estimate (build with Claude)

| Phase | Scope | Rough effort |
|---|---|---|
| 1. Skeleton + design system | Astro project, i18n routing, layout, typography, nav/footer | 1–2 sessions |
| 2. Content migration | Export, convert, image pipeline, both languages | 1–2 sessions |
| 3. Travel map | Map component, trip data model, markers/routes | 1–2 sessions |
| 4. Polish + cutover | Search, redirects, SEO checks, deploy, DNS | 1 session |

Total: roughly a focused week of evenings, not a multi-week project.

## 3. Risks & open questions

- **SEO continuity** is the main technical risk — mitigated by keeping the slug structure and hreflang pairs (R5.4).
- **Content cadence**: newest post is Oct 2024. A redesign won't fix a stale-content impression by itself — worth planning 1–2 new posts to launch alongside it.
- **Open question — map data**: do you have GPS/route data (e.g., a Polarsteps export) or should trips be hand-pinned? Determines the map's data model.
- **Open question — design taste**: before building, pick a visual direction from 2–3 mockups (the visual companion is set up for exactly this).

## 4. Suggested next step

When ready to build: start with Phase 1 and a mockup round (2–3 homepage design directions to choose from), then proceed phase by phase. No commitment made yet — this document is analysis only.
