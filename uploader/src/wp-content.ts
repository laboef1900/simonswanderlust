import TurndownService from 'turndown';
import { escapeMeta } from './body-content.js';

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
td.remove(['script', 'style', 'noscript', 'iframe']);

/**
 * Elementor renders a gallery as bare `<a href="photo.jpg">` anchors carrying
 * the real image only in `href` — the inner `<img>` either points at
 * `elementor/assets/images/placeholder.png` or is absent entirely, because the
 * widget swaps it in client-side. Turndown's stock rules therefore reduce a
 * 46-photo gallery to 46 empty `[](url)` links and the import's re-host pass
 * (which matches `![alt](url)`) never sees them.
 *
 * @ai-warning: the grouping and the alt text come from Elementor's own
 * attributes, not from adjacency or guesswork — `data-elementor-lightbox-slideshow`
 * is the widget's gallery id and `data-elementor-lightbox-title` its caption.
 * Measured against the 2026-06-24 export: 1394/1394 upload anchors carried both.
 * An anchor missing the slideshow id is deliberately left to the stock link
 * rule — it is a normal link to a file, not a gallery member.
 */
const MARK = '\u0000';

interface GalleryItem { group: string; href: string; title: string }

td.addRule('elementorLightboxGallery', {
  filter: (node) =>
    node.nodeName === 'A' &&
    node.getAttribute('data-elementor-lightbox-slideshow') !== null &&
    (node.getAttribute('href') ?? '') !== '',
  replacement: (_content, node) => {
    const el = node as unknown as { getAttribute(n: string): string | null };
    const group = el.getAttribute('data-elementor-lightbox-slideshow') ?? '';
    const href = el.getAttribute('href') ?? '';
    const title = el.getAttribute('data-elementor-lightbox-title') ?? '';
    return `\n${MARK}${group}${MARK}${href}${MARK}${title}${MARK}\n`;
  },
});

/** Collapse runs of adjacent marker lines sharing a slideshow id into one fence. */
function foldGalleries(md: string): string {
  const lineRe = new RegExp(`^${MARK}([^${MARK}]*)${MARK}([^${MARK}]*)${MARK}([^${MARK}]*)${MARK}$`);
  const out: string[] = [];
  let run: GalleryItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const lines = run.map((i) =>
      i.title === '' ? i.href : `${i.href} | alt="${escapeMeta(i.title)}"`,
    );
    out.push('```gallery', ...lines, '```');
    run = [];
  };
  for (const line of md.split('\n')) {
    const m = lineRe.exec(line.trim());
    if (m) {
      const item: GalleryItem = { group: m[1] ?? '', href: m[2] ?? '', title: m[3] ?? '' };
      if (run.length > 0 && run[0]!.group !== item.group) flush();
      run.push(item);
      continue;
    }
    if (line.trim() === '' && run.length > 0) continue; // blank lines inside a run
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Classic (pre-Elementor) WordPress shortcodes that would otherwise reach
 * Turndown as literal text and come out as escaped junk (`\[gallery ids="1,2"\]`)
 * — a post importing "clean" with its galleries silently gone.
 *
 * - `[gallery ids="1,2,3"]` becomes the same anchor shape Elementor's lightbox
 *   emits, so ONE gallery pipeline (`elementorLightboxGallery` + `foldGalleries`)
 *   handles both eras; ids with no attachment in the export are dropped, and a
 *   gallery that resolves to nothing (or has no `ids`, i.e. "all attached media",
 *   which the export cannot express) is left untouched rather than emitted empty.
 * - `[caption …]<img …> text[/caption]` becomes `<figure><img …><figcaption>text
 *   </figcaption></figure>`, which Turndown renders as the image followed by the
 *   caption as its own paragraph — nothing lost, no shortcode markup shown.
 */
export function expandShortcodes(html: string, attachments: ReadonlyMap<string, string>): string {
  let n = 0;
  return html
    .replace(/\[gallery\b([^\]]*)\]/g, (whole, attrs: string) => {
      const ids = /\bids\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
      if (!ids) return whole;
      const anchors = ids.split(',').map((id) => attachments.get(id.trim())).filter((u): u is string => Boolean(u));
      if (anchors.length === 0) return whole;
      const group = `wp-gallery-${++n}`;
      return anchors.map((href) => `<a data-elementor-lightbox-slideshow="${group}" href="${href}"></a>`).join('');
    })
    .replace(/\[caption\b[^\]]*\]([\s\S]*?)\[\/caption\]/g, (_whole, inner: string) => {
      const img = /<img\b[^>]*>/i.exec(inner);
      if (!img) return inner;
      const text = inner.slice(img.index + img[0].length).trim();
      return `<figure>${img[0]}${text ? `<figcaption>${text}</figcaption>` : ''}</figure>`;
    });
}

/** One inline image as Turndown wrote it, with the destination decoded back to the URL it encoded. */
export interface MarkdownImage {
  /** The exact source text, for `replaceAll`. */
  full: string;
  /** Alt text as written (still Markdown-escaped, so it can be re-emitted verbatim). */
  alt: string;
  /** The destination URL with CommonMark escapes and `<…>` removed. */
  url: string;
}

/**
 * Turndown escapes `(` `)` `<` `>` in a destination, wraps it in `<…>` when it
 * contains a space, appends ` "title"` when the `<img>` had one, and escapes
 * `]` (among others) in alt. Elementor sets `title` from the attachment title
 * — by default the filename — so a titled image is the COMMON single-image case.
 * A naive `!\[([^\]]*)\]\(([^)]+)\)` captured `src "title"` as the URL and the
 * re-host then fetched `…/x.jpg%20%22title%22` (issue #125).
 *
 * Grammar (CommonMark §6.4, restricted to what Turndown can produce):
 *   alt   = ( "\" any | [^\]\\] )*
 *   dest  = "<" [^<>\n]* ">"  |  ( "\" punct | [^\s()\\] | "(" … ")" )*   — one level of balanced parens
 *   title = optional, after whitespace: "…" | '…' | (…), with backslash escapes
 */
const IMAGE_RE = /!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>\n]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))*))(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/g;

export function markdownImages(md: string): MarkdownImage[] {
  const out: MarkdownImage[] = [];
  for (const m of md.matchAll(IMAGE_RE)) {
    // Backslash escapes apply to ASCII punctuation only (CommonMark §2.4); a
    // backslash before anything else is literal.
    const raw = m[2] ?? m[3] ?? '';
    const url = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    if (url) out.push({ full: m[0], alt: m[1] ?? '', url });
  }
  return out;
}

/** Convert post HTML to clean Markdown — turndown keeps the content tags
 *  (headings/paragraphs/lists/links/images) and drops wrapper divs/styles.
 *  `attachments` (WXR attachment id → URL) enables classic-shortcode expansion. */
export function htmlToMarkdown(html: string, attachments?: ReadonlyMap<string, string>): string {
  return foldGalleries(
    td
      .turndown(attachments ? expandShortcodes(html, attachments) : html)
      .replace(/^(-|\*|\+)\s{2,}/gm, '$1 ')  // normalise bullet indent: "- ·· item" → "- item"
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
}
