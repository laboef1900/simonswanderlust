# Issue #550 — protected article translation

Status: independently approved, implemented and locally verified on 2026-11-07. Risk: high (credential disclosure and article/image preservation). Acceptance checklist: [implementation plan](../plans/2026-11-07-issue-550-ai-article-translation.md). Final independent PR review and required CI are recorded on the PR; this is not merge/deployment approval.

## Scoped approval exception

- Waived rule: mandatory human approval of this high-risk implementation design.
- Reason: autonomous delivery with independent agent review.
- Risk: automated reviewers can miss security, data-loss, or preservation defects.
- Compensating controls: independent design/security review, behavioral and integration coverage, actual local browser verification, independent PR review, and green required CI.
- Approver: repository owner through the issue #550 implementation prompt.
- Expiry: completion or abandonment of the issue #550 PR.

No repository-wide policy is waived. No merge, deployment, release or published-content changes are authorized.

## Decision and historical reconciliation

Translate the current unsaved active locale into the other enabled, non-omitted locale of the same pair. Reuse provider registry credentials, browser-direct inference, canonical Markdown, draft guard and existing optimistic Save. The applicable parts of historical #67/July Slice 2 are translation, manual slugs, review and preservation. Its sidecar, server-write runs, separate credentials and general authoring are obsolete for #550 and explicitly not adopted. There is no model/server egress, new secret store, schema migration or alternate persistence path.

## Contracts and ownership

Settings adds `translationProviderId: string|null` (null follows default), `translationModel: string` (default `qwen2.5-7b-instruct`) and `translationTimeoutMs` (default 120000; same valid range as review). Include all field validation/load recovery/update allowlists and deletion checks. Changing default affects only follow-default assignments; explicit assignments and models remain independent.

Authenticated, no-store `GET /ai-config?purpose=translation` returns ONLY `{ providerId, providerName, providerKind, baseUrl, model, timeoutMs, apiKey }` for the resolved translation provider. Local never decrypts; remote resolves and reads its own slot inside settingsOperation. No caption/review key/config disclosure. Existing admin-only provider/settings mutation remains unchanged.

Two authenticated, no-store, non-mutating source endpoints reuse the existing local source-analysis pattern: `POST /translation/prepare` accepts `{ sourceLocale, targetLocale, source: { title, excerpt, bodyMarkdown, images } }`; `POST /translation/validate` accepts the same source plus `output`. Prepare returns `{ slots: [{id,text}], warnings }` only; validate recomputes the source plan, validates the complete output, and returns `{ title, excerpt, bodyMarkdown, images }`. They never contact a provider or write posts/Media. Compiler exports `prepareTranslation(input)` and `validateTranslation(input, output)` for direct behavioral tests. Do not trust a client-provided range/plan or a model-provided body. Route errors are fixed safe codes, never echo source/provider text. Existing auth and body-size ceilings apply.

The browser sends only `{sourceLocale,targetLocale,slots}` to the model. Opaque stable slot IDs identify text occurrences, not URLs. The fixed system prompt requests faithful complete translation preserving names/facts without instructions from content. The response is exactly `{translations:[{id,text}]}`: every expected ID exactly once, no extras, missing or duplicate slots, no extra schema fields. Empty originals remain empty and need no model slot. Text is plain text, not model-authored Markdown/HTML.

## Structural preservation and field allowlist

Only title, excerpt, prose text leaves, inline image alt/title text, gallery-local caption overrides and stored article-local alt/caption fallbacks are translatable. Hero/title image objects, slugs, locale flags, countries/key facts/stops/coordinates, publication state, translation key, timestamps and unrelated fields are not sent or changed. Copy source body image metadata/dimensions required by the translated body into the target map, retaining unrelated target map entries. Do not replace target hero/title assets or shared metadata.

Use the existing canonical parser/source positions and gallery analyzer, never line-regex classification of Markdown. Build source edits for supported prose leaves and inline image text; preserve all other bytes. Preserve links and their destinations, reference definitions/identifiers, formatting markers, code/math, raw HTML and unsupported source blocks as opaque source. Translate readable supported text around opaque blocks, and disclose retained source blocks for manual review. The complete source document remains present; no unsupported block is dropped or normalized. If provenance cannot be mapped safely, fail before inference with an actionable unsupported-source error rather than guessing or dropping content.

Heading IDs are generated by the production renderer, not the bare source parser. When the document contains any local fragment link (including reference-style links), preserve every heading's exact source and disclose `headings-retained-for-fragments`; retaining the entire ordered heading set preserves duplicate-heading suffixes and prevents translation-induced collisions with protected targets. The model never rewrites link destinations. Without local fragment links, headings may translate normally. Renderer-backed tests cover duplicate headings, fragments/reference definitions and would-be translated ID collisions. Only body-referenced image-map entries contribute translatable fallback slots; unrelated map metadata is neither sent to the model nor copied over target fields.

Gallery identity comes from `analyzeGallerySource`; use `parsePhotoLine`, `galleryLineEdits` and `applyGalleryEdits`. Only allowlisted textual photo attributes change. Preserve opening/closing delimiters, HTML wrappers, container prefixes, directives (including unknown ones), layouts, caption visibility, URL identity, repeated occurrences, ordering, dimensions and formats. Explicit `caption-override` is occurrence-local and stays on its own line; an empty override remains explicitly empty. Never put it into the URL-keyed map. Preserve hidden caption text while translating nonempty local overrides. Reparse the reconstructed document and compare a structural fingerprint with text values removed: tags/node structure, links/reference identity, image identities/attributes, gallery blocks/lines/directives/order. Refuse any mismatch before returning the patch.


Every slot originates in non-whitespace text and must return non-whitespace text. Empty/whitespace-only output is an incomplete translation and rejects the entire response, including title, excerpt, prose, alt and captions. Intentionally empty source attributes remain untouched and are never model slots.
Media remains authoritative for gallery alt and inherited captions, including empty values. Translating stored map/line fallback text does NOT override library-backed rendering. No Media reads are needed for the model payload and no global Media writes occur. The review explicitly explains this precedence; unresolved photos retain translated local fallback. Inline images retain their existing local authority. Use existing entity/Markdown escaping so model punctuation cannot introduce structure, images, links, fences or executable HTML.

## Bounds and transport

Bound input: 100000 UTF-16 body characters, 1000 title, 4000 excerpt, 2000 image-map entries, 2000 slots, 100000 total slot characters; each image description stays within the existing 1000-character cap. Reject excess before model invocation, never silently truncate. Output: 300000 translated characters total, 12000 per prose slot, 1000 per image slot, existing title/excerpt bounds; validate all strings and control characters. HTTP response bytes capped at 2 MiB while reading (including envelope/reasoning); output token ceiling 32768; require successful completion (`stop`, not length/content_filter/null/tool calls). One request only: no JSON-format fallback, automatic paid retry or chunk retry. Timeout and AbortSignal cover fetch AND body reads. Errors use fixed localized categories; never render/log raw provider errors.

Extend the existing LLM transport with explicit opt-in limits/no-retry flags or a translation entry point sharing endpoint/header helpers; existing review/caption behavior stays unchanged. `redirect:error`, `credentials:omit`, `cache:no-store`, `referrerPolicy:no-referrer`. Keys are request-local, cleared in finally, never stored in dialog/draft/localStorage, nor captured by snapshots. Exact selected endpoint determines headers and key. Config preparation discards the key immediately and retains only secret-free disclosure.

## Editor state, consent and atomic application

Operate mode within Editorial desk; no unrelated redesign. A secondary Translate with AI action beside locale controls opens the existing styled native-dialog pattern. Target is the other locale, explicitly named. Single-language installs hide the action; omitted source/target shows an explanation directing the existing coverage control and never enables it. Header names direction; body contains provider/name/kind, exact endpoint/model, title/excerpt/prose/local-description disclosure, no images/GPS/shared metadata, possible charges, library authority and retained opaque-source warning. Opening/preparing does not call a model.

States: preparing → ready → translating → review → applied, with error/cancel/stale branches. Explicit Translate invocation flushes pending gallery edits and captures latest live body and both locale drafts. Fetch fresh config; any provider/id/kind/endpoint/model/timeout change rediscloses and requires another explicit click. At every async boundary check operation epoch, article, active locale, enabled/omitted coverage, form generation and exact whole draft snapshot. Invalidate on source/target/shared input, programmatic body changes, locale switches, coverage changes, recovery/reload, save-base changes and article creation/switch. Abort invalidated calls; late responses never revive review or mutate state. Recheck before and after replacement confirmation and before application. Config-fetch failures never trigger inference.

Review uses textContent/plain read-only fields for complete title/excerpt/Markdown, with translated local metadata included in review; no model HTML. Explicit Apply writes only the validated target patch. If any target title/excerpt/body/local metadata exists, require unchecked replacement consent or existing scoped confirm dialog naming target and overwrite fields. Discard/Escape/Cancel changes neither locale. No autosave, publish, asset upload or alternate server write.

Apply is synchronous after all validation/confirmation. Precompute the full merged target patch and retain exact before-fields plus CodeMirror history/selection. Use one `cm.operation()` and `replaceRange` for the complete body (not `replaceDocument`, which clears history); title/excerpt are assigned directly WITHOUT the slug-deriving title input event. The existing bridge's source-change synchronization updates Visual and falls back to intact Markdown on rich-view failure. Body undo remains body-only; the dedicated Undo translation restores title/excerpt/body/map together. Locale switching must not reset either locale's body history.

The bridge must expose a synchronous source transaction that defers ALL source-to-Visual and selection synchronization until the field commit succeeds. During a failed commit, restore CodeMirror source/history/selection while synchronization remains deferred, then resume without changing the rich document; ProseMirror undo/redo state is therefore untouched. After successful field commit, resume with one source-to-Visual synchronization; a rich-view error keeps the completed canonical draft and switches to Markdown. No rollback may replay source changes into the rich engine. A real-engine regression must start with existing Visual undo/redo entries, inject commit failure, then exercise both engines' undo/redo and verify the exact pre-commit histories/content. Ordinary successful application remains an undoable body edit in each engine.

During commit, an explicit applying guard suppresses translation self-invalidation and dirty/stash callbacks until all allowlisted target fields are assigned. If the synchronous commit fails, restore before-fields/body/history/selection before releasing that guard, report failure, and do not switch locale or mark the partial result dirty. After successful commit, release the guard, invalidate older requests, mark dirty and stash through existing DraftGuard, then switch to target. A stash/storage failure is a separate recovery warning: it must not misreport the already-complete in-memory application as partial. Preserve updatedAt and unrelated map entries. Dedicated Undo is available only while the target fields exactly match the applied patch and article/form identity is unchanged; otherwise refuse rather than overwrite newer work. Saved revisions and normal recovery remain the longer-lived recovery path. Optimistic conflicts remain normal Save conflicts and retain local work.

All new copy is in DE/EN `site/src/i18n/ui.ts`, emitted through existing editor/settings dictionary conventions. Admin chrome follows current English convention. Native dialog traps focus, Escape aborts/discards, close restores visible trigger; progress/error has polite status and actionable focus after failures. Controls remain reachable at phone widths; wrap long endpoint/model text. No automatic scrolling/focus theft during typing.

## Misuse cases, recovery and rollback

Prompt injection can degrade translated meaning but cannot select fields/ranges, routes, credentials, assets or persistence. Structural checks and entity escaping prevent output becoming structure; existing sanitization/image-origin validation remains mandatory at preview/save/build. A strict schema prevents prototype keys and arbitrary field writes. CORS/provider failure, cancellation, timeout, truncation or stale output leaves drafts unchanged. A lost response costs at most the explicitly invoked request; retry is always manual.

Rollback frontend/backend translation additions together. Existing saved Markdown/maps remain ordinary content; no schema/data migration or destructive recovery. Assignment fields can remain ignored by an older version; retain settings backup before downgrade. Revert an unwanted applied draft with guarded Undo before further target edits, normal local recovery, or saved revisions; saving/publishing remain explicit. No rollback action rebuilds or changes live content automatically.

## Verification gate

Use the single acceptance checklist in the plan. Tests must exercise actual behavior, not source-string wiring: complete assignment lifecycle and endpoint-key isolation; both directions and exact non-text preservation; repeated/empty/hidden captions and Media precedence; hostile/missing/duplicate/truncated output; no retries; cancellation/staleness/config consent; atomic allowlist application and undo; enabled/omitted restriction; actual normal save optimistic conflict. Integration tests use a distinct disposable database. Browser uses real local app, controlled free provider fixture and isolated draft/images, both modes/directions, save/reopen/preview, keyboard and desktop/mobile. Never publish. Required CI and independent final PR review are mandatory.

Mandatory documentation gate: update or explicitly reconfirm `SECURITY.md` for translation-purpose auth and endpoint/key binding, browser-only provider transport, ephemeral credentials, authenticated non-mutating source analysis, bounds, and no Media writes. Update the AI section of `docs/claude/security-and-operations.md` to describe the third assignment without weakening policy; add shipped status to `docs/claude/project-status.md`.

Regression additions from independent review: reject empty/whitespace output for every nonempty slot kind, while preserving original intentional empty overrides; exercise synchronous application callbacks, rich-view initialization failure, body history and whole-translation undo in both modes, and rollback of application failure with unchanged source/shared/slugs.

Register the new authenticated API namespace in `site/src/lib/reserved-routes.ts` without changing grandfathered existing slugs or published URLs.

## Pre-implementation review record

Initial specialist `reviewer` and `security-reviewer` agents, followed by two general-purpose agents, failed before review because their configured `anthropic/claude-fable-5-1` returned HTTP 429. No review is claimed for those failed attempts.

A separate stateless review through the `completion` API's `slow` selection returned REQUEST CHANGES on empty-output rejection, concrete atomic/undo semantics, and the mandatory security documentation gate. Those three findings are incorporated above. A fresh independent re-review returned APPROVE for the revised design only, with Visual-mode history explicitly remaining an implementation-verification gate. The API exposes the `slow` selector, not its underlying model identity; this advisory review is not misrepresented as a named-model agent review.

The owner then authorized a session-only agent-model configuration change. Independent `DesignApproval550` (`reviewer`) and `SecurityApproval550` (`security-reviewer`) both used `openai-codex/gpt-6-astra` with high reasoning. Design review initially requested heading-fragment preservation and deferred Visual history synchronization. Both corrections were incorporated and re-reviewed. Both agents explicitly APPROVED the revised design, with no remaining design/security blockers, before implementation began. Their review was source-grounded and read-only; neither approval substitutes for runtime/browser/CI verification.

Before implementation, local prerequisites were prepared: Node v26.13.0, clean dependency installation in both trees, successful native ownership build and browser asset generation. A dedicated PostgreSQL 18 container exposes loopback port 55550 with separate `translation550` and `translation550_test` databases. The baseline app uses loopback port 35550 with all writable paths under this worktree's `.local-550` and SITE_APP_DIR pointing to this worktree's site. A disposable admin was created and the actual baseline Visual editor opened in an isolated managed browser. No paid provider request, publication or production-data access is authorized.

## Local implementation evidence

- Node 26.13.0; native ownership build and self-hosted assets generated. Disposable PostgreSQL
  18 content/integration databases were separate; all writable paths and SITE_APP_DIR pointed
  inside this worktree. App/provider listened only on loopback 35550/35551. An inherited
  IMG_HOST was corrected explicitly for local photo serving; no production state was used.
- Ran `npm test` in both trees, uploader `npx tsc --noEmit`, and site `npx astro check`
  against the initialized content database. Astro checked 155 files with no diagnostics.
  Full-suite failures were corrected, then only affected suites reran: compiler 55/55,
  editor DOM 279/279, real CodeMirror/ProseMirror histories 5/5, and the three affected
  PostgreSQL integration suites 60/60. The complete uploader run exercised all 181 files,
  including database-backed paths rather than skipped integration tests.
- The site full run initially skipped seven database cases; all were subsequently exercised:
  navigation/journey snapshot suites and four real empty-site builds across language modes.
  Local runtime legal generation exposed an existing fixture-isolation defect. Per the
  documented #291 boundary and independent security review, the fixture now stages all
  public assets except the generated root legal directory. Exact route inventory and
  full emitted-file branding assertions remain intact; legal-assets coverage is unchanged.
  The four builds then passed. No notice or branding policy was weakened.
- Compiler corrections preserve CRLF physical spans and complete malformed/nested/unclosed
  BodyImage regions. GFM may create autolinks after entity decoding; such changed structure
  is intentionally rejected atomically instead of weakening the fingerprint. Failed-commit
  regressions traverse real undo/redo content and public selection positions, not incidental
  editor-internal object prototypes.
- Managed Chromium used three real uploaded fixture photos and a free controlled provider.
  Three galleries (breakout, slider, hidden-caption column), one inline image, repeated URLs,
  distinct/empty/hidden overrides and opaque math survived DE→EN and EN→DE, in both Visual
  and Markdown source modes, through review/apply, ordinary Save, reopen and draft preview.
  Latest unsaved text was included; source/shared fields, manual slugs, draft publication
  state, target hero/facts and unrelated image-map entries stayed unchanged. Media remained
  exactly three photos with unchanged bilingual library descriptions; previews used library
  descriptions and occurrence overrides correctly.
- Browser checks covered unchecked overwrite protection, full-field Undo, reviewed-result
  discard, Escape cancellation/focus restoration, stale source invalidation, renewed model
  consent with zero requests until another click, and five error fixtures (HTTP 400,
  malformed JSON, truncation, missing slot, empty slot), each exactly one request and no
  draft mutation. Omitted source/target guidance prevented inference; an isolated single-
  language database fixture hid the action without rebuilding or publishing.
- A second real editor advanced the stored revision; saving an applied translation from the
  old editor produced the normal conflict, retained the complete local draft, and blocked
  further translation. Reopening and choosing Restore recovered that exact draft without
  automatically saving. Both locale bodies and histories remained usable.
- Desktop 1360×960 and phone 390×844 screenshots covered consent/review, Settings and
  rendered previews; no horizontal overflow. Native Tab, Space and Escape worked. The
  Impeccable detector ran once: existing dynamically populated image elements, the mandated
  Inter font and unresolved `/admin/` stylesheet paths produced warnings, not new translation
  defects. Actual runtime images loaded after the isolated image-host correction.
- No paid provider requests, automatic retries, publishing, releases or deployments occurred.
  Temporary provider/photo/database helpers are outside the committed deliverable.

## Independent PR review corrections

Independent workflow and security reviewers of PR #551, both
`openai-codex/gpt-6-astra` (high), identified two actionable defects:

1. The configuration recovery link used `#ai`, which Settings treated as unknown and opened
   Site identity. It now uses `#ai-models`; a DOM navigation regression follows the real
   editor destination through Settings' tab dispatcher. Actual Chromium reproduced the
   wrong destination before the fix and reached the AI assignment panel afterward.
2. Identical gallery-only source/target Markdown could change local fallback metadata without
   refreshing the existing Visual node views. Successful atomic transactions now refresh
   metadata-dependent views independently of Markdown equality, with no document/history
   transaction. Views reread current maps while retaining Media and occurrence-override
   precedence; failed transactions never refresh them. Identical-body Apply/Undo avoids
   unnecessary CodeMirror replacements. Real-engine coverage includes rollback, undo/redo,
   ownership and inline rendition metadata.

The second defect was reproduced in the actual app with an unresolved-photo gallery:
review contained `First view`, but the old Visual caption remained after Apply. After the
fix and rebuilt self-hosted bundle, Apply immediately displayed `First view`, mode switching
retained it, Undo restored `Old caption`, and save/reopen/preview retained the translated
caption. Markdown was byte-identical and CodeMirror history depth stayed unchanged.
These corrections preserve the approved architecture; final focused re-review and CI
outcomes are recorded on the PR.
