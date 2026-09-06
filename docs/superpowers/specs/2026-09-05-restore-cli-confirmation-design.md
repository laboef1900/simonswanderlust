# 2026-09-05 — `restore` CLI: confirmation, filename check, pre-restore dump (#114)

High risk per CLAUDE.md ("Change Risk and Required Rigor": backup/restore). Branch:
`feature/114-restore-confirm-predump`.

## Defect

`node --import tsx src/cli.ts restore <file>` went straight from argument parsing to
`restoreDatabase`, which `DELETE`s `posts`, `media`, `media_folders`, `users` and (v2+) `pages`
inside one transaction. No confirmation, no filename check, and no dump of the state being
replaced — although `dumpDatabase` is one import away. Tab-completing last month's dump instead
of yesterday's silently discarded every row written since. Golden Rule 3 asks for a backup before
any wipe; the tool did not take one.

## Trust boundaries

- The CLI runs **inside the container as the operator** (`docker compose exec app …`). Its caller
  already holds the database credentials (`DATABASE_URL`) and the `/data` mount; this change adds no
  authorization boundary — it adds a **mistake** boundary. The threat is the owner, not an attacker.
- Inputs: a file path (argv), an optional `--yes` flag (argv), a line on stdin (interactive
  confirmation), `DATABASE_URL` and `BACKUP_DIR` (env). None come from the network.
- Outputs: stdout/stderr text and one new file under `${BACKUP_DIR:-/data/backup}/db/`. The
  summary printed before the prompt names the target database as `host:port/dbname` only — the
  `DATABASE_URL` password is never echoed.

## Misuse cases

|Case|Before|After|
|---|---|---|
|Wrong dump file (tab-completion slip)|Wipe + restore of the wrong state; no way back|Summary shows the dump's `createdAt` and per-table counts next to the live counts; the operator must type `yes` (or pass `--yes`). Even after confirming, the pre-restore dump holds the replaced state.|
|Wrong file altogether (`state.json`, an `images-*.tar`, `db-x.json.gz.bak`)|`gunzipSync`/`JSON.parse` crash with a stack trace — or, for a valid-but-foreign gzip JSON, an unversioned "unsupported dump version undefined" after nothing checked the name|Refused **before** any DB connection: the basename must match `BACKUP_FILE_RE` (`db-YYYYMMDD-HHmmss.json.gz`), exactly the pattern the admin download route enforces.|
|Scripted restore in CI/automation, no TTY|Ran unconditionally|Without `--yes` the prompt sees EOF and the restore **aborts** (exit 1, nothing changed). Automation must pass `--yes` explicitly.|
|Pre-restore dump cannot be written (`/data` full, `BACKUP_DIR` unwritable)|n/a|Restore **aborts** before the transaction opens. A restore that cannot be undone is not run.|
|Dump from a future `DUMP_VERSION`|Rejected by `restoreDatabase` (allow-list)|Rejected by `readDump` — now shared by the CLI summary and `restoreDatabase` — before the pre-dump is written, so an unrestorable file does not leave a stray dump behind.|
|Pre-dump name already taken — by the file being restored (the documented undo path run back-to-back), by the previous run's pre-dump (two scripted `--yes` restores in one second), or the reverse: a **scheduled / "Back up now" dump** landing on the pre-dump's name in the same second (the app keeps running during `docker compose exec … restore`)|n/a|Dump names have one-second resolution and `atomicWrite` renames over an existing file, so a guard in the CLI alone cannot protect the pre-dump from the other writers. The no-clobber rule lives in **`dumpDatabase` itself**, and it is atomic across processes (round 3 pointed out that an exists-check before `rename` is a TOCTOU between the app and a `docker compose exec` CLI): the payload is written to a private temp file and published with **`link(2)`**, which fails with `EEXIST` if the name is taken — `rename(2)` would overwrite — and on `EEXIST` the stamp advances one second and the link is retried (`createdAt` keeps the real time). Every writer — scheduler, admin button, CLI — shares it. Pinned by a unit test (three dumps with one `now` → three files, earlier contents intact), a two-process stress test (2 × 40 dumps under one stamp → 80 distinct files, none lost; 20 were lost with the exists-check version), and two integration tests (back-to-back undo; two same-source `--yes` runs).|

## Invariants

1. **Nothing is deleted before a dump of the current state exists on disk.** Order in
   `restoreMain`: filename check → env check → parse dump (version allow-list) → count live rows →
   confirm → `dumpDatabase` → `restoreDatabase`. Any failure up to and including the pre-dump exits
   non-zero with "nothing was changed".
2. **Confirmation is explicit.** `--yes` on argv, or the literal line `yes` on stdin. Any other
   input, empty input, or EOF aborts.
3. **The pre-restore dump is an ordinary dump.** Same `dumpDatabase`, same directory as scheduled
   backups (`${BACKUP_DIR:-/data/backup}/db`), same `db-<stamp>.json.gz` name — so it appears in the
   admin backup list, is downloadable via `GET /backups/:name`, and can itself be restored with this
   command. It is also subject to retention pruning like any other dump; the CLI prints its path so
   the operator can copy it out if they want it kept.
4. `restoreDatabase` itself is unchanged in behaviour: still one transaction, still rolls back on
   error. The only edit is that it obtains the parsed dump through `readDump`.
5. **`dumpDatabase` never overwrites an existing dump, even from a concurrent process.** The name is
   claimed with `link(2)` (atomic, no-replace); a taken `db-<stamp>.json.gz` name advances to the
   next free second; `createdAt` still records when the dump was taken. This is the only
   behavioural change to the scheduled/on-demand backup path, and it is strictly safer (a scheduled
   run can no longer clobber anything either).

## Rollback / containment

- The change is CLI-only apart from invariant 5 (a no-clobber rule in the shared dump writer); no
  schema, route, or UI change. Reverting the commit restores the old unconditional behaviour.
- Operational rollback of a mistaken restore: run the same command against the pre-restore dump the
  CLI printed (`… restore --yes /data/backup/db/db-<stamp>.json.gz`).
- Residual risk: the pre-dump lives on the same disk as the live data (already documented under
  "Backups & disaster recovery"); disk failure between dump and restore is out of scope, as before.
