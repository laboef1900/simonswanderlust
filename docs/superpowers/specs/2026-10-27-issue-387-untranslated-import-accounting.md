# Account for untranslated WordPress stories — issue #387

**Date:** 2026-10-27  
**Status:** OWNER APPROVED 2026-10-28 — report-and-reject accounting on the current bilingual runtime, preserving #283's later mode-aware contract. Implementation and verification remain required; no owner-content changes or deployment are authorized.
**Risk:** High — WXR import admission/accounting.  
**Baseline:** `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Problem and policy boundary

The issue's reproduction is accepted evidence, not a new test run. In
`wxr-parse.ts:48–52`, a published DE/EN post with no `post_translations` category
is discarded before the importer can reject it. A grouped post with a missing
partner reaches `wp-import.ts:789` and is counted; the untranslated post does
not. The existing parser test explicitly expects that silent omission.

**Recommended decision:** report each such post as rejected, without importing
it, fetching its photos or writing a draft. Keep the current requirement for
both DE and EN import members and both publication locales. This fixes silent
loss of accounting, not untranslated-story support. The author must see that the
live WordPress story has not been migrated; no translation or slug is invented.

There is a real sequencing distinction with the **owner-approved #283** contract
(`2026-10-27-issue-283-language-mode-contract.md`, sibling worktree, §8.4): its
future mode-aware importer permits a primary-only draft and defines handling for
untagged items. That contract is approved but is not the baseline runtime.
This proposal neither rescinds it nor implements its mode/schema/omitted-row
prerequisites. Here, a known DE/EN language with a missing group is specifically
an *untranslated post*, not an unknown-language post. #283's combined wording
“no language/post_translations” must not be interpreted to erase that distinction.
If mode-aware import implementation lands first, reconcile admission under that
approved contract instead of adding this baseline two-locale refusal afterward.

## Minimal contract and affected callers

1. Keep the existing paired `ParsedPost` shape and `posts` collection. Add an
   explicit `ParsedWxr.untranslated` collection of `{ locale: 'de' | 'en'; slug:
   string }`, populated only for `post` + `publish` + recognized DE/EN language
   with absent/empty translation-group metadata. Keep slug bytes verbatim.
   Existing field decoding remains the single parser contract. No synthetic
   group name, post-id requirement, title matching or locale guessing.
2. In `prepareImport`, count each entry once in `rejected` and add a capped
   warning naming its slug and locale and explaining missing translation.
   Keep these entries separate from the group map: two untranslated items must
   not accidentally form a pair, and an attacker-controlled Polylang group
   string cannot collide with a fabricated group key. No re-host plan or store
   write is created for these entries, even with `overwriteDrafts` enabled.
3. Preserve summary JSON fields. Accounting becomes:
   `imported + updated + skippedPublished + rejected + failed === distinct
   Polylang groups + untranslated published DE/EN items`.
   The count is of reportable units, not XML rows in bilingual pairs. Duplicate
   groupless XML items count as separate reported items; this patch adds no
   deduplication or pairing policy.
4. Set `PreparedImport.groups` to that reportable-unit count. The existing
   `POST /import` zero-count guard must therefore admit an untranslated-only
   export as a normal **202 job**, whose completed summary contains refusals;
   it must not return the generic 400 and hide the reason. A truly empty eligible
   export still returns 400. `planned.groups.total` continues to count pending
   accepted pairs only, so a rejection-only job has zero work and can complete
   with an honest nonzero rejected summary. Do not change progress semantics.
5. `import.html` already shows the rejected bucket and safely renders warnings
   with `textContent`. Reuse that presentation, not a new panel or endpoint.
   Treat an untranslated item as a singleton reporting group for the existing
   “post group(s)” callout; the item-specific warning explains it accurately.
   New warning copy lives in `site/src/i18n/ui.ts` in DE and EN (with slug/locale
   placeholders), resolved for the existing English admin summary without adding
   a locale selector or changing the warning-array API. Suggested meaning:
   “{slug} ({locale}): no translation (untranslated post) — rejected”.

**Implementation files:** `uploader/src/wxr-parse.ts`, `uploader/src/wp-import.ts`,
`uploader/test/wxr-parse.test.ts`, `uploader/test/wp-import.test.ts`, existing
`uploader/test/server.test.ts` route coverage, `site/src/i18n/ui.ts`, and the
relevant import paragraph in `docs/authoring-workflow.md` plus `SECURITY.md`.
Reconfirm `server.ts`, `import-jobs.ts` and `public/import.html` consumers; change
only comments if their existing runtime handling already satisfies this contract.
No schema, endpoint, route, public slug or dependency changes.

## Safety and acceptance scenarios

Untrusted XML remains subject to the same parser limits/error mapping and upload
limit. New warning values are text, never markup, filenames or fetch targets.
Use the existing warning cap/omission notice; counts remain exact even when
individual warnings overflow it. Existing rejection of unsafe slugs, exact pair
identity, published-skip behavior, draft merge, work cancellation, image cap,
SSRF controls, private originals and output sanitization remain unchanged.
Unknown/missing language, other post types and non-published posts retain their
baseline exclusions; they belong to #283's broader policy, not this fix.

Required disposable-input regressions, with no network:

- The issue's pair `g1` + groupless DE `nur-deutsch` + DE-only `g2`/`halb-de`
  yields `imported: 1`, `rejected: 2`, and warnings naming both refused stories;
  the five buckets sum to three reportable units.
- Groupless EN and DE items are individually reported, including multiple items
  and items sharing slugs or names resembling real group IDs; none forms a pair.
- An untranslated-only export produces `PreparedImport.groups > 0`, zero planned
  pairs/photos, a 202 route result and a completed status summary with rejections.
  No re-host or upsert occurs. Empty eligible input still produces the existing 400.
- Draft/private posts, attachments and unknown languages remain excluded as
  before. Grouped incomplete pairs and complete pairs preserve existing behavior.
- Warning overflow preserves exact rejected counts and the existing bounded
  warning behavior; HTML-like slug text renders as text in the existing UI.
- Replace the current parser test's “silently skipped” expectation with explicit
  untranslated collection assertions; keep all XML failure-contract tests.

Uploader typecheck/full affected tests (including route/job persistence integration
with disposable Postgres) and site i18n completeness remain the integration owner's
verification responsibility; the runtime-only evidence below does not replace them.

## Isolated runtime evidence — 2026-10-28

The real `uploader/src/main.ts` served multipart imports on loopback port 33487
against disposable `swl_387_dev`, with all writable paths confined to this
issue's `.issue-runtime`. No owner content or production service was used.

- Original three-unit example: HTTP 202, completed with `imported: 1`,
  `rejected: 2`, all other post buckets zero; exactly two locale rows created.
- Extended mixed export: the same valid pair updated once, the grouped missing
  partner and individual groupless DE/EN items rejected (`updated: 1`,
  `rejected: 3`); no additional post rows.
- Grouped-only refusal: HTTP 202, completed with exactly one rejection.
  Groupless DE/EN-only refusal, with overwrite enabled: HTTP 202, completed with
  exactly two rejections. Both planned zero pairs/photos; full persisted
  post/revision snapshots and image-directory entries remained unchanged.
- Every fixture contained zero images. App-side undici request diagnostics
  recorded zero outbound requests; every summary reported zero image work.
  This does not exercise external downloads, encoding, resume, or a SQL
  statement audit.
- Empty eligible export: HTTP 400 (`no importable posts found in export`).
- After stopping and restarting the app, the same completed job ID, summary,
  status and progress were returned. The persisted `updatedAt` was 1 ms earlier
  than the original in-memory response; whole-job byte equality is not claimed.
- Managed Chromium loaded the real persisted status without response interception.
  At 1440×1000 and 390×844, the DE `<img …>` and EN `<b …>` slug warnings stayed
  literal text: zero child markup nodes, no executed sentinel, and no horizontal
  overflow in the workspace, results or warning list. The existing English admin
  UI was inspected; no German admin language mode is claimed.

Local evidence: `.issue-runtime/import-387-proof.json`,
`import-387-browser-proof.json`, `import-387-desktop.png`,
`import-387-mobile.png`, `import-387-runtime.log`, and
`import-387-restart-runtime.log`. Synthetic accounts and owned runtime
were stopped/removed; synthetic post/job data was retained. No automated suites,
typechecks, standalone builds, dependency changes or deployment were performed
by this runtime-only slice.

## Recovery and owner decision

Reconfirm `SECURITY.md`'s import-boundary and warning-disclosure rules: untranslated
posts are refused before fetch/write; authorization and output handling do not
change. This extends #100's accounting rather than the #85 network policy.

No data migration is needed. Reverting code restores silent omission, so contain
by pausing imports or explicitly reconciling every export item before relying on
an old summary. Already-unimported stories remain solely in the export/source;
this proposal authorizes no content creation, translation, overwrite, restore,
publish or deployment.

**Exact owner decision requested:** approve **report-and-reject on the current
bilingual runtime**, including a 202 completed rejection-only job, with known
DE/EN groupless posts counted individually. Confirm that this is an interim
accounting correction, not authorization to bypass bilingual publication or to
change the approved #283 mode-aware admission contract. If the owner wants those
stories imported now, that is the #283 implementation dependency, not an
alternative hidden inside this fix.
