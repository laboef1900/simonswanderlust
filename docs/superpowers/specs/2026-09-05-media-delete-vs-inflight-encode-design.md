# Media Delete vs. an In-Flight Encode — Design

**Date:** 2026-09-05
**Status:** Proposed (implementation on `feature/116-delete-vs-inflight-encode`, stacked on #158)
**Risk:** **High** — irreversible media delete path plus the encode queue's `status` invariant
(a Postgres row, files on disk, and the publish gate with no shared transaction).
**Repos touched:** `uploader/` only. No schema change, no new endpoint, no new dependency.
**Closes:** #116.

## Why this exists

`DELETE /media/items/*` checked content usage but never `status` or the encode queue. A running
job holds the original in memory (`readOriginal` → `processImage`, ~19 s → `storeVariantFiles`),
`storeVariantFiles` `mkdir -p`s per file and so recreates the just-deleted directory, and
`setVariantBytes`/`setStatus` are bare `UPDATE`s that silently affect 0 rows. `media-sync` then
backfills any key with ≥ 1 variant as `ready`. Net effect: an admin deletes a "processing" photo
(200, row and original gone); ~15 s later eight variants appear under the deleted key; the next
boot or rescan inserts it back as a `ready` row with harvested alt, no uploader, no EXIF, and no
retained original. The delete undid itself.

## Decision

Two layers, both required:

1. **Refuse at the boundary.** After the usage check, the route reads the row and returns 409
   when `status === 'processing'` **or** `encodeQueue.isActive(key)` (queued or in flight). Both
   signals are needed: the row says `processing` from upload until the encoder's final write,
   while the queue knows about a key whose row a concurrent status write no longer describes.
   `EncodeQueue` gains `isActive(key)`. The library's detail panel disables **Delete photo** for a
   `processing` item with a visible, `aria-describedby`-linked note, so the refusal is stated
   before the confirm dialog rather than after it.
2. **Discard, don't resurrect.** `runJob` re-reads the row after the encode. If it is gone (a
   delete that slipped past the gate, or a rescan-inserted row removed out of band), it unlinks
   whatever the encode wrote via `deleteMedia` and logs `encode discarded for <key>: row deleted
   mid-encode` instead of writing `ready` into a non-existent row.

Delete semantics otherwise unchanged: `ready`, `failed` and `missing` rows delete as before, and a
key with files but no row still deletes the files (legacy content).

## Trust boundaries and misuse

- No new input: the key still passes `assertSafeKey`; `deleteMedia` re-asserts it; the route stays
  `requireAdmin`.
- The gate cannot be used to pin a photo forever: an encode ends in `ready` or `failed` within the
  job's lifetime, and `recover()`/`retry` paths re-queue rather than leave `processing` orphaned
  (#117 made the rescan pass do the same).
- Race between the gate's read and the encoder's final write: harmless in either order — if the
  encoder finishes first the row is `ready` and the delete proceeds normally; if the delete wins
  the row is still `processing` and is refused.
- Layer 2 unlinks only files matching the exact key (`deleteMedia`'s suffix-exact match); sibling
  keys sharing a prefix are untouched.

## Invariants

1. A `processing` or queued/in-flight key cannot be deleted through the API
   (`server.test.ts`: upload → DELETE 409 → settle → DELETE 200; queue-signal-only 409).
2. An encode whose row vanished writes no status and leaves no files
   (`encode-queue.test.ts` › discards an encode whose row was deleted mid-flight).
3. `isActive` is true from enqueue until the job's `finally` (`encode-queue.test.ts`).

## Rollback

Revert the commit; stateless. Orphaned variants created under the old behaviour, if any, are
already visible as zombie rows after a rescan and can be deleted normally.
