/**
 * Current Media-library gallery descriptions for one stored post, resolved the
 * way the site build resolves them (`site/src/lib/postgres-loader.ts`): keyed
 * by the photo's exact full base URL `${imageBase}/${key}`, one map per locale.
 *
 * @ai-context docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md
 * @ai-note Presence of a media row, not a non-empty string, decides precedence:
 * an emptied library field overrides the post's copy, and a URL with no row is
 * simply absent so the renderer keeps the stored description. No title-to-alt
 * and no cross-locale fallback.
 * @ai-warning A store failure PROPAGATES. Swallowing it would silently show the
 * stale copied text the owner asked to stop seeing; callers rely on the global
 * error handler to answer a sanitized 500.
 */
import type { GalleryMetadata } from '../../site/src/lib/body-images.js';
import type { MediaStore } from './media-store.js';
import type { Locale, PostPair } from './posts.js';

export type LocaleGalleryMetadata = Record<Locale, GalleryMetadata>;

const LOCALES = ['de', 'en'] as const;

/**
 * The storage key behind an EXACT base URL of ours, or null. Unlike the
 * publish gate's `srcToKey`, a hand-pasted variant suffix is NOT stripped:
 * the overlay is keyed by the same string the renderer looks up in `images`,
 * and the site build only ever keys `${origin}/${key}`.
 */
function keyOf(url: string, imageBase: string): string | null {
  const prefix = `${imageBase}/`;
  if (!url.startsWith(prefix)) return null;
  try {
    if (new URL(url).origin !== new URL(imageBase).origin) return null;
  } catch { return null; }
  const key = url.slice(prefix.length);
  return key === '' ? null : key;
}

/**
 * One batched store read for every `images`-map URL of both locales — gallery
 * lines only resolve through that map, so nothing else can be a gallery photo.
 */
export async function loadGalleryMetadata(
  pair: Record<Locale, Pick<PostPair['de'], 'images'>>,
  store: Pick<MediaStore, 'descriptions'>,
  imageBase: string,
): Promise<LocaleGalleryMetadata> {
  const base = imageBase.replace(/\/+$/, '');
  const urlByKey = new Map<string, string>();
  for (const locale of LOCALES) {
    for (const url of Object.keys(pair[locale]?.images ?? {})) {
      const key = keyOf(url, base);
      if (key !== null) urlByKey.set(key, url);
    }
  }
  const de = new Map<string, { alt: string; caption: string }>();
  const en = new Map<string, { alt: string; caption: string }>();
  if (urlByKey.size === 0) return { de, en };
  const rows = await store.descriptions([...urlByKey.keys()]);
  for (const [key, row] of rows) {
    const url = urlByKey.get(key);
    if (url === undefined) continue;
    de.set(url, { alt: String(row.alt.de ?? ''), caption: String(row.caption.de ?? '') });
    en.set(url, { alt: String(row.alt.en ?? ''), caption: String(row.caption.en ?? '') });
  }
  return { de, en };
}
