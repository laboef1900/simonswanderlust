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
  footer-y: "56px"
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
    backgroundColor: "{colors.navy}"
    textColor: "#ffffff"
    padding: "16px"
  card-meta-line:
    textColor: "rgb(255 255 255 / 0.7)"
    typography: "{typography.label-quiet}"
  card-caption-ramp:
    height: "72px"
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
image they get their own opaque plate — navy for white type, canvas for dark
ink — which then frees the gradient above to stay light, so the photograph
survives too. On desktop the homepage hero's vignette
(`from-navy/45 via-navy/10 via-40%`) grounds the paper; story captions use a
72px ramp. On mobile neither needs a scrim: text sits below the photograph.

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
scrim. Where text must sit on an image it gets its own opaque plate — navy for
white type, canvas for dark ink — and the scrim is then free to stay light so
the photograph survives. Never tint a plate with an alpha. This is why
`FeaturedHero`'s entry panel, the story card's caption panel, the stamp chip and
footer logline all look the way they do: the hero's log line measured **1.19:1**
on a phone before it got a plate and its headline sat at **~2.8:1** whenever a
long German compound pushed it out of the dark end of the scrim; on paper the
same type is **5.4:1 to 14:1** on every frame. The card's accent line ranged
**1.90:1 to 5.01:1** depending only on which part of which photograph sat behind
it; on solid navy it is **4.8:1**, and white beside it **14.6:1**.

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
  `prose prose-lg`. The column is `768px` minus `20px` gutters = **728px** of
  measure; `max-w-none` overrides the typography plugin's 65ch cap, so the
  measure is set by the container, not by the prose.
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

**Where the entry number belongs.** `N°09` is a signature mark and it earns
its place where it says something: the hero's entry, and the story page. It was
also on every grid card, nine of them down one index, restating an order the
grid's own newest-first sequence already shows. Removing it there is not a
retreat from the identity — it is spending the mark where it carries meaning.

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

**The story spread.** From `lg` a story is a reading column beside a rail
inside the 1112px content box: column `min(45.5rem, 100% − 21rem)`, a `3rem`
gap, rail `clamp(18rem, 100% − 48.5rem, 21rem)` (`--container-story-column` /
`--container-story-rail`). The column yields first — 648px at a 1024
viewport, the full 728px from 1192 — and the rail grows once the column is
full; the three always sum to exactly 100%. The rail holds the story's
furniture — contents, key facts, the route map — open in a stack that stays
`0.5rem` from the viewport top while the story is in view. The stack is capped
at `calc(100dvh − 1rem)` and scrolls internally with contained overscroll, so
short viewports do not make its later controls unreachable. Below `lg` the same
three elements are collapsed disclosures stacked above the article. The outer
wrapper remains a **float**, not a grid column, because the article is one
rendered body that cannot be split around a sidebar, and a wide gallery near
the top must not run under the rail: `clear: right` on the wide modes drops such
a gallery below the rail and leaves every later one where it is.
The title block widens with it, the text keeping the column's width so its
left edge meets the article's, and the arrival stamp moves to the top-right
corner above the rail — the same place it sits on the homepage hero. This is
what the WordPress site's opening row was for (intro, facts, contents and a
photograph in the first screen); what it got wrong was setting the body at the
same 1140px, ~140 characters a line.

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

**Break-out.** Below `lg` a wide gallery may exceed the story column to
`min(100% + 24rem, 100vw - 3.5rem, 1112px)` — 24rem is the measured overhang
either side of the 728px column, and `100vw - 3.5rem` keeps it clear of the
classic scrollbar. It is centred with `margin-inline`, never
`transform: translateX(-50%)`, because a transform would make the gallery a
containing block and trap the lightbox dialog inside it. From `lg` it spans the
whole spread (`100cqw` of `.story-reading`) from the column's left edge instead
— centred on a column that now sits left of centre, it would cross the
viewport's left edge. Break-out is opt-in (`#layout: breakout`); the default
gallery is `column`, aligned with the text as the WordPress galleries were.
That flip cost nothing in photo size: the old galleries were ~1140px wide, and
so is the break-out; what changed is that the text got narrower.

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
stamp chip). Nothing else on the public site casts a shadow at rest.

### Shadow Vocabulary

- **Card at rest** (`box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`):
  the story card's only resting elevation — it replaced a card that carried a 1px
  border *and* a wide soft shadow.
- **Chip on photograph** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`):
  the stamp chip — paper laid on an image.
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
traced: the rule inside the hero panel between masthead and entry
(`border-dashed border-navy/25`), the `RouteDivider` between story body and
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

### Cards / Containers

- **Story card** — a whole-tile link with navy body and `12px` corners.
  Below `640px`, the photograph is uncropped and followed by a solid navy caption
  with `16px` padding. Mobile titles are not clamped. The homepage's promoted
  cover alone becomes a thumbnail-and-title index row.
  - *Small and tablet captions:* from `sm`, a two-row grid separates the photo
    from its solid navy caption (`16px` padding). The image row is
    `minmax(6rem, 1fr)` and the caption row sizes to its text inside the unchanged
    `280px` mosaic track. There is no fade or text over a small photograph.
  - *Lead caption:* only the double-height lead at `lg` fills the tile with a
    photograph and overlays its caption. A **72px** ramp
    (`from-navy/92 to-transparent`, no type in it) meets the `navy/92` base.
  - *Why the lead uses 92 and not 100:* it is the floor, not a preference. White measures
    **11.6:1** on it and `white/70` **6.57:1** over the brightest sky in the
    corpus; at `/80` that second figure is 4.66:1 and at `/75` it is 4.07:1,
    i.e. under AA. The caption could only be lighter by giving up the date
    line. It could not be translucent at all while the card still carried a
    `brand-red-light` marker, which needs solid navy and misses AA at `/98`
    over a bright sky — removing that marker is what bought the transparency.
  - *Why the ramp is a fixed length:* a percentage scales with the title's line
    count, so the one distance guaranteeing that type never lands in the fade
    would differ per card.
  - *Date line:* the month and year, plus the country **only when the title
    does not already name it** — eight of nine live titles do, and printing it
    twice within 30px made the index read as repeated. Weight 400 at `12px` in
    `white/70`, below the heading, no box. It wraps rather than truncates:
    `truncate` here cut the destination country, the identity payload the card
    exists to deliver, on 3 of 9 cards at a 320px viewport.
  - *No entry number, no cover marker.* Nine `N°` labels down one index
    restated an order the newest-first grid already shows, and the cover marker
    put a second coloured object on the one card that least needed decorating.
    The `N°` still leads the hero and every story page.
  - *No card-height scrim.* There used to be one (`from-navy/90 via-navy/35
    via-55%`) serving the title. It cannot serve it any more: with the date
    line below the heading the title's top sits around 46% of the card, where
    that gradient is near its weakest — re-derived against the same pale Rhodes
    sky, white lands at **2.87:1** there. Holding it would take roughly `/62`
    at the midpoint, veiling the lower half of every photograph and blurrier
    than the ramp.
  - *Sizing:* mobile height follows the photo and caption, not fixed tracks.
    From `sm`, the tile is `280px` per row and `cardSizes` retains
    `max(boxWidth, boxHeight × 1.5)` as a conservative source hint: small photo
    regions are shorter than their tracks, while the lead still uses its full height.
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
  it, and a section link focuses the heading without closing anything. Summary
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
- **Story pagination:** chronological links with `80px` square, lazy-loaded
  photo thumbnails and full wrapped titles. A sole link spans the reading
  column; two split from `768px`. No empty placeholder cell, border or shadow;
  underline and color carry hover/active feedback.

### Story Opening

`StoryHero.astro` owns the photograph, title, entry/date/country line,
coordinates, arrival stamp and optional translation link. The photograph leads;
every word sits on canvas below it at every width. The translation link is a
secondary action in the site's link register: 14px medium navy on canvas
(**14.114:1**), with the red accent reserved for hover and active states; its
44px hit box and arrow remain. Below `lg` the title and body share the `768px`
container with `20px` gutters and the stamp sits beside the coordinate and
translation group. From `lg` the block is the spread's grid: the text keeps the
reading column's width, and the stamp is placed top-right above the rail — one
element, two grid placements, no duplicate markup. Responsive source hints
account for the photograph's actual aspect ratio when desktop cover cropping
needs a wider source. Mobile retains the whole frame, including portrait
photographs. No title clamp or photographic scrim.

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
  `brand-red` bottom border — a different *kind* of signal, not a darker shade —
  and the outgoing link is `ink/70` (**5.97:1**; `/60` was 4.33:1).
- **Destination index** (`RegionFilter`): navigation set in the log register —
  14px mono uppercase navy, a `brand-red` `tabular-nums` count, and a 12px arrow
  at `navy/55` that turns red and slides `2px` on hover. Hover adds a **dashed**
  underline at `4px` offset. The current region is not a link to itself: it is
  `brand-red`, arrow-less, and carries `aria-current`. See The No-Pill Rule.
- **Footer:** navy with a contour texture, a three-column grid from `md`
  (`2.2fr 1fr 1fr`), `56px` vertical padding. Every secondary colour is `/70` or
  heavier — a floor, not a preference. Links are `44px`-tall boxes and focus with
  the light accent ring.

### Featured Hero (signature)

Below `640px`, a full-width photograph at its natural aspect ratio, followed by
the paper entry in document flow. The title never overlays the mobile image.
From `sm`, the existing `80vh` cover (clamped to `480–720px`) retains its vignette
and overlaid paper entry.

- **Entry panel:** canvas, capped at `672px`. Mobile uses the page's `20px`
  gutters and `24px` vertical spacing, without a floating shadow. From `sm`,
  the panel has `4px` corners, `24px` padding and the system's deepest shadow.
  Inside, in order: the tagline as a quiet 16px semibold `navy/75` `<h1>` (18px
  from `sm`; the wordmark is already in the header,
  so repeating the identity at display size would be the page shouting its own
  name); a dashed rule; then one link wrapping the whole entry — mono field line
  (`N°` in red, date · country at `navy/70`), display title, coordinates, a
  two-line excerpt, and the red call with its arrow.
- **Stamp chip:** a square canvas chip with `8px` padding and a lifted shadow,
  pinned top-right, holding the rotated stamp. Shown at every width — 124px plus
  margins clears a 320px viewport.
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

### Route Divider (signature)

Filled `brand-red` dot → dashed 2px navy rule → a 16px compass arrow at
`ink/40` → dashed rule → open `brand-red` ring on canvas. `aria-hidden`.
Used where two genuinely different kinds of thing meet: inside the hero panel
between masthead and entry, and between a story's body and its pagination. It
was removed from the homepage because one dashed rule between two sections that
already meet at a hard canvas/navy edge is a motif asserting itself rather than
dividing anything.

### Map Band (signature)

Navy band, `1152px` container, two-up from `lg`. The chart is a real projection:
land as a `fill-opacity: 0.14` silhouette *under* the graticule, primary
meridians and parallels at `opacity 0.34` solid and secondaries at `0.14`
dashed `4 6`, pins as a `brand-red-light` dot inside a 15px ring. Degree labels
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
`#4a5563`. Row *membership* is fixed at build time for a 1112px or 728px
container; only justification within a row is fluid. The last row is capped as a
**percentage** of the container so the remainder keeps matching the row above
it — a pixel cap computed at the design width left a 242px-tall remainder beside
167px rows on a tablet.

## Do's and Don'ts

### Do:

- **Do** give type its own opaque plate wherever it meets a photograph — navy
  under white, canvas under dark ink — and let the scrim stay light
  (`FeaturedHero.astro`, `StoryCard.astro`, `Footer.astro`).
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

- **Don't** tint an opaque plate with an alpha or a backdrop blur. The stamp on
  a `bg-navy/60` blurred plate measured **1.28:1 to 2.58:1**; on the opaque
  canvas chip the same inks are **5.49:1 to 16.5:1**.
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
  the footer only because `px-5 py-14` keeps every ring inside the containment box.
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
