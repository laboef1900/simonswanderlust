import type { MarkdownHeading } from 'astro';

/**
 * Split a story's rendered body into its opening section and the rest.
 *
 * The opening is what sits beside the rail (contents, key facts, route map) on
 * a desktop: the first section — everything up to the first top-level heading
 * that has content before it. That reads a body that opens with its intro
 * heading (`## Odyssee` → intro → image → `## Anreise`) as one section, a body
 * that opens with bare paragraphs as those paragraphs, and a body whose first
 * headings are stacked with nothing between them (`## Ecuador: Cuyabeno` →
 * `## Jungle` → intro) as one opening rather than an empty one. The rest is
 * rendered centred and wider below the spread.
 *
 * "Top-level" is the shallowest depth the body uses, so a story written in
 * `###` alone splits like one written in `##`. Headings are located by the
 * `id` rehype-slug gave them, which is what `headings` carries; a body whose
 * markup does not match its metadata is returned whole rather than cut in a
 * guessed place.
 */
export function splitOpening(html: string, headings: readonly MarkdownHeading[]): { opening: string; rest: string } {
  const whole = { opening: html, rest: '' };
  if (headings.length === 0) return whole;
  const depth = Math.min(...headings.map((h) => h.depth));
  let cursor = 0;
  for (const heading of headings) {
    if (heading.depth !== depth) continue;
    const open = new RegExp(`<h${depth}\\b[^>]*\\bid="${heading.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    open.lastIndex = cursor;
    const match = open.exec(html);
    if (!match) return whole;
    if (html.slice(cursor, match.index).trim() !== '') {
      return { opening: html.slice(0, match.index), rest: html.slice(match.index) };
    }
    const close = html.indexOf(`</h${depth}>`, match.index);
    if (close === -1) return whole;
    cursor = close + `</h${depth}>`.length;
  }
  return whole;
}
