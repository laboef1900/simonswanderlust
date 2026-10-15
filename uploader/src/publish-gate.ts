/**
 * The publish gate's foreign-image check (#91): every `http(s)` image URL a
 * post body would put on the live page whose origin is not the image host.
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
 * The sources are collected BEFORE any `images` resolution on purpose. With
 * the map applied, `transformBodyImages` would turn a foreign inline image
 * into a `<picture>` that hot-links `…-640.webp` on the old host and — worse
 * — silently DROP a foreign gallery line, which is exactly the "photo
 * vanishes at render" hole this gate exists to close.
 *
 * Origin comparison is equality on `URL.origin`, never a prefix — the gallery
 * allow-list's rule, for the same look-alike-host reason.
 *
 * @ai-context docs/superpowers/specs/2026-09-06-publish-gate-foreign-images-design.md
 */
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { bodyImageSources } from '../../site/src/lib/body-images.js';

export async function foreignImageUrls(body: string, imageOrigin: string): Promise<string[]> {
  // server.ts validates cfg.baseUrl at boot (previewCsp), so this cannot throw there.
  const allowed = new URL(imageOrigin).origin;
  const found = new Set<string>();
  const { sources, galleryLines } = bodyImageSources(await renderMarkdown(body));
  for (const raw of [...sources, ...galleryLines]) {
    let u: URL;
    // Resolved against the image host — which in this deployment is the origin
    // that serves the blog too — because that is what the reader's browser
    // does with a reference that carries no origin of its own. Parsing without
    // a base disagreed with it in both directions: `//old.example/a.jpg`
    // (also its `&#47;&#47;` and `\\` spellings, which WHATWG resolves the same
    // way) failed to parse and was passed as harmless while the page hot-linked
    // old.example, and `https:old.example/a.jpg` parsed as a foreign origin
    // while the browser reads it as a path on our own host — a false refusal.
    try { u = new URL(raw, allowed); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.origin !== allowed) found.add(raw);
  }
  return [...found];
}
