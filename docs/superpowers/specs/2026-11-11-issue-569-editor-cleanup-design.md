# Issue #569 — Editor clean-up: library-only hero/title image, no hero alt suggest, excerpt disclosure, waypoint row

Status: APPROVED by independent AI design review (round 2, 2026-11-11; Amendment A approved in
round 4). Owner: Simon.

## Scope and risk

Four clean-ups in the story editor (`uploader/public/editor.html` and helpers), as specified in
GitHub issue #569. Admin surface only ("Editorial Desk", `admin.css` tokens, no decoration).

**Risk: Normal.** No slug, route, schema, API, auth, session, comment, body-HTML render, EXIF or
AI-credential change. Server endpoints (`POST /upload`, `/geocode`, `/ai-config`) are untouched;
the change removes client entry points only. One privacy-relevant decision: where the AI-excerpt
disclosure lives once the Excerpt help text is removed (section 3).

## Acceptance tracker (single source; mirrored in the PR body)

| # | Item (issue AC or invariant) | Owner | Evidence |
|---|---|---|---|
| A1 | Hero + title image (DE/EN) set only from the library; no file input or upload button in those sections; their upload code paths removed | Lead | Test "offers no file input, upload or suggest action…" (both locales, exact button ids); grep: no `HeroFile/HeroUpload/uploadHero/TitleImageFile/TitleImageUpload`, no `trips/<slug>/hero|title` `UploadRecovery` call; browser: 0 file inputs in all four sections, picked alps/coast/wide from the library |
| A2 | Body-image upload and body-image **Suggest alt text** still work (`*BodyImgUpload`, `*BodyImgSuggest`, `alt-suggest.js` unchanged) | Lead | New tests: body upload (owner, key, insert, `images[src]`), no insert after account change, `AltSuggest.wire` exactly the two body panels; browser: upload inserted `trips/testreise-569/wl569-body-photo-16c7c7c0`, saved in `body_markdown`; Suggest ran (no provider configured → its documented failure status) |
| A3 | Hero has no **Suggest alt text**; hero alt input stays editable and saves | Lead | Test "sets the hero from the library … saves an edited alt"; browser: DE/EN alt edited → Save → reload → persisted (`hero_image->>'alt'` in Postgres) |
| A4 | Publish-gap jump for a missing hero focuses the library button | Lead | Test (mobile drawer) focuses `enHeroLibrary` with `enHeroDetails` open; browser: "German missing hero" via mouse and keyboard → `deHeroLibrary` focused, section opened, 2px steel-blue ring on keyboard |
| A5 | Excerpt help text gone (both locales); AI-excerpt disclosure implemented per section 3 and recorded | Lead | Tests: no `#xxExcerptHelp`, textarea without `aria-describedby`, Generate → `excerpt-disclosure-<locale>`; `editor-excerpt.test.ts` note visible, outside the action row, stays during busy; browser a11y tree DE/EN: name "Generate excerpt with AI", description = disclosure; note y unchanged while Cancel shows |
| A6 | Stop row: Find coordinates · Via point · Continue by on one line (Amendment A: never wraps); lookup status/results and profile note below it at full width; routing values save unchanged | Lead | Lookup test pins controls children and row order controls → note → status → results; routing tests unchanged and green; browser: line never wraps at 1440/1280 fine, 1280 with scrollbar gutter, 375/320 coarse; mocked lookup results below, profile note under the line; stops JSON in Postgres identical before/after save+reload |
| A7 | `ui.ts`: no orphan or missing keys in either locale | Lead | 11 removed keys: 0 references each in `uploader/public`, `uploader/src`, `site/src`; added `editor.chrome.excerptDisclosure` in DE+EN and used; `ui.test.ts` completeness green |
| A8 | Tests: hero upload cases (~L4213) removed/rewritten library-only; focus expectation (~L1866) retargeted; stop-row layout + routing covered; `tsc --noEmit` + `npm test` (uploader), `npm test` + `astro check` (site) pass | Lead | Site: 53 files / 927 tests pass, `astro check` 0/0/0 (local Postgres). Uploader: see PR (full suite with `TEST_DATABASE_URL` on a disposable local Postgres) |
| A9 | Verified visually in the running editor (desktop, narrow inspector, ~375px mobile; coarse-pointer targets) | Lead | Local stack (uploader dev + Postgres 18 container), managed headless Chromium: 1440px (inspector 312px), 375px and 320px drawers with `pointer: coarse`; `scrollWidth − clientWidth = 0` for every stop row, controls line, hero zone and excerpt assist; targets 44px (search, Via label, select, library, Generate), checkbox 24px |
| I1 | Library pick adds no new behaviour; existing hero alt prefill (only when the field is empty) and title-image alt adoption kept as is | Lead | `pickHero()` body unchanged except a comment; test: empty alt prefilled, typed alt kept; cancelled picker leaves src unchanged and returns focus (browser) |
| I2 | `rowValues()`, `syncRows()`, `aria-describedby="stopRouteViaHelp"`, select↔note linkage unchanged; saved routing values identical | Lead | Functions untouched; ID sweep test resolves `stopRouteViaHelp` and each `stopProfileNote<n>`; Postgres `stops` identical after reload + save |
| I3 | DOM placement, CSS and the lookup button's accessible-name mechanism; no copy or routing change | Lead | Diff: element placement in `waypoint-lookup.js`/`decorateRow`, unused `row` parameter dropped, icon button named by `aria-label`/`title` from the existing copy, visually hidden Continue by label, CSS; no `ui.ts` or listener change |
| I4 | No slug, route, schema or API change | Lead | Diff touches only `uploader/public/*`, `site/src/i18n/ui.ts`, tests, docs |
| I5 | Every `aria-describedby` / `for` points at an existing ID | Lead | Test "resolves every label and description reference…" over the loaded editor incl. stop rows and excerpt assists |

Implementation was not delegated: the lead already holds the complete context for all four parts,
and the parts share `editor.html`, `admin.css` and `editor-dom.test.ts`, so a split would create
overlapping writes without saving work.

## 1. Hero and title image: library only

### Current

- Hero (per locale, `editor.html`): `#deHeroReplace` `<details open>` "Replace photo" holds
  `#deHeroFileLabel` + `#deHeroFile` (file input) and a row with `#deHeroUpload` +
  `#deHeroLibrary`. `uploadHero()` + two click listeners upload via `UploadRecovery.run` with key
  `trips/<slug>/hero`. `populateForm` sets `HeroReplace.open = !hero.src`.
- Title image (`editor-title-image.js`): `${prefix}Replace` `<details>` with File label/input and
  `Upload`, `Library`, `Remove`; an upload handler (busy toggling of `Upload/Library/Remove/File`,
  `UploadRecovery.run` with key `trips/<slug>/title`); `load()` opens Replace only when empty.

### Design

The disclosure existed to fold the heavy upload UI (dashed file drop field + two buttons). With
upload gone it would hide a single button behind an extra click, so it is **removed**, not
renamed. The library action is always visible directly in the section:

```
Hero image (DE)            [thumb]     ← existing collapsible section (unchanged)
  [preview]
  Hero alt text (DE)
  [ alt input ......................... ]
  status (role=status)
  [Choose from library]                ← .hero-actions-row, always visible
  ▸ Adjust framing                     ← unchanged, only for a usable hero

Title image (optional)     [thumb]
  help text
  [preview]
  Alt text for the title image [input] ← only with an image (unchanged)
  status (fallback / selected)
  [Choose from library] [Remove title image]   ← Remove only with an image (unchanged)
  ▸ Adjust framing
```

- "Replace photo" → "Change photo" rename: **not applied** — the disclosure no longer exists.
  The single button keeps its established label **Choose from library** / **Aus Mediathek
  wählen**, which names the source, and reads correctly whether or not a photo is set (the preview
  and summary thumbnail show the state).
- Library button shown directly when no image is set: **yes, always** (with or without an image).
- Order and copy otherwise unchanged; the hero alt input loses its `.hero-alt-row` wrapper (it only
  existed to place Suggest beside the input).
- Library pick behaviour unchanged (I1): `pickHero()` keeps "prefill alt only when empty", resets
  framing, marks dirty, status "Hero photo chosen from the library." + key; title image keeps its
  current library adoption. A failed/cancelled picker leaves the section exactly as it was (the
  picker only calls `onPick` on a choice; its own error states are unchanged).
- A hero whose library photo has gone missing keeps its preview `onerror` handling; the library
  button is the recovery path. Publish refuses a hero only while its media row exists and is not
  ready (`server.ts` publish media check); a hero URL with no media row is not refused, and
  in-use photos cannot be deleted from Media, so this edge stays as it is today (out of scope).

### Dead code to delete

- `editor.html`: the two `#xxHeroReplace` `<details>` (summary, `#xxHeroFileLabel`, `#xxHeroFile`,
  `#xxHeroUpload`); `uploadHero()` and its two listeners; the `HeroFileLabel` `textContent`
  assignment; `$(loc + 'HeroReplace').open = !hero.src` in `populateForm`; the stale "see
  uploadHero" comment in `pickHero`. `photoStatus()` stays (used by `pickHero`).
- `editor-title-image.js`: File label/input, `Upload` button, `Replace` `<details>`, the upload
  handler, `busy`, `el('File').value = ''`, `load()` (its only job was the `open` state), and the
  now-unused options `getSlug` and `recovery` (+ the caller's arguments in `editor.html`).
- `admin.css`: `.hero-alt-row`, `.hero-replace > label`; `:is(.hero-replace, .hero-focus)[open]`
  becomes `.hero-focus[open]`. `.hero-file-input` **stays** (body-image file inputs use it).
- No `UploadRecovery` call with `trips/<slug>/hero|title` remains in the editor. `UploadRecovery`
  itself stays (body-image upload, About page). `upload-recovery.test.ts` uses those key strings
  only as arbitrary fixtures for the shared module and stays.
- Stale comments updated: `editor.html` "hero upload" section header and the `pickHero` lead
  comment ("the other half of upload"); `admin.css` comments on the hero alt row, image
  disclosures and the hero banner zone; `editor-title-image.js` header (mirrors "Replace photo").
- Spec trail: this change removes the editor hero and title-image consumers listed as upload
  callers in `2026-10-27-issue-304-weak-connection-write-contract.md` (§5.3 and the evidence
  table); body image and About remain, and the new body-image upload test (Test plan) is the
  remaining editor evidence. It supersedes the "and upload pipeline" clause of
  `2026-10-16-story-title-image-design.md` (title image is library-only). Both receive a short
  dated note pointing here.

### Focus

- Publish-gap jump: `hero: kind + 'HeroFile'` → `hero: kind + 'HeroLibrary'`.
  `inspectorApi.reveal()` already opens the closed `HeroDetails` section and focuses the target.
- Title image Remove already focuses its Library button; unchanged.

### `ui.ts` keys removed (DE and EN)

`editor.chrome.heroFile`, `editor.chrome.uploadNotApplied` (only the removed hero/title upload
paths used it), `editor.titleImage.replace`, `.file`, `.upload`, `.processing`, `.uploading`,
`.pickFile`, `.slugRequired`, `.uploadFailed`. (Hero section chrome is literal English in
`editor.html` and has no keys.)

## 2. Hero "Suggest alt text": removed

- Remove `#deHeroSuggest` / `#enHeroSuggest` and their two `AltSuggest.wire` calls.
- Keep `AltSuggest.wire` for `#deBodyImgSuggest` / `#enBodyImgSuggest` and `alt-suggest.js`
  unchanged. The title image never had one; nothing changes there.
- Hero alt input remains editable and is collected by `buildPayload()` as today.

## 3. Excerpt help text and the AI disclosure

### Removal

`#deExcerptHelp` / `#enExcerptHelp`, their `textContent` assignment, the Excerpt textareas'
`aria-describedby`, and `editor.chrome.excerptHelp` (DE/EN).

### Disclosure decision: **move it onto the Generate action**

The removed help was the only statement that **Generate excerpt with AI** sends unsaved text to a
possibly remote, paid provider. Article translation and Story review disclose at the action: a
visible statement plus `aria-describedby` on the button that calls the model. The excerpt assist
follows the same pattern inline:

- `EditorExcerpt` renders a short muted note as **its own line directly under the action row**
  (Generate · Cancel), before the status region:
  `<p class="excerpt-assist__note" id="excerpt-disclosure-<locale>">`. The Generate button gets
  `aria-describedby="excerpt-disclosure-<locale>"`. Accessible name stays "Generate excerpt with
  AI"; description = the note. Cancel appearing during a run does not move the note (no layout
  jump); the inspector is never wide enough for the note to sit beside the button.
- New key `editor.chrome.excerptDisclosure` (added to `EditorExcerpt`'s required `COPY_KEYS`):
  - EN: "Sends this language’s unsaved title and story to the Story Review provider. Charges
    may apply."
  - DE: "Sendet den ungespeicherten Titel und Text dieser Sprache an den Story-Review-Anbieter.
    Kosten können entstehen."
  The copy is accurate to the payload (`LLM.suggestExcerpt` receives locale, title and
  markdown plus the configured guidance) and names where the provider is configured.
- Outcome stated plainly for the owner: a visible sentence remains under the Excerpt, now
  below the Generate button instead of between the field and the button, shorter, and attached
  to the action rather than to the field. The Excerpt textarea no longer carries an AI
  description on every focus. This is the only option consistent with `DESIGN.md` "Help": a
  privacy disclosure stays visible, after the controls.

Rejected alternatives: **dropping** the disclosure (excerpt would be the only text-sending AI
action without one); **`title` tooltip / visually hidden description only** (invisible to
sighted keyboard and touch users, and `title` is not reliably exposed — WCAG 1.3.1/1.4.13
risk); **first-run confirmation step** (new behaviour and friction outside the issue's scope).

## 4. Waypoint stop row

### Current DOM (per `.stop-row`, 3-column grid)

name · remove / lat · lng / `.stop-lookup` (Find coordinates button, status, results) /
`.stop-routing` (Via point, Continue by + select or "Last stop…" text, profile note).

### Target DOM and CSS

```
.stop-row  (grid: 1fr 1fr var(--control-h-sm); unchanged columns)
  input.stop-name   (1 / 3)        button.btn-remove (3, row 1)
  input.stop-lat    (1, row 2)     input.stop-lng    (2 / 4, row 2)
  div.stop-controls (1 / -1)  display:flex; flex-wrap:nowrap; align-items:center; gap:.5rem (Amendment A)
     button.stop-search          ← WaypointLookup
     label.stop-via-field        ← StopRouteEditor.decorateRow
     label.stop-leg-field        ← decorateRow (hidden on the last stop)
     span.stop-last              ← decorateRow (shown on the last stop, same slot)
  p.stop-profile-note    (1 / -1; [hidden] → display:none)      ← decorateRow, right after controls
  p.stop-search-status   (1 / -1; :empty → display:none)        ← WaypointLookup
  div.stop-search-results(1 / -1; grid; :empty → display:none)  ← WaypointLookup
```

- `addStopRow()` creates `.stop-controls` and passes it to both modules:
  `WaypointLookup.attach({ row, controls, … })` puts the button in `controls` and status/results
  in `row`; `decorateRow(controls, routing)` (its unused `row` parameter dropped) puts via/leg/last in `controls` and inserts the
  note directly after `controls`, so the warning stays next to the select it describes. Row
  order: controls → note → status → results. The `.stop-lookup` and `.stop-routing` wrappers are
  removed (their CSS too); no other caller exists. The line itself is laid out by Amendment A
  (one line, no wrapping).
- Focus order: unchanged for name, lat, lng and Remove (Remove stays after lng in the DOM while
  drawn in row 1, as today). Then Find coordinates, Via point, Continue by select, then result
  buttons — matching the visual order of the controls line and the results below it. Results
  can no longer sit between the button and the checkbox. Result pick still focuses lat
  (unchanged).
- Spacing: the row's 0.5rem grid gap replaces `.stop-search-status` margin-block and
  `.stop-search-results` margin-top; empty status/results take no grid row.
- Labels inside `.stop-controls` get `margin: 0` with a selector that outranks
  `body.editor-page .editor-inspector label`, so the Via label is vertically centred beside the
  button. The Via label gets `min-height: var(--control-h-sm)` (44px under coarse pointer),
  which costs no line height beside the 44px button and select, and keeps a near-miss off Find
  coordinates (which sends the place name out).
- Width reality: superseded by Amendment A below (owner chose a one-line form).
- Coarse pointer: buttons and the select use `--control-h-sm` (2.75rem under
  `pointer: coarse`); the checkbox keeps its 1.5rem coarse box inside the label row.
- Unchanged: `rowValues()`, `syncRows()` (both use `row.querySelector`, independent of
  placement), `aria-describedby="stopRouteViaHelp"`, select `aria-describedby` → its note id,
  `aria-invalid`, copy, `collectStops()`.
- `2026-11-03-issue-513-stop-routing-design.md` contains no row-layout statement (checked: it
  defines data, normalization, "the editor shows 'Last stop'" — still true); no update needed.

### Amendment A — one controls line (owner decision, 2026-11-11, during PR #572)

Asked whether the wrapped form was acceptable, the owner put the merge on hold and chose
"icon button + visually hidden Continue by label" from three options. The other two were
shorter visible copy, or keeping the wrap.

- **Measured** in the running editor: the controls line is 280px wide (inspector 19.5rem) and
  256px below ~1310px viewports (18rem). The items needed 435px: Find coordinates 119 · Via
  point 80 · "Continue by" 76 + select 120, plus 16px gaps.
- **Find coordinates** becomes a square icon button the size of the × remove
  (`--control-h-sm`: 30px fine, 44px coarse). It draws a magnifier in the editor's stroke style
  (inline SVG, `aria-hidden`, fixed markup, no interpolation). Its accessible name is
  `aria-label` = `editor.waypoint.search` ("Find coordinates"), and `title` repeats it as the
  hover tooltip. During a lookup the button's `aria-label`/`title` switch to `searching`
  instead of its text, as before; the button is disabled as today. The class stays
  `btn-secondary stop-search`.
- **Continue by** stays in the DOM as the select's `<label>` text, so the select's accessible
  name is unchanged. The text gets the existing `.visually-hidden` utility. The select gets
  `title` = "Continue by" as a hover hint. Its `aria-describedby` to the profile note keeps
  priority for the description. Options and copy are unchanged: no `ui.ts` change.
- **CSS (the line cannot wrap):**
  - `.stop-controls` uses `flex-wrap: nowrap` and a 0.5rem gap.
  - The search button and the Via label are `flex: none`.
  - The Continue by label and its select are the item that **absorbs any shortfall**:
    `flex: 0 1 auto; min-width: 0` on both. The select may shrink and ellipsize its option
    text (`admin.css` select ellipsis); it never pushes anything to a second line.
  - `.stop-last` gets `flex: 1 1 0; min-width: 0; line-height: 1.25`, so "Last stop: no
    further leg." wraps inside its slot.
  - The dead `min-width: 9.5rem` on the select is removed. It never applied in the editor,
    because `body.editor-page select { min-width: 0 }` outranks it.
- **Expected widths** (select at its intrinsic ~120px):
  - Fine pointer: 30 + 8 + 80 + 8 + 120 = 246px. It fits at 280 and 256 with no shrink.
  - Fine pointer with a classic always-visible scrollbar (about 8–11px; ~245px at the 18rem
    inspector): the select gives up a few px and stays on the line.
  - Last stop: the text wraps to two short lines inside its slot when the line is under
    ~277px. That row's controls line is then about two text lines high (~33px at
    `line-height: 1.25`), not one control high. This is accepted: the line itself never
    breaks.
  - Coarse pointer: 44 + 8 + 88 + 8 + 120 = 268px. That fits the phone drawer (280px line at
    a 320px viewport, 336px at 375px). On a touch desktop with a 256px line, the select
    shrinks to ~108px.
- **Trade-off accepted by the owner:**
  - The visible words "Find coordinates" and "Continue by" are gone. The icon, tooltips and
    accessible names carry them; the Via point label stays visible.
  - Known risk: the select can read as belonging to Via point. Nothing visible says the
    mode applies to the leg to the next stop, and the tooltip is mouse-only. Fixing that
    would need a new visible note (a `ui.ts` key), which the chosen option excludes. Recorded
    for the owner.
- **Unchanged:** DOM order and focus order, `rowValues()`, `syncRows()`, the
  `stopRouteViaHelp` link, select ↔ note, lookup behaviour, and the routing values. No copy
  change: the lookup's busy label moves from text to `aria-label`/`title`.
- **Verification:**
  - Tests:
    - The button keeps its icon and has no visible text. Its `aria-label`/`title` are checked
      at first render, after an input reset, while a lookup is pending (`searching`, disabled),
      and after success and after failure.
    - The select's label text is "Continue by" with `.visually-hidden`, and the select has
      `title` "Continue by".
    - The existing order and routing tests still pass.
  - Browser: the controls line never wraps (search, Via and select tops are equal) on middle
    and last stops at:
    - 1440px (280) and 1280px (256), fine pointer;
    - 1280px with an 11px gutter simulated for an always-visible scrollbar;
    - 375px (328px line) and 320px (280px line), coarse pointer.
    Zero overflow in every case, and the lookup still works.
- **Docs and tracker updates:**
  - The `DESIGN.md` stop-row bullet, `docs/authoring-workflow.md` "Find waypoint coordinates"
    (the magnifier button), and the `project-status.md` entry describe the one-line form.
  - Tracker rows A6 and I3 are restated: I3 becomes "DOM placement, CSS and the lookup
    button's accessible-name mechanism; no copy or routing change".

## Docs to update

- `DESIGN.md` (admin): hero/title image bullet (no Replace disclosure, no upload), excerpt
  disclosure placement, stop-row line; title-image paragraph (~L790-794 "media picker, upload
  and framing controls").
- `docs/authoring-workflow.md`: Stage 1 hero note (point to Media instead of the old `/admin/`
  upload page, which is now the Desk), "Replace photo" sentence, title-image "or upload", field
  table rows, library history note, quick checklist (~L979).
- `ARCHITECTURE.md` "AI alt-text": "per alt field" → body photos and media library, not hero.
- `uploader/README.md`: excerpt section mentions the action-level disclosure; "Hero/body fields"
  refusal sentence (~L659) → body fields.
- `2026-10-27-issue-304-weak-connection-write-contract.md`, `2026-10-16-story-title-image-design.md`:
  dated supersede notes (see section 1).
- `docs/claude/project-status.md`: status entry.
- The 2026-07-05 alt-text plan/spec are dated historical documents and stay as written.

## Rollback

Client-only change (static admin files + `ui.ts` copy). Reverting the PR restores the upload
controls, hero Suggest, Excerpt help and the old stop-row DOM; no data, schema, API or stored
routing value changes in either direction.

## Test plan

Automated (`uploader/test/editor-dom.test.ts` unless noted):

- Replace "inline upload snapshot adoption" hero/title upload cases with a library-only test:
  per locale, hero and title sections contain no `input[type=file]`, no upload or suggest
  button, keep the library button; a library pick sets src, prefills an empty alt, keeps a
  typed alt; hero alt edits reach `buildPayload()`.
- Body-image upload (new, resolves review B1): drive `#deBodyImgUpload` through the harness
  `upload` seam; assert exactly one `UploadRecovery.run` call with the editor owner and
  `fields.key = trips/<slug>/<file-slug>`, the image inserted in the manuscript with
  `images[src]` recorded; and a second case where the account changes while the upload is
  pending (`recovery.observeOwner(other)`) inserts nothing.
- Suggest wiring (resolves B1): the harness records `AltSuggest.wire` calls; assert exactly two,
  for the DE/EN body-image button/file/alt elements, and none for hero elements.
- Focus test: missing-hero jump focuses `enHeroLibrary` with `enHeroDetails` open.
- Rewrite "opens Replace photo on load…": library buttons visible for set and missing images;
  thumbnails; Remove hides itself and focuses the library button.
- ID references (I5): every `aria-describedby` token and every `label[for]` in the loaded
  editor (including generated stop rows and excerpt assists) resolves to an existing element.
- Excerpt: textarea has no `aria-describedby`, no `#xxExcerptHelp`; in `editor-excerpt.test.ts`
  the Generate button's `aria-describedby` resolves to a visible note with the disclosure copy
  in each locale view.
- Stop rows: controls line children are `[stop-search, stop-via-field, stop-leg-field,
  stop-last]`; row order controls → note → status → results after a lookup; existing routing
  round-trip, stale/fresh, and disabled-provider tests keep passing.
- `ui.ts` orphans (A7): no automated orphan check exists; the PR records a per-key grep for
  every removed key (no remaining reference) and for the added key (used).
- Full: `npx tsc --noEmit` + `npm test` (uploader; integration suites with `TEST_DATABASE_URL`
  against a disposable local Postgres), `npm test` + `npx astro check` (site).

Browser (real local stack, managed browser profile, both locales): hero set/change from
library; no file input/upload; hero alt edit → save → reload persists; title image pick +
remove; missing-hero publish-gap jump focuses library button; excerpt (no help, note visible,
accessible description, busy state with Cancel does not move the note); body-image upload +
Suggest alt present and working; stop rows (middle + last), lookup status/results below,
profile note, save → reload → identical routing values; desktop, narrow inspector, ~375px and
320px with measured `scrollWidth ≤ clientWidth` for every stop row and the excerpt assist,
coarse-pointer target sizes; keyboard order and focus ring; no console errors. Screenshots stay
local (Golden Rule 5).

## Scoped exception record

- **Waived rule:** the human design-approval pause before implementation in this workflow.
- **Replacement:** independent AI design approval (fresh-context reviewer agent).
- **Reason:** owner-requested workflow automation.
- **Risks:** reviewer blind spots; shared-model bias between author and reviewer.
- **Compensating controls:** adversarial independent reviewer; re-review of any material design
  change; `/review` on the PR; required CI; owner review before merge.
- **Approver:** Simon (owner), 2026-11-11, scoped to issue #569 only.
- **Expiry:** when the PR completes (merged or closed) or the work is abandoned.
- This exception does not relax any other repository rule.

## Independent AI design approval

### Round 1

- **Reviewer:** fresh-context `reviewer` agent, model `anthropic/claude-fable-5-2` (as reported
  by the runtime and the agent session log; provider `anthropic`, model `claude-fable-5-2`).
  Inputs: the issue, this document, the relevant file paths.
- **Verdict:** CHANGES REQUIRED (confidence 0.85).
- **B1 (blocking)** — A2 had no automated coverage: no test drives `*BodyImgUpload`; the upload
  seam was only used by the two removed hero/title cases; `AltSuggest.wire` is a no-op stub, so
  losing the body wiring fails nothing; the #304 contract cites the removed cases as evidence.
  **Resolution:** Test plan adds a body-image upload case (owner, key, insert, `images[src]`, no
  insert after an account change) and a recorded-`wire` assertion (exactly the two body
  wirings); plan sentence corrected; #304 spec gets a dated consumer note.
- **N1** excerpt note vs Cancel → note is its own line under the action row (section 3).
- **N2** label margin → reset inside `.stop-controls` with sufficient specificity (section 4).
- **N3** Via touch target → `min-height: var(--control-h-sm)` (section 4).
- **N4** profile note order → inserted right after the controls line (section 4, test plan).
- **N5** focus-order sentence → corrected (section 4).
- **N6** owner-visible outcomes → stated in sections 3 and 4 and in the PR.
- **N7** copy → "this language's" restored (section 3).
- **N8** docs/comments/spec trail → added to Docs, Dead code, Rollback.
- **N9** evidence → per-key grep in PR; ID-reference sweep test; measured overflow incl. 320px.
- **N10** missing-hero wording → corrected (section 1).
- Accepted by the reviewer without change: removing (not renaming) the disclosure; disclosure
  on the Generate action; `ui.ts` removal list complete; CSS deletions safe (`.hero-file-input`
  kept); no hero/title upload path left; routing invariants; focus retarget; risk Normal; no
  #513 spec update.

### Round 2

- **Reviewer:** same agent and model (`anthropic/claude-fable-5-2`), re-reviewing the revised
  document against the code.
- **Result:** B1 and N1–N10 verified resolved; no new blocking issue.
- **Minor (non-blocking) and handling:** EN copy uses the dictionary's typographic apostrophe
  (adopted, section 3); recorded-`wire` assertion also checks `lang` and `statusEl` per call
  (adopted in the test); Find coordinates reads "Finding location…" during a lookup so Via
  point shifts a few pixels (accepted: existing label behaviour, transient, no overlap).
- **Verdict:** `VERDICT: APPROVED`.

### Round 3 (Amendment A, one-line stop controls)

- **Reviewer:** same agent and model. **Verdict:** CHANGES REQUIRED.
- **B1:** the line had 2–10px slack at 256px and would still wrap with an always-visible
  scrollbar. **Resolution:** `nowrap`; search and Via are `flex: none`; the Continue by
  label and select absorb the shortfall; the last-stop text wraps inside its slot; the browser
  check adds a scrollbar-gutter run.
- **N1–N6 resolutions:**
  - N1: tests cover every button state.
  - N2: the docs and tracker list now covers the amendment.
  - N3: the last-stop height is reworded, with `line-height: 1.25`.
  - N4: phone figure corrected.
  - N5: the dead `min-width: 9.5rem` is removed.
  - N6: the meaning risk is recorded as owner-accepted.

### Round 4

- **Result:** B1 resolved by construction; N1–N6 addressed. **Verdict:** `VERDICT: APPROVED`.
- **Minor items:**
  - Adopted: the per-state test asserts "SVG present, no text" as well as the attributes; the
    375px figure is corrected; rounds 3 and 4 are recorded here; the Target DOM block and
    tracker rows A6/I3 are restated.
  - Declined: `line-height` ≈1.15 for the last stop. Uniform row height isn't a requirement,
    and 1.25 keeps the two short lines legible.

## PR review follow-ups (PR #572)

PR review (fresh `reviewer` agent, verdict APPROVE, five INFO items) — all adopted:

1. `docs/authoring-workflow.md` upload-receipt sentence no longer lists hero/title-image uploads.
2. #304 spec note: "Body image, About and the Media queue" (the picker only browses).
3. Docs no longer say hero alt "is written … in Media": it is typed in the field, and a library
   pick copies the Media alt only into an empty field (`DESIGN.md`, `ARCHITECTURE.md`,
   `docs/authoring-workflow.md`).
4. The hero and title-image **Choose from library** buttons get `aria-describedby` pointing at
   their section summary (`xxHeroLabel`, `xxTitleImageHeading`), so the missing-hero jump
   target announces which image it changes. Accessible description only; no visual, copy,
   layout or behaviour change, so not a material design change (no design re-review needed).
5. `editor-excerpt.test.ts` pins the assist order actions → note → status → suggestion in idle
   and busy states.
