# #302 compose, preview, save and publish on a phone — audit, change and emulation evidence (2026-11-01)

Baseline `dev` `208f3cf`. Risk: **normal** (client files only; publish permissions and gates —
`validateForPublish`, foreign-image and not-ready gates — are unchanged). Hypotheses are those of
the #300 matrix (PR #471, §6/§15). Labels: `[STATIC]`, `[EMULATED]` (Chromium device emulation),
never `[DEVICE]`; gate G5 is open.

## Audit of #302 against `dev`

| #302 item / hypothesis | Before | Evidence |
| --- | --- | --- |
| H1 Preview `window.open` after `await doSaveDraft()` | **Present** — popup-blocker risk | `[STATIC]` `editor.html` preview handler |
| H2 stash on backgrounding | Partial: `beforeunload` + `pagehide` (#306), no `visibilitychange` | `[STATIC]` `draft-guard.js` |
| H5 field text 14px → iOS focus zoom | **Present** (`font: 400 0.875rem/1.4`, no coarse override) | `[STATIC]` `admin.css` |
| Authors see no Publish | **Not met**: Publish visible and enabled for authors (server answers 403) | `[STATIC]` `editor.html`; `[EMULATED]` |
| Touch targets (H15) | Mostly 44px (coarse `--control-h`); checkboxes 16×16 | `[EMULATED]` measured |
| Command bar / tabs / drawer at 320/390 | Wrap without overflow; drawer opens, Escape returns focus to opener | `[EMULATED]` |
| Media/gallery pickers on touch | 44px controls; reorder by buttons, not drag | `[EMULATED]` measured in the gallery picker |
| 200% text | Masthead "View site" pushed off-screen at 390 px | `[EMULATED]` (also seen on Media, #301) |
| H3 EasyMDE toolbar at 320 | Wraps to two rows; no overflow | `[EMULATED]`; touch selection/autocorrect is device-only |
| H4 keyboard covering Save | Not reproducible in emulation | device row below |

## Change

- **Preview** opens its tab synchronously inside the tap (`opener` nulled) and navigates it after
  the save; a failed save closes it; if the browser blocks even that, the status line reads
  "Saved. The browser blocked the preview window." with an **Open preview** link (DE/EN copy).
- **DraftGuard** stashes a dirty form on `visibilitychange` → hidden, with the same per-tab key
  (#138) and generation (#22) as every other stash; nothing else in the lifecycle changes.
- **Publish/Unpublish** are hidden unless the session is admin (Publish starts hidden until the
  session is known, so it never flashes for an author).
- **`admin.css`**: `--control-font` (0.875rem; 1rem on coarse pointers) drives field text,
  including the gallery picker's layout select and caption textareas; coarse-pointer
  checkboxes/radios are 24px; below 900px the masthead brand name truncates with an ellipsis so
  View site stays visible with large text.

## Evidence

- Regression tests (each fails on the old code): DraftGuard vm suite — hidden stashes, visible
  and clean do not; editor DOM — preview opens before the save request and is navigated after it;
  blocked popup shows the link; failed save closes the pre-opened tab; Publish hidden for authors,
  shown for admins.
- `[EMULATED]` real app on a fresh database, story with hero, two inline photos and a two-photo
  gallery (created through the API with library photos). As **admin**, iPhone UA, 390 px, touch:
  opened Story details by tap, typed into the excerpt, Escape returned focus to the drawer
  opener; More → Preview opened a new tab on `/posts/<tk>/preview?locale=de` showing the unsaved
  edit; Publish → confirm (44×44) → "Publish saved… Release … was promoted", the live page served
  the edit. As **author**, Android UA, 320 px: no Publish/Unpublish, 16px field text, excerpt edited
  in the drawer and saved. Gallery picker at 390 px: two photos picked by tap, move/remove 44×44,
  Escape closed it. Desktop 1280: unchanged (14px fields, 16px checkboxes, Publish for admin,
  Preview tab opens). Masthead at 390 px with 200 % root text: View site fully on screen. No
  horizontal overflow anywhere. Screenshots retained locally.
- Fixture note: inline images and gallery lines created through the API without the picker's
  dimension metadata render as plain images/code — an artefact of bypassing the picker, not of
  this change; the device run inserts photos through the pickers.

## Device rows for G5 (from the #300 script, editor part)

On each matrix phone at 320 and 390 CSS px, normal and 200 % text (iOS Dynamic Type / Android
font size), both roles, touch and Bluetooth keyboard:
1. New story: title, excerpt, hero (library), two inline photos (picker), one gallery (picker,
   reorder with buttons), story details in the drawer; Save draft. Record whether the keyboard
   hides Save or the active field (H4) and whether focusing a field zooms the page (H5).
2. Preview: a new tab opens without a popup prompt, or the **Open preview** link appears and works.
3. Background the browser mid-edit (home screen, lock, app switch, wait), return: the stash is
   offered after a reload (H2); note whether `pagehide` or only `visibilitychange` fired.
4. Admin: Publish → confirm; open the public story; text, hero, inline photos, gallery order and
   captions match. Author: no Publish/Unpublish anywhere.
5. Tab through every control with the Bluetooth keyboard: sensible order, visible focus.
