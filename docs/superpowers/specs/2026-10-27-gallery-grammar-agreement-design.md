# #354 — One gallery grammar across the content pipeline

Date: 2026-10-27
Status: **OWNER APPROVED 2026-10-28 — server-authoritative analysis**, including the authenticated non-persisting bridge and server-dependent visual editing. Implementation and verification remain required.
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

## Required verification after approval (not run)

One shared corpus must assert real renderer recognition, normalizer recognition, export metadata restoration, audit membership, browser ranges and publish source discovery. For render-output assertions supply a same-origin URL with valid dimensions; an unresolved photo remaining as `<pre>` is not evidence that the block is not a gallery.

Cover canonical/tilde/0–3 indentation, four-space code, tabs, longer and shorter closers, trailing spaces/tab/NBSP, CRLF/LF, EOF, info arguments, `gallery-notes`, invalid backtick info, nested/combined list and blockquote containers, raw HTML gallery markup, literal enclosing examples, duplicate URLs, Unicode before ranges, directives and mixed gallery/prose/code documents. Test typed metadata → save → export → paste/import → save → render, and stored bare URLs with an existing image map. Assert metadata/order/source preservation and idempotency, not only equal photo counts. Audit remains warning-only.

Browser tests: stale analysis response, edits while picker open, no network, Cancel, nested edit/removal, unterminated refusal, undo, localized actionable error and no fallback parser. Store tests exercise direct importer calls and both locales with a later failing analysis. Existing XSS/origin-spoofing and publish-gate cases must remain valid. Parent runs full affected suites, both type checks, isolated PostgreSQL tests and disposable browser/render smoke after implementation.

## Recovery and exact approval

No migration or automatic content rewrite. Before any later production rollout, retain the normal database backup and current release; use disposable fixtures for development. Failure leaves the old static release active. If the new analysis is defective, stop gallery save/export/edit operations rather than deploying the old lossy scanners against newly normalized noncanonical galleries. Roll back serving code only with that containment; restore only explicitly affected drafts from retained revisions/backups after owner review, never overwrite the corpus. Prefer a targeted roll-forward source-map fix.

**Owner approval recorded 2026-10-28:** “Approve server-authoritative analysis.” This authorizes preserving the complete current render grammar, a single Satteri-backed source analysis, and the authenticated non-persisting `/gallery/analyze` bridge with server-dependent visual editing. It does not authorize content conversion, owner-data changes, deployment or merge.
