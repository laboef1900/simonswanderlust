import TurndownService from 'turndown';

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
td.remove(['script', 'style', 'noscript', 'iframe']);

/** Convert post HTML to clean Markdown — turndown keeps the content tags
 *  (headings/paragraphs/lists/links/images) and drops wrapper divs/styles. */
export function htmlToMarkdown(html: string): string {
  return td
    .turndown(html)
    .replace(/^(-|\*|\+)\s{2,}/gm, '$1 ')  // normalise bullet indent: "- ·· item" → "- item"
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
