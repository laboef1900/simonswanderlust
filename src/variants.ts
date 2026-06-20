/**
 * Image variant contract. MUST stay identical to the blog's
 * site/src/lib/images.ts so generated filenames and the srcset match.
 * Spec: docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md
 */
export const WIDTHS = [640, 1280, 1920] as const;
export const FORMATS = ['avif', 'webp'] as const;
export type ImageFormat = (typeof FORMATS)[number];

/** Standard widths smaller than the source, plus the source's own width. Never upscales. */
export function variantWidths(
  intrinsicWidth: number,
  widths: readonly number[] = WIDTHS,
): number[] {
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}
