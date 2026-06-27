import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';
import { srcset, fallbackSrc, type RemoteHeroImage } from './images.js';

export interface ImageDims { width: number; height: number }
const SIZES = '(min-width: 768px) 720px, 100vw';

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

export function transformBodyImages(html: string, images: Record<string, ImageDims>): string {
  // @ai-warning: post body HTML is rendered from DB-stored Markdown authored
  // through the admin editor (untrusted-ish). Sanitize it FIRST — stripping
  // <script>, inline event handlers, and javascript: URLs — then inject our own
  // trusted <picture> nodes, so the injected nodes keep their srcset/loading
  // attributes while the body itself can't carry stored XSS to the public site.
  const parser = unified().use(rehypeParse, { fragment: true }).use(rehypeSanitize, BODY_SCHEMA);
  const tree = parser.runSync(parser.parse(html));
  visit(tree, 'element', (node, index, parent) => {
    if (index === null || index === undefined || !parent) return;
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
