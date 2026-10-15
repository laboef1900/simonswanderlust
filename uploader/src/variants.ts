/**
 * Image variant contract. MUST stay identical to the blog's
 * site/src/lib/images.ts so generated filenames and the srcset match.
 * Spec: docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md
 */
export const WIDTHS = [640, 1280, 1920] as const;
/** The original modern-format contract. Omission of an image-level format means this pair. */
export const FORMATS = ['avif', 'webp'] as const;
export const JPEG_FORMAT = 'jpeg' as const;
export type ModernImageFormat = (typeof FORMATS)[number];
export type ImageFormat = ModernImageFormat | typeof JPEG_FORMAT;
/** Persisted/reference-level discriminator. Modern images deliberately omit it for compatibility. */
export type ImageOutputFormat = typeof JPEG_FORMAT;

/** Historical/default encode profile; shared by settings and legacy media recovery. */
export const DEFAULT_PROCESS_OPTIONS = {
  convertJpeg: true,
  webpQuality: 75,
  avifQuality: 55,
} as const;

export function formatsFor(format?: ImageOutputFormat): readonly ImageFormat[] {
  return format === JPEG_FORMAT ? [JPEG_FORMAT] : FORMATS;
}

/** Standard widths smaller than the source, plus the source's own width. Never upscales. */
export function variantWidths(
  intrinsicWidth: number,
  widths: readonly number[] = WIDTHS,
): number[] {
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}
