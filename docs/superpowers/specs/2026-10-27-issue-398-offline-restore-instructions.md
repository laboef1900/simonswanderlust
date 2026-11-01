# #398 — Restore instructions must use a stopped app and exclusive ownership

Date: 2026-10-27. Risk: **High — destructive recovery guidance.**
Status: **OWNER APPROVED 2026-10-28; implemented and disposable operator drill completed 2026-10-28.** Parent automated checks and review remain required. No production restore, deployment or volume deletion is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Source-backed defect

`uploader/src/storage-owner.ts:114–151` admits restore only with the advisory lease and no `swl-app:` sessions. `restoreMain` (`uploader/src/cli.ts:76–179`) enforces both before mutation and again through `restoreDatabase`. Its dedicated usage already says stop the app; general CLI usage at lines 391–398 still recommends `compose exec ... restore`. `SECURITY.md:889–900` and `ARCHITECTURE.md:634–648` repeat that impossible live-app recipe. The supplied running-app refusal is ground truth; it was not rerun.

`Dockerfile:118–122` sets `/app/uploader` as workdir and starts Node directly; Compose supplies the same image, database environment and `/data` bind mount. The existing correct ARCHITECTURE restore section uses a one-shot `--entrypoint node` invocation. This source inspection establishes the proposed command shape, **not** a successful runtime rehearsal.

## Proposed narrow change

Change general CLI help in `uploader/src/cli.ts` and the two stale documentation sections to one canonical stopped-app procedure. Align the restore-specific usage with the same explicit entrypoint form. Keep `exec` for rebuild, set-password and audit-exif. Do not modify ownership acquisition, restore admission, schema, backup format, confirmation or restore semantics.

Operator sequence, with the actual validated dump basename substituted for `db-YYYYMMDD-HHmmss.json.gz`:

```sh
docker compose stop app
docker compose run --rm --no-deps --entrypoint node app --import tsx src/cli.ts restore /data/backup/db/db-YYYYMMDD-HHmmss.json.gz
```

Before running that sequence, confirm the intended image, database and `/data` bind path; retain the input dump and its manifest-matched private route archive. Keep Postgres running. Stop every app instance and other maintenance writer sharing that database/storage, wait for process exit/session drain, and keep public ingress disabled for a fresh or otherwise unsafe recovery target. `--no-deps` must not accidentally launch another app; do not add `--service-ports`. Resolve configuration privately: never paste full Compose environment or secrets into evidence.

Inspect the CLI's credential-free target and row counts before answering literal `yes`. The default example is interactive, not `--yes`. Explain that `--yes` skips only the prompt, never exclusive ownership, source-set validation or verified pre-restore backup. The CLI writes and verifies an undo recovery set before replacing rows; insufficient space, invalid archive or ownership refusal aborts. Never kill database sessions or disable fencing to force admission.

Only after the one-shot CLI exits successfully and the reported result is inspected:

```sh
docker compose up -d app
```

Reconcile the matching settings file/master key before using remote AI; log in again (sessions were invalidated) and explicitly rebuild through Settings. Static release contents do not automatically follow a DB restore. Failed or ambiguous completion: leave the app stopped, preserve input/undo/staged sets, investigate the stated outcome; do not blindly retry or erase recovery files. Lease recovery follows the existing stopped-owner procedure.

## Postgres-major app-native alternative

Keep the primary Postgres-major procedure separate; do not invent in-place upgrade or downgrade support. Correct the alternative as follows:

1. While on the old version, take and verify an old-version dump plus all paired private archives, image recovery material, settings and key escrow. Check the target app accepts that dump version. No deletion of the old cluster is authorized by this issue; follow the existing major-migration safety gates only after a verified backup, preserving the old cluster where possible.
2. On the **isolated new target**, boot the configured app once against the new database so `ensureSchema` creates the tables. Keep ingress blocked for the whole zero-user window, not merely until health first becomes green. `/health` alone is not proof of schema/content recovery.
3. Stop the app and wait for exit/drained sessions, leaving the new Postgres running. Use the same one-shot restore command and confirmation/pre-backup safeguards above. The fresh schema is necessary: restore queries live table counts and creates its undo set; the CLI does not initialize missing tables itself.
4. Restart only on confirmed restore success, rebuild and verify restored content before reopening ingress.

Replace the stale “users, posts and pages only” claim with the current dump scope (v10: users, posts, pages, media, media_folders, app_secrets, comments, post_routes plus manifest-paired private originals), with links to version-specific absent-field behavior. `settings.json` remains external; sessions are not restored. Coordinate that paragraph with #295 rather than publishing competing edits.

## Invariants and verification

- No advice recommends live `exec` for restore; mentioning that it is refused is acceptable. A targeted docs/help search at implementation time finds and fixes all actionable copies, including the uploader guide if present.
- No new web restore route, authentication relaxation, lease bypass, data wipe or implicit production restore.
- `SECURITY.md` Backups must describe exclusive ownership, verified undo material, confirmation and the correct command; reconfirm its GPX/storage-owner section unchanged.
- Implementation assignment clarification: do not add wording-pinning tests for this help/documentation-only change. Inspect existing meaningful CLI/restore tests and exercise the actual operator scenario; the parent runs applicable suites. Restore guards remain unchanged.
- Use a disposable topology (separate host bind, database/project and non-3000 loopback port) for the corrected fresh-schema flow. Record image digest, isolated target identification, source/undo validation, counts and successful reboot/rebuild. Accept the supplied live-app refusal rather than repeating it; verify competing app admission is refused while restore holds ownership. Confirmation/backup failure coverage remains in the existing integration suites.

#295 remains independent: its retained test fixture was inspected read-only, not executed or
edited, and none of its results are claimed here. This implementation used its own topology.

Subsequent #295 evidence (2026-10-29) is recorded separately in the
[whole-blog isolated restore runbook](../../2026-10-29-restore-rehearsal.md). It covers
nonempty media/comments/secrets and a fresh target with distinct bind/database/project,
followed by an actual rebuild and desktop/mobile gallery decoding on its final locked runtime.
It does not retroactively broaden the #398 evidence below, establish upgrade/downgrade
eligibility, or claim offsite recovery. Its earlier dependency-mismatched image attempt and
key-error scenario provenance remain explicitly bounded in that record.

For a fresh whole-blog recovery, complete image-chain and matching settings/key recovery
**before** restarting the restored app; otherwise boot reconciliation can mark media missing.
Extract images oldest-first into the fresh target's empty `images/`, never by clearing an
existing installation. The private archive remains manifest-paired and is handled by the CLI.
Retain the verified undo set and immutable recovery inputs. Inspect both the resolved host
`/data` bind and the CLI's database target before confirming; a separate Compose project
alone does not isolate the default relative bind or port 3000.

## Observed disposable evidence — 2026-10-28

- Compose project `swl-issue398-offline`, own `.issue-runtime/drill-pg` and `drill-data`
  binds, target `swl_398_dev` and separate synthetic source `swl_398_source`. The preconfigured
  shared development/test databases were not used or modified by this drill.
- Reused local Linux/arm64 image
  `sha256:e78d3f6d82114fbeec9838930bfeb8aa3770a2d50a913c85aa0fe0268d7ce5c2`
  from #371 for its runtime/dependencies/site configuration and assets; this worktree's
  `uploader/src`, `uploader/public` and `site/src` were mounted read-only. This is not a newly
  built #398 image. Postgres 18 image:
  `sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2`.
- Fresh boot ran the real `main.ts`/`ensureSchema` with only an internal Docker network,
  container-loopback listening and no published ports. Observed 13 public tables and zero
  users. Stopping the app left zero `swl-app:` database sessions.
- Actual `run --rm --no-deps --entrypoint node` restore displayed the correct target/counts
  and waited for literal `yes`. A competing app-role ownership request was refused with
  `storage_read_only` while that prompt held the restore lease. No gate/session bypass.
- Source `db-20261028-134049.json.gz` and undo `db-20261028-134113.json.gz` both passed
  `readDump` and `verifyRouteArchive`. Restore exited 0. Persisted counts were users 1,
  posts 2, pages 2, private routes 1; media, folders, secrets, comments and sessions 0.
  The restored private original retained its SHA-256 and received a fresh source ID.
  The undo set preserved the fresh target's two seeded pages and empty remaining tables.
- Restart, login and explicit authenticated `POST /rebuild` all succeeded (HTTP 200).
  Both synthetic DE/EN story pages returned 200 with restored body content. Only afterward
  was ingress opened at `127.0.0.1:33498`, where health and both stories again returned 200.
  The app and database were then stopped; recovery sets and all disposable data were retained.
- Actual general and restore-specific CLI help emitted the stopped-app/explicit-entrypoint
  command; general help retained `exec` for rebuild, set-password and audit-exif.

Redacted transcripts, counts/hashes, provenance and limitations are retained locally as
`.issue-runtime/398-{provenance,source,recovery,http,cli-help,outcome}.json`,
`398-restore.log` and `398-reboot.log`. Synthetic fixture setup initially omitted hero alt;
that source-only setup error was corrected without changing restore or deleting committed
fixture data. Docker's internal-only network also kept the first port-mapping attempt closed;
a separate ingress network was added only after verified recovery.

Limits: this proves the fresh-schema restore/reboot/rebuild sequence on Postgres 18, not a
cross-major cluster conversion. Nonempty secrets/comments/media restore fidelity remains
covered by existing integration suites, not claimed from this minimal fixture. No suites,
typechecks or standalone builds were run by the implementing worker. Parent checks: uploader
`npm test` with its isolated `TEST_DATABASE_URL`, `npm run typecheck`, and site
`npx astro check` with the configured development database. Applicable focused suites include
`cli.test.ts`, `backup.integration.test.ts`, `gpx-backup.integration.test.ts`,
`storage-owner.integration.test.ts`, `gpx-main-boot.integration.test.ts` and
`secrets.integration.test.ts`; retain the runner's serial integration project.

## Approval and containment

Owner decision: approve the narrow help/documentation correction and exclusive-owner operator sequence, including the temporary ingress closure for fresh-schema bootstrap. This grants no permission to restore production or destroy volumes. Rollback is documentation/help correction or roll-forward; never restore the known-broken live-exec advice as a supported recipe. On a failed drill preserve the disposable recovery evidence and stop; on a real recovery use the CLI's verified undo set under the same exclusive-owner conditions, after inspecting the outcome.
