# Gallery Layout Modes & Lightbox — Design

**Date:** 2026-07-29
**Status:** Approved (scope decided on issue #66)
**Repos touched:** blog repo — `site/` and `uploader/`.
**Supersedes:** §Layout and §Lightbox of
`2026-07-26-media-library-and-galleries-design.md` (Phase 4). That spec assumed **one** justified
layout and stored no mode; this one replaces it with three selectable modes and the storage
mechanism for choosing between them. Everything else in the 07-26 spec stands.
**Builds on:** #65 (the ```gallery fence, `galleryNode`, the URL defences) and #75 (the picker).

## Why this exists

The 07-26 spec deferred Phase 4 behind an explicit gate: *look at a real Phase 3 gallery first —
the plain grid may turn out to be enough.* The gate was exercised on 2026-07-28 against the real
photo corpus, rendered through `renderMarkdown → transformBodyImages` with the live `.jgal` CSS.

**Verdict: the plain grid is not enough.** `grid-template-columns: repeat(auto-fill, minmax(15rem,
1fr))` gives every cell its row's height, so uniform landscapes look fine but a single portrait
among landscapes leaves roughly a third of the block as dead background.

## Confirmed requirements

- Three selectable layout modes, chosen per gallery, defaulting to the widest one.
- A lightbox on **all three** modes.
- Every gallery authored before this change keeps rendering, unchanged, with no migration.
- No new **runtime** packages, no new server endpoints, no data-model change. (`happy-dom` was
  added to `site/` as a dev dependency for the island's test suite — nothing ships to a reader.)

## Layout modes

| Mode | Behaviour |
| --- | --- |
| `breakout` *(default)* | Justified rows in the **1112 px** full-bleed break-out — wider than the text column |
| `column` | Justified rows constrained to the **728 px** story column, aligned with body text |
| `slider` | Carousel; slides per view adapts to the viewport (3 desktop / 2 tablet / 1 mobile), uniform tiles |

The justified modes preserve each photo's aspect ratio; the last row is capped rather than
stretched. **The slider deliberately does not preserve aspect ratio** — uniform tiles mean
cropping. That is a knowing trade-off for a conventional carousel feel, and it is the reason the
slider is one mode among three rather than the only layout. It is recorded in a code comment so a
future reader does not "fix" it.

`1112 px` is derived, not chosen: `StoryPage.astro` renders `<Content />` inside
`mx-auto max-w-3xl px-5` → 768 − 40 = **728 px**, and 728 + 24rem = **1112 px** exactly.

## Storage: a `#layout:` directive inside the fence

```gallery
#layout: slider
https://img.simonswanderlust.com/trips/x/a | 3000x2000 | alt="…" | caption="…"
```

**An info-string argument on the fence opener does not work — verified, not assumed.**
` ```gallery layout=slider ` and ` ```gallery {layout=slider} ` both render to *byte-identical*
HTML to a plain ` ```gallery `: `<pre><code class="language-gallery">…</code></pre>`. The info
string is discarded before `body-images.ts` ever sees it (`excludeLangs: ['gallery']` bypasses
Shiki, and the fallback path emits only the language class). Any design storing the mode there is
unimplementable.

The in-fence directive needs **no new parsing on either side**:

- **Save path** — `isSkippableLine` (`uploader/src/body-content.ts`) already treats `#`-prefixed
  lines as comments, citing *"spec §Body encoding"*, so `normalizeGalleryFences` leaves the
  directive alone and never mistakes it for a photo line.
- **Render path** — `galleryNode` already does `if (raw === '' || raw.startsWith('#')) continue`.
- **Picker path** — `GalleryFence.parse()` already returns `directives`, and `serialize()` already
  re-emits them, so #75 round-trips the line today without knowing what it means.

The only new code is a reader that extracts the mode before the photo loop.

**Unknown or missing value falls back to `breakout`.** A typo degrades to the default rather than
breaking the block. The directive is matched case-insensitively on the value; the first `#layout:`
line wins, so a stray second one cannot silently override the author's choice.

## Modules

### `site/src/lib/gallery-layout.ts` (new, pure)

**Constraint: this module runs in two runtimes.** `uploader/src/preview.ts` imports
`transformBodyImages` cross-tree, so it executes under `tsx` in the uploader as well as under
`astro build`. It must stay dependency-free and `astro:`-free, or `GET /posts/:tk/preview` breaks.

- `readLayoutMode(fenceText): GalleryMode` — the directive reader described above.
- `partitionRows(ratios, containerWidth): GalleryRow[]` — the justified-row partition. Greedy:
  extend the current row while doing so brings its height closer to the target; close it
  otherwise. The last row is **capped rather than stretched**, and the cap rule changed under
  measurement:

  - It is capped at the height of the row **above** it, so a remainder reads as a partial row.
    A flat 1.5 × target ceiling made the final photo the largest on the page — 450 px tall beside
    297 px rows at the design width, and 450 beside 210 on a tablet.
  - With no row above (a gallery that fits on one line) the ceiling is `MAX_LAST_ROW_HEIGHT`
    (1.5 × target). That lets two landscapes fill the width at ~367 while stopping a lone
    portrait at ~300 × 450 instead of 1112 × 1668.
  - The cap is emitted as a **fraction of the container**, not a pixel value. The row above scales
    with the container; a px cap computed at 1112 does not, so the two drift apart at every other
    width. Measured at 1440 / 834 / 390: remainder 296.8 vs 297.0, 207.6 vs 205.8, stacked.
  - The CSS must clear the cap where rows stack (`max-width: none` in the `@container` block) —
    a percentage cap would otherwise leave the stacked last row at a third of the width.
- `BREAKOUT_WIDTH` / `COLUMN_WIDTH` / `containerWidthFor(mode)` / `ROW_GAP` /
  `TARGET_ROW_HEIGHT` / `MAX_LAST_ROW_HEIGHT` — the measured constants, exported so the tests
  assert against the same numbers the renderer uses.

### `site/src/lib/body-images.ts` (changed)

`galleryNode()` branches on the mode. **The #65 URL defences do not move and do not change** —
origin-equality allow-listing, `String()` coercion of alt/caption, and integer dimension checks all
still run before a photo becomes an item. This phase only changes what is emitted *after* a photo
has passed them. That matters because this phase promotes gallery URLs into `<a href>`, which is
exactly the sink the `javascript:` attack targets.

Justified modes emit rows explicitly — `flex-wrap: nowrap` on one container holding all 13 photos
would put them on a single line:

```html
<div class="jgal jgal--breakout not-prose">
  <div class="jgal__row"><figure class="jgal__item" style="--r:1.5">…</figure></div>
</div>
```

The slider emits one scroll-snap track plus two `hidden` buttons (see below).

`largestVariant()` is promoted from a private helper in `body-images.ts` to `site/src/lib/images.ts`
with its own test, because the lightbox becomes the second caller the previous review anticipated.

### `site/src/styles/global.css` (changed) + `uploader/src/preview.ts` (mirrored)

Plain CSS classes, not Tailwind utilities — custom-property-driven flex is not expressible as
utilities.

**`preview.test.ts` scrapes every `.jgal` selector out of `global.css` and requires each one in
`preview.ts`'s `STYLE`.** This is a hard constraint on this work: three modes is a meaningful
amount of new CSS, all of which the guard forces into `preview.ts`. It was **strengthened** rather
than merely satisfied — the scrape now allows leading whitespace, so rules nested inside
`@container` blocks are covered too. The new stacking and slides-per-view breakpoints live exactly
there, and an unindented-only scrape would have let precisely those drift (20 selectors covered
before, 25 after).

**Lightbox CSS is the one exception, and not by dodging the guard.** It lives in
`site/src/scripts/gallery-lightbox.css`, imported by the island — the same colocation
`travel-map.ts` uses for `maplibre-gl.css`. The lightbox does not run in draft preview at all, so
putting its rules in `global.css` would force a block of permanently dead CSS into `preview.ts`.
Layout CSS, which the preview genuinely needs, stays in `global.css` and stays mirrored.

Measured details encoded as CSS comments:

- **Emit ratios, not pixels:** `flex: calc(var(--r) * 100) 1 0`. The `* 100` matters — CSS
  distributes only `Σgrow` of the free space when `Σgrow < 1`, and a lone portrait (`--r: 0.667`)
  rendered 808 px instead of 1112 px without it.
- **`nowrap` + `flex-basis: 0`.** The popular "pure-CSS justified gallery" (`flex-wrap: wrap` +
  computed `flex-basis`) measured rows of 507 px and 741 px against a 300 px target.
- **Row membership is fixed at build time.** Ratios re-justify *within* a row only. Between 600 px
  and 1112 px rows simply get shorter; below 600 px a container query stacks them. This is an
  accepted trade-off, not a solved problem — and it is in the CSS comment because the next person
  to read it will assume the layout is fluid.
- **`sizes` is derived per photo** from the build-time partition, not from one conservative
  constant. Three clauses — a pixel width at and above the design width, the photo's share of the
  container between there and the stacking breakpoint, and `100vw` below it. One constant for the
  whole gallery is wrong in both directions: a lone full-width panorama would be served a 640 px
  variant, or a 3-up row would be served 1920 px ones.
- **Break-out:** `--jgal-w: min(100% + 24rem, 100vw - 3.5rem, 1112px)` with
  `margin-inline: calc((100% - var(--jgal-w)) / 2)`. Not `margin-left: 50%; transform:
  translateX(-50%)` — a transform makes the element a containing block for fixed-position
  descendants, which would trap the dialog.

CLS is zero in every mode: each item's height comes from `width × 1/aspect-ratio`, resolved before
any image byte arrives.

### `site/src/scripts/gallery-lightbox.ts` (new island)

Loaded by a `<script>` in `StoryPage.astro` — the gallery markup is injected HTML, not a component,
and Astro only bundles script tags it parses. Same pattern as `travel-map.ts`. It no-ops when the
page has no gallery.

- **Native `<dialog>` + `showModal()`** gives focus trap, Esc, `inert` background, `::backdrop` and
  focus restoration for free, and its top layer escapes the gallery's `container-type: inline-size`
  containment.
- **Measured gap:** the browser does *not* lock page scroll behind a modal dialog. Fixed in CSS —
  `html:has(dialog.jgal__lb[open]) { overflow: hidden }`. No ancestor sets `overflow-x: hidden` on
  the story route, so the document element is the scroller and this works.
- Arrow keys and `Home`/`End` navigate; backdrop click closes; position announced via a polite live
  region; `prefers-reduced-motion` respected.
- **Degradation:** every photo is a real `<a>` to its largest variant. JS off → clicking opens the
  full-resolution image, and the grid is already correctly laid out by CSS alone.
- **The script never touches the layout** — no measuring, no class toggling that affects flow — or
  CLS returns.
- All strings come from `site/src/i18n/ui.ts` via data attributes, mirroring `data-readstory`
  (Golden Rule 7).

### Slider controls and accessibility

The track is `overflow-x: auto` + scroll-snap + `tabindex="0"` + an accessible name, so **arrow
keys scroll it natively with JavaScript off**. That is the non-JS fallback, and it is the same
control the enhanced version drives.

Prev/next buttons ship in the build-time HTML carrying the `hidden` attribute and are un-hidden by
the island. They are absolutely positioned over the track's edges, so neither state affects layout
— which is what keeps "the script never touches the layout" true. With JS off they stay hidden
rather than sitting there inert.

### Editor: choosing the mode

#75's picker landed first, so the mode selector belongs inside it, exactly as #66 anticipated. A
`<select>` in the picker's multi-select mode, seeded from the fence's current directive and written
back on confirm.

`uploader/public/gallery-fence.js` gains `layoutOf(directives)` and `withLayout(directives, mode)`.
`serialize()` already re-emits directives verbatim, so an author who hand-typed a directive the
picker does not understand keeps it. The default mode writes **no** directive, so a gallery whose
layout was never touched round-trips byte-identical.

`layoutOf` duplicates the renderer's directive rule — a browser IIFE cannot import an ESM module
from the other tree, the same constraint that forced `escapeMeta` to be written twice. A parity
test in `test/gallery-fence.test.ts` imports `readLayoutMode` cross-tree and runs both over one
corpus, and `test/admin-pages.test.ts` pins the editor's offered values to `GALLERY_MODES`. Without
those, the picker can show one mode while the site renders another — silently, and only after
publishing.

## Testing

| Area | Coverage |
| --- | --- |
| `gallery-layout.test.ts` | The ten partition cases named on #66 (1/2/3/7/13 landscape, 9 and 13 mixed, 5 portraits, a lone 4:1 panorama, a panorama in a mix), the greedy invariant as a property, the cap rules including the cross-width drift check, plus the directive reader including unknown-value, missing, casing and duplicate-directive cases |
| `gallery-lightbox.test.ts` | The island's DOM behaviour under happy-dom — keys, clamping, disabled/hidden states, modifier-click passthrough, and that wiring the slider writes no inline style |
| `images.test.ts` | `largestVariant` |
| `body-images.test.ts` | Per-mode markup, ratio emission, row nesting, and that the #65 URL/coercion defences still reject what they rejected before |
| `preview.test.ts` | The CSS parity guard, unchanged and unweakened |
| `ui.test.ts` | Locale completeness for the new strings |
| `gallery-fence.test.ts` (uploader) | `#layout:` round-trip through parse → serialize, and `layoutOf`/`withLayout` |

## Risks and accepted trade-offs

- **The slider crops.** Deliberate; documented in code.
- **Three modes is three times the CSS surface**, mirrored into `preview.ts`. The parity test makes
  drift loud but does not make the volume smaller.
- **Row membership fixed at build time** — accepted, documented in the CSS.
- **The directive rule is written twice** (renderer and picker) — unavoidable across the two
  trees, and held together by a cross-tree parity test rather than by discipline.
- **happy-dom is a new dev dependency** in `site/`, for one suite. Justified because the island's
  accessibility behaviour *is* DOM behaviour: the repo's existing `vm`-sandbox precedent covers
  pure logic and cannot reach keyboard handling, focus, or `<dialog>` state.

## Out of scope

Per-photo layout overrides, a masonry mode, captions inside the lightbox chrome beyond the existing
`figcaption`, and any change to the media library, the `images` map, or the storage format beyond
the one directive line.
