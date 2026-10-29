# Truthful publication-state contract and source of truth (#316)

Date: 2026-10-27
Status: **OWNER APPROVED 2026-10-28 — content comparison, measured Media pending counts and the
precise §8.5 AC4 amendment.** Implementation and verification remain required; approval authorizes
no deployment or owner-data mutation.
Risk: **High** — the approved manifest persists per-release state under `/data/site` and
touches the build/publish pipeline (`uploader/src/build.ts`, `site/src/lib/postgres-loader.ts`).
This feature adds no Postgres schema or dump-version change. Version 10 is the inspected baseline,
not a requirement to revert approved identity/language format increments from #273/#283.
Parent epic: #315. Consumers: #317 (editor, posts list, Desk, preview) and #318 (Media impact).
Inputs: PR #271 (merged into `dev` as `d418c75`, spec
`2026-10-19-gallery-library-metadata-design.md`) and #297 (owner-approved durable last-build record,
spec `2026-10-27-issue-297-publish-recovery-design.md`).
Baseline: `origin/dev` `11e16d1`.

## 1. Problem

The admin shows states the server does not track:

- `hasUnpublishedChanges` is `updated_at > published_at` (`rowHasUnpublishedChanges`,
  `uploader/src/posts.ts:754-758`). Every save runs `touchPostPair` (`posts.ts:971`), so a save
  with identical content raises "Unpublished changes" in the editor (`editor.html:2086`), the posts
  list (`posts.html:615-618`, `posts-filter.js:95`) and the Desk (`desk.js:16`, hardcoded heading
  `index.html:25`).
- Nothing records which content the **current release** contains. `POST /posts/:tk/publish`
  commits (`server.ts:1647`) and then builds (`server.ts:1653`). A failure **before promotion**
  retains the previous release, but today's post-flip pruning can also report failure after the
  new release is live. #397, owner-approved on 2026-10-28, fixes that boundary and remains an integration prerequisite.
- Since PR #271 a Media alt/caption save changes live article galleries on the next rebuild
  (`postgres-loader.ts:111-127`). `media` has no metadata timestamp (`uploader/src/db.ts:241-270`),
  and `imageUsage` (`media-files.ts:75-99`) has no use kind, no locale, and reports the About page
  `published: true` (`media-files.ts:93-96`) although About galleries never get the overlay
  (`pages-loader.ts:47` passes no gallery metadata).

## 2. Scope and non-goals

In: the state vocabulary, each state's source fact and staleness window, the per-release record
that makes "live" observable, the content comparison for "newer draft", the usage classification
#318 consumes, the media pending signal, permissions, wire contracts, verification and rollback.

Non-goals (invariants of every child):

- **No new publication behavior.** No read, state computation, Media save or upgrade triggers a
  build. Publish, unpublish, delete, page save, bulk and `POST /rebuild` keep their current
  semantics and authorization (`requireAdmin`, `server.ts:1605,1703,1771,1797,1932,1940`). A failure
  to write or read release state never fails or blocks a build, a publish or a promotion.
- **No new exposure of EXIF, GPS, uploader identity or secrets.** New projections carry only the
  explicitly enumerated state/impact metadata. Existing media serialization stays behind
  `serializeMedia` / `redactForNonAdmin`; it intentionally retains camera/lens/capture data and
  null GPS/uploader keys. This is NOT compliance with #318 AC4 as literally written: § 8.5 requires
  an explicit owner clarification before #318 implementation, not a silently narrower test.
- Does not redefine #297's last-build record (shape, durability, redaction) or #305/#306's
  `loadedUpdatedAt` resync and stale-tab handling.
- Does not change the #271 overlay, gallery rendering, the publish gate, or comment behavior
  (`comments_enabled` is read live from the working row, `comments-public.ts:102`, and is
  deliberately outside the snapshot and outside this contract).

## 3. Investigation: is `published_at` vs the release stamp sound?

Question from the issue: can `published_at` fall before a release stamp whose loader snapshot still
misses the commit?

Observed code (the issue's "`published_at=now()` at transaction start, `posts.ts:910`" is out of
date):

- `publish()` sets `published_at` to the value of `touchPostPair` (`posts.ts:1004-1011`), i.e.
  `GREATEST(date_trunc('ms', clock_timestamp()), MAX(updated_at) + 1 ms)` on the **database** clock
  (`post-pair-lock.ts:12-19`), evaluated *inside* the transaction, before the `UPDATE` and the
  `COMMIT` (`posts.ts:1013`).
- The release stamp is `Date.now()` on the **app** clock, taken inside the exclusive lock before
  the child starts (`build.ts:187`). The loader's `SELECT` runs later, in another process, under
  READ COMMITTED (`postgres-loader.ts:107-113`).
- Coalescing (`build.ts:226-279`) guarantees that the run a caller awaits *starts* after the
  caller's `COMMIT` — not that its stamp is `>= published_at`, and nothing about a run that was
  already in flight.

Answer: **unsound; never compare them.** Counter-examples:

1. Another admin's rebuild takes stamp `S` after the publish's `touchPostPair` (`P < S`) but its
   loader reads before the publish `COMMIT`; that release lacks the post. The publish route's own
   queued run then fails (or the process dies before it promotes). `current = S`, `P < S`, and the
   comparison says "live" — precisely in the case the state exists to report.
2. Two clocks: the DB may be another host (`DATABASE_URL`), and `GREATEST(…, prev + 1 ms)` can push
   `published_at` ahead of wall time after a restore from a skewed host.
3. A database restore (`restore` CLI) brings back `published_at` values older than every release on
   disk although those releases were built from the pre-restore database; a dump-time backfill even
   sets `published_at = updated_at` (`backup.ts:891-893`, `db.ts:143-145`).

Within one pair, however, `updated_at`, `published_at` and `post_routes.updated_at` all come from
`touchPostPair` under the pair's advisory lock (`post-pair-lock.ts:6-8`, `gpx-store.ts:51-57`), so
they are strictly ordered on one clock. Comparing them **with each other** is sound; comparing any
of them with a release stamp is not.

Conclusion: "live" must be read from **what the release's loader actually read**, recorded with the
release, and compared by **content identity**, not time.

## 4. Source of truth (recommended: Option A — per-release content manifest)

### 4.1 Manifest

Each promoted release has a best-effort manifest
`/data/site/manifests/<stamp>.json` beside `releases/<stamp>` (outside the served `current` root,
`server.ts:372-379`; `<stamp>` is the release directory name, which #297 calls `attemptId`/`release`):

```ts
interface ReleaseManifestV1 {
  schema: 1;
  stamp: string;                       // === releases/<stamp>; must equal the file name
  posts: Array<{
    translationKey: string;
    locale: 'de' | 'en';
    slug: string;
    digest: string;                    // 64 hex — PUBLISHED_SNAPSHOT_DIGEST_SQL of the row the loader rendered
    gallery: Array<{                   // one entry per RENDERED gallery photo occurrence, document order
      src: string;                     // the raw gallery URL the renderer accepted (origin + key)
      alt: string;                     // effective alt the release rendered
      caption: string | null;          // effective caption if visible and no caption-override;
                                       // null for hidden captions or ANY override, including empty
    }>;
  }>;
}
```

- **Writer: the trips loader**, the only code that knows what was rendered. `build.ts` passes a
  per-run path (`SITE_RELEASE_MANIFEST=<siteAppDir>/.build-tmp/<stamp>.manifest.json`) to the
  child; the loader writes exactly one entry per `store.set` (`postgres-loader.ts:128`), from the
  same rows it rendered, selecting `PUBLISHED_SNAPSHOT_DIGEST_SQL` beside `published_snapshot`.
  Without the variable (dev, `astro check`, tests) it writes nothing.
  The rows, enabled language mode and gallery metadata must come from #273/#283's approved
  exported PostgreSQL snapshot, shared with identity/assets and pages. Do not reinstate independent
  READ COMMITTED loader reads. The manifest records only the committed locale rows actually
  rendered, never requested working translations.
- **Digest:** one SQL expression, defined once in `site/src/lib/` and imported by the uploader
  (as `publish-gate.ts:28-29` already imports site libs):
  `encode(sha256(convert_to(published_snapshot::text, 'UTF8')), 'hex')`. Postgres computes it on
  both sides, so there is no second canonicalization to drift.
- **Promotion (parent, `buildAndDeploy`):** after `rename(staging, dest)` and **before** the
  `current` flip, validate the child's file (size cap 8 MiB, `schema === 1`, `stamp` match, strict
  types) and publish it via temp + `rename` to `manifests/<stamp>.json`. Any failure is logged and
  the flip proceeds: the release is then *manifest-less* and reads as `unknown` (§ 5). The manifest
  never decides whether a build succeeds.
  The loader's optional manifest write is also best-effort: directory creation, serialization,
  size-cap or write failure logs a bounded diagnostic and leaves no valid manifest, but must not
  fail Astro's otherwise successful render. Parent manifest-directory creation/publication remains
  under the storage ownership guard; optional state never bypasses a lost lease.
- **Irreversible boundary:** successful `rename(tmpLink, current)` is promotion. After it, pruning,
  lease loss or #297 record-write failure cannot downgrade the successful build or disregard the
  promoted manifest. #397 is separately owner-approved and must be integrated first; this document
  neither broadens it nor provides an interim ordering that preserves the old bug.
- **Lifecycle:** remove `manifests/<old>.json` only after its old release was successfully removed,
  and after another ownership check. Failed release deletion retains its manifest; failed manifest
  deletion is nonfatal cleanup. `sweepLeftovers` removes temp files/orphans under the same ownership
  guard. Never prune current/promoted manifests or touch #297's `build-state.json`; after observed
  lease loss admit no new filesystem mutation.
- **Reading/cache:** inspect `current` on every projection request, then read the manifest, then
  the database rows. The sole cross-request cache is one validated manifest keyed by the exact
  release stamp; a different stamp (including rollback) replaces it. Do not cache missing/invalid
  reads. If the file disappeared between link/file reads, re-read the link once; unresolved
  missing/invalid state is `unknown`. A confirmed absent `current` is `not-live`; a failed link
  inspection is `unknown`, never evidence of absence.
- These are observations at the request's read points, not an atomic snapshot of disk and DB.
  A concurrent promotion may leave the response describing the just-observed older release;
  manifest-first avoids comparing a stale database row to a later release as if it were current.
  An ABA sequence (unpublish/change, rebuild, republish identical content between reads) cannot be
  ruled out. § 11's bounded refresh corrects races; no timestamp inference or new publication lock.

### 4.2 Alternatives considered

- **B — no liveness tracking.** Rejected for the current scope. "Published" plus #297's record
  cannot satisfy #317 AC2 or its local/saved/live distinctions. This is not an interchangeable
  owner implementation option: it requires an explicit amendment to #317 scope/AC2 and #316's
  state contract before replacing A. Timing-only Media copy separately remains allowed by #318 AC5.
- **C — compare `published_at` with the release stamp.** Rejected: unsound (§ 3).
- **D — manifest in a Postgres table.** Rejected: a schema change (High, dump question), and a
  database restore would separate the record from the release files it describes. The manifest
  must live and die with its release directory.
- **E — parent process snapshots the DB before spawning the child.** Rejected: rows committed or
  unpublished between the parent's read and the loader's read make the record differ from the
  release, in both directions.
- **F — derive liveness from the release HTML.** Rejected: a page's existence does not identify the
  version, and parsing output is a second reader of the renderer's results.

## 5. Facts each state derives from

| Fact | Source | Read point | Survives restart |
|---|---|---|---|
| `status` | primary locale row's `posts.status`, per approved #283 | request, same consistent read as mode/rows | yes (DB) |
| `requestedLocales` | enabled locales whose working row is not omitted, per #283 | same mode/rows read | yes (DB) |
| `committedLocales` | enabled locales with published status and a non-null stored snapshot, per #283 | same mode/rows read | yes (DB) |
| `draftDiffers` | requested-row comparison plus requested/committed coverage difference, § 6 | same mode/rows read | yes (DB) |
| `routeChanged` (per pair) | `post_routes.updated_at >` primary row's `published_at` (one clock, § 3) | same mode/rows read | yes (DB) |
| `rowDigest` (per locale) | `PUBLISHED_SNAPSHOT_DIGEST_SQL`, null when no snapshot | request | yes (DB) |
| `live[locale]` | manifest of `current` vs `rowDigest`, § 5.1 | request, manifest first | yes (disk) |
| build running / last attempt | #297 `GET /rebuild/status` (admin) | request | recommended durable #297 record; explicit unknown if unavailable |
| Media library text | `media.alt_*`, `caption_*` | request | yes (DB) |
| Rendered gallery text | manifest `gallery[]` | request | yes (disk) |
| Local edits | browser (`guard.isDirty()`) | client | no — browser-only by nature |

### 5.1 `live[locale]` (server-computed, never sent as digests)

- `'unknown'` — `current` cannot be inspected, or exists but its manifest is missing, unreadable or invalid.
- `'not-live'` — no `current` release, or the manifest has no entry for `(translationKey, locale)`.
- `'live'` — entry exists and `entry.digest === rowDigest`.
- `'older-version-live'` — entry exists and `entry.digest !== rowDigest` (including a row whose
  snapshot is now null).

A row deleted from Postgres but still in the manifest is only visible in the admin summary
(`deletedStillLive`, § 9.3); no per-post row exists to show it on.

## 6. "Newer draft saved" — content comparison (recommended)

Per locale row:

```
draftDiffers := status = 'published' AND published_snapshot IS NOT NULL AND (
  (published_snapshot - 'track') - absent_defaults(published_snapshot, row)
    IS DISTINCT FROM ${POST_SNAPSHOT_SQL} - absent_defaults(published_snapshot, row)
)
```

- `POST_SNAPSHOT_SQL` (`db.ts:64-73`) is the exact expression `publish()` stores, so equality is
  "Publish would store the same snapshot".
- `track` is excluded from the jsonb comparison because it is a worker-transformed public form of
  the private route (`posts.ts:990-993`) and is not recomputable in SQL. Route changes are covered by
  `routeChanged` (pair-level), which is sound (§ 3) and conservative: re-attaching an identical file
  still counts as a change.
- `absent_defaults` removes, from both sides, a key the **stored snapshot lacks** while the working
  value equals what the loader assumes for absence: `title_image` NULL, `featured` false,
  `categories` `'{}'`, `tags` `'{}'`, `scheduled_at` NULL. Without it, every snapshot written before
  those keys existed would read "newer draft" until republished. A working value that differs from
  the default still counts (e.g. `featured` turned on).
- Pair-level `draftDiffers` is true only when the pair is published and at least one of:
  `requestedLocales` differs as a set from `committedLocales`; a requested locale's comparison
  above is true; or `routeChanged` is true. Disabled/omitted working rows are not pending content.
  Un-omit + Save therefore remains pending even though the secondary row is draft with no snapshot.
  Publishing that translation clears the coverage difference only after its commit; re-omitting
  a never-published requested translation clears it without changing the committed primary.
- No additional column or migration: compute in the existing list/get query, with #283's mode,
  working coverage and row status/snapshots from one consistent database read.
- `updated_at`, revisions and the concurrency token keep their current semantics (a no-op save still
  bumps `updated_at` and writes a revision; #305/#306 own the token). Only the *displayed* state
  stops treating a save as a change.

The issue permits a timestamp alternative only with the accurate label "Saved after publishing"
and an explicit owner selection of that branch of #317 AC1. Content comparison is recommended:
no-op saves and reverted edits are not pending content. Timestamp semantics are not a fallback
when comparison fails; unavailable facts remain unavailable.

## 7. Vocabulary — two axes, never merged

**Save axis (editor only, client + response):** *Not saved* (`saveNew`/`saveUnsaved`), *Saving…*,
*Draft saved* (`saveSaved`). Unchanged keys; the only change is that the editor re-derives the
publication axis from each server response instead of from the button pressed.

**Publication axis (editor, posts list, Desk):** one pure function
`publicationState(publication)`, shared by `editor.html`, `posts.html`, `posts-filter.js` and
`desk.js`. It consumes the § 10 union; first matching row wins:

Let `C` be `committedLocales`. For a published pair, it contains the primary locale and is
nonempty; a contradictory projection is unavailable, not vacuously Live. Required inclusion
and version comparisons use only `C`. Still inspect both `live.de` and `live.en` to retain
evidence of unexpectedly served locales after restore or a stale release. Unknown release
membership remains unknown rather than assuming the disabled/omitted locale is absent.

| # | Condition | State (EN / DE) | Staleness window |
|---|---|---|---|
| U | `availability = unavailable` | **Publication status unavailable** / **Veröffentlichungsstatus nicht verfügbar** | until the next successful projection read; never reuse stale Live as current |
| X | `availability = missing` | **Story no longer exists in the CMS** / **Geschichte nicht mehr im CMS vorhanden** | fresh confirmed absence; no claim about release content |
| 1 | available, `status = draft`, every locale `not-live` | **Draft** / **Entwurf** | through the observed release/row reads; refreshed per § 11 |
| 2 | available, `status = draft`, any locale `live` or `older-version-live` | **Draft in the CMS — still on the live site** / **Entwurf im CMS — noch auf der Website** | until an excluding release is promoted and refreshed |
| 3 | available, `status = draft`, no proven-live locale and any `unknown` | **Draft in the CMS — live status unknown** / **Entwurf im CMS — Live-Stand unbekannt** | until a successful projection read with known release membership |
| 4 | available, `status = published`, any `unknown` | **Published — live status unknown** / **Veröffentlicht — Live-Stand unbekannt** | until a known manifest is observed |
| 5 | available, `status = published`, any locale in `C` is `not-live` | **Published, not yet live** / **Veröffentlicht, noch nicht live** | until an including release is promoted and refreshed |
| 6 | available, `status = published`, any locale in `C` is `older-version-live`, or any locale outside `C` is proven live | **Published — live publication differs** / **Veröffentlicht — Live-Veröffentlichung weicht ab** | until a matching, correctly scoped release is promoted and refreshed |
| 7 | available, `status = published`, every locale in `C` is `live`, every locale outside `C` is `not-live`, `draftDiffers` | **Live — newer draft saved** / **Live — neuerer Entwurf gespeichert** | until the next projection read |
| 8 | available, `status = published`, every locale in `C` is `live`, every locale outside `C` is `not-live`, not `draftDiffers` | **Live** / **Live** | until the next projection read |

- This is total over valid coverage and both locales' observations, including single-language
  modes, an omitted secondary, draft unknown/unknown and unknown/not-live on legacy releases.
  A draft never receives unqualified **Live**. A missing manifest entry outside `C` is expected,
  not a missing publication; a proven-live entry outside `C` is still surfaced in row 6.
- Rows 4–6 append " · newer draft saved" / " · neuerer Entwurf gespeichert" when `draftDiffers`.
- Mixed locales name each observed locale fact (e.g. "DE still live; EN live status unknown").
  Never erase known membership because the other locale is unknown, or diagnose corruption from
  a mix: restore, missing snapshots and release/row races are possible.
- Admins alone see #297 qualifiers beside rows 2–6, **without inferring causation**: "A site build
  is running" (`running.owner = 'this_process'`); "A site build may be running elsewhere or was
  interrupted" (`owner = 'unverified'`); "Last site build failed at {time} — see Desk" for
  `last.result = failed`; "Last site build was interrupted; result unknown — see Desk" for
  `interrupted`. DE equivalents are required. Missing/unavailable history never means success.
- The qualifiers cannot override manifest facts: after a flip/crash, a story may be Live while
  the interrupted attempt's outcome remains unknown. No per-post "failed because" claim.
- Timing copy says a CMS change **may not yet be reflected** unless membership/version is
  observed. Do not say a never-live story "still shows" after failed publish then failed unpublish.
  `current` absent means no release, not a fictional previous version.
- Authors see the same per-post facts, but no attempt reason/time/Rebuild control. For rows 5–6:
  "… — requires a site rebuild" / "… — benötigt einen Neuaufbau der Website". A rebuild includes
  only what its loader reads; it cannot promise inclusion of a later concurrent action.
- Desk heading: "Newer drafts of published stories" / "Neuere Entwürfe veröffentlichter Geschichten"
  over rows 4–7 with `draftDiffers`; admins also get "Publication needs attention" /
  "Veröffentlichungsstand prüfen" for rows 2–6. U is a separate unavailable notice, never a zero count.
- Posts-list filter `unpublished` keeps its value; label "Newer draft saved" / "Neuerer Entwurf
  gespeichert"; matches available `draftDiffers` only, with unavailable entries separately indicated.
- Preview: "Draft preview — not the live site" / "Entwurfsvorschau — nicht die Live-Website"; plus
  (PR #271 merged, gate met) "Galleries show current Media descriptions" / "Galerien zeigen die
  aktuellen Medienbeschreibungen".
- `saveLiveUnchanged` becomes, for a published post: "Saved as a draft. The live story changes
  when you publish; gallery descriptions from Media change on the next site rebuild." / "Als Entwurf
  gespeichert. Die Live-Geschichte ändert sich beim Veröffentlichen; Galeriebeschreibungen aus den
  Medien ändern sich beim nächsten Neuaufbau."

All strings land in `site/src/i18n/ui.ts` for both locales (Golden Rule 7). Public pages are not
touched (Expedition Log stays as is); admin copy keeps the Editorial-desk voice.

### 7.1 Media-global vs post-local wording

- **Media-global, next rebuild:** gallery alt text and gallery captions that follow the library.
- **Post-local, only on Publish:** body text, gallery membership and order, layout, dimensions,
  `caption-override`, `#captions: hidden`, hero/title image and its alt, inline images and their
  alt, every other post field.
- **Never affected by a Media description:** hero/title images, inline images, About-page
  galleries.

## 8. Usage classification (owned here; consumed by #318)

### 8.1 Renderer function

Add to `site/src/lib/body-images.ts`:

```ts
export interface GalleryUse {
  src: string;
  alt: string;                         // effective rendered alt
  caption: string | null;              // effective caption only when it follows the library
  captionFollowsLibrary: boolean;
}
export function bodyImageUses(
  html: string, images: Record<string, ImageDims>, imageOrigin: string,
  galleryMetadata?: GalleryMetadata,
): { gallery: GalleryUse[]; inline: string[] };
```

- `gallery` uses the **same sanitized tree and guarded photo reader** as `transformBodyImages`:
  `galleryCode`, `textOf`, `readCaptionsVisible`, `readCaptionOverride`, and `galleryPhotos`' origin
  equality, image-map entry, positive integer dimensions and undefined-or-JPEG format guards.
  Refactor the reader to expose use metadata alongside its existing render result; do not parse
  Markdown again, infer base src from emitted variant `<img src>`, or reconstruct descriptions
  in the parent from a later media query. Dropped lines are not uses; repeated accepted occurrences
  remain repeated and ordered.
- Exact precedence from `body-images.ts:218-224`: `description = metadata?.get(raw) ?? images[raw]`.
  A present library row wins **including empty strings**; only a missing row uses snapshot/working
  image-map text. `alt = String(description.alt ?? '')`; line `alt=` never overrides it.
  Hidden captions render `''`; otherwise `String(readCaptionOverride(line) ?? description.caption ?? '')`.
  A present empty `caption-override=""` wins. Therefore `captionFollowsLibrary` is
  `captionsVisible && readCaptionOverride(line) === undefined`, and exposed `caption` is the
  effective string only for that branch, otherwise null. No fallback on truthiness.
- The loader supplies the **same per-locale metadata Map it rendered with**, captured by its media
  SELECT, when collecting manifest occurrences. No later read may describe that release.
- `inline` uses `bodyImageSources(html).sources` from the same sanitization rules before
  transformation (gallery lines are separate). Inline text never consults the library.

### 8.2 Classifying one row

`classifyRow(row, imageOrigin, renderMarkdown)` lives beside `rowToEntryInput` and applies the
loader's own path: `rowToEntryInput(row, origin)` (`postgres-loader.ts:53-84`, including
`retargetImageOrigins`), then `renderMarkdown(body)`, then `bodyImageUses`. For a media item with
`src = ${origin}/${key}`:

- `gallery` = count of `GalleryUse` with `use.src === src` (exact equality, the overlay's own key,
  `postgres-loader.ts:119`);
- `galleryCaptionFollowsLibrary` = the subset with `captionFollowsLibrary`;
- `heroTitle` = `heroImage.src === src || titleImage?.src === src` (fields, after retargeting);
- `inline` = count of `inline` URLs equal to `src` or `src-<width>.<avif|webp|jpeg>`.

The loader collects the gallery observations in the actual render pass to fill `manifest.gallery`;
the uploader uses `classifyRow` with `site/src/lib/render-markdown.ts` (lockstep with Astro options).
**No cross-request classification memoization initially.** Each impact request classifies its
current corpus once. `rowDigest` is a published-snapshot identity, NOT a working-copy version:
draft saves, including never-published rows with null digest, must be immediately reflected.
No `(tk, locale, source, rowDigest, origin)` cache is permitted for working copies. Any future cache
needs an explicit working-content/version fingerprint plus origin and renderer semantics, separate
from published digest keys; it is not part of this implementation. Media text/pending comparisons
are likewise read afresh, not cached by post digest or release stamp.

### 8.3 Corpus and scopes

- **published** — only rows in the authoritative committed published locale set, classified
  from the stored snapshot. The enabled-mode/status/snapshot filter matches the loader.
  Reach: next rebuild.
- **drafts** — only requested locale rows with `status = 'draft'`, classified from the working
  copy. Reach: preview now, live with successful Publish. This includes a requested secondary
  awaiting its first publication while the primary is already published.
- **newerDrafts** — only requested published rows whose working-copy per-photo classification
  differs from their snapshot's classification (including added/removed use or changed caption
  inheritance). Return working-copy counts, retaining an all-zero locale when a use was removed.
  Prose-only changes do not invent a new Media effect.
- **Excluded:** `pages` (About), and retained disabled/omitted locale rows. Existing deletion-guard
  `usedIn` retains those references; `impact` must not promise publishable description reach for
  them. Resolve mode, requested/committed sets and corpus rows in one consistent database read.

### 8.4 Wire shape

`GET /media/items/*` and `PATCH /media/items/*` gain `impact` (`requireAuth`, same audience as `usedIn`):

```ts
interface LocaleUse { gallery: number; galleryCaptionFollowsLibrary: number; heroTitle: boolean; inline: number }
interface StoryUse { translationKey: string; title: string; locales: { de: LocaleUse; en: LocaleUse } }
type MediaImpact =
  | { availability: 'available'; published: StoryUse[]; drafts: StoryUse[]; newerDrafts: StoryUse[] }
  | { availability: 'unavailable' };
interface ChangedDescriptions { de: { alt: boolean; caption: boolean }; en: { alt: boolean; caption: boolean } }
// PATCH additionally returns changedDescriptions: ChangedDescriptions.
```

`title` is DE, falling back to EN, then key, as in `usedIn`. Link titles to the existing editor
using `translationKey`; no slug/new public route needed. Exact enumerated keys only: no digests,
stamps, EXIF, GPS or user fields. Classification failure returns unavailable, not empty uses.
PATCH preserves the acknowledged saved item even when optional impact/pending enrichment fails;
no committed save becomes a 500 because this new projection failed.

`changedDescriptions` identifies **this write's actual normalized field delta**, not submitted
field presence or which locales have uses. Capture the stored preimage and normalized postimage
within the same row-locked update/transaction (memory store mirrors it), return the booleans with
the acknowledged write, and do not derive them from a later reread that may belong to another
writer. This adds no media OCC/overwrite policy, schema column or extra write. If persistence
itself has an unknown outcome, #305/#306's reconciliation boundary applies; do not fabricate flags.

- An alt change in L reaches `published`/`drafts` stories with `locales[L].gallery > 0`.
- A caption change in L reaches those with `locales[L].galleryCaptionFollowsLibrary > 0`.
- Union the relevant sets for multiple changed fields; count **distinct stories**, not occurrences.
  Apply the same field rules to `newerDrafts`, keeping its scope separate from published reach.
- The other locale is "unaffected by this save" when BOTH of its change flags are false, even
  when its truthful usage counts are nonzero. A submitted but unchanged EN caption stays false.
  If both flags everywhere are false, report "Descriptions unchanged", not invented pending work.
- If fields changed but have no following galleries, say "No gallery effect" and explain hero/title
  and inline uses. About-only is available empty impact plus non-empty existing `usedIn`.
- Counts describe the corpus read for the response, not a guarantee against later author edits.

### 8.5 Explicit #318 AC4 amendment — owner approved

Original AC4 requires the **whole non-admin response** to contain no `lat`/`lng`, camera data or
uploader fields. Existing `redactForNonAdmin` returns `exif.lat = null`, `exif.lng = null`,
`uploadedBy = null`, while retaining `exif.camera`, `lens` and `takenAt`. This is intentional
(`SECURITY.md:214-224`, `server.test.ts:491-524`), not a newly introduced leak. The issue's own
Scope says "beyond what redactForNonAdmin already allows"; these requirements conflict.

**Owner-approved explicit AC4 amendment:** "The new non-admin `impact` projection contains only its
enumerated metadata keys, with no location, camera or uploader fields; `livePending` is absent
for non-admins. Existing Media item permissions remain unchanged: GPS and uploader values are
null, while camera/lens/capture metadata stays available. Route tests assert the exact projection
keys and preserve existing whole-item redaction assertions for GET and PATCH."

The owner approved this exact scope on **2026-10-28**, selecting **Approve precise AC4 amendment**
in this implementation conversation. The original literal whole-response requirement is amended,
not claimed to be satisfied by projection-only tests. A broader Media privacy/API change was not
selected and remains outside scope. Existing whole-item redaction tests and SECURITY.md guarantees
remain load-bearing alongside the new projection-key assertions.

## 9. Media "pending since the current release" — no timestamp needed

### 9.1 Decision (recommended): no `media` column

Pending is a **content** comparison between the current library row and what the current release
rendered (manifest `gallery[]`), not a time comparison. For a manifest occurrence `o` of photo `k`
in `(tk, L)`:

```
pendingAlt(o)     := media row k exists AND row.alt_L !== o.alt
pendingCaption(o) := media row k exists AND o.caption !== null AND row.caption_L !== o.caption
```

Counted only for `(tk, L)` in that story's authoritative committed published locale set (§ 5);
unpublished or no-longer-eligible locale occurrences disappear on the next rebuild. A photo is pending when any occurrence is. This gives
#318's clearing semantics by construction:

- a promoted release clears exactly what its loader read; an edit committed after that read still
  differs, so it stays pending;
- a failure **before promotion** changes no current manifest and clears nothing;
- after promotion, pruning/lease/record failure cannot undo included changes or turn the build
  into a failure (#397 prerequisite). A flip followed by a crash still changes the manifest facts;
  #297 may independently report an interrupted/result-unknown attempt;
- a no-op save or an edit that is later reverted is not pending (a timestamp would report both).

### 9.2 Rejected: `media.meta_updated_at`

A schema change (High) plus a dump bump to v11 and restore handling. It would repeat § 3's
unsoundness (app-clock stamp vs DB-clock timestamp, commit-after-read) and over-report no-op and
reverted saves. #318 AC5 permits a separately selected **timing-only Media display** with no
measured pending count. It does not remove the manifest required for #317's liveness acceptance.

### 9.3 Admin summary

`GET /publication/summary` — `requireAdmin`, `Cache-Control: no-store`; authors get 403:

```ts
type PublicationSummary =
  | { availability: 'available'; release: 'none' | 'unknown' | 'known';
      posts: { notLive: number; olderVersionLive: number; unexpectedLocaleLive: number; unpublishedStillLive: number; deletedStillLive: number } | null;
      galleryDescriptions: { photos: number; stories: number } | null }
  | { availability: 'unavailable' };
```

Counts are null unless `release = known`; unavailable is not zero. Deduplicate photos by key and
stories by translationKey across locales/occurrences. An observed unreadable link is unknown,
not none; DB projection failure is unavailable. No stamp (owned by #297), deleted titles or digests.
Shown beside **Rebuild site now** on Desk/Settings with #297's independently observed record.
`notLive` and `olderVersionLive` compare only committed locales; `unexpectedLocaleLive` counts
published pairs with proven-live manifest entries outside their committed set. Counts are per
story, not per locale. Never count an intentionally absent secondary as `notLive`.
Admins also receive `livePending: { de: { alt: boolean; caption: boolean }; en: { alt: boolean; caption: boolean } } | null`
on GET and PATCH Media detail; null when release/pending computation is unknown or unavailable,
never false. Authors receive no `livePending` key.

## 10. Permissions

| Data | Author | Admin |
|---|---|---|
| `publication` availability and, when available, `{status, requestedLocales, committedLocales, draftDiffers, live}` | yes — no build internals | yes |
| Reason qualifiers (build running / last failure) | no | yes, from #297's record |
| Release stamp, attempt id, failure code/message | no (403 on #297's route) | via #297 only |
| `GET /publication/summary` | 403 | yes |
| `impact` on Media items | yes (titles already in `usedIn`) | yes |
| `livePending` per photo | no | yes |
| Rebuild control | none | unchanged (`POST /rebuild`) |

The post payload replaces `hasUnpublishedChanges` (clean cutover; callers `editor.html`,
`posts.html`, `posts-filter.js`, `desk.js` and their tests migrate in #317) with:

```ts
type LiveState = 'live' | 'older-version-live' | 'not-live' | 'unknown';
type PublicationLocale = 'de' | 'en';
type Publication =
  | { availability: 'available'; status: 'draft' | 'published';
      requestedLocales: PublicationLocale[]; committedLocales: PublicationLocale[];
      draftDiffers: boolean; live: { de: LiveState; en: LiveState } }
  | { availability: 'unavailable' }
  | { availability: 'missing' };
// Response property: publication: Publication
```

Locale arrays are unique, ordered DE then EN, and derived from the same mode/row read as
`status` and `draftDiffers`; neither is inferred from manifest membership. Both observed live
fields remain present even when only one locale is enabled. A published pair without a committed
primary is unavailable. The save/publish request's working locale list is not authoritative.

On `GET /posts`, `GET /posts/:tk`, and post mutation responses (save/publish/unpublish and each
bulk result), compute **after** the operation/build: manifest first, fresh rows second.
`status` is freshly observed CMS status, not the earlier action's `published: true` acknowledgement.
A concurrent unpublish can therefore produce `published: true` with `publication.status = draft`.
Deleted mutation/bulk rows use `missing` only after confirmed absence; ordinary GET still returns
404 for absent resources. Failed reads are unavailable, never missing. Digests never leave the server.

**Post-commit enrichment is optional, not part of persistence success.** Catch projection failures,
log a sanitized diagnostic and return `publication: { availability: 'unavailable' }` alongside the
successful mutation acknowledgement, its **own committed `updatedAt`**, and #297's build result.
Never replace that token with a later writer's token, drop it, or turn known success into 500.
Missing/unavailable projections contain no invented status, draftDiffers or live fields.
The editor marks only the acknowledged submitted content clean under #305/#306, keeps any edits
made in flight, and labels current publication unknown until refresh. For unavailable status,
actions requiring a known current status wait for the normal read path; do not guess `isPublished`.

Known validation/auth/conflict rejection **before commit** means no write by this operation.
A timeout, lost response, COMMIT-acknowledgement failure or arbitrary non-2xx does not prove
non-persistence. Unknown-outcome reconciliation stays with #305/#306; no automatic write replay,
new reconciliation gate, foreign token adoption or offline queue is added here.

## 11. Concurrency, coalescing and restarts

- **Two tabs / two users.** Each response carries facts at its read points. When available, replace
  `isPublished` and the badge from fresh `publication.status`, not the action button/acknowledgement.
  The action-owned concurrency token remains separate; a projection refresh does not adopt a
  foreign content version or overwrite unsaved fields. #305/#306 own reconciliation/conflicts.
- **Save during a build.** A draft save never enters the release unless subsequently published.
  `draftDiffers` detects changed saved content even when its published snapshot remains Live.
  A concurrent publish missing from the loader's read is not-live/older-version-live, not inferred
  from timestamps or the success of the initiating action.
- **Coalescing.** Inspect the release actually current. A queued build can include later commits
  or fail before promotion; neither attachment to an attempt nor its success proves membership.
- **Promotion race.** Manifest precedes flip. Link/file read races permit one link reread then
  unknown. Prune protects current/promoted files and obeys #397 ownership semantics.
- **Restart before flip.** Durable manifest/current reconstruct observed release membership.
  If the post was absent before, a committed publish is not-live; if an older version existed,
  it is older-version-live; on a legacy release it is unknown. #297's recommended durable record
  may independently show interrupted. Its guarded first-record parent mkdir covers a fresh volume.
- **Restart after flip, before completion record.** The current manifest establishes live content.
  #297 may still have `running` recovered as interrupted/result unknown. Neither source overwrites
  the other's meaning. No new build is triggered by this contract; existing bootstrap behavior stays.
- **Database restore.** Changed rows read `older-version-live`/`not-live` against releases built
  from the previous database until a rebuild: truthful, where a timestamp would claim "live".
- **Operator rollback of `current`** to an older release: its own manifest is read, so the state
  stays truthful. A pre-feature release has none and reads `unknown`.
- **Read-only (non-owner) instance:** projections only read existing state; no new write is admitted.

### 11.1 Concrete refresh and stale-response bounds

- Read on initial editor/list/Desk/Media-detail entry, on successful action completion (use the
  returned projection, then invalidate any older in-flight read), and on window focus or
  `visibilitychange` back to visible. Returning from Settings after an external rebuild refreshes.
- While visible, run a 30-second refresh timer, including when the
  previous observation was Live: another window/admin may unpublish or rebuild. One request per
  surface in flight, 10-second read deadline, no catch-up queue. Hidden pages stop the timer;
  focus/visibility triggers coalesce with an in-flight read and are throttled to one per 5 seconds.
  A healthy visible page observes a completed external rebuild within 40 seconds (timer + deadline);
  network/server failure shows unavailable/stale, never an unbounded claim of freshness.
- Editor refresh uses GET `/posts/:tk` but installs **only the projection**; it does not load the
  returned content/token into a dirty form. Lists/Desk read `/posts`; Media refreshes only the
  selected detail's impact and (admin) livePending, preserving dirty metadata fields. Desk/Settings
  admins refresh summary and #297 status under the same schedule; authors never request them.
- Media reuses the selected item's PATCH acknowledgement, conflict observation, AI preflight
  GET or the conditional protocol's one bounded recovery GET for the projection. These settle
  through the shared lifecycle without a trailing projection GET; an invalid/failed observation
  is unavailable, not permission to probe again. Only the conditional protocol can establish a
  saved outcome or offer comparison choices. Initial detail observation is a separate read;
  valid acknowledgements and unsupported old-server successes add no recovery reads. Manual,
  focus and 30-second refresh remain enabled, and a nested selection/non-item action still
  requests its required post-action observation. Shared generation fencing rejects older item
  responses as well as older background responses without adopting fields into the form.
- Use a local request generation per active resource. Invalidate it on a local action start,
  completion, navigation or detail selection change. Discard late/out-of-order responses and do
  not launch projection refresh during a local mutation; refresh once it settles. No token is
  persisted by these reads. Failed refresh marks observed data stale/unavailable and offers a
  read-only Refresh action; 401 uses existing session handling, never a write retry.
- List background refresh must preserve search/filter/selection for surviving rows rather than
  invoke a destructive full-page initialization. Deleted rows lose controls. Editor confirmed
  deletion preserves unsaved work under #305/#306 instead of navigating away or silently clearing.
- #317/#318 add DE/EN unavailable/stale/Refresh copy to the shared i18n source. This bounded
  observation contract adds no automatic build, save, autosave, event bus or background write.
- All projection-bearing GET/mutation responses use `Cache-Control: no-store`; clients request
  fresh reads. On list/Desk refresh failure, label retained display data stale and disable stale
  row/bulk mutation controls until a successful read, preserving the last acknowledged action
  message. This retains the existing failed-list-refresh safety rule without clearing dirty forms.

## 12. Trust boundaries and misuse

- The manifest is written by the build child (same trust as the release HTML) and validated by the
  parent before promotion. The reader re-validates against a strict schema and a size cap, so a
  corrupt or oversized file yields `unknown`, never a crash or "live".
- It is not served: `/data/site/manifests` is outside `current`. It holds only public content
  (slugs, rendered alt/caption) plus translation keys and digests. It is not added to backups,
  because it is regenerated by any rebuild.
- Anyone who can write `/data` can make the UI claim "live". That is host compromise, outside the
  threat model (`SECURITY.md` *Threat model*).
- Authors gain no new capability: per-post liveness is observable on the public site, and `impact`
  repeats titles `usedIn` already gives them. Site-wide counts and failure details stay admin-only.
- Model output, comments and import paths are untouched.

## 13. Compatibility and migration

- No additional DB schema or dump change; preserve approved #273/#283 format increments.
- On first deployment, an existing release lacks a manifest: both published **and draft** rows
  have unknown locale liveness (including mixed unknown/not-live observations). Use § 7's total
  table, not Draft-as-absent. A promoted manifest makes the next refresh known. No automatic build
  on upgrade: that would expose pending #271 gallery descriptions without an admin action.
- `hasUnpublishedChanges` is removed from the API in the same PR that migrates every caller (#317).
- `transformBodyImages` keeps its signature. The guard refactor in § 8.1 is behavior-preserving,
  pinned by the existing `body-images.test.ts` plus the parity test C1.

## 14. Rollback and containment

- **Copy/UI rollback** (#317/#318): revert the PRs. No data is rewritten.
- **Manifest rollback:** revert the loader, `build.ts` and the summary route. Old code never reads
  `/data/site/manifests`, so the directory is inert and may be left or deleted; no DB or dump
  migration is involved. A manifest bug cannot affect publishing, because writing it is best-effort
  and the reader degrades to `unknown`.
- **Re-upgrade after a rollback:** releases built meanwhile have no manifest and read `unknown`
  until the next build; orphaned manifests are swept.

## 15. Dependency contracts

- **#397 (owner-approved 2026-10-28):** `2026-10-27-issue-397-promoted-release-pruning.md`,
  worktree `simonswanderlust-issue-397`. Integrate its irreversible flip/log-only cleanup/lease
  rules before #297 outcome integration and this manifest implementation. Its existing approval
  is not reopened; the inspected integration baseline still has the false-failure bug.
- **#297 (owner-approved durable history, 2026-10-28):** consumed read-only — `GET /rebuild/status` (`requireAdmin`, no-store),
  `running.{attemptId, owner}`, `last.{result, finishedAt, failure.code}`, `record` and admin action
  `build`. Use #297's live observation distinction: confirmed no release is null; an omitted
  unavailable observation is unknown, never absence. A refused-before-start `build_stopped` with
  `attemptId: null` is not an attempt. This contract neither reads/writes its `build-state.json`
  nor redefines its shape, redaction or durability. Recommended source is #297's durable record,
  including guarded parent creation before the first running write. #297 never sweeps manifests.
  The manifest stamp equals its `attemptId`/`release` (`${ms}-${pid}-${seq4}`). If the owner instead
  explicitly chooses #297's unknown-after-restart option, admin attempt history becomes unknown;
  disk-backed per-post liveness and every #317 acceptance criterion still remain required.
- **PR #271 (merged, `d418c75`):** renderer overlay/precedence is authoritative (§ 8.1).
- **#305/#306:** own `loadedUpdatedAt`, outcome reconciliation and stale-tab conflicts; #305 before
  #317. #361's independently implemented unpublish token fix and #344 page OCC are inputs, not
  duplicate work or renewed gates. #345 stash-base safety applies to posts only.
- **Sequencing:** all owner choices below are recorded; integrate already-approved #397
  implementation → #297 outcome implementation; then, with #305 in place, #317's shared manifest,
  comparison/projection and renderer-classification PR. #317 UI and #318 can follow that shared
  contract independently. No-liveness/author-Draft-only variants require explicit #317 scope/AC
  amendments and cannot bypass this dependency chain.

## 16. Verification matrix (for the implementation children)

Manifest and build (uploader + site; integration with `TEST_DATABASE_URL`):

- M1 — A successful build writes `manifests/<stamp>.json` before the flip; its entries equal the
  loader's rendered rows (fixture: two published pairs and one draft).
- M2 — Pre-promotion build/flip failure retains the previous current manifest (an unpublished
  manifest file is not live). Post-flip prune failure/lease loss remains success and uses the new
  manifest; failed old-release deletion retains its manifest, and no writes follow observed loss.
- M3 — An unwritable manifest dir: the build succeeds and is promoted, the state is `unknown`, and
  the failure is logged.
- M4 — SIGKILL leftovers (temp files, manifests without a release) are swept. Pruning removes the
  manifest with its release and never the live one.
- M5 — Coalescing: a publish committed after an in-flight run's loader read is `not-live` after
  that promotion and `live` after the queued run. A failing queued run keeps it `not-live`.
- M6 — Manifest-first read ordering and concurrent promotion/ABA fixtures: report observed facts,
  never infer membership from action success/timestamps; next bounded refresh corrects races.
- M7 — Restart reconstructs states; fresh volume mkdir/start-record/crash uses #297's interrupted
  record. Crash after flip before completion recording gives manifest Live plus interrupted/unknown
  attempt, without downgrading promotion or inventing causal failure copy.
- M8 — Legacy release: published and draft unknown/unknown, draft unknown/not-live, and mixed
  proven-live/unknown use the total table; first promoted manifest transitions on refresh.
- M9 — Corrupt/oversized/stamp-mismatched/missing manifest and link inspection failure are unknown;
  confirmed absent link is not-live. Cache stamp changes on promotion/rollback; unknown not cached.

Posts (#317):

- P1 — A no-op save after publish leaves `draftDiffers` false (pg integration and memory store
  parity).
- P2 — An edit gives true; reverting the edit gives false.
- P3 — Replacing or removing the route after publish gives true.
- P4 — An old snapshot lacking `featured`/`title_image`/`categories`/`tags`/`scheduled_at` with
  default working values gives false; `featured` on gives true.
- P5 — Publish with a failing builder: both locales `not-live` and the previous release still
  served. A successful rebuild then gives `live`.
- P6 — Republish of a changed post with a failing builder gives `older-version-live`.
- P7 — Unpublish with a failing builder: `status = draft` while still live (row 2).
- P8 — Delete with a failing builder: summary `deletedStillLive = 1`.
- P9 — An author's `GET /posts` carries `publication` with exactly the § 10 keys;
  `GET /publication/summary` is 403 for authors.
- P10 — Restoring an older dump over a newer release: changed posts are not `live`.
- P11 — Two tabs plus concurrent unpublish during publish/build: the acknowledgement remains
  `published: true` with its own committed token, while fresh `publication.status` is draft.
  Never show unqualified Live for a draft or install another writer's token/content.
- P12 — Force postcommit projection DB/read failure: successful save/publish/unpublish/bulk
  acknowledgements and tokens survive with exactly `{ availability: 'unavailable' }`; no 500,
  phantom missing row, dirty-state regression or automatic replay. Confirmed deletion gives missing.
- P13 — Failed initial publish followed by failed unpublish, and no-current first-build failure:
  copy never claims a previous version or continued liveness without manifest evidence.
- P14 — Fake-clock DOM cases for editor/list/Media and Desk: rebuild in Settings/another client,
  focus/visible refresh and 30-second timer update without reload; hidden pause, read timeout,
  single-flight/throttle, late response after action, resource switch, 401 and dirty fields/token
  preservation. Unknown/stale response never restores stale Live. Both locale strings present.
- P15 — Both single-language modes and bilingual primary-only stories become Live after a
  matching rebuild; an intentionally absent secondary never recommends an inclusion rebuild.
  Restore/stale-release fixtures with a proven-live locale outside the committed set still show
  differing publication and the admin unexpected-locale count.
- P16 — Un-omit a never-published secondary and Save: primary stays published, secondary remains
  draft with no snapshot, `draftDiffers` is true, and editor/list/filter/Desk retain the pending
  translation. Publish clears the coverage difference; re-omitting before first publication also
  clears it. Pre-commit publication rejection leaves coverage pending. A committed publication
  followed by a failed build clears the coverage difference but leaves the new locale not live.
  Exercise both boundaries with both primary locales and both stores.

Classification and Media (#318):

- C1 — Renderer parity: guarded raw occurrence identities/order and effective alt/caption equal
  those used by actual rendering, not raw-vs-variant img URL equality. Cover every layout, hidden
  captions, empty/nonempty override, present blank library row, missing library row fallback,
  line alt that cannot override, foreign origin, missing/invalid dimensions and non-JPEG formats.
- C2 — One photo in two published DE+EN stories and one DE+EN draft: DE caption change reports
  2 published / 1 draft reached; EN usage stays nonzero but changedDescriptions.en is false.
  Include a PATCH carrying unchanged EN, normalized no-op, both locales/fields changed, duplicate
  occurrences counted once per story, overrides/hidden captions, and concurrent writes' own deltas.
- C3 — Hero-only: `heroTitle` true, `gallery` 0.
- C4 — About-only: `impact` empty while `usedIn` lists the page.
- C5 — A `caption-override` occurrence counts for alt, not for caption.
- C6 — `#captions: hidden` counts for alt, not for caption.
- C7 — A variant-suffixed inline link counts as `inline`; a gallery line the renderer drops is not
  a use.
- C8 — Under the owner-approved AC4 amendment (§8.5), assert exact new impact keys for both roles,
  livePending absent for authors, and unchanged whole-item GET/PATCH redaction: null GPS/uploader
  values with camera/lens/capture metadata retained. No whole-response metadata-removal claim.
- C9 — No classification cache staleness: never-published draft (null published digest) adds/removes
  gallery, published working copy changes caption inheritance/membership with unchanged snapshot
  digest; next GET/PATCH reflects drafts/newerDrafts. Prose-only edit does not fabricate Media reach.
- C10 — Impact/pending enrichment fails after acknowledged PATCH: item and changedDescriptions
  survive, impact unavailable and admin livePending null; author response still omits livePending.
- C11 — Retained omitted-secondary and disabled-locale galleries remain available to deletion
  guards but contribute no draft/working publication impact. Un-omit + Save adds requested draft
  reach without inventing committed reach; Publish adds committed reach only after commit.
- G1 — A Media alt edit after a build gives pending 1 photo / N stories; a rebuild gives 0.
- G2 — An edit committed after the loader read stays pending after that promotion.
- G3 — Pre-promotion failed rebuild clears nothing; post-flip pruning/lease/record failure does
  not keep already included changes pending or downgrade success. Flip/crash uses manifest facts.
- G4 — Edit then revert: not pending.
- G5 — Occurrences of an unpublished-but-still-live story are not counted.

Gates for each child: uploader `tsc --noEmit` and the full Vitest suite with `TEST_DATABASE_URL`;
site `astro check` and Vitest; a real-browser smoke with a forced build failure (#317) and a
Media edit → rebuild → served gallery check (#318), on disposable fixture data only.

## 17. Recorded owner decisions

On **2026-10-28**, the owner selected in this implementation conversation:

1. **Approve content comparison** — per-release manifest persistence, the two-axis DE/EN
   vocabulary, per-post liveness for authors without build internals, the trust/rollback plan,
   and content-based "newer draft" semantics (§6). Timestamp semantics were not selected.
2. **Measured pending counts** — content-based admin photo/story counts (§9), preserving
   per-locale field-granular reach, unchanged-locale accuracy and About exclusion. No Media
   timestamp/schema change; timing-only copy was not selected.
3. **Approve precise AC4 amendment** — the exact §8.5 scope preserves existing Media permissions
   and constrains the new projection. Broader whole-response removal was not selected.

Renderer parity, working-copy invalidation, fresh status versus action token, total unknown states,
postcommit failure containment, refresh bounds and promotion sequencing remain required. No-liveness
and author-only Draft/Published variants are not authorized. #297's durable history was separately
approved in the same exchange; #397 was already approved and remains an integration prerequisite.


## 18. Approval record

- Owner approval: **recorded 2026-10-28**, as quoted in §17 and §8.5. Approval includes the
  high-risk contract, security boundaries and rollback/containment plan, not implementation proof.
  The independent full-contract review was clean before approval. #297 and #397 have their own
  approval records; dependency integration and the full verification matrix remain mandatory.
- Before implementation reconfirm `SECURITY.md` Authorization (summary admin-only, per-post
  projections), Media metadata redaction (existing values and new projection key sets under the
  selected AC4 resolution), and Single app container/storage ownership (unserved manifests,
  best-effort recording, irreversible promotion). Document release layout in `ARCHITECTURE.md`.
- Rollback is § 14: revert feature code on a security-supported image, retain data and existing
  releases, never downgrade codecs prohibited by #347. No state failure initiates a rebuild,
  wipes data or rolls back a committed CMS mutation.

## Evidence

Code read on `origin/dev` `11e16d1`: `uploader/src/posts.ts` (754-758, 933-1035),
`post-pair-lock.ts` (6-19), `build.ts` (8-14, 182-280, 307-330), `server.ts` (372-379, 588-643,
738-776, 1605-1814, 1823-1849, 1932-1976), `media-files.ts` (22-99), `media-store.ts` (254-256),
`db.ts` (64-73, 121, 172-180, 241-270), `gpx-store.ts` (36-70), `backup.ts` (37, 838-893),
`comments-public.ts` (102), `site/src/lib/postgres-loader.ts`, `pages-loader.ts` (41-47),
`body-images.ts` (126-444), `site/src/i18n/ui.ts` (58, 95-102, 430, 467-474); spec
`2026-10-19-gallery-library-metadata-design.md`; issues #297, #315, #316, #317 and #318 with their
review comments. This repair additionally read #397's owner-approved specification,
`SECURITY.md:214-224`, `uploader/test/server.test.ts:491-524`, and the actual editor reload,
posts-list refresh, Desk selectors and Media detail-save consumers. #297's repair owner confirmed
the shared promotion/crash boundary, guarded first-record mkdir, optional unavailable live
observation, durable recommendation and exact Publication union. No code changed and no tests,
builds, linters, formatters or runtime checks were run in that review. Subsequent owner approval
is recorded in §18; implementation remains unverified.

## 19. Executed timing investigation (2026-10-29)

The timestamp counterexample in §3 was exercised against isolated PostgreSQL 18 using the
baseline's actual `lockPostPair` and `touchPostPair` functions, two database sessions and
synthetic locale rows. The writer assigned publication time `2026-10-29T13:30:07.581Z` but
held its transaction open. After the application clock recorded release stamp
`1793280607605`, the reader observed zero published locales. The writer then committed;
a fresh reader observed both published locales, each dated before the release stamp.

This proves that a pre-commit timestamp can falsely imply inclusion in an earlier content
read. It is a focused MVCC investigation, not an Astro build, end-to-end manifest test or
implementation qualification. Source baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`;
Node `v26.12.1`. The private execution ledger retains the helper hash, read counts,
fixture identity and exact outcome. No owner content, production database or release changed.

The approved manifest design remains required; this evidence does not replace the children’s
verification matrix. Current authorization and Media redaction boundaries are reconfirmed as
unchanged by this documentation-only issue. #317/#318 must implement and document the new
projection and unserved release-state boundaries described in §18.

## 20. #317 implementation handoff (2026-10-29)

The #317 source implementation adds the shared strict manifest/digest module, guarded
build lifecycle, actual-render gallery observations, uncached row classification,
consistent store facts, per-post projection union and admin summary. Editor/list/Desk
consumers replace the former post timestamp flag; preview labels distinguish the working
copy from the live site. `ARCHITECTURE.md` records the release layout and refresh lifecycle,
and `SECURITY.md` reconfirms authorization, redaction and ownership boundaries.

Reusable interfaces for #318 are `bodyImageUses`/`classifyRow`, `ReleaseObservation`,
`PostStore.publicationFacts`, `createPublicationProjection` and `galleryPending`. The latter
returns photo/story counts and per-key locale/field booleans from fresh Media descriptions;
it does not add Media endpoint fields or UI in #317. `classifyRow` returns retargeted
hero/title fields plus ordered gallery and inline occurrences, so an impact consumer
applies §8.2's exact per-item count rules without another parser.

Regression coverage is added for the specified boundaries, but no implementation checks
or runtime qualification were executed by the source-writing agents. The parent must run
the complete §16 gates, including PostgreSQL, real build/promotion and browser failure/
refresh protocols, before treating the implementation as qualified. No deployment,
owner-content mutation, migration or automatic build is authorized by this handoff.

## 21. #317 isolated qualification (2026-10-29)

The parent subsequently qualified the actual `uploader/src/main.ts`, PostgreSQL,
Astro builds/promotions and browser consumers at product commit
`4d31f48caefb45b6dc5392df29f0846917bc848a`. The retained execution ledger contains
138 observations, including 98 recorded API requests, served HTML, release manifests
and ten inspected desktop/320px screenshots. This supersedes the unexecuted
source-handoff status in §20, not its deployment restrictions.

Observed behavior covered all four language configurations and the publication
lattice, including no-op saves, newer drafts, omitted locales, failed publish,
unpublish and delete after commit, missing/unreadable manifests, unavailable and
partially available observations, author redaction, and DE/EN draft-preview labels.
An actual failed build left public HTTP200 HTML byte-identical; the changed committed
title appeared only after a successful rebuild. Dirty two-tab text and concurrency
bases survived refresh, and a held older response could not replace newer state.
Twenty-four simultaneous refresh triggers produced one post read and one build-status
read, with no mutations. PR #271's merged prerequisite was independently confirmed.

The complete integrated verification subsequently passed uploader types, the full
PostgreSQL-backed uploader suite, Astro checking, the site suite and a real site build
(`wave1793305473532_29724`). Later prerequisite documentation merges did not change
the publication implementation. Final-head CI and independent actual-PR review remain
separate gates recorded in the PR and execution ledger.

Fixture corrections remain disclosed: the configured image host does not serve blog
HTML, so final public-byte assertions used the separate loopback public hostname;
early wrong-host 404 probes are not qualification. A coalesced-refresh experiment
was replaced by the recorded real-mutation generation experiment. All owned processes
and tabs were closed, faulted permissions restored exactly, and fixture data retained.
No owner content, deployment, or physical accessibility audit was involved.

### Independent-review refresh and layout repairs

PR review found three lifecycle defects: BFCache restoration did not restart observation,
Posts retained stale language/token facts, and an initial language-read failure escaped the
recoverable unavailable state. Regressions failed before repair. Required posts/language
reads now settle together; accepted language facts precede rendering and mutation tokens.
Trusted persisted restoration restarts a previously running observer, but never an explicitly
stopped or unauthorized one.

Actual browser qualification verified native BFCache document restoration, held-old-response
rejection, a second-tab language change followed by real bulk Publish using the fresh token,
network/malformed-language Retry, and bounded reads with zero automatic writes. Visual checks
then exposed a long status badge crossing desktop cells and a zero-width Languages column
clipping its chip on phones. Wrapping the badge and reserving the language column corrected
both; no text or unavailable state was hidden.

At `f5f7bbb`, settled1400/768/390/320px screenshots and geometry showed complete, contained
labels/chips without overlap or inner horizontal overflow. The320px workspace measured304px
client and304px scroll width. Native keyboard Enter recovered genuine data from unavailable
state with zero writes. Expiring only the synthetic server session produced actual401s and
login navigation; native Back restored the same document with trusted persisted events.
It stayed visible for31.546seconds with zero requests or writes. Fresh fixture data is retained;
owned sessions, apps, tabs and fault injection were cleaned up. This is not physical or
screen-reader qualification.

## 22. #318 implementation handoff (2026-10-29)

The Media detail GET/PATCH source adds the exact §8 impact union and admin-only nullable
`livePending`, reusing `classifyRow`, `galleryPending` and the existing admin summary.
`PostStore.mediaImpactCorpus()` captures language mode, authoritative coverage and working/
published rows in a single consistent read (PostgreSQL REPEATABLE READ; memory exclusive
language read). It is story-only and has no cross-request working-content cache.
`ConditionalMediaResult` extends the acknowledged Media item with `changedDescriptions`;
the conditional write captures the normalized preimage under `FOR UPDATE` and returns its
own postimage/delta from the same transaction. Internal unconditional patches are unchanged.

The detail panel consumes the actual shared `PublicationRefresh` lifecycle, installs only
observations, preserves conditional expectations/dirty fields, and retains this session's
acknowledged write delta separately. DE/EN copy explains scope, occurrence versus distinct-story
counts, caption inheritance, unchanged locales, removed newer-draft uses and no-gallery effects.
Only existing authorized `usedIn` titles become editor links. Summary rendering remains the
#317 implementation beside Rebuild, with #297 build status independent.

The precise owner-approved §8.5 amendment is implemented as specified, not as a claim that
the original literal whole-response AC4 is satisfied. Exact GET/PATCH projection-key assertions
sit beside whole-item camera/lens/capture preservation and null GPS/uploader assertions.
Regression source also covers fresh draft classification, conditional deltas/races/unknown
commit outcomes, pending content changes/reverts/captured-release behavior, optional enrichment
failure, dirty detail refresh, stale responses, and author-only request/control boundaries.

**Verification status:** no checks, builds, installs or runtime exercises were run by the
#318 implementation worker. These are source/test additions, not passing-test or rendered-page
evidence. Parent qualification must run the full PostgreSQL-enabled suites, Astro checks/build,
real browser and served-gallery protocol, actual-PR review and final-head CI before delivery.
No schema/dump change, rendering-policy change, deployment or owner-data mutation is authorized.

## 23. #318 isolated qualification (2026-10-29)

The parent exercised actual main/PostgreSQL/Astro/Chromium at product `73bb0f0`;
the retained runtime evidence contains 71 observations, including 43 recorded API
results, served HTML and real release manifests. These are bounded evidence counts,
not total-run request counts. Complete uploader/PostgreSQL/site checking and a real
build passed at that product (`wave1793301326468_22276`); integrated final-head checks,
CI and independent PR review are recorded separately in the execution ledger.

A DE caption change measured two distinct published gallery stories and one draft,
without counting repeated occurrences twice or changing EN. Hero, inline and About
descriptions remained local and their served HTML byte-identical. A real successful
build included the DE caption and cleared pending counts; an edit made while the
actual Astro child was paused after snapshot capture remained pending after that
build. A genuine release-write failure preserved the current release and pending
counts, and keyboard-operated recovery cleared only included changes.

The amended AC4 was exercised against exact author GET/PATCH shapes: the impact
projection exposes only approved fields, `livePending` is absent, GPS/uploader
values are null, and existing camera/lens/capture metadata remains visible.
Admin summary/build status refused authors. Dirty detail input and conditional
expectations survived refresh and delayed older responses. Twenty-four refreshes
coalesced to one item read; an ordinary Save performed one PATCH and no item-read
echo. A real cancelled usage query after a committed PATCH returned acknowledged
saved details with unavailable optional impact, rather than pretending the save failed.

Desktop and 320px captures, keyboard focus and recovery were inspected. Single/bulk
AI inference was not exercised in this supplement: no worker-owned provider was
available, and an owner's model was not contacted. #306's separately recorded AI
interruption evidence is not relabeled as #318 inference coverage.

The workstation's Node installation was externally replaced during this run:
the old process's deleted executable path caused a genuine `build_unavailable`.
Restarting only the owned app under Node26.13.0 (unchanged ABI147/NAPI10) restored
actual publish/rebuild; no fallback or product change was introduced. Earlier
unsuccessful fixture probes and this interruption remain disclosed. All owned
processes/tabs stopped, paused child resumed, query lock rolled back and exact
filesystem permissions restored; synthetic fixtures remain retained. No owner-data,
deployment or physical accessibility qualification is claimed.

### Independent-review reauthentication and focus repairs

Independent PR review found that an initialized Media page did not restart its stopped
detail observer after same-owner reauthentication, and that replacing the impact subtree
discarded keyboard focus. Both consumer regressions failed before repair. Reactivation
now restarts read-only observation without adopting dirty fields; repaint restores the
equivalent focused control, falls back to Refresh when its link disappears, and never
takes focus from outside the impact section.

Actual qualification at `552f76e` expired only a fresh synthetic session, observed the real
item401, then signed in and resumed. Resume made one auth, list, folders and selected-item
read with zero mutations; both dirty input nodes/text survived. The next explicit Save
made exactly one PATCH200 with original conditional expectations and no item-read echo.
Native Enter retained Refresh focus, bounds and scroll at desktop and320px. Automatic
observation retained a focused story link, fell back after a real usage-removal PUT, and
left an outside input focused. Native visible focus outlines were inspected.

The managed headless browser did not emit native window-focus events on foreground
switching; that listener was exercised with an explicitly disclosed synthetic focus event
and genuine reads, not represented as native window-focus proof. Apps, tabs, sessions and
interception were cleaned up; private evidence records harness limitations.

### Integrated pending-recovery qualification

Actual `cb517fe` qualification combined the inherited Media recovery controls with the
impact observer in the real main process. Two native tabs and a genuinely published
referencing story produced409, then a committed200 held at the response boundary. An
older genuine Check stored response released after acknowledgement did not reopen the
comparison, replace Mine, or alter the acknowledged description effects and story impact.
The next EN-caption Save sent one PATCH containing only that leaf and its empty expectation.
Holding its real acknowledgement for32.004seconds produced zero observer requests or
automatic writes and retained identical dirty input nodes.

After acknowledgement, native Refresh Enter made one item GET at each desktop/320px width
with zero writes, preserving visible focus, bounds and scroll. HTTP and independent
`title`/`caption_de`/`caption_en` SQL reads agreed. The evidence distinguishes an expired
preliminary old-GET hold from the successful ordering run and the separate32-second pause
proof. Sessions, tabs, cookies, app and interception were closed; synthetic fixtures remain.
