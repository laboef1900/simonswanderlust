# Publish readiness follows rendered image references (#334)

Date: 2026-10-25. Risk: **High** (publication gate and body-render interpretation).
Status: Owner-approved for implementation and isolated verification.
Part of #331, finding 3. This is not authorization to merge, deploy, or mutate owner content.

## Problem and scope

Single and bulk publication currently ask the media store about heroes, title images, and
all stored `images` metadata keys. A Markdown or raw HTML image can render without a metadata
entry and bypass the gate, while an unused entry can prevent publication indefinitely.
The reported behavior is accepted ground truth; reproduction is not a prerequisite to the fix.

Replace only the reference discovery used by these publication gates. Do not prune or migrate
metadata, change media usage/deletion policy, add disk probing, change routes/slugs, modify
publication concurrency tokens, or address publication-state UX roadmap issues.

## Concrete mechanism

1. Extend the existing renderer-backed publication analysis in `uploader/src/publish-gate.ts`
   into one body-analysis function returning foreign image URLs and actual body image sources.
   Render each locale's Markdown **once**, with the existing `renderMarkdown`.
2. Preserve the foreign-origin interpretation: run `analyzeRenderedBody` (expanded and renamed by #375) on that rendered HTML
   **before** metadata resolution. Retain both source URLs and gallery lines for this check,
   including foreign gallery lines the transform would drop. Keep origin equality and the
   existing HTTP(S)/relative-URL interpretation; never replace this with a Markdown regex.
3. For readiness, run that same rendered HTML through the actual `transformBodyImages` with
   the locale's stored `images`, then use the existing sanitized-tree source reader's `sources`
   (not its unresolved `galleryLines`). Thus an emitted inline image, raw HTML image/picture,
   or resolved gallery counts; a code example, removed image, or unresolved gallery text does
   not. Generated responsive pictures name the same media key across their fallback/source
   variants; reading their surviving image fallback suffices even if re-sanitizing removes a
   generated attribute. Tests will pin this against actual transformed markup.
4. In `server.ts`, collect the two locale analyses once per attempted publication, merge actual
   body sources with both heroes and title images, and deduplicate storage keys. Run the
   unchanged foreign-image refusal before media lookups. Both single and bulk paths consume
   this same analysis and existing media-status checks.
5. Map actual body URLs to hosted storage keys with URL parsing and origin/path-boundary
   equality. Resolve relative body sources against the locale's public story URL (DE at root,
   EN under `/en/`), not a guessed Markdown grammar; normalize URL query/fragment away before
   stripping the existing numeric variant suffix. Support exactly the stored output formats
   `avif`, `webp`, and `jpeg`. Preserve the existing hero/title URL validation contract rather
   than making relative URLs newly valid for those fields. No network or filesystem access is
   introduced by reference analysis.
6. Keep `media.notReadyKeys` unchanged: known rows with `processing`, `failed`, or `missing`
   status refuse publication. No-row body/hero references retain the deliberate legacy
   exception. Title images retain their stronger requirement for a known `ready` library row.
   Existing response status codes/shapes and per-post bulk failure semantics remain unchanged.

No gallery metadata lookup is needed for readiness: library alt/caption overrides do not change
which image URLs the transform emits. No second sanitizer schema, Markdown parser, or gallery
scanner is introduced. The existing foreign helper's exported callers/tests migrate to the
combined analysis rather than leaving a dead compatibility alias.

## Trust boundaries and invariants

- Stored Markdown and metadata are author/importer-controlled. The actual existing sanitizer,
  gallery allow-list, dimension guards, and responsive-image transform interpret them; none
  is relaxed. Rendered analysis output is discarded, not served by the gate.
- Publication remains admin-only. The foreign gate still runs before readiness database access;
  credentials, GPS, paths on disk, and other authors' data are not newly exposed.
- Known not-ready photos referenced in **either locale** block single and bulk publication,
  including direct AVIF/WebP/JPEG variants with no `images` entry.
- An unused metadata entry alone never blocks. A resolvable gallery still blocks on its actual
  photo; an unresolved same-origin gallery URL remains visible text under the existing renderer
  fallback and does not become a new image requirement. Foreign gallery refusal remains intact.
- Heroes remain checked even when a title image supplies the story banner: cards/social output
  still use the hero. Missing-row legacy hero/body references remain allowed; missing-row title
  images remain forbidden. Existing hero/title structural and alt requirements remain intact.
- Readiness failures happen before `posts.publish` and before requesting a build. Drafts and
  existing published snapshots remain unchanged; the existing token/revision checks still guard
  a concurrent save between analysis and publication.
- This remains a media-row readiness check, not a guarantee of file existence or a new lock
  across encode/publication. Reconciliation continues to own disk/status consistency.

## Misuse and design self-review

**Could reusing the foreign gate's pre-transform list still over-block?** Yes: a same-origin
unresolved gallery can remain only code text. Readiness therefore reads the transformed result,
while foreign detection deliberately retains its pre-transform view. This distinction also
avoids treating obsolete metadata as references.

**Could URL spelling bypass the row lookup?** Direct variant suffixes, query strings, fragments,
root-relative/protocol-relative references and path-relative references must map to the key the
browser requests; origin equality must reject lookalike hosts. Focused tests will cover these
forms and locale-relative resolution. URL decoding must follow served-path behavior without
accepting a different origin or inventing access to files. No unsafe value reaches filesystem
operations: keys only parameterize the existing media-store query.

The combined analysis avoids rendering Markdown twice per locale. Extra transformation and
HTML-tree traversal are bounded by existing request/body constraints and occur only on the
already guarded publication path. Existing renderer resource limitations remain; this change
adds no input limit, retry, or separate rendering implementation.

## Failure, recovery, and rollback

A renderer or media-store failure fails the request through existing sanitized error handling;
never convert uncertainty into permission to publish. Bulk keeps its existing per-post error
accounting. A failed readiness check requires no rollback because it writes nothing.

Authors recover by waiting for encoding, retrying/reconciling failed or missing media through
existing controls, replacing/removing the actual reference, or repairing a selected title image.
Removing an image no longer requires manually purging stale metadata. Build failures after an
allowed publication retain the existing snapshot/build behavior and last-good-release handling;
this fix does not redesign them.

Rollback is reverting this focused application/test/documentation commit: no schema migration,
data rewrite, metadata deletion, new setting, or persisted analysis exists. Reversion reopens the
reported readiness bypass/false refusal, so prefer a forward correction; no automatic rollback
or production operation is authorized. Reconfirm the image publication and output-sanitization
sections of `SECURITY.md` alongside implementation.

## Verification and delivery plan

After approval and a coherent implementation batch:

- Renderer tests: Markdown/raw HTML, direct `avif`/`webp`/`jpeg`, raw picture sources where the
  sanitizer retains them, variant query/fragment/relative spelling, referenced versus stale
  metadata, resolved/unresolved galleries, code examples, duplicates and either locale. Assert
  against actual transformed output, not only a mock URL list.
- Single and bulk route regressions: `processing`/`failed`/`missing` block actual references;
  all-ready and stale-unused-metadata cases succeed. Assert HTTP/per-item outcomes, stored
  status and published snapshots, and no build on refusal. Preserve hero/title, foreign-origin,
  no-media-row legacy, and concurrency coverage.
- Real Postgres integration using only `sw331_c_test`: persist refusals and accepted snapshots,
  including an already-published post whose later failing draft must not replace live content.
- Isolated runtime/API proof using `sw331_c_app` and port 34323: create synthetic photos/posts,
  exercise real single and bulk handlers and persisted state; successful allowed publication
  must invoke the **real Astro builder**, produce a release, and serve the expected story/image
  output. Keep runtime/evidence files under this worktree's `.superpowers/331-*` directories.
- Node 26.12.1/Postgres 18; complete affected uploader/site Vitest suites (integration enabled),
  uploader typecheck, Astro check, and successful local real Astro build. Record exact results
  and limits; no mocks count as real-build proof. Never run integration cleanup on the app DB.
- Commit focused code/tests/docs, push feature/331-publish-readiness, open PR targeting dev with
  `Closes #334` and `Part of #331`. Parent supplies a fresh independent reviewer; address valid
  findings, rerun affected verification, and require green CI. No merge/deployment.

## Approval

Owner approval received in the implementation conversation on 2026-10-25: **“Approve #334 spec”**,
for the exact mechanism posted at
https://github.com/laboef1900/simonswanderlust/issues/334#issuecomment-6401591437.
The parent relayed this explicit approval before implementation began. Approval covers
implementation and isolated verification only, not merge, deployment, or owner-content changes.

## Local implementation evidence (2026-10-25)

- Uploader full suite with isolated Postgres integration enabled: **99 files, 2,296 tests passed**
  (`npm test -- --maxWorkers=2` with `TEST_DATABASE_URL` pointing only at `sw331_c_test`).
  `npm run typecheck` passed.
- Site full suite: **27 files, 364 tests passed**; `npx astro check` against the isolated
  application database reported **0 errors, 0 warnings, 0 hints** across 99 files.
- Real `src/main.ts` runtime on localhost:34323 and `sw331_c_app`: **36 refusal cases**
  (single/bulk × processing/failed/missing × AVIF/WebP/JPEG × Markdown/raw picture) preserved
  draft status and null published snapshots. Known-ready heroes/title images were present.
- Both allowed single and bulk cases retained unused not-ready metadata, rendered a ready body
  variant and a no-media-row legacy image, persisted both locale snapshots, and invoked real
  Astro builds successfully (13 and 15 pages respectively). The served stories returned 200
  with the expected body; the ready variant returned 200 and the absent blocked variant 404.
- Managed Chromium loaded the built story, the selected title image, and both body images;
  following prose remained visible and there were zero broken-photo references in the DOM.
  The screenshot and JSON/API evidence are local ignored artifacts under
  `.superpowers/331-evidence/`.
- The new Postgres regression also starts from a published snapshot, saves later failing
  drafts, and confirms neither publication path replaces that snapshot or requests a build.
- Limit: these are synthetic isolated fixtures, not owner content or production verification.
  Real builds emitted the existing Vite large-chunk advisory; empty-content warnings occurred
  only on the initial fresh-database bootstrap, before fixture publication. Neither prevented
  successful builds. Independent review and required CI are tracked on the PR separately.
