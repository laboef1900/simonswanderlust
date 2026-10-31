# Literal re-host substitution — issue #360

**Date:** 2026-10-27  
**Status:** OWNER APPROVED 2026-10-28 — callback-only literal substitution and the stated verification/recovery boundaries. Implementation and verification remain required; no existing-content repair or deployment is authorized.
**Risk:** High — WXR import and persisted author content.  
**Baseline:** `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and scope

The issue's supplied reproduction is accepted evidence, not a newly executed test.
`uploader/src/wp-import.ts:507–516` passes a replacement **string** to
`replaceAll`. JavaScript consequently interprets `$$`, `$&`, `$\`` and `$'` in
image alt text. `buildLocale` and `mergeLocale` both call this same
`applyRehosts` helper. The latter operates on the author's stored Markdown, so
this is not confined to the initial WordPress conversion.

Implement only literal substitution. Preserve the existing `markdownImages`
contract (`wp-content.ts:134–182`): `full` is exact matched Markdown, `alt` is
already Markdown-escaped source text, and `url` is the decoded lookup key.
Do not escape dollars, decode/re-escape alt text, change image matching, or add
a second substitution path for merge runs.

## Proposed engineering contract

In `applyRehosts`, replace the string replacement argument with a function
returning the same `![${alt}](${r.src})` string. Keep `replaceAll(full, …)` so
identical occurrences retain their existing handling. This treats the complete
replacement as literal output, including any dollar sequence in the returned URL.

- Successful re-host: change only the matched image's destination and retain
  the current behavior of dropping its optional image title. Preserve alt source
  bytes exactly; surrounding prose is neither copied nor removed.
- Failed/unattempted re-host: keep the original image markup, including its
  WordPress URL. Do not claim every possible run has no old-domain URL.
- Keep `record()` metadata movement/merging, dimensions and format handling,
  gallery exclusion, gallery rewriting, pair-level deduplication and image
  accounting unchanged.
- Fresh imports and explicit `overwriteDrafts` use the same corrected helper;
  default merge re-runs preserve stored prose, editorial metadata and chosen hero.
  Already-published pairs remain untouched.

**Affected files:** `uploader/src/wp-import.ts`,
`uploader/test/wp-import.test.ts`, this spec, and a brief `SECURITY.md`
reconfirmation in the implementation. No exported API, schema, dependency,
route, slug, UI-copy or owner-data changes.

## Trust boundaries and verification contract

The input is untrusted WXR alt text or stored author Markdown. A replacement
callback prevents string-substitution instructions from being interpreted; it
is not an HTML sanitizer. Existing SSRF/redirect/size/time guards, image-map
validation, gallery origin checks, render sanitization, import authorization,
image caps, work locks and EXIF/GPS policy remain mandatory and unchanged.

Add deterministic regressions to the existing import tests, with an injected
re-host result and disposable memory stores, never remote fetches:

1. Fresh paired WXR with `<img … alt="Menu $$ and $&amp; here">`, plus separate
   alts containing `$'` and `$\``. Include distinctive intro, middle and ending
   paragraphs and multiple images, as in the reported input. Assert the exact
   stored Markdown, unchanged parsed alt strings, no duplicated surrounding
   text and no `wp.example` destination when every fixture photo succeeds.
2. Merge re-run where the stored draft's alt contains all four sequences and
   differs from the export's alt. Assert the stored alt wins byte-for-byte,
   other author edits survive, the URL is healed and the pair counts as updated.
3. Repeated identical images still all substitute; an unsuccessful photo keeps
   its original markup, contributes to failed-image accounting and receives the
   existing warning. Existing metadata/gallery and published-skip tests remain
   applicable; do not weaken them to fit the fix.

The implementing agent must run the affected uploader suite and typecheck,
including existing integration coverage with disposable Postgres where required.
The callback fix and focused regressions are implemented. Uploader typecheck and the
import suite pass. Real multipart imports against isolated Postgres preserved all four
dollar sequences through fresh import and an editor-save/merge re-run; complete synthetic
variants were encoded locally and resumed by the real importer, with no external fetch.
Full CI-equivalent checks and independent final-head PR review remain required.

## Security documentation, recovery and approval

Reconfirm `SECURITY.md`'s input/output validation, gallery text isolation and
partial-import publish gate: literal replacement changes none of their trust
rules. The #85 hardening, #125 image-destination and #126 merge specifications
remain the underlying contracts.

Rollback is a code revert with no migration, but reintroduces corruption on the
next affected import: contain by not running imports until the corrected code is
restored. Reverting does not repair already-corrupted drafts. Recovery requires
owner review of an existing revision/export/backup and a targeted normal editor
save; do not automatically re-import, overwrite drafts, restore a database or
publish anything.

**Owner approval recorded 2026-10-28:** callback-only substitution, fresh/merge
regression coverage and unchanged safety boundaries. This does not authorize
existing-content repair, publication, deployment or changes to re-host policy.
