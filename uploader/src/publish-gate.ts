/**
 * Publication image analysis: foreign-origin refusal (#91) and readiness
 * references from the actual transformed body (#334).
 *
 * @ai-warning Judged on the RENDERED body, read from the renderer's own
 * sanitized hast tree (`bodyImageSources` in site/src/lib/body-images.ts,
 * fed by `renderMarkdown`) — not on the Markdown text and not on a regex over
 * serialized HTML. Four review rounds each found a place where a second
 * parser disagreed with the renderer — code spans across blocks, backticks
 * inside attributes, character references, a raw `>` inside an attribute
 * value, `<pre id>` around a gallery, a raw `<picture><source srcset>` — and
 * every divergence was a silent bypass or a false refusal on a
 * named-sensitive surface. Reading the renderer's tree makes the two agree
 * by construction: what the gate sees IS what the reader would get.
 *
 * Foreign sources are collected BEFORE any `images` resolution on purpose. With
 * the map applied, `transformBodyImages` would turn a foreign inline image
 * into a `<picture>` that hot-links `…-640.webp` on the old host and — worse
 * — silently DROP a foreign gallery line, which is exactly the "photo
 * vanishes at render" hole this gate exists to close.
 *
 * Origin comparison is equality on `URL.origin`, never a prefix — the gallery
 * allow-list's rule, for the same look-alike-host reason.
 *
 * @ai-context docs/superpowers/specs/2026-09-06-publish-gate-foreign-images-design.md
 * @ai-context docs/superpowers/specs/2026-10-25-publish-readiness-references-design.md
 */
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { bodyImageSources, foreignBodyImageSources, transformBodyImages, type ImageDims } from '../../site/src/lib/body-images.js';

/** Foreign references before resolution; actual image loads after resolution (#334). */
export async function analyzeBodyImages(
  body: string,
  images: Record<string, ImageDims>,
  imageOrigin: string,
): Promise<{ foreign: string[]; sources: string[] }> {
  // server.ts validates cfg.baseUrl at boot (previewCsp), so this cannot throw there.
  const allowed = new URL(imageOrigin).origin;
  const html = await renderMarkdown(body);
  return {
    foreign: foreignBodyImageSources(html, allowed),
    sources: bodyImageSources(transformBodyImages(html, images, allowed)).sources,
  };
}

/** Browser-resolved body reference → hosted key; no filesystem access. */
export function bodyImageKey(src: string, imageBase: string, storyUrl: string): string | null {
  try {
    const url = new URL(src, storyUrl);
    const base = new URL(imageBase);
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(url.pathname.slice(prefix.length)).replace(/-\d+\.(?:avif|webp|jpeg)$/, '');
  } catch {
    return null;
  }
}
