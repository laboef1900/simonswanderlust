# Images archive safety: no leaked temp files, a free-space precondition, disk-derived cutoff recovery

**Issue:** #113 · **Risk:** high (backup/restore + `/data` layout) · **Module:** `uploader/src/backup.ts`

## Problem

The incremental images archive (`archiveImages`) tars every file under `/data/images` whose
mtime is at or after a cutoff into `/data/backup/db/images-<stamp>.tar`. It writes to
`images-<stamp>.tar.<pid>.tmp` and renames on success. Four things go wrong around that seam:

1. **Leaked temp on failure.** Nothing removes the `.tmp` when `createTar` rejects (ENOSPC,
   EACCES, a source file deleted mid-tar) or when the process exits mid-write. The temp name
   matches neither `BACKUP_FILE_RE` nor `IMAGES_ARCHIVE_RE`, so `pruneBackups` and the admin UI
   never see it. Each scheduled attempt can leak another multi-GB file until `/data` is full —
   at which point `/upload` 507s and `astro build` cannot write a release: the backup feature
   takes the site down.
2. **No free-space precondition.** `/upload` refuses with 507 when `/data` is tight
   (`disk.ts`); the archive — the single largest writer on the volume (~11 GB for the current
   corpus) — does not check at all.
3. **Corrupt `state.json` forces a full re-archive.** `readState` returns `{}` on any parse
   error, so `lastImagesArchiveAt` is lost and the next run uses cutoff `0`: the whole corpus
   is tarred again. Worse, a *present but unparsable* timestamp yields `NaN`, and
   `mtimeMs >= NaN` is always false — nothing is archived, the cutoff advances anyway, and
   every file modified in that window is silently dropped from the chain for good.
4. **Concurrent `POST /backups` looks like a no-op.** `runNow()` returns the stale pre-run
   state while a run is in flight; a double-click on *Back up now* reports the previous result.

Low priority, same module: the hourly tick plus `lastSuccessAt >= 24 h` makes the effective
daily period 25 h, so the run walks around the clock.

## Trust boundaries

- Only admins reach `POST /backups` / `GET /backups` (`requireAdmin`). Nothing here widens who
  can trigger, list, or download a backup.
- The archive reads `/data/images` and writes `/data/backup/db`; both are inside the `/data`
  bind mount. Filenames stay matched by the two strict regexes; the temp-file sweep uses a
  third, equally strict pattern (`<dump-or-archive-name>.<digits>.tmp` and
  `state.json.<digits>.tmp`) and deletes only inside the backup directory.
- Free-space numbers are logged server-side and stored in `state.lastError`, which is shown to
  admins only (`GET /backups`).

## Design

### 1. Temp files never outlive a failed run

`archiveImages` registers a synchronous `process.on('exit')` listener that unlinks the temp
while the tar is streaming, removes the temp in a `catch` before rethrowing, and deregisters
the listener in `finally`. This covers every in-process failure and every path through
`process.exit()` — including `docker stop`'s SIGTERM, whose shutdown sequence
(`close → drain → end → exit(0)`) does not wait for a running archive. Only SIGKILL escapes it.

For SIGKILL (and any pre-fix leftovers), `sweepTempFiles(dir)` removes stale temps. It runs at
the start of every `runNow()` — so the next attempt reclaims the previous crash's space before
writing — and once at boot from `main.ts`. It is guarded by the `running` flag so it can never
unlink the temp of an archive in flight in this process; there is exactly one app process per
backup directory.

### 2. Free-space precondition

After the walk, `archiveImages` knows every file it will tar and its size. It estimates the
tar as `sum(sizes) + 2 KiB × count` (headers, padding, occasional pax extension) and refuses
unless `free >= estimate + UPLOAD_HEADROOM_BYTES` on the backup directory's filesystem. The
floor is the same 2 GiB reserve `/upload` keeps "so a site build and a backup can still run":
after the archive lands, publishing and uploads must still have room.

A refusal throws `ArchiveSpaceError` (a `BackupError`), which `runNow()` already records as
`lastError` and logs — and, crucially, does **not** advance `lastImagesArchiveAt`, so the next
successful run covers the gap. A failing `statfs` is logged and the archive proceeds (same
fail-open convention as `/upload`: an unreadable statfs must not silently disable backups).

### 3. Cutoff recovery is derived from disk

`readState` now validates the shape it reads: each timestamp must parse, `lastError` must be
a string; anything else is dropped, and an unreadable or non-object file is logged and treated
as empty. A bogus timestamp can no longer poison the comparison.

The archive cutoff used by `runNow()` is

    chain  = archiveChainCutoff(dir)          // 0 when no images-*.tar exists
    since  = stored === undefined || chain === 0 ? chain : stored

where `archiveChainCutoff` reads the newest `images-*.tar` name and returns its stamp — walking
back through any run of consecutive-second stamps, because a same-second collision bumps a
name forward of its walk-start (the bumped archive's real cutoff is at or after the earliest
stamp in the run). An intact `stored` value next to an existing chain is trusted as-is: taking
`min(stored, chain)` instead would re-include, on every run, the files written inside the
previous walk's truncated second and mint a needless duplicate archive for them.

What this makes recoverable, exactly:

- **`state.json` corrupt, missing, or lacking `lastImagesArchiveAt`** while archives exist →
  the next archive is incremental from the newest archive's stamp. Files modified inside that
  archive's walk second are re-included (benign duplicates); nothing is skipped.
- **The whole chain deleted by hand** (an admin reclaiming space) while `state.json` is intact →
  the cutoff falls to `0` and the next run writes a fresh full archive. Before this change the
  chain was silently broken: the cutoff kept advancing over an empty directory.
- **State write failed after a successful archive** → same as the first case.

Not recoverable, unchanged: deleting only *some* archives of a chain is not detected (the
state still vouches for the newest stamp), and files whose mtime is set *backwards* (a
host-level restore that preserves old mtimes) are never re-archived by an mtime-based
incremental. Both are documented in `ARCHITECTURE.md`.

### 4. Concurrency is visible

`DbBackup` gains `running()`. `POST /backups` answers **409** `{ error }` while a run is in
flight; `GET /backups` includes `running: boolean` so the settings page can show *Running…*
instead of the previous run's status. `runNow()` itself keeps returning the current state when
called while running — the hourly tick fires it without awaiting, and a rejection there would
be an unhandled promise.

### 5. Schedule anchored to calendar windows

`isBackupDue` is due when the UTC day (daily) or the Monday-anchored UTC week (weekly) of
`nowMs` is later than that of `lastSuccessAt`. With an hourly tick that fires in the first hour
of each window instead of drifting an hour per day. A missed window (app down over midnight)
is still caught up on the next tick or boot.

## Invariants

- No file matching `*.<pid>.tmp` remains in the backup directory after `runNow()` resolves, in
  this process or — after the next boot or run — from a killed one.
- The archive never starts when the estimate would leave the volume below the upload reserve.
- `lastImagesArchiveAt` advances only after `archiveImages` resolves (existing); with no
  archive on disk, or no usable state, the cutoff comes from disk, never from a guess (new).
- An invalid `state.json` value can never turn into `NaN` inside a comparison.
- Every existing archive name, dump name, download route, and restore path is unchanged.

## Misuse cases

- **Admin hammers *Back up now*.** Second click → 409, first run unaffected; the UI shows
  *Running…* from `GET /backups`.
- **Attacker-shaped `state.json`.** The file is admin/root-writable only; even so, non-string
  and unparsable values are dropped rather than trusted.
- **Foreign `images-*.tar` copied into the directory.** Its stamp is used only when the state
  is unusable; then it can make the cutoff earlier or later than the truth. An admin who plants
  files in `/data/backup/db` already owns the backups outright.

## Rollback

Revert the PR. The archive format, filenames, `state.json` keys, and routes are unchanged, so a
tree built before this change reads everything a tree built after it wrote — and vice versa. A
recovered cutoff is persisted only as the ordinary `lastImagesArchiveAt` after a successful run.

## Tests (`uploader/test/backup.test.ts`, `server.test.ts`)

- A failing tar leaves no `.tmp` and rejects.
- Insufficient space refuses before creating any file; a failing `statfs` does not refuse.
- A stale temp is swept by `runNow()`.
- Corrupt `state.json`: cutoff derived from the newest archive; only newer files are tarred.
  A garbage `lastImagesArchiveAt` is dropped rather than turned into `NaN`.
- Deleted archives with an intact state → full archive again.
- Consecutive-second stamps → the earliest stamp of the run.
- `POST /backups` → 409 while running; `GET /backups` reports `running`.
- `isBackupDue` window semantics (day boundary, Monday-anchored week).
