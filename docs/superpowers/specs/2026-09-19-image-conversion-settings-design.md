# Image conversion and quality settings

## Approval and risk

Owner approved both controls and the safe JPEG fallback on 2026-09-19 in the implementation conversation. High risk: extends the shared image-format contract, media persistence/recovery, and post-sanitization image rendering. This supersedes the fixed AVIF + WebP requirement of the 2026-06-18 image-hosting spec only for newly processed JPEG-mode images. Existing images and URLs remain valid.

## Behavior

Admin Settings gains `convertJpeg` (boolean, default true), `webpQuality` (integer 1–100, default 75), and `avifQuality` (integer 1–100, default 55). Values persist in the existing settings store; no environment variables. Quality applies to modern-format encoding. Disabling conversion affects JPEG inputs only: generate responsive JPEG variants at quality 90, with the same widths, orientation correction, ICC preservation, and EXIF allow-list. Other input formats continue producing AVIF and WebP. Originals remain private, untouched recovery assets; Off never means serving original bytes.

Settings do not reprocess existing media. New upload jobs snapshot their encoding settings so queued jobs, retries, and crash recovery cannot silently change format when the global preference changes. Identical bytes uploaded with different encoding settings must not overwrite an existing immutable image URL. Imports retain disk-based resume: a complete existing body/gallery variant set wins over the current preference, while new work uses the selected settings. The existing explicit `overwriteDrafts` action still re-fetches and overwrites its deterministic featured-image key; normal merge skips a stored hero. This feature does not migrate the importer's hero-key identity or remove old-format variants.

## Shared contracts

- `ProcessOptions` gains optional `convertJpeg` alongside existing optional quality fields.
- Image references (hero, body image metadata, media responses, upload results and import results) gain optional `format: 'jpeg'`. Omission means the existing AVIF + WebP contract; reject any other supplied value at untrusted write boundaries.
- JPEG variant filenames use `{key}-{width}.jpeg`; modern variants retain their existing names. Every consumer must use the image's recorded format rather than the current global setting.
- Media persistence records optional `format` (text) and `encoding` (JSONB) for future job recovery, through additive columns. Existing records require no data rewrite and retain their original modern-format behavior. Backup v7 preserves both fields; v1–v6 remain readable.
- Rendering emits only actually generated formats, including responsive JPEG sources and JPEG fallbacks/lightbox targets. Editor, picker, export, preview, post lists, schema and normalization preserve the format field end-to-end.
- Reconciliation recognizes JPEG sets, requires every expected width, and retains the existing missing/processing/ready transitions. It must not label a partial JPEG set ready or re-encode a healthy old modern set because the global preference changed.

## Trust boundaries and misuse cases

Settings writes remain admin-only and validate booleans and integer bounds before persistence. Image metadata is untrusted at both save and rendering boundaries. Existing origin equality, path checks, dimension validation and text escaping remain intact. New format handling must not permit arbitrary extensions or paths. JPEG outputs carry no GPS/XMP/IPTC; the private-original serving exclusion remains unchanged. Unknown or malformed encoding metadata must not weaken privacy or accept an incomplete set.

## Verification

Exercise settings persistence and invalid inputs; real JPEG encoding in both modes and non-JPEG behavior; output metadata privacy; immutable identity across different profiles; media recovery and partial variant sets; mixed JPEG/modern rendering; editor save/reload and gallery/export preservation. Run both affected test suites, uploader TypeScript checks and Astro checks (with available database). Run a real upload/encoding smoke scenario and inspect Settings in the browser at desktop and mobile widths.

Verified locally against isolated PostgreSQL 18: 1,460 uploader tests (including integration
suites), 255 site tests, `tsc --noEmit`, and `astro check` pass. A real HTTP/browser run saved
and reloaded preferences, encoded JPG in both modes and PNG with conversion off, confirmed
distinct profile identities, served all expected MIME types, rejected quality 101 with 400,
and kept the original URL at 404. After restarting the app, rescan demoted/recovered no healthy
images; a mixed JPEG/modern hero/body/gallery story published through the actual Astro build
and every rendered image loaded. Settings was checked at 1280px and 390px with no horizontal
overflow and a 44px checkbox-label target.

The optional static design detector cannot resolve the app's `/admin/` stylesheet mount and
reports incomplete heading metrics. Its Inter warning conflicts with the pinned design
language, and its editor image warnings describe runtime-populated preview slots. Those
incumbent patterns were retained; actual browser rendering is the visual verification.

## Recovery and containment

No automatic corpus rewrite, deletion, or migration of image files. Defaults preserve current behavior. Turning conversion back on changes only future uploads. Database additions must be additive and backup/restore must retain format/profile metadata. Once JPEG-mode content is saved, rolling application code back to a build without JPEG support is not safe; roll forward or restore a verified pre-change database and matching image/site backup. Existing static releases remain available during failures.

## Design review

A global toggle read at render time is rejected: old photos would 404 after a settings change. Serving originals is rejected: it exposes private metadata. An extension-only encoder change is rejected: completeness checks, backup/restore, editor round-trips and image renderers share the contract. Upload-byte-only cache keys are insufficient when quality/format changes; new encoding profiles need distinct identities. Width and format guards must be maintained in both application trees.
