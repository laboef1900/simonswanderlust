# #296 — Complete recovery inventory, offsite copies and separate key escrow

Date: 2026-10-27. Risk: **High — backups, private location data and keys.**
Status: **OWNER APPROVED, 2026-10-28 — inventory/UI/docs implemented; offsite recovery evidence blocked.** The owner selected operator-managed settings/configuration coverage, 14 completed daily offsite generations and an existing encrypted backup system. Its tool, non-secret destination identifier and independent escrow/recovery method are still required before the offsite-only drill. No purchase, production operation or owner-data transfer is authorized. Reachable implementation and synthetic browser evidence are recorded below; actual restore acceptance remains required.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`. Native dependency: **#295, independent and pending**. Related: #399 archive classification; #398 offline restore instructions; #298 upgrade generations.

## Current facts

The existing Settings warning correctly says backups share the server disk. `GET /backups` (`uploader/src/server.ts:1993–2000`) returns run state, file lists, image archives, private route archives and cleanup status; it does not expose settings or bootstrap secrets. `backup.ts` wrote **v10** at this baseline (accepting v1–v10); on the 2026-11-01 integration base it writes **v14**, accepting v1–v14 (see *Integration with current `dev`* below). `settings.json` is outside logical dumps. The default schedule is off; a configured schedule is not evidence of an available recovery set.

Paths derive from configuration: `main.ts:42–43` locates image storage and settings; `gpx-files.ts:62–63` locates private routes beside images; `resolveBackupDir` locates backups. Compose defaults mount `./uploader/data` as `/data`. An operator override can put files elsewhere, so the inventory must name configured locations, not promise that copying one default directory always suffices. No live configuration or secret value was read for this proposal.

## Recovery inventory contract

| Material | Existing app coverage / limitation | Operator recovery requirement |
|---|---|---|
| Content, accounts, comments, media metadata, encrypted AI credentials, private route rows, identity, language, navigation, journeys | `db-*.json.gz` (v10 at this baseline; v14 now): `users`, `posts`, `pages`, `media`, `media_folders`, `app_secrets`, `comments`, `post_routes`, and since v11–v14 `site_identity`, `site_identity_assets`, `site_language`, `site_nav`, `journeys`, `journey_locales`, `journey_members`; password hashes and private coordinates are sensitive | Retain a validated dump from the intended point in time, plus its companion files; gzip is not encryption |
| Private GPX originals | Retained originals live under the configured routes root (default `/data/routes`); dump's manifest binds a separate `routes-*.tar`, including explicit degraded-source states | Copy the matching manifest-referenced archive with each retained dump, and include retained route storage in host recovery; never substitute the public simplified route or an image tar. Full original locations/times may survive detachment and public trimming |
| Image originals and variants | Completed files in configured image storage; incremental `images-*.tar` includes private originals that may retain EXIF/GPS; image archives are never automatically pruned | Preserve image storage and/or the complete required archive chain, replayed oldest-first into an empty disposable directory. Existing media deletion does not purge old archives or offsite copies (#399) |
| `settings.json` | Not in the DB dump; holds provider registry URLs/assignments and operating settings, not encrypted provider keys | Copy the actual configured file coherently with the recovery generation; include `settings.json.pre-ai-registry` while present. Do not infer that a migration copy is always the current pre-upgrade settings |
| Bootstrap configuration | `.env`/deployment configuration is not in app backups; includes database/bootstrap values, image identity and origin configuration | Keep a restricted, encrypted recovery copy of required values and any overrides. Preserve deployment/Compose configuration and immutable image identity. Do not expose values in the panel or reports |
| AI master key | `ENCRYPTION_KEY` is never part of app backups; ciphertext alone cannot recover it | Escrow every still-needed key generation separately from data backups, including access/recovery instructions; associate generations without exposing values. If a bootstrap file contains the key, do not copy that value into the data repository: separate it into escrow |
| Offsite repository recovery credentials/decryption key | Not managed by the app | Independently recoverable escrow; avoid a circular dependency where the only key is inside the repository it unlocks |
| Static site releases, generated public tracks, baked map assets | Releases are generated; map assets normally ship in the image | Rebuild from restored content/settings/media with the pinned supported image. Preserve custom basemap/config overrides if used. Release copies may aid immediate recovery but are not a substitute for source material |
| MDX exports, backup `state.json` | MDX is an optional portable export, not a complete account/comment/route/secret restore; backup state tracks scheduling/cutoffs, not content | Host copy may retain them; never treat them as a full dump or proof that the last archive completed. Invalid/missing image cutoff state triggers the existing conservative full archive |
| Sessions and temporary/operational state | Sessions are not dumped; pending GPX imports and operational job state are not full recovery material | Reauthenticate and reconstruct disposable work through existing boot recovery. Do not promise recovery of unsaved browser edits or excluded revision/job history |

Treat the data repository as sensitive even with the AI key elsewhere: it still contains password hashes, comments, private photo/route locations and source metadata. Encryption must cover transfer and storage at the offsite destination; separate key escrow does not make a DB dump public.

## Approved implementation

**Operator-managed settings coverage; no app-native settings snapshot.** The owner selected
this option on 2026-10-28. The host copy already needs bootstrap/escrow and private files,
so `backup.ts`, dump format, retention and restore remain unchanged. Any future native
snapshot needs a separately approved consistency, naming, retention, failure and restore
contract; it is not part of this implementation.

Update existing `ARCHITECTURE.md` Backups/DR and `README.md` Backups with the inventory, generation selection and offsite workflow. In `uploader/public/settings.html`, replace/extend the existing same-disk note with two concise groups: **app-created recovery files** (DB, images, private route archive) and **operator-managed material** (settings/migration copy, bootstrap config, separate key escrow), plus rebuildable releases. Reuse current backup lists/status, including degraded GPX counts; do not imply that listing a file proves recoverability or offsite delivery.

All added copy goes into `site/src/i18n/ui.ts` for DE/EN and through the existing admin-copy delivery mechanism, rendered with text nodes. No secret values or original GPX/EXIF details are needed. Keep `GET /backups` admin-only and its existing explicit metadata shape; the inventory describes coverage, not remotely probed offsite status. No new endpoint, settings-file download, environment read, key-presence probe or built-in upload is justified. API tests must continue proving exclusion of secret/config values rather than testing prose.

## Host-level offsite example contract (not an installed solution)

The runbook describes this tool-neutral sequence; command syntax is filled from the **operator's chosen, documented encrypted backup tool**, not a fabricated executable or a silently selected vendor:

1. Select a genuinely separate failure domain and encrypted repository whose ownership, cost, access and retention the owner has approved. Do not call another path on the same host “offsite”. Record non-secret identifiers and recovery contacts privately.
2. **Establish the operational write freeze before creating the recovery set.** Block new author/admin/public mutations and scheduled/storage writers, drain already-admitted changes (especially provider URL/key updates), and resolve known partial failures. Keep only the designated existing backup control available for capture; use the existing stopped-app ownership procedure for subsequent filesystem copying where needed. This is an operator-maintained maintenance window, not an application transaction or a new snapshot feature. If a complete freeze cannot be maintained, do not declare a coherent generation.
3. While that freeze remains in force, create a current app recovery set; inspect success/degraded status and validate the dump plus referenced private archives. Capture the matching configured settings/migration copy, bootstrap configuration and non-secret key-generation association before releasing the freeze, together with all required image material. A DB snapshot taken before a provider change must never be paired with settings captured afterward: that can bind an old credential to a new destination. Verify every selected dump's companion/image coverage and refuse an incomplete generation rather than advancing a success marker.
4. Copy that frozen recovery generation, complete required image chain and bootstrap material (excluding separately escrowed master keys) into one encrypted offsite generation. Preserve earlier valid generations if copying fails. Capture originals only as private data, never web assets. Release the write freeze only after the selected material has been coherently captured; do not resume writers while a tool is still reading the live files.
5. Approved operator policy: keep **14 completed daily offsite generations**, retaining a last-known-restorable generation if later attempts fail. This is not an implemented app pruner or a capacity guarantee. Preserve older archives still needed by retained generations; never prune individual image tars out of a retained chain or orphan a retained dump's GPX companion. Existing in-app nonpruning of image archives is unchanged. Measure space/cost with the chosen tool before enabling pruning; no destination or budget is assumed.
6. Recover using only that offsite generation plus independent escrow in #295's isolated topology: distinct data bind/project/database, non-3000 loopback port, ingress blocked. Do not let source data on the original disk silently fill a gap. Check dump/route integrity, counts, image rescan, rendered story/gallery/comments and settings fidelity. Exercise encrypted credential recovery without paid/provider calls or logging keys. Record only redacted evidence.

Key-loss scenario: content and photos still restore; encrypted AI credentials cannot decrypt. Keep local AI workflows available. Restore provider settings, configure a valid replacement master key through the existing private bootstrap mechanism, and re-enter/reissue each remote provider credential via admin Settings; revoke obsolete provider credentials where appropriate. Do not bypass encryption, copy ciphertext into a different provider assignment or claim replacing the key decrypts old envelopes. Keep the original escrow key for generations still intended to restore those credentials.

## Approval, dependencies and evidence

Decisions approved on 2026-10-28:

1. Inventory/UI/docs and SECURITY.md *Secrets*, *Backups* and private-GPX reconfirmation, without changing application backup semantics.
2. Settings coverage: **operator-managed only**, not an app-native snapshot.
3. **14 completed daily offsite generations**, preserving older required chain material. The existing encrypted backup system must still be identified by its tool and non-secret destination, with independent escrow/recovery access, before setup, expense or transfer. No vendor/cost is chosen by this spec.

Owner decision recorded 2026-10-28: **Approve operator-managed coverage** and **Approve 14 generations**. The existing-system choice does not identify a tool or destination and is not evidence of a successful backup or restore. Obtain the non-secret system and escrow details before that drill; complete the independent approved UI/documentation work meanwhile.

#295 must supply independent disposable restore evidence; #296 additionally requires an **offsite-only** drill. Neither has occurred here and neither is waived by approving documentation. #399 supplies the archive privacy clause; #398 supplies the runnable offline restore sequence. Future #297/#316 build records/manifests, if approved, remain rebuildable operational state rather than a new source of content truth.

Verification scope: meaningful Settings DOM/browser checks for both locale copy sets, visible coverage categories, no secret/environment values; `/backups` authorization and sensitive-data exclusion tests; actual chosen-tool encrypted restore evidence without secrets. Main integrator runs affected suites/typechecks. The evidence below covers only synthetic local UI/API behavior, not infrastructure recovery or an offsite restore.

Containment: an incomplete copy must leave earlier valid generations intact; never delete live data or recovery history to make space. UI/docs can be corrected without data mutation. Failed restore drills preserve the isolated target for diagnosis and cannot touch production. This spec authorizes no production operation or cryptographic-key rotation.

## Reachable implementation and evidence — 2026-10-28

- Settings now groups app-created files and operator-managed material, with rebuildable
  releases and the explicit operator-only retention policy. DE/EN strings use the existing
  server-delivered `EditorCopy` dictionary and `textContent`. Existing backup lists,
  degraded-GPX status and #399 image-archive privacy copy are unchanged.
- `ARCHITECTURE.md`, `README.md` and `SECURITY.md` record the full inventory, write freeze,
  coherent provider/settings generation, separate escrow, chain/companion dependencies,
  failed-copy retention, key loss and isolated recovery containment. No API, settings snapshot,
  environment/key probe, uploader or automatic offsite pruner was added.
- Added a permanent API privacy-boundary regression: `/backups` returns only existing
  recovery metadata without reading operator settings or provider secret values/presence.
  Automated suites/typechecks are left to the parent integrator; no pass is claimed here.
- Actual `src/main.ts` ran against synthetic `swl_296_dev` on loopback port 33396 with all
  writable paths under this worktree's `.issue-runtime`. The real **Back up now** control
  produced a local dump; admin metadata/download returned 200 (download `no-store`).
  Anonymous/author GET, POST and DB/image/GPX download requests returned 401/403.
  `/backups/settings.json` was refused. Rendered markup/metadata contained neither the
  synthetic password, database URL nor actual configured settings path.
- Managed Chromium captured 1440×1000 desktop and 390×844 mobile coverage without horizontal
  document overflow. Settings remains English by incumbent design; German evidence explicitly
  renders the real delivered `EditorCopy.de` copy set via text nodes, not a claimed locale
  switch. Screenshots and redacted `inventory-browser-evidence.json` are retained under
  `.issue-runtime`. The optional existing local-model discovery failed at localhost:1234
  because no model server was supplied; no remote/provider call or secret was required.
  Owned browser tab and runtime were stopped.

This synthetic account-only local backup has no image/GPX fixture and is **not** a restore
drill, encrypted offsite proof or #295 acceptance. The precise remaining prerequisite for
#296 is the owner's existing encrypted backup **tool/system, non-secret destination
identifier and independently recoverable escrow/access method**, followed by the authorized
offsite-only drill using that system. Neither #295 nor #296 recovery acceptance is waived.
