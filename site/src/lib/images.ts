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
  /**
   * Author-chosen subject position as percentages of the frame, fed to
   * `object-position`. Every surface that shows a hero crops it with
   * `object-fit: cover` into a box whose aspect ratio it does not control —
   * the 70vh phone hero keeps ~44% of a 3:2 frame's width — and the default
   * centre crop decapitated the subject of the two portrait-format heroes in
   * the corpus. Optional: absent means `50% 50%`, which is what every post
   * predating this field renders as.
   */
  focus?: { x: number; y: number };
}

/**
 * `object-position` for a hero, or `undefined` when the author never moved it
 * (so no attribute ships and the CSS default applies).
 *
 * @ai-warning This value lands in a `style` attribute. The numbers are clamped
 * and rounded HERE rather than trusted from the database: `heroImage` is a
 * `jsonb` column and a draft save only runs the shape check in
 * `uploader/src/body-content.ts`, so treat anything inside it as untrusted at
 * the render boundary — the same rule `uploader/src/preview.ts` applies to
 * `width`/`height`.
 */
export function focusPosition(image: RemoteHeroImage): string | undefined {
  const f = image.focus;
  if (!f) return undefined;
  const pct = (n: unknown): number => {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 50;
    return Math.round(Math.min(100, Math.max(0, v)));
  };
  const x = pct(f.x);
  const y = pct(f.y);
  return x === 50 && y === 50 ? undefined : `object-position:${x}% ${y}%`;
}

export type ImageFormat = 'avif' | 'webp';

/**
 * Origin the hero images are served from when the build has no configured base
 * URL. Mirrors the `PUBLIC_BASE_URL` default in the repo-root `docker-compose.yml`.
 */
export const PROD_IMAGE_ORIGIN = 'https://img.simonswanderlust.com';

/**
 * Origin to preconnect to for the LCP hero image (see `Base.astro`).
 *
 * @ai-note The image host is an *uploader* setting (`PUBLIC_BASE_URL`), and the
 * app container spawns `astro build` with its own env, so Vite exposes it as
 * `import.meta.env.PUBLIC_BASE_URL` (Astro's env prefix is `PUBLIC_`). Local
 * dev / CI builds run without it, hence the production fallback. Takes
 * `unknown` because `import.meta.env` is an untyped record — narrowing here
 * keeps callers free of casts.
 */
export function imageOrigin(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return PROD_IMAGE_ORIGIN;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return PROD_IMAGE_ORIGIN;
  }
}

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
  // Always returns at least one element (the intrinsic width), so callers can
  // safely index the last element.
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}

/**
 * Re-point a post's own image URLs at `origin`, so one database renders
 * correctly in every environment.
 *
 * The uploader stamps its `PUBLIC_BASE_URL` into content at upload/import time
 * — the hero `src`, every key of the `images` map, and every URL written into
 * the body. Nothing downstream swaps it: `srcset()` below concatenates onto the
 * stored string, and the gallery allow-list in `body-images.ts` compares the
 * stored origin by EXACT EQUALITY. So content imported against
 * `http://localhost:3000` renders broken images on a server, and its galleries
 * fail the allow-list and fall back to a code block. This makes the stored
 * origin advisory instead of binding.
 *
 * @ai-warning Only URLs the post REGISTERED as images are rewritten — the
 * `images` map keys plus the hero. A blanket origin replace over the body would
 * also rewrite ordinary prose links (these posts link to Wikipedia and to other
 * posts on this blog), and locally the blog and the image host are the SAME
 * origin, so there is no origin test that separates them.
 *
 * Replacement runs longest-key-first: `…/a` is a prefix of `…/a-2`, and
 * rewriting the short one first would corrupt the long one.
 */
export function retargetImageOrigins<V>(
  content: { heroSrc: string; images: Record<string, V>; body: string },
  origin: string,
): { heroSrc: string; images: Record<string, V>; body: string } {
  const retarget = (url: string): string => {
    let u: URL;
    try { u = new URL(url); } catch { return url; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    return `${origin}${u.pathname}${u.search}${u.hash}`;
  };

  const images: Record<string, V> = {};
  const renames: [string, string][] = [];
  for (const [key, value] of Object.entries(content.images)) {
    const next = retarget(key);
    images[next] = value;
    if (next !== key) renames.push([key, next]);
  }

  renames.sort((a, b) => b[0].length - a[0].length);
  let body = content.body;
  for (const [from, to] of renames) body = body.split(from).join(to);

  return { heroSrc: content.heroSrc === '' ? '' : retarget(content.heroSrc), images, body };
}

/** Responsive srcset string for one format. */
export function srcset(image: RemoteHeroImage, format: ImageFormat): string {
  return variantWidths(image.width)
    .map((w) => `${image.src}-${w}.${format} ${w}w`)
    .join(', ');
}

/**
 * The largest variant that exists for a photo.
 *
 * Two callers, which is why it lives here rather than inline: the gallery's
 * `<a href>` (the no-JS "open full size" target) and the lightbox island that
 * enhances it.
 */
export function largestVariant(image: RemoteHeroImage, format: ImageFormat = 'webp'): string {
  const widths = variantWidths(image.width);
  return `${image.src}-${widths[widths.length - 1]}.${format}`;
}

/** Plain <img src> fallback — prefers the 1280 webp, else the largest available. */
export function fallbackSrc(image: RemoteHeroImage): string {
  const widths = variantWidths(image.width);
  const w = widths.includes(FALLBACK_WIDTH) ? FALLBACK_WIDTH : widths[widths.length - 1];
  return `${image.src}-${w}.webp`;
}
