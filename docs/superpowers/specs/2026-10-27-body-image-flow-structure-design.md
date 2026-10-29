# #378 — Keep transformed images valid in their HTML context

**Status: OWNER APPROVED 2026-10-28; implemented and locally qualified. Risk: High:** post-sanitize body HTML injection. Final-head review/CI and the unmerged dependency stack are PR gates; no owner Markdown rewrite or deployment is authorized.

## Approved decision

Use **figures for standalone root-paragraph images; bare pictures in phrasing contexts**. For a standalone linked image, produce one `<figure><a …><picture>…</picture></a></figure>`. Do not split prose sentences, duplicate a link, add a new lightbox interaction, or rewrite owner Markdown.

The issue's supplied `transformBodyImages`/parse5 reproduction was accepted without rerunning it. Before this fix, `pictureNode` always returned a figure, while the paragraph special case recognized only one unlinked image. General replacement therefore emitted flow content inside paragraphs/anchors and relied on browser repair.

## Implementation contract

In `site/src/lib/body-images.ts`, separate the existing responsive **picture** construction from the optional **figure** wrapper. Reuse `sourceNodes`, `fallbackSrc`, stored format, alt, dimensions, lazy loading, async decoding and existing image classes; do not maintain a second source-selection implementation.

Traverse the sanitized HAST with parent context:

- A root-level paragraph whose only non-whitespace child is a resolvable image becomes the existing `figure.my-8` around its picture.
- A root-level paragraph whose only non-whitespace child is an anchor, itself containing only one resolvable image plus whitespace, becomes `figure.my-8` containing **that single sanitized anchor** and the replacement picture. Preserve its surviving href/title/other sanitized properties and the image alt. There is no empty outer anchor and no cloned sibling link.
- All other eligible images become **bare `<picture>` phrasing content at the original position**. This includes consecutive images in one paragraph, images between words, mixed-content anchors, emphasis/headings and nested paragraph containers. Keep surrounding text, whitespace, links and paragraph structure intact; do not hoist or split sentences.
- An image already inside an author-supplied `<picture>` is not wrapped in a second picture. Preserve that sanitized picture/source structure as a unit; its explicit source choices already participate in #334 readiness analysis. An existing `<figure>` can contain a replacement bare picture without acquiring another figure.
- Unrecognized image URLs or unsupported stored formats retain existing non-transform behavior. Generated subtrees are skipped during traversal so sources/images are not transformed again.

Treat this as node construction, not serialized-HTML search/replace. The three issue fixtures must round-trip through an HTML5 fragment parser without tree repair. Normalize with the same serializer when comparing: harmless serializer spelling differences are not malformed structure.

## Safety and invariants

Sanitize author markup **before** retaining/moving an anchor or creating the picture. Do not expand `BODY_SCHEMA`, copy attributes from pre-sanitize input, synthesize an href from text, or remove the existing origin/format/dimension checks on galleries. Existing images-map validation at the posts/pages store boundary remains mandatory; this structural change grants no exception for invalid dimensions. Keep the existing image source policy, no-upscale variants, private-original restrictions and EXIF allow-list unchanged.

No new unnamed duplicate anchors are introduced. The fixtures' nonempty image alt continues to name their single original link; intentional authored decorative image links are not automatically given invented destination descriptions. #358 separately supplies names for renderer-created gallery links. No-JS output is the final valid structure; no DOM repair script.

## Affected consumers and verification

Direct implementation: `body-images.ts` and `body-images.test.ts`. Consumers requiring regression coverage: `postgres-loader.ts` and `pages-loader.ts` (story/About builds), `StoryPage.astro`/`story-opening.ts` (split still preserves content), `uploader/src/preview.ts`, and `publish-gate.ts` (sources/readiness remain identical). No consumer should independently reconstruct images.

Regression coverage exercises the three exact issue bodies through `renderMarkdown → transformBodyImages → HTML5 parse/serialize`: stable structure, no generated empty paragraphs/anchors, exactly one destination link for the linked-image case, preserved text order and native image alt. Additional cases cover standalone whitespace, mixed text/link, adjacent images, emphasis, headings, blockquote/list, authored figure/picture, unknown images and JPEG-only selection. Source sets, alt, dimensions and loading survive; existing sanitization, hostile-link and gallery regressions remain. Whitespace preservation is compared within the original sanitized paragraph, not against an incidental Markdown fragment-ending newline.

Update the existing image/gallery rendering documentation and reconfirm `SECURITY.md` output-sanitization/post-sanitize sections. Coordinate shared renderer changes with #356/#358/#375/#379; #379 must target the new bare-picture construction as well as figures.

## Local qualification

- Production implementation `7bc196495221b36383840fb7382eae336e217f6d`; test corrections
  complete at `5c62a724ca8813d08ff9f55c4933ab2a7a4140f6`. Uploader types and the full
  Postgres-enabled suite passed in wave `1793235667881_5041`; Astro check, the full site
  suite and build passed in `1793236120195_6576`. Intermediate test-helper type errors
  and whole-fragment newline assumptions were corrected without weakening production guards.
- Actual `main.ts` and authenticated authoring APIs published a synthetic DE/EN story
  and saved/built About in isolated `swl_378_dev`. Two ready 3000×2000 photos exercise
  genuine AVIF/WebP and JPEG-only pipeline variants.
- DE/EN story, About and script-free preview at 1440/390px: 12 JS-disabled surfaces,
  156 decoded picture instances and 60 named links inspected in Chrome's accessibility
  tree. No empty paragraph/link, nested picture, figure inside a paragraph/anchor or
  orphaned sentence text. Each linked-image fixture has exactly one named destination.
  Authored source choices, JPEG-only selection and stripped hostile anchor attributes
  remain correct. Preview CSP still denies scripts.
- Native Tab/Shift-Tab preserves the original link order; Enter opens the genuine
  3000×2000 WebP in both locales. Evidence under
  `.local/backlog-execution-2026-10-27/issue-378-runtime/` includes six raw HTML responses,
  source hashes, DOM/accessibility records, 26 qualified screenshots and final readback.
  Fixture/setup corrections and four mistaken metadata-only preview crops are retained
  separately, not counted as qualification.
- Stored and published body text/image maps and About content remain unchanged after
  browser exercise. Temporary account/sessions, browser application/profile/launcher
  and runtime are removed; synthetic databases, photos and releases are retained.
  No physical-device, screen-reader-speech or production-data claim.

## Recovery

No persisted-data migration or URL change. Roll back code and rebuild through the normal release flow only if necessary; the existing previous release remains available. A rollback restores the malformed markup defect. Prefer a forward structural correction; never strip links/photos or alter stored bodies as containment.
