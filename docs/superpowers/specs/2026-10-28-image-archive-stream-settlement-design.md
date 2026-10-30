# Image archive failure must settle its writer before cleanup

Date: 2026-10-28
Status: **OWNER APPROVED 2026-10-28 — separate defect and PR.** Newly discovered prerequisite outside the original issue snapshot; implementation and verification remain required.
Risk: High — backup artifact integrity and shutdown/ownership settlement.

## Evidence and scope

The full uploader suites in the isolated #375 and #291 worktrees independently failed existing `backup-boundary.test.ts` assertions after a selected original disappeared before tar opened it. `archiveImages` rejected with ENOENT, but an `images-*.tar.<pid>.tmp` file remained. Logs are retained in the private execution ledger (`issue-375-wave-two-1793181361952-uploader-tests.log`, `issue-291-wave-two-1793181361952-uploader-tests.log`). These are observed failures, not a reason to rerun until green.

The relevant application code is unchanged from the integration baseline: `backup.ts` calls `await createTar({ file: tmp, ... }, fresh)`, then unlinks `tmp` in catch. Installed `tar/dist/esm/create.js` rejects that promise on the packer's error, independently of the destination stream's open/close lifecycle. A pending open can therefore recreate the path after cleanup, and the returned promise does not establish that all file writes have settled.

This proposal does not change #295's restore semantics or silently expand its docs/test-only scope. Owner approval is requested for a **separate focused defect issue and PR**, reported outside the original snapshot. Affected PRs can then stack on or integrate that single prerequisite without duplicating its patch.

## Proposed implementation contract

Own the archive pack stream and destination stream explicitly using the existing tar package and Node stream APIs. Establish destination/error listeners before starting consumption; use one awaited pipeline or equivalent complete lifecycle that settles both streams on every outcome. Confirm the installed stream API and destruction/closure behavior before selecting the exact implementation; do not assume the file convenience promise implies closure.

- On success, await destination completion and closure before the existing abort/lease check and atomic rename. Preserve archive names, collision handling, file selection, filesystem cutoff/provenance, strict tar behavior and returned result.
- On pack/open/write failure, stop both sides and wait until any pending open, writes and close have settled **before** unlinking the unfinished output and rejecting. Preserve the original failure, without retrying or turning a partial archive into success.
- Preserve the current cancellation contract: admitted work settles before quiescence releases storage ownership; an aborted/lease-lost run must never activate an archive or advance its cutoff. Do not introduce a new timeout, queue, worker, compression format or retention policy.
- Preserve process-exit best-effort cleanup and the existing boot/pre-run sweep for SIGKILL leftovers. Do not claim JavaScript can guarantee cleanup after SIGKILL or erase a prior successful archive as recovery.
- Only the temporary file created by this invocation is eligible for failure cleanup. Retained originals, completed tars, dump/route companions, state and owner data are never deleted by this fix.

There is one `createTar` writer in `uploader/src`; private-route backups use their own existing writer and are not refactored. Review the image archive's backup service and storage-owner/quiesce consumers for the stronger completion guarantee.

## Verification after approval

Keep the existing consumer-visible failure/retry assertions. Add a deterministic failure test that holds destination opening until the packer has failed, then releases it: the call must remain unsettled until resource closure, leave no temporary artifact after rejection, retain the original error and preserve the prior successful cutoff/archive. Cover output-open/write failure, successful readable archive contents and abort-before-activation. Do not make tests depend on repeated probabilistic runs or elapsed timing thresholds.

Run affected and complete uploader suites with a distinct isolated integration database, uploader typecheck, site check and applicable full CI. Exercise actual `archiveImages`/backup service against disposable files and a real tar writer, including failure then a successful retry and extraction. Observe quiescence waiting for resource settlement. Record sanitized output, not image contents or private metadata.

Update the existing backup specification/runbook and reconfirm SECURITY.md backup/restore integrity after proof. Independent review and exact-head CI remain required.

## Recovery and owner decision

No schema or persisted-format migration. Existing successful recovery sets remain valid. Containment is to avoid further archive attempts while a writer outcome is unknown, retain existing recovery material and roll forward; do not wipe backup directories to clear failures. Rolling back this code restores the cleanup race and is not a data-recovery technique.

**Owner approval recorded 2026-10-28:** “Approve separate defect and PR.” Filing and implementing this bounded separate backup writer-settlement fix is authorized, with the verification and no-data-loss boundaries above. This does not authorize a production backup, restore, deployment, volume deletion or owner-data change.

## Implementation and local runtime evidence

The implementation uses the installed tar `Pack`, Node `createWriteStream` and `pipeline`.
Listeners are established before adding files. Pipeline terminates the owned streams on error;
an explicit destination `close` barrier additionally covers pending open/write/close callbacks
before unlink/rejection. On success the same barrier precedes the existing abort check and
atomic rename. Cleanup failures retain the original archive error and defer the temp to the
existing sweep. No private tar APIs, archive format, cutoff or route-writer changes are required.

The installed tar pack inherits Minipass destruction, which does **not** cancel all of tar's
private input jobs. The guarantee here is terminal owned pack plus closed output, not universal
input-FD closure: read-only callbacks may continue, while the destroyed pack suppresses data and
pipeline retains error listeners. A controlled output-open fault with a real delayed input lstat
observed one input read after rejection and eventual closure of that input descriptor; it observed
no destination write, unhandled exception or recreated temporary path.

On 2026-10-28, disposable-file runtime proof on Node v26.12.1 also exercised a real selected-file
ENOENT with destination open and close independently gated, preserving the original error and
prior archive/cutoff; a backup-service retry produced an extractable, byte-identical synthetic
fixture. Lease cancellation during real destination write/close held service quiescence pending
and published neither an archive nor a new cutoff. Fault scheduling was injected at filesystem
seams; tar packing, stream I/O and extraction remained real.

Sanitized local evidence: `.issue-runtime/archive-stream-settlement-smoke.json` and
`.issue-runtime/archive-pending-input-smoke.json`. Regression coverage is in
`uploader/test/backup-stream-settlement.test.ts`; automated test/typecheck execution, independent
review and exact-head CI are still required from the integration owner.
