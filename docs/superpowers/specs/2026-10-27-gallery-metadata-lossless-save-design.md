# #355 — Preserve malformed gallery metadata on save

Date: 2026-10-27
Status: **OWNER APPROVED 2026-10-28 — preserve line and warn.** Initial implementation and runtime qualification completed below; final dependency integration remains separately qualified.
Risk: High — author content normalization and post-sanitize caption inputs.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`. Issue reproductions are accepted evidence; no tests/probes or code/data changes were performed for this proposal.

## Root cause and recommended decision

`uploader/src/body-content.ts:296–340` splits on every `|`, ignores fields outside its attribute regex, then strips the entire metadata-bearing line when dimensions resolve. This destroys a malformed caption even if its alt/dimensions were understood. `readCaptionOverride` has the same partial-read risk. The browser parser likewise discards unknown fields and can lose them when the picker serializes its partial interpretation.

**Approve line-atomic preservation with an actionable warning, not a new save/publish refusal.** A malformed photo line is stored byte-identical and contributes no metadata changes. Valid other lines still normalize. Return an explicit diagnostic on the save response and show it at the corresponding locale/source line. Do not broaden the accepted syntax or guess what the author intended.

This follows the issue's literal acceptance criterion: every supplied probe survives a successful save byte-identical. The alternative is an atomic HTTP 400 refusal of the entire pair before writes/builds, retaining all unsaved editor text. That is safe but does **not** satisfy “survives save” as written and prevents saving unrelated work until syntax is fixed. Choosing rejection therefore requires an explicit owner amendment to that criterion; it must not be smuggled in as an implementation detail.

## Line contract

Use one dependency-free photo-line codec for the normalizer, exporter, browser parse/update helpers and renderer caption-override reader. Reuse the existing entity encoding; do not invent another quoting dialect. A browser-loadable shared JS module with server imports can follow the existing shared-public-module approach (`gpx-public-track.js`), without a browser bundler. Remove superseded duplicated field regex/escape implementations rather than maintaining another mirror.

The codec returns either a complete recognized record with source field spans, or an invalid result with the original line and a diagnostic. Gallery/block membership belongs exclusively to #354, not this codec.

- The current `WIDTHxHEIGHT`, `alt="…"`, `caption="…"`, `caption-override="…"`, and `format="jpeg"` fields remain the accepted forms, with existing outer-field trimming, entity decoding and text caps. Existing handling of valid duplicate recognized fields remains unchanged; this is not a duplicate-field-policy project.
- Validate **every non-empty field before any mutation or metadata lift**. A typo, unmatched quote, raw delimiter inside a value, unsupported format, malformed dimensions token, or malformed override makes the whole line invalid. Dimensions already present in `images` must not make unknown text safe to discard.
- Preserve all five issue probes exactly: backslash-escaped quotes in a caption, a literal pipe in a caption, `capton=`, spaces around `alt =`, and single-quoted `alt`. Preserve malformed `caption-override` the same way. Do not accept a suffix fragment merely because it happens to match a valid field after a split.
- Invalid means **no part of that line is lifted**: do not update dimensions, format, alt or caption from its otherwise-valid fields. Retain the original URL's existing map entry unchanged by that line, or leave it absent if absent. Another valid occurrence of the same URL may still update shared metadata according to the existing URL-keyed semantics; the malformed occurrence supplies nothing.
- Preserve all raw bytes of that line, including leading/trailing whitespace, quote/backslash spelling, `|` fragments and CRLF. Do not decode/re-encode invalid source. Preserve surrounding prose, other gallery directives, source wrappers and all unrelated map entries. Valid lines continue normalizing and remain idempotent.
- Keep the existing unresolved-dimensions preservation behavior. The new guard must also catch unknown fields when valid dimensions are available from the input map, the failing case current tests omit. Bare stored URLs and valid caption-only overrides remain valid.
- `caption-override` remains occurrence-local and never enters the URL-keyed map. Empty override remains distinct from absence. Do not change library alt/caption authority, hidden-caption behavior, caps, URL selection or render eligibility in this issue.

The confusing authoring documentation at `docs/authoring-workflow.md:455–460` must be corrected. Hand-typed values need `&quot;` for a quote and `&#124;` for a pipe; export/picker escape automatically. `\"` and a literal `|` are not currently supported escape syntax. Describe preservation and how to repair a warned line, without claiming that preserved malformed fields render correctly.

## Exact actionable diagnostic boundary

Safety lives in `normalizeGalleryFences`, reached by post `draftWithDefaults`/`normalizeBodyImages` and page normalization in **both** memory and PostgreSQL stores. Direct importer/store callers therefore get lossless behavior even without a UI. Do not implement preservation only in HTTP validation or the editor linter.

Proposed diagnostic shape is `{ code: 'invalid_gallery_metadata', locale, line, column, field, reason }`, with one-based original body coordinates, a known field name or `unknown`, and a bounded reason enum (unknown field, malformed field, invalid dimensions, unsupported format). Do not echo the author-supplied field or caption into error HTML/logs. The first unrecognized fragment identifies the repair location; the whole original line remains available in the editor.

- Successful `POST /posts` and `PUT /posts/:tk` retain the current saved-pair response fields and add a transient `galleryWarnings` array. `PUT /pages/:key` retains `{ saved, build }` and adds the same array. These diagnostics are response metadata, not persisted post/page fields or database columns.
- Derive diagnostics with the shared codec from the exact submitted locale body **before any normalization**, including multiline BodyImage conversion. The response belongs to the captured save-request snapshot; its coordinates never refer to a normalized response body that the editor did not adopt. Preserve source positions through the shared normalization boundary, not an alternate route regex. Existing authentication, conflict/slug checks and storage failures retain their status/error precedence; a refused save must never display “saved with warnings.”
- In `editor.html` and the page editor (`about.html`, or its approved #287 successor), display a persistent localized warning after success: the content **was saved**, the specified metadata **was not applied**, and the author should open the named locale and fix the line. Associate it with the submitted snapshot. Before focusing, compare current locale text with that snapshot; if changed, reanalyze current text through the shared analysis path and focus only a current diagnostic, never stale coordinates. Do not overwrite newer text to align coordinates. Show correct quoted/entity syntax, preserve undo history, and do not replace this warning immediately with generic success or clear it on a failed subsequent request.
- All new user-facing copy belongs in both locales of `site/src/i18n/ui.ts`. Display via text nodes/textContent, not HTML assembled from source. Maintain keyboard focus and undo history.
- The existing editor linter/widget may show the same shared diagnostic before save. It is advisory, never the safety boundary. On reopening retained malformed source, show the warning again; warning loss due to navigation must not imply the data was repaired.
- A gallery containing an invalid line must not pass through the picker's partial `parse → serialize` replacement. Show its raw Markdown and diagnostic; block only that lossy visual update until the author repairs the source. Opening/Cancel/failed analysis makes no source edit. Inline-alt updates must likewise never serialize a partial parse over the malformed line.

The preservation choice intentionally leaves current publication behavior unchanged: it is **not** a new publish gate, and the alt audit remains warning-only. A malformed caption can remain invisible while its valid existing photo still renders; the warning must say so. Page save currently also rebuilds, so this same caveat applies immediately to page saves. Approving preservation means accepting this explicit warning-based repair flow; choosing “must prevent such publication” instead requires the rejection alternative and its acceptance-criterion amendment.

## Scope, dependencies and security

#354 owns one gallery definition, logical content and exact source spans for tilde/indent/info-string/list/blockquote/raw-HTML forms. This issue owns field completeness and no-loss behavior only. Implement the codec once; do not add fence scanning while fixing attributes. A canonical-fence regression fix can precede #354, but the final integrated acceptance covers every gallery #354 recognizes. Transport/async scanner work is not duplicated here; no new endpoint is required for #355.

Affected implementation: `uploader/src/body-content.ts`, store normalization in `posts.ts` and `pages.ts`, `server.ts` save responses, `public/gallery-fence.js`, `editor-galleries.js`, `editor-linter.js`, `editor.html`, `about.html`; `site/src/lib/gallery-layout.ts` caption reader and the shared line codec. `galleryFencesToMdx` and export callers must preserve invalid lines rather than reattach partial metadata or pass caption text through inline-image rewriting. `wp-import.ts` substitutions must retain the unchanged metadata suffix when replacing an actual URL, not reconstruct an invalid line from recognized fields. Reuse existing tests and authoring docs. The approved pages/navigation work and its routes are not redesigned here.

Reconfirm/update `SECURITY.md` “Content injected after sanitize” to describe the shared line codec and lossless-invalid-input behavior. Origin equality, HTTP(S) checks, dimension/format validation, `String()` coercion, hast escaping, images-map validation, preview CSP and authorization stay unchanged. Preserved text is still untrusted; neither diagnostics nor renderer may use it as HTML. No fetching metadata-like Markdown links, no Media writes, no EXIF/original exposure, slug changes, schema changes or owner-data cleanup.

## Required verification

1. Every issue probe and malformed caption-override, with and without an existing map entry: stored source byte-identical, no metadata contribution, actionable coordinates. Cover LF/CRLF, Unicode before the field, multiple malformed fields, an unknown field following a valid override, and a valid-looking suffix after a raw pipe.
2. A mixed document/pair: malformed lines preserved, unrelated valid lines still normalize, unrelated map entries and opposite-locale content preserved; re-save is idempotent. Two galleries sharing a URL do not leak local overrides.
3. Valid entity-escaped pipe/quote, literal entities, empty alt/caption/override, valid JPEG marker, unchanged text-cap semantics and unresolved dimensions. Correcting only the warned syntax then saves normally, clears the warning and renders the intended text under existing library precedence.
4. Real memory and PostgreSQL save boundaries, direct `upsertDraft`/page saves and HTTP responses. Conflict, write failure and failed page build retain honest outcomes; no warning claims a refused write succeeded. No new build or publication triggered by diagnostics.
5. Save → export → paste/import → re-save retains malformed source; inline-image or BodyImage-looking caption text is never interpreted as another image or fetched. Export must not claim to repair malformed metadata. Valid export round-trips remain unchanged.
6. Browser save/reopen, linter focus, picker refusal/Cancel, inline-alt behavior, undo and DE/EN messages. Repair restores normal visual editing without removing other photos. Run the same cases inside #354's accepted nested/tilde/indented/info-string forms, testing original source coordinates rather than flattened logical-line coordinates.
   Include a multiline `<BodyImage … />` before the malformed gallery and edits made while Save is pending: normalization and later typing must not make a warning link select unrelated text. A warning that no longer exists in current text must not cause a stale jump.
7. Existing gallery-caption escaping, origin-spoofing, image-map validation and preview security tests stay enforced. Parent runs affected suites, type checks, isolated PostgreSQL and browser checks after implementation; qualification is recorded below.

## Recovery and exact owner approval

No corpus migration or automatic repair. Already deleted metadata cannot be reconstructed from dimensions, filenames or library text; recover only from an owner-selected revision/backup or retained unsaved text. Do not fabricate captions.

Retain the normal pre-rollout database backup and existing release. If a regression is found, contain gallery writes/visual rewrites rather than reverting to the known lossy normalizer and asking the author to re-save. Retained malformed source needs no rollback migration. A targeted fix can resume normalization after the author repairs the line; restoring a prior draft requires owner review and must not overwrite unrelated later edits.

**Owner approval recorded 2026-10-28:** “Preserve line and warn.” Successful line-atomic preservation and mandatory actionable save warnings are approved, including page-save/rebuild behavior and unchanged publication policy. Whole-request rejection was not selected. This does not authorize content repair, owner-data changes, deployment or merge.

## Initial integrated qualification (2026-10-28)

Full six-check wave `1793227694004_65564` passed, including both application suites,
type checks, isolated PostgreSQL integration, Astro check and build. The browser VM
harness now loads the same shared codec used by the production ES modules; its
declaration file follows the repository's existing shared-JavaScript typing pattern.

Actual `main.ts`, API, Postgres, export, preview and released-page evidence is in
`.local/backlog-execution-2026-10-27/issue-355-runtime/RESULT.json`, with source hashes,
thirteen screenshots and cleanup. It covers all five issue probes plus malformed
override, with/without maps; exact invalid-line preservation and no partial lift;
submitted CRLF/Unicode/multiline-BodyImage coordinates; nested and raw-HTML galleries;
export/editor/save roundtrips; and no fetch from image-looking caption text.

Measured 1440px and fresh 390px DE/EN editing proved persistent warnings, safe picker
and inline controls, repair and restored editing, Cancel and undo. Held real save
responses proved current-source focus and no stale jump after repair. Actual About
save/build retained warnings, while a concurrent-write 409 remained an honest failure.
Malformed content still published successfully; repaired output escaped captions and
retained Media precedence. GET/revisions stayed free of transient warning fields.

This proof uses the #354 dependency at `9492981`, before its later authentication
recovery fix, and does not claim to qualify the later combined source. The clipboard
helper failure and recovery through native input are disclosed in the evidence.
Temporary accounts/sessions, runtime, browser profile and launcher were removed;
synthetic fixtures/releases remain. No owner content, physical device, external
provider, deployment or merge was exercised.
