# #354 — One gallery grammar across the content pipeline

Date: 2026-10-27
Status: **OWNER APPROVED 2026-10-28 — server-authoritative analysis**, including the authenticated non-persisting bridge and server-dependent visual editing. Implemented; isolated runtime/browser qualification recorded below. Integration review and release remain separate.
Risk: High — source rewriting, backups, publish checks and post-sanitize rendering.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`. No code or owner data changed; no probes/checks run for this proposal. The issue's reproductions are accepted evidence.

## Problem and decision required

`body-content.ts:193–218` and `public/gallery-fence.js:311–357` independently recognize only column-zero backticks with an exact `gallery` info string. `body-images.ts:130–140` recognizes sanitized `pre > code.language-gallery` at any nesting depth. Consequently valid rendered galleries using tildes, indentation, containers or extra info words lose save/export/audit coverage. The existing parity corpus compares two scanners with the same omission, not the renderer.

**Recommended decision: preserve every currently rendered gallery and derive source operations from the existing Markdown engine, not a larger handwritten CommonMark scanner.** Approve the narrow authenticated, non-persisting analysis route described below to let the unbundled browser consume the same server analysis. This is a proposed addition, not permission inferred from the older gallery specs.

The materially different choices are:

| Choice | Semantics and cost | Decision |
| --- | --- | --- |
| Preserve the current render language; server-authoritative source analysis | Tilde, 0–3-space-indented, list/blockquote and `gallery …` fences continue rendering. Save/export/audit/picker catch up. Visual gallery tools require the server; raw Markdown editing remains available. One new read-only-in-effect authenticated POST, no browser bundler. | Recommended; needs explicit owner approval. |
| Preserve the same language; ship the same Satteri engine to the browser | Same content semantics and potential offline gallery tools; requires browser WASM/dependency packaging, initialization and deployment work. Still must share parser options and source mapping, not substitute another CommonMark implementation. | Viable alternative only with a separately approved packaging design; not part of the recommended implementation. |
| Restrict rendering to canonical top-level backtick fences | Previously rendered tilde/indented/nested/info-argument galleries become visible code rather than photos on rebuild. Raw HTML gallery forms also need an explicit disposition. Existing content would need owner-authorized conversion to avoid regression. | Do not choose silently. Requires explicit approval of that rendering change and conversion scope; no such approval exists. |

Adding tilde/indent/info-word regexes to both scanners is **not** a viable maintainable resolution: nested container parsing still differs, and a larger parity corpus does not make a second parser authoritative. Nor may a whole-document Markdown serializer silently reformat author content. Layout still comes exclusively from `#layout:` inside the gallery; `gallery slider` remains a gallery using the directive/default layout, **not** an alias for slider.

## Smallest complete contract for the recommended choice

### Shared source analysis

Add one server-side source-analysis module next to `site/src/lib/render-markdown.ts`, using the **same Satteri version and parser feature options** as the real render path. The existing Astro integration uses Satteri, not remark. Installed package evidence exposes `markdownToMdast`, `markdownToHast`, node `Position` and plugin hooks; this is API evidence, not proof that every required source range already exists. Promote the actual underlying package to a direct, lockfile-aligned dependency if directly imported; do not import an undeclared transitive dependency or add a different Markdown engine.

The analysis result owns gallery identity, logical content and source provenance: exact source ranges, logical photo/directive lines, per-line editable spans, container prefixes, newline bytes and whether a fenced block is explicitly closed. Represent enclosing non-gallery code blocks too, because the existing insertion safety depends on them. Convert parser offsets to JavaScript/CodeMirror UTF-16 offsets explicitly; do not assume UTF-8 byte offsets are interchangeable.

- Gallery classification is the renderer's sanitized `pre > code.language-gallery` predicate, factored into one shared implementation. Parser nodes/source positions associate those rendered blocks with source; no independent lexical test may admit or reject them.
- All currently rendered forms are included: tildes, variable fence lengths, indent, nested lists/quotes and arbitrary trailing info text whose parsed language is `gallery`. Four-space code, invalid backtick info strings, and gallery examples inside enclosing code blocks follow the real parser, not guesses based on their text.
- Raw author HTML can also produce the same sanitized `pre > code.language-gallery` shape. It must not become a hidden exception. Include its text-node source spans through the existing HTML parser, retaining its HTML wrapper and entity layer when rewriting. Do not remove those galleries or interpret their caption markup as trusted HTML. A source-map capability gap must be solved before release, not covered by silently skipping raw HTML or any nested form.
- Derive edits from parser-established nodes and source spans. A bounded source-mapping adapter may preserve container prefixes/HTML entity spelling; it must not decide which blocks are galleries. Test ambiguous repeated lines, tabs, escaped entities and Unicode. Never locate a node by global string matching or normalize the entire document.
- Source analysis failure refuses the attempted mutation with a recoverable error and leaves source/metadata unchanged. Missing/ambiguous source mapping is a failed operation, never permission to guess an edit range. Every required corpus form must support save/export before this issue is complete.

Rendering and publish analysis continue using the actual sanitized render tree. Export, normalization, audit and import use the same source-analysis result rather than recomputing fence grammar. `rewriteFences`/`rewriteOutsideGalleries` can retain their conceptual jobs, but replace their scanner, propagate any necessary async API change through every caller, and remove obsolete scanner rules/comments. Parser options must stay shared with `MARKDOWN_OPTIONS`, Astro config and preview.

### Browser bridge and safe editing

Proposed route: `POST /gallery/analyze`, `requireAuth`, JSON `{ bodyMarkdown: string }`, using the existing post-body size ceiling and request validation conventions. It returns only analysis of the supplied unsaved string, not stored content, rendered executable markup or library/private metadata. No DB writes, revision, fetch, publication, model call or content logging; response is `Cache-Control: no-store`. Invalid payload is 400, oversize follows the existing 413 boundary, unexpected parser failures use the sanitized server error path. No new unauthenticated surface.

`gallery-fence.js`, editor widgets and the linter consume that result; delete their handwritten block classifier. Results apply only to the exact editor snapshot requested. If text changes while analysis or a picker is open, discard the stale result and analyze current text before any range edit. A timeout/failure leaves Markdown and undo history untouched, shows a localized retry action, and never falls back to the old scanner. Debounce read-only widget analysis; never fire a request per photo. Raw Markdown remains editable without successful analysis.

Preserve the existing range-edit/undo model. Updating a nested gallery preserves its list/quote placement, opener/info string and surrounding source; it does not replace it with a column-zero block. New galleries may keep the canonical serializer. Closed nested insertion must preserve its container; an unterminated gallery is recognized for audit/normalization but picker replacement/removal stays blocked as today. Cancellation edits nothing. Removal must not consume adjacent list items, quotes or prose.

The route is necessary only for the chosen server-authoritative browser architecture. The 2026-07-26 no-bundler constraint remains intact. The older #66 “no new endpoints” statement described that feature's scope; explicitly approve this new narrowly scoped surface rather than pretending the old design already authorizes it.

## Affected files and coordination

- `site/src/lib/render-markdown.ts`, Astro Markdown configuration, `body-images.ts`, new shared source-analysis module: parser/options, identity and provenance. Keep preview/build configuration parity.
- `uploader/src/body-content.ts`, `posts.ts`, `pages.ts`: save normalization in both memory/PG store chokepoints, including direct importer writes.
- `export.ts`, `alt-audit.ts`, `wp-content.ts`, `wp-import.ts`, media-sync alt-backfill consumers: same gallery ranges; captions resembling Markdown images remain protected. Import preflight counting and actual rehost operations agree. Do not change import retry, identity or quota policy.
- `publish-gate.ts`: preserve sanitized-render-tree source discovery; validate agreement rather than replacing it with a scanner.
- `server.ts`, `public/gallery-fence.js`, `editor-galleries.js`, `editor-linter.js`, `editor.html`: analysis transport and all scanner consumers. Localized feedback in DE/EN `site/src/i18n/ui.ts`.
- Existing gallery/body-content/export/audit/publish/import/editor tests and `gallery-fence-parity.test.ts`; authoring workflow and the relevant gallery specs.

**#355 owns photo-line metadata validity and lossless error handling. #354 owns block identity/source mapping only.** Land grammar once, then integrate #355 against its logical lines/ranges; neither issue independently rewrites the other's parser. #355 may first fix canonical-line loss, but its complete acceptance must run across #354's widened forms. Other approved identity/pages/codec/proxy work is not duplicated.

## Security, no-loss and failure invariants

Reconfirm `SECURITY.md` sections “Content injected after sanitize” and publish image guards; document the authenticated analysis route and shared grammar. No weakening of origin equality, HTTP(S)-only URLs, dimension/format validation, `String()` coercion/hast escaping, image-map validation, preview CSP or library-description precedence. No live slug, auth policy, schema, media contents, EXIF/private-original access or published-snapshot changes.

Metadata is lifted only from the actual gallery photo line. Identical URL/caption text outside that node is untouched. Preserve byte-for-byte source outside intentional edit spans, including CRLF, whitespace, HTML wrappers and container prefixes. Preserve every unrelated `images` entry, gallery order, directives, explicit empty overrides and localized data. An analysis failure must not partially save one locale, partially export a post or trigger a build. Existing write conflict checks remain authoritative.

## Required verification after approval

One shared corpus must assert real renderer recognition, normalizer recognition, export metadata restoration, audit membership, browser ranges and publish source discovery. For render-output assertions supply a same-origin URL with valid dimensions; an unresolved photo remaining as `<pre>` is not evidence that the block is not a gallery.

Cover canonical/tilde/0–3 indentation, four-space code, tabs, longer and shorter closers, trailing spaces/tab/NBSP, CRLF/LF, EOF, info arguments, `gallery-notes`, invalid backtick info, nested/combined list and blockquote containers, raw HTML gallery markup, literal enclosing examples, duplicate URLs, Unicode before ranges, directives and mixed gallery/prose/code documents. Test typed metadata → save → export → paste/import → save → render, and stored bare URLs with an existing image map. Assert metadata/order/source preservation and idempotency, not only equal photo counts. Audit remains warning-only.

Browser tests: stale analysis response, edits while picker open, no network, Cancel, nested edit/removal, unterminated refusal, undo, localized actionable error and no fallback parser. Store tests exercise direct importer calls and both locales with a later failing analysis. Existing XSS/origin-spoofing and publish-gate cases must remain valid. Parent runs full affected suites, both type checks, isolated PostgreSQL tests and disposable browser/render smoke after implementation.

## Recovery and exact approval

No migration or automatic content rewrite. Before any later production rollout, retain the normal database backup and current release; use disposable fixtures for development. Failure leaves the old static release active. If the new analysis is defective, stop gallery save/export/edit operations rather than deploying the old lossy scanners against newly normalized noncanonical galleries. Roll back serving code only with that containment; restore only explicitly affected drafts from retained revisions/backups after owner review, never overwrite the corpus. Prefer a targeted roll-forward source-map fix.

**Owner approval recorded 2026-10-28:** “Approve server-authoritative analysis.” This authorizes preserving the complete current render grammar, a single Satteri-backed source analysis, and the authenticated non-persisting `/gallery/analyze` bridge with server-dependent visual editing. It does not authorize content conversion, owner-data changes, deployment or merge.

## Implementation contract (2026-10-28)

- `site/src/lib/gallery-identity.ts` owns the unchanged sanitized-tree predicate
  and schema; `markdown-features.ts` pins the real parser feature options in both
  Astro and `MARKDOWN_OPTIONS`. `satteri@0.9.4` and the installed HTML parser's
  `entities@6.0.1` decoder are declared direct, lockfile-aligned dependencies.
- Real API probes established that Satteri 0.9.4's positions count **Unicode scalar
  values**, not UTF-8 bytes or JavaScript code units. `gallery-source.ts` explicitly
  maps those positions to UTF-16; the existing HTML parser's offsets are already
  UTF-16. The analyzer serializes the actual HAST with source provenance and parses
  the complete resulting HTML before sanitization/classification, so raw fragments
  and HTML tree repair share the renderer's identity.
- `analyzeGallerySource(bodyMarkdown)` returns a promise of `{ bodyMarkdown, blocks }`.
  Blocks expose `start/end`, `kind`, `isGallery`, `unterminated`, logical `content`,
  `contentStart/contentEnd`, continuation `prefix`, `newline`, and `lines`.
  Each logical line carries `text`, source `start/end`, `prefix`, `newline`, `html`
  and `spans`: `{ start, end, from, to }` maps logical UTF-16 positions to editable
  source text, excluding wrappers/container prefixes. HTML entities are indivisible
  spans. Repeated source text is mapped within its parser-owned node, never globally.
  Multiline inline-HTML text uses the parser's actual quote/list ancestors to
  exclude continuation prefixes; entity newlines are counted after decoding, and
  smart-punctuation provenance never consumes a neighbouring logical line.
- `uploader/public/gallery-source-edits.js` is a pure ESM range editor shared by
  server and the unbundled browser via dynamic import. It does not classify blocks.
  `galleryLineEdits` preserves unchanged spellings and wrappers, and
  `applyGalleryEdits` batches those edits without copying the document per photo.
  `galleryContentEdit` returns one undoable range edit.
- **#355 integration:** use these logical `line.text` values for photo-line policy
  and these spans for edits. Do not reparse block delimiters/container prefixes or
  treat an HTML entity layer as photo metadata escaping. The existing metadata
  validity/normalization policy is intentionally unchanged by #354. All four
  body-content gallery APIs now return promises; outside-gallery callbacks may
  also be asynchronous. Callback visitation stays in source order even though
  source edits apply backwards.
- Browser analysis is snapshot-correlated, debounced and failure-recoverable with
  DE/EN copy. Store/import/export/audit consumers await the same analysis. Both
  locales normalize before persistence, and both export documents render before
  writing files. No owner content is migrated or published by this implementation.
- Non-gallery raw-HTML `pre` containers do not hide nested gallery nodes. Source
  ranges may nest only inside such literal containers; crossing/duplicate ranges
  remain invalid, and cursor selection chooses the innermost containing block.
  The linter masks each source byte once even when those ranges nest, while
  retaining every gallery block for its alt checks. Decoded text units are
  appended iteratively, without spreading an input-sized array into a JavaScript call.
- Manual post-local descriptions retain the latest intent per URL and locale.
  Applying an intent rechecks its identity and exact body; a source shift requests
  new ranges, while an intentional form replacement clears old intents. Save
  flushes both locales until the existing dirty-generation token is stable.
  A form-generation token cancels an awaiting Save after a post/revision replacement.
  Analysis failure retains the intent for retry and prevents that post write.
- Pending accepted/manual descriptions are form content, just as synchronous
  Markdown descriptions were before this migration. The existing best-effort
  draft stash must include their locale/URL/text intent before any login redirect
  or navigation. Recovery restores those intents and obtains fresh authoritative
  source ranges before applying them; no saved offset is trusted and no post is
  written until explicit Save. Ordinary server/revision replacement still clears
  prior intents. The private recovery field never enters post-save payloads.
  This preserves the existing content-recovery contract; it does not change stash
  ownership, key scope, lifetime, storage-failure guarantees, session policy or the
  deferred #304 write-receipt/shared-device decisions. No credentials or unaccepted
  model suggestions are added to browser storage.

## Isolated runtime/browser qualification (2026-10-28)

The integration owner's six-check wave `1793219813393_85825` passed before this
smoke. Those tests/type checks/build checks were not repeated by the runtime worker.
The following evidence is from the actual `uploader/src/main.ts`, retained isolated
Postgres database `swl_354_dev`, and `http://127.0.0.1:33454`, not injected stores or
an alternate classifier. Only generated solid-colour photos and synthetic posts
were used. The real Publish action built release `1793220538145-95934-0001`.

- Anonymous analysis returned 401; an author analyzed the exact unsaved
  Unicode/CRLF, nested list/quote tilde/info-argument and raw-HTML source. Invalid
  shapes returned 400 and an oversized body 413; all analysis responses were
  `no-store`. Post/revision/media counts were unchanged. Author Publish returned
  403; admin Publish succeeded. Preview retained `no-store` and its restrictive CSP.
- Both locales saved through the real API/PG store. Readback retained localized
  dimensions/alt/caption, explicit empty alt/caption and unrelated image-map entries.
  Source outside gallery ranges, container/HTML wrappers, directives, CRLF and
  duplicate-URL order survived. Export files were read from disk, pasted into a
  second synthetic pair and saved; localized metadata and explicit empties survived
  that roundtrip.
- The actual editor exercised nested DE reorder/layout update and Cancel, EN
  nested removal and new insertion, and exact one-step Undo. A raw-HTML picker edit
  preserved its wrapper and outside source; its decoded semantic URL (not literal
  entity spelling) was asserted. Unterminated replacement/removal never opened a
  picker, altered source or added an undo step.
- A picker whose source changed and was undone back to identical text was refused
  by its revision guard. A delayed **real** analysis request could not open a picker
  against newer source. Explicit network aborts produced DE/EN retry feedback
  without source/undo mutations; raw Markdown remained editable and a real retry
  recovered. Eight rapid edits produced one body-analysis request for four photo
  cards, not one request per photo. No fabricated successful response or provider
  response was used; optional live AI inference was not exercised.
- Public and authenticated preview DOM/screenshots were retained at measured
  1440px desktop and 390px mobile viewports. Each DOM contained three galleries/four
  photos in order `[0, 1, 2, 0]`, with `complete` and positive `naturalWidth` checked
  before capture and no horizontal overflow. The initial `preview-en-mobile.png`
  has a blank region for the green column photo despite its positive natural width.
  A targeted follow-up on the same release scrolled that gallery into view, awaited
  image decoding and two animation frames, and visually confirmed the green photo
  at 390px in `preview-en-mobile-column-decoded.png`; the corresponding paint-proof
  JSON records its source, dimensions and visible styles. The initial capture's
  missing paint has no established cause. Enclosing and four-space code examples
  remained code. The publish audit
  covered all three distinct gallery photos in each locale. Empty rendered alts
  correctly followed the intentionally empty Media descriptions; localized stored
  metadata was asserted separately, not mistaken for the public precedence rule.

Evidence is retained outside tracked source in the integration checkout's
`.local/backlog-execution-2026-10-27/issue-354-browser/`: `proof.json`,
`source-hashes.json`, exported MDX, generated photos, and editor/public/preview
screenshots plus DOM captures. Runtime files and synthetic content remain under
this worktree's `.issue-runtime`; temporary accounts, sessions and browser profile
are removed after capture. No owner content, external import/fetch, deployment,
commit or push was involved. No functional grammar defect was found by this smoke;
the targeted follow-up also established the previously missing mobile-preview
visual evidence without a source change.

Security confirmation: the documented `SECURITY.md` grammar/provenance,
post-sanitize image guards, Media-first descriptions, preview CSP and publication
authorization remain intact. This smoke does not replace the integration owner's
automated XSS/origin/mapping regression suites or final review.

## Review-fix qualification (2026-10-28)

Full six-check wave `1793225380688_49333` passed after the review fixes, including
the permanent failing-before regressions for nested HTML, a large HTML gallery,
multi-photo/manual-description retention, source shifts, retry, form replacement
and a second-locale edit started after Save.

Focused real-runtime evidence is retained in
`.local/backlog-execution-2026-10-27/issue-354-review-fix-runtime/`:

- `proof.json` covers actual authenticated analysis of a 350-row raw-HTML gallery,
  nested non-gallery `pre` save/export/paste/save, desktop/mobile DE/EN manual edits,
  latest-value coalescing, source insertion with Undo/Redo, failed analysis and retry.
  Real Save and confirmed Publish sent no write while required responses were held;
  release `1793224743909-41424-0000` contains the latest descriptions. Responses were
  delayed, not replaced with fabricated successful data.
- The additional boundary probes reproduced two remaining races before fixing
  them: an awaiting Save wrote a restored form, and a locale edited after its first
  flush was omitted while the other locale still waited. Final-source
  `replacement-save-boundary-final.json` records zero post writes after a revision
  replacement; `late-locale-save-boundary-after-fix.json` records zero writes while
  EN remains held and the latest EN value persisted after release.
- Each probe records its own source hashes. The initial focused proof predates
  the final two Save guards; `boundary-followup.json` records the final hashes and
  separate reproof, not a retroactive claim that the earlier captures used them.
  A service restart reconciled the earlier synthetic photos into Media; the
  follow-up used fresh post-local photos with no matching Media rows.

Only synthetic local content was changed. Temporary accounts/sessions, owned
services, browser profiles and launch scaffolds were removed; fixtures, releases
and evidence were retained. Mobile means a measured Chromium viewport, not a
physical device. No external model, deployment or owner-content migration ran.
The existing `SECURITY.md` authorization, nonpersisting analysis, provenance,
post-sanitize URL/markup guards and Media-first metadata policy remain unchanged.

## Nested linter consumer qualification (2026-10-28)

The full-range review found one remaining consumer that assumed disjoint ranges:
the linter appended a nested range twice and displaced subsequent repair offsets.
The failing-before regression located an inline alt at UTF-16 offset 291 instead
of 165. The fix skips already-masked contained ranges without removing the nested
gallery from the analysis result.

Full six-check wave `1793226390750_58264` passed, including exact repair offsets,
heading line numbers, hidden literal examples and retained nested gallery checks.
The actual editor's audit buttons then selected the complete filename-pattern alt
after a nested raw-HTML gallery: DE at 1440px and EN at 390px. The fresh mobile
navigation had no horizontal overflow; the earlier resize capture retained open
desktop panels and is not the qualified mobile image. Source stayed unchanged.
Evidence and source hashes are in
`.local/backlog-execution-2026-10-27/issue-354-nested-linter-runtime/`.
Only a new synthetic draft and temporary test accounts were used; retained fixtures
were not published. Accounts/sessions, browser profiles and the owned service were
removed. No physical-device or optional AI-provider coverage is claimed.

## Pending-description recovery qualification (2026-10-28)

The final review found that a 401 interrupted analysis before pending manual
descriptions reached the Markdown, so the existing recovery snapshot omitted them.
The failing-before DOM regression lost the latest first-photo description. The
snapshot now carries URL/value pairs per locale; Restore re-analyzes the restored
source rather than trusting persisted offsets. Ordinary post payloads stay unchanged.

Full six-check wave `1793227694004_65563` passed. Actual `main.ts`, API and Postgres
qualification at measured 1440px and fresh-navigation 390px exercised real logout,
held real 401 responses, login, explicit Restore, fresh analysis and explicit Save.
Latest descriptions for multiple DE/EN photos and an explicit empty value survived;
no automatic post write or recovery-only payload field was observed.

Evidence, screenshots, source hashes and cleanup are retained in
`.local/backlog-execution-2026-10-27/issue-354-auth-recovery-runtime/`.
Existing twelve post-locale rows and seven Media rows were unchanged. New synthetic
photos remained post-local; temporary accounts/sessions, service, browser profile
and launcher were removed. Initial thumbnail placement and capture-harness issues
are disclosed separately; corrected final captures show decoded photographs.
This preserves the existing recovery contract, not the deferred #304 ownership,
lifetime, authentication-policy or save-receipt design. No physical-device,
optional-provider, owner-content or deployment coverage is claimed.
