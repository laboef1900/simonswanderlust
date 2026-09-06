# Media Rescan Runs the Full Reconcile Pass — Design

**Date:** 2026-09-05
**Status:** Proposed (implementation on `feature/117-rescan-reconcile`)
**Risk:** **High** by CLAUDE.md's table — touches the encode queue and media-sync, whose `status`
invariant spans a Postgres row, files on disk, and the publish gate.
**Repos touched:** `uploader/` only. No schema change, no new endpoint, no new dependency.
**Closes:** #117.

## Why this exists

`POST /media/rescan` called only `mediaSync.run()`. The sync inserts an originals-only key (an
upload that crashed after `storeOriginal` and before `upsert`, or a database restored from a dump
that predates the upload) as `status = 'processing'` — but only `encodeQueue.recover()` re-seeds
the queue from `processing` rows, and it was called from exactly one place: the boot chain in
`main.ts`. `POST /media/retry` skips `processing` rows and the UI offers Retry only for `failed`.
So an admin's Rescan discovered the crashed upload, wrote a row nothing would ever encode, and the
publish gate then blocked every post referencing it until the next container restart. The comment
in `encode-queue.ts` claiming `/media/retry` triggers recovery was wrong.

## Decision

One entry point, `createReconciler({ sync, queue })` in `uploader/src/media-sync.ts`, runs
`sync.run()` **then** `queue.recover()` and returns `ReconcileReport = SyncReport & { recovered }`.
Both boot (`main.ts`) and `POST /media/rescan` (`server.ts`, cfg key `reconciler`) call it; nothing
else calls `recover()`. The route's response and the media browser's status line now include the
`recovered` count, so an admin sees that the pass re-queued what it found.

If the sync throws, recovery still runs and the sync error is re-thrown afterwards: the `processing`
rows a crash left behind predate this pass and heal independently of it. This preserves the boot
behaviour that existed before (sync failure logged, recovery still attempted) and lets the route
return the same 500 it did before.

## Trust boundaries and misuse

- The route stays `requireAdmin`; the reconciler adds no input surface — it takes no request data.
- Amplification: `recover()` is bounded by `MAX_BACKLOG` (200) per pass, exactly as at boot. A
  repeated Rescan cannot enqueue beyond the backlog cap; `enqueue`/`recover` are idempotent on keys
  already pending or in flight.
- Concurrency: two overlapping passes (boot + an early Rescan, or two admins) both call
  `recover()`; the queue de-duplicates by key, and re-encoding overwrites deterministic filenames,
  so the worst case is one redundant encode.

## Invariants

1. A key on disk with an original and no variants, absent from the database, is in the encode
   queue after one reconcile pass (`media-sync.test.ts` › `createReconciler`).
2. `recover()` runs after the sync, never in parallel with it, and runs even when the sync fails.
3. The rescan route returns the sync counters plus `recovered`.

## Rollback

Revert the single commit. The change is stateless: no schema, no files, no settings. A deployment
running the old code simply reverts to "Rescan strands `processing` rows until restart".
