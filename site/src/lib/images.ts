/**
 * Remote hero image hosted on the image server (see
 * docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md).
 * `src` is the base URL with no size/format suffix; variants follow the
 * `{src}-{width}.{format}` convention.
 */
export interface RemoteHeroImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export type ImageFormat = 'avif' | 'webp';

/** Standard responsive widths. MUST match the uploader's WIDTHS. */
export const IMAGE_WIDTHS = [640, 1280, 1920] as const;

/** Width used for the <img> fallback inside <picture>. */
const FALLBACK_WIDTH = 1280;

/**
 * Widths that actually exist for a given source: every standard width smaller
 * than the intrinsic width, plus the intrinsic width itself. Never upscales.
 * MUST mirror the uploader's variant logic so URLs never 404.
 */
export function variantWidths(
  intrinsicWidth: number,
  widths: readonly number[] = IMAGE_WIDTHS,
): number[] {
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}

/** Responsive srcset string for one format. */
export function srcset(image: RemoteHeroImage, format: ImageFormat): string {
  return variantWidths(image.width)
    .map((w) => `${image.src}-${w}.${format} ${w}w`)
    .join(', ');
}

/** Plain <img src> fallback — prefers the 1280 webp, else the largest available. */
export function fallbackSrc(image: RemoteHeroImage): string {
  const widths = variantWidths(image.width);
  const w = widths.includes(FALLBACK_WIDTH) ? FALLBACK_WIDTH : widths[widths.length - 1];
  return `${image.src}-${w}.webp`;
}
