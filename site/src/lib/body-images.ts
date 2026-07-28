import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';
import { srcset, fallbackSrc, variantWidths, type RemoteHeroImage } from './images.js';

/**
 * One entry of a post/page `images` map: the intrinsic dimensions plus the
 * optional per-locale alt/caption a gallery renders.
 *
 * @ai-warning Declared independently here and in `uploader/src/body-content.ts`
 * as `ImageMeta` (re-exported as `ImageDims` by `posts.ts`/`pages.ts`) — two
 * trees, two tsconfigs, so neither can import the other's canonical type. They
 * must widen TOGETHER: because the extra fields are optional, `tsc` and
 * `astro check` both stay green when only one side is widened, and the failure
 * mode is galleries rendering with empty alt and no captions on a green build.
 * `uploader/test/body-content.test.ts` now pins the two shapes together with a
 * compile-time key-set + mutual-assignability assertion, so that drift fails
 * the build — but the assertion lives in the uploader tree, which means a
 * `site`-only check (`astro check` alone) still will not catch it.
 */
export interface ImageDims { width: number; height: number; alt?: string; caption?: string }
const SIZES = '(min-width: 768px) 720px, 100vw';
/**
 * Conservative bound: the gallery grid is capped at ~3 columns inside the
 * story's `max-w-3xl` (48rem) column, so a photo is never wider than ~360 CSS
 * px on desktop. Deliberately not derived from a build-time column count —
 * the browser re-flows the grid at any width.
 */
const GALLERY_SIZES = '(min-width: 768px) 360px, 100vw';

// Tuned from the GitHub-safe default: it still strips <script>, inline event
// handlers, javascript: URLs and iframe/object/svg, but preserves the benign
// markup Astro emits so the page doesn't visibly regress —
//  • clobberPrefix:'' keeps heading `id`s un-prefixed so <Toc> #slug anchors resolve
//  • `id`/`className` are allowed so heading anchors and code classes survive
//  • `style` is allowed only on code spans (Shiki inline syntax colors)
const baseAttrs = defaultSchema.attributes ?? {};
const BODY_SCHEMA = {
  ...defaultSchema,
  clobberPrefix: '',
  attributes: {
    ...baseAttrs,
    '*': [...(baseAttrs['*'] ?? []), 'id', 'className'],
    span: [...(baseAttrs.span ?? []), 'style'],
    code: [...(baseAttrs.code ?? []), 'className', 'style'],
    pre: [...(baseAttrs.pre ?? []), 'className', 'style'],
  },
};

/** hast <figure><picture>…</figure> mirroring BodyImage → RemoteImage output. */
function pictureNode(image: RemoteHeroImage) {
  return h('figure', { class: 'my-8' }, [
    h('picture', [
      h('source', { type: 'image/avif', srcset: srcset(image, 'avif'), sizes: SIZES }),
      h('source', { type: 'image/webp', srcset: srcset(image, 'webp'), sizes: SIZES }),
      h('img', {
        src: fallbackSrc(image),
        alt: image.alt,
        width: image.width,
        height: image.height,
        loading: 'lazy',
        decoding: 'async',
        class: 'block w-full rounded-lg',
      }),
    ]),
  ]);
}

/** The largest variant that exists for a photo — the no-JS "open full size" target. */
function largestVariant(image: RemoteHeroImage): string {
  const widths = variantWidths(image.width);
  return `${image.src}-${widths[widths.length - 1]}.webp`;
}

/**
 * Is this the `<pre><code class="language-gallery">` a ```gallery fence
 * survives sanitize as? (See MARKDOWN_OPTIONS in render-markdown.ts for why
 * the class is still there.)
 */
function galleryCode(node: { tagName: string; children: unknown[] }): { children: unknown[] } | null {
  if (node.tagName !== 'pre') return null;
  const kids = (node.children as { type: string; value?: string }[])
    .filter((c) => !(c.type === 'text' && /^\s*$/.test(c.value ?? '')));
  const only = kids.length === 1 ? kids[0] : undefined;
  if (!only || only.type !== 'element') return null;
  const code = only as unknown as { tagName: string; properties?: { className?: unknown }; children: unknown[] };
  if (code.tagName !== 'code') return null;
  const cls = code.properties?.className;
  const names = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : [];
  return names.includes('language-gallery') ? code : null;
}

/** Concatenated text of a hast subtree — the fence's raw lines. */
function textOf(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  return (n.children ?? []).map(textOf).join('');
}

/**
 * Build the photo grid for one ```gallery fence.
 *
 * @ai-warning This node is injected AFTER rehypeSanitize (like pictureNode),
 * so it inherits NONE of the sanitizer's protections — and unlike pictureNode,
 * whose `src` comes off a hast <img> the sanitizer already protocol-checked,
 * these URLs arrive as plain TEXT content that sanitize never looks at. The
 * three guards below are therefore load-bearing, not defensive:
 *
 *  1. URLs are allow-listed by ORIGIN EQUALITY. Never prefix-match the base
 *     URL: `raw.startsWith('https://img.simonswanderlust.com')` passes both
 *     `https://img.simonswanderlust.com.evil.com/x` (origin …com.evil.com) and
 *     `https://img.simonswanderlust.com@evil.com/x` (origin https://evil.com).
 *     A `javascript:` line lands in the <a href> below and fires — and
 *     GET /posts/:tk/preview renders this same transform at author level,
 *     same-origin with /admin/* and with no CSP.
 *  2. alt/caption are coerced with String(). The images map is untyped JSON,
 *     and hastscript treats a node-shaped object in a children array AS A NODE
 *     — `{type:'raw', value:'<script>…'}` would emit a live script tag,
 *     because the stringifier runs with allowDangerousHtml.
 *  3. Dimensions are checked before any arithmetic reaches markup.
 *
 * Nothing disappears silently: a URL with no `images` entry is skipped, and if
 * that leaves the gallery empty the caller keeps the original sanitized <pre>.
 */
function galleryNode(
  fenceText: string,
  images: Record<string, ImageDims>,
  imageOrigin: string,
): ReturnType<typeof h> | null {
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(imageOrigin).origin;
  } catch {
    return null; // no usable origin ⇒ allow nothing
  }
  const items: ReturnType<typeof h>[] = [];
  for (const line of fenceText.split('\n')) {
    // Tolerate the export format's `url | 3000x2000 | alt="…"` trailing
    // metadata: normalizeBodyImages lifts it into `images` on save, but a body
    // that never went through that chokepoint should still render.
    const raw = (line.split('|', 1)[0] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.origin !== allowedOrigin) continue;
    const d = images[raw];
    if (!d) continue;
    const w = d.width;
    const hgt = d.height;
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(hgt) || hgt <= 0) continue;
    const alt = String(d.alt ?? '');
    const caption = String(d.caption ?? '');
    const image: RemoteHeroImage = { src: raw, alt, width: w, height: hgt };
    items.push(h('figure', { class: 'jgal__item' }, [
      h('a', { href: largestVariant(image) }, [
        h('picture', [
          h('source', { type: 'image/avif', srcset: srcset(image, 'avif'), sizes: GALLERY_SIZES }),
          h('source', { type: 'image/webp', srcset: srcset(image, 'webp'), sizes: GALLERY_SIZES }),
          h('img', {
            src: fallbackSrc(image),
            alt,
            width: w,
            height: hgt,
            loading: 'lazy',
            decoding: 'async',
          }),
        ]),
      ]),
      ...(caption === '' ? [] : [h('figcaption', { class: 'jgal__cap' }, caption)]),
    ]));
  }
  if (items.length === 0) return null;
  // `not-prose` opts the grid out of @tailwindcss/typography, which would
  // otherwise apply its own figure/figcaption margins inside StoryPage's
  // `prose` article and fight the grid gap.
  return h('div', { class: 'jgal not-prose' }, items);
}

/**
 * @param imageOrigin the ONLY origin a gallery may reference — passed in
 *   explicitly rather than read from the environment, because this function
 *   runs both under `astro build` (where `import.meta.env` exists) and under
 *   the uploader's tsx runtime via `preview.ts` (where it does not). Keep it
 *   pure and env-free.
 */
export function transformBodyImages(
  html: string,
  images: Record<string, ImageDims>,
  imageOrigin: string,
): string {
  // @ai-warning: post body HTML is rendered from DB-stored Markdown authored
  // through the admin editor (untrusted-ish). Sanitize it FIRST — stripping
  // <script>, inline event handlers, and javascript: URLs — then inject our own
  // trusted <picture> nodes, so the injected nodes keep their srcset/loading
  // attributes while the body itself can't carry stored XSS to the public site.
  const parser = unified().use(rehypeParse, { fragment: true }).use(rehypeSanitize, BODY_SCHEMA);
  const tree = parser.runSync(parser.parse(html));
  visit(tree, 'element', (node, index, parent) => {
    if (index === null || index === undefined || !parent) return;
    if (node.tagName === 'pre') {
      const code = galleryCode(node);
      if (!code) return;
      const gallery = galleryNode(textOf(code), images, imageOrigin);
      // No resolvable photo ⇒ keep the sanitized <pre> so the URLs stay
      // visible rather than the block vanishing without a trace.
      if (!gallery) return SKIP;
      parent.children[index] = gallery;
      return SKIP;
    }
    if (node.tagName === 'p') {
      const kids = node.children.filter((c) => !(c.type === 'text' && /^\s*$/.test((c as { value: string }).value)));
      const only = kids.length === 1 ? kids[0] : undefined;
      if (only && only.type === 'element' && (only as { tagName: string }).tagName === 'img') {
        const imgNode = only as typeof node;
        const src = imgNode.properties?.src as string | undefined;
        if (src && images[src]) {
          const d = images[src];
          const alt = (imgNode.properties?.alt as string) ?? '';
          parent.children[index] = pictureNode({ src, alt, width: d.width, height: d.height });
          return SKIP;
        }
      }
      return;
    }
    if (node.tagName === 'img') {
      const src = node.properties?.src as string | undefined;
      if (!src || !images[src]) return;
      const d = images[src];
      const alt = (node.properties?.alt as string) ?? '';
      parent.children[index] = pictureNode({ src, alt, width: d.width, height: d.height });
    }
  });
  return unified().use(rehypeStringify, { allowDangerousHtml: true }).stringify(tree);
}
