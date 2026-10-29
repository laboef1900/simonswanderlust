# #378 — Keep transformed images valid in their HTML context

**Status: OWNER APPROVED 2026-10-28 — valid picture placement. Risk: High:** post-sanitize body HTML injection. Implementation and verification remain required; no owner Markdown rewrite or deployment is authorized.

## Decision requested

Approve **figures for standalone root-paragraph images; bare pictures in phrasing contexts**. For a standalone linked image, produce one `<figure><a …><picture>…</picture></a></figure>`. Do not split prose sentences, duplicate a link, add a new lightbox interaction, or rewrite owner Markdown.

The issue's supplied `transformBodyImages`/parse5 reproduction is the evidence; it was not rerun. Current `pictureNode` always returns a figure, while the paragraph special case only recognizes one unlinked image. General replacement therefore emits flow content inside paragraphs/anchors and relies on browser repair.

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

After implementation, test the three exact issue bodies through `renderMarkdown → transformBodyImages → HTML5 parse/serialize`; assert stable tree structure, no generated empty paragraphs/anchors, exactly one destination link for the linked-image case, preserved text order and accessible name. Add standalone whitespace, mixed text/link, adjacent images, emphasis, blockquote/list, existing figure/picture, unknown-image and JPEG-only fixtures. Assert all expected srcsets, alt, dimensions and loading properties survive, with existing sanitization/hostile-link/gallery tests unchanged. Verify static story and script-free preview in a browser with JS disabled, including text after an image staying in its paragraph; then run affected suites/typechecks. These are future checks, not observed results.

Update the existing image/gallery rendering documentation and reconfirm `SECURITY.md` output-sanitization/post-sanitize sections. Coordinate shared renderer changes with #356/#358/#375/#379; #379 must target the new bare-picture construction as well as figures.

## Recovery

No persisted-data migration or URL change. Roll back code and rebuild through the normal release flow only if necessary; the existing previous release remains available. A rollback restores the malformed markup defect. Prefer a forward structural correction; never strip links/photos or alter stored bodies as containment.
