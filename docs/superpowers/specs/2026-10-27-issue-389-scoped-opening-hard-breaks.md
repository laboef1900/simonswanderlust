# Preserve ordinary imported hard breaks — issue #389

**Date:** 2026-10-27  
**Status:** OWNER APPROVED 2026-10-28 — facts-bounded ordinary opening-paragraph normalization; preserve hard breaks without a qualifying boundary. Implementation and verification remain required; no owner-content normalization or deployment is authorized.
**Risk:** High — WXR HTML conversion and persisted author content.  
**Baseline:** `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and scope decision

`uploader/src/wp-content.ts:199–234` initializes `beforeFacts = true` and only
clears it on `Eckdaten` / `Key data` / `Key facts`. Consequently every two-space
hard break in a story with no such heading can become a paragraph break,
including list/quote content and later sections. The issue's reproduction is
accepted evidence; it has not been re-executed.

The existing `2026-09-20-imported-content-semantics-design.md:14,20` authorizes
repair of **opening copy before the facts block**, not all line-break typography.
The existing test at `wp-content.test.ts:58–65` is an opening H2, a plain paragraph
with three thoughts, and an H3 `Key data` whose fact-row hard break stays intact.

**Proposed conservative interpretation:** require that identified facts boundary
before splitting any opening prose. With no facts section, preserve **all**
ordinary hard breaks, including the intro. The issue offers first-section
splitting without facts as an example, not a required acceptance criterion; this
proposal deliberately does not infer that an arbitrary intro's line breaks are
paragraphs. The reported later-section/blockquote preservation and the existing
facts-present opening test are both required. Owner approval must cover this
explicit narrowing of the old overbroad transformation.

## Minimal conversion contract

Remove the global trailing-two-space rewrite controlled by `beforeFacts`.
Keep heading/subtitle repair and empty-TOC cleanup as separate existing rules;
do not change their match grammar or use their presence as a new prose heuristic.

The only permitted hard-break-to-paragraph repair is:

- Ordinary paragraph content in the opening region, optionally preceded by its
  opening heading, whose **first following section heading after that opening
  content** is the existing H2–H4 facts-heading match. Keep the existing
  case-insensitive `Eckdaten`, `Key data`, `Key facts` recognition, without adding
  inferred synonyms, slug-specific matches or locale guesses.
- A different H2–H4 section heading after opening content ends eligibility; a
  facts heading found later must not retroactively normalize that earlier prose
  or other sections. The initial opening heading before prose is not a boundary.
- Only actual HTML `<br>` nodes in those ordinary paragraphs are candidates.
  Lists (including continuation paragraphs), blockquotes, pre/code blocks,
  headings and gallery content are never candidates, even before the facts
  heading. Facts rows and everything after the facts heading remain untouched.
- If there is no qualifying facts boundary, retain Turndown's normal hard-break
  output throughout. Do not split an address, hours table or quote merely because
  it occurs near the start of a document.

Use **Turndown's existing parsed DOM and rule hooks** to determine paragraph
ancestry and document-order section boundaries, not a second regex-based Markdown
block parser. Elementor wrapper divs are transparent; structural ancestors such
as list, quote and code containers are not. Determine eligible opening paragraphs
once per conversion and apply the narrowly scoped break rule there; do not rescan
the full document for every break. Conversion state must be per call, not a shared
`beforeFacts` flag leaking between DE and EN or successive conversions. No new
parser dependency, public API or generic formatting framework is needed.

`htmlToMarkdown(html, attachments?)` remains the shared conversion used by
pre-flight planning and `buildLocale`. Both see identical output. Merge re-runs
continue substituting URLs over the stored body; they do **not** reformat stored
prose. Fresh imports and an owner-selected overwrite use the corrected conversion.
Do not silently enable overwrite to apply this fix to previously imported drafts.

**Affected implementation files:** `uploader/src/wp-content.ts`,
`uploader/test/wp-content.test.ts`, and focused end-to-end fixture coverage in
`uploader/test/wp-import.test.ts`. Clarify the relevant sentence in the existing
2026-09-20 semantics spec and reconfirm `SECURITY.md` during implementation.
No schema, UI copy, public route/slug, dependency or owner-content change.

## Acceptance and safety boundaries

Add these deterministic HTML/WXR regressions, with no remote requests:

1. The issue's facts-free HTML: intro paragraph; `Unterwegs` heading; opening
   hours with two `<br>` elements; `Bus<br>Linie 5` list item and `Taxi`; and a
   two-line blockquote. Preserve the intro, hours, list-item and quote hard breaks
   in their original blocks. Assert exact Markdown, not just substring presence
   that could overlook an extra paragraph separator.
2. Keep the existing `<h2>Opening</h2>` / three-thought paragraph /
   `<h3>Key data</h3>` test: only those opening thoughts become paragraphs;
   `Population:<br>10,000` remains a hard-broken fact row. Cover each existing
   DE/EN facts-heading spelling.
3. Lists, blockquotes, fenced/code output and gallery metadata before a facts
   heading retain their structure. Heading-like/code text is not a real facts
   boundary. Wrapper divs do not change the valid opening fixture's result.
4. Opening prose followed by a different section and only then facts preserves
   ordinary hard breaks; a late facts section cannot authorize conversion of
   intervening content. A body with no headings preserves its breaks as well.
5. Call conversion consecutively for facts-present and facts-absent DE/EN inputs
   to pin per-call isolation. Existing heading/subtitle, TOC, shortcode, gallery
   and image-destination tests must remain valid.
6. A fresh paired import stores the corrected body; an existing edited draft's
   body is preserved on a normal merge re-run. Keep pre-flight/fetch-count parity
   and the store's image-map validation intact.

Input remains untrusted HTML. Turndown's script/style/iframe removal is not the
security sanitizer: the existing render sanitizer, gallery URL allow-list and
post-store validation remain mandatory. No new HTML bypass or raw DOM output is
introduced. Import authorization, safe fetches, caps, cancellation, EXIF policy,
slug identity and publish gates are unchanged. Reconfirm those applicable
`SECURITY.md` input/output and gallery-isolation sections, without claiming a
security-policy change.

Implementation uses a per-call Turndown service and a lazy rule hook that analyzes
the existing parsed DOM once, collecting eligible opening paragraphs before the
first section boundary. Only their real `<br>` nodes receive paragraph separators;
the global Markdown trailing-space rewrite is removed. Regression fixtures cover
exact Markdown, repeated DE/EN calls, fresh paired import/preflight counts, edited
merge preservation and explicit overwrite. No parser dependency or data repair
is introduced.

Full automated verification remains the parent integration agent's responsibility,
including uploader typecheck and affected suites against disposable Postgres.

### Executed isolated runtime proof — 2026-10-28

The real `uploader/src/main.ts` served authenticated HTTP on loopback port 33489
against disposable `swl_389_dev`; all writable paths were checked under this
worktree's `.issue-runtime/` before launch. Four real multipart `POST /import`
requests returned 202 and completed through the persisted import-job runner:

- Fresh import: three DE/EN pairs, `imported: 3`, no failures or warnings.
  All six API-read persisted Markdown bodies matched explicit expected strings.
  Elementor-wrapped opening paragraphs split before `Eckdaten`; `Key data` and
  mixed-case `Key facts` also qualified. Fact rows, later sections, facts-free
  itineraries/addresses, lists and their continuation paragraphs, blockquotes,
  inline/fenced code, heading breaks and gallery-wrapper prose kept their normal
  conversion. An intervening ordinary section prevented later facts from
  retroactively authorizing expansion.
- Authenticated `PUT /posts/:tk` saved deliberately edited DE/EN draft bodies.
  Default merge re-import reported `updated: 3`; both authored bodies remained
  byte-for-byte unchanged. Explicit multipart `overwriteDrafts=true` reported
  `updated: 3` and restored the exact approved source conversion.
- A second fresh import reversed the fixture order under new identities and
  added a gallery/protected-heading pair: `imported: 4`, no failures or warnings.
  Its eight stored locale bodies matched explicit expected Markdown, proving
  isolation across locales and successive imports. The gallery retained its
  fence and normalized title metadata; code/quote headings did not qualify as
  facts boundaries.
- Managed Chromium loaded four authenticated real draft previews. DOM inspection
  showed separate opening paragraphs only in the eligible case; facts/later
  prose, itinerary hours, list continuations, quotes and gallery-wrapper text
  retained `<br>` elements, and fenced code retained its literal newline.
  Four screenshots were retained; the facts-free itinerary screenshot was also
  visually inspected.

Evidence: `.issue-runtime/runtime389-evidence.json`, `fixtures389.xml`,
`fixtures389-repeated.xml`, and `{bounded,protected}-{de,en}-preview.png` in the
issue-389 worktree. Credentials and session cookies are excluded. The owned
application was stopped and the managed browser tab closed.

Limits: these were synthetic draft import/save/preview operations, not publishing
or owner-content changes. Edits used the real save API rather than editor
keystrokes. The gallery photo URL was relative and synthetic: every import
reported zero planned/hosted/failed images, so no remote WordPress fetch,
photo decoding/rehosting or gallery-photo rendering is claimed. No automated
suites, standalone typechecks or standalone builds were run by this runtime
worker. The existing sanitization and gallery safety boundaries remain unchanged.

## Dependencies, recovery and exact approval

Build on the existing Turndown/gallery conversion and the 2026-09-20 semantics
contract; #360 and #388 are independent content-preservation fixes. They do not
justify widening this formatter's scope. No #283 language-mode dependency exists.

A code revert requires no migration but restores the reported formatting loss,
so stop affected imports until the correction is restored. Neither rollback nor
a normal merge re-run repairs already-expanded paragraphs. Existing content
requires an owner-reviewed source/revision comparison and targeted normal edits;
no bulk body rewrite, database restore, re-import, publishing or deployment is
authorized here.

**Exact owner decision requested:** approve facts-bounded, ordinary-opening-
paragraph normalization only, and **preserve all hard breaks when no qualifying
facts boundary exists**. Approve removal of the global text-line rewrite while
retaining the existing heading/TOC repairs and safety boundaries. This is not
approval for a general prose formatter or a one-time owner-content normalization.
