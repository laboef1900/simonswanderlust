# Disposable whole-blog restore rehearsal — #295

Date: 2026-10-29. Scope: owner-authorized synthetic recovery into an isolated local target.
This is a runbook and bounded evidence record, not permission to restore production, change
restore semantics, remove volumes, deploy, or qualify an upgrade/downgrade.

## Recovery contract

Current dump **v11** contains `users`, `posts`, `pages`, `media`, `media_folders`,
`app_secrets`, `comments`, `post_routes`, `site_identity` and `site_identity_assets`.
It does not contain settings.json, image files, sessions, or the encryption master key.
Private route originals accompany the dump in its manifest-named route archive; never
substitute an archive based on a similar timestamp. The v10 evidence below remains historical,
not evidence of an identity-capable native image rehearsal.
Image recovery requires the full base plus all subsequent incremental archives, oldest-first.
Static releases are rebuilt explicitly after restoration; a successful database restore alone
does not prove a working blog.

Use the [offline restore contract](../ARCHITECTURE.md#database-dumps) and
[exclusive-owner instructions](superpowers/specs/2026-10-27-issue-398-offline-restore-instructions.md).
This rehearsal adds isolation and whole-blog acceptance, not another restore mechanism.

## Reusable isolated procedure

### 1. Prepare immutable input and an unmistakable target

- Retain a verified source dump, its exact manifest-paired private archive, the complete image
  archive chain, matching settings.json, and separately escrowed original `ENCRYPTION_KEY`.
  Keep the original recovery input immutable and outside the writable target data tree. Copy
  regular files, not hard links (the recovery guards reject multiply linked inputs). Record
  basenames, sizes and digests without recording content, keys, credentials or private locations.
- Use a **separate absolute directory**, for example an operator-created
  `/absolute/disposable/restore-295-<unique-id>/target`, with its own standalone `compose.yml`.
  Do not invoke the root checkout's Compose file or use the owner's `uploader/data`.
- Give this target a unique Compose project, an explicit absolute bind from its own initially
  empty `data/` to `/data`, a fresh project-scoped named `pgdata` volume (no `external` volume
  and no fixed shared volume name), and a distinct database such as `swl_295_target_<unique-id>`.
  Preserve the image's required Postgres mount layout. Never reuse or delete an existing volume
  to make it appear fresh.
- Pin the intended application image and record its ID, source revision and dependency
  provenance. Do not mount older source over unrelated newer image dependencies. Use matching
  source and lockfiles for the runtime; this rehearsal encountered precisely that mismatch.
- Keep the database unpublished. During zero-user bootstrap and CLI restoration, publish **no
  app port** and attach no reverse proxy. For validation only, configure a single binding
  `127.0.0.1:33395:3000` (or another unused **non-3000** loopback port). A source and target may
  use that port sequentially, never concurrently. No internet ingress is permitted.
- Preserve the source's configured image origin for restored content. Synthetic source and
  target here both used `http://127.0.0.1:33395`. For another source, plan isolated local origin
  resolution rather than rewriting stored URLs or relaxing gallery origin checks. Do not point
  the rehearsal at live services or change public DNS.

Make every command name the disposable configuration explicitly. These variables must be set
to the operator's verified absolute directory and unique project, not copied from production:

```sh
# Set REHEARSAL_DIR and REHEARSAL_PROJECT to the new disposable target first.
dc() {
  docker compose --project-directory "$REHEARSAL_DIR" \
    -f "$REHEARSAL_DIR/compose.yml" -p "$REHEARSAL_PROJECT" "$@"
}
dc config
```

Inspect resolved configuration **privately**: full Compose output may contain secrets. Retain
only a redacted preflight showing the project, application image, exact resolved host `/data`
source, database host/port/name, actual named volume, and port bindings. Check that the data
directory is empty and not a symlink/alias into owner data, and that the database/volume are
new. A changed project name alone isolates neither the default relative bind nor port 3000.
**Stop on any mismatch; do not write, extract, or answer `yes`.**

### 2. Bootstrap, then stop all writers

Start only the disposable database and configured app, with no ingress. The real app boot
creates the schema; the restore CLI does not initialize missing tables. Verify the fresh
state (`needsSetup: true`, no users; seeded About pages are expected), without creating an
admin account. Stop the app and wait for clean exit and drained app database sessions:

```sh
dc up -d db app
dc stop app
```

Keep Postgres running. Stop every other app or maintenance writer sharing this target's
storage/database. Do not kill database sessions, bypass the storage-owner lease, or use
`exec app … restore` on a running app. Copy the selected dump and companion route archive
into the target's recovery directory, preserving their basenames, while retaining the
immutable originals separately. Keep space for the CLI's verified undo set and staged originals.

### 3. Inspect both identities before confirming

Substitute the actual dump basename in this command; do not add `--service-ports` or `--yes`:

```sh
dc run --rm --no-deps --entrypoint node app --import tsx src/cli.ts \
  restore /data/backup/db/db-YYYYMMDD-HHmmss.json.gz
```

Before typing literal `yes`, compare **both**:

1. The resolved `/data` host path from the exact Compose configuration above is the disposable
   target, not the source or owner's data directory.
2. The CLI's credential-free `host:port/database` target is the intended fresh database, and
   its live counts match the bootstrapped target. Compare the input version, timestamp and
   per-table counts with the retained source record.

EOF or any response other than `yes` aborts unchanged; a deliberate inspection/EOF run may
exit 1 and is not a successful restore. On the confirmed run, the CLI must validate the input,
write and verify its **pre-restore undo recovery set**, report its path, and exit successfully.
Keep that verified undo set alongside the untouched input. Do not replace these guards with
an operator-created empty file or a claim that a backup merely exists. On failure or ambiguous
completion, keep the app stopped and retain input, undo and staged sets for investigation.

Compare restored counts with the input. An optional second CLI invocation answered with EOF
can print the live counts without performing another restore; label that exit separately.

### 4. Recover files and settings before boot

- Confirm the target `images/` is still empty; if not, stop and investigate rather than deleting
  it. Inspect trusted archive members for the expected relative image paths. Extract the
  selected full/incremental chain **oldest-first into this target `images/` only**, with later
  copies replacing earlier copies. Never untar into the checkout, a shared `/data`, or a live
  installation. Retain every input archive; do not reconstruct a chain from just the latest tar.
- The CLI handles manifest-verified private route originals and fresh storage identities.
  Do not manually untar private originals into public `images/` or substitute old identities.
- Copy the matching settings.json to the target settings path and compare its digest with the
  source record. Reconcile provider assignments with the restored encrypted secret rows.
  Supply the original master key through private runtime configuration, not logs or evidence.
  The database restore itself does not need the key; subsequent credential decryption does.
- Only then start the restored app. Configure/recheck the non-3000 loopback-only port for local
  validation, keeping all external ingress closed. Log in with a restored account; sessions
  are not restored and setup must now be closed.

### 5. Rebuild, rescan, and prove the surfaces

Run **Settings → Rebuild site now** (authenticated `POST /rebuild`), then the admin media
Rescan action (`POST /media/rescan`). Retain the rebuild result and complete rescan report;
expect no missing/demoted media for a complete recovery, not merely a green health response.

Acceptance checklist:

- Input/restored table counts agree, including locale rows, folders, comments and private routes.
- Restored accounts work; setup is closed. Approved comments appear publicly and pending comments
  remain in moderation, not in the public list.
- Both locale story pages render after the explicit rebuild. At desktop and mobile widths,
  gallery images actually decode, variants return 200, and the page has no horizontal overflow.
- Settings match and the restored provider credential decrypts without exposing it or contacting
  a model. Missing/wrong-key checks, when performed on disposable configurations, must fail
  explicitly without breaking ordinary non-AI content; record their runtime provenance separately.
- Compare retained private image originals and authenticated GPX originals against source
  digests/bytes. Check public original-image URLs remain unavailable and unauthenticated private
  route access remains refused. Successful image display alone proves neither private recovery
  nor private access control.

On any failed check, contain the target and retain evidence; do not change product security
checks to make the drill pass. Stop only the owned disposable services when finished. Keep
recovery material; this runbook does not authorize volume deletion or cleanup of owner data.

## Observed evidence — 2026-10-29

Evidence root, relative to the canonical working checkout:
`.local/backlog-execution-2026-10-27/issue-295-runtime/`.
The summary below is durable documentation of the retained local evidence; those artifacts are
not committed public backup material. No secret values or private originals are reproduced here.

### Isolation and provenance

The source was project `swl295source1793262571`, database `swl_295_source`, under
`simonswanderlust-issue-295/.issue-runtime/restore-20261029T082931/source/data` in the
separate issue worktree. The corrected fresh target was project `swl295current1793268997`,
database `swl_295_target_current`, with its distinct bind under
`.issue-runtime/restore-20261029T082931/current-source-rehearsal/target/data`.
`proof.json` records the full absolute paths, initial source/target named-volume preflight,
and the corrected current-worktree mount/port preflight. Only owned synthetic stacks were used.
Port `127.0.0.1:33395` was used sequentially. An initial Docker internal-only network prevented
host access despite the configured mapping; an isolated ordinary project bridge with no DB
ports and loopback-only app ingress replaced it without deleting retained volumes or bind data.

The successful final surface proof is **only**
`proof.json.currentWorktreeQualification.lockedRuntime`:

- Source HEAD: `0d7e6f4bd777e3c82f31033ceeb72c281836de55`.
- Locally built locked runtime: `swl-issue295-locked:1793270694`.
- Locked image ID: `sha256:869562b79e25e943110806b451311707e72437e5d2f9b0bee28c71ebd456fb58`
  (`linux/arm64`, observed from the final local image).
- Source archive SHA-256: `e0dff3338f538a161c517a31dc3a4ba71b62a2b7744958b6a30bdf8535d66f11`.
- Basemap assets were reused from the prior synthetic image, not freshly packaged.

Earlier attempts used image
`sha256:b657a5af6088efe39c60cd78fe1af9c1d1fb5115041df00f91254f68620c819c`
(`qualification-20261028192804`, Node 26.12.1, sharp 0.35.5, libvips 8.18.7).
Mounting the issue source over those different dependencies produced image HTTP 500
(`res.setHeader is not a function`). This was **contained**, not bypassed in product code.
The final exact-lockfile runtime rebuilt and served decoded images successfully. The earlier
image ID/native versions must not be attributed to the final locked image. The outer
`currentWorktreeQualification.status` still describes the earlier mismatch; its nested
`lockedRuntime` records the subsequent recovery and exact image identity, not an assertion
that the mismatch never occurred.

### Results and evidence map

| Result | Retained evidence |
| --- | --- |
| Current-source backup, dump v10 `db-20261029-101818.json.gz`; private archive complete with 1 present and 0 missing/corrupt/unreadable/oversized originals | `proof.json.dumpVersion`, `currentWorktreeQualification.backup`, `.dump` |
| Fresh target boot exposed setup only in the isolated environment; CLI restore exited 0 and verified its undo set; count-only EOF readback exited 1 | `currentWorktreeQualification.targetInitiallyEmpty`, `.freshTargetSetupOpen`, `.restore` |
| Restored **2 users, 2 posts, 2 pages, 3 media, 2 folders, 3 comments, 1 private route** (posts/pages are locale rows) | `currentWorktreeQualification.restore.counts` |
| Two retained image archives applied oldest-first: `images-20261029-085216.tar`, `images-20261029-090054.tar`; matching settings digest retained | `currentWorktreeQualification.files` |
| Current-source target login 200; rescan: scanned 3, inserted 0, altHarvested 0, markedMissing 0, demoted 0, recovered 0 | `currentWorktreeQualification.login`, `.rescanAfterRebuild`; this rescan preceded the final locked-image switch |
| Final locked runtime: credential decrypted, variant 200, actual rebuild succeeded, release `1793271144406-7-0000` | `currentWorktreeQualification.lockedRuntime.credentialDecrypted`, `.variantStatus`, `.build` |
| EN desktop at 1365px: two decoded gallery photos, no overflow; DE mobile at 390px: two decoded gallery photos, no overflow | `lockedRuntime.desktop`, `.mobile`; `locked-restored-en-desktop.png`, `locked-restored-de-mobile.png` |
| Earlier disposable restore: setup closed, 2 approved and 1 pending comments, private route digest matched | Top-level `setupClosed`, `approvedComments`, `pendingComments`, `privateRouteDigestMatched`; not a separate final-locked-binary recheck |
| Earlier missing-key scenario: 503 `encryption_key_unconfigured`; wrong-key scenario: 503 `ai_secret_unavailable`; story and preview each remained 200 | Top-level `missingKey`, `wrongKey`; same credential implementation, not exact final locked-binary provenance |

The original `isolation.json`, `restore-preflight.txt`, `restore-confirmed.txt`,
`restore-count-readback.txt` and non-`locked-` screenshots describe the initial attempt. Do not
use those screenshots as final locked-runtime success evidence or conflate the original
`swl_295_target` database with the corrected fresh `swl_295_target_current` target.

### Automated coverage and limits

`uploader/test/restore-rehearsal.integration.test.ts` exercises the current `DUMP_VERSION`:
real app backup → fresh schema bootstrap → stopped/drained app → actual interactive restore
CLI and verified undo → file/settings recovery → real `src/main.ts` boot. It uses two random
schemas derived only from `TEST_DATABASE_URL`, private temporary directories and the serial
integration project because ownership is database-wide. Its fixture has **one** media item,
not the manual drill's three. It checks restored users/roles, closed setup, rescan, media
metadata/redaction, variant bytes and original-image refusal, both locale gallery previews,
comments (including the retained author display name), private route recovery/access, and
missing/wrong-key behavior. Loopback app fixtures explicitly ignore inherited Docker proxy
mode; this does not qualify the production proxy topology.

The suite deliberately has no usable `SITE_APP_DIR`: preview rendering is not an Astro build
or browser proof. The manual locked runtime above supplies the actual rebuild and rendered-page
evidence. The suite skips without `TEST_DATABASE_URL`. The final local verification ran with a
fresh isolated integration database and passed both complete test suites, uploader typecheck,
Astro check and the real Astro build. Logs are retained in the execution ledger under
`wave-two-results-1793272007813_91028.json`; this does not claim GitHub CI or review success.

This proves a bounded synthetic local Linux/arm64 recovery journey, **not** production data
recovery, offsite retrieval/key-escrow durability (#296), a released upgrade/backward-compatible
rollback pair (#298), clean-host qualification (#292), fresh map packaging, or a security-floor
qualification. Dependency installation reported existing vulnerable paths tracked by #369;
no deployment approval follows from the successful restore. Final PR review and CI status are
not established by these artifacts.
