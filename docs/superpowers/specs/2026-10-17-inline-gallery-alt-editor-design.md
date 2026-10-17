# Inline gallery preview and per-photo alt text

## Scope

Owner requested visual gallery editing in the article editor, including manual and
AI-assisted alt text. Owner selected inline previews in the writing area rather
than extending the existing media-picker dialog (2026-10-17).

Use the existing EasyMDE/CodeMirror 5 editor, gallery fence grammar, per-locale
images metadata and caption-only AI configuration. No new editor framework,
server endpoint, content schema, external service, publishing or deployment.

## Interaction

Complete top-level gallery fences display as inline photo previews in each locale's
writing area. Each photo has a visible ordinal, full uncropped image, editable alt
text and Suggest alt text. A gallery action opens the existing picker for adding,
removing, ordering and selecting layout. A locale-level toggle exposes the original
Markdown; raw text remains the underlying editable document and export format.
The preview is an authoring view of photos in order, not a pixel-exact published
layout. Existing column/breakout/slider directives remain unchanged.

Manual changes update the active locale's Markdown immediately, including explicit
`alt=""` when cleared. They flow through the existing store normalization on Save
draft, which preserves dimensions, captions and JPEG format. No writes to the media
library or the other locale. The existing per-locale image map is keyed by URL:
repeated uses of one image in the same locale share stored alt text, so update all
occurrences of that URL in gallery fences together and keep visible fields in sync.

AI calls remain browser-direct, using GET /ai-config?purpose=caption and existing
LLM.prepImage/LLM.caption. Use the hosted display variant, never the original/GPS.
Return suggestions in the active locale; show them separately with Use suggestion
and Dismiss controls. Receiving a suggestion never changes the draft. Typing,
replacing/deleting a gallery, loading/restoring another post, changing locale or
switching to Markdown cancels obsolete work. Only explicit acceptance updates alt.
Failures stay inline; manual editing, saving and publishing remain available.

## Implementation and invariants

- CodeMirror collapsed text markers hide complete fences; line widgets provide
  interactive block previews without changing document content. Reuse
  GalleryFence.scanFences; never implement a second fence scanner. Unterminated
  fences and fenced examples remain plain Markdown.
- Change alt metadata only on matching photo lines using existing escapeMeta;
  preserve delimiters, directives, other fields and text around the gallery.
  Keep edits in CodeMirror history. Do not modify the images map behind undo.
- Retain widgets while unrelated text or their own alt text changes. Dispose stale
  widgets, requests and image observers. Refresh measured heights after image loads
  or suggestions. Hidden locale editors refresh when their tab becomes visible.
- Initial alt precedence: unsaved fence metadata, then the post's images map, then
  empty. Explicit empty is distinct from absent. The picker must serialize an
  explicit empty alt rather than resurrecting stored/library text.
- Previews and AI photo reads accept only HTTP(S) URLs on the configured image
  origin or the current app origin, without credentials. Use the existing
  PostsFilter.thumbUrl variant logic and handle missing dimensions/images visibly.
- All copy comes from the shared DE/EN dictionary via the existing editor-copy
  route. Use textContent/value for author/provider strings, not generated HTML.
- AI config/image transport has bounded timeouts and cancellation; LLM.caption's
  existing deadline gains an optional caller cancellation signal. No provider keys
  or review configuration enter the caption flow.

## Risk and recovery

Content-safety-sensitive editor change: alt is serialized into an existing trusted
normalization boundary; no changes to renderer URL guards, images-map validation,
authentication, routes, secrets, or database. Human review of the round-trip and
cancellation behavior is required before merge. Switch to gallery Markdown to
continue authoring if previews fail. Reverting UI code leaves valid gallery fences
and saved metadata compatible with the previous editor; no data rollback needed.

## Verification

Regression coverage: manual and empty alt round-trip through the real normalizer;
preserve captions/format/dimensions/directives; same-URL synchronization; locale
isolation; nested/unterminated fence protection; undo and raw-mode transitions;
AI preview/acceptance, errors, cancellation and late responses. Browser smoke on
real CodeMirror with hosted photo variants, actual editing, save/reload and mobile
layout. Exercise provider transport without claiming mocked responses are real AI.
Full uploader/site suites and type checks before delivery.

API reference: CodeMirror 5.65.21 manual, markText and addLineWidget:
https://codemirror.net/5/doc/manual.html#markText
https://codemirror.net/5/doc/manual.html#addLineWidget

## Verification record

- Uploader: `npm run typecheck` and `npm test`, with `TEST_DATABASE_URL` pointing
  to a disposable Postgres 18 container: 71 files, 1,604 tests passed.
- Site: `npm test`: 24 files, 290 tests passed. `npx astro check` against the
  disposable database: 95 files, zero errors, warnings or hints.
- Actual EasyMDE/CodeMirror browser smoke, isolated Fastify with in-memory stores
  and real local display variants: manual typing retained focus/caret; Save draft
  returned 200; reload retained edited and explicitly empty alt. English content,
  captions and dimensions stayed unchanged. Picker reorder/layout updates retained
  article alt text. Undo/redo and raw/preview toggles preserved the document.
- Real browser image fetch, JPEG preparation and caption transport exercised with
  controlled model responses in DE and EN. Suggestions changed no source before
  acceptance; keyboard acceptance worked. Regression tests cover late responses
  after typing/locale changes and cancellation of an in-flight model request.
  LM Studio was not listening at localhost:1234: real-model generation was not
  verified. The actual connection-refused path showed an inline error and left
  manual editing available.
- Inspected desktop (1440px) and mobile (390px): all three real photos loaded,
  uncropped; no horizontal overflow; visible focus and 44px-tall gallery buttons.
  CodeMirror measurement clones prompted implicit input labels instead of IDs.
- Design detector findings were existing hidden image placeholders, its failure to
  resolve absolute `/admin/` stylesheet URLs, and the intentionally pinned Inter
  typeface. No new gallery-specific finding.
- No production content, media metadata, published output, credentials or
  deployment were changed. Renderer/normalizer validation and the security model
  remain unchanged; editor strings still cross the existing escaping boundary.
