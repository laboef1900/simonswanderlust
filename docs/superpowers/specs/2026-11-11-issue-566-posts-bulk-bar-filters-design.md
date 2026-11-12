# Issue #566 — Posts: floating bulk-action bar, in-label filter menus, hover-revealed row checkboxes

Status: **approved** by independent AI review, round 5 (see [Approval record](#approval-record)) · Risk: **Normal**
(presentation-only; no endpoint, schema, auth, slug or route change) · Issue:
[#566](https://github.com/laboef1900/wanderlust-studio/issues/566) (binding acceptance criteria).

This spec refines the incumbent **Editorial desk** admin (`DESIGN.md` → *Admin authoring*). It adds
no new visual language: every colour, radius, height, shadow and chevron below is an existing
`admin.css` token or an existing menu shape.

## 1. Scope

| Surface | Change |
|---|---|
| `uploader/public/admin-select.js` (new) | Reusable select-only combobox (`window.AdminSelect`) over a hidden native `<select>`. |
| `uploader/public/posts.html` | Five filters adopt `AdminSelect`; `#bulkBar` moves out of the list card and floats; the header's visible **Select visible** text is removed; the select-all name becomes the issue's string. |
| `uploader/public/admin.css` | `.admin-select*` component rules; `.posts-page`-scoped floating bar and hover-revealed checkboxes; shell token `--cms-sidebar-w`; dead `.post-select-all span` rules removed. |
| `uploader/test/` | `admin-select.test.ts` (happy-dom) for the component; posts-harness cases for bar visibility, selection mode, Escape, focus, `inert`, and menu `sync()`. |
| Docs | `DESIGN.md` admin control vocabulary (filter menus, floating bulk bar, checkbox reveal; L1128 labels-above note, L1140 selects, L1205-1206 menus/disclosures); `docs/claude/project-reference.md` admin script list (L201: add `admin-select.js`); `docs/claude/project-status.md` entry; `ARCHITECTURE.md` only if it lists admin scripts. |

Out of scope: `media.html` (§7), the Search field (it is not a select; its stacked caption stays),
every server route, `posts-filter.js`, URL format, the position of the page status line `#out`
(§10).

## 2. Invariants that must not change

1. `listStale` / `listMutating` keep disabling exactly what they disable today: bulk Publish /
   Unpublish / Delete (`render()`), `#selectAll`, row checkboxes and row actions
   (`controlsUnavailable`). The bar's move does not touch those assignments.
2. `confirmBulk` — the typed `DELETE` confirmation and the plain confirmations — and `runBulk`'s
   immutable key snapshot, partial-failure retention and focus hand-off (`AdminFocus.hold` →
   first acted-on Edit link, else neighbours, else New post) are unchanged.
3. `#fStatus`, `#fSort`, `#fRegion`, `#fCountry`, `#fOrder` remain the **single source of truth**
   for filter state. `currentFilters()`, `setFilterControls()`, `syncFilterUrl()`, `editorHref()`'s
   `returnTo`, `#statusViews`, `#fReset`, `#fMore` and `PostsFilter.fromSearch/toSearch` read and
   write those selects exactly as today.
4. `fillOptions()` still rebuilds Region/Country options and preserves a still-valid choice.
5. `#bulkCount` keeps `aria-live="polite"` and the same text (“N selected · M outside current
   view”). `#selectionReview` keeps listing every selected title (text only).
6. Non-admins still get no checkboxes, no select-all and no bar; the server still enforces the role.
7. No new endpoint, no new network request, no new HTML sink: all new DOM is built with
   `createElement` + `textContent`/`setAttribute`; ids are derived from the select's own id and an
   index, never from option text. No `innerHTML`, `insertAdjacentHTML` or style strings from data.

## 3. `AdminSelect` — component API and value/`change` contract

```js
const menu = AdminSelect.enhance(select, {
  label,   // optional; defaults to select.getAttribute('aria-label'); required non-empty (throws)
});
menu.sync();    // re-read options, value and disabled state from the <select> and re-render
menu.close();   // close without committing
menu.trigger;   // the role="combobox" element (for focus hand-offs)
```

- **Source of truth.** The native `<select>` stays in the DOM, keeps its `id`, and is hidden with
  the `hidden` attribute (out of the tab order and accessibility tree). Code that reads or assigns
  `select.value` keeps working unchanged.
- **User commits.** When the user picks an option whose value differs from `select.value`, the
  component sets `select.value`, re-renders, then dispatches bubbling `input` and `change` events
  on the select — the same pair, in the same order, a native select fires. Picking the current
  value fires nothing (native parity).
- **Programmatic writes** (`select.value = …` from status tabs, Clear filters, URL restore) fire no
  events, natively or here, so the consumer calls `menu.sync()` afterwards. Posts calls it for all
  five menus at the end of `render()`, which every state change already goes through.
- **Option changes** (`fillOptions`, the missing-translation option's `hidden`/`disabled`/text) are
  picked up automatically: a `MutationObserver` on the select (`childList`, `subtree`,
  `characterData`, attributes `hidden`/`disabled`/`label`/`value`/`selected`) schedules one
  coalesced `sync()` per microtask.
- **Posts markup.** Each filter becomes `<div class="filter-field filter-field--menu"><select
  id="fStatus" aria-label="Status">…</select></div>` — a `div`, not a `<label>`, so no label click
  forwarding targets the hidden select. `#fStatus`'s first option reads **All** (was “All
  statuses”) because the trigger now supplies “Status”; values are unchanged.
- **Cheap, stable `sync()`.** `sync()` builds a signature of the rendered options (value, label,
  disabled, hidden) and rebuilds the option list only when it changed — `fillOptions` rewrites
  Region/Country on every 30 s publication refresh with identical content. If the list is rebuilt
  while open, the active option is kept by value, else moved to the selected option.
- **Rendering.** `<option hidden>` is omitted; `<option disabled>` renders `aria-disabled="true"`
  and is skipped by keyboard and ignored by clicks. Option text is `option.label` via
  `textContent`. A disabled select renders `aria-disabled="true"` on the trigger and does not open.
- **Default / “set” state.** The default is the select's first option. When `select.value` differs,
  the wrapper gets `is-set`: value in 600 weight and `--studio-accent-hover` (8.154:1 on surface),
  trigger border `--studio-accent`. Weight carries the state as well as colour.

Generated structure (ids derive from the select's id, e.g. `fStatus`):

```html
<div class="admin-select [is-set] [is-open] [is-above] [is-end]">
  <div class="admin-select__trigger">  <!-- the visual box; a click anywhere toggles -->
    <span class="admin-select__label" aria-hidden="true"><span id="fStatus-label">Status</span><span>:</span></span>
    <div class="admin-select__control" role="combobox" tabindex="0" id="fStatus-combo"
         aria-haspopup="listbox" aria-expanded="false" aria-controls="fStatus-listbox"
         aria-labelledby="fStatus-label" [aria-activedescendant="fStatus-opt-2"]>
      <span class="admin-select__value">All</span>
    </div>
  </div>
  <ul class="admin-select__panel" role="listbox" id="fStatus-listbox"
      aria-labelledby="fStatus-label" tabindex="-1" hidden>
    <li class="admin-select__option" role="option" id="fStatus-opt-0" aria-selected="true">All</li>
    …
  </ul>
</div>
```

The visible caption is `aria-hidden` and sits **beside** the combobox inside the visual box, so the
combobox's **name** is exactly “Status” (via `aria-labelledby`, which still resolves hidden nodes;
the colon sits in a sibling span outside the referenced node) and its **value** is only its own
text, “All”. This is the APG layout the approved text named as the fallback: the first build put
the caption inside the combobox, and Chrome's accessibility tree then reported the value as
“Status All” (CDP `Accessibility.getPartialAXTree`), i.e. the caption read twice. The box draws
the focus ring with `:focus-within`; the returned `trigger` is the combobox element.

**Visual states** (all existing tokens):

- Trigger: `min-height: var(--control-h)`, `--control-radius`, `--line-control` border, `--surface`
  fill, the drawn chevron of `.post-more > summary` (rotates when open); caption `--muted` 500,
  value `--ink`; ellipsis on the value at `max-width: 18rem`; fills its field's width.
- Panel: `--surface`, `--menu-shadow`, `--radius-lg`, `0.375rem` padding (same as
  `.post-more-actions`), `z-index: var(--z-menu)` (80); 120 ms opacity/translate fade-in, none under
  `prefers-reduced-motion: reduce`. Closing is instant.
- Option: `0.8125rem` text, `--control-h-sm` min-height (2.75rem on coarse pointers),
  `overflow-wrap: anywhere`.
- **Selected** option: 600 weight plus a border-drawn check mark (no text content) at the inline
  end.
- **Active** option (keyboard or pointer — hover moves the active option, so they never diverge):
  `--studio-accent-soft` fill **and** a 2 px inset `--studio-accent` outline (5.393:1 against the
  soft fill), so it never rests on the 1.148:1 tint alone.
- Disabled option: `--muted`, `cursor: not-allowed`.
- `forced-colors: active`: active option outline `Highlight`, selected check `CanvasText`.

## 4. ARIA pattern and keyboard map

WAI-ARIA APG **select-only combobox**: focus never leaves the trigger; the active option is
conveyed with `aria-activedescendant`, which is set only while open.

| State | Key | Effect |
|---|---|---|
| closed | `↓`, `Enter`, `Space`, `Alt+↓` | open; active = selected option |
| closed | `↑` | open; active = selected option (APG marks Up as optional; native selects keep the current choice) |
| closed | `Home` / `End` | open; active = first / last enabled option |
| closed | printable character | open; type-ahead from the selected option |
| open | `↓` / `↑` | move active by one enabled option (no wrap) |
| open | `PageDown` / `PageUp` | move active by 10 (clamped) |
| open | `Home` / `End` | first / last enabled option |
| open | printable character | type-ahead (below) |
| open | `Enter`, `Space` (no type-ahead in progress), `Alt+↑` | commit active, close; focus stays on trigger |
| open | `Escape` | close without committing; focus stays on trigger; event consumed (`preventDefault` + `stopPropagation`) so no outer Escape handler also runs |
| open | `Tab` / `Shift+Tab` | commit active, close, **default not prevented** (focus moves on, APG) |
| closed | `Escape`, `Tab` | not handled |

Keys with `Ctrl`/`Meta` (and `Alt` except `Alt+↑/↓`) and keys during IME composition
(`isComposing`) are ignored. The active option is kept in view by adjusting the panel's
`scrollTop` (no `scrollIntoView`, which could also scroll the workspace).

**Type-ahead.** Characters typed within 500 ms accumulate. Matching is a case-insensitive prefix
match on option labels over enabled options, searching forward and wrapping. A single character —
or the same character repeated (“nnn”) — starts after the current option, so repeated presses cycle
through options with that initial; a longer distinct buffer starts at the current option, so
“No”→“Nor” stays on “Norway”. No match leaves the active option unchanged. `Space` joins the buffer
only while one is in progress. Pure helper: `AdminSelect.typeahead(labels, enabled, start, query)`.

**Pointer.** Clicking the trigger toggles. `pointerdown` on the panel is `preventDefault`ed so the
trigger keeps focus; clicking an enabled option commits and closes; moving over an option makes it
active. A `pointerdown` outside the component closes it without committing (DESIGN.md: a floating
panel closes like a menu). `blur` closes without committing unless `relatedTarget` is inside the
component; `Tab` commits first (above).

## 5. Panel placement (flip and clamp)

On open the panel is measured and placed by the pure helper `AdminSelect.place(input)`:

- The **boundary** is the viewport intersected with the nearest scrolling ancestor's box (the
  admin workspace scroller clips its descendants). The floating bar is not part of the boundary:
  panels paint above it (§6 Stacking).
- Desired height = `min(panel scrollHeight, 20rem)`. It opens **below** if that fits; otherwise
  **above** when the space above is larger, else below. `max-height` is the chosen side's space
  (minus a 4 px gap and an 8 px margin, never below 2 options' height); the panel scrolls
  internally. A 320 × 256 viewport is part of the browser check.
- Horizontally it aligns to the trigger's start edge and switches to end alignment (`is-end`) when
  that would cross the boundary's right edge. Width: at least the trigger's, at most
  `min(22rem, boundary width − 16 px)`.
- Placement is computed on open only; a long option label wraps and the trigger's value truncates
  with an ellipsis (full text remains the accessible value and the panel shows it in full).

## 6. Floating bulk-action bar (Posts)

**Layout.** `#bulkBar` moves from inside the list `.card` into a new slot, `<div id="bulkBarSlot"
class="bulk-bar-slot">`, at the end of `<main>` (after the card); the slot is the runway (below).
Current engines no longer give `container-type` layout containment (css-conditional-5, WebKit
277122), but older ones did, which would make the card the containing block of a fixed bar; moving
it out is correct in both. Same children, same order, same ids. Tab order is filters → status
views → table (select-all, rows) → bar, i.e. from the selection controls to the bar. The bar gets
`role="region"` and `aria-label="Bulk actions"` so it can be found as a landmark now that it is
visually detached from the list.

- `position: fixed`, inset to the **workspace**, not the viewport: `left: calc(var(--cms-sidebar-w)
  + 1rem)`, `right: calc(var(--cms-shell-gutter) + 1rem)`, `bottom: calc(var(--cms-shell-gutter) +
  0.75rem)`; `width: fit-content; margin-inline: auto` centres it between those insets.
  `--cms-sidebar-w: 13rem` becomes the shell token that the grid column also uses (one source).
  At ≤ 900 px the sidebar is a drawer, so `left` uses the shell gutter.
- Wide (> 40rem): `width: fit-content`, one row where the workspace allows (it wraps to two below
  about 64rem, longer with three-digit counts); `.selection-review` is `flex: none` there.
  ≤ 40rem: `width: auto` (full width minus gutters), count and Review selection each take a full
  row (`flex-basis: 100%`), action buttons wrap at `flex: 1 1 7rem` — today's narrow rules, moved
  from the card container query to a viewport query because the bar is no longer inside the card.
  The base `.bulk-bar` `margin-bottom` is reset.
- Short, narrow viewports (`(max-height: 30rem) and (max-width: 40rem)`, e.g. 320 × 256 or 400 %
  zoom): the bar is **not fixed**; it sits in flow inside its slot (`position: relative; inset:
  auto`), so it never covers most of the workspace, and Review selection opens from its own row so
  as much of the list as possible stays on screen. Landscape phones wider than 40rem keep the
  floating bar. The slot keeps its reserved height in both modes, so showing or hiding the bar
  never moves rows there either.
- Elevation: `--menu-shadow` only, no border (Declare-Once), `--radius-lg` corners, compact
  controls at `--control-h-sm` (2.75rem on coarse pointers via the existing token).
- **Stacking** (one shared order inside the workspace): page header `.cms-topbar` 50 → bar and its
  Review panel `--z-commandbar` (70) → Posts row **More actions** menus raised from
  `--z-popover` to `--z-menu` (80) and filter panels `--z-menu` (80) → drawer scrim 90 → drawer 100.
  The row menu was `--z-popover`'s only consumer, so that token is removed from the scale.
  So the Review panel paints over the header on short screens, a row menu opened on the last rows
  paints over the bar, and the bar never covers the mobile drawer (the shell also makes the whole
  workspace `inert` while the drawer is open). Engines that still give `container-type` layout
  containment (pre Chrome 129 / Firefox 133 / Safari 18.4) put row menus back under the bar;
  recorded, not mitigated.
- **Review selection** opens **upward** as a floating panel (`--surface`, `--menu-shadow`,
  `max-height: min(40vh, 18rem)`, scrolls). The list gets `tabindex="0"` and
  `aria-label="Selected stories"` so a keyboard user can scroll it (as `settings.html` does); the
  summary gets an id. It closes like a menu: Escape (focus to its summary) and an outside click.

**Translucency floor (no blur).** Fill: `color-mix(in srgb, var(--surface) 95%, transparent)`.
**No `backdrop-filter`.** At 95 % the list stays faintly visible beneath and every text **and
control** pairing clears its threshold against the worst case.

Contrast method (DESIGN.md Measured Backdrop Rule): the composited background is
`α·surface + (1−α)·B`; relative luminance is monotonic in each channel, so the worst case for dark
foregrounds is `B = #000` (a black hero thumbnail under the bar) and the composite is
`rgb(242.25 242.25 242.25)`. WCAG 2.x formula:

| Element on the bar | Threshold | over white row | over worst case (black) |
|---|---|---|---|
| `--ink` #202630 (count, Review selection, chevron) | 4.5:1 | 15.203:1 | **13.610:1** |
| `--studio-accent` #416486 (Clear selection, focus ring) | 4.5:1 / 3:1 | 6.191:1 | **5.543:1** |
| `--studio-accent-hover` #2f5273 (link hover) | 4.5:1 | 8.154:1 | **7.300:1** |
| `--line-control` #858c95 (Unpublish/Delete outline) | 3:1 | 3.397:1 | **3.041:1** |
| `--red` #d23b30 (Publish fill boundary) | 3:1 | 4.763:1 | **4.264:1** |
| White on `--red` (Publish label, own opaque fill) | 4.5:1 | 4.763:1 | 4.763:1 (unaffected) |

The floor is 95 %: 92 % fails the outline (2.839:1). The live, browser-composited measurement
(sampled bar pixel over a real row and over an injected black thumbnail) is recorded in the PR.

**Visibility and motion.** Visibility stays the `hidden` attribute, and `refreshBulkBar()` sets
`bar.inert` together with it (`inert = hidden`), so a bar fading out can neither take focus nor
clicks — `AdminFocus.hold` therefore moves on from a bulk trigger to the Edit link exactly as
today. Entry: `@starting-style` fades in from `opacity: 0; translate: 0 0.5rem` over 160 ms; exit:
the reverse via `transition-behavior: allow-discrete` on `display`. `prefers-reduced-motion:
reduce` removes both transitions. Engines without `@starting-style`/`allow-discrete` show and hide
instantly — `inert` makes focus behaviour identical either way.

**Focus.** Showing the bar never moves focus (no `focus()` call is added; the checkbox the author
used keeps focus). **Clear selection** clears, re-renders, then focuses — **without scrolling**
(`preventScroll: true`) — the first enabled checkbox, in DOM order `#selectAll` then the row
checkboxes, whose box lies fully inside the workspace scroller's visible rect. If none does (or the
shell is not mounted) — e.g. 320 × 256 at the scroll end, where the static bar fills the view —
focus goes to `#selectAll` **with** scrolling, because visible focus (WCAG 2.4.7) outranks a still
list; that is the one case where clearing scrolls. At the top of the list the target is
`#selectAll`, as today; further down it is the first visible row's checkbox, so focus stays
visible and the list does not move.
**Escape** (non-repeating, not already handled) while focus is inside the bar: closes Review
selection if open (focus → its summary); otherwise does exactly what Clear selection does. Escape
outside the bar does not touch the selection; an open filter menu and `AdminConfirm`'s dialog
consume their own Escape first.

**Label-area clicks never scroll.** Each checkbox's `<label>` is its hit area. A click on the label
(not the box) would run the label default — focus the control with scrolling — and the scroll
padding below would make a checkbox in the bottom strip count as out of view. So one delegated
`click` listener on `#postsTable` handles clicks whose target is a `.post-row-select` /
`.post-select-all` label itself: it cancels the default, calls `input.focus({ preventScroll: true
})` and `input.click()`. Clicks on the box, keyboard and assistive-technology activation reach the
input directly and are untouched; the `change` handlers are unchanged.

**Runway — a reserved slot that never shrinks.** For an admin, `#bulkBarSlot` gets `is-reserved`
on the first render (before any selection), and the class is never removed. A `ResizeObserver`
writes the **largest** border-box height the bar has had since load to `--bulk-bar-h` on
`<body>`. The reserved slot has `min-height: max(var(--bulk-bar-min), var(--bulk-bar-h, 0px))`,
where `--bulk-bar-min` is declared on `.posts-page` (the body, so the slot and `.cms-workspace`
both inherit it): `3.5rem` (≥ the one-row bar's 2.875rem), `4rem` on coarse pointers, `5.5rem` /
`7.5rem` (fine / coarse) below 64rem where the bar can wrap to two rows, and `9rem` / `11rem` at
≤ 40rem for the stacked bar. `max()` with a fixed floor means the first measurement can only keep
or raise the slot, never lower it. `.cms-content` keeps its normal 2.5rem bottom padding.

- Floating mode: the bar is fixed and the empty slot is the runway, so the last rows scroll 1.75rem
  clear of the bar's top. Short-narrow mode: the bar sits statically inside the same slot.
- `.posts-page .cms-workspace` gets `scroll-padding-bottom: calc(max(var(--bulk-bar-min),
  var(--bulk-bar-h, 0px)) + 1.5rem)` for admins in floating mode only (none in short-narrow mode,
  where nothing is fixed), so keyboard focus that scrolls into view stops above the bar (WCAG 2.2
  SC 2.4.11) — from load, so a checkbox ticked by keyboard in the bottom strip before the bar first
  appears is not covered either (on a wide window; at ≤ 40rem the 9rem floor approximates the
  stacked bar and the first measurement corrects it).
- The slot only ever grows, and only at the end of the content, so neither selecting (first select
  or Select visible) nor unticking can move rows on screen, in either mode, and neither can Clear
  selection or Escape while a checkbox is in view. The one exception is §6 Focus: when no checkbox
  is fully in view, clearing scrolls `#selectAll` into view so focus stays visible.
  `.posts-page .cms-workspace` also gets `scrollbar-gutter: stable`, so a slot that first creates
  overflow cannot add a scrollbar and reflow the table.
- “Bottom padding equal to the bar's height while the bar is visible” holds (the slot is at least
  the bar's height); it is reserved before and retained after. Non-admins get no slot height.

Known limit (accepted; new for the bar's region): a fixed element is outside the workspace's
scroll chain, so a wheel or drag that starts on the bar does not scroll the list. Pull-to-refresh
on a drag-down already applies to every non-scrolling part of the shell (masthead, sidebar).

## 7. `media.html` decision — scoped to `.posts-page`

Media's `#bulkTools` is **not** adopted. Every floating rule is `.posts-page .bulk-bar`-scoped and
the shared `.bulk-bar` base rule (in-flow, `--canvas` fill, compact controls) is unchanged, so
Media renders identically. Reasons: (1) Media is a three-column layout whose right column is a
sticky photo-details panel; a bar centred over the workspace would sit over that panel's lower
fields and its Save action. (2) Media's bar contains a native **Move to** `<select>` and its
selection is driven by the grid listbox (roving tabindex, Shift-extend) and drives the detail
panel; floating it needs its own design pass. (3) The issue allows either; scoping keeps this
change presentation-only on one page. A later issue can adopt the same rules by moving them to a
modifier class, without changing Posts.

## 8. Hover-revealed checkboxes (Posts)

`.post-row-select input` and `.post-select-all input` rest at `opacity: 0` (120 ms fade) — never
`display: none` / `visibility: hidden`, so they stay in layout (no shift), in the tab order and in
the accessibility tree. They are fully opaque when any of these holds:

- row checkbox: its `tr` is hovered or has `:focus-within`;
- header checkbox: the table is hovered or the header row has `:focus-within`;
- the checkbox is `:checked`, `:indeterminate` or `:focus` (`:focus`, not only `:focus-visible`:
  Clear selection moves focus to a checkbox programmatically after a mouse click, where
  `:focus-visible` would not match);
- selection mode: `#postsTable.is-selecting`, set by `refreshBulkBar()` whenever an admin has
  any post selected (including posts outside the current view);
- `@media (hover: none), (pointer: coarse), (any-pointer: coarse)` — always visible (hybrid
  touch laptops included);
- `@media (forced-colors: active)` — always visible.

`prefers-reduced-motion: reduce` removes the fade. The header's visible **Select visible** text
is removed (with its now-dead `.post-select-all span` rules); `#selectAll`'s `aria-label` changes
from “Select all visible stories” to the issue's required **“Select all visible posts”** — a
deliberate wording change mandated by the issue, recorded here because `DESIGN.md` otherwise says
“story” in sentences (the list itself is named **Posts**). In the narrow card layout the header
checkbox follows the same rules.

## 9. Responsive and touch

- Coarse pointers: triggers use `--control-h` (2.75rem), options `--control-h-sm` (2.75rem), bar
  buttons `--control-h-sm` (2.75rem). Checkboxes are always visible and 24 px.
- ≤ 480 px: the More-filters menus already go full width (`flex: 1 1 100%`); the trigger fills its
  field there.
- Menus open within the workspace scroller and flip near its bottom; they paint above the bar.

## 10. Failure and edge cases

| Case | Behaviour |
|---|---|
| List stale / mutating | Unchanged disabling (§2.1). Bar stays visible with disabled actions while a selection exists; filters stay operable (as today). |
| Escape during a bulk request | Same as Clear selection today: clears the UI selection; `runBulk` already acts on its frozen snapshot. |
| Escape that cancels the confirmation dialog | Consumed by the dialog; key repeat ignored by the bar, so a held Escape cannot also clear the selection. |
| Region/Country options rebuilt (30 s refresh) | Identical options: no DOM change. Changed options: re-render; open panel keeps its active option by value; a vanished selected value falls back to `fillOptions`' "All". |
| Empty options / all disabled | Trigger renders the empty value; opening is a no-op (no empty panel). |
| Hidden option selected (missing-translation in a single-language install) | `applyPosts` already resets the value; `sync()` after `render()` reflects it. |
| Panel near the viewport/workspace bottom | Flips up (§5); clamped with internal scroll when neither side fits; paints above the bar. |
| Very long country/title | Trigger value ellipsis, panel wraps; bar count and review list `overflow-wrap: anywhere`. |
| Zero results | Empty-state row unchanged; selection outside the view still counts in “M outside current view”; selection mode keeps the header checkbox visible. |
| Non-admin | No checkboxes, no bar, no runway; filters work. |
| Bulk outcome while scrolled down | Reported in `#out` at the top of the card, as today. Row actions far down the list already have this gap; moving the status line is out of scope (follow-up candidate). |

## 11. Verification plan

Automated (`uploader/`): `npx tsc --noEmit`; `npm test` with a disposable `TEST_DATABASE_URL`.

- `admin-select.test.ts` (happy-dom, the real file): ARIA wiring and accessible-name inputs
  (`aria-labelledby` target text is exactly the label); open keys; arrow/Page/Home/End movement
  skipping disabled and hidden options; Enter/Space/Tab commit with `input` then `change` and only
  on change; Escape closes without commit, keeps focus, stops propagation; modifier and composition
  keys ignored; outside pointerdown; option click; type-ahead (single, repeated, multi-char, no
  match, timeout); `sync()` after a programmatic write; observer re-render when options are
  replaced and no DOM churn when they are identical; `place()` flip/clamp/end-align; disabled
  select; selected/active classes.
- Posts harness (`admin-actions-dom.test.ts`): the harness gains `AdminSelect` (a stub recording
  `sync()` per select id), `ResizeObserver`, `document.body` and `style.setProperty` so the inline
  script loads; stub elements gain `closest()` (no shell → `#selectAll` fallback). New cases: bar
  shown + `inert=false` + `is-selecting` on first selection, both reverted on Clear selection;
  showing the bar leaves focus on the checkbox; Clear selection focuses a checkbox in view with
  `preventScroll`, else `#selectAll` with scrolling;
  Escape in the bar closes an open review first, then clears and focuses the fallback, and a
  repeated Escape is ignored; a label-area click toggles the checkbox once without a scrolling
  focus; `sync()` runs for all five menus after a status-view click, Clear filters and the URL
  restore in `applyPosts`. Existing bulk, stale and confirmation cases must pass unchanged.

Browser (real local app on an isolated stack, Chromium): desktop 1440, ~700 px, 390 px and the
drawer —

- row position before/after single select and Select visible **at the top and at the scroll end**
  (including a first select at the scroll end on a fresh load at 1440), and after unticking at the
  scroll end — Δ = 0 at 1440, 390 px, 844 × 390 and 320 × 256; after Clear selection / Escape with
  a checkbox in view, focus is on that checkbox and Δ = 0; at 320 × 256 with none in view, focus
  is on `#selectAll` and inside the viewport;
- a click on the label edge (not the box) of a checkbox in the bottom strip, before any selection
  and with the bar visible, at 1440 and at 390 with touch emulation: toggles once, Δ = 0;
- Review selection at 375 × 548, scroll top, 12+ selected: the panel paints over the page header
  and its last item is reachable;
- Review/Clear/Escape; Publish, Unpublish, Delete with typed confirmation; after a successful bulk
  action with motion **on**, the active element is the first acted-on Edit link immediately and
  500 ms later; stale and mutating disabled states;
- every filter by mouse and by keyboard only; status tabs, Clear filters, More filters, URL
  round-trip; Region/Country refresh;
- accessibility tree (CDP `Accessibility`) for `#fStatus` and `#fCountry`: role combobox, name
  exactly `Status`/`Country`, value `All`, `expanded` toggling, `activedescendant` naming the
  active option;
- Tab through every row with the bar visible (focused control never under the bar); open More
  actions on the last published row at maximum scroll at 1280 px and 390 px;
- checkbox reveal rules, touch emulation, reduced motion, flip near the bottom; at 320 × 256 the
  bar is in flow (not fixed) and the filter panel flips/clamps; last rows clear of the bar, sampled
  composited contrast, Media bulk tools unchanged.

Not available in this environment and recorded as untested residual risk in the PR: VoiceOver
(Safari) spot check, WebKit and Firefox runs. Mitigation: standard APG roles/properties only;
motion features degrade to instant show/hide, and `inert` makes focus behaviour engine-independent.
Screenshots are evidence only, never committed.

## 12. Scoped exception

- **Waived rule:** the human design-approval pause for this workflow.
- **Reason:** owner-delegated, autonomous delivery.
- **Risks:** an unchallenged design, or missed accessibility, invariant or security issues.
- **Compensating controls:** independent AI design review with blocking findings resolved,
  re-review of material changes, `/review` on the PR, required CI, and full local and browser
  verification.
- **Owner authorization:** granted by the owner (Simon, @laboef1900) for issue #566 only, in the
  delivery instruction of the 2026-11-11 working session that commissioned this change; restated
  in the PR description.
- **Expiry:** when the PR is completed or abandoned.

No other policy is waived. Repository-wide rules, merge protections and safety rules stay fully in
force.

## Approval record

| Round | Reviewer (model) | Verdict | Notes |
|---|---|---|---|
| 1 | Independent `reviewer` agent, `anthropic/claude-fable-5-2` | BLOCKED (6 blocking, 8 non-blocking) | Resolutions below. |
| 2 | Same reviewer, re-review | BLOCKED (2 blocking, 7 non-blocking) | Resolutions below. |
| 3 | Same reviewer, re-review | BLOCKED (1 blocking, 3 non-blocking) | Resolutions below. |
| 4 | Same reviewer, re-review | BLOCKED (2 blocking, 2 non-blocking) | Resolutions below. |
| 5 | Same reviewer, re-review | **APPROVED** (0 blocking, 3 non-blocking) | Non-blocking 1–2 adopted (below); 3 restates residual risks carried into the PR. |

Round-1 resolutions:

1. Exit transition kept the bar focusable → `inert` set with `hidden` (§6 Visibility); harness and
   browser check added (§11).
2. Runway removal re-created layout shift → runway never shrinks, `scrollbar-gutter: stable`
   (§6 Runway); clear-at-scroll-end Δ = 0 check (§11).
3. Bar covered focus and row menus → `scroll-padding-bottom`; bar z-index below `--z-popover`
   (§6); Tab-through and last-row menu checks (§11).
4. Controls contrast → floor raised to 95 %; outline and Publish-fill rows added (§6).
5. Option states unspecified → selected check + weight, active fill + inset outline, trigger and
   panel tokens, `--z-menu` (§3).
6. Verification gaps → harness globals and `sync()` assertions, AX-tree assertions, untested
   VoiceOver/WebKit/Firefox recorded as residual risk (§11).
7. Bulk outcome visibility → pre-existing for row actions; out of scope, follow-up candidate (§10).
8. Scroll chain → accepted limit, recorded (§6).
9. Containing-block rationale → corrected; panel z-index named (§3, §6).
10. Colon in the accessible name → separate span outside the referenced node (§3).
11. Event hardening → modifiers/composition ignored, Tab not prevented, `scrollTop` keeps the
    active option in view, `relatedTarget` blur guard, signature-gated `sync()`, Escape repeat
    ignored (§3, §4, §6).
12. Markup/CSS → `div` wrappers, “All statuses” → “All”, triggers fill fields, bar margin reset,
    review `flex: none`, review list `tabindex`/name, dead rules removed (§3, §6, §8).
13. Wording/process → select-all string change recorded, docs added to scope, authorization
    detail (§1, §8, §12).
14. Lower-priority a11y → panel motion gated, `forced-colors` block, 320 × 256 check,
    `any-pointer: coarse`, bar `role="region"` (§3, §5, §6, §8).

Round-2 resolutions:

1. Bar at z 19 sat under the page header → bar back at `--z-commandbar` (70), Posts row menus
   raised to `--z-menu` (80); full order stated (§6 Stacking); 375 × 548 check (§11).
2. Runway formula invalid before first measurement → `var(--bulk-bar-h, 3.5rem)` everywhere and
   runway reserved from the first admin render; first-select-at-scroll-end check (§6, §11).
3. White on red figure → 4.763:1 (§6).
4. `floor` redundant → removed from the API and placement (§3, §5).
5. 95 % barely translucent → kept: it is the lowest alpha at which the outlined controls clear 3:1
   without restyling them; the browser pass confirms the list remains faintly visible.
6. Short viewports → below `max-height: 30rem` the bar is in flow, not fixed; criterion and check
   stated (§6, §11).
7. Scroll padding before first show → runway and scroll padding reserved from load (§6).
8. Engine coverage → Safari automation needs `safaridriver --enable` (admin rights), not
   available; recorded as residual risk with the containment caveat (§6, §11).
9. Wording → wide/narrow review layout split, markup moved into §3, `project-reference.md` added
   to docs scope, scroll-chain limit reworded (§1, §3, §6).

Round-3 resolutions:

1. Runway could still shrink (fallback above the measured one-row bar; runway off in short mode) →
   reserved slot `#bulkBarSlot` with `min-height: max(--bulk-bar-min, --bulk-bar-h)` that holds the
   bar in both modes and never shrinks; fresh-load and short-viewport Δ = 0 checks (§6, §11).
2. Short-viewport scope → `(max-height: 30rem) and (max-width: 40rem)` (§6).
3. `--z-popover` unused → removed from the token scale (§6 Stacking).
4. Bottom-strip claim at ≤ 40rem → `--bulk-bar-min: 9rem` there; sentence qualified (§6).

Round-4 resolutions:

1. Clear selection / Escape scrolled to the header → focus the first fully visible enabled
   checkbox (`#selectAll` first) with `preventScroll`, fallback `#selectAll` (§6 Focus, §8, §11).
2. Label-area clicks scrolled via scroll padding → delegated handler cancels the label default and
   focuses with `preventScroll` before toggling (§6, §11).
3. Scroll padding in short-narrow mode → off there (§6 Runway).
4. `--bulk-bar-min` scope → declared on `.posts-page` (§6 Runway).

Round-5 non-blocking items adopted (implementation detail, no behaviour change, no re-review
needed): the Tab-through check also asserts that tabbing from the last row into the bar and
across its buttons does not scroll the list; the Clear-selection focus pick is the pure helper
`AdminFocus.firstInView(candidates, container)` in `admin-ui.js`, unit-tested over stub rects in
`admin-ui.test.ts`.

PR #575 code review (`/review`, independent agents): `claude-haiku-4-5` — no findings;
`anthropic/claude-opus-5-5` — 2 warnings, 2 info, all fixed: Review selection anchored to the
bar (no right-edge overflow at 641–712 px); Clear-selection fallback scrolls `#selectAll` into
view when no checkbox is visible (§6 Focus, amended above); filter panels size to their content
(`width: max-content`, so the 22rem cap and end alignment apply); `--bulk-bar-min` floors raised
where the bar wraps or uses coarse controls. The fixes were re-reviewed before merge.
