# #397 — Promotion succeeds even when release pruning fails

Date: 2026-10-27. Risk: **High — build/publish and storage ownership.**
Status: **OWNER APPROVED 2026-10-28.** Commit-point success, bounded log-only cleanup warnings and fail-closed lease behavior are approved. Implementation, deterministic regressions and disposable runtime proof are complete; final integrator verification remains separate. No production operation, deployment or owner-data change is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Facts and root cause

`uploader/src/build.ts:182–217` stages a complete release and atomically renames `current` at line 208. It then enumerates/prunes releases in the same rejecting function. `runOnce` catches those later errors and returns `ok: false`, despite promotion having completed. The supplied EACCES reproduction is accepted as evidence and was not rerun.

One detail in the issue is broader than this baseline: the post-flip `readlink` already catches its own exception and substitutes an empty live name. That does not make pruning safe; inability to identify current must instead skip deletion. Enumeration, deletion and lease assertions can still reject after promotion. Pre-flip staging, build-temp cleanup, symlink and rename failures remain real build failures.

Affected implementation: `uploader/src/build.ts`, `uploader/test/build.test.ts`; documentation: `ARCHITECTURE.md` release/build recovery and `SECURITY.md` Single app container/storage-owner sections. Consumers are publish, unpublish, delete, bulk, page save, `POST /rebuild`, CLI rebuild and `bootstrapRelease`; their existing success shape need not change for this issue.

## Minimal proposed contract

1. The successful `rename(tmpLink, current)` is the commit point. Once it resolves, return `{ ok: true, release: stamp }` irrespective of later housekeeping. Do not undo the symlink or any already-persisted CMS content.
2. Separate the post-promotion prune phase from the throwing promotion path. Keep the existing `keep` selection and exclusive work lock; do not introduce a new scheduler, retry loop or storage format.
3. Enumeration or current-link inspection failure: report a cleanup warning and skip pruning for this run. Protect the promoted stamp explicitly as well as the observed current release. If current no longer identifies the just-promoted release, skip this prune pass rather than guessing ownership of release retention.
4. For each eligible old release, assert storage writability immediately before mutation. A deletion error while still writable is logged and the next candidate is attempted. A lost lease/aborted work signal stops the pass immediately; no subsequent removal or other recovery write is admitted. An already-issued filesystem operation cannot be recalled; this promises no *new* mutation after loss is observed, not retroactive cancellation of `rm`.
5. Never delete current, the promoted directory, staging entries, or releases outside the existing retention candidates. Do not suppress pre-promotion failures or weaken `assertWorkWritable`.
6. Use the existing container stdout/stderr diagnostic channel: a fixed message saying **release promoted; old-release cleanup incomplete**, the generated promotion stamp, a fixed stage (`enumerate`, `current`, `remove`, `ownership`) and a bounded errno classification (known errno or `unknown`). Do not log arbitrary directory names, raw exception messages/paths or build stderr as a pruning warning. The diagnostic itself must not turn completed promotion into a reported failure.
7. No new public/browser response field or UI warning in #397: logging satisfies the issue's required diagnostic; optional `pruneWarning` is deliberately not added. A succeeding build is not evidence that disk cleanup succeeded.

## Coordination with proposed #297 and #316

Neither proposal is approved by this document. Prefer #397 before #297 so the last-attempt record never calls this outcome failed.

- #297 exclusively owns build reports, sanitized last-attempt state and its persistence. Consume its eventual contract: after promotion `result = succeeded`, `release = attemptId`, and no build-failure diagnostic for pruning. Post-flip lease loss does not change that fact; if the durable record cannot be written under the lease, #297 must expose its existing persistence/unknown state rather than write without ownership. A separately observed live-link failure remains unknown, not invented evidence of failure or success of the last attempt.
- #316 owns optional per-release manifests. Its current spec pairs pruning of `manifests/<old>.json` with old releases. On integration, delete a matching manifest only after that old release was successfully removed and after another ownership check. A failed release deletion retains its manifest; a manifest deletion failure is another nonfatal cleanup warning. Current/promoted manifests are never candidates. Do not touch #297's `build-state.json`. Unreadable optional manifest state cannot reverse a completed promotion.
- Both proposed records remain distinct from disk-retention success. No new duplicate last-build record is introduced here.

## Trust boundaries and recovery

The builder owns mutation of `/data/site` only while holding its storage lease and work lock. A filesystem permission error is not permission to broaden deletion; a database/lease error is not permission to continue cleanup. Keeping extra releases is the safe outcome. Reader serving and admin authorization remain unchanged.

Operator recovery: inspect the fixed cleanup diagnostic and filesystem permissions/capacity; do not republish merely because old releases remain. After a lease loss, restore database availability, confirm no restore is running, and restart the same app configuration through the existing recovery procedure. A later authorized normal build retries ordinary retention. Do not direct the operator to delete current, wipe `/data`, change ownership blindly or bypass fencing. Persistent accumulation remains visible in logs and requires operator attention; this issue adds no telemetry.

## Verification required after approval

Extend `build.test.ts` with deterministic disposable fixtures/fault injection, not permission-only tests that accidentally pass as root:

- one old candidate fails removal; a later candidate is removed; outcome is successful and current serves the newly built bytes;
- enumeration failure and current-read failure each preserve all uncertain candidates and still return the promoted stamp;
- lease loss immediately after flip and between candidates stops later `rm` calls, while returning success;
- no warning leaks raw injected error text; warnings identify the cleanup stage;
- a pre-flip rename/build failure remains failure and preserves the previous served release; existing coalescing/retention tests remain valid;
- when #297/#316 land, success and manifest retention follow the coordination contract, including inability to persist status after lease loss.

Main integrator owns affected uploader suites and typecheck. The disposable runtime evidence below exercises publish/rebuild and CLI success independently; it does not replace the final integration gate.

Implementation separates `prunePromotedRelease` from the throwing promotion path without
changing exported builder options or outcomes. Current-link identity compares resolved paths,
not just basenames, so an unexpected target outside `releases/` also skips pruning. Logging
is guarded separately from cleanup. `build.test.ts` injects faults at existing filesystem
boundaries while retaining real temporary directories, copies, symlink renames and successful
removals; it covers inspection/removal faults, lease and signal loss, diagnostic sink failure,
backwards-clock retention and pre-flip rename failure. No suites or runtime checks were run
during implementation; these test additions are not evidence of passing verification.

### Disposable runtime proof — 2026-10-28

Executed the actual `uploader/src/main.ts` from the #397 worktree as uid 501,
bound to `127.0.0.1:33497`, against isolated `swl_397_dev` on loopback port 55427.
All writable roots were checked beneath this worktree's `.issue-runtime/`;
only synthetic releases, an uploaded synthetic image and one DE/EN post pair were used.
Evidence is retained locally in `.issue-runtime/promotion-proof.json` and
`.issue-runtime/lease-observation.json` (no credentials or session tokens).

- **Real post-flip filesystem failure, no cleanup shim:** an old synthetic release
  containing a file had directory mode `0500`, causing actual `EACCES` under the
  non-root app. Authenticated `POST /rebuild` returned HTTP 200 / `ok: true`,
  promoted `1793196465615-45864-0000`, and public HTTP serving changed from the seed
  bytes to real Astro output.
- **Publish:** the real admin publish route returned `published: true` and
  `build.ok: true`, promoted `1793196517501-45864-0001`, and HTTP
  `/runtime397-de/` served the new `marker397-publish` body. The unremovable old
  candidate remained, while the next eligible old candidate was removed.
- **CLI:** `node --import tsx src/cli.ts rebuild` reached the same running app,
  exited 0 and reported release `1793196551784-45864-0002`. `current` advanced and
  HTTP serving contained `marker397-cli`. To distinguish the rebuilt bytes, the
  fixture changed only the two synthetic rows' published snapshot body beforehand;
  this is not an authoring workflow or an operation on owner content.
- **Bounded diagnostics:** each of those three promotions emitted exactly the
  fixed cleanup warning with its generated stamp, `stage=remove errno=EACCES`
  (107 characters each). No candidate name, filesystem path or raw exception
  appeared in these cleanup warnings. Successful responses contained no new
  public warning field.
- **Real pre-flip failure:** mode `0500` on the synthetic `releases/` parent
  denied staging creation after a real Astro child completed. `POST /rebuild`
  returned HTTP 200 / `ok: false` with `EACCES`; `current` still named
  `1793196551784-45864-0002`, and the served story bytes were unchanged.
- **Observed lease-loss fixtures, not a physical lease outage:** a separate
  process called the real builder against disposable directories, copying the
  preceding actual Astro output through its `runBuild` seam. Narrow filesystem
  observation hooks switched `isWritable` false immediately after the real
  current-link rename, or after the first real candidate removal. Both runs
  returned promotion success and emitted `stage=ownership errno=unknown`.
  The first false ownership observation was recorded; zero subsequent builder
  filesystem mutation calls were admitted. Immediate loss retained all three
  old candidates; between-candidate loss removed the first and retained the
  remaining two. This proves the fixture's observed-loss boundary, **not** a
  database disconnect, advisory-lock outage or cancellation of an already-issued
  filesystem operation.

Four real Astro children ran only as part of the actual route/CLI scenarios.
The initial empty synthetic collection emitted empty-collection notices, and
Astro emitted its chunk-size warning; neither was suppressed. No standalone
suite, typecheck, linter or build verification was run by this runtime worker.
The owned app was stopped, fault permissions restored, and the temporary
observation script removed; synthetic data and redacted evidence were retained.
No application or test code changed. Admin authorization, storage-owner fencing,
retention selection and the security boundaries above were unchanged; this
proof implements neither #297 nor #316.

## Owner decision and containment

Approve this commit-point semantics, log-only cleanup warning and fail-closed lease behavior, including SECURITY.md reconfirmation. No new permission, data migration, API or deletion policy is requested. If implementation is defective, revert only this patch on a security-supported image or roll forward; retain the promoted release and persistent data. Reverting the patch can restore the known false-failure symptom and is not a rollback of published content. Never downgrade to codecs prohibited by #347.
