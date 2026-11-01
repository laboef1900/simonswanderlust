# #298 — Upgrade and rollback guidance limited to evidenced, secure release pairs

Date: 2026-10-27. Risk: **High-area documentation — upgrades and destructive recovery.**
Status: **OWNER APPROVED, 2026-10-28 — runbook/checklist implemented; the unpublished, exact DHI candidate pair completed bounded upgrade/roll-forward qualification on 2026-10-29 after the initial storage blocker.** Policy is immediately-previous security-supported, rehearsed pair only; the historical downgrade criterion was amended as recorded below. This candidate evidence establishes neither a published support pair nor an eligible downgrade. No production operation is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`. Native dependency: **#295, supplied and integrated for the bounded candidate attempt below**. Coordinate #296 inventory/settings decision, #398 offline restore, and the already-approved **#347 roll-forward-only codec fix**.

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

The authorized disposable exercise below supplies candidate-specific runtime evidence, not a
release support matrix. Remaining release/deployment gates are the published immutable pair,
current security-floor decision including the deferred tooling paths, fresh release packaging,
and the actual target VPS proxy topology. No eligible backward pair exists; that direction
remains unsupported, not permission to run the historical downgrade.

### Initial bounded candidate attempt — blocked before application runtime

The parent integrated final #295 and #369 before freezing the following unpublished pair:

| Role | Exact source | Local qualification image tag |
| --- | --- | --- |
| Source | `8afd0c8e6917e2f1cc668fc7ff35c11e7e9744ae` (#369) | `swl-issue298-source:1793275472` |
| Target | `945c08d36a7d9fdbeab481bdd14bcbe26463acd1` (#298 with both prerequisites) | `swl-issue298-target:1793275472` |

Both native `linux/arm64` builds completed dependency-install and source-copy stages, then
failed during image unpack with Docker Desktop containerd reporting a **read-only file
system** while writing `map-assets/basemap.pmtiles`. Emitted build manifests are not evidence
of successfully loaded images or running codec versions. The retained qualification recipe
uses copied, previously retained synthetic map assets; it does not qualify fresh map packaging.

Read-only comparison found byte-identical schema, settings implementation, Compose and proxy
trust code. Both source contracts write dump v10 and admit versions 1–10. The runtime delta
is the #295 backup/restore corrections and two i18n strings, not a schema/settings migration.
Both locks select sharp 0.35.5, the arm64 libvips package 1.3.4, Fastify 5.12.7,
`@fastify/static` 10.1.8 and Astro 7.4.2. These are source facts, not exercised upgrades.

The lock-only audit returned zero uploader production findings. The full site audit returned
one high and two moderate findings on #369's explicitly deferred paths: test-only happy-dom
20.11.1 (GHSA-834v-8h66-3h79, plus GHSA-c8p4-j97h-3vg8 and GHSA-5fpq-26gf-qwcr), and
typography 0.5.20 → postcss-selector-parser 6.0.10 (GHSA-rj75-hqrm-r3gf; repository-owned
selectors). Site devDependencies ship in the runtime image; this is not a blanket
security-supported-release claim. No audit fix or dependency change was applied.

The fresh isolated database container `swl2981793275472-db-1` started, but **no application,
seed, backup, restore, TLS proxy or browser exercise ran**. Its stop request subsequently
timed out after 15 seconds; it may remain running. `docker info` timed out after 30 seconds,
and host free capacity measured 116,854,784 bytes. No restart, prune, image/volume deletion
or owner-stack operation was attempted. All synthetic preparation, private generated
credentials, database files, build contexts and logs remain under this issue's
`.issue-runtime/rehearsal-1793275472/`; no active #295 data was reused.

Canonical non-secret evidence is retained in
`.local/backlog-execution-2026-10-27/issue-298-runtime/` in the main checkout:
`proof.json`, `build-inputs.json`, `build-results.json`, both image-build logs,
`dependency-audit.json`, `infrastructure-blocker.json` and `integration-proposal.json`.
The proposal records the prerequisite integration request; the exact pair above records its
subsequent completion. The initial blocker required separately authorized recovery of host
capacity and Docker daemon responsiveness **without discarding retained data**. The resumed
exercise below supersedes that runtime blocker; this paragraph preserves the failed attempt's
provenance rather than presenting it as a successful drill.

### Resumed exact DHI candidate qualification — 2026-10-29

Both retained DHI builds resumed successfully with their original resolved base digests:
`dhi.io/node:26-dev@sha256:fed7352d6abaed0e0b9172bef3dbb2437c135de1f68fef70b2a8a818b2568fa5`
and `dhi.io/node:26@sha256:57a27f9e03b0bef98d39da2860fb0bd6b785a72a58f756f88ef2634ac7526343`.
Their dependency-install and source-copy stages were cached; image unpack completed.
No frozen product source was changed. Capacity was checked before each heavy stage and
remained above the 10 GiB stop threshold. No daemon restart, prune, image/volume deletion,
owner-stack change or operation against the parent's independent Postgres was performed.

| Role | Frozen source | Observed local image identity (`linux/arm64`) |
| --- | --- | --- |
| Source | `8afd0c8e6917e2f1cc668fc7ff35c11e7e9744ae` | `sha256:f3fe6fea3468982cdd86b527b6832e549e99fde0b643257c2232494e33686ba9` |
| Target | `945c08d36a7d9fdbeab481bdd14bcbe26463acd1` | `sha256:db41a7c0bc1c8927e9403f03b8542a33f8bdc8c94ca7260445368f78f01b81b6` |

The first resumed command mistakenly supplied plain `node:26-slim` overrides. Those images
and their results are retained as **diagnostic-only** in `plain-node-supplemental-proof.json`;
they do not satisfy the DHI gate. The exact DHI pair was subsequently exercised end to end
against the retained owned synthetic fixture, without reseeding or touching owner data.
`dhi-proof.json` and `dhi-restore.log` are the authoritative resumed runtime evidence.

Observed DHI results:

- The old DHI app captured a complete v10 recovery set under an isolated operator write
  freeze (loopback ingress, worker-controlled synthetic credentials, scheduled backups off).
  Settings, bootstrap/key association and recovery archives were retained together in
  `dhi-source-generation/`. The route archive's byte count and SHA-256 matched its manifest.
- The target boot preserved schema, settings bytes, media files and counts: **2 users,
  2 locale posts, 2 locale pages, 2 media rows, 2 media folders, 4 comments, 1 private route
  and 1 encrypted secret**. The synthetic credential decrypted with its matching retained key.
  Both applications accept the `asia` region; both locale region pages rendered the story.
- A target-era pending comment increased the count to five. After stopping the app and
  observing zero remaining database sessions, the one-shot target CLI restored
  `db-20261029-130756.json.gz`. It first verified undo set
  `db-20261029-130826.json.gz`, then restored the four-comment source generation. This
  demonstrates the explicitly scoped loss of that one post-backup synthetic write; it is
  not a reverse schema migration. The undo set was validated, not itself replayed.
- The full retained image chain (two archives) was extracted oldest-first into a fresh
  directory, preserving earlier trees. All **14 originals/variants** matched source hashes.
  Restored settings were byte-identical; source and restored schema hashes and counts
  matched. Private GPX download bytes matched the source digest. Rescan found two photos,
  with no missing, demoted or requeued rows.
- Explicit target rebuild returned HTTP 200 with release `1793279320609-1-0000` and
  changed the current release symlink. Managed-browser evidence covers the German desktop
  story, English mobile story, both loaded gallery photos, next/close lightbox interaction,
  approved reader comment/author reply, hidden pending comments and a new browser submission
  saved as pending with its translated confirmation. Screenshots are retained as
  `dhi-de-desktop-story.png`, `dhi-en-mobile-gallery.png`,
  `dhi-en-mobile-lightbox.png` and `dhi-de-comment-pending.png`.
- TLS login emitted a Secure cookie. A client exhausted its ten-attempt IP budget, while
  a distinct fixed-IP client still logged in successfully. Direct untrusted forwarding
  headers did not create a Secure cookie or evade that client's limiter. Same-origin GPX
  mutation passed the Origin check and reached payload validation (400); foreign/spoofed
  Origin attempts returned 403. Anonymous private GPX returned 401; both image originals
  returned 404 on the configured image host while AVIF/WebP variants returned 200.
- Loaded target versions were Node **26.13.0**, sharp **0.35.5**, libvips **8.18.7**.
  The existing audit qualification remains unchanged: uploader production **0** findings;
  site full audit **1 high, 2 moderate** on the named deferred paths above. No blanket
  security-support claim is made.

**Topology and packaging limits:** Docker Desktop used a VM-host-network TLS proxy connecting
to the app's bridge IP, with raw TCP adapters exposing it to the managed browser. Fixed,
distinct bridge client addresses made limiter isolation observable. This is not the target
VPS host-proxy → published-loopback topology; that topology still needs its own pre-cutover
proof. An initial short-lived-client attempt reused an address and is explicitly invalid
isolation evidence. Shared-browser captures stalled; a dedicated managed profile resolved
capture and lazy-image proof. Map paint/fresh basemap packaging was not qualified: the
retained map fixture remains inherited. These local images are not published releases.
Backward recovery remains **unsupported/pending**; no historical vulnerable image ran.
The integrated source then passed uploader TypeScript, the complete uploader suite against
a separate isolated integration database, site tests, Astro check and a real Astro build
(`wave-two-results-1793280743462_58384.json` in the private execution ledger). These local
checks do not extend the candidate/image/topology scope above. Fresh actual-PR review,
exact-head required CI and eventual stack retarget/requalification remain separate gates.
