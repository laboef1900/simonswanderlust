# Design — Per-Country Passport Stamps

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — ready for implementation planning

## Problem

Each story page shows a decorative "arrival stamp" (`Stamp.astro`), but it's **identical for every
post** — an 80px brand-red dashed circle with the country code + date. The user wants each country to
get its own **authentic-looking passport stamp**, so scrolling the blog feels like flipping through a
stamped passport.

## Goal

Make the per-story stamp look like a real immigration entry stamp, **distinct per country**,
**deterministic** (same country → same stamp), and **on-brand** with the expedition-log aesthetic —
without per-country artwork.

## Research basis

(Field research on real entry stamps — see conversation.) Real stamps cluster into **regional
families**, share a worn **rubber-ink** look, and vary mainly along a few axes (shape, ink color,
border, transport icon). Key facts applied below: circular stamps dominate Asia/Latin America (country
name arced top, date centered, double ring, ✈ icon, star separators); the **Schengen** area uses a
**rectangle with square corners for entry** (EU stars + country code, transport icon, crossing name,
big date, black ink + red accent); ink colors in reality skew black/navy, then red/purple/green;
the rubber-stamp look = semi-transparent ink that multiplies over the page, slightly uneven/blurred,
hand-tilted, with a slightly broken border.

## Decisions (from brainstorming)

- **Deterministic style by country code** (chosen over flags / bespoke art).
- **Two stamp families, assigned by the trip's `region`:**
  - `europe` → **Schengen entry rectangle** (square corners).
  - `north-america` / `south-america` → **circular immigration stamp** (double ring, arced country name).
  - (Any future region falls back to the circular family.)
- Authentic **worn rubber-ink** rendering; **decorative** (`aria-hidden`) as today; ~72–88px.

## Architecture

### 1. `stampStyle(countryCode)` — pure, unit-tested helper

New `site/src/lib/stamp.ts`:
```
type StampShape = 'rect' | 'circle';
interface StampStyle { ink: string; border: 'single' | 'double' | 'dashed'; rotation: number; }
function regionShape(region: string): StampShape   // 'europe' → 'rect', else 'circle'
function stampStyle(countryCode: string): StampStyle
```
- `stampStyle` hashes the (upper-cased) country code to deterministically pick:
  - **ink** from a real-world-weighted palette: `#1a1a2e` (near-black), `#1e3a6e` (navy), `#c0311e`
    (red), `#6b3d9e` (purple), `#1e5c30` (green) — weighting favors black/navy (e.g. black & navy each
    appear multiple times in the pick table).
  - **border**: `single` | `double` | `dashed`.
  - **rotation**: a small hand-applied tilt in the range **−5°…+5°** (deterministic per code).
- Pure (string in → object out), no DOM/Astro — **Vitest-covered**: deterministic & stable for a given
  code, distributes across the palette, ink weighting skews to black/navy, rotation within range,
  `regionShape` maps europe→rect / others→circle. Same country code always yields the same style.

### 2. `Stamp.astro` — SVG renderer (two families)

Rewrite `site/src/components/Stamp.astro`. Props: `{ countryCode, country, date, region, locale }`
(adds `country` name + `region`; `country`/`date`/`countryCode` are already in the page's visible text,
so the stamp stays `aria-hidden`). It computes `shape = regionShape(region)` and
`style = stampStyle(countryCode)`, then renders inline **SVG** in the chosen family:
- **Circle family**: outer circle + (for `double`) inner ring; **country name arced along the top** via
  `<textPath>`, the localized status (`t('story.stamp')`, e.g. EINREISE/ARRIVED) arced along the bottom,
  a ✈ glyph top-center, the **date** (`dateLabel`) large in the center, small star separators.
- **Rect family** (Schengen entry): square-corner rectangle; a small EU-style ring-of-dots + the
  **country code** top-left, a ✈ top-right, the **country name** (city/country) mid, the **date** large
  center, a small red code accent.
- Ink color = `style.ink` (via `currentColor`); border per `style.border`; the whole stamp is rotated
  by `style.rotation`.

### 3. Worn rubber-ink look (CSS, in the component / `global.css`)

Applied to the stamp root:
```css
.stamp { color: var(--ink); opacity: 0.82; mix-blend-mode: multiply; filter: blur(0.3px);
         transform: rotate(var(--rot)); }
```
`--ink` and `--rot` are set inline from `style`. `mix-blend-mode: multiply` over the cream canvas
(`--color-canvas: #fbfbfd`) makes the ink read as printed-on-paper. Border irregularity: `dashed`
borders use an uneven `stroke-dasharray`; a subtle SVG `feTurbulence`+`feDisplacementMap` "ink-worn"
filter is **optional/progressive** (guarded so it degrades to a clean stamp if unsupported). No layout
shift; respects `prefers-reduced-motion` is N/A (static).

### 4. Wiring

`StoryPage.astro:71` currently:
`<Stamp countryCode={trip.data.countryCode} date={trip.data.date} locale={locale} />`
→ add `country={trip.data.country}` and `region={trip.data.region}`. No other call sites.

## Content & i18n

- Reuse the existing `story.stamp` label (`EINREISE` / `ARRIVED`) for the status line.
- Country **name** comes from `trip.data.country` (already locale-correct per row); **code** from
  `countryCode`; **date** via `dateLabel(date, locale)`. **No new i18n keys** — reuse `story.stamp`
  for the status line (the only word on the stamp beyond the data already on the page).

## Error handling / edge cases

- Unknown/short country code → hash still yields a valid style (no crash); shape falls back to circle
  for any non-`europe` region.
- Missing `feTurbulence` support → the base stamp still renders (filter is additive).
- Long country names on the circle → arc text uses tight letter-spacing; if it overflows, the name is
  uppercased and the font scales down (no wrap).

## Testing

- **Vitest** (`site/test/stamp.test.ts`): `stampStyle` determinism/stability, palette distribution &
  black/navy weighting, rotation range, `regionShape` mapping. (The SVG render is verified visually.)
- Visual check (`npm run dev` / running blog): each story shows its country's stamp; Europe posts get
  the rectangle, Americas posts the circle; same country = same stamp; worn-ink look reads as a real
  stamp; no layout shift; `npx astro check` + `npm test` green.

## Non-Goals (YAGNI)

- No flags, no bespoke per-country artwork, no animation.
- No new map/route work. No per-locale stamp shapes (region drives shape, not language).
- Route-line and other expedition-log elements are untouched.
- Not adding a stamp to the homepage/teaser in this change (story page only, as today).
