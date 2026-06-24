import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';
import { srcset, fallbackSrc, type RemoteHeroImage } from './images.js';

export interface ImageDims { width: number; height: number }
const SIZES = '(min-width: 768px) 720px, 100vw';

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
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
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
