# #399 — Classify image archives as private recovery material

Date: 2026-10-27. Risk: **High-area documentation — EXIF/GPS and backups.**
Status: **OWNER APPROVED 2026-10-28.** Factual security documentation and matching Settings disclosure are approved. Implementation and verification remain required. No retention, erasure, permission or backup-code change is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Facts

- `SECURITY.md:883–885` incorrectly says image archives contain only publicly served image files.
- `uploader/src/storage.ts:112–137` persists supplied original bytes as `{key}-orig.<ext>`; these can retain full EXIF including GPS. This does not promise every original has GPS or is byte-identical to an upstream SVG: the existing SVG rasterization policy is unchanged.
- `uploader/src/backup.ts:280–318` selects completed regular files under image storage by mtime/ctime, excluding unfinished `.part-*` files and boundary markers. Originals and public variants both qualify. The supplied synthetic tar-entry evidence is accepted and was not rerun.
- `uploader/src/server.ts:349–365` exposes only finished public variant filenames. Private originals are not public merely because the backup captures them.
- Image archive chains are deliberately never pruned (`backup.ts:280–286`); DB retention and manifest-linked private GPX retention are different policies (`pruneBackups:485–497`). Media deletion removes current stored files/rows, not existing image tar entries.
- `ARCHITECTURE.md:583–610` already identifies originals as private DR assets and says image archives are never pruned. `uploader/src/exif-audit.ts:92–97` skips originals when inspecting EXIF and audits public variants, not historical tar contents.

## Proposed correction

Replace the inaccurate SECURITY Backups bullet with this factual contract, mirrored concisely in ARCHITECTURE's image-archive section and the Settings backup inventory:

> Image archives contain public variants **and private full-resolution originals**. Originals can retain EXIF/GPS and other source metadata; handle image archives as sensitive recovery material, like database dumps. Downloads remain admin-only. Image archives are not automatically pruned: each may contain a unique part of the recovery chain. Deleting a photo from the media library does not purge earlier archives or their offsite copies.

Do not claim that image archives contain database password hashes; “like dumps” is a handling classification, not an assertion that their contents match. Do not claim route originals are in image tars: private GPX originals are separate recovery material covered by v10 dump manifests and route archives.

Link the existing `audit-exif` command as a **public-variant exposure audit**. State explicitly that a clean result does not certify originals or old archives GPS-free and does not erase anything. Link #296's offsite/escrow inventory, once available, without adding or endorsing a storage destination.

Scope excludes archive rewriting, GPS stripping, file permission changes, new retention periods, automatic deletion, privacy-policy/legal rewrites and any changed public-photo policy. The observed tar mode is not grounds to expand this issue into permission hardening. Existing protected download routes and private original serving remain unchanged.

## Files and coordination

- `SECURITY.md`, Backups: correct the false statement and its handling consequence; reconfirm EXIF/private-original rules.
- `ARCHITECTURE.md`, Image originals & incremental archives: add the explicit metadata/deletion caveat beside existing nonpruning language.
- `uploader/public/settings.html` and `site/src/i18n/ui.ts`: the inventory sentence must make the same distinction, with DE/EN copy through the existing admin-copy delivery pattern. #296 owns the full inventory; integrate this clause once rather than introduce a second warning panel. If #399 lands first, #296 reuses its copy. No new API or payload inspection is needed.
- Existing code paths (`backup.ts`, `storage.ts`, serving and media deletion) are evidence, not implementation targets.

## Trust boundaries and acceptance evidence

Backups cross from private app storage to admin downloads and operator-held copies. Misclassifying them as public can leak location histories; this correction makes the existing trust boundary explicit without changing authorization or retention. The operator must not infer erasure from media deletion, a clean public-variant audit, or expiry of DB dumps.

After approval, review SECURITY, ARCHITECTURE and the rendered Settings inventory together: all must state originals may carry GPS, archives are nonpruning, and deletion does not purge history. Use synthetic data only for any targeted coverage. Existing archive tests or the supplied reproduction establish inclusion; do not add exact-wording tests or rerun a probe just to reconfirm the known defect. If inventory DOM behavior changes, extend meaningful Settings/backup coverage to verify the sensitive category is displayed without loading/rendering original metadata or secret values; browser-check the DE/EN copy delivery. No behavior change to backup code is proposed, so a full restore is not a prerequisite for this correction.

## Owner decision and recovery

Approve the factual security-model/documentation correction and matching Settings disclosure. This is **not** approval for an erasure or retention policy change. #296's broader offsite choices and #295's pending rehearsal retain their own gates. Rollback/containment is to correct misleading copy while preserving the accurate warning; leave all archives and current data untouched. If an archive was previously treated as public, assess that concrete exposure through the existing incident process; this proposal neither claims such an exposure occurred nor authorizes deleting recovery history.

## Implementation and observed evidence — 2026-10-28

- Corrected SECURITY's Backups classification and ARCHITECTURE's image-archive section.
  The public-variant audit scope, nonpruning image chain, persistent historical/offsite
  copies and separate v10 GPX companion archives are explicit. Existing offsite/key-escrow
  guidance is linked; #296 can extend that inventory without repeating this warning.
- Settings adds one plain-text disclosure immediately below the existing Image archives
  heading, using `editor.chrome.imageArchivePrivacy` in both locales and the existing
  `EditorCopy` delivery/`textContent` loop. No new panel, endpoint, metadata request,
  locale-selection behavior, backup action, storage policy or authorization change.
  The EXIF allow-list/private-original serving rules in SECURITY are reconfirmed unchanged.
- Inspected the incumbent authenticated Settings inventory before editing. Ran the real
  `src/main.ts` app on `127.0.0.1:33499` with isolated `swl_399_dev` and distinct
  `swl_399_test`; validated writable absolute paths inside this worktree. Created only a
  synthetic admin through first-run setup. Image and backup inventories were empty.
- Managed Chromium (`relay: false`) rendered the updated English disclosure at 1440×1000
  and 390×844. Both locale values arrived from the real `/admin/editor-image-copy.js`
  response. The admin currently selects English, so German layout was checked by assigning
  the **delivered German value** to the same paragraph in the browser only; this does not
  claim a German admin locale switch exists. Both mobile copies wrapped without horizontal
  document overflow (390px document/viewport; paragraph about 347px). One disclosure node,
  no child markup; existing muted styling and surrounding inventory were retained.
- Redacted evidence in `.issue-runtime`: `settings-before-desktop.png`,
  `settings-after-desktop-en.png`, `settings-after-mobile-en.png`,
  `settings-after-desktop-de-delivered-copy.png`,
  `settings-after-mobile-de-delivered-copy.png`, and `privacy-evidence.json`.
  Captures contain synthetic account identity and public guidance, not credentials,
  original metadata or secret values. Post-change requests were only app resources and
  the existing auth/settings/backups reads (plus a data-URI icon); no image/original,
  archive-download or provider-credential request. Before editing, the incumbent AI
  initialization attempted `http://localhost:1234/v1/models`; the browser's allow-list
  blocked it. No external/model request was permitted, and this unrelated behavior
  was not changed.
- Limits: no tar reproduction, backup, deletion, restore or EXIF audit was rerun.
  No claim is made about real originals, historical archive contents or production.
  No prose/source assertion tests were added: this is a copy-only binding through the
  existing loop, not changed inventory behavior. Suites/typechecks remain the parent's
  responsibility; this worker ran no test, lint, formatter or verification-build command.
  The app's normal initial empty-site bootstrap ran in the isolated runtime.
