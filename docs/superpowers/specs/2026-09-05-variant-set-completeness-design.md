# Variant-Set Completeness and Atomic Variant Writes — Design

**Date:** 2026-09-05
**Status:** Proposed (implementation on `feature/118-variant-set-completeness`, stacked on #162)
**Risk:** **High** — touches `storage.ts` (the write chokepoint every image path goes through),
`media-sync.ts` (which writes `status`, the invariant the publish gate relies on) and the WXR
resume path's assumptions. No schema change, no new endpoint, no new dependency.
**Closes:** #118.

## Why this exists

Three independent readers all answered "is this photo complete?" with a weaker test than the
contract they serve:

- `walkStorageKeys` set `hasVariants` on the **first** matching file; the backfill inserted
  `ready` on that basis. A crash after `-640.avif` alone became a `ready` row whose `<picture>`
  requests `-1280.webp` / `-1920.avif` — 404s on the live blog, and the publish gate let it through.
- The prune marked `missing` only when **no** file existed, so a partial restore of
  `/data/images` that lost some variants left a `ready` row `ready` forever because the `-orig`
  still counted as "present".
- `probeDims` on the largest *surviving* webp recorded a too-small width, so `thumbSrc` and the
  site's `srcset` disagreed with the files.
- `storeVariantFiles` wrote each variant with a plain `writeFile`, so a SIGKILL / ENOSPC during the
  **last** write left a non-empty truncated file carrying the final name. The WXR resume check
  (`createRehostResume`) fails closed on missing and zero-length files but cannot tell a truncated
  one apart — the one gap #85 left open.

The variant contract is `variantWidths(intrinsicWidth) × FORMATS` (`variants.ts`, mirrored in
`site/src/lib/images.ts`): every standard width below the intrinsic width, plus the intrinsic
width itself, in both formats.

## Decision

### 1. Atomic per-file writes (`storage.ts`)

`storeOriginal` and `storeVariantFiles` write to a sibling temp name
`<final>.part-<8 hex>` in the same directory and `rename` it into place. Rename is atomic on
POSIX, so a file carrying a final variant/original name is always complete. The temp suffix
matches neither `VARIANT_FILE_RE` nor `ORIGINAL_FILE_RE`, so a leftover from a crash is invisible
to `listMedia`, `walkStorageKeys`, `deleteMedia` and the resume lookup. On a failed write the temp
file is unlinked best-effort before the error propagates.

This closes the resume gap without touching `wp-images.ts`: a truncated file can no longer carry
the final name, so "present and non-empty" is once again a sound test there.

### 2. Completeness derived from the intrinsic width (`media-sync.ts`)

`walkStorageKeys` now records, per key, the set of variant `(width, format)` pairs on disk, the
original's relative path (if any) and `origBytes`. A new pure helper
`isCompleteSet(variants, intrinsicWidth)` checks `variantWidths(intrinsicWidth) × FORMATS ⊆ set`.

**Intrinsic width comes from the retained original when one exists** — probed with sharp using
the orientation-corrected size, exactly as `createRehostResume` does and for the same reason:
variants are written in ascending width, so a crash truncates the **top** widths, and a
top-truncated set is indistinguishable from a complete set for a smaller photo. Only when no
original exists (legacy WP-era files) does the largest surviving variant define the expected set —
there is no ground truth to compare against, and the recorded width is then at least
self-consistent with the files that exist.

**Backfill (no row yet):**

| on disk | status inserted |
|---|---|
| complete set | `ready`, dims from the original (or the largest variant) |
| original, incomplete or no variants | `processing` — re-encoding is idempotent and `createReconciler` (#117) queues it in the same pass |
| variants only, incomplete | `missing` — nothing can heal it; the library shows "file missing" and the publish gate blocks it |

Probing the original for dims also fixes the width/height `0` that #117 left on a backfilled
crashed upload (the encode path never writes dims).

**Prune (existing `ready` rows):** a row whose set is incomplete is demoted the same way —
`processing` when the original exists (re-encode heals it on this pass), `missing` otherwise —
and counted in a new `demoted` report field. Rows that are not `ready` are still skipped: an
upload in flight has a row and a growing file set, and a concurrent pass must not touch it.

Cost: for the prune, a ready row is checked first against its **own recorded width** — if
`variantWidths(row.width) × FORMATS` is on disk, consumers' `srcset` cannot 404 and no probe is
needed. Only rows failing that (or with `width = 0`) probe the original. The common case is
one `readdir` and no image reads, as today.

## Trust boundaries and misuse

- No new input surface. Both write helpers still run `assertSafeKey` first; the temp name is
  derived from the already-validated final path plus `randomBytes` hex, so it cannot escape the
  directory. `deleteMedia` and the walk ignore `.part-*` files by construction of their regexes.
- Demotion never deletes anything and only ever moves `ready` → `processing`/`missing`. Both are
  states the UI, the publish gate and `POST /media/retry` already handle; the worst case of a false
  demotion is one redundant, idempotent re-encode.
- A `missing` row from a variants-only incomplete set can be retried; the encode then fails
  honestly with `decode_failed` ("no retained original") rather than pretending.
- Leftover `.part-*` files from a crash are bounded (one per interrupted write, ≤ 8 per key) and
  inert. They are not swept automatically — a deletion path inside the sync is more risk than the
  disk they cost; re-encoding the key overwrites the final names and the temp can be removed by
  hand. Recorded as accepted residual.

## Invariants (all tested)

1. A file carrying a final variant/original name is complete: a write that throws mid-way leaves
   no file under the final name (`storage.test.ts`).
2. A key with an original and a partial set is inserted `processing`, never `ready`
   (`media-sync.test.ts`); a variants-only partial set is `missing`.
3. A `ready` row whose set lost files is demoted on the next pass; a complete set is left alone;
   a `processing` row is never touched (`media-sync.test.ts`).
4. Backfilled dims come from the original when present (width no longer `0`).
5. The expected set for a key with an original is derived from the original, not the largest
   surviving variant (top-truncated set ⇒ `processing`).

## Rollback

Revert the commit; stateless. Rows demoted by this code are `processing`/`missing`, both of which
the previous code treats as ordinary (recover re-encodes `processing`; `missing` is retryable), so
rolling back leaves nothing stranded. Leftover `.part-*` files are ignored by old and new code alike.
