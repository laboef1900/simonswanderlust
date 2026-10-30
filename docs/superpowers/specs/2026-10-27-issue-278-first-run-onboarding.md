# First-run onboarding: Postgres state and restore-safe exclusion (#278)

**Date:** 2026-10-27; redesigned 2026-10-28.
**Status: OWNER-APPROVED DESIGN, 2026-10-28; IMPLEMENTATION AND INTEGRATION EVIDENCE OUTSTANDING.**
The owner approved optional Identity, install-wide Hide / Desk-only Show / explicit permanent
Finish, conservative all-restore retirement and admin-only checklists with role-safe author
empty states, then approved **P1: “Approve Postgres contract”** and **P2: the permanent off-DB
retirement marker and managed restore protocol** after the corrected 685-line contract passed
independent full re-review. The former `onboarding.json` progress/state design remains withdrawn.

**Issue:** design-only #278, parent #277; its owner-approval gate is satisfied. #279 still requires
dependent integration and implementation evidence. #280 can use the inventory/role rule
independently; #281 remains conditional on the language work.
**Risk:** high: schema, boot, `/data` operational metadata and offline restore boundaries.
**Baseline:** worktree source based on `origin/dev` at `11e16d1`; #271 is merged and the baseline
app-native `DUMP_VERSION` is 10 (private GPX recovery sets). This approved design specifies changes;
it does not claim they exist. No app code, tests, runtime or owner data changed for this design.

## 1. Outcome and fixed boundaries

After the existing first-admin setup, the Desk offers a short path to the first published story.
It does not replace the editor, create a draft, insert sample content, publish automatically,
block ordinary work, or add Publish prerequisites. The incumbent editorial Desk UI is preserved.

- `/setup`, `/login` and `/auth/status` retain their exact request/response shapes, status codes,
  `limitAuth`, `withSetupLock` and zero-user gate. Login already redirects to the Desk.
- Onboarding does not protect the zero-users recovery window. Recovery keeps the app stopped;
  onboarding state must never become an input to authentication or setup permission.
- Upgraded, restored and zero-user installations with existing content/data are excluded.
  **Every supported restore retires onboarding**, including self-, empty, partial and later-failed
  restores. There is no provenance/timestamp exemption.
- State is install-wide, never browser- or account-owned. No new `.env` setting.
- No language step, including a disabled placeholder, until #281 and its approved dependencies.
- #304's shared authenticated-context proposal is **separately unapproved**. This design does
  not approve `/auth/me`, owner fencing, receipts or any other #304 policy or API.

## 2. Source and review evidence

Owner records in the archived execution artifacts are
`owner-onboarding-decisions-2026-10-28.json` (Q1–Q5) and
`issue-278-postgres-owner-decision.json` (P1/P2, approved 2026-10-28).
The earlier `ReviewOnboardingWrites-review.md` assessed the withdrawn file proposal;
`ReviewOnboardingWrites-current.md` recorded the subsequent singleton-seeding defect in the
632-line redesign. After correction, **ReviewOnboardingWrites' independent full re-review of
the complete 685-line contract returned “correct”, no remaining P1/P2 findings, confidence
0.95**. It explicitly confirmed shared required-singleton initialization and actual
prepared-target dump validation, not schema existence alone. The owner then approved that
corrected contract. Static review and owner approval are not implementation/runtime evidence.

| Actual consumer | Consequence for this design |
|---|---|
| `uploader/src/main.ts:39-74,205-221` acquires ownership, runs `ensureSchema`, AI migration and import recovery before listening; bootstrap/reconciliation follow listen | Eligibility must be decided before maintenance can erase evidence and before listen/bootstrap/reconciliation. A new boot hook is necessary. |
| `uploader/src/db.ts:191-207` seeds About; `routeFiles.assertRoot()` creates directories | Seed rows and known empty structural directories are not evidence of owner content. |
| Installed #274 `main.ts:50-53` calls `seedSiteIdentity(pool)` separately after `ensureSchema`; `backup.ts:194-208,738-745` requires exactly one valid identity row | Schema creation alone cannot prepare a dumpable empty target. Normal boot and offline preparation must share the installed bootstrap-only singleton initialization (§6.3). |
| `uploader/src/backup.ts:153-210` uses a fixed SELECT/payload allow-list | Excluding a new table from app-native dumps is possible, but says nothing about full SQL/physical backups. |
| `uploader/src/cli.ts:95-178` validates input/archive, acquires a restore lease, checks drained app sessions, confirms, verifies an undo set, then calls `restoreDatabase` | Insert retirement after these native admission checks and **before** the call: `restoreDatabaseContents` stages GPX files before its first transaction guard. |
| `uploader/src/backup.ts:812-815,945-969` stages files, checks ownership, replaces rows in a transaction, checks again before COMMIT; uncertain COMMIT retains sources | Retirement is separate from the content transaction, must precede staging and must survive rollback/unknown commit. Preserve the existing recovery set and source-retention rules. |
| `uploader/src/storage-owner.ts:30-161` uses a dedicated Postgres advisory-lock connection with heartbeat; loss latches read-only, aborts a signal and closes that connection without reconnecting | It is not a filesystem lock, durable restore marker or cross-cluster lock. `isWritable()` is a local guard, not proof that arbitrary SQL is excluded. |
| `main.ts:173-199` quiesces workers and drains the app pool on lease loss; the HTTP/static server may remain alive | Offline recovery requires actual stopped processes and drained sessions, not just an apparently released advisory lock. |
| `ARCHITECTURE.md:542-568,612-648` supports native restore and `pg_dump`/`psql` major upgrades | Both remain supported under the approved procedure; the stale native example that runs restore inside a live app must be corrected, not copied. |
| `ARCHITECTURE.md:569-581` distinguishes password/account recovery | Password reset or deleting accounts alone is not a restore; it does not reset onboarding. |
| `posts.ts` Publish validation requires both locale heroes; media statuses reflect encoding | Photo is a real required step; processing/failed are not completion. |

## 3. Approved experience and derived progress

Step ids are stable API strings; all progress is derived from current data, not completion flags.

| Order / id | Label | Required for Finish | Done predicate | Destination |
|---|---|---|---|---|
| 1 `account` | Admin account created | No; informational | Requesting admin is authenticated | none |
| 2 `identity` | Name your blog | **No; optional** | #273/#274 `identityConfigured()`, exactly `saved_at IS NOT NULL` | #274's fixed Settings identity tab |
| 3 `photo` | Upload your first photo | Yes | Any `media.status = 'ready'` | `/admin/media.html` |
| 4 `story` | Write your first story | Yes | Any post row | New: `/admin/editor.html`; otherwise newest post's editor |
| 5 `publish` | Publish it | Yes | Any `posts.status = 'published'` | Newest draft's editor, otherwise `/admin/posts.html` |

Identity remains visible and useful before publishing, but untouched seeded identity is neither
a Finish blocker nor a Publish blocker. The UI marks it **Optional**; `required: false` is
returned. Completion/progress denominators use the three required steps, not four or five.
Skipping identity needs no persisted flag. #273's seed is not an explicit save.

Step states: `done` when the predicate holds, otherwise `todo`; photo alone uses `in_progress`
when no ready row but some processing row exists, or `attention` when neither ready nor
processing exists but failed/missing rows exist. Show text and icons, never colour alone.
Photo precedence is ready > processing > failed/missing > empty. Links use the existing Media
retry experience and existing editor; they do not start uploads, create drafts or publish.
Newest links sort by `created_at DESC, translation_key ASC, locale ASC` to break ties;
encode the selected translation key as one query parameter. No slugs are changed.

Every eligible read derives progress in one read-only REPEATABLE READ transaction, including
state, media/post predicates, links and the identity predicate on that same client. A retired
row skips progress queries. The implementation must expose transaction-aware read methods in
both pg and memory stores rather than mix pool snapshots. Counts/rows remain internal.

Deleting the sole ready photo, deleting the sole post or unpublishing the sole publication
regresses progress at the next read. Identity follows its approved saved predicate, not a
comparison with defaults. No remembered completion or “previously done” badges.

- **Hide checklist:** install-wide dismissal; survives restart and applies to all admins.
- **Show setup checklist:** Desk header link only; clears dismissal. No Settings/nav entry.
- **Finish:** explicit and permanent; allowed only when Photo, Story and Publish are done in
  the server's action snapshot. Optional Identity can still be `todo`. Finishing retires the
  row; both checklist and Show disappear. Publish alone never finishes it.
- A hidden checklist stays hidden even after completion; Show then Finish is intentional.
- Post-Finish regressions do not reopen it; #280 empty states still work.

Finish locks the singleton row, re-derives required predicates and retires in one REPEATABLE
READ transaction. It never trusts the browser's earlier `complete`. A concurrent content edit
committed after that snapshot may regress content; permanent Finish intentionally does not
undo itself. No global content lock or publish-contract change is introduced. Concurrent
onboarding actions serialize on the row; no last-writer resume can resurrect a finished row.

## 4. Approved Postgres contract (P1, 2026-10-28)

`uploader/src/db.ts` adds this singleton operational table using the incumbent additive,
idempotent migration pattern. No row is seeded by `ensureSchema` itself.

```sql
CREATE TABLE IF NOT EXISTS onboarding_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  state text NOT NULL CHECK (state IN ('eligible', 'retired')),
  reason text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  dismissed_at timestamptz,
  retired_at timestamptz,
  CHECK (
    (state = 'eligible' AND reason = 'fresh' AND retired_at IS NULL)
    OR
    (state = 'retired' AND reason IN (
      'existing-schema', 'existing-accounts', 'existing-content',
      'existing-data', 'restored-content', 'finished'
    ) AND retired_at IS NOT NULL AND dismissed_at IS NULL)
  )
);
```

No foreign key to users, per-user rows, content identifiers, per-step flags, credentials or
progress counters. The boolean primary key/check allows at most one row. The store validates
runtime row values as well as relying on constraints; unknown versions or malformed shapes
are an operational error, not fresh state. Future versions require an explicit migration.
Timestamps are diagnostics only, never proof of installation identity, age or restore origin.

Concrete domain types (ISO timestamps at the store boundary):

```ts
type RetiredReason = 'existing-schema' | 'existing-accounts' | 'existing-content'
  | 'existing-data' | 'restored-content' | 'finished';
type OnboardingState =
  | { schemaVersion: 1; state: 'eligible'; reason: 'fresh'; evaluatedAt: string;
      dismissedAt: string | null; retiredAt: null }
  | { schemaVersion: 1; state: 'retired'; reason: RetiredReason; evaluatedAt: string;
      dismissedAt: null; retiredAt: string };
type OnboardingAction = 'dismiss' | 'resume' | 'finish';
type StepId = 'account' | 'identity' | 'photo' | 'story' | 'publish';
type StepState = 'done' | 'todo' | 'in_progress' | 'attention';
type OnboardingView = { status: 'retired' } | {
  status: 'open' | 'dismissed'; complete: boolean;
  steps: { id: StepId; state: StepState; required: boolean; href: string | null }[];
};
```

`null` from the store means “row absent”, not eligible. Only the guarded boot initializer may
insert `eligible/fresh`. All other insertions (restore reconciliation) are retired. All public
store transitions are eligible → eligible (dismiss/resume) or eligible → retired; there is no
reset/delete method. A valid retired row is retained, including its original retirement reason.
Actions use `SELECT ... FOR UPDATE`, validate, then update conditionally; dismiss/resume are
idempotent. Owner loss refuses mutations with `storage_read_only`. DB/commit failures use the
existing sanitized failure path; a lost acknowledgement is not success. Reload GET to reconcile
an uncertain action; no new receipt/retry framework is imported from #304.

### 4.1 Migration, backups and exclusion

- Add the table only; do not migrate the withdrawn, never-shipped `onboarding.json` proposal.
- Existing installs lacking a row are classified at boot (§5); schema migration must not insert
  an eligible default before classification or delete history before it is captured.
- Exclude `onboarding_state` from app-native dump SELECTs, `Dump.tables`, restore DELETE/INSERT
  lists, MDX exports, public loaders and builds. This feature alone requires **no dump version
  bump**. Dependency-owned dump revisions remain independent.
- Full `pg_dump`, physical/host backups and snapshots **can contain the table**, including an
  eligible row. Do not claim that exclusion from the JSON codec protects those restores.
- Native restore preserves the destination's retired row, even for v1/legacy/empty input.
  SQL restore may drop/replace it: the separate fence in §6 is authoritative until boot has
  re-applied retirement, and stays permanently afterward.
- Native undo sets intentionally cannot restore onboarding eligibility/dismissal. That is the
  approved conservative restore policy, not a loss of owner content.

## 5. Boot eligibility and failures

Before `ensureSchema` or other startup migrations/recovery can erase evidence, while holding
the existing app owner, capture whether any incumbent core table already existed and inspect
existing content signals that maintenance can prune (notably revisions, import jobs and route
cleanup). Reads use catalog existence checks so a truly empty DB is valid. Record the presence
of any prior core schema when no onboarding row exists. A half-finished initial migration on
restart therefore conservatively loses onboarding rather than being mistaken for fresh.

After the shared bootstrap-only schema/singleton initialization (§6.3), but **before** AI
migration/import recovery, listen, release bootstrap, backup housekeeping, media or route
reconciliation, read the fence (§6), then initialize or reconcile the onboarding singleton in
a REPEATABLE READ write transaction under the owner guard. The initial evidence capture above
precedes this initializer; approved default seeds are not owner saves or proof of prior use:

1. A durable restore fence always wins: insert/update to retired, never eligible. A valid
   already-retired row keeps its reason/timestamps. Do not evaluate freshness.
2. A valid present row without a fence is retained. A normal restart does not re-evaluate
   eligibility because that admin's own first upload/draft/release is now expected.
3. An absent row without a fence is eligible only if **all** checks below pass. Insert exactly
   once; conflict means re-read the committed row, never overwrite it with an eligible default.

Checks run in listed order; the first failing check supplies the reason. Pre-schema evidence
is combined with the post-migration snapshot, so cleanup cannot make an old install look new.

| Check | Disqualifying evidence | Reason |
|---|---|---|
| Accounts | Any users | `existing-accounts` |
| Content | Any posts, post revisions, post routes, route cleanup, media, media folders, comments, import jobs, app secrets, page revisions | `existing-content` |
| Pages | Any page outside About, or About title/body/images differing from the exact locale seed and empty image map | `existing-content` |
| Identity | #274 identity `saved_at IS NOT NULL`; a seed alone is not content | `existing-content` |
| Data | Configured settings path or its legacy migration backup exists; any image entry, backup entry, site entry (including current/partial releases), or non-structural entry in the private-route root | `existing-data` |
| Prior schema | Any incumbent core application table existed before this boot's schema initialization, but no onboarding row exists | `existing-schema` |

Disk paths use the same resolved `STORAGE_DIR`, settings path, backup root and site root as
their actual consumers, not hard-coded Docker-only alternatives. Read directory entries
lazily; stop at the first evidence, do not stat every photo. Private-route inspection permits
only the known empty directories created by `assertRoot`; files, symlinks or unexpected entries
are evidence. A traversal/read error is not “empty”. The optional new fence file is handled
separately, not accidentally counted as fresh-install data.

`evaluated_at` uses transaction time. Do not compare it with user/post creation times.
The read-only schema-history capture is solely a conservative initial exclusion signal, not
provenance. Installations on earlier versions that never completed setup remain excluded.

**Failure policy (P1):** if evidence cannot be read, row shape is invalid, migration fails,
ownership is lost, or the initial commit is uncertain, abort startup before listen/background
work. Do not serve a process-only eligible state, rely on bootstrap to disqualify next boot,
or quietly treat a DB outage as success. A later boot reads durable state anew. Preserve corrupt
metadata for diagnosis; operator repair may only retire, never reset to eligible. This changes
the old proposal's in-memory fallback and is part of approved P1, not already exercised
behaviour. Existing schema/ownership boot failures already abort startup; authentication
failures after boot remain sanitized failures rather than anonymous fallback.

## 6. Approved restore-persistence contract (P2, 2026-10-28)

### 6.1 Why Postgres retirement alone is insufficient

A whole SQL/physical restore can replace `onboarding_state` after a pre-restore UPDATE commits.
It can restore an eligible row, remove the table, or load an empty database. A later UPDATE is
also insufficient: a crash between replacement and that UPDATE exposes eligible state at the
next boot. Dump allow-lists, transaction timestamps, source-user timestamps, a Postgres
advisory lock and the native undo dump do not solve this persistence problem.

**Approved P2:** Postgres remains the only checklist state store, with one permanent, off-DB
**restore-retirement fence**, not a second progress/dismissal file. Preserve all supported
native, SQL and host-recovery routes with the mandatory protocol below. This material
storage/operations choice was approved separately from the original Postgres-design request.

A revised support-boundary design (for example, forbidding unmanaged SQL/physical recovery)
was not selected and cannot silently replace Q4 or approved P2. A purely Postgres row cannot
preserve Q4 across arbitrary database replacement. Departing from the approved fence/protocol
requires fresh explicit approval; implementation must not ship native-only restore coverage
or exempt SQL/host restores.

### 6.2 Fence format and lifetime

Approved path: `join(dirname(resolve(STORAGE_DIR)), 'onboarding.restore-retired')` (normally
`/data/onboarding.restore-retired`). Derived from existing config; no env knob, web download,
settings field or request-controlled path. Exact fixed payload: `swl-onboarding-restore-retired-v1\n`.
It contains no install identity, owner data, progress or dismissal. It means only “never enable
onboarding on this data root after restore admission”. It is **never removed**, including after
successful reconciliation, failed restore, undo, normal restart or an app rollback.

Publish once with a private `0600` temp file, file flush, atomic no-clobber publication and
parent-directory flush; use the incumbent durable/no-clobber backup publication pattern.
Validate the fixed regular, non-symlink, single-link final file before accepting an existing
fence and repeat durability checks on retry if an earlier flush/acknowledgement was uncertain.
A partial temporary alone is not proof of retirement; retry must publish/verify the final fence
before replacement. No replacement starts after a failed/uncertain fence write. Unknown content,
wrong type or read errors abort recovery and boot; preserve evidence for explicit operator
repair to a valid retired fence. Do not follow or silently replace malformed files.

The fence is a **durable retirement fact, not a maintenance lock or “restore complete” flag**.
It survives process exit but cannot prevent an operator starting the app mid-SQL restore. The
existing ownership/drain and stopped-writer procedure still apply (§6.5). Restoring a snapshot
of the entire machine can also overwrite the fence; the host procedure must preserve/re-establish
it before activating that restored tree (§6.4). No file can prove an unannounced whole-host rollback.

### 6.3 App-native JSON restore boundary

Keep existing input/archive validation, stopped app/drained sessions, confirmation and verified
pre-restore dump plus GPX undo archive. Add the retirement consequence to the scope summary.
After these succeed:

1. Reassert the existing restore owner and no app sessions; durably publish/verify the fence.
2. Commit a separate onboarding-only transaction that creates a missing table through the
   narrow idempotent onboarding schema migration if needed, then inserts/retires the singleton.
   A valid retired row remains unchanged. Require successful commit acknowledgement; on an
   unknown outcome stop, retaining the fence, and re-read on retry. Never put retirement in the
   transaction that replaces content.
3. Reassert ownership/drain and call the existing `restoreDatabase` with its guard. The fence
   and retirement commit must precede **GPX staging**, not just the first DELETE.
4. Preserve existing content transaction, session invalidation, source-retention/unknown-COMMIT
   handling, undo output, and explicit post-restore rebuild. Neither successful restoration nor
   failure/rollback clears the fence or re-enables onboarding.

Do not make the production path an optional unguarded call: the native CLI is the supported
entry point; #279 must ensure its replacement call cannot skip retirement. Tests of the lower
content codec are not an alternative operator entry point. No restore web endpoint is added.

**Fresh-cluster native restore:** the current CLI expects schema and the installed backup
codec's required singleton rows for live counts and its mandatory undo set. Do not start HTTP
to create them. Implement the approved offline CLI operation `prepare-native-restore`: validate configured
destination, acquire restore ownership, check stopped/drained writers, apply the bootstrap-only
admission check below, explicitly confirm retirement, and publish/verify the fence **first**.
Then invoke the **shared, idempotent bootstrap-only initializer used by normal boot**, retire
the onboarding row and exit. This initializer comprises `ensureSchema` **and** the installed
features' required singleton seeds, not `ensureSchema` alone:

- With mandatory dependency #274 installed, call its real `seedSiteIdentity(pool)` after schema
  creation, with the same approved bootstrap options/defaults as normal boot. Its insert is
  conflict-safe; a fresh target gets the approved neutral identity with `saved_at = NULL`, not
  an admin save. `ensureSchema` creates `site_identity` but does not insert this required row.
  An empty identity table is not a valid current-format backup and must not be papered over by
  relaxing `dumpDatabase`/`readDump` validation.
- When the installed language implementation requires `site_language`, invoke its approved
  idempotent default seed (DE-primary, DE+EN; no publication history means unlocked), using the
  same implementation/order as normal boot. No mode change or fabricated explicit choice.
- When the installed navigation implementation requires `site_nav`, invoke its approved
  conflict-safe default-document seed, plus the installed About schema/seed defaults. No
  author navigation edits, new pages or automatic publication beyond incumbent seed behaviour.
- Keep the installed codec's required singleton initializers and normal boot/offline callers
  together through one shared initialization boundary. Reuse the feature-owned seed functions;
  do not copy defaults into the restore CLI, assume future dependencies are already installed,
  or add placeholder language/navigation tables. Every subsequently installed required
  singleton must join that boundary and the prepared-target backup acceptance test.

The shared initializer runs **no HTTP listener, release build/bootstrap, background workers,
import/media/route recovery, housekeeping, settings writes or model migration**. It inserts
only incumbent bootstrap defaults, never demo stories or owner content, and does not overwrite
existing rows to force them to match. Reassert the owner between schema, seed and retirement
phases and before exit. Failure after fence publication leaves retirement durable and reports
preparation failure; retry remains offline and idempotent.

Preparation is not a general migration/repair bypass: before **any** initializer mutation,
inspect the target through catalog-aware reads and require either no application schema or a
partial/complete bootstrap-only schema. Content/accounts/operational tables must be empty;
required singleton rows may be absent (including a crash between schema and seeding), or match
the exact installed bootstrap values. Permit only incumbent About defaults, neutral unsaved
identity with no owner assets, default unlocked language/default navigation when installed,
and optional retired onboarding metadata. Compare semantic seed fields using feature-owned
defaults; generated timestamps are not evidence of an admin save. Unknown tables/shapes,
non-default/saved singleton values, owner content or uncertain inspection refuse preparation
without migrations/seeding. Never silently overwrite such values to pass admission.

This admits retry after a crashed empty-cluster preparation but never runs orphan cleanup over
a populated target without its normal verified recovery set. A populated target uses ordinary
guarded restore; an incomplete populated schema requires separately backed-up operator recovery,
not deletion or a “fresh” shortcut.

Run normal native restore afterward. Preparation success means initialization completed, **not**
that an undo set has already been created or proven restorable. The native restore must still
capture the actual prepared DB with the **installed** `dumpDatabase`, then pass that exact dump
through installed `readDump` and all required paired-archive/asset validators before reporting
a verified/restorable undo set or replacing content. §12 requires real acceptance evidence for
this capture/validation path, including the installed identity and applicable language/nav
singletons; table existence alone is insufficient. No native dump validation is weakened.

The two commands do not share a lifetime lease, so keep services stopped between them. A
successful preparation followed by cancellation or failure leaves onboarding retired
intentionally. This shared initialization/command procedure is part of approved P2, not a
claim that the baseline CLI can restore into an uninitialized schema.

### 6.4 `psql`, host recovery, partial restore and clone protocol

Implement the approved offline CLI operation `onboarding-retire` that validates the configured data root,
acquires the existing destination restore owner and checks drained app sessions, then durably
writes/verifies **only the fence**. It needs a reachable destination Postgres database for the
existing lease, but no application schema/tables. It exits nonzero on any guard or durability
failure. It does not run broad `ensureSchema` before a full SQL import, which would conflict
with the import's CREATE statements. Boot applies the row after SQL completes.

Required operator sequence, documented alongside both existing recovery paths:

1. Stop and wait for the app and all maintenance writers; disable service auto-start/restart
   during recovery. Verify normal source/undo material and the destination configuration.
   Postgres alone may run. The same offline obligation covers other processes using this
   storage through a different database/cluster, which the advisory lock cannot see.
2. Before **any** destination content replacement, publish/verify the destination fence via
   `onboarding-retire`. Gate subsequent restore commands on its success. No retirement failure
   may be followed by “try the SQL anyway”. This applies to empty/schema-only SQL, self-restore,
   table-selective restore excluding users, legacy SQL and rollback-to-undo.
3. Run `psql` with stop-on-error; keep app/other writers stopped across command boundaries and
   after any failure. Full SQL can overwrite the onboarding row but not this retained fence.
   If restoring a whole cluster requires stopping/replacing Postgres after retirement, the
   advisory lease will end; that is not continuing mutual exclusion. Stopped processes and
   disabled activation remain the explicit operator obligation.
4. For host/data recovery, never overwrite/delete the destination fence while copying snapshots.
   Exclude and preserve it when restoring in place. For a new/replaced data root, stage the
   restored tree offline, provision the same final fence in that tree **before any activation**,
   and verify it after the copy. Preserve the previous fenced root until cutover succeeds.
   Retirement must be established on the destination before replacement begins; if a staging
   copy would overwrite that marker, exclude it from the copy as well. A raw volume-image restore
   that cannot preserve the marker must use an isolated staging destination (not the live root),
   with app startup disabled, then establish/verify the fence before that root is selected.
   That staging-to-live switch is the replacement/activation boundary; no partially recovered
   tree is ever an eligible runnable destination.
5. Before restart, verify the final selected data root has the valid durable fence and recovery
   is complete or explicitly contained by the operator. Start the same configured app only
   after recovery writers have exited. Boot reconciles retired state **before listen**. Failed
   SQL/partial schema may prevent boot entirely; never manufacture successful content recovery.

A new host with an empty DB follows the same fence procedure using a reachable empty destination
database. A cold clone from a full backup is a restore even if it contains zero users/content or
an eligible row: fence its destination before activation. A filesystem-only recovery is also a
restore; it is not excused because Postgres rows are unchanged. Known-existing data without a
fence is conservatively excluded at boot, but this is not a substitute for the restore protocol.

Whole-machine rollback may roll back both DB and `/data` to an eligible snapshot. Automatic
startup of that snapshot **before** fencing is outside this supported procedure, not magically
detectable at boot. Operator recovery must mount/stage it without starting the app, retain
recovery evidence outside the replaced tree, and fence the final root before activation. This
explicit managed activation obligation, including disabled restart policies, is part of approved
P2. It preserves supported host restore, rather than declaring all restores
unsupported when a fence might be overwritten.

### 6.5 Actual guard lifecycle and crash boundaries

The baseline owner is a session advisory lock scoped to a Postgres database. Its heartbeat and
error/end handlers latch read-only and abort work; `close()` releases the connection. The CLI
checks `assertNoAppSessions()` using the `swl-app:` prefix; it does not detect arbitrary SQL or
other clusters. Native restore retains the lease through preparation/replacement and drains its
pool before closing. Do not weaken those checks or reconnect after loss. Check immediately
before each new side-effect phase and before content COMMIT; uncertain loss stops continuation.
Already durable retirement is retained even if a later guard fails.

The separate retirement CLI's lease ends on exit. It **does not fence the subsequent `psql`
process**, restart policy, physical restore or copied filesystem. Operator-enforced stopped
writers are required throughout; no new kernel lock is asserted here. #304's proposed native
filesystem ownership primitive is unapproved and is not a hidden prerequisite or delivered
capability of this design. If stronger automated exclusion is required, that is additional
owner-approved scope, not something a Postgres tombstone or `isWritable()` implements.

| Crash/failure boundary | Required outcome |
|---|---|
| Before admitted retirement (invalid input, declined ordinary restore, failed undo verification) | No content replacement; prior onboarding unchanged. Undo artifacts may exist. |
| Temp fence written but final publication/flush uncertain | No replacement; report failure. Retry validates/flushes final or safely publishes it. No eligibility claim based on temp. |
| Fence durable, before row commit or SQL starts | Retirement is permanent; restart reconciles it or fails closed before serving. |
| Row retirement commit uncertain | Abort native replacement; retain fence and re-read on retry. |
| Native/SQL replacement later fails, rolls back or is only partial | Fence persists; onboarding cannot reappear. Content recovery may still require undo. |
| Content COMMIT acknowledgement lost | Existing unknown-outcome/source-retention rules remain; onboarding remains retired regardless of content outcome. |
| Restore succeeds, crash before app boot | Fence survives; next boot retires even a SQL-restored eligible row. |
| Undo/older snapshot/self-restore or clone | Execute the same fence/activation protocol again; never restore eligibility. |
| Fence corrupt or unreadable | Boot/restore fail closed; preserve evidence, repair only to retired state. |
| App lease lost | Existing quiescence/read-only latch; no automatic re-acquire. Restart only after operator verifies recovery writers stopped. |

## 7. Behaviour matrix

| Situation | Result |
|---|---|
| Truly fresh DB (no prior core tables), empty configured storage, no fence | Insert eligible before first listen; existing `/setup` creates admin/session; Desk can display checklist. |
| Ordinary restart of eligible/hidden install | Retain row/dismissal; derive current progress, regardless of new content/release. |
| Upgrade with accounts, content, prior schema or old boot release | Retired; never retroactively start onboarding. |
| Zero users, populated `/data`, absent row | Retired for data/content/schema evidence; `/setup` still follows its unchanged zero-user rule. |
| Missing DB but eligible row lost, old `/data` retained | Conservative data exclusion; if recovered by any supported restore, fence also forces retirement. |
| Reset password or delete only users for documented account recovery | Row/fence unchanged; no restore exception needed. Retired stays retired, eligible remains eligible. |
| Empty/self/foreign/partial restore, rows newer than old evaluation, skewed clocks | All retired; no timestamp test, even if every content predicate looks fresh. |
| SQL restores an eligible row or drops onboarding table | Fence wins at boot; schema recreated then retired before serving. |
| `/data` copied with eligible SQL backup to new host | Cold clone/recovery protocol fences destination; no auto-start from the copied eligible state. |
| All onboarding metadata/DB/data intentionally erased or an unannounced old snapshot booted | Cannot infer prior existence from nothing. Not a reset feature or supported recovery shortcut; follow fenced recovery before activation. No owner data deletion is authorized. |

## 8. Approved onboarding route contract (no authn changes)

These are the approved #279 route requirements, not implemented by this design task.

**GET `/onboarding`:** `requireAdmin`, `Cache-Control: no-store`. Read the singleton after
authentication. Retired → `200 { "status": "retired" }`, with no progress reads. Eligible →
`OnboardingView` open/dismissed, derived as §3. Missing/invalid state at request time is an
operational error, not permission to initialize eligible or anonymous state. Reasons/timestamps
stay internal; no counts, names, titles, slugs, EXIF/GPS or user identifiers in the response.
Fixed server destinations only; encode the translation key. The optional identity step always
has `required: false`; Account also false; Photo/Story/Publish true.

Unlike the withdrawn file proposal, this design **does query Postgres for retired state** after
authentication. Do not retain the old “no additional onboarding queries” claim or implement an
unvalidated process cache. State/identity/progress/authentication DB failures return the existing
sanitized 500. The Desk uses its resilient loader's explicit Retry/unavailable presentation,
not an empty checklist or anonymous fallback.

**POST `/onboarding`:** `requireAdmin`, `bodyLimit: 1024`, `no-store`; strict object
`{ "action": "dismiss" | "resume" | "finish" }`, no extra keys. Unknown shape/value →
400 `invalid_onboarding_action`; retired → 409 `onboarding_retired`; incomplete required
predicates on Finish → 409 `onboarding_incomplete`; lost lease → 503 `storage_read_only`.
Success → 200 with the same view shape (retired for Finish). Atomic row/action rules are §3–4.
Handlers never mutate users/sessions/content, build, or set cookies. They do not take the
password/setup `limitAuth` budget. No new auth endpoint, token mechanism or CSRF policy.

Admin static markup remains unguarded as today; the state API is guarded. An author receives
403, anonymous caller 401. The Desk only requests onboarding after the approved protected-page
helper has resolved admin role; client role checks avoid useless requests, never authorize data.

## 9. First story, language and dependency gates

The first-story action opens the current new-post editor. First Save uses the existing post
endpoint, slug guard and validation. No pre-created pair, invented slug, tutorial mode or sample.
Language has no step until #281 lands after #284/#285 under the approved #282/#283 contract;
#281 must define its real completion signal and allowed changes. A seeded language default does
not prove explicit choice. Existing-install/changeability restrictions remain binding. #277
can close without #281.

#273 is approved; #274 must expose `identityConfigured() = saved_at IS NOT NULL` before #279.
Optionality is now settled by Q1; do not reopen it. #280 depends only on the inventory/roles,
not persistence or #279 runtime. Onboarding neither solves nor modifies the adjacent last-admin
race (#368) or origin contract (#319/#276).

The shared #304/#305 context proposal is `GET /auth/me` under `requireAuth`, `no-store`, returning
`{ authenticated: true, userId, username, isAdmin, needsSetup: false }`; the protected-page
helper would consume it, preserve role fields, redirect on 401 and retain other failures.
Login/setup would keep `/auth/status`. **That remains a separately unapproved dependency, not
an endpoint authorized here.** Land an independently approved shared helper before #279 uses
it; do not add a private duplicate or expand `/auth/status` to unblock onboarding.

Independent full specification review and P1/P2 owner approval are complete. Remaining
implementation order: land the approved identity and independently approved context
prerequisites; implement onboarding schema + boot + all restore integration/procedures together;
then enable the checklist only with the required implementation evidence. No partial shipping
of a checklist whose SQL/host restore retirement is only future work. #279 remains high risk.

## 10. Empty-state inventory for #280

This is the prior static investigation baseline, **not** successful build/browser evidence.
#280 owns empty migrated-DB `astro build` integration and real rendered verification.

| Public surface | Current zero-story output | #280 work |
|---|---|---|
| Home / `HomePage.astro` | No FeaturedHero; fallback heading/tagline; RegionFilter/MapTeaser gated; StoryGrid filter-miss copy | Distinguish first-use empty copy from a filter miss, DE/EN `ui.ts` keys. |
| Map / `MapPage.astro` | Zero stats, empty GeoJSON island, fallback with empty list | Localized empty message, no empty list; decide whether to suppress island, verify no broken map. |
| Region routes | `liveRegions([])` emits none | Preserve absence of orphan links. |
| Destinations index | RegionPage/StoryGrid empty state and zero stats | Same copy distinction as Home. |
| Story routes | None | Preserve. |
| About | Seeded About text | Identity/About work is separate; no automatic sample replacement. |
| RSS | Zero items [INFERENCE: renderer accepts them] | Verify empty feeds in build. |
| Sitemap | Static routes [INFERENCE] | Verify generated result. |
| Empty build | Expected to succeed [INFERENCE from bootstrap and empty branches] | Real build is required evidence, not this table. |

| Admin surface | Current baseline | #280 work |
|---|---|---|
| Desk | “No draft pairs are saved…” and New trip; idle photo queue; View live site after bootstrap | Accessible empty status; admin-only checklist above ordinary sections. |
| Posts | “No posts yet.” cell | New trip CTA available to authors. |
| Media | “No photos here yet.” | Point at upload control, available to authors. |
| Comments | “No pending comments.”; comments default off | Admin-only explanation of publish/enable prerequisites. |
| Users / Import | First admin exists / import form exists | No invented empty state needed. |

Empty states appear on eligible and retired installs. Authors get only actions their role can
perform (New trip, upload), never identity/settings/Publish/admin moderation CTAs. Checklist
is admin-only, not a reduced author checklist with a second dismissal scope.

## 11. Trust boundaries, invariants and misuse cases

Boundaries: anonymous → unchanged auth/setup; authenticated author → ordinary Desk but no
onboarding API; admin → validated onboarding actions; trusted offline operator → recovery
configuration/data root; Postgres restores → replaceable metadata; off-DB fence → mandatory
retirement. Files and SQL rows are validated even though only trusted operators manage recovery.

| Misuse/failure | Required defence / future regression proof |
|---|---|
| Anonymous learns onboarding status or races setup | 401 for GET/POST; exact unchanged `/auth/status` keys, zero-user gate, setup lock/limiter tests. |
| Author reads/dismisses checklist | 403 and no state write; role-safe author empty states. |
| Action creates users/session/content | Strict action schema, no write-store/builder calls, no Set-Cookie; all content/account stores unchanged. |
| Resume races Finish | Row lock + conditional monotonic transition; retired action 409; never resurrect. |
| Optional identity accidentally gates completion | Required set exactly Photo/Story/Publish in GET, Finish and UI; finish with seeded identity test. |
| Malicious key/title reaches markup | Return fixed ids/enums and encoded server-built href; use textContent; never return titles/slugs/photo metadata. |
| Freshness query runs after cleanup or first setup | Capture history before migration/recovery; finalize before listen; real boot ordering test. |
| Old/empty/self/partial SQL resurrects eligible state | Fence-before-replacement and boot precedence, not app-dump exclusion or timestamp inference. |
| Host copy overwrites retirement | Preserve/exclude destination fence or fence staged root before activation; no auto-start restored snapshot. |
| Retired state bypasses auth during DB outage | `requireAdmin` always runs first; sanitized 500, never anonymous/200 fallback. |
| Guard expires between retirement and restore | Abort native continuation; offline SQL procedure keeps stopped writers; do not claim CLI lease persists after exit. |
| Read error/malformed row/file looks empty | Fail boot/recovery closed, preserve evidence; repair only to retired. |

Invariants:

1. No onboarding handler changes users, sessions, posts, pages, media, comments or releases.
   Offline preparation uses only shared incumbent schema/default-singleton initialization,
   after bootstrap-only admission; no automatic owner content or overwritten singleton edits.
2. Authentication/setup contracts and public responses remain unchanged. State is admin-only,
   absent from public build, `/health`, auth status and unauthenticated responses.
3. Application transitions never make retired eligible. Restore/undo cannot restore eligibility
   under the approved protocol; resetting/removing metadata is not an offered recovery command.
4. Step state is current-data-derived; Finish requires only the three approved required steps.
5. Every supported restore retires durably before replacement/activation, including self/empty/
   partial/failed restores. Off-DB fence survives rollback; copied snapshots are fenced offline.
6. Retirement changes only onboarding metadata; it does not repair, delete or certify restored
   owner content. Existing verified undo and unknown-outcome rules remain binding.

## 12. Acceptance and verification plan (implementation only)

No implementation verification was executed for this design-only assignment. #279 must supply:

- Unit/store parity: constrained row decoding, missing vs invalid, all monotonic transitions,
  duplicate actions, exact action/response shapes, optional identity, each photo state and
  progress regression; no user/content/build side effects; href escaping and role denial.
- Real Postgres boot: fresh DB and exact seeds; every exclusion predicate; preexisting empty
  schema; history pruned by migrations/recovery; zero users with old storage; before-listen
  latch; initial transaction/ownership/read/commit failures; hidden state across process restart
  and a second admin/browser. No eligibility from an unknown/missing runtime row.
- Real DB concurrency: concurrent Finish/resume, predicates rechecked server-side in one
  snapshot, post-snapshot regressions behave as specified, DB failure remains a failure.
- Native restore rehearsal: regular, self, empty, legacy and foreign timestamps; offline
  fresh-cluster preparation; cancellation before retirement; fence/row failure prevents **all**
  staging/replacement; later failure and undo retain retirement and owner recovery material.
  Prove on a real empty target that shared preparation seeds #274's required identity and every
  applicable installed language/navigation singleton without HTTP/build/workers. Capture its
  actual DB using installed `dumpDatabase`, read that output with installed `readDump`, and
  validate all required paired archives/assets; only then call the undo set restorable. Include
  crashes after schema creation/between seeds, safe retries with missing/default seed rows,
  and refusal of saved/non-default singleton rows without overwriting them. Keep the installed
  codec's missing-singleton rejection tests: no schema-only mock or loosened validation counts.
- Real `pg_dump`/`psql`: a dump **containing an eligible onboarding row**, table-drop/recreate,
  empty input and partial input excluding users; stop after replacement but before boot/row
  reconciliation and prove the next app cannot serve eligible state. A test that merely omits
  onboarding from the native dump is insufficient.
- Host/clone rehearsal: restored eligible DB plus copied `/data`, in-place fence exclusion,
  staged root activation, disabled auto-start, whole-root snapshot rollback with re-fencing;
  preserve original data and undo artifacts. Explicitly demonstrate the procedure, not an
  assertion that a marker outside the DB survives every filesystem restore.
- Fault injection at every §6.5 boundary: file and directory flush, uncertain commit, process
  death, corrupted marker/row, lease loss, live/draining app refusal. Show the separate retire
  command releases its lease; external SQL safety depends on the documented stopped interval.
- Full affected uploader suites, `tsc --noEmit`, relevant site suites/`astro check`, plus real
  browser setup → upload → draft → publish → Finish **without setting identity**; separate
  optional-identity visit, Hide/Show across sessions, keyboard/focus/320px/status accessibility.
  #280 separately verifies real zero-content builds/rendering.

Implementation documentation must update `ARCHITECTURE.md` (schema, fence/data layout, boot,
JSON restore, offline schema preparation, SQL/host/clone recovery and rollback), `SECURITY.md`
(admin-only metadata, unchanged setup/auth, actual lease limits), `DESIGN.md` (incumbent Desk
checklist/optional identity) and `CLAUDE.md` status. Fix the contradictory live-app native
major-upgrade example; do not leave two mutually incompatible recovery procedures.

## 13. Compatibility, rollback and containment

The table is additive and ignored by old binaries. Preserve it and the fence when rolling back
application code. Older code does not enforce the fence or new recovery procedure: keep the
current offline retirement tool/procedure available before any older native/SQL/host restore,
then recheck the selected root before rolling forward. Never promise mixed-version recovery
is automatically fenced. Existing dependency-owned roll-forward-only dump codec requirements
remain; this feature itself adds no dump codec.

An eligible admin may Hide or explicitly Finish when required steps are complete. An operator
can retire offline. There is no web/CLI reset, `.env` kill switch or recommendation to delete
metadata/content. Invalid metadata is retained for diagnosis; repair to retired under stopped
writers, not to a guessed fresh installation. Recovery cannot depend on successful app boot:
the fence-only command works without application tables, while reachable Postgres remains
required for its actual existing ownership guard.

Security reconfirmation: `SECURITY.md` First-admin setup's zero-user gate and per-process lock,
Rate limiting's login/setup budgets and HttpOnly/SameSite session policy remain unchanged.
“Content-side-effect free” does not mean no metadata writes: explicit onboarding state/fence
writes and offline schema preparation are documented approved design boundaries, not delivered code.

## 14. Approval record and remaining implementation gates

Owner record **2026-10-28**, `owner-onboarding-decisions-2026-10-28.json`:

- **Q1 APPROVED:** Identity optional for Finish; Photo, Story and Publish required.
- **Q2 REQUEST FULFILLED:** the requested Postgres redesign is approved through P1/P2 below.
  The withdrawn file-based checklist-state design was not approved.
- **Q3 APPROVED:** install-wide Hide, Desk-only Show, explicit permanent Finish.
- **Q4 APPROVED:** conservative exclusion and retirement before **every** supported restore,
  including self-restores and admitted operations that later fail; persistence failure prevents
  replacement. The approved Postgres/fence protocol preserves this guarantee.
- **Q5 APPROVED:** admin-only checklist and role-safe author empty states.

Subsequent owner record **2026-10-28**, `issue-278-postgres-owner-decision.json`, approves the
corrected **685-line contract** after ReviewOnboardingWrites' clean independent full re-review:

- **P1 APPROVED — “Approve Postgres contract”:** the constrained singleton, derived
  transaction-consistent progress, native-backup exclusion, pre-migration history capture,
  conservative prior-schema exclusion and abort-before-listen initialization policy (§4–5).
- **P2 APPROVED — “Approve permanent off-DB retirement marker and managed restore protocol”:**
  the minimal permanent fence alongside Postgres checklist state; durable pre-staging native
  integration; offline `prepare-native-restore` through shared installed schema/singleton
  initialization; the actually validated prepared-target backup path; fence-only
  `onboarding-retire`; and mandatory SQL/host/clone stop–fence–restore–verify–activate procedures.
  Approval includes preservation/exclusion or re-fencing of restored roots before activation,
  disabled automatic startup across physical recovery, actual advisory-lock limitations and
  the unannounced-snapshot support boundary (§6).

Q1/Q3/Q4/Q5 remain settled. #278's owner-approval acceptance is satisfied; no new onboarding
policy decision is outstanding for this contract. #304 remains separately unapproved, and its
shared context cannot be introduced on the strength of this approval. Required dependency
integration, code, automated tests, real Postgres/restore/fault-injection/browser evidence and
implementation review remain outstanding as specified in §9 and §12. Design approval is not
a claim that #279 is implemented, verified or ready to enable.

These decisions authorize the documented design for implementation subject to those gates,
not a merge, deployment, owner-data operation, login/session-policy change or revival of the
withdrawn file-based progress design. Any material departure requires fresh explicit approval.
