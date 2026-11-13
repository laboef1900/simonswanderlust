---
name: Simon's Wanderlust
description: An expedition log kept as an editorial magazine — ink pressed on paper, photography first.
colors:
  brand-red: "#d23b30"
  brand-red-light: "#ff5a4e"
  navy: "#142a42"
  ink: "#16212e"
  canvas: "#fbfbfd"
  stamp-ink-near-black: "#1a1a2e"
  stamp-ink-navy: "#1e3a6e"
  stamp-ink-oxblood: "#c0311e"
  stamp-ink-plum: "#6b3d9e"
  stamp-ink-forest: "#1e5c30"
typography:
  display:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "normal"
  headline:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body-long:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.7778
    letterSpacing: "normal"
  body-sm:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4286
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.18em"
  label-quiet:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3333
    letterSpacing: "0.18em"
  label-lg:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3333
    letterSpacing: "0.18em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  gutter: "20px"
  grid-gap: "16px"
  card-padding: "16px"
  panel-padding: "20px"
  panel-padding-lg: "24px"
  section-y: "48px"
  section-y-lg: "64px"
  footer-y: "32px"
  grid-row: "280px"
components:
  hero-entry-panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.navy}"
    rounded: "{rounded.sm}"
    padding: "{spacing.panel-padding}"
    width: "42rem"
  stamp-chip:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "8px"
  story-card:
    backgroundColor: "{colors.navy}"
    textColor: "#ffffff"
    rounded: "{rounded.xl}"
    padding: "{spacing.card-padding}"
    height: "100%"
  card-caption-panel:
    backgroundColor: "rgb(20 42 66 / 0.92)"
    textColor: "#ffffff"
    padding: "16px"
  card-meta-line:
    textColor: "rgb(255 255 255 / 0.7)"
    typography: "{typography.label-quiet}"
  card-caption-ramp:
    height: "40px"
  footer-logline-plate:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.brand-red-light}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  nav-link:
    textColor: "rgb(22 33 46 / 0.8)"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "44px"
  nav-link-hover:
    textColor: "{colors.brand-red}"
  nav-link-active:
    textColor: "{colors.brand-red}"
  destination-link:
    textColor: "{colors.navy}"
    typography: "{typography.label}"
    fontSize: "0.875rem"
    rounded: "{rounded.sm}"
    height: "44px"
  destination-link-hover:
    textColor: "{colors.brand-red}"
  destination-link-current:
    textColor: "{colors.brand-red}"
  map-cta:
    textColor: "#ffffff"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "44px"
  panel-keyfacts:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    padding: "12px 0"
  panel-toc:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.navy}"
    padding: "12px 16px"
  skip-link:
    backgroundColor: "{colors.brand-red}"
    textColor: "#ffffff"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
---

# Design System: Simon's Wanderlust

## Overview

**Creative North Star: "The Expedition Log"**

An editorial magazine whose furniture is a field logbook. The page is paper —
a near-white canvas (`#fbfbfd`) with navy ink — and the recurring props are the
ones a traveller actually accumulates: coordinates set in mono, entry numbers
(`N°09`), arrival stamps pressed askew, dashed route rules, contour lines, a
graticule with real degree labels. None of it is ornament for its own sake: the
coordinates come from the post's frontmatter, the entry number is its
chronological position, the graticule in the map band is a genuine projection
with pins measured against it. The mood is precise, weathered, unhurried,
evidence-first.

Photography leads, and the interface is the mount rather than the picture. That
single commitment produced the system's hardest rule: type is never asked to
survive against a photograph through a scrim. Where words must sit over an
image they get their own plate — navy for white type, canvas for dark ink —
which then frees the gradient above to stay light, so the photograph survives
too. Two plates are deliberately translucent at a measured floor (the hero entry
panel at `canvas/85`, card captions at `navy/92`); see The Opaque Plate Rule.
On desktop the homepage hero's vignette (`from-navy/45 via-navy/10 via-40%`)
grounds the paper; story captions use a short ramp. On mobile neither needs a
scrim: text sits below the photograph.

Density is low and deliberately uneven. A six-column mosaic gives the index a
cadence (a 4×2 lead tile, then threes, with the tail levelled so no cell is ever
empty); below `640px` full-width photographs retain their natural proportions,
with captions beneath. Portraits, not card indices, supply the taller beats.
The homepage cover repeats only as a compact index entry. Explicitly rejected in
`CLAUDE.md`: glassmorphism, bento grids, dark-by-default themes, and the generic
2018–2026 travel-blog hero (full-bleed photo → eyebrow → extrabold headline →
filled pill CTA).

**Key Characteristics:**

- Ink-on-paper base: canvas page, navy structure, one loud red accent used sparingly.
- Opaque plates, never scrims, wherever type meets a photograph.
- Contrast measured against the composited pixel and pinned in `site/src/styles/tokens.test.ts`.
- Flat by default; elevation declared once per element, as border **or** shadow.
- A mono uppercase log register (IBM Plex Mono, `0.18em`) for every coordinate, date and entry number.
- Structural, restrained components; no pills, no filled CTAs except the skip link.

## Colors

A two-material palette — near-white paper and deep navy ink — with a single
signal red that changes weight, not hue, depending on which material it lands on.

### Primary

- **Expedition Red** (`brand-red`): the site's one loud voice. Active nav item,
  the hero's entry number, destination counts, the "Read story" call, prose
  links, the first-letter drop cap, the route divider's terminals, the focus
  ring, and the skip link. Measured **4.609:1** on canvas — AA with 0.109 of a
  point to spare, which is why a "slightly warmer red" is a breaking change.
  It fills no plate on the public site: the one that did, the story card's
  cover-story kicker, was removed rather than restyled.
- **Signal Red Light** (`brand-red-light`): the same voice on dark material.
  The footer logline, the map band's stat line and its pins. **4.741:1** on
  navy, where `brand-red` itself is only **3.1:1** and therefore never carries
  text. Nothing on a story card uses it any more, which is what freed that
  card's caption to be translucent — see Cards.

### Tertiary

- **Stamp Inks** (`stamp-ink-near-black`, `stamp-ink-navy`, `stamp-ink-oxblood`,
  `stamp-ink-plum`, `stamp-ink-forest`): the arrival stamp's five-ink set in
  `site/src/lib/stamp.ts`, chosen deterministically per country code and
  weighted so black and navy cover ~57% of codes. Decorative
  (`aria-hidden`, `role="presentation"`) but held to text contrast anyway: on
  the opaque canvas chip the lightest ink measures **5.49:1** and the darkest
  **16.5:1**. They print with `mix-blend-mode: multiply` at full opacity, so
  the ink sits *in* the paper rather than on it.

### Neutral

- **Log Navy** (`navy`): brand and structure. Headings, dark bands (map teaser,
  footer), the story card's own body, every opaque plate under white type, and —
  at low alpha — hairline borders and dashed rules.
- **Reading Ink** (`ink`): body copy only. Slightly cooler and darker than navy
  so running text sits back from headings without a size change. Both `ink` on
  canvas and `canvas` on navy clear **7:1**.
- **Paper Canvas** (`canvas`): the page. Also the material of every light plate —
  the hero entry panel, the stamp chip, the Key Facts and TOC panels, the story
  pagination cards.

Two composited surfaces are not tokens and must never be treated as such. The
footer's real backdrop is the **contour ridge** `rgb(47 73 99)` — `Contours.astro`
paints `#7fa3c8` at 25% opacity over navy — and the map band's degree labels are
painted in `#d0d4d9`, which *is* white-at-0.8-over-navy made opaque so the glyph
stops sampling whatever coastline passes behind it.

### Named Rules

**The Opaque Plate Rule.** Type never reads against a photograph through a
scrim. Where text must sit on an image it gets its own plate — navy for
white type, canvas for dark ink — and the scrim is then free to stay light so
the photograph survives. This is why
`FeaturedHero`'s entry panel, the story card's caption panel, the stamp chip and
footer logline all look the way they do: the hero's log line measured **1.19:1**
on a phone before it got a plate and its headline sat at **~2.8:1** whenever a
long German compound pushed it out of the dark end of the scrim; on paper the
same type is **5.4:1 to 14:1** on every frame. The card's accent line ranged
**1.90:1 to 5.01:1** depending only on which part of which photograph sat behind
it; on solid navy it is **4.8:1**, and white beside it **14.6:1**.
A plate may be translucent only at a measured floor, never by eye, and never with
a backdrop blur (glassmorphism). Two are: story card captions at `navy/92` (see
Cards), and — at the owner's request (2026-10-18) — the hero entry panel at
`canvas/85`, where `navy/70` still clears AA over a black frame (**4.59:1**,
pinned in `tokens.test.ts`) but the `brand-red` accents fall to **3.25:1** in
that worst case. That shortfall is accepted, not a precedent. The stamp chip and
the footer logline plate stay opaque.

**The Measured Backdrop Rule.** Contrast is measured against the composited
pixel, never the token. Alphas multiply; a texture lightens its own background;
`border-navy/45` reads safe and is **2.67:1**. `site/src/styles/tokens.test.ts`
is the enforcement — it reads the palette out of `global.css` and the ridge out
of `Contours.astro` rather than restating either, and it pins every measured
ratio to three decimals. Recorded failures it now prevents: `text-ink/70` under
`opacity-70` composites to α 0.49 and **3.14:1**; `text-white/50` on the footer
columns is **3.705:1** against the ridge, `/60` clears by 0.077 of a point, `/70`
is **5.578:1**; `navy/60` on canvas is **4.05:1** where `navy/70` passes;
`text-ink/60` on the language switcher was **4.33:1**.
The small StoryGrid empty-state title and About profile-stat labels use
`navy/70`; the no-JavaScript map introduction uses `ink/70`. Browser-composited
contrast on their canvas surfaces measures **5.51:1** and **5.98:1**, respectively,
in DE and EN at desktop and mobile widths. Their size, weight and spacing still
carry the secondary hierarchy; reduced contrast does not.

**The Two-Accent Rule.** `brand-red` is for light material, `brand-red-light`
for dark. They are not a light/dark pair to be "simplified" into one token —
`tokens.test.ts` has a test whose entire job is to record that `brand-red` on
navy is under AA and the light accent is not. On the contour ridge neither works
at any alpha (`brand-red-light` is **3.058:1** opaque, **3.03:1** measured live),
which is why the footer logline sits on a plate instead.

## Typography

**Display Font:** Inter Variable (with `ui-sans-serif`, `system-ui`, `sans-serif`)
**Body Font:** Inter Variable — the same face; hierarchy is carried by weight and size, not by a second serif
**Label/Mono Font:** IBM Plex Mono (with `ui-monospace`, `SFMono-Regular`, `monospace`), weights 400 and 600 self-hosted via `@fontsource`

**Character:** One neutral, high-legibility sans doing all the reading work at a
single heavy weight (800) for every heading, against a mono register that is
always uppercase and always tracked at `0.18em`. The mono is not decoration: it
marks the parts of the page that are *measurements* — coordinates, dates, entry
numbers, country codes — and it is the only place the logbook metaphor is
allowed to speak.

### Hierarchy

- **Display** (800, `24px → 30px → 36px` at base/`sm`/`md`, line-height 1.12):
  the promoted entry title in `FeaturedHero` and the story page's `<h1>`.
  Carries `text-balance`, `break-words` and `hyphens-auto` below `sm` —
  a 30-character German compound at this weight measured a `scrollWidth` of
  **819** against a **390px** viewport, 429px of sideways pan on the landing
  page in the default locale.
- **Headline** (800, `24px → 30px` at base/`sm`, line-height 1.2): section
  headings — "Alle Reiseberichte", the map band, the region page `<h1>`. The map
  band was deliberately pulled down from `30px` at base so the closing band
  never shouts louder than the hero entry it exists to support.
- **Title** (800, `20px` base; `16–24px` from `sm` up, line-height 1.25):
  story card headings. Mobile captions show the full title; the already-featured
  cover uses `16px` beside its compact thumbnail. From `sm`, three title tiers
  follow the mosaic, with a two-line clamp and a full `title` attribute.
- **Body** (400, `16px`, line-height 1.5): the document default, `ink` on canvas.
- **Body Long** (400, `18px`, line-height 1.778): the story article, via
  `prose prose-lg`. Beside the rail the column is up to **720px** of measure;
  below the opening spread the body runs **1056px** (`--container-story-wide`).
  `max-w-none` overrides the typography plugin's 65ch cap, so the measure is
  set by the container, not by the prose.
- **Body Small** (400, `14px`, line-height 1.43): excerpts, footer links, nav
  labels, the map CTA.
- **Label** (600 mono, `11px`, `0.18em`, uppercase): the compact identity
  register in the footer logline and gear line.
- **Homepage metadata** (`12px` mono, `0.18em`): the hero entry number and
  date/country field line use weight 600; coordinates use weight 400.
- **Label Quiet** (400 mono, `12px`, `0.18em`, uppercase): story-card dates,
  subordinate to the heading without reducing useful information to microprint.
- **Label Large** (600 mono, `12px`, `0.18em`, uppercase): section eyebrows —
  Key Facts and TOC headings, footer column labels, the map band's stat line,
  the region page's trip count.
- **Destination navigation** (600 mono, `14px`, `0.18em`, uppercase): region
  links are actions rather than metadata; counts and arrows keep their meaning,
  and each link retains a `44px` minimum hit area.

**One register, several jobs.** The 11px mono label carries compact footer
identity; useful homepage metadata and section labels use 12px, and destination
navigation uses 14px, with a weight step (400 against 600).
Extend those roles with a size or a weight when needed — never
a tracking value, and never a coloured plate, which is what the card's date
line used to be.

**Count grammar.** Public DE/EN labels use the singular only for exactly one:
`1 REISE` / `1 TRIP`, `1 LAND` / `1 COUNTRY`, `1 KONTINENT` / `1 CONTINENT`,
`1 Pin-Standort` / `1 pin location`, and `1 Kommentar` / `1 comment`.
The homepage map band, region kicker, map page, About statistics and comment
thread share this rule through `countLabel`; translated forms stay in `ui.ts`.
Zero and two or more use plural labels. Existing empty states take precedence:
the homepage omits its map band without stories, empty regions have no page,
and an empty comment thread says “Noch keine Kommentare.” / “No comments yet.”

**Where the entry number belongs.** `N°09` is a signature mark and it earns
its place where it says something: the homepage hero's entry, where it
introduces the latest story as one of a numbered series. It was also on every
grid card, nine of them down one index, restating an order the grid's own
newest-first sequence already shows, and on the story page, where the reader
has already arrived and the number told them nothing they act on. Spending
the mark where it carries meaning is not a retreat from the identity.

**Equal-date stories keep one order (#377).** `byLocale` orders trip dates
newest first, then the pair's shared `translationKey` ascending by code-point
comparison. Localized titles, slugs and save chronology never decide ties.
The homepage cover (including competing featured stories), its entry number,
home/region grids, previous/next links, footer latest list and RSS share that
rule, so DE and EN retain the same pair order after saves and rebuilds.

### Named Rules

**The One Tracking Rule.** `--tracking-log` (`0.18em`) is the only tracking a
mono uppercase log label may use. It replaced four values scattered across the
tree (0.15 / 0.18 / 0.2 / 0.25em) that were close enough to be arbitrary rather
than a scale, and were applied inconsistently to the same kind of element — the
hero's log plate at 0.18em beside its own coordinate line at 0.15em. An
arbitrary `tracking-[…]` in a component is the drift this token exists to
prevent. Sans uppercase wordmarks are a separate register and keep
`tracking-wide` / `tracking-wider` (0.025em / 0.05em).

## Layout

**Containers.** Three widths, and only three. `max-w-6xl` (**1152px**) is the
site container — nav, footer, home sections, region pages, the map band, and
from `lg` the story page too. `max-w-3xl` (**768px**) is the story column
below `lg`. `max-w-2xl` (**672px**) caps the hero's entry panel so it never
spans a desktop photograph. Every container carries a `20px` gutter (`px-5`),
so the content box locks at 1152px once the viewport passes **1192px** — the
number `story-grid-layout.ts` calls `CONTENT_LOCKED_AT` and uses to emit exact
pixel `sizes`.

**The story spread.** From `lg` a story opens as its first section beside a
rail, and the spread and the body below it share **one measure**:
`--container-story-wide`, `66rem` (1056px), centred in the 1112px content
box — 10% wider at the owner's request (2026-10-19). Inside the spread the
rail is a fixed `18rem`, the gap `3rem`, and the column takes the available
remainder — up to `45rem` (720px) — so the three always sum to the spread
(`--container-story-column` / `--container-story-rail`). The rail holds
the story's furniture — contents, key facts, the route map — open in a stack.
The rail is static by default and sticks `0.5rem` from the viewport top only
when its measured height plus that offset fits the viewport. A ResizeObserver
and viewport resize listener update `data-sticky-fit` as disclosures, fonts,
lazy map content or the viewport change. An oversized rail scrolls with the
page, so its lower facts and map controls remain reachable before the opening
ends, including by keyboard. The stack never scrolls internally: a second
scrollbar beside the page's was the owner's objection. Without JavaScript or
ResizeObserver it stays nonsticky; native disclosures remain usable (initially
collapsed without JavaScript). A rail taller than the opening still sets the
spread's height.
The opening is the body's first section — everything before the first
root-level heading at the shallowest root heading depth that has content in
front of it (`story-opening.ts`), so an intro heading, its paragraphs and its
first photograph sit beside the rail. Headings inside blockquotes or list
items never become cut points or determine that depth: the complete quote or
list stays in the opening, followed by any introductory paragraphs. Stacked
intro headings stay together until there is content before a later heading.
The HTML tree locates original source offsets, without reserializing the
sanitized body; concatenating the two fragments reproduces it exactly. With
no eligible heading, or root heading IDs/depths that disagree with renderer
metadata, the whole body remains the opening rather than guessing a cut.
The rest of the story then runs **centred on the same 1056px**, with
the route divider and pagination on the same measure. Matching the edges
and the owner's requested wider reading area take precedence over a
shorter line measure. The spread wrapper is a
**float** container, not a grid, because the opening is one rendered section
that is not split further, and a wide gallery in it must not run under the
rail: `clear: right` on the wide modes drops such a gallery below the rail.
Below `lg` the spread and rail wrappers are `display: contents`, so the same
three disclosures stack above one continuous article and the sticky contents
strip keeps the whole story as its containing block.
The title block shares the spread's 1056px measure and left edge, but reserves
only the arrival stamp's intrinsic width plus a 3rem gap on the right:
the title uses all remaining space, not just the opening column's width.
The stamp stays top-right above the rail. This is what the WordPress site's opening row was for (intro, facts,
contents and a photograph in the first screen); what it got wrong was setting
the body at the same 1140px, ~140 characters a line.

**The story mosaic.** From `640px`, six columns, `280px` auto-rows and `16px`
gaps. Spans of 3 give two cards per row, spans of 2 give three. Six
lets a remainder of two split evenly. From `lg`, four or more cards
render a 4×2 lead tile with one card stacked beside it in each of the first two
rows, then threes, with the tail levelled — one leftover becomes a full-width
band, two split the row in half. The plan is computed in TypeScript, not CSS,
because the remainder rule depends on how many cards fit a row and that differs
per breakpoint.

**Mobile rhythm.** Below `640px`, one column with `24px` gaps. Photographs use
their stored width and height to render uncropped; captions follow on solid navy
and grow with the full title. A portrait photograph naturally makes a taller
card, while a landscape keeps its breadth. No index-based double-height rule.
The homepage's promoted cover alone gets a compact `96px` thumbnail beside its
caption, wherever it falls in the chronological index. Region pages have no
promoted cover and therefore no compact exception. Every story remains present.

**Breakpoints.** `sm 640px` · `md 768px` · `lg 1024px`. The map band splits
two-up at `lg`, not `md`, because an SVG `font-size` is in viewBox units: at
768px the chart column was ~312px and the axis labels rendered at 7px. Galleries
use **container** queries instead (`900px`, `600px`), because a break-out
gallery is wider than its parent and a media query would measure the wrong box.

**Vertical rhythm.** Home index `48px → 64px` (`py-12 sm:py-16`); map band
`32px → 44px`; footer `56px`; region header `40px`; story body starts with
`20px → 24px` top padding and ends with `40px`. The home hero is natural-height
at base, followed by its paper entry; from `sm` it stays `80vh`, clamped to
`480–720px`. The story photograph is natural-height below `640px` and `36vh`,
clamped to `240–400px`, above it. Its canvas title block follows in normal flow,
with `24px → 32px` above the metadata and no text over the photograph.
The homepage's section order remains photograph → index → map band, whose navy
runs into the footer's navy as one dark base.

**Imagery.** Mobile homepage hero and full-size index photographs preserve the
stored aspect ratio. Their source hints are `100vw` and `calc(100vw - 2.5rem)`
respectively; a fixed-height correction would over-fetch them. Desktop retains
the existing cover crops and their height-aware source hints. The compact cover
thumbnail reuses the photograph already requested by the eager hero.

**Body images.** Known images receive responsive pictures. A figure is reserved
for an image-only top-level paragraph, including one image-only link; the figure
wraps that single sanitized link, never the other way around. Mixed sentences,
consecutive images and nested prose keep bare pictures at their original
positions, with paragraph text and link order intact. Authored pictures retain
their sanitized source choices. This adds no lightbox or stored-content rewrite.

Generated inline pictures receive section-specific source hints before JavaScript
runs. The story loader starts with the full-width envelope; `StoryPage` applies
the final hints after splitting the opening from the remainder:

| Viewport | Opening slot | Remainder slot |
| --- | --- | --- |
| below `48rem` / 768px | `100vw - 2.5rem` | same |
| `48rem` to below `64rem` | `45.5rem` / 728px | same |
| `64rem` to below `68.5rem` | `100vw - 23.5rem` | `100vw - 2.5rem` |
| at least `68.5rem` / 1096px | `45rem` / 720px | `66rem` / 1056px |

About uses its own grid: below `64rem`, `100vw - 2.5rem`; above it,
`(min(100vw, 72rem) - 5.5rem) × 2.2 / 3.2`, capped at 731.5px.
Standalone preview uses `min(100vw, 46rem) - 2.5rem`, capped at 696px.
The rem geometry follows CSS and the shared gallery `COLUMN_WIDTH`; nested prose
may be narrower, so these are containing-column envelopes. Galleries keep their
existing per-row/slider hints, and authored pictures keep their sanitized choices.
No variant URL, format, loading policy or layout changes. An intrinsically small
original still has only its existing no-upscale candidates.

**Break-out.** Below `lg` a wide gallery may exceed the story column to
`min(100% + 24rem, 100vw - 3.5rem, 1112px)` — 24rem is the measured overhang
either side of the 728px narrow-viewport column, and `100vw - 3.5rem` keeps it clear of the
classic scrollbar. It is centred with `margin-inline`, never
`transform: translateX(-50%)`, because a transform would make the gallery a
containing block and trap the lightbox dialog inside it. From `lg` a wide
gallery *in the opening* spans the whole spread (`100cqw` of `.story-spread`,
1056px) from the column's left edge instead — centred on a column that sits
left of centre, it would cross the viewport's left edge. In the centred body
below the spread the default centring holds, and 1056 + 24rem clips to the
full 1112px, overhanging the body by 28px a side. Break-out is opt-in (`#layout: breakout`); the default gallery is
`column`, aligned with the text as the WordPress galleries were.

### Named Rules

**The No-Empty-Cell Rule.** The grid plan must tile exactly at *every* card
count, because the count is "however many stories are published" and it changes
on every Publish. The previous `md:grid-cols-3` with a 2×2 lead tile happened to
tile at 9, 12, 15 … and left a visible **360×240** hole at every other count —
the live homepage was one of them. Extend `storyGridSpans` and its test; never
reintroduce a fixed column count with a spanning tile, and never shrink or drop
a span to make room (`demoteCover` swaps two entries precisely because a swap
preserves the span multiset).

## Elevation & Depth

Flat by default. Depth is carried first by **tonal banding** — canvas page,
navy bands (map teaser, footer), navy cards — and second by texture: contour
lines in the footer, a graticule in the map band. Shadow is not resting
decoration. It appears in exactly two situations: as a **state** (the card's
hover/active ring) or as a **material cue**,
where paper is physically lifted off a photograph (the hero entry panel, the
story page's stamp chip). Nothing else on the public site casts a shadow at rest.

### Shadow Vocabulary

- **Card at rest** (`box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`):
  the story card's only resting elevation — it replaced a card that carried a 1px
  border *and* a wide soft shadow.
- **Chip on photograph** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`):
  the stamp chip on a story opening — paper laid on an image.
- **Card raised** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`):
  the story card under hover **and** `active:`.
- **Panel on photograph** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`):
  the hero entry panel, the deepest shadow in the system and the only instance of it.
- **State ring** (`box-shadow: 0 0 0 2px #d23b30`): the card's hover/active ring.
  Ring and shadow are both `box-shadow`, so one transition entry covers both.
- **Focus ring** (`outline: 2px solid #d23b30; outline-offset: 2px`): not a
  shadow and never animated. One themed ring for every focusable element,
  replacing the four appearances the pages used to ship. On dark bands components
  override the colour with `focus-visible:outline-brand-red-light`.

### Named Rules

**The Declare-Once Rule.** Elevation is declared once per element: border **or**
shadow, never both. A resting shadow must justify itself as material (paper on a
photograph); otherwise elevation is a state. Audit test: if an element has a
visible border at rest and also a resting `shadow-*`, one of them is
decoration — `AboutPage.astro` and `MapPage.astro` still carry
that pairing and are the drift to clear, not the pattern to copy.

**The Ring-Is-A-State Rule.** The hover ring is feedback, not elevation, and it
must be paired with an `active:` twin. Tailwind 4 compiles every `hover:`
utility under `@media (hover: hover)` and `motion-safe:group-hover:` under that
*and* the reduced-motion query, so on a touch device a hover-only card gives the
majority visitor nothing but the browser's default grey flash. `active:` has no
media gate.

## Shapes

**Corners are shallow and squared-off.** Four steps, each with a job.
`4px` is the default and the most common value in the tree: it is what "paper"
gets — the hero entry panel, the stamp chip, the
footer logline plate, the map CTA, and every 44px link hit box. `6px` is for
prose-adjacent panels such as the grid's empty state. Story contents and facts
are flat disclosures, not rounded panels; pagination links use `4px` corners.
`8px` is for photographic and map surfaces (gallery items, body images,
the story mini-map). `12px` belongs to exactly one element,
the story card — the single tile that reads as a framed photograph.

**Fully round is reserved for non-text objects.** Two instances only: the route
divider's `6px` terminals (one filled, one open ring) and the gallery slider's
`44px` circular nav buttons. A text control never wears a pill.

**Borders are hairlines, and dashes are a motif.** Solid hairlines at low alpha
separate structure: `border-navy/10` under the nav and around canvas panels;
`border-white/10` above the footer. Where a border *is* the
control it must clear 3:1 against its composite — the map band's ghost link is
`border-white/50` (≈3.9:1) because `/30` measured **2.64:1**, and the project's
answer for a control hairline on canvas is `navy/55`. Dashed strokes are the
route motif and are used only where something is genuinely being divided or
traced: the `RouteDivider` between story body and
pagination (`border-t-2 border-dashed border-navy/15`), the underline a
destination link grows on hover (`decoration-dashed`), and one of the three
stamp border variants (`stroke-dasharray="5 3"`).

**Silhouettes.** The arrival stamp is either a `124×72` rectangle (Europe — the
Schengen shape) or an `86×86` circle, rotated deterministically between −5° and
+5° inside a square chip, so the ink reads as pressed askew onto straight paper
rather than as a tilted widget. Scrims are linear gradients with named stops,
never blurs or filters.

### Named Rules

**The No-Pill Rule.** Navigation never wears a pill. The destination index was
`rounded-full` pills with a filled active state sitting in the same baseline row
as the section heading under the label "filter by region" — the universal
grammar of an in-page filter, and every part of it was a lie: clicking one
unloaded the document and took the hero and map with it, at the highest-intent
moment on the page. Controls that navigate are set in the log register with a
count and a trailing arrow. If in-place filtering is ever wanted, filter the
rendered cards and keep `/reiseziele/*` as the crawlable href; do not go back to
a control that looks like one thing and behaves like another.

## Components

### Buttons

There is no filled button on the public site except the skip link. The primary
call to action is a **text link with a moving arrow**, and its weight comes from
colour and position, not from a filled shape.

- **Shape:** squared-off (`4px`); hit area is a padded `44px` box, never a glyph box.
- **Primary call ("Read story"):** `brand-red`, 14px semibold, with a 16px arrow
  that translates `4px` on hover under `motion-safe:`. No background, no border.
- **Ghost, on dark (the map band CTA):** transparent on navy, `border-white/50`
  (≈3.9:1 — the border *is* the control), white 14px, `8px 16px` padding.
  Hover moves the border to `brand-red-light` and fills with `brand-red/15`,
  plus a `2px` lift under `motion-safe:`. Focus overrides the ring to
  `brand-red-light`.
- **Skip link:** the one filled button. Invisible until focused, then a
  `brand-red` plate with white 14px semibold text at `8px 16px`. It keeps the
  standard focus ring — the plate is the reveal, the ring is still the ring.
- **Focus:** every control takes the one system ring (`2px solid #d23b30`,
  `2px` offset). Transitions name their properties explicitly
  (`transition-[color]`, `transition-[color,background-color,border-color,translate]`).

### Chips

One plate, and it is not a chip in the filter sense — it is a label.

- **Footer logline plate:** solid `navy`, `brand-red-light` over white,
  `6px 10px`. It carries both the logline and the camera gear line in one register.

The story card used to carry two more — a bordered navy plate around its date
line and a solid `brand-red` cover-story kicker, both stacked above the
heading. Both are gone; see Story card below, and do not reintroduce either.

### Journeys

The journey is a reading surface, not a second homepage. Its opening pairs a bounded
photograph with a paper title and plain-text introduction; below desktop they stack.
The ordered stories remain primary: existing photographic StoryCards, with an explicit
“Story n of m” register outside each card. The count and order include only public
stories in the reader's locale. A flat photographic index exists only in live locales.

The overview follows the list, with numbered 44px keyboard-link pins and independently
drawn public GPS runs on the existing self-hosted chart. A visible discontinuity note,
every member link and per-run public summaries remain outside the JavaScript surface.
No inferred connecting lines, journey-wide distance, stops or new color language.

A member story gains one quiet, dashed-rule journey strip after its reading/gallery
surface and before comments. Its landmark names the journey distinctly; its text links
step through visible members only. There are no thumbnails and no changes to the
chronological StoryPagination below. Non-member pages gain no strip or navigation.

### Cards / Containers

- **Story card** — a whole-tile link with navy body and `12px` corners.
  Below `640px`, the photograph is uncropped and followed by a solid navy caption
  with `16px` padding. Mobile titles are not clamped. The homepage's promoted
  cover alone becomes a thumbnail-and-title index row.
  - *Mosaic captions:* from `sm`, every tile fills with its photograph and
    overlays its caption, as the lead always did: a **40px** ramp
    (`from-navy/92 to-transparent`, no type in it) meets a `navy/92` base with
    `16px` padding. The double-height lead at `lg` keeps its longer **72px**
    ramp and `20px` side padding. Translucent small-tile captions are an owner
    request (2026-10-18); before it, small tiles stacked a solid caption row
    below the photo.
  - *Why the captions use 92 and not 100:* it is the floor, not a preference. White measures
    **11.6:1** on it and `white/70` **6.57:1** over the brightest sky in the
    corpus; at `/80` that second figure is 4.66:1 and at `/75` it is 4.07:1,
    i.e. under AA. The caption could only be lighter by giving up the date
    line. It could not be translucent at all while the card still carried a
    `brand-red-light` marker, which needs solid navy and misses AA at `/98`
    over a bright sky — removing that marker is what bought the transparency.
  - *Why the ramp is a fixed length:* a percentage scales with the title's line
    count, so the one distance guaranteeing that type never lands in the fade
    would differ per card.
  - *Date line:* the month and year, plus the country whenever one is set.
    It is never suppressed by the title — titles should not lead with the
    country, since the date line already carries it. Weight 400 at `12px` in
    `white/70`, below the heading, no box. It wraps rather than truncates:
    `truncate` here cut the destination country, the identity payload the card
    exists to deliver, on 3 of 9 cards at a 320px viewport.
  - *No entry number, no cover marker.* Nine `N°` labels down one index
    restated an order the newest-first grid already shows, and the cover marker
    put a second coloured object on the one card that least needed decorating.
    The `N°` now leads the homepage hero alone.
  - *No card-height scrim.* There used to be one (`from-navy/90 via-navy/35
    via-55%`) serving the title. It cannot serve it any more: with the date
    line below the heading the title's top sits around 46% of the card, where
    that gradient is near its weakest — re-derived against the same pale Rhodes
    sky, white lands at **2.87:1** there. Holding it would take roughly `/62`
    at the midpoint, veiling the lower half of every photograph and blurrier
    than the ramp.
  - *Sizing:* mobile height follows the photo and caption, not fixed tracks.
    From `sm`, the tile is `280px` per row, the photograph fills it, and
    `cardSizes` emits `max(boxWidth, boxHeight × 1.5)` as the source hint.
  - *Shadow strategy:* see Elevation — `shadow-sm` at rest, `shadow-xl` plus a
    `2px brand-red` ring on **hover and `active:`**, over `500ms`.
  - *Motion:* `transition-[transform,translate,box-shadow]`. `translate` is
    load-bearing: Tailwind 4 compiles `-translate-y-1` to the `translate`
    property, so a list of `transform,box-shadow` transitioned nothing and the
    4px lift landed in a single frame (measured final at 50ms) beside a 500ms
    ring fade. From `sm`, the photograph scales to `1.04` under `motion-safe:`.
  - *Image:* no resting `opacity`. An earlier card mixed 10% navy into every
    photograph and lifted it only on `group-hover` — a state a touch device
    cannot enter.
- **Grid empty state:** a canvas panel with a navy hairline and shallow corners.
- **Story contents:** a native disclosure with an opaque canvas background and
  horizontal rules. Below `lg` it starts collapsed and stays `8px` from the
  viewport top while the article is in view, then leaves with the reading
  section; the expanded list scrolls internally; selecting a section closes
  the list, focuses the heading and preserves native fragment/history
  navigation, and Escape returns focus to the summary. In the rail (`lg`) it
  starts open, is static and fully expanded, flush with the disclosures under
  it, and a section link focuses the heading without closing anything. Crossing
  the `64rem` boundary without a reload resets all three rail disclosures:
  Contents, Key Facts and Route map close below it and open at or above it.
  Resizing within either layout preserves the reader's manual toggles. A
  real published DE/EN story with 20 contents entries confirmed this through
  repeated 1180×820 ↔ 820×1180 rotations and the exact 1023/1024px boundary;
  the collapsed mobile strip measured `47px` high at `top: 8px` while scrolling,
  with keyboard section focus and Escape-to-summary preserved. Summary
  and links have at least `44px` targets. Without JavaScript the links still
  work and heading margins clear the expanded strip; the rail simply starts
  collapsed.
- **Key Facts:** an optional native disclosure with a bottom rule, not a
  bordered-and-shadowed card. Full key/value pairs wrap in one mobile column,
  two columns from `640px`, and one again in the rail; no facts are removed or
  rewritten.
- **Route map:** the story's mini-map is the third disclosure, in the same
  dress as Key Facts. It mounts lazily on intersection, which a closed
  disclosure never reports — opening it is what mounts the map.
  WebGL2 is probed before MapLibre construction and checked again on its real
  canvas. If either fails, no empty focusable canvas survives: trackless stories
  retain their localized map link at its natural height; tracked stories hide
  the empty map slot and retain the published route summary, endpoints, stops
  and map link. On the full map page, initialization failure hides the entire
  map wrapper (including its `70vh` allocation), leaving the story-link list.
- **Story pagination:** chronological links with `80px` square, lazy-loaded
  photo thumbnails and full wrapped titles. A sole link spans the reading
  column; two split from `768px`. No empty placeholder cell, border or shadow;
  underline and color carry hover/active feedback.

### Story Opening

`StoryHero.astro` owns the photograph, title, field line, arrival stamp and
optional translation link. The photograph leads; every word sits on canvas
below it at every width. The field line is one mono log entry: date · country
at weight 600, then the coordinates at weight 400 beside them — the measurement
next to its label, both at `navy/70`. No entry number: on the story page it
only ever said "sixth story published", which no reader navigates by, and
with the coordinates on the same line it would have crowded the entry. The
homepage hero keeps it. The translation link is a secondary action in the
site's link register: 14px medium navy on canvas (**14.114:1**), with the red
accent reserved for hover and active states; its 44px hit box and arrow
remain. Below `lg` the title and body share the `768px` container with `20px`
gutters and the stamp sits beside the translation link. From `lg` the block
shares the spread's measure, with the text filling the space left of the
stamp's intrinsic-width grid column — one element, two grid placements, no
duplicate markup. Responsive source hints account for the photograph's actual
aspect ratio when desktop cover cropping needs a wider source. Mobile retains
the whole frame, including portrait photographs. No title clamp or
photographic scrim.

The photograph can be an independently selected **title image**, with its own alt text
and focal point. If absent, the existing hero is used. This does not alter the opening's
geometry or introduce text over the photograph; homepage covers, cards, pagination and
social images keep the hero. Selection is per locale in the editor's existing inspector,
using the same media picker and framing controls rather than a new visual pattern; like
the hero, it is chosen from the library only (#569).

Story openings and About use one 3rem, extra-bold red drop cap on the article's
first **direct-child paragraph**. A preceding heading does not suppress it.
Quoted paragraphs, loose-list paragraphs, later direct paragraphs and the
story-rest article keep their ordinary body-size initials; nested prose never
starts another decorative opening.

### Navigation

- **Header:** canvas with a `border-navy/10` underline, `1152px` container,
  `20px` gutters, very low vertical padding (`4px → 8px`). The wordmark is 14px
  extrabold uppercase navy at `tracking-wide`.
- **Links:** 14px medium, `ink` at 80%, `8px` horizontal padding inside a
  `44px`-tall box, `transition-[color]` only. Hover and active are both
  `brand-red`; active adds semibold and `aria-current="page"`.
- **Mobile:** the nav wraps to its own line below `sm`. The German labels are
  ~40px wider than the English ones and a single-row header measured a
  `scrollWidth` of **415** against a **390px** viewport — the page scrolled
  sideways and the language switcher sat off-screen, in the default locale.
- **Language switcher:** 12px semibold uppercase, `44×44` targets, separated by
  a drawn 1px rule (not a "|" glyph). The current locale is marked with a `2px`
  `brand-red` bottom border on a square-cornered box, so it reads as one straight
  rule — a different *kind* of signal, not a darker shade — and the outgoing
  link is `ink/70` (**5.97:1**; `/60` was 4.33:1).
- **Language switcher per mode** (`site/src/components/LangSwitcher.astro`, fed by
  `siteLanguage()` from `site/src/lib/site-language.ts`; `site/src/components/language-render.test.ts`
  and `site/test/built/routes.test.ts` pin it). The install's mode is
  `{ primary, locales }`, with `locales` always ordered primary first:
  - **DE+EN, DE-primary** (`{ primary: 'de', locales: ['de','en'] }`, simonswanderlust.com):
    renders `DE | EN` in that order, unchanged. DE lives at root, EN under `/en/`.
  - **DE+EN, EN-primary** (`{ primary: 'en', locales: ['en','de'] }`): renders `EN | DE` — the
    order follows the primary, so the root language is always the first item. EN lives at root,
    DE under `/de/`.
  - **DE-only** and **EN-only** (`locales.length === 1`): the switcher is **not rendered at all**
    — no empty box, no lone current-locale marker. The header simply ends with the nav links.
    Nothing on any page links to the absent locale's prefix.
  - In both bilingual modes the current locale is the `aria-current` box with the brand
    underline; the other locale is a link carrying `hreflang` and an accessible name in the
    reader's language (`nav.viewInGerman` / `nav.viewInEnglish`). Its `href` is the page's
    counterpart when one is built (`alternates` from `Base.astro` — fixed pages via
    `localeAlternates`, stories via `translationOf`, regions only when both sides exist) and
    otherwise the other locale's **home** (`homePath(other)`), so an untranslated story or an
    empty translated region never advertises a page that does not exist. `hreflang` /
    `x-default` link elements and `og:locale:alternate` are emitted on the same condition — a
    built counterpart — with `x-default` pointing at the primary locale's URL.
- **Destination index** (`RegionFilter`): navigation set in the log register —
  14px mono uppercase navy, a `brand-red` `tabular-nums` count, and a 12px arrow
  at `navy/55` that turns red and slides `2px` on hover. Hover adds a **dashed**
  underline at `4px` offset. The current region is not a link to itself: it is
  `brand-red`, arrow-less, and carries `aria-current`. See The No-Pill Rule.
- **Footer:** navy with a contour texture, a three-column grid from `md`
  (`2.2fr 1fr 1fr`), `32px` vertical padding (`40px` from `md`) and `24px` row
  gaps when stacked. Every secondary colour is `/70` or heavier — a floor, not a
  preference. Links are `44px`-tall boxes and focus with the light accent ring.
- **Configurable links:** the approved ordered header/footer/legal lists retain
  this typography and target sizing. Labels wrap rather than overflow. Only builtin
  and page targets receive `aria-current`; external links show an arrow and localized
  new-tab description. Footer social links remain a separate, unchanged list.
- **Basic pages:** Contact/Privacy/Legal use a restrained prose column, one title and
  the existing sanitized gallery island. No invented legal text, forms, comment
  surface or story-specific rail is introduced. About keeps its incumbent layout.

### Featured Hero (signature)

Below `640px`, a full-width photograph at its natural aspect ratio, followed by
the paper entry in document flow. The title never overlays the mobile image.
From `sm`, the existing `80vh` cover (clamped to `480–720px`) retains its vignette
and overlaid paper entry.

- **Entry panel:** canvas, capped at `672px`. Mobile uses the page's `20px`
  gutters and `24px` vertical spacing, without a floating shadow, and stays
  opaque. From `sm`, the panel is `canvas/85` over the photograph (no blur),
  with `4px` corners, `24px` padding and the system's deepest shadow. Inside:
  the tagline as a visually hidden `<h1>` (it is the page's only one; the
  wordmark in the header already names the site), then one link wrapping the
  whole entry — mono field line (`N°` in red, date · country at `navy/70`),
  display title, coordinates, a two-line excerpt, and the red call with its
  arrow. No masthead, no dashed rule, and no stamp on the homepage hero: all
  three were removed (2026-10-18) to give the photograph the space.
- **Vignette:** desktop only, `from-navy/45 via-navy/10 via-40% to-transparent`.
  It seats the paper on the frame and closes the bottom crop, not text contrast.
  Alpha above this is photograph thrown away on a page whose premise is the
  photograph.

### Arrival Stamp (signature)

A drawn SVG passport stamp: country name on a `textPath` arc (circle) or in a
straight line (rectangle), a country-code roundel, a hand-authored plane glyph
(never the `✈` character — a platform emoji font is not an icon system), and the
date in 800-weight mono. Ink, border style (single / double / dashed) and
rotation are hashed from the country code, so a country always stamps the same
way. `mix-blend-mode: multiply` at full opacity on an opaque canvas chip; the
chip stays square while the ink is rotated.

The date is the stored trip's **calendar date**, not a UTC instant: `Stamp.astro`
reads local day/month/year, matching the loader's local-midnight convention and
the hero/card date formatters. Do not use UTC getters here. Runtime rebuilds via
the app's `/rebuild` endpoint were verified in UTC, Europe/Zurich and
America/Los_Angeles with unchanged `2024-01-01` and `2024-03-01` synthetic
published stories: both DE and EN stamps retain `01 01 2024` and `01 03 2024`
respectively (#400).

### Route Divider (signature)

Filled `brand-red` dot → dashed 2px navy rule → a 16px compass arrow at
`ink/40` → dashed rule → open `brand-red` ring on canvas. `aria-hidden`.
Used where two genuinely different kinds of thing meet: between a story's body
and its pagination. It
was removed from the homepage because one dashed rule between two sections that
already meet at a hard canvas/navy edge is a motif asserting itself rather than
dividing anything.

### Map Band (signature)

Navy band, `1152px` container, two-up from `lg`. The chart is a real projection:
land as a `fill-opacity: 0.14` silhouette *under* the graticule, primary
meridians and parallels at `opacity 0.34` solid and secondaries at `0.14`
dashed `4 6`, pins as a `brand-red-light` dot (`r 4.5`) inside an 11-unit ring. The
chart is fitted to a `2.2:1` window. Degree labels
are informative text, so they are 600-weight mono with opaque `#d0d4d9` fill and
a navy `paint-order: stroke fill` halo — the label casts its own plate and
measures **9.8:1** wherever it lands. At `opacity: 0.8` the same label fell to a
**6.70** median over the silhouette and **2.40:1** where a coastline ran behind
a glyph.

### Galleries (signature)

Hand-written CSS classes, not utilities, because the draft preview inlines its
own copy and the justified layout drives per-photo flex ratios from computed
custom properties. Three modes: justified rows at break-out or column width, and
a cropping slider. Photos take `8px` corners and captions are 12.8px at
`#4a5563`. Row *membership* is fixed at build time for a 1112px or 1056px
container; only justification within a row is fluid.

**A gallery is a square.** Rows are cut so the block stacks as close to as tall
as it is wide as a contiguous, order-preserving split allows: the row count is
whichever lands nearest the width, and within that count the rows are the most
even (`gallery-layout.ts`, a small DP). Every row fills the width — there is no
ragged remainder, and two landscapes stack rather than sit as a wide, short
pair. The square yields to a floor: no row of two or more photos may be shorter
than **168px** at design width (up to four landscapes a row in either mode),
so a 37-photo gallery grows taller than it is wide instead of
becoming a contact sheet. The one cap left is on a row that would stand taller
than the square — a lone portrait — held at the square's own height as a
**percentage** of the container so it scales with it.

Every gallery photo link is named in the server-rendered HTML: a nonblank image
alt supplies its native name; otherwise use the resolved visible caption, then
the localized “Open photo {current} of {total}” action. Hidden or deliberately
cleared captions are not exposed through a name. Decorative `alt=""` stays
decorative; no photo description is invented. Numbering counts accepted photos,
continues across rows and resets per gallery. The names work without JavaScript
and in the script-free preview; the lightbox leaves them intact.

**Lightbox dismissal follows the visible content, not its containers.** In all
three modes, clicking or tapping the dark space around a photo closes the native
dialog, even when that space hit-tests to its full-viewport figure. Only the
photo, caption and controls are excluded from backdrop dismissal — never the
whole figure or frame. Photo and caption clicks keep it open; arrows navigate;
Close and Escape dismiss and return focus to the gallery link.

## Do's and Don'ts

### Do:

- **Do** give type its own plate wherever it meets a photograph — navy under
  white, canvas under dark ink — and let the scrim stay light
  (`FeaturedHero.astro`, `StoryCard.astro`, `Footer.astro`). Translucency only
  at a measured, test-pinned floor.
- **Do** measure contrast against the composited pixel and add the pairing to
  `site/src/styles/tokens.test.ts`. If a pinned ratio moves, the token is wrong,
  not the threshold.
- **Do** use `brand-red` on canvas (4.609:1) and `brand-red-light` on navy
  (4.741:1). They are two tokens because one of them fails on the other's ground.
- **Do** declare elevation once: `border-navy/10` **or** a `shadow-*`, never both
  at rest.
- **Do** pair every `hover:` affordance with an `active:` twin — Tailwind 4 gates
  `hover:` behind `@media (hover: hover)`, so a touch visitor sees none of it.
- **Do** name transition properties explicitly (`transition-[color]`,
  `transition-[transform,translate,box-shadow]`), and include `translate`
  whenever `-translate-y-*` is animated.
- **Do** keep every interactive target a padded `min-h-[44px]` box (WCAG 2.2 SC
  2.5.8) — nine controls on the homepage were once under 24×24.
- **Do** set every mono uppercase label with `tracking-log` (0.18em).
  `KeyFacts.astro` retains `tracking-wider` on fact keys; other story metadata
  and pagination use the shared log register.
- **Do** re-derive both `object-fit: cover` branches when touching a `sizes`
  string — width leads above 3:2, `height × 1.5` below it.
- **Do** extend `storyGridSpans` and its test when changing the mosaic, so the
  plan still tiles at every card count.

### Don't:

- **Don't** thin a plate below its measured floor, and never add a backdrop
  blur. The stamp on a `bg-navy/60` blurred plate measured **1.28:1 to
  2.58:1**; on the opaque canvas chip the same inks are **5.49:1 to 16.5:1**.
- **Don't** stack an opacity utility on an alpha text colour. `text-ink/70` under
  `opacity-70` is α 0.49 and **3.14:1** on canvas — it shipped for a release
  because the active item beside it happened to be safe.
- **Don't** trust a token's alpha as a contrast figure. `border-navy/45`
  composites to **2.67:1**; the project's control hairline on canvas is
  `navy/55`, and `border-white/30` on navy was **2.64:1** where `/50` is ≈3.9:1.
- **Don't** let a transition touch `outline`. `transition-all` interpolated
  `outline-width`/`-color` into a 1.5px ink line for the first ~0.5s of a focus
  ring, and Tailwind 4's `transition-colors` includes `outline-color`, which
  animated the ring from `currentColor`. Story pagination now transitions color
  only under `motion-safe`; focus outlines never transition.
- **Don't** put `content-visibility: auto` on the card grid. It implies
  `contain: paint`, and the grid has no padding, so the `2px` focus ring at
  `2px` offset would be sliced off every edge card (WCAG 2.4.7). It is safe in
  the footer only because `px-5 py-8` keeps every ring inside the containment box.
- **Don't** rely on `hover:` alone for feedback, and never use a resting
  `opacity` on a photograph that only lifts on hover.
- **Don't** reintroduce the generic travel-blog hero: full-bleed photo, eyebrow,
  extrabold headline and a filled pill CTA straight on the image. The entry sits
  on paper.
- **Don't** make destination links pills again, or give any navigation control
  the grammar of an in-page filter when it loads a new document.
- **Don't** introduce glassmorphism, bento grids, or a dark-by-default theme
  (`CLAUDE.md`).
- **Don't** add a stamp ink, soften the canvas, or warm the red without running
  `tokens.test.ts` — these pairings clear AA by 0.109 to 0.263 of a point.
- **Don't** dim informative text toward its background: the map band's degree
  labels are opaque with a halo, never `opacity`-faded onto the chart.
- **Don't** truncate identity payload. `truncate` on the card meta cut the
  destination country on 3 of 9 cards at 320px; plates wrap instead.
- **Don't** fix a grid remainder by hardcoding a column count with a spanning
  tile — that left a **360×240** hole on the live homepage.

## Admin authoring: Wanderlust Studio

The approved **Editorial desk** direction (UI mockup 2, based on the owner's CompendiQ
reference) governs the shared admin shell and Posts list. It is a light operating UI:
quiet gray navigation, a white workspace, compact rows, and steel-blue navigation and
New post accents. The public blog's expedition identity is unchanged. Self-hosted
Inter/IBM Plex Mono remain; the shell and login identify the workspace as **Wanderlust
Studio**, with **Simon's travel journal** as the descriptor.

**Writing-first Desk (2026-11-06).** Keep New post in the header after authenticated language
context resolves, even with a recent draft or unavailable publication observations. Continue
editing leads the populated writing section; the header's New post becomes an outlined command.
The empty section says Start writing. Backup-off advice sits above writing with its Settings
link; it remains admin-only and does not infer a backup state from a failed read.

Publication has its own heading and read-only Refresh. Empty newer-draft lists remain compact;
the attention subsection appears only for actual attention rows or unavailable observations.
An admin overview lists nonzero story/media categories without adding overlapping counts.
Only a complete, known, nonnegative-count observation can report no known differences; missing,
malformed, unknown and no-release observations retain explicit uncertainty. Native Publication
details discloses exact build/release history, all counts, rebuild scope, the confirmed action
and its outcome without resetting open state on refresh. Running, failed, interrupted or
unavailable build evidence remains outside the disclosure. Photo processing and live-site access
stay independent below it. No refresh or disclosure triggers a write.

Desk commands and standalone live-site links have 44px minimum targets. A missing/broken draft
thumbnail does not reserve a blank panel; phone thumbnails are bounded so writing remains
reachable. The Editorial desk palette, shell, role boundaries, publication observations and
rebuild semantics are unchanged.

**First-run checklist (#279).** Preserve the incumbent Desk and its independent draft,
photo-queue and live-site sections. Only an eligible admin sees the compact checklist above
them; the shared protected-page context resolves first, and authors retain ordinary
upload/draft-authoring empty states without identity/settings/Publish affordances.
Upgraded/restored installations never gain a retroactive setup wizard.

The progress rows remain Account (informational), Name your blog (**Optional**), Photo, Story and
Publish. Completion is **three required steps**, not five: identity follows an explicit
Settings save and never gates Finish or Publish. An optional **Language** configuration section
sits after Account, with four native radio choices, URL consequences and explicit Save/confirmation.
It shows current stored configuration, never a completion badge or remembered acknowledgement.
Publication history makes this section read-only; Settings still owns allowed secondary activation.
Changed selection alone writes nothing, and ambiguous outcomes trigger a read, not a replay.
Each progress row links into the existing Media, Settings identity tab or editor; no sample,
pre-created draft or automatic upload/publication. Text/icons accompany colour; photo precedence
is ready, processing, failed/missing, then empty. Regressions are truthful until explicit permanent
Finish; completing a publish does not finish the checklist.

**Hide checklist** applies install-wide across admins, sessions and restarts. The only reopen
affordance is **Show setup checklist** in the Desk header, not Settings/navigation. Show
focuses the checklist heading. A hidden complete checklist remains hidden. **Finish** requires
the three current required predicates, confirms permanent removal, and removes both checklist
and Show; later content regressions do not reopen it. Ordinary empty states remain useful.
Loading/unavailable states are explicit, with read-only Retry and visible keyboard focus;
after an uncertain action acknowledgement reload state instead of replaying the mutation.
The checklist uses the existing responsive control vocabulary, wrapping at 320px rather than
creating a second shell. Authentication-context failures are unavailable, not automatic logout.

**Ordinary empty states (#280).** These remain independent of checklist eligibility,
dismissal and retirement. Desk offers a private draft without assuming two active
languages; Posts keeps its existing New post action. Media distinguishes an empty
library from a narrowed view, offers the existing photo picker to authors and admins,
and lets a narrowed view return to all photos without creating content. Its explanatory
status and actions sit outside the photo listbox; a populated grid is unchanged.
Comments retains its announced Pending/Approved empty result and moderation explanation:
having no comments needs no setup action. Users cannot legitimately have an empty
authenticated list (first-admin setup precedes access), while Import's idle state is
the existing export-file chooser, not a second onboarding workflow.

Phone acceptance targets current-stable iOS Safari and Android Chrome under the
[approved measured matrix and manual audit](docs/superpowers/specs/2026-10-27-mobile-acceptance-matrix-design.md),
run with the [G5 device script](docs/superpowers/plans/2026-11-01-issue-300-device-test-script.md).
Physical-device execution remains blocked; this records the target, not a passed qualification.

Admin tokens live on `:root` in `uploader/public/admin.css`, so the shell, the login page
and the `<dialog>`s appended to `<body>` share one set:

| Role | Token | Value |
|---|---|---|
| Surrounding canvas | `--canvas` | `#f5f6f7` |
| Structural navy | `--navy` | `#263b51` |
| Body text | `--ink` | `#202630` |
| Secondary text | `--muted` | `#626974` |
| Dividers | `--line` | `#e7e9ec` |
| Strong dividers | `--line-strong` | `#d6dbe1` |
| Form boundaries | `--line-control` | `#858c95` |
| Active navigation / New post | `--studio-accent` | `#416486` |
| Active navigation surface | `--studio-accent-soft` | `#eaf0f6` |
| Live-site mutation / destructive | `--red` / `--red-hover` | `#d23b30` / `#ac2a21` |
| Control height (small) | `--control-h` (`--control-h-sm`) | `2.25rem` (`1.875rem`); both `2.75rem` on coarse pointers, except command bars (below) |
| Focus ring | `--focus-ring` | `2px solid var(--studio-accent)` |
| Corner radius | `--radius-sm` / `--control-radius` / `--radius-lg` / `--radius-xl` | `0.375rem` / `0.5rem` / `0.625rem` / `0.875rem` |
| Status badge pairs | `--status-ok-*` / `--status-idle-*` / `--status-warn-*` (`-bg`, `-ink`) | Live / Draft / needs-attention pills and chips |
| Stacking | `--z-raised` … `--z-skip` | one ordered scale; no literal `z-index` outside it |

**Command bars keep one compact height (owner decision, 2026-11-10).** The command bar of
the story, journey and page editor — back link, locale tabs, Save draft, Publish, preview,
More actions, Details — is `2rem` (32px) on every pointer, touch included. The masthead's
menu button is `2.25rem` and the editor's live re-check icon `1.625rem`. These do not take
the coarse-pointer `2.75rem`; every other control does. WCAG 2.1 AA has no target-size
criterion (2.5.5 is AAA), so the accessibility commitment in `PRODUCT.md` is unaffected.

**One control vocabulary.** Every page uses the same primitives; page CSS only places them.

- **Labels** sit above their field in the body face (13px, 600, ink) — the old mono
  uppercase labels are gone from the admin. The exception is a **filter menu**, whose
  caption sits inside its trigger (below). A checkbox sits beside its label
  (`.check-field`), and its help text indents under the label. A label that names a
  language appends the code in parentheses — Excerpt (DE), Permalink (EN), Tagline (DE) —
  never the language name; only the locale tabs spell the language out.
- **Story details section titles are the one uppercase register** (owner decision,
  2026-11-10). Every section title in the inspector — Hero image, Key facts, Title image,
  Expedition details, Route along stops, GPX route, Taxonomy, Revisions — and the locale
  heading above them is uppercase, 13px/700, tracked 0.05em, in the body face. The status
  line under a title ("1 Oct 2026 · RO · Europe · 1 stop", "Missing date") stays sentence
  case.
- **Inputs, selects, textareas, file inputs, and checkboxes/radios** follow the **Tinted
  Paper & Capsules (3B)** treatment across the admin: translucent paper wells (`#f6f8fa` on
  white/frosted surfaces, `rgb(255 255 255 / 0.76)` inside the tinted Story details rail)
  with `--radius-lg` top corners, a `1px` perimeter hairline, and a `1.5px` bottom ledger
  rule that lifts to `--surface` and `--studio-accent` on focus; selects draw their own
  accent chevron and file inputs use a dashed bottom rule with a `--radius-lg` picker button.
  Custom checkboxes (`var(--radius-sm)`) and radios (`50%`) use `--studio-accent` when
  checked and preserve native rendering under `forced-colors: active`.
- **Filter menus** (`admin-select.js`, #566; Posts only so far) replace a list filter's
  native popup with an in-label trigger — `Status: All`, caption in muted 500, value in
  ink — at the field height and radius, with the menus' drawn chevron. A filter set away
  from its default reads in `--studio-accent-hover` at 600 with an accent border. The panel
  is the row-menu panel (`--surface`, `--menu-shadow`); the selected option carries a drawn
  check and 600 weight, the active one a soft fill plus an inset accent outline. It is an
  APG select-only combobox over a hidden native `<select>`, which stays the source of truth
  and receives `input` + `change`. Spec:
  `docs/superpowers/specs/2026-11-11-issue-566-posts-bulk-bar-filters-design.md`.
- **Posts bulk actions float** in a bar fixed at the foot of the workspace (never over the
  sidebar), centred, `--menu-shadow`, and translucent at a measured floor: `--surface` at
  95%, never blurred (ink 13.61:1, accent 5.54:1, outlined-button border 3.04:1 over a black
  thumbnail). Its runway is reserved after the list and never shrinks, so selecting or
  unticking never moves a row; Clear selection scrolls only when no checkbox is in view, to
  keep focus visible. Row checkboxes fade in on row hover and stay visible when
  focused, checked, while anything is selected, and wherever there is no hover. Media's
  bulk bar stays in flow.
- **Buttons** use `--radius-lg` (`0.5rem`) across all four roles: the unclassed button is the one
  navy primary per form or section (Save, Add user, Import, Sign in); `.btn-secondary` is
  outlined and auxiliary (Test connection, Insert image, Review story, Cancel); `.btn-remove`
  is outlined red for destructive row actions (a destructive *confirm* in the dialog is
  filled red); `.btn-primary` / `.btn-publish` / `.btn-primary-publish` are the filled red
  Publish and Rebuild. `.btn-new` is the accent command link (New post, New journey). Command
  bar actions (Back, Save draft, More actions), row Edit/More triggers, and masthead ghost
  links share the same `--radius-lg` radius; inline text-link buttons (`.btn-link`, `.provider-action`),
  navigation/tab items, and menu panel items remain flat. Form actions sit in one
  `.form-actions` row, primary first; dense rows (bulk bars, folder actions, revisions,
  comment moderation) use the small height. In an editor command bar **Save draft** is the
  outlined `.commandbar__save` and Publish the one filled action; a page that is already live
  shows the red **Save & rebuild** instead, because that save is a live-site mutation.
- **Red means the live site or a loss.** A confirmation's action button is filled red only
  for a live-site mutation (Publish, Rebuild, a save that rebuilds) or a destructive action;
  every other confirmation (Restore a local draft, Reload saved values, Discard form edits)
  uses the navy primary. A destructive confirmation opens with focus on **Cancel**, so
  Enter never deletes; a typed confirmation focuses its field. No admin flow uses the
  browser's own `prompt()` or `confirm()`.
- **Errors** are one inline pattern: a red `.field-error` sentence directly under the
  field it concerns, the field marked `aria-invalid` and described by it, focus moved to
  the field. The sentence names the problem and the limit or remedy ("Site name can be at
  most 60 characters"). Messages that concern no single field use the page's `.err` line.
  Server refusals are shown as sentences, never as raw lowercase codes.
- **Dates and counts** have one format: `10 Nov 2026` for a date and `10 Nov 2026, 08:43`
  for a moment (`AdminFormat.date` / `.dateTime`), in lists, status lines, confirmations
  and prompts alike; counts pluralise ("1 photo", "3 photos"). Measurements — coordinates,
  dates in fields, pixel sizes, country codes, keys, slugs' site prefix — are set in mono.
- **One object, one word.** A blog entry is a **story** in every sentence the author
  reads (the navigation and its list keep the name **Posts**, and **New post** stays the
  command). Destroying something is **Delete**; **Remove** is only for taking an item out
  of a list that keeps existing elsewhere (a link from navigation, a story from a journey,
  a photo from a gallery).
- **Confirmations** require fresh consent for each opening. Escape, Cancel, and a
  result-less `close()` never reuse an earlier acceptance; a typed confirmation also
  requires the current prompt's exact token.
- **Outcomes** are two plain sentences in the page's status line: what was done, then what
  the live site does now with the build moment ("Published. The live site is serving this
  version (built 10 Nov 2026, 08:43)."). No release ids or pipeline words reach the author.
  **Published** is what the author asked for; **Live** is what the site was last observed
  serving. A page that navigates away after a delete carries its outcome to the list
  (`AdminFlash`), where it is shown once.
- **Focus after an action** never falls to the page. A save, moderation or rebuild returns
  it to the control that started it (`AdminFocus.hold`). A row that leaves a list hands it
  to the next row's first action, else the previous row's, else the list's create command
  (Posts, Comments, Users, Media tiles); a deleted page hands it to that row's **Create**.
  The phone drawer is focusable the moment it opens.
- **Row actions** are direct buttons; a **More actions** menu exists only where a row has
  two or more secondary actions (a published story), never for one (a draft's **Delete**).
  A repeating row uses one control kind: Navigation rows are **Edit link** (a disclosure
  button with `aria-expanded`), Move up, Move down, **Remove link**. In-page jumps
  (Site & backups) are `.action-link`s, not buttons.
- **Conflicts** compare field by field — Field / Yours / Stored, differing fields only,
  the resolving actions first — and keep the raw evidence under **Technical details**.
  Values the server filled in for an empty draft are not differences.
- **Sections** inside the white workspace are flat: stacked `.card`s divide by a hairline
  (`--line`), never as cards inside the workspace card. A `fieldset` only groups controls
  for disabling and naming and never draws a box. Simple form pages (Users, Import)
  keep fields at a `34rem` measure; a list page leads with its list (Users shows existing
  accounts before Add a user, with Reload as a secondary button).
- **Help** is one short line beside the control it explains. Background and caveats sit
  in a `.help-details` disclosure ("How importing works", "What a full recovery needs");
  a consequence the author must see before acting ("discards your edits to them") and a
  privacy disclosure stay visible, after the controls rather than above them.
- **Menus and disclosures** share one shape: outlined trigger with a drawn chevron and a
  floating panel (the editor's More actions, the Posts row's admin-only More actions, the
  Posts filter menus, Review selection in the floating bulk bar); inline disclosures
  (alt-text review, picker folders, help details) use the same chevron in place of the UA
  triangle. A floating panel closes like a menu: Escape returns focus to its trigger, and a
  click outside it dismisses it.
- **Advisories** that never block anything (the editor's alt-text review before a publish)
  use the neutral `.notice-info`; `.notice-warn` is for results with a consequence (a live
  story missing alt text, backups off, an incomplete import).
- **Locale tabs** are one segmented control in the story, journey and page editor,
  labelled in each language's own name (Deutsch, English). The code beside the name is a
  language chip that carries that locale's state, so the pair reads at a glance without
  opening the other tab.
- **Language chips** (`.lang-chip`) are the one DE/EN indicator, on Posts rows, Pages rows,
  Journeys rows and inside every locale tab. Four states, each with a non-colour cue and an
  accessible name: available (solid), missing — nothing written yet (dashed, amber),
  omitted — written or not, but not requested for publication (dashed, struck through,
  muted) and unknown (dotted). The choice itself has one polarity in both editors: the story
  editor makes it in the **Publish** dialog (#568) — one checkbox per enabled language when two are enabled (a single-language install shows its one row without a checkbox), the
  primary and any already-published language checked and locked with their reason, each row with
  title, resulting URL in mono and readiness in words; selected languages with gaps block Publish
  with an announced reason and a **Go to** link that closes the dialog. The journey editor keeps
  its **Publish this journey in English** checkbox.
  The **Pages** catalogue replaces About in the admin sidebar, using flat compact
  rows like Posts — kind, a Draft/Published status pill (or "Not created yet"), language
  chips with the enabled-locale titles and right-aligned **Edit**/**Create** actions — not
  new card chrome.
  The **page editor** follows the story editor (owner decision, 2026-11-10): a command bar
  with **Back to Pages** and the locale tabs on the left, Save draft / Publish / Preview
  saved version / Unpublish / Delete page on the right and the status beneath, then heading,
  slug and the same Visual / Markdown manuscript with the same toolbar and Photo tray as a
  story. Pages have no Gallery picker: a gallery block already in a page renders in Visual
  mode and is edited in Markdown. The page heading stays visible above the bar, as on a
  journey. About hides
  inapplicable slug/delete/unpublish controls. A never-public locale's slug stays editable.
  About ends each enabled locale panel with a hairline-divided **Equipment** section
  (the identity equipment line, #514): label, code-point counter, inline error, its own
  navy **Save equipment**, and a timing note that saving never rebuilds. Conflicts keep
  the input and offer **Load saved equipment**; preparation views omit it.
  Ordinary views show enabled locales only; the explicit Prepare translations
  entry shows one inactive locale with a notice and return to Language settings.
  Deletion uses the existing scoped confirmation dialog, never a second modal
  convention. Legal/Privacy explain author responsibility without seeded legal prose.
- The **journey editor** follows the story editor rather than inventing a layout: a
  command bar with **Back to Journeys** and the locale tabs on the left, Save draft /
  Publish / Unpublish / Delete on the right and the status beneath; one locale panel at a
  time with title, slug and intro beside the hero photo. Alt text and framing appear only
  once a hero is chosen. The heading reads **New journey** until the first save.
- The **journey catalogue** uses flat, compact rows: primary-locale title, enabled secondary
  titles with their language chips, publication state, unpublished changes, story count and
  **Edit** (named "Edit <title>" for assistive technology, as on Posts and Pages). Dormant
  published locales stay explicit. Title search searches enabled locales only, ignores case
  and surrounding whitespace, and distinguishes no matches from an empty catalogue.
  Below 68rem the description spans the row, with state/count beside the edit action.
- **Navigation settings** uses the existing vertical tab and flat field-row pattern.
  Header/footer/legal sections show bounded item counts. Collapsed rows summarize the
  destination and effective labels in each enabled locale, including default labels.
  **Edit link** opens type, target and label/URL fields; move up/down and confirmed removal
  remain visible. Reordering retains the expanded editor and keyboard focus.
  Unpublished/missing targets are explicit notices, not hidden authoring failures.
  Social links are read-only here with a Site identity link. Saving rebuilds once;
  a failed rebuild acknowledges the committed draft and offers explicit retry.
  Conflicts/network ambiguity retain edits and require a confirmed reload, never
  silent last-write-wins. Disabled translations remain stored but are not displayed.
- `[hidden]` is enforced globally with `!important`, because every control carries an
  author `display`.

- A full-width 3rem masthead (brand on the left; descriptor and View site on the right)
  sits above a 13rem sidebar and a single rounded white workspace. The sidebar holds
  all page navigation (no journal header above it) and, at its foot, the account menu. Its
  trigger is a full-width `--radius-lg` button showing the 32px steel-blue (`--studio-accent`) avatar,
  single-line ellipsized username, role, and chevron (`44px` hit height). The panel opens
  upward with **Software license and source** above a hairline and **Log out**, closing like
  every admin menu (Escape, outside click); the trigger's accessible name stays “Account
  menu for …”. Admin-only pages appear in the sidebar for admins only. Roles and server
  authorization are unchanged. Publish and destructive actions retain their existing red
  treatment.
  **Software license and source** sits inside the account menu (`#cmsAccountMenu`, above
  **Log out**) and opens `/admin/license.html`, styled in the frosted Editorial desk shell.
- The shell is exactly the viewport and the workspace is its only scroll container:
  masthead, sidebar and the canvas gutter around the workspace never scroll away.
  At the owner's direction (2026-11-13), `.cms-app-shell` uses a neutral-gray
  rule-of-thirds diagonal gradient (darkest `#d0d4da` at bottom-left, anchored
  through the `(1/3, 1/3)` crossing point `#dbdfe4`, to brightest `#fbfbfd` at
  top-right, with `--shell-muted: #4b525c` for AA contrast on the darker sidebar).
  The workspace is frosted at `rgb(255 255 255 / 0.68)` with `backdrop-filter:
  blur(16px) saturate(112%)`, a crisp `1px` `rgb(255 255 255 / 0.62)` edge, and
  a minimal shadow — and a thin scrollbar drawn in `--line-strong`. Sticky
  children (the editor command bar and inspector, the Settings index) stick inside
  it, and anything sized to the visible area uses `--cms-workspace-h`, not the
  viewport. No script reads or sets window scroll.
- Below 900px, navigation becomes a dismissible drawer. It traps keyboard focus,
  makes both masthead and workspace inert, closes with Escape, and restores focus to
  the menu button. Reduced-motion preferences are respected.
- Posts keeps search, status, and sort visible; country, region, and ordering live under
  More filters. Status views share the status select's state. Their counts include the
  current search/country/region filters, not the unfiltered library. Selection survives
  filter changes and continues to name stories outside the current view.
- Each row combines the title with country/date, a hero thumbnail, publication state,
  DE/EN indicators, modification date, and existing actions. DE means primary locale,
  not verified completeness. EN distinguishes available, missing, and unknown body
  state with accessible names and non-color-only cues.
- Under a 58rem list container, table rows become stacked records without losing
  selection, status, language, date, or actions. Edit and New post carry the list query
  into an explicit, same-origin Back to Posts link; restoration does not depend on
  a referrer header.

- The editor has no visible page title: the shell's h1 (New post / Edit post) is
  visually hidden, so the command bar opens the workspace. The command bar separates
  primary actions (Save draft, Publish, **Save & preview**, More actions) from the
  full-width save/readiness status row; the actions come first in the DOM, so Tab reaches
  Save before the status. Confirmed draft saves use this status row alone, including saves confirmed by a recovery
  check. They never open a second success banner or offer **Check again** after success.
  The recovery panel remains available for uncertain outcomes, conflicts and account changes;
  edits made during a save remain visibly unsaved.
  On a live story Publish reads **Publish changes** (it replaces
  what readers see); below 52rem the word "changes" folds out of sight but stays in the
  accessible name, so the phone action row does not wrap. Save draft names its shortcut (⌘S / Ctrl+S) in its tooltip and
  `aria-keyshortcuts`. **Save & preview** names its existing save-before-preview operation;
  its accessible name keeps "Draft preview — not the live site", and its description explains
  that it does not publish. **Review story** lives inside **More actions** at all viewport
  widths alongside Unpublish; closing Review returns focus to the More actions trigger when
  its menu is closed. Re-reading the live state is
  a small icon beside it (**Check the live site again**), not a full-height button. Above
  74rem readiness lives in a native **Publish checklist** disclosure in the status row:
  a live missing-field count, then the existing locale/trip links in its floating panel.
  A gap link closes it before revealing its field; Escape closes it and restores summary
  focus. It never changes the draft or implies a successful publication. Below 74rem
  More actions carries readiness as well.
  The desktop manuscript title is a fixed 2rem; its placeholder uses `--muted`.
  On phones the status is one
  wrapping line ("Saved to server · Live ↻"), the story-details opener rides at the right
  end of the locale row so the actions fit one line, and error/status text wraps instead
  of disappearing behind ellipses.
- The unboxed title and editable prose share a quiet white document canvas. A compact,
  sticky toolbar pins beneath the command bar: a roving `role="toolbar"` with one Tab stop
  and arrow keys, formatting controls, **Photo**, **Gallery**, and an editable
  **Visual / Markdown** mode switch. Visual is the default; Markdown exposes the actual
  EasyMDE source editor, not a read-only rendered view. Below 52rem less-used formatting
  folds into an overlay **Format** tray, while the primary writing controls remain reachable.
  Escape returns focus to Format; resizing retains a visible toolbar focus target.
  **Photo** opens a tray for upload, alt text, suggestions and the library picker, inserting
  at the caret and returning focus to the story. Upload/gallery outcomes use one status line.
  This extends the existing Editorial desk palette and type rather than introducing a new
  visual system; the existing tokens and design sidecar remain unchanged.
- All editor chrome is English like the rest of the admin, whichever locale tab is open:
  gallery widgets, title-image controls, gallery metadata advisories and their retry
  copy come from the English dictionary; only the author's own text (alt, captions) is
  marked with the manuscript's `lang`.
- On a phone the editor stays the same editor (#302). Preview opens its tab inside the tap
  and fills it once the draft is saved — a tab opened after the save would be a blocked
  popup — and if the browser still blocks it, the status line says so with an **Open
  preview** link. Publish and Unpublish are shown only to admins (the routes are
  admin-only; an author is never offered a control that can only fail). A dirty draft is
  stashed the moment the tab is hidden, not only on `beforeunload`/`pagehide`, because a
  backgrounded phone tab can be discarded without either.
- Touch (coarse pointer) raises field text to 16px — iOS Safari otherwise zooms the page
  into any smaller focused field — and checkboxes/radios to 24px; desktop keeps 14px and
  16px. With large text below 900px the masthead's brand name truncates (its link keeps
  the full name) so **View site** stays on screen.
- The gallery picker keeps caption controls with the ordered selection: a native
  **Show captions** checkbox beside Layout and a locale-labelled textarea beneath
  each selected photo. **Use default caption** removes the local override and resumes
  Media inheritance. Text stays editable while hidden; the setting also hides public
  lightbox captions. Edits apply only to this gallery in the active locale, commit with
  Insert/Update gallery, and Cancel discards them. The manuscript widget marks hidden
  captions explicitly. On phones, each reset button sits below its textarea.
- The manuscript's gallery widget is a visual index, not a form: compact 4:3 tiles in
  photo order, each showing only its alt text from Media (or a **No alt text yet** tag).
  The photo's Media title is the image tooltip and part of its label for assistive
  technology; the visible label appears only on an editable field. The gallery head links
  to Media once (new tab, announced), and the explanatory help line appears once per
  story, on the first gallery. Only a photo that is not in Media keeps an editable alt
  field there; a Review story jump to a non-editable photo lands on its shown text.
- Gallery blocks remain part of the canonical Markdown draft. Visual gallery editing uses
  the existing Media picker and preserves directives, ordering, captions and source URLs;
  Markdown mode exposes the underlying fence.
- **Translate** (accessible name **Translate with AI**) stays beside the locale tabs, its label
  led by the shared 1rem stroke AI icon (`AdminIcons.ai()`, `currentColor`, hidden from assistive
  technology) and kept on one line at every width. It also works for a language that is not
  selected for publication; the dialog then says the result stays a private draft. Its native dialog
  names the direction and provider/endpoint/model before an explicit inference action, then
  shows readonly title, excerpt, complete Markdown and article-local image text for review.
  Existing target content requires a separate unchecked replacement confirmation. Apply and
  Discard remain distinct; cancellation never applies partial output. The dialog traps focus,
  returns it to the trigger, and scrolls within a narrow phone viewport without horizontal
  overflow. A nearby **Undo translation** restores the complete applied patch until intervening
  edits invalidate it. Save, Preview and Publish retain their existing meanings.
- **Draft with AI** (#579; accessible name **Draft with AI (DE)** / **(EN)**) is a compact row
  between the title and the story card of a language that has no title, excerpt or body: a
  secondary button led by the AI icon and one muted line. It hides once the language has text
  (the issue allows hidden or disabled; a permanently disabled row would be clutter) and is
  disabled while the story loads, saves or needs recovery. Its native dialog reuses the
  translation dialog frame: destination line, **Trip events (one per line)** with a quiet
  counter, an **Also send (optional)** fieldset whose checkboxes show exactly the value sent
  (date and kilometres in mono) and start unchecked on every opening, **Add photo captions from
  Media…** (the Media picker, captions only), a visible privacy line after the controls, a polite
  atomic status line, then a readonly plain-text preview. One navy primary per state: **Generate
  draft**, then **Apply to story** beside **Generate again**; **Cancel** appears only while
  generating and receives focus. Input errors use the inline `.field-error` pattern. Apply
  closes the dialog and focuses the title; nothing is saved or published.
- Story details sits beside the manuscript on desktop as a tinted column (`--canvas`,
  divided by `--line-strong`) so white fields read against it.
  It pins flush under the command bar and scrolls on its own. Its header carries one
  icon-only panel toggle (`panel-right-close` / `panel-right-open`, named Collapse /
  Expand story details); collapsing turns the column into a slim tinted rail that keeps
  only that toggle, and the writing column widens into the freed space. The column switch
  itself is not animated (it would reflow the whole manuscript each frame); the content
  fades and slides out with opacity/transform. The
  collapsed content is inert and hidden from assistive technology; the slide honours
  reduced motion. At 74rem and below it is a modal drawer opened by the visibly labelled
  **Details** button; the same header toggle closes it, and it traps Tab, closes on
  Escape or the scrim, and restores focus to its opener. The manuscript retains its
  unboxed document surface.
  Story details uses the shared **Tinted Paper & Capsules (3B)** control vocabulary, tuning
  its input wells to `rgb(255 255 255 / 0.76)` against the tinted rail (`#f6f8fa` inside
  the hero/title cards) and keeping `--radius-lg` on multi-line waypoint lookup results.
- Within each locale, Story details leads with the hero thumbnail and excerpt, followed by
  country and permalink. Key facts fold behind a live row count without removing their values
  from the draft. The optional title image and expedition/route sections remain available.
  The phone title uses a smaller display scale and tighter spacing to expose the manuscript sooner.
  Below 52rem the audit-to-title gap, title-field margin and title-to-body gap are reduced
  without shrinking the touch targets or changing the manuscript's reading size.
- Hero image and title image are collapsible inspector sections (closed by default) with
  one box: a white panel with preview, alt text, status, then **Choose from library**
  (always visible, no upload; the title image adds **Remove title image**) and **Adjust
  framing**. A closed section shows a small thumbnail of its photo beside Show. Hero alt text
  is typed here (a pick copies the photo's Media alt only into an empty field); the hero has
  no AI alt suggestion (body photos keep theirs).
- Excerpts grow with their text; no inner scrollbar or resize grip.
- The slug's site prefix sits above the slug in the inspector, so neither half truncates.
  A published, disabled permalink is styled as a quiet reference; editable slugs retain a field boundary.
- Key facts stack label above value, each fact divided by a hairline. The value field
  wraps and grows with its text (one logical line: Enter and pasted breaks become spaces),
  so nothing is cut off in the inspector's narrow column. Row removal is a drawn ×.
- Alt-text review is a compact disclosure rather than a full notice box. Its accessible
  summary includes the count and advisory status. Expanded content distinguishes empty
  descriptions from filename/title descriptions needing improvement, based on the existing
  audit reasons. A four-photo queue shows safe-origin thumbnails, locale, reason and an
  **Edit description** action. Language filtering, Previous/More photos and **Next unresolved**
  keep large saved-draft backlogs navigable without changing the draft or its saved state.
  Missing previews keep their text/action; filtering to no findings shows an empty state.
  Live-publication warnings retain warning colour; the audit never gates Publish.
- Opening **Review story** runs local quick checks and prepares a provider disclosure, not
  inference. Provider kind, endpoint, model, fields sent and possible usage charges appear
  above the checks. Only **Review with AI** sends the active unsaved language. The action
  fetches fresh configuration; a changed destination/model/prompt/timeout requires another
  explicit click after redisclosure. Retry preparation never silently starts inference.
  Suggestions remain advisory, and applying a suggestion never saves or publishes.
- **Expedition details** is closed by default; its summary line names what it holds
  ("3 Oct 2024 · RO · Europe · 1 stop") or what is missing ("Missing date"), and never
  forces itself open — the readiness chip's Trip link is the way in to a gap.
- Waypoints show their stops and **Add stop** first; the via-point note, the geocoding
  privacy note and the routing privacy note follow together below them. Each stop row is
  name · remove, lat · lng, then one controls line that never wraps: a square magnifier
  button (**Find coordinates**, named by `aria-label` and tooltip, the size of the ×) ·
  **Via point** · the travel-mode select (labelled **Continue by**, visually hidden, tooltip),
  or the last stop's note in that slot. The select gives up width first. The profile warning,
  lookup status and result buttons follow below at full width.
- **Route along stops** and **GPX route** fold like the sections around them; each
  summary carries its live status line, so the state reads without opening them. A GPX
  error opens its section before taking focus.
- GPX editing is a flat section in Story details, not another dashboard. Its scoped native
  dialog closes the phone inspector first, then restores that drawer and the exact opener
  on dismissal. A fixed header/footer frame one scrollable body; touch actions are at least
  44px. The self-hosted map distinguishes the actual public candidate (solid red),
  removed source sections (dashed gray), and selected/unselected waypoints with
  filled/hollow markers plus a text legend. Initial framing includes source context
  even while the bounded candidate worker is pending; waypoints cannot steal that fit.
  A missing basemap keeps interactive overlays on a grid; a WebGL failure uses local SVG.
  WebGL2 is checked before MapLibre construction; preview cleanup cannot turn an
  acknowledged attachment into a failed-save message.
  An explicit point/distance selector exposes only the active trim controls; switching
  methods uses that method's entered values, never a hidden combination of both.
  Segment removal recalculates distance trims without counting discontinuity gaps.
  Counts and Reset remain usable; Reset clears trimming without changing the chosen method.
  Replacement and exact-coordinate waypoint adoption require separate unchecked consent.
  Attach names its save scope; cancellation never silently saves. Errors receive focus
  after an action, but live trim feedback never steals focus while typing. Delayed cleanup
  warnings stay separate from the current input error. Candidate generation disables
  Attach while pending or invalid; collapse/limit feedback never silently changes precision
  or drops a route. Pending refreshes preserve map-availability notices. Publish failures
  use localized recovery messages in both the editor and the posts list.
  The retained original remains private, and attachment is draft-only until Publish.
  Published story maps add a localized per-run textual alternative with public-precision
  endpoints and approximate lengths; routeless stories gain no empty panel.
  The **Route caption** field sits below the section's actions (#512): help text names its
  only public placement, under “Published route”. A non-blank caption without a published
  track gets a `.notice-warn` advisory in a polite live region that never takes focus or
  blocks Save/Publish; a pending route read keeps the last known state.
- Country assistance and excerpt generation sit next to the relevant fields in Story
  details. Coordinate approximation is explicit. Excerpt suggestions have a plain-text
  preview, character count, and separate accept/dismiss actions; generation never looks
  like a saved edit. The Excerpt field carries no help text; the provider disclosure is a
  muted line under **Generate excerpt with AI** and is that button's description.
- **Media leads with the photograph.** The library grid uses larger tiles (≥10.5rem, two
  columns on a phone) captioned with the photo's title; a photo without one shows its file
  name set back in muted, one-line type. Tiles carry no alt-text tag (owner decision,
  2026-11-10): above the grid one line counts the ready photos in the current view that
  have no alt text in any locale and offers **Show only these**, which sets the **Alt text**
  filter (under More filters) to Missing; with the filter on, the line offers the way
  back. With no detail selected the grid takes the inspector's
  space; selection guidance and keyboard shortcuts live under Folders. The detail panel
  (20rem) has a quiet **Photo details / Back to photos** header, then the photo itself,
  camera · date · pixel size in mono (the storage key is not shown, #570), then **View
  fullscreen** beside **Suggest with AI** in one compact row, then fields. **File** lists Lens
  and Exposure (`28 mm · f/2.8 · 1/250 s · ISO 200`) only when recorded — no dash — then the
  original and variant sizes. **Versions** follows: one mono, underlined link per stored
  variant file (`AVIF · 1920 × 1280 · 412 kB`), opening a new tab; the original is size-only
  and never linked. The fullscreen viewer is a native `<dialog>` on a solid `#0f141a` stage with
  the photo at `object-fit: contain`; its caption sits **under** the photo on an opaque navy
  plate (white title, DE/EN alt texts with mono codes, "Photo n of N on this page") with
  outlined white Previous / Next / Close (white focus ring; the accent ring fails on navy).
  Previous/Next stay focusable at the ends (`aria-disabled`); ←/→ step, Escape closes and focus
  returns to the opener. At 320px the plate stacks under the photo with the three controls on
  one row; on short wide screens it stands beside the photo. A photo without a ready variant
  shows its status in a dashed frame, never a broken image. Only a fade, and only without a
  reduced-motion preference. **F** on a focused tile opens it fullscreen; the hint sits with
  the other shortcuts. The laptop inspector pins within the workspace and scrolls independently.
  Enter opens the focused photo without changing bulk selection; **Photo details** also moves
  focus into the panel. On phones an unmodified photo tap reveals the panel from its top.
  Back to photos asks before discarding unsaved metadata and restores the photo's grid focus.
  Folders uses a native disclosure, initially open on laptops and folded on phones, naming
  the current folder even when closed. **Upload photos** is a separate native disclosure:
  its closed summary still accepts drops, its open body holds the native file input,
  and the upload queue stays outside it. An empty-library upload opens it before focusing
  the chooser. One AI entry per scope: the
  toolbar's whole-view **Generate details with AI…** steps aside while a selection exists,
  because the bulk bar's button acts on it. Rename and Delete are disabled on **All
  photos**, which is a view, not a folder.
- Media photo details follow the same rule in the detail panel: AI fills only empty
  fields (marked unsaved) and offers the rest as a tinted note with **Use**. The bulk
  dialog is the exception that saves, so it states scope, fields, destination and photo
  count first; overwriting renames the action to **Generate and overwrite**.
- Media's upload queue gives every picked file its own outcome in words (#301). Files the
  browser can already rule out — over the 25 MB upload limit, HEIC/HEIF (the shipped image
  pipeline decodes only AVIF-flavoured HEIF) or not an image — are **never sent**; their row
  says "Not sent: …" with what to do instead, on its own full-width line under the file name,
  red only repeating the words. A transferred file reads "Transferred; image processing may
  still be running" (never "done"): the grid badge reports processing → ready/failed. While any
  transfer is unsettled, a warn-toned note asks to keep the tab open; it disappears once every
  file has a result, because encoding continues on the server without the tab.
- Settings is one flat document per tab beside a quiet vertical tab index (**Site
  identity**, Languages, Navigation, Images, Comments, AI models, Site & backups), not a
  stack of competing cards. It opens on Site identity. The active tab sits on the
  accent-soft surface, is mirrored in the URL hash (unknown → Site identity) and in the
  title (**Settings · Site identity**, the tab in muted weight). AI models holds the
  **Providers** list — name with a small `default` badge, kind and key state as text,
  the base URL in mono, and right-aligned text actions Edit · Set default · Test ·
  Delete (Delete red, disabled actions dimmed with a stated reason) under an **Add
  provider** primary; add/edit is an inline tinted form, never a card. Three flat task sections,
  **Story review & excerpts**, **Photo descriptions** and **Article translation**, each own
  their provider/model pair, resolved destination and privacy note. Prompts, timeouts and photo
  limits sit behind each task's **Advanced settings** disclosure. **Test story review** names
  its sample-data/possible-charge scope. One pinned **Save AI settings** saves all assignments
  without contacting a provider. A shared model-list failure notice avoids duplicated diagnosis.
  Model dropdowns fill from the
  provider's own list; a saved model it does not list stays as "(saved, not listed)", and
  **Other model ID…** reveals a text field. Images ends with **Compare quality**: a photo
  picker, a WebP/AVIF segmented choice and **Generate preview**, then the original and the result in
  two equal panes (stacked below 48rem) captioned with format, pixels, file size and saving,
  with a synchronized **1:1 pixels** view. Tabs still save independently.
- Settings tracks unsaved intent per save scope, including identity text and its two asset
  selections separately. A pinned notice names pending sections; save controls stack below it
  using its measured height, never cover one another. Native leave/reload protection remains
  until that scope is saved or explicitly discarded. **Discard all changes** confirms a reload;
  it does not undo saved settings. No field values, API keys or files are copied into browser
  storage. Failed saves retain pending inputs. Form fields lock during their save.
  Identity, Navigation, AI and backup/import saves state their scope and publication timing
  next to the action. Languages disables its save/rebuild action for the unchanged mode.
  Timeouts and import pacing use seconds, preserving millisecond precision and API units.
  Comments names the saved on/off state separately from the current checkbox.
- While the saved database backup schedule is **Off**, Site & backups shows a
  `.notice-warn` under the schedule and the admin's Desk repeats it in the Site list with
  a link to `settings.html#site`; the Desk reads it from `GET /settings` and stays silent if
  that read fails. Recovery details sit in a **What a full recovery needs** disclosure.
  Site & backups has jump links for Publishing, Backups & recovery, WordPress import tuning
  and Street routing. Publishing and routing have independent actions/status. Import tuning
  folds below backup scheduling; the action explicitly saves backup and import settings only.
  **Last recorded backup operation** is not inferred from a file listing: missing success
  history says it is unknown even when local files exist. Every empty archive list names
  what is absent. Local files are not proof of offsite copies or recoverability. A failed
  status read has an explicit reload action and does not prevent other Settings from loading.
- Site identity groups **Public identity**, **Author profile** and **Admin appearance**, using
  paired enabled-locale fields. Its pinned save action distinguishes saving from publishing;
  detailed timing and domain-format guidance fold while the blank-domain indexing consequence
  remains visible. Social links are an ordered list
  with labelled Move up, Move down and Remove actions; a seventh link cannot be added.
  Saving checks the loaded revision: conflicts retain the author's inputs until an explicit,
  confirmed reload. Save never rebuilds. The timing note distinguishes the next public
  Publish/Rebuild from immediate new author replies and next-load admin chrome; **Rebuild
  site now** confirms that it uses saved values, not unsaved form input. Domain controls
  remain owned by #276.
  Logo and favicon controls save/remove separately from text. Each states whether a custom
  asset is saved or the default is selected; a local filename is a selection, not a public
  preview. Accept PNG, JPEG or static WebP (2 MiB maximum), never SVG. Successful asset
  actions advance the shared revision without discarding unsaved text; conflicts keep the
  current inputs until explicit reload. Removal requires confirmation and restores the
  default only at the next Publish/Rebuild, just like replacement.
  On the public site a saved logo replaces the text wordmark inside the existing home link:
  its accessible name is the site name (or localized fallback), its intrinsic dimensions
  reserve space and its target height is 2rem. Without it the text name remains. Custom
  favicon links replace the bundled icon only when the complete group exists.
  Text limits count NFC-normalized, trimmed Unicode code points; supplementary characters
  do not consume two slots. Excess input stays intact and receives focus on Save rather
  than being truncated by an HTML UTF-16 length cap. Configured wordmarks and footer text
  wrap even when a valid name or social label contains no spaces.
- Below 72rem the index becomes a horizontal, wrapping strip above the panel (its arrow
  keys follow) and paired fields stack; provider rows and use-case rows stack below
  48rem. The topbar stays in normal flow.

