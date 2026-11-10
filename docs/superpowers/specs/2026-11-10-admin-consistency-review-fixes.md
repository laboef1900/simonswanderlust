# Admin consistency review: fixes and owner decisions

## Approval and scope

On 2026-11-10 the owner commissioned an Impeccable critique and audit of the admin
(`uploader/public/`) and, on its report, chose: fix order *on the road → one system →
words and formats*; scope *everything, including token extraction*; and the decisions
recorded below. This spec is the record of those decisions and of the two high-risk parts:
the page editor's move to the rich-text manuscript, and the journey catalogue's additive
read field. No schema, slug, public renderer, publish pipeline, authentication or
image-map contract changes; no route is added or removed.

Risk: **Normal** for the admin presentation and copy changes and the read-only Media
filter. **High** for the page editor (authoring boundary: stored Markdown must not be
lost, rewritten or executed) and for `uploader/src/journeys-admin.ts` (journey tables are
a high-risk area in `CLAUDE.md`): its list `summary()` now also returns
`omitted: { de, en }`, read from the row it already loads — no write path, published
snapshot, membership cleanup or query changes.

Approver: repository owner. The page editor port was decided in the review conversation
of 2026-11-10; the journey list field was explicitly approved by the owner on 2026-11-10
after the implementation report named it as high-risk. Containment for both is the
rollback below.

## Owner decisions

| Question from the review | Decision |
|---|---|
| Editor command bars measure 32px on touch although the control token says 44px | Keep 32px on every pointer; `DESIGN.md` now says so. |
| Desk without photographs unless a draft exists | Keep the Writing-first Desk; no photographs of recent stories. |
| Page editor differs from the story editor | Port it: same command bar, same Visual / Markdown manuscript. |
| Story details section titles in two registers | Uppercase for all of them; `DESIGN.md` amended. |
| Readiness count folds under More below 74rem | Stays as documented. |
| `No alt text` tag on every Media tile | Replace with a count line and an Alt text filter. |

## Approved build exception, extended

The rich-text exception of 2026-11-07 ([spec](2026-11-07-rich-text-post-editor.md))
waived `PRODUCT.md`'s no-bundler constraint "for this surface only", the story editor.

- **Waived rule:** the same constraint, now for a second surface: the page editor
  (`about.html`: About, Contact, Privacy, Legal notice).
- **Reason:** one editor component system; the page editor was the last screen with a
  different toolbar, icon set and command layout.
- **Risk:** the same engine now touches page bodies. A conversion defect could rewrite or
  drop page Markdown; legal pages are the most sensitive content on the site.
- **Compensating controls:** no new dependency and no new bundle — the page editor loads
  the bundle the story editor already ships. Markdown stays the one saved body and
  CodeMirror stays the source of truth for save, local recovery, conflict recovery,
  revisions and gallery diagnostics, exactly as in the story editor. Opening a page or
  switching modes never rewrites its source; unsupported Markdown/HTML stays a labelled
  source block; an engine failure leaves the Markdown editor in place and says so. Page
  revisions (last 20) remain the content rollback. Server-side sanitisation, image-origin
  checks and the public renderer are untouched.
- **Approver:** repository owner, 2026-11-10.
- **Review:** with the story editor's exception, at the next rich-text engine major
  upgrade.

## What changes

**On the road**
- Media tiles that are `processing` are re-read every 3 s while the page is visible (one
  sequential round at a time, paused when hidden) and move to ready or failed in place,
  with one announcement per round; no reload is needed. The manual **Check again** is gone.
- A file the server refuses as unreadable or too large is final in the upload queue
  (`rejected`): one sentence, never offered for resending.
- A save conflict is compared field by field ("Yours" / "Stored", differing fields only)
  with the three resolving actions first; the JSON evidence moves under *Technical
  details*. The page editor no longer shows "Saving the change…" after a conflict. Values
  the server filled into an empty draft (date, region, `0, 0`) are not listed as
  differences.
- The offline and recovery panels use the warning notice style and plain sentences.
- Keyboard focus is kept after saves, moderation and deletes (a vanished row hands focus
  to its neighbour); the phone navigation drawer takes focus when it opens.

**One system**
- One language chip (`.lang-chip`: available, missing, omitted, unknown) on Posts, Pages
  and Journeys rows and inside every locale tab; the journey editor's checkbox now has
  the story editor's polarity ("Publish this journey in English"); the stored field is
  still `omitted`.
- One editor command bar (`.commandbar`) for the journey and page editors, sharing the
  back link and outlined Save draft with the story editor. The page editor uses the story
  editor's Visual / Markdown manuscript and Photo tray; journey fields name their locale
  ("Title (DE)") like story and page fields.
- A Posts row offers a draft's Delete directly; **More actions** appears only on published
  rows. Navigation rows open through an **Edit link** button instead of a summary.
- Confirmations: red only for live-site or destructive actions; focus opens on Cancel
  for destructive ones; an in-page text prompt replaces `prompt()` for folder names and
  link addresses.
- The media picker keeps its actions on screen (fixed header and footer, one scrolling
  body, pager beside the results).
- Media shows one count of ready photos without alt text and a filter for them instead of
  a tag on each tile; the folder and that filter are kept in the URL.
- Comments rows name the story, not its UUID, and say what each action did.
- Outcome sentences name what was done and what the live site serves now, with the build
  moment and without release ids; a delete that leaves the editor carries its outcome to
  the list.

**Words and formats**
- One date format (`AdminFormat`: `10 Nov 2026`, `10 Nov 2026, 08:43`), pluralised
  counts, region names instead of slugs, measurements in mono.
- One inline error pattern (`AdminField`) with the reason under the field.
- One noun (story), Delete versus Remove, `&` between two actions in a button label.

**Tokens**
- `--radius-sm/-lg/-xl` beside `--control-radius`; `--status-ok|idle|warn-*` for pills and
  chips; `--surface-sunken`; one `--z-*` stacking scale. Raw colours, near-duplicate radii
  and literal `z-index` values are gone from `admin.css`.

## Server changes

- `GET /media` accepts `alt=missing` and returns `altMissing` (count of ready photos in
  the same view without alt text in any locale). Read-only; parameterised; no schema
  change. `MediaQuery.alt` is implemented for the in-memory and the Postgres store.
- `GET /journey-admin` list rows carry `omitted: { de, en }` so the catalogue can show an
  omitted translation. Additive, read-only.
- `posts.ts`: the missing-title refusal is a sentence. No behaviour change.

## Invariants

- Page and story bodies: bytes of an unopened or untouched locale are unchanged by
  opening, switching tabs or modes, or saving another locale.
- No admin flow sends author text anywhere new. No new network destination.
- Destructive and live-site confirmations still require fresh consent per opening; a
  typed confirmation still requires its token.
- Published URLs: unchanged. The page editor's slug rules are unchanged.
- WCAG 2.1 AA: contrast pairs unchanged or stronger; every new indicator has a
  non-colour cue and an accessible name; focus is never left on `<body>` after an action.

## Verification

Uploader typecheck and full Vitest; site Vitest (dictionary completeness). `astro check`
and the Postgres-backed integration suites need a database that the review worktree does
not have; CI is the signal for those. Browser checks against working-tree assets at
1440, 1100, 820 and 390 px.

## Rollback

Frontend-only except two additive read fields (the `alt` query with `altMissing`, and the
journey list's `omitted`): revert the commit range. Stored content
is unchanged Markdown and needs no migration. A page damaged by an editing mistake is
restored from its revisions.
