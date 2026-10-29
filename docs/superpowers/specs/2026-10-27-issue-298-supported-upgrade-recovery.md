# #298 — Upgrade and rollback guidance limited to evidenced, secure release pairs

Date: 2026-10-27. Risk: **High-area documentation — upgrades and destructive recovery.**
Status: **OWNER APPROVED, 2026-10-28 — runbook/checklist documentation implemented; disposable upgrade/roll-forward evidence pending.** Policy is immediately-previous security-supported, rehearsed pair only; the historical downgrade criterion was amended as recorded below. No eligible rollback pair or successful upgrade rehearsal is established by approval or documentation. No production operation is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`. Native dependency: **#295, independent and pending**. Coordinate #296 inventory/settings decision, #398 offline restore, and the already-approved **#347 roll-forward-only codec fix**.

## Facts, not a tested support matrix

- README and Compose at this baseline identify app `0.17.1`; current `backup.ts` writes **v10** and `readDump` allows **1–10**. That allow-list is input-format admission, not proof of complete downgrade fidelity or a tested release pair. v10 restores private routes and matched private originals; v1–v9 cannot supply that material.
- `ensureSchema` (`uploader/src/db.ts:75ff,324ff,460–489`) runs forward/idempotent schema work at boot. An app-native content restore is not a reverse DDL migration. A lower tag over an already migrated database is not inherently safe, even when dump versions match.
- `settings.ts` preserves a no-clobber `.pre-ai-registry` file during the registry migration; it is not a generic snapshot of every subsequent upgrade. Settings are outside the DB dump.
- README's pre-v0.15.0 notes and the two 2026-10-19 specs require restoring pre-registry settings and the matching old credentials dump. The region spec says the old loader rejects newly introduced regions. The registry spec's historical “v6” example and #298's v9 release example are not a current compatibility guarantee; actual image/dump metadata must decide.
- #347 explicitly approves sharp 0.35.5, libvips package 1.3.4 and the required runtime dependency update, **roll forward only**. Retaining an old image digest for evidence is not authorization to run vulnerable codecs. Boot/rescan can decode stored originals, so turning off uploads does not make such a downgrade safe.

## Approved support policy and acceptance amendment

**Approved 2026-10-28:** a rollback is eligible only to the **immediately preceding published release**, and only when that exact source/target image pair has compatible, release-specific recovery instructions and disposable evidence, and both comply with current security floors. Otherwise recovery is roll-forward. No arbitrary older version, automatic rollback, time-based support promise or Postgres-major downgrade is offered.

No eligible pair is established here. The first security-fixed release may have **no** eligible predecessor; #347 remains roll-forward-only regardless of this general window. Release notes must say so explicitly rather than imply that “previous tag” is always supported.

The original issue requested a v0.14.1 → v0.15.0 → v0.14.1 rehearsal. The owner **approved amending that criterion on 2026-10-28**: those historical tags do not authorize a return to vulnerable codecs. Preserve the migration lesson as historical documentation; exercise supported upgrade/roll-forward recovery and mark backward qualification unsupported/pending until an eligible pair exists. Do not silently substitute another pair and claim the historical drill ran. Approval of #347 or this amendment does not waive #298's applicable evidence requirement.

## Upgrade runbook contract

Add one canonical runbook to existing `ARCHITECTURE.md`, linked from README Backups/release notes; do not create a second operational procedure in a new guide.

1. Read the target release's notes before pulling/starting it: schema and settings migrations, dump reader/writer versions, image/archive capacity changes, required explicit rebuild and security/rollback restriction. Record both immutable image digests and platform; tags alone are insufficient evidence of the binaries used.
2. **Freeze new content/settings/media/public mutations and scheduled/storage writers before taking the recovery point**, then drain already-admitted operations and resolve known partial failures. Maintain that operational freeze through capture of the dump, settings, bootstrap/key-generation association and image material, as specified in #296. Do not mix a pre-change credential snapshot with post-change provider settings.
3. Establish the recovery point on the **old app** while the freeze remains in force. Backups default off: use the designated existing backup control to trigger a fresh backup, inspect success/degraded state and verify the dump and manifest-paired private route archive. Retain full image recovery material, current configured `settings.json`, any migration copy and bootstrap configuration/separate matching key escrow per #296. Copy settings before upgrade even if an old `.pre-ai-registry` file exists. The #296 decision approved on 2026-10-28 is **operator-managed settings/configuration coverage**, not native settings snapshots. Do not proceed with incomplete capture or insufficient capacity; never delete recovery history blindly to make space.
4. Apply the reviewed target release's **Compose/bootstrap changes as well as its immutable image selection** before startup, preserving the old configuration with its recovery generation. For #369's approved host-TLS-proxy/bridge topology, this includes the literal `TRUSTED_PROXY: docker-gateway` in Compose; omitted mode is intentionally loopback-only and is not a compatible host-proxy upgrade. Preserve fail-closed gateway discovery; no `.env` workaround or broadened trust. Then use the existing pull/up flow for the app only, leaving the database unchanged. This is a separately authorized operator step, not performed by documentation approval. Do not combine an app upgrade with a Postgres-major change.
5. Check actual image identity, successful schema/startup, `/health` database/storage ownership and release availability, then admin access and a known story/image. Rehearse HTTPS Secure-cookie behavior, independent client-IP limiter isolation, spoofed forwarded-header rejection and GPX Origin checks through the actual approved proxy topology. Health's `release` boolean proves only that a static release exists; it does not prove a new build succeeded or that new content is live. Consult #297's outcome contract if implemented, otherwise the explicit build response/logs.
6. Rebuild only when the release notes require it or the owner deliberately requests it. Deploying an image does not rebuild the persisted static site and must not silently publish pending rendered changes. Verify the returned outcome and expected page after the rebuild; use #397's corrected promotion semantics once landed.

## Release-specific rollback/recovery contract

Every candidate pair needs an explicit row recording: source/target app tags **and digests/platform**, forward schema/settings changes, source dump writer and target reader versions, private-route/image recovery requirements, key/settings association, allowed recovery direction, expected data-loss window and rehearsal evidence. Unknown is **unsupported**, not a guessed green matrix cell.

When backward recovery is allowed by that release's notes:

- Stop all app/storage writers and block ingress as required. Follow #398's one-shot offline restore procedure; never `compose exec` into the live app, bypass storage ownership, skip confirmation, or skip the verified pre-restore undo set.
- Restore the **old-version pre-upgrade dump** and matching old settings/configuration into the precise target schema named by the notes. Prefer a separately initialized target database/data copy when the old code cannot safely operate the migrated schema; preserve the original database and files. This document authorizes neither provisioning nor volume deletion. A content dump cannot be presented as a reverse schema migration.
- Keep image originals/variants and all required GPX recovery material. Older code may not understand newer private-route state or new encoding profiles. Do not feed a newer dump to an older reader merely because JSON parses. Do not promise that a downgrade preserves post-upgrade writes.
- Present the cutback scope and expected loss of post-backup edits before confirmation. No automatic content rewriting, region reassignment or slug change is authorized. If newer content cannot be represented, keep the current security-supported image and roll forward unless the owner approves a specific recovery/data decision.
- Restart only on confirmed restore success, explicitly rebuild under the supported target, and verify counts, settings bytes, routes, images and rendered content. A failure/unknown commit outcome preserves all source and undo sets; do not repeat destructively without diagnosis.

### Historical v0.15.0 note to correct, not permission to deploy it

Write the missing historical note in README's release section: matching pre-deploy dump plus pre-upgrade settings (or verified matching `settings.json.pre-ai-registry`) are required to restore the legacy registry/key arrangement; a post-upgrade dump with an unchanged version does not undo registry migration. Every retained story must have a region accepted by the old renderer. The old region spec suggested reassignment, but this issue cannot perform or prescribe an automatic owner-content change: a pre-upgrade snapshot may remove the offending new values at the cost of losing later edits, otherwise staying on a compatible secure release is the safe choice. Any historical synthetic region-reassignment exercise is evidence only if actually authorized and executed; none is claimed here. Label the old tags historical, not current security-supported rollback targets.

## Release checklist addition

A release is not ready to tag until its notes state:

- schema/constraint/data migrations (including “none”), settings-file migrations and retained backup copies;
- dump writer version, accepted reader versions and fidelity exclusions (especially private routes/older formats);
- all recovery material and free-space requirements;
- whether an explicit rebuild is needed, without treating deploy as publish;
- the exact allowed previous secure image/recovery procedure **or “roll-forward only; no supported downgrade”**;
- per-release restore steps, not just “previous tag + dump + settings”; actual rehearsal evidence or an explicit unsupported direction.

Link the existing Postgres-major section, corrected by #398/#295, rather than duplicating it. No instruction may authorize deleting `pgdata` or `uploader/data` without verified backups and explicit owner authorization; an app-version rollback never implies a Postgres cluster downgrade.

## Files, security and verification

Implementation scope is existing `README.md` release/Backups sections and `ARCHITECTURE.md` upgrade/recovery/release sections. Reconfirm `SECURITY.md` Backups/Secrets, storage ownership and the #347 codec floor; add a concise rollback-security cross-reference where needed. No runtime API, migration framework, retry, deployment automation or schema change.

#295 supplies the isolated restore foundation, not proof of this upgrade pair. After approval, record the actual eligible forward/backward (or explicitly roll-forward-only) rehearsal: digests, dump metadata, pre/post counts, private-route/archive integrity, byte-identical restored settings (report equality, never contents), acceptable regions, rescan and rendered page checks. Use synthetic content/credentials; retain evidence without secrets. Do not add tests that assert documentation wording. No tested matrix, successful drill, current infrastructure or deployment is claimed.

## Exact owner decisions and containment

1. **Approved 2026-10-28:** immediately-previous **security-supported and rehearsed pair only**, with roll-forward as the default when any prerequisite is missing; #347's prohibition is immutable here.
2. **Approved 2026-10-28:** amend the historical v0.14.1/v0.15.0 rehearsal criterion to the supported upgrade/roll-forward scope above. The historical vulnerable downgrade is not executable acceptance; backward qualification remains unsupported/pending until an eligible pair exists.
3. **Approved 2026-10-28:** documented backup/settings/offline-restore safety and per-release checklist. This is not permission for any production restore, data loss, region reassignment or purchase.

Owner decision recorded 2026-10-28: **Approve policy and criterion amendment.** The named vulnerable historical downgrade is not an executable acceptance requirement. Exercise supported upgrade/roll-forward recovery; explicitly report backward recovery as unsupported/pending until an eligible pair exists. This does not permit claiming a rehearsal that did not run or weakening #347's security floor.

Containment is to preserve existing data/recovery sets and repair forward on a secure image. A runbook defect is corrected in docs; it is never an excuse to roll back codecs, clear volumes, remove GPX originals or relax restore admission. Actual recovery requires the release-specific procedure and operator authorization.

## Documentation implementation and remaining evidence — 2026-10-29

- `ARCHITECTURE.md` now owns the canonical app-upgrade runbook, coherent-generation inventory,
  restricted backward admission and release checklist. The existing Postgres-major procedure
  remains separate; its legacy volume-removal example is explicitly gated on a verified isolated
  restore and owner authorization for that exact volume.
- `README.md` links the runbook/checklist and records the historical v0.15.0 settings/key and
  region constraints without prescribing content mutation or authorizing old vulnerable tags.
  `SECURITY.md` reconfirms key/settings association, private originals, storage ownership,
  verified undo sets and the non-negotiable codec floor.
- #296's approved operator-managed decision was cross-checked; no settings snapshot feature,
  runtime change, test, command execution or upgrade/recovery success is claimed by this work.
  The deployment instructions require the actual target release's matching proxy-trust runtime
  and Compose changes; the older checkout's hop-count/Compose setup is not proof of #369.

Still required from the integrator's authorized disposable exercise: exact source/target tags,
digests and platforms; dump writer/reader metadata and pre/post counts; freeze/drain and coherent
generation evidence; manifest-paired private-route integrity and image-chain recovery/rescan;
byte-identical restored settings reported without contents and matching synthetic key recovery;
accepted regions, explicit rebuild/promotion outcome and rendered story/gallery/comments;
and actual host-TLS-proxy Secure-cookie, client-IP isolation, forwarded-spoof rejection and GPX
Origin checks for that target topology. #295's restore foundation is a prerequisite, not proof
of this release-pair upgrade. Its runtime dependency correction and resulting evidence must be
supplied before any success claim. No eligible backward pair exists; that direction remains
unsupported, not a passed rehearsal or permission to run the historical downgrade.
