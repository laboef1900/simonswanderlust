# Image archive publication boundary (#335)

**Date:** 2026-10-25  
**Risk:** High — image backup/recovery boundary.  
**Status:** Revised filesystem-barrier mechanism explicitly owner-approved on 2026-10-25: “Approve revised #335 spec” ([approved revision](https://github.com/laboef1900/simonswanderlust/issues/335#issuecomment-6401790348)). The earlier exact-wall-clock ctime mechanism was approved ([earlier scope](https://github.com/laboef1900/simonswanderlust/issues/335#issuecomment-6401591424)), then rejected by prerequisite evidence before any implementation. The proposed fixed one-second overlap was withdrawn: there is no demonstrated hard bound.
**Scope:** Finding 4 of #331 only. No database schema, routes, storage image names, tar format, retention, or public image behavior change.

## Failure and acceptance

A writer finishes `<final>.part-<8 hex>` before a backup walk; tar successfully captures that temporary name; the writer renames it afterwards. Rename preserves write mtime. The next mtime-only incremental omits the final name despite the successful backup/cutoff advance. Normal oldest-first extraction does not produce a discoverable original. The reproduction retains bytes under a temporary name; it does not establish irreversible byte loss.

A writer crossing the archive boundary must eventually be captured under its complete final name, or the archive must fail without advancing the cutoff. Temp exclusion alone is insufficient.

## Rejected wall-clock comparison: prerequisite evidence

Real Node 26.12.1 rename probes on macOS and an isolated Linux `node:26-alpine` container show ctime advances while mtime is preserved. However, Linux reported rename ctime **1.217 ms before** userspace `Date.now()` sampled immediately before rename. Exact millisecond comparison is unsafe; an empirical one-second margin would not establish correctness.

The replacement probe takes its cutoff from a newly created file on the **same images filesystem**, floors it to milliseconds, and then renames the old-mtime original. Across 250 iterations per platform, every final ctime was at or after that filesystem-derived cutoff. Linux had 22 renames behind the userspace clock, all covered by the filesystem cutoff. Evidence is retained locally under `.superpowers/331-evidence/{macos,linux}-{rename,barrier}.json`. These probes establish the targeted filesystem behavior, not universal portability.

## Concrete mechanism

### 1. Capture the boundary in the filesystem clock domain

At the start of `archiveImages`, before enumerating sources, create an empty private marker directly inside the configured images directory with an exclusive random name such as `.archive-boundary-<pid>-<hex>.tmp` and mode `0600`. Use `openSync('wx')`, `fstatSync(fd).ctimeMs`, `closeSync`, and `unlinkSync` synchronously, in `try/finally`, retaining `Math.floor(ctimeMs)` as the boundary. No await permits another application task between those operations. The marker contains no data and is removed before enumeration; a process crash can leave only an empty marker, explicitly excluded from archive selection and media discovery. Do not sweep unrelated images or delete old markers implicitly.

The source filesystem, not the backup destination filesystem or JavaScript wall clock, supplies the cutoff. With nondecreasing filesystem time, a later rename's ctime cannot precede a marker created earlier on that same filesystem, even if both timestamps occupy one coarse clock tick. Flooring and inclusive comparison preserve equal-tick events. No guessed delay or safety margin is needed.

A missing source directory keeps the existing empty-source behavior but produces **no boundary** and must not advance the saved cutoff. All other marker creation/stat/close/removal errors fail the image archive and preserve the previous cutoff. A read-only source can no longer support an advancing incremental cutoff; it reports failure instead of silently weakening this protocol.

### 2. Capture complete names using write or publication time

Exclude both storage's exact `.part-<8 hex>` suffix and the exact private boundary-marker filename pattern. Do not reinterpret temporary files as completed originals or pass directory names to recursive tar inclusion.

Select regular final files if **`mtimeMs >= sinceMs || ctimeMs >= sinceMs`**. Rename publication advances ctime on supported local Linux/macOS filesystems, even when mtime predates the boundary. Keep storage's atomic writes unchanged; no post-rename `utimes` crash gap and no archive-duration upload/encode lock.

`archiveImages` returns an explicit result `{ name: string | null, boundary: string | null }`: name identifies an actual published tar or is null for no selected files; boundary is the filesystem-derived ISO timestamp (millisecond floor), or null only for an absent source directory. The existing optional date argument remains a filename label for deterministic naming/tests only, never a trusted cutoff. Migrate all callers/tests to the result; no compatibility alias.

### 3. Persist only a demonstrated boundary; distrust historical/name-derived cutoffs

Retain `lastImagesArchiveAt` as the cutoff field, but add validated state provenance `imagesCutoffSource: 'filesystem-v1'`. Only after `archiveImages` succeeds with a non-null boundary does `runNow()` persist both together. A failure preserves the previous pair. Successful no-change walks may advance the filesystem boundary without writing a new tar, as before.

An incremental start is allowed only when state has both a valid timestamp and the exact provenance tag **and an image chain still exists**. Otherwise start from zero and make a fresh full image archive, preserving every prior archive. Thus upgrade from legacy wall-clock state, absent/corrupt state, invalid provenance, or a hand-emptied archive directory cannot silently reuse an unproven boundary.

Remove the now-obsolete `archiveChainCutoff` filename-derived recovery and its dead helper/tests. Collision-bumped names remain solely unique filenames; a bumped filename is never recovery evidence. This deliberately replaces #113's missing-state incremental optimization with conservative full capture because legacy filename timestamps are from a different clock domain. No second-boundary argument or collision chain can recover the missing filesystem timestamp reliably. The cost is one full archive on upgrade or state loss, subject to the existing free-space reserve; this cost is explicit, not a hidden fallback that reports success without coverage.

### 4. Fail incomplete tar reads honestly

Enable strict tar handling. Real disappearance of a selected final between selection and tar opening must reject, remove unfinished archive output, and leave cutoff/provenance unchanged. Preserve existing free-space reserve, cancellation/ownership checks, temporary-output cleanup, final tar publication, same-second name no-clobber behavior, and admin-only access.

## Interleavings and invariants

- Temp exists before the boundary and survives through tar: no temporary entry is archived. A subsequent rename has ctime at or after the filesystem boundary and qualifies next time.
- Rename after source enumeration but before tar: this tar may omit it; next time the final qualifies by ctime, including equal-tick publication.
- Final exists before enumeration: selection by write/publication time captures it in this or an earlier successful archive.
- Selected final disappears before tar: failure, no published tar for that attempt, no cutoff advance; a later restored final is captured on retry.
- Absent source directory: no boundary is manufactured and no cutoff advances over an unavailable library.
- Missing/corrupt/legacy state: full capture, never a cutoff inferred from wall-clock or bumped filenames.
- State-write failure after successful tar: old safe boundary or full retry; duplicates are benign.
- Individual final images remain complete by atomic writes. No claim of transactionally consistent whole-library snapshots or recovery of bytes already absent from live storage.

## Trust boundaries and misuse

No new HTTP surface: backup routes remain admin-only. Originals/backups remain private DR assets, including EXIF/GPS. Storage key/extension guards, public-original exclusion, cancellation and storage-owner lease checks are unchanged. The marker is empty, private, randomly named, exclusive-created and removed only by its creating call. Marker stat/cleanup failures are errors, not permission fallbacks.

Supported deployment assumption: local Linux filesystem (container image volume) or macOS development filesystem, with source files and marker on the same filesystem and nondecreasing filesystem time. Clock rollback, arbitrary network/coarse filesystems that do not update ctime on rename, nested foreign mounts, privileged timestamp manipulation, and deletion of some existing chain members are outside the guarantee. This is not a POSIX-wide ctime assertion. Metadata changes can cause benign repeat entries.

## Failure, recovery, rollout and rollback

All marker/read/tar/space/cancellation failures retain the prior cutoff and report an image-archive error. A database dump can succeed while the image archive fails; do not call that a complete image recovery set. Retrying after restoring source access/free space covers the gap.

First upgraded run with legacy state deliberately takes a full archive of all surviving completed images, subject to reserve capacity. Keep all previous archives. This covers surviving final names omitted by old chains but cannot reconstruct missing bytes. If the full run cannot fit, report failure and preserve the old chain; provision backup space rather than deleting history automatically.

Rollback is a code revert with archives preserved. Old code ignores the provenance tag but returns to the known boundary race; quiesce writers during image backups or stop relying on old incremental backups until the fix returns. Re-upgrade must invalidate legacy-written cutoff provenance: old `readState` drops the new tag whenever it writes state, forcing the next upgraded run to full capture. Do not claim code rollback repairs old gaps.

## Verification and delivery

Deterministic tests use real filesystem/tar operations and controlled barriers at existing module seams, not production-only hooks:

1. Temp remains throughout first successful tar; rename afterwards; later increment contains final name only.
2. Rename between selection and tar open; later increment captures final, including ctime equal to boundary and the measured userspace-clock lag case.
3. Real selected-file disappearance at archive and `runNow` levels; strict failure, no output temp, no cutoff/provenance advance; retry captures returned final.
4. Marker failure/cleanup, absent source, no-change, both mtime-only/ctime-only selection, disk-space and cancellation cases.
5. Legacy/missing/corrupt/invalid-provenance state and collision-bumped filenames cannot skip an old final: real full recovery instead. Intact provenance permits incremental selection. Lost state after tar success produces safe duplicates.
6. Extract real tars oldest-first into an empty disposable path. Run application media discovery/sync and actual encode queue against restored originals; verify ready media, full expected variant set, and sharp decoding. No manual temp-to-final repair or mocked encoding.
7. Full uploader tests/integration against the isolated Postgres 18 test database and uploader type checking after a coherent batch. Independent Linux Node 26 synthetic archive/restore/re-encode smoke, plus macOS evidence. No owner content/database/service changes.

Update `SECURITY.md` and `ARCHITECTURE.md`, including the explicit fresh-full-archive upgrade/state-loss cost and filesystem assumptions. This spec supersedes #113's filename-derived cutoff recovery, not its other safeguards. Commit/push a focused PR to `dev`; no merge or deployment.

## Implemented verification evidence (2026-10-25)

- Uploader type checking passed; full isolated Postgres 18 integration/unit run passed **99 files / 2285 tests**. Focused archive suites passed **49 tests**.
- Site regression suite passed **364 tests**; `astro check` against the isolated application schema reported **0 errors, warnings, or hints** across 99 files.
- Real macOS/Postgres recovery: first tar held only the seed while the old-mtime temp remained; the next tar captured the published final original. Oldest-first extraction preserved its bytes. Actual media reconciliation recovered two rows and the encode queue produced `ready` media with decodable 64×48 AVIF/WebP variants.
- Independent Linux Node 26.12.1 container recovery exercised real tar/extraction/discovery/encoding with the application memory metadata store, also producing ready/decodable variants and identical original bytes. Linux/Postgres integration is not claimed; the Postgres integration proof ran on macOS against the isolated Postgres 18 container.
- Deterministic regressions cover the actual `storeOriginal` pre-rename pause, publication after selection, userspace-clock skew, inclusive ctime, source disappearance before tar, unchanged cutoff/provenance on failure, marker failure/cleanup, read-only/missing source, cancellation, and full capture for missing/corrupt/legacy/invalid provenance despite future collision-bumped filenames.

Raw local proof and exact commands are indexed in ignored `.superpowers/331-evidence/index.md`. No owner content or deployment was used; no irreversible byte-loss claim is made.
