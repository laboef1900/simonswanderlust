# #358 — Name gallery links in server-rendered HTML

**Status: OWNER APPROVED 2026-10-28 — server-rendered link names. Risk: High** because this changes the post-sanitize renderer, despite the issue's presentation-oriented classification. Implementation and verification remain required; no owner-data change or deployment is authorized.

## Owner decision requested

Approve build/preview-time names for otherwise unnamed gallery photo links: retain a nonblank image alt as the link name; otherwise use the resolved visible caption; otherwise use localized **“Foto {current} von {total} öffnen” / “Open photo {current} of {total}”**. Keep the underlying decorative `alt=""` unchanged. No invented photo description or mandatory alt-text gate.

The issue suggests an island-only label as one option. That cannot satisfy the repository's no-JS contract or the script-free draft preview; it is explicitly not the proposed fix.

## Narrow implementation contract

`body-images.ts:itemNode` currently creates an anchor whose only content is a picture; the caption is a sibling. All three modes share this builder. `galleryPhotos` already resolves library/stored alt, gallery-local caption overrides, hidden captions, origin, dimensions and format. Use those **resolved** values, not another metadata lookup:

1. Nonblank `image.alt.trim()` → keep the native image-derived name; no overriding `aria-label`.
2. Otherwise nonblank resolved `caption.trim()` → assign that text to the anchor's `aria-label`.
3. Otherwise format the localized positional label with a one-based index and total of **accepted/rendered photos in this gallery**. Filtered unsafe/missing photos do not count. Duplicate URLs count as distinct positions. Numbering continues across justified rows and resets for each gallery.

Use `hastscript` property serialization and `String()`-coerced resolved text; never raw HTML or interpolated attribute markup. Do not expose captions hidden by `#captions: hidden` or intentionally cleared by a local override through an accessible label. Whitespace-only alt/caption is unnamed for this purpose but is not rewritten in storage.

Make locale an explicit required render input alongside the existing image origin; use `useTranslations(locale)` and the new `gallery.open` DE/EN key in `site/src/i18n/ui.ts`. The transform remains environment-free and usable under uploader `tsx`; `ui.ts` has no Astro/runtime dependency. Migrate every `transformBodyImages` call, including tests, rather than defaulting English silently:

- `site/src/lib/postgres-loader.ts`: `row.locale` for each story;
- `site/src/lib/pages-loader.ts`: `row.locale` for About/page bodies;
- `uploader/src/preview.ts`: selected preview locale;
- `uploader/src/publish-gate.ts` and `server.ts:publicationImages`: locale from the existing per-locale loop, so analysis uses the same renderer contract.

`justifiedRows` passes the gallery-global index (not row-local index); `sliderNode` passes its item index. Do not change hrefs, photo order, captions, slider controls or lightbox event behavior. `GalleryIsland.astro`'s comment claiming that render-time locale is unavailable must be updated; it continues transporting **interactive** labels only. `initGalleries` must not erase or replace the built names.

## Trust boundaries and acceptance

Reconfirm `SECURITY.md` sections on post-sanitize injection and gallery-library metadata. Origin equality, protocol checks, positive integer dimensions, format checks, text coercion, preview CSP, variant-only hrefs and EXIF privacy remain unchanged. A caption resembling markup or an attribute escape must remain inert label text. No schema, content or route changes.

Implementation verification, not performed here:

- `body-images.test.ts`: all three modes; blank and whitespace-only alt; visible/hidden/cleared/hostile captions; DE/EN fallback; accepted-photo counts; multiple rows/galleries and repeated URLs; described-image name remains unchanged.
- `gallery-lightbox.test.ts`: initialize an empty-alt rendered link and assert its built name survives, while opening the correct positional slide and preserving modified-click navigation.
- Loader and `uploader/test/preview.test.ts` coverage: story and About DE/EN names are in raw output before any script executes. i18n completeness covers `gallery.open`.
- Real static story/About accessibility inspection with JavaScript disabled, and script-free preview: every gallery link has a nonempty name and still opens the largest safe variant. Then JS-on lightbox/slider keyboard check.
- Affected site/uploader suites and typechecks after implementation. Do not call a runtime-only fix complete.

## Dependencies and recovery

Coordinate the shared `body-images.ts` edits with #356/#378/#379; none changes this naming policy. Approved #287 page work must pass the actual page locale to the same renderer. No dependency on AI descriptions or owner content edits. Update the existing gallery specification and accessibility notes, not a new public interaction model.

No stored data changes. Revert renderer/caller changes together and rebuild through the normal admin flow to restore previous markup; old static releases are unaffected until rebuilt. A rollback restores the accessibility defect, so prefer a corrective label-only release. Never hide the unnamed links or remove photographs as containment.
