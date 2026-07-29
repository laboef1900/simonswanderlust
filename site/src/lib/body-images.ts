import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';
import { srcset, fallbackSrc, largestVariant, type RemoteHeroImage } from './images.js';
import {
  BREAKOUT_WIDTH,
  ROW_GAP,
  containerWidthFor,
  partitionRows,
  readLayoutMode,
  type GalleryMode,
} from './gallery-layout.js';

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
 * Viewport below which the CSS container query stacks a justified row to one
 * photo per line. MUST match the `@container` breakpoint in global.css — a
 * disagreement only costs a wrong `sizes` hint, never a broken layout.
 */
const STACK_WIDTH = 600;

/**
 * `sizes` for one photo in a justified row, from the build-time partition.
 *
 * Three clauses, because the photo's rendered width has three regimes:
 *  - at or above the design width the gallery stops growing, so the width is a
 *    fixed pixel value;
 *  - between the stack breakpoint and the design width the whole row scales,
 *    so the photo keeps its SHARE of the container — accurate throughout, and
 *    an over-estimate rather than an under-estimate, since the container is
 *    narrower than the viewport;
 *  - below the stack breakpoint each photo is full width.
 *
 * Deriving this per photo (rather than one conservative constant for the whole
 * gallery) is what keeps a lone full-width panorama from being served a 640px
 * variant while a 3-up row is served 1920px ones.
 */
function rowSizes(photoWidth: number, containerWidth: number): string {
  const px = Math.round(photoWidth);
  const share = Math.max(1, Math.round((photoWidth / containerWidth) * 100));
  return `(min-width: ${containerWidth}px) ${px}px, (min-width: ${STACK_WIDTH}px) ${share}vw, 100vw`;
}

/**
 * `sizes` for a slider tile. Slides per view is a fixed 3/2/1 at the
 * breakpoints in global.css, so the tile width follows directly.
 */
const SLIDER_SIZES =
  `(min-width: ${BREAKOUT_WIDTH}px) ${Math.round((BREAKOUT_WIDTH - 2 * ROW_GAP) / 3)}px, ` +
  '(min-width: 900px) 33vw, (min-width: 600px) 50vw, 100vw';

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
 *
 * @ai-warning The `<a href>` below is exactly the sink guard 1 exists for, and
 * #66 made it load-bearing twice over: the lightbox island reads that href back
 * out of the DOM. Every photo reaching the item builder has already passed all
 * three guards — do not move item construction above them, and do not relax
 * them for a layout mode.
 */
type GalleryPhoto = { image: RemoteHeroImage; caption: string };

/** Photos a fence resolves to, in order, after the three guards above. */
function galleryPhotos(
  fenceText: string,
  images: Record<string, ImageDims>,
  allowedOrigin: string,
): GalleryPhoto[] {
  const photos: GalleryPhoto[] = [];
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
    photos.push({ image: { src: raw, alt, width: w, height: hgt }, caption });
  }
  return photos;
}

/** One `<figure>` — the same item markup in every layout mode. */
function itemNode(
  { image, caption }: GalleryPhoto,
  sizes: string,
  style?: string,
): ReturnType<typeof h> {
  return h('figure', { class: 'jgal__item', ...(style ? { style } : {}) }, [
    h('a', { href: largestVariant(image) }, [
      h('picture', [
        h('source', { type: 'image/avif', srcset: srcset(image, 'avif'), sizes }),
        h('source', { type: 'image/webp', srcset: srcset(image, 'webp'), sizes }),
        h('img', {
          src: fallbackSrc(image),
          alt: image.alt,
          width: image.width,
          height: image.height,
          loading: 'lazy',
          decoding: 'async',
        }),
      ]),
    ]),
    ...(caption === '' ? [] : [h('figcaption', { class: 'jgal__cap' }, caption)]),
  ]);
}

/** `breakout` / `column`: photos partitioned into justified rows at build time. */
function justifiedRows(photos: GalleryPhoto[], mode: Exclude<GalleryMode, 'slider'>) {
  const width = containerWidthFor(mode);
  const rows = partitionRows(photos.map((p) => p.image.width / p.image.height), width);
  // @ai-note Photos are re-associated with their ratios BY POSITION, which is
  // only sound because partitionRows cannot drop one here: galleryPhotos has
  // already rejected any photo whose width/height are not positive integers, so
  // every ratio is finite and positive and the partition's own guard never
  // fires. Feed it unvalidated dimensions and this slicing silently pairs each
  // photo with the wrong ratio from that point on.
  let taken = 0;
  return rows.map((row) => {
    const slice = photos.slice(taken, taken + row.ratios.length);
    taken += row.ratios.length;
    const rowWidth = (row.maxWidthFraction ?? 1) * width;
    const gaps = (row.ratios.length - 1) * ROW_GAP;
    const height = (rowWidth - gaps) / row.ratios.reduce((a, r) => a + r, 0);
    // A PERCENTAGE, not pixels: the cap tracks the row above it as the
    // container resizes. See GalleryRow.maxWidthFraction.
    const cap = row.maxWidthFraction;
    return h(
      'div',
      { class: 'jgal__row', ...(cap === null ? {} : { style: `--jgal-maxw:${(cap * 100).toFixed(2)}%` }) },
      slice.map((photo, i) => {
        const ratio = row.ratios[i] ?? 1;
        // `--r` drives `flex: calc(var(--r) * 100) 1 0`. The `* 100` is in the
        // CSS, not here: flex-grow values summing below 1 leave part of the row
        // unfilled (a lone portrait rendered 808px instead of 1112px).
        return itemNode(photo, rowSizes(ratio * height, width), `--r:${ratio.toFixed(4)}`);
      }),
    );
  });
}

/**
 * `slider`: a scroll-snap track of uniform tiles.
 *
 * @ai-note This mode CROPS — uniform tiles cannot preserve aspect ratio, which
 * is the opposite of what the justified modes exist to do. That is a deliberate
 * trade-off for a conventional carousel feel, and the reason the slider is one
 * mode of three rather than the only layout. Do not "fix" it by restoring
 * intrinsic ratios; that just makes it a worse justified row.
 *
 * The track is keyboard-scrollable on its own (`tabindex="0"` + `overflow-x`),
 * so the slider works with JavaScript off. The buttons ship `hidden` and are
 * revealed — and named — by the island, which is also why they are absolutely
 * positioned: neither state may move the layout, or CLS comes back.
 */
function sliderNode(photos: GalleryPhoto[]) {
  return [
    h('div', { class: 'jgal__track', tabindex: '0' }, photos.map((p) => itemNode(p, SLIDER_SIZES))),
    h('button', { type: 'button', class: 'jgal__nav jgal__nav--prev', hidden: true, 'data-jgal-nav': 'prev' }, '‹'),
    h('button', { type: 'button', class: 'jgal__nav jgal__nav--next', hidden: true, 'data-jgal-nav': 'next' }, '›'),
  ];
}

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
  const photos = galleryPhotos(fenceText, images, allowedOrigin);
  if (photos.length === 0) return null;
  const mode = readLayoutMode(fenceText);
  const children = mode === 'slider' ? sliderNode(photos) : justifiedRows(photos, mode);
  // `not-prose` opts the gallery out of @tailwindcss/typography, which would
  // otherwise apply its own figure/figcaption margins inside StoryPage's
  // `prose` article and fight the row arithmetic.
  return h('div', { class: `jgal jgal--${mode} not-prose` }, children);
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
