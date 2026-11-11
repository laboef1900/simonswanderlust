# Publish-time language choice and the "Translate" action (issue #568)

**Status: APPROVED (independent AI design review, 2026-11-11; see §12 exception and §13 record).**
Issue: [#568](https://github.com/laboef1900/wanderlust-studio/issues/568) is the requirement
source; this spec records only the decisions it leaves open and the contract the
implementation must keep. It amends §9 of
[the language-mode contract](2026-10-27-issue-283-language-mode-contract.md) (editor coverage
control) and the issue-550 translation spec's coverage rule. Risk class: **High** (language-mode
coverage `posts.omitted`, publish pipeline).

## 1. Scope

In: the story editor (`uploader/public/editor.html`) Publish flow, removal of the per-tab
"Publish this story in …" checkbox, article-translation availability for an omitted secondary,
the Translate button label/icon, one shared admin AI icon, copy in `site/src/i18n/ui.ts`, docs.

Out: the journey editor's own "Publish this journey in …" checkbox (unchanged), the Posts list
bulk publish, every server route and module (`uploader/src/**`, `site/src/lib/**`), the schema,
`posts.omitted` semantics, the publish gate (`validateForPublish`), and any other AI action
(they may adopt the icon later).

## 2. Invariants

1. **The primary always publishes.** The dialog renders the primary checked and disabled. The
   selection is computed as *forced set ∪ checked toggleable rows*, so a forced row's checkbox
   state can never drop it; the client never sends `omitted: true` for the primary (the server's
   400 `invalid_post` stays the backstop, §7.3).
2. **A published secondary can never be deselected.** A locale with publication history
   (`publishedLocales[locale]`, from `publishedAt`) is in the forced set: rendered checked and
   disabled with the `languageCoverageLocked` explanation, and always in the selection. Backstop:
   the server's `409 locale_published`.
3. **What gets published is the selection confirmed in the dialog.** The selection is frozen
   (`Object.freeze`, the `runBulk` pattern in `posts.html`) and the save intent is captured in the
   same synchronous step, **while the modal dialog is still open** (D3). The intent payload's
   `omitted` values are forced from the frozen selection. Nothing typed, toggled or reloaded after
   that step can change what is saved or published. After the save the editor compares the
   server-acknowledged requested set (`savedRequestedLocales`, which `WriteRecovery` can adopt from
   an earlier attempt) with the frozen selection and **does not call publish** if they differ.
4. **Cancel is a no-op.** Cancel, Escape, a gap-jump link and any close that is not the current
   opening's confirmed Publish send no request, do not touch `omitted` and do not mark the draft
   dirty. Cancel, Escape and toggling also leave review/excerpt/translation state alone (a gap jump
   switches locale through the existing `activateLocale`, which invalidates them as any tab switch
   does).
5. **No API, schema or `posts.omitted` semantic change.** `omitted` still persists only through the
   normal draft save payload (`snapshotIntent` → `saveDraftNow` → `WriteRecovery`), and
   `POST /posts/:tk/publish` is unchanged; the server still derives the publishable set from the
   saved rows. The diff touches nothing under `uploader/src/` or `site/src/lib/`.
6. **Published-URL set and slug contract unchanged.** No route, slug derivation, slug lock or
   prefix logic changes. The dialog only displays URLs via the existing `AdminConfirm.liveUrls`.
7. **Author text is text.** Titles, slugs/URLs, field names and language names are rendered with
   `textContent`/text nodes only, never `innerHTML` (today's confirm does the same).

## 3. Decisions

### D1 — Which gaps are checked before the dialog opens

The **forced set** is the primary plus every secondary with publication history. The pre-dialog
gate (the Publish button's disabled state, its tooltip and the click-time check) covers the forced
set and the shared Expedition details. Every deselectable locale is checked in the dialog, for
exactly the locales selected there.

*Rejected:* gating on the currently requested set (primary + every non-omitted secondary). A new
story starts with the secondary requested (`editor.html` sets `omitted` false for enabled
locales), so with the checkbox removed an incomplete secondary would disable Publish and leave no
way to reach the dialog, the only control that can deselect it.

The **Publish checklist** (`#publishChecklist`/`localeChip`, and the narrow-width copy in More
actions) and the alt-text audit keep describing the **intended** set (`requestedLocales()`:
primary + non-omitted secondaries) as an advisory. They never gate the dialog's optional languages.

`populateForm` clamps `omitted` to `false` for the primary and for every published locale, so a
restored revision or local stash cannot reintroduce an impossible coverage value that the gate,
the checklist and the server would disagree about. Restoring a **revision** additionally keeps the
current `omitted` values: they overwrite the snapshot's values **before** `populateForm` runs, so
the tab chips and checklist render the kept coverage; a restore cannot change coverage invisibly.
Restoring the author's own local draft keeps its values (it is their unsaved work).

**Consequences, accepted:** the editor offers no control for coverage other than the Publish
dialog, and Publish is admin-only, so in normal editor use coverage changes when an admin confirms
Publish (authors previously could toggle the checkbox and save). The save API is unchanged and
still accepts `omitted` from any authenticated author; this is UI placement, not an authorization
rule. Changing coverage of a never-published secondary on a live story now happens together with a
publish, so it costs a rebuild. Both follow from moving the choice to the action it controls, which
the issue asks for.

### D2 — The dialog

A static `<dialog id="publishDialog" class="admin-modal publish-dialog">` placed **after
`</main>`** (sibling of `#articleTranslationDialog`), so its `input`/`change` events never reach the
editor's dirty/stash/invalidation listeners. Native modal: focus trap, inert background, Escape.
It contains **no `<form method="dialog">`**: Cancel and Publish are `type="button"` and the dialog's
`returnValue` is never read. Each opening gets a fresh opening token; only the Publish button's
click handler for the current opening can confirm. Every opening rebuilds all rows and checkbox
states from the current form state (`omitted`, `publishedLocales`, titles, slugs, gaps), so an
earlier opening's toggles never persist.

Contents:

- Heading `publishDialogTitle` ("Publish to the live site?"); the intro line `publishDialogIntro`
  ("Choose the languages to publish.") only when at least one row is toggleable, otherwise hidden
  and removed from the dialog's `aria-describedby` (which then names the rebuild notice).
- A `<fieldset>` (no box) with legend `publishDialogLanguages`; one list row per enabled locale in
  `language.locales` order:
  - name (`SiteLanguage.names[locale]`) as the checkbox label in DE+EN, plain text in a
    single-language install (no checkbox, no note);
  - title (or `(untitled)`), resulting URL (`AdminConfirm.liveUrls`, mono, wraps anywhere);
  - a note: primary → `publishDialogPrimary`; published secondary → `languageCoverageLocked`;
    toggleable secondary → `languageCoverageHelp`;
  - a readiness line: selected & complete → `publishDialogReady`; selected with gaps →
    `publishDialogMissing` ("Missing: title, excerpt") plus one link-style `type="button"`
    (`publishDialogFix`, "Go to {field}", accessible name `publishDialogFixName`, "Go to {field} in
    {language}", which starts with the visible text) that closes the dialog as a cancel and runs
    the existing `jumpToGap(locale, firstGap)`; not selected → `publishDialogPrivate`.
  - Every checkbox (enabled or not) is `aria-describedby` its note and its readiness line.
  - Toggleable secondary checkbox default: `checked = !omitted[locale]`.
- A polite live status line (`role="status"`), empty when Publish is enabled, otherwise
  `publishDialogBlocked` naming the incomplete selected languages; also used for a flush error.
- The rebuild notice `publishDialogRebuild` (today's wording).
- Footer: **Cancel** (`btn-secondary`, first) and **Publish** (`btn-publish`, the red publish tone
  of today's `tone: 'publish'` confirm). Publish is `disabled` while any selected language has gaps
  and is `aria-describedby` the status line.

Single-language install (DE-only, EN-only): the same dialog with one row and no checkbox. One code
path in all four modes.

### D3 — Confirmation sequence

1. `publishBtn` click. Ignored while the `publishFlow` latch is set. Existing guards (load blocked,
   `gpxEditor.guardAction()`, `publishVersion()`), plus a click-time `writeRecovery.unresolved()`
   refusal with the new `publishUnresolved` message (as the GPX path does; it is not part of the
   button's disabled state, which `WriteRecovery` does not re-render), then the forced set +
   Expedition details gap check. Set the latch; open the dialog with a new opening token.
2. **Any** `close` of the dialog not issued by step 4 — Cancel, Escape, a gap jump, a
   browser-forced close — retires the opening token and clears the latch, in every phase including
   busy; focus returns to `publishBtn` (gap jump: the field). Nothing else happens.
3. Publish click (current token only): mark the language choices busy (`aria-busy` on the fieldset, so the status line outside it stays audible; all checkboxes disabled;
   Publish keeps focus but is `aria-disabled` and ignores clicks, so a repeated key press can neither
   confirm twice nor land on Cancel; the status line reads `publishDialogChecking`; **Cancel and
   Escape stay available and cancel**), `await
   flushGalleryEdits()`. On failure, and only if the dialog is still open with the same token: show
   the error in the dialog status line, leave busy state, return focus to Publish, change nothing;
   the author may retry or cancel.
4. On success, **one synchronous step**: require the dialog still open, the token still current,
   the editor still loaded and `writeRecovery.unresolved()` false (otherwise: a retired token or
   closed dialog is a cancel; an unresolved state shows `publishUnresolved` in the dialog status and
   leaves busy state, changing nothing); freeze `selection = forced ∪ checked toggleable` (in
   `language.locales` order); re-check the selected locales' gaps — on failure re-render the rows,
   stay open, focus the first enabled checkbox, change nothing; apply the selection to `omitted` for enabled locales and mark dirty
   only if a value changed; `updateLocaleChip()`; `snapshotIntent()`; force
   `intent.payload[locale].omitted = !selection.includes(locale)` for every enabled locale; retire
   the token; close the dialog (this close keeps the latch); focus `publishBtn`.
5. `enqueueWrite(() => publishNow(intent, reviewedRouteVersion, selection))`; clear the latch when
   it settles (`finally`).
6. `publishNow`: `saveDraftNow(intent)` → if false, stop → if `savedRequestedLocales` is not exactly
   the selection, `publishSelectionMismatch` and stop → `POST /posts/:tk/publish` (unchanged body)
   → on success mark `publishedLocales` for the frozen selection. The second `AdminConfirm.ask` is
   removed: the dialog is the confirmation.

### D4 — Translation and an omitted secondary

Translation is **allowed** into or from an omitted secondary. Publication is a separate,
publish-time choice, and applying a translation never saves or publishes (issue-550 rule kept).
`EditorTranslation.eligible()` drops both `omitted` conditions; it still requires two enabled
locales, both direction locales enabled and no blocking state. When the target is omitted the
dialog shows `translationPrivateDraft` in `#translationDraftNote` (a plain paragraph, hidden otherwise).
`translationCoverage` is deleted; the remaining ineligible path (a blocking save/load state that
arose after the trigger was enabled) shows the new `translationUnavailable`. The snapshot keeps
`omitted`, so a publish confirmed mid-translation still invalidates the request and Undo, as any
save does today.

### D5 — The Translate button and the shared AI icon

- Visible label `translationAction` = **Translate** (DE `Übersetzen`); `aria-label` from new
  `translationActionName` = **Translate with AI** (DE `Übersetzen mit KI`). Both start with the
  visible word (WCAG 2.5.3 label-in-name).
- Built by `editor-translation.js`: `button#translateArticle.btn-secondary.btn-sm.btn-icon` ›
  `AdminIcons.ai()` + `span.btn-icon__label`. `aria-haspopup="dialog"`/`aria-controls` unchanged.
- `admin-ui.js` gains `window.AdminIcons.ai()`: a fresh `<svg>` built with `createElementNS` (no
  `innerHTML`), `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="2"`,
  round caps/joins, `aria-hidden="true"`, `focusable="false"`, class `admin-icon`. Original sparkle
  geometry (one four-point star plus one small star) drawn for this project, so no third-party
  icon licence is introduced.
- CSS: `.admin-icon` 1rem square, `flex: none`; `.btn-icon` inline-flex, centred, `gap: 0.375rem`,
  `white-space: nowrap`. `#translateArticle` keeps the command bar's **2rem height on every
  pointer** (owner decision 2026-11-10, `DESIGN.md` command-bar controls); only the existing narrow
  overrides (`white-space: normal`, the phone font/padding rule) are replaced so icon + "Translate"
  stay on one line and never overlap the absolutely positioned `#inspectorToggle` in the nav row,
  down to 320 CSS px and at 200% text size.

## 4. Behaviour in the four language modes

| Mode | Rows | Primary | Secondary |
|---|---|---|---|
| DE+EN, DE primary (live site) | Deutsch, English | Deutsch locked on | English: locked on if published, else toggleable (default `!omitted.en`) |
| DE+EN, EN primary | English, Deutsch | English locked on | Deutsch: as above |
| DE-only | Deutsch, no checkbox | always published | none; the disabled EN row stays `omitted: true` in the payload, untouched |
| EN-only | English, no checkbox | always published | none; DE row untouched |

The selection is applied only to enabled locales; a disabled locale's stored `omitted` value is
sent unchanged (today's behaviour). The Translate button stays hidden unless two locales are
enabled.

## 5. Trust boundaries and misuse cases

The dialog is client-side UX for an admin-only, already-authenticated route. Every rule above is
re-enforced on the server; the client adds no new trust.

| Case | Behaviour |
|---|---|
| Crafted request omitting the primary / a published secondary | Server 400 `invalid_post` / 409 `locale_published`; DB CHECK `posts_omitted_unpublished` (unchanged). |
| Author-written title/slug containing markup | Rendered as text (invariant 7); no element is created. |
| Stale tab: the secondary was published elsewhere after load | Dialog shows it toggleable; deselecting sends `omitted: true` → the save is refused (409 `locale_published`, or the stale-`baseUpdatedAt` conflict) → publish not sent; the error is shown; reload shows the lock. |
| Stale tab: language mode changed elsewhere | The draft save carries no language token, so it can succeed under the server's current mode; publish then gets the existing 409 from `baseLanguageUpdatedAt`. If the save's acknowledged requested set differs from the selection (e.g. the secondary was disabled), the acknowledged-set check stops before publish. |
| Unresolved save state (comparison pending, unknown outcome, other account) | Publish refused at the click with `publishUnresolved` (D3 step 1) and re-checked in step 4, like the GPX write path. |
| Double click / double submit | `publishFlow` latch ignores further `publishBtn` clicks; the dialog's busy state ignores further Publish clicks; `enqueueWrite` serialises writes; `publishBtn.disabled` during the build (unchanged). |
| Reused dialog / Escape after an earlier confirm | No `returnValue`, no `method="dialog"`; consent is the current opening's Publish click only. |
| Edits after confirmation (typing while the save is queued or running, slug-change confirm) | Excluded: the intent was captured, with `omitted` forced from the frozen selection, in step 4 while the dialog was still open. Later edits stay visibly unsaved (existing #362 rule). |
| Dialog closed during the gallery flush (Cancel, Escape, browser-forced close) | The close retires the token; when the flush settles step 4 finds no current opening and does nothing: no `omitted` change, no save, no publish. |
| Gallery flush fails | Dialog stays open with the error; nothing changed; focus returns to Publish. |
| Save fails or is cancelled after confirmation (network, 409, slug-change confirm cancelled) | No publish request. The confirmed selection remains as an unsaved, dirty form state (it is what the author chose); the next Save or Publish persists or revisits it. Nothing live changes. |
| Save succeeds but the acknowledged requested set ≠ selection | No publish request; `publishSelectionMismatch`. |
| Publish refused after the save (gate, foreign images, conflict, language) or build fails | Saved draft keeps the chosen `omitted`; live site unchanged or reported by `BuildReporting` as today. Recovery: fix, Publish again (the dialog reflects the saved state). |
| Author-role session | Publish stays hidden for non-admins (unchanged); the route stays admin-only. |

## 6. Failure handling, recovery and rollback

- Every failure path ends with the latch cleared, Publish re-enabled (`finally`) and an error in
  the existing status row or the dialog status line; no path leaves a partial publish because
  publish is one server call after a completed, verified save.
- `omitted` changes are draft state and reversible: a never-published secondary can be re-selected
  at the next Publish.
- **Rollback:** revert the PR (client files, copy and docs only). No migration, no data change,
  no dump-version change; the previous editor reads and writes the same `omitted` field. A deployed
  release can be contained by redeploying the previous image tag.

## 7. Accessibility

- Native modal `<dialog>`: focus trap and inert background; `aria-labelledby` the heading,
  `aria-describedby` the intro; `aria-busy` on the language fieldset while flushing.
- Initial focus: the first enabled (toggleable) checkbox; otherwise Publish. While busy, focus stays
  on Publish, which is `aria-disabled`, and the live status line announces `publishDialogChecking`.
  Cancel/Escape focus `publishBtn` explicitly; a gap jump focuses the
  field (existing `jumpToGap`). The translation dialog adds `#translationDraftNote` to its
  `aria-describedby` while the note is shown.
- No form submission exists, so Enter on a checkbox does nothing; Space toggles.
- Every checkbox is described by its note (why it is locked or what deselecting means) and its
  readiness line. The disabled Publish button is described by the status line, which is also a
  polite live region updated on every toggle (text present at opening is reachable through the
  description and through the focused checkbox's readiness line).
- "Go to" buttons name their language (2.5.3-compliant: the accessible name starts with the visible
  text).
- Colour is never the only cue: readiness and private-draft states are words; an excluded row's URL
  is muted *and* its state reads "Stays a private draft".
- Translate: icon `aria-hidden`/`focusable="false"`; name "Translate with AI".
- Touch: checkboxes 24px under coarse pointer (existing rule); footer buttons full width below 40rem.

## 8. UI design notes (Editorial Desk)

Quiet operating surface, reusing `dialog.admin-modal`, `.admin-modal__foot`, `.check-field`,
`.help`, `.btn-publish`, `.btn-secondary`, hairline `--line` dividers, IBM Plex Mono for URLs. The
fieldset draws no box (DESIGN.md "Sections"). Rows are flat, hairline-divided; no cards, pills,
badges or decorative elements. Width: `min(36rem, 100vw - 2rem)`; the body scrolls inside the
viewport on short screens. Gaps use the readiness chip's existing incomplete colour with text. The
icon is a 1rem stroke glyph in `currentColor`, matching the model-reload and shell icons.

## 9. Copy (`site/src/i18n/ui.ts`, both dictionaries)

Removed: `languageCoverageLabel`, `translationCoverage`.
Kept and reused: `languageCoverageHelp`, `languageCoverageLocked`.
Changed: `translationAction` → "Translate" / "Übersetzen".
Added: `translationActionName`, `translationUnavailable`, `translationPrivateDraft`,
`publishDialogTitle`, `publishDialogIntro`, `publishDialogLanguages`, `publishDialogPrimary`,
`publishDialogReady`, `publishDialogMissing`, `publishDialogFix`, `publishDialogFixName`,
`publishDialogPrivate`, `publishDialogBlocked`, `publishDialogChecking`, `publishDialogRebuild`,
`publishDialogConfirm`, `publishDialogCancel`, `publishSelectionMismatch`, `publishUnresolved`. Final wording is in `ui.ts`; the completeness
test pins both dictionaries, and ED asserts that every added or kept key is rendered.

## 10. Documentation impact

Language-mode contract §9 (and a §7.3 pointer), issue-550 spec coverage sentence, `DESIGN.md`
(language-chip and Translate paragraphs), `docs/claude/project-reference.md` (translation line),
`uploader/README.md` (Translate line), `docs/claude/project-status.md`. `SECURITY.md` is
**reconfirmed unchanged**: no route, authorization, data-flow or AI-credential change.

## 11. Verification plan and acceptance tracker

The single shared tracker. Every agent updates this list in place; evidence names a test, a
browser step or a CI check. `uploader/test/editor-dom.test.ts` is **ED**,
`uploader/test/editor-gpx.test.ts` is **EG**. ED/EG load the real `admin-confirm.js` `liveUrls`
for URL assertions. **PD** is the ED suite `publish dialog: languages are chosen where the story
is published (#568)`; **TR** is the ED suite `explicit article translation of the current unsaved
pair`. A ticked sub-item is implemented with its test written; the suites are run by the
integration owner (AC9).

- [x] **AC1** No coverage checkbox on the secondary tab — ED: no `deIncluded`/`enIncluded`/
  `*Coverage*` element exists in any mode; browser B1.
  - [x] ED — PD › `offers no publication checkbox in a language tab ($primary primary, $locales)`
    (all four modes).
  - [x] browser B1 (no `[id$=Included],[id$=Coverage]` element on the editor page).
- [x] **AC2** Dialog lists each enabled language with title, exact URL, readiness; primary fixed;
  published secondary locked; unpublished secondary toggleable — ED dialog-state tests in all four
  modes with exact URLs; browser B1, B4, B8.
  - [x] ED — PD › `lists both languages with title, live URL and readiness: the %s primary fixed,
    the secondary a choice` (DE+EN, both primaries), `locks a secondary that has been live and says
    why (%s primary)`, `shows one row and no checkbox in a %s-only install, and publishes it`
    (DE-only, EN-only); ED › `locks only the locale with publication history, even after
    whole-story unpublish`.
  - [x] browser B1, B4, B6, B8 (screenshots: DE+EN DE-primary, published EN locked with its
    explanation, DE-only one row, EN-primary with DE toggleable).
- [x] **AC3** Unchecked → only primary published, secondary private draft with content kept;
  checked → both — ED payload/request tests; browser B1, B2 + DB check of `omitted`/`status`.
  - [x] ED — PD › `publishes only the %s primary when the secondary is unchecked, keeps that draft
    private, and publishes both once it is checked` (both primaries, against `memoryPostStore`).
  - [x] browser B1 (`PUT` then `POST …/publish`; DB `de published/omitted f`, `en draft/omitted t`
    with its body kept; `/testreise-568-eins/` 200, story absent from `/en/`), B2 (EN completed and
    checked: both rows `published`, `/en/test-trip-568-one/` 200), B8 (EN-primary, DE unchecked:
    `/english-first-568/` 200, DE row `draft/omitted t`, absent from `/de/`).
- [x] **AC4** Cancel → no save, no `omitted` change — ED (Cancel, Escape, gap jump, each after
  firing `input` and `change` on a toggle: zero POST/PUT, payload, dirty state and stash
  unchanged); browser B3 + DB check.
  - [x] ED — PD › `changes and sends nothing on %s, even after a language was toggled` (cancel,
    escape, gap jump), `ends an open dialog like Cancel when the form it describes is replaced`.
  - [x] browser B3: Escape, Cancel, toggle → Cancel → reopen (saved default re-shown), Enter on the
    focused checkbox (dialog stays open, nothing submitted): zero PUT/POST in the network log,
    status "Saved to server" unchanged, DB `omitted`/`updated_at` unchanged; focus back on Publish.
- [x] **AC5** Gap checks exactly the selected languages — ED (forced-set gate enables Publish with
  an incomplete optional secondary; dialog blocks while it is selected, unblocks when deselected;
  gap jump closes and focuses the field after `flushDialogEvents()`); browser B5.
  - [x] ED — PD › `lets a %s-primary story with an unfinished secondary reach the dialog, which
    checks exactly what is selected` (both primaries), `rechecks the selected languages at
    confirmation and stays open when one has lost a required field`.
  - [x] browser B5: Publish enabled with an incomplete EN; dialog shows "Missing: slug, excerpt,
    country, hero", Publish disabled with "Complete or deselect English to publish."; unchecking
    English enables Publish; "Go to slug" (name "Go to slug in English") closes the dialog and
    focuses `slugFieldEn`.
- [x] **AC6** Translation for an omitted secondary decided, implemented, copy updated — ED
  (translation runs with omitted target, note shown and announced; `translationCoverage` removed from `ui.ts`).
  Evidence: TR › `hides single-language targets, and translates into or from a language that is
  not selected for publication`, `aborts and ignores late output after a coverage change`
  (a publish confirmed mid-translation); `translationUnavailable` in PD › `renders every copy key
  the issue adds or keeps`. Browser: Translate on the EN-primary story with DE unselected opens
  "Translate English to German" with the private-draft note; only `POST /translation/prepare` and
  `GET /ai-config` were sent (no model call).
- [x] **AC7** "Translate" + AI icon, accessible name "Translate with AI" — ED (label text,
  `aria-label`, `svg[aria-hidden=true][stroke=currentColor]`); browser B7.
  - [x] ED — PD › `labels the trigger “Translate”, leads it with the shared AI icon and names it
    “Translate with AI”`.
  - [x] browser B7: label "Translate", `aria-label` "Translate with AI", 16px `svg[aria-hidden]`
    in `currentColor`; height 32px at 1440/832/390/320 px and with emulated coarse pointer; one
    line, no horizontal scroll and no overlap with `#inspectorToggle` at every width and at 200%
    text. (Pre-existing, unchanged by #568 and identical with `dev`'s `admin.css`: at ≤390px *and*
    200% text, the Details toggle overlaps the locale tab strip.)
- [x] **AC8** `ui.ts` complete, no orphans; README and §9 updated — `site` `ui.test.ts`; ED asserts
  each added/kept key is rendered; grep shows no caller of removed keys; docs diff.
  - [x] ED — PD › `renders every copy key the issue adds or keeps` (21 added/kept keys) and the busy test for
    the 22nd, `publishDialogChecking`; no
    caller of `languageCoverageLabel`/`translationCoverage` is left in `uploader/public/`.
  - [x] `site` `npm test` (incl. `ui.test.ts`) green; README, contract §9/§7.3, issue-550 note,
    `DESIGN.md`, `project-reference.md` updated in this branch.
- [x] **AC9** Tests + checks — `uploader`: `npx tsc --noEmit`, `npm test` with
  `TEST_DATABASE_URL` (integration suites not skipped); `site`: `npm test`, `npx astro check` with
  `DATABASE_URL`. Evidence (rebased on `dev` eca8fa9, disposable PostgreSQL 18, native ownership
  addon built, `pg_dump` 18.6 on PATH): `tsc` clean; uploader 183 files / 5310 tests, none
  skipped — all passed except one busy-focus assertion that the second review fix changed, after
  which `editor-dom.test.ts` passed in full; site 56 files / 934 tests passed; `astro check` 155
  files, 0 errors/warnings/hints. CI reruns both required checks on the final commit.
- [x] **AC10** Visual verification desktop + narrow — browser B1–B8 screenshots (dialog at 1440,
  390 and 320×568 px — scrolls within the viewport, full-width footer buttons, no horizontal
  overflow; coarse pointer: 24px checkboxes, 44px footer buttons). Impeccable detector: only
  pre-existing findings (dynamically filled images, mandated Inter, unresolved stylesheet paths).
- [x] **INV1/INV2** With a forced row's checkbox programmatically unchecked, the PUT still sends
  `omitted: false` for the primary and the published secondary — ED against `memoryPostStore`;
  server refusals of crafted payloads — existing `posts` tests (named in evidence).
  Evidence: PD › `always saves and publishes the primary and a published secondary, whatever their
  checkboxes say`. Server backstop (unchanged): `posts-language.test.ts` › `rejects primary
  omission and ignores forged publication history` (400 `invalid_post`), `keeps un-omit + Save
  private until successful Publish and freezes history after unpublish` (409 `locale_published`);
  `language-mode.integration.test.ts` › `keeps requested %s-secondary coverage private and
  atomically rolls back failed gates`, `enforces omission at the database boundary for status,
  snapshots and publication history`.
- [x] **INV3** Published selection = confirmed selection — ED: with a queued earlier save holding
  the write queue, edits to title and `omitted` after confirmation are absent from the PUT; with a
  held gallery flush, the dialog stays open and busy and confirms only after the flush; an
  acknowledged-set mismatch sends no publish.
  Evidence: PD › `saves and publishes what was confirmed, not what the form holds by the time the
  write queue reaches it`, `stays open and busy while a gallery description settles, and confirms
  only once it has`, `does not publish when the acknowledged save requests other languages than
  were confirmed`.
- [x] **BUSYCLOSE** With a held gallery flush, Cancel, Escape and `close()` (both before and after
  `flushDialogEvents()`) each end the flow; after the flush is released there is zero POST/PUT and
  `omitted`/dirty state are unchanged — ED.
  Evidence: PD › `ends the flow on %s while gallery edits settle, and sends nothing once they have`
  (cancel; escape; close, then its event; close, its event after the edits settle).
- [x] **FLUSHFAIL** A failing gallery flush shows its error in the dialog status line, changes
  nothing, returns focus to Publish, and a retry proceeds — ED.
  Evidence: PD › `shows a failed gallery check in the dialog, changes nothing, and publishes on
  retry`.
- [x] **INV5/INV6** Diff touches nothing under `uploader/src/` or `site/src/lib/`; language-mode
  integration and public-paths parity suites green. Evidence: `git diff --name-only` against the
  merge base lists no file under either path; `language-mode.integration.test.ts`,
  `language-api.integration.test.ts` and `public-paths-parity.test.ts` pass in the AC9 run.
- [x] **INV7** A title/slug containing markup creates no element inside `#publishDialog` — ED.
  Evidence: PD › `renders titles and URLs as text, creating no element from them`.
- [x] **GUARDS** Every existing publish-flow test in ED and EG goes through one helper that asserts
  the dialog opened and clicks its Publish; each negative guard test asserts the dialog did not
  open or that confirming it sends nothing (unresolved conflict, pending route reconciliation,
  unsafe restore, `writeRecovery.unresolved()`).
  Evidence: the helper is `publishThroughDialog` (`uploader/test/editor-dom-harness.ts`), used by
  every publishing click in ED and EG. Negative guards: unresolved conflict — ED › `keeps the stash
  base %s, so the draft reaches the stored-version comparison instead of overwriting v2`, EG ›
  `does not reconcile a route when the conflict probe fails (%s), preserving local recovery` (no
  dialog, `publishUnresolved`); pending route reconciliation — EG › `blocks pending/failed route
  reconciliation (%s) and recovers only after a successful explicit reload` (confirmed behind the
  conflicting save: nothing sent; then no dialog), ED › `rejects Publish during a held conflict
  reload without replaying the old form against the foreign version`; unsafe restore — ED ›
  `blocks saving a restored draft whose base is %s, without sending a write`, `blocks saving and
  keeps the untouched stash when the restore fails part-way (#332)`, `blocks mixed-form saves and
  retains local edits when population fails (rollback also fails: %s)`, EG › `does not reconcile a
  route when adopting the stored version fails to populate, preserving local recovery`, `redirects
  on a route 401 without admitting writes or claiming route reconciliation`; route not loaded —
  ED › `does not save or publish when the route state has not loaded`; `writeRecovery.unresolved()`
  at the click and again at confirmation — PD › `refuses while the stored version is unresolved: at
  confirmation, and at the click`.
- [x] **REOPEN** Confirm, let the flow settle, reopen, then Escape / Cancel / `close()` → zero
  POST/PUT, `omitted` unchanged; toggle, Cancel, reopen → the saved default is shown — ED;
  browser B3.
  - [x] ED — PD › `asks afresh on every opening: %s after an earlier confirmed publish sends
    nothing` (escape, cancel, close).
  - [x] browser B3 (see AC4).
- [x] **LATCH** Two rapid `publishBtn` clicks and two rapid dialog Publish clicks → one PUT and one
  publish; after confirming (`flushDialogEvents()`, PUT held) a `publishBtn` click opens no
  dialog — ED.
  Evidence: PD › `runs one flow at a time: double clicks publish once, and Publish stays latched
  until the write settles`.
- [x] **CLAMP** A revision/stash with `omitted: true` for the primary or a published secondary
  populates as `false`; restoring a revision keeps the current `omitted` values — ED.
  Evidence: PD › `never populates the primary or a published secondary as held back` (local draft
  restore and direct populate, both primaries, tab chips), `keeps the current coverage when a
  revision is restored (secondary held back now: %s)` (payload, tab chip, checklist).
- [ ] **CI** Required checks green on the final commit: `site · tests + astro check`,
  `uploader · typecheck + tests`.
- [x] **REVIEW** `/review` findings resolved or rebutted in the PR; fixes re-reviewed. Evidence:
  PR review by `PrReview574d` (`anthropic/claude-opus-5-5`; earlier attempts on
  `anthropic/claude-fable-5-2` and `openai-codex/gpt-6-astra` failed on provider limits): 8 INFO
  findings, all fixed; re-review of the fix diff `REVIEW: APPROVE` with 2 INFO notes, both fixed
  (busy Publish keeps focus as `aria-disabled` with a live status message instead of moving focus
  to Cancel; AC6/AC9 tracker evidence refreshed). Dispositions are on the PR.

Browser steps (a disposable compose stack and disposable posts only; never the owner's data):
B1 DE+EN DE-primary, new complete DE story with an EN draft: Publish → EN unchecked → only
`/<slug>/` live, EN row `omitted = true`, `status = draft`, content kept. B2 same story, EN
checked → both live. B3 after B2: Publish → toggle → Cancel, reopen (saved default shown), Escape,
Enter on the focused checkbox → no save request (network log), `omitted`/`updated_at` unchanged in
the DB. B4 reopen on the published story → EN locked with its explanation. B5 EN incomplete and
checked → inline gaps, Publish disabled with announced reason; uncheck → enabled; Go to → dialog
closes, field focused. B6 single-language install → one row, no checkbox, publish works. B7
Translate button label/icon/accessible name at 1440 px, 52rem, 390 px and 320 px, and at 200% text
size: one line, no overlap with `#inspectorToggle`, computed height 32px on fine and emulated
coarse pointers. B8 DE+EN EN-primary: publish with DE
unchecked → only the EN root URL live.

## 12. Scoped exception record

| Field | Value |
|---|---|
| Waived rule | Human design approval required for high-risk changes (CLAUDE.md "Change Risk and Required Rigor", High row: explicit human approval) — for the **design** only. |
| Scope | Issue #568 only. |
| Reason | The owner chose AI-reviewed design approval for this issue. |
| Risks | Missed design flaws; approval bias if the reviewer is not independent. |
| Compensating controls | Independent adversarial reviewer agent with no implementation role; re-review of any material design change; full test and browser verification; `/review` on the PR; green required CI; no merge or deploy by the agent. |
| Approver | The owner (@laboef1900), authorized 2026-11-11 in the owner's written task instruction to the implementing agent for this issue; recorded here and in the PR description. |
| Expiry | When the PR for #568 is merged or abandoned. |

No other rule is waived: the owner's own review and merge of the PR (the human approval of the
change itself) is **not** waived, and repository-wide policy is unchanged.

## 13. Design approval record

- **Round 1** — independent `reviewer` agent `DesignApproval568`, model
  `anthropic/claude-fable-5-2` (as reported by its harness): **CHANGES REQUESTED**, 3 blocking and
  10 non-blocking findings; server boundary, D1, D4, the four-mode table and rollback found sound.
  Disposition (all incorporated in revision 2):
  1. *Fresh consent for the reused dialog* (blocking) → D2/D3: no `method="dialog"`, opening
     token, rows rebuilt per opening; tracker REOPEN, B3.
  2. *Capture the intent before the dialog closes* (blocking) → D3 steps 3–4, §5 rows; INV3.
  3. *Prove existing guards and invariants 1, 2, 5, 6* (blocking) → tracker GUARDS, INV1/INV2,
     INV5/INV6, LATCH; EG in scope.
  4. Dialog outside `<main>`, `input` events → D2, AC4.
  5. Text-only rendering → invariant 7, §5, INV7.
  6. `writeRecovery.unresolved()` guard → D3 step 1, §5.
  7. Stale-language row → §5.
  8. `omitted` clamp in `populateForm` → D1, CLAMP.
  9. Accessibility details → D2, D5, §7, B7.
  10. AC2/AC8/browser tightening → tracker, B8.
  11. Coverage consequences → D1.
  12. Documentation gaps → `project-reference.md`, contract §9 wording, `DESIGN.md`.
  13. Exception record source and pre-approval edits → §12; a pre-approval draft of `ui.ts` copy
      was reverted and is re-applied only after approval.
- **Round 2** — same reviewer and model: **CHANGES REQUESTED**; round-1 findings resolved except
  two new blockers and four non-blocking refinements, all incorporated in revision 3:
  1. *A close during the gallery flush must cancel the flow* (blocking) → D3 steps 2–4 (any close
     retires the token; Cancel/Escape stay available while busy), §5 rows; tracker BUSYCLOSE.
  2. *Keep the owner's 2rem command-bar height* (blocking) → D5, B7.
  3. Unresolved-save guard as a click-time refusal with `publishUnresolved`, re-checked in step 4
     → D3, §5, §9.
  4. Coverage wording is UI placement, not authorization; revision restore keeps `omitted` → D1,
     contract §9.
  5. Invariant 4 gap-jump clause; intro only when a row is toggleable → §2, D2.
  6. Tracker FLUSHFAIL, LATCH after confirm, focus return after failure → §11, D3.
- **Round 3** — same reviewer and model: **`VERDICT: APPROVED`** for revision 3, no blocking
  finding; overall correctness "correct", confidence 0.8. Its three non-blocking notes are folded
  in without changing the design: the hidden intro leaves `aria-describedby`; revision restore
  overwrites `omitted` before `populateForm` (CLAMP asserts tab chips too); step 3's failure branch
  checks the token, BUSYCLOSE runs `close()` before and after `flushDialogEvents()`, and a failed
  re-check focuses the first enabled checkbox.

**Approved design: revision 3 (with the round-3 notes), 2026-11-11.** Reviewer: `DesignApproval568`
(`reviewer` agent, no implementation role), model `anthropic/claude-fable-5-2`.
