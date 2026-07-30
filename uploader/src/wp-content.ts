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

/** Convert post HTML to clean Markdown — turndown keeps the content tags
 *  (headings/paragraphs/lists/links/images) and drops wrapper divs/styles. */
export function htmlToMarkdown(html: string): string {
  return foldGalleries(
    td
      .turndown(html)
      .replace(/^(-|\*|\+)\s{2,}/gm, '$1 ')  // normalise bullet indent: "- ·· item" → "- item"
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
}
