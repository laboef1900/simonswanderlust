import type { MarkdownHeading } from 'astro';
import type { Element } from 'hast';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';

const parser = unified().use(rehypeParse, { fragment: true });

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
 * "Top-level" is the shallowest depth among headings directly under the body
 * root, so a story written in `###` alone splits like one written in `##`.
 * Headings inside quotes or lists stay with their enclosing nodes. The root
 * headings must match the `id` and depth in the renderer's metadata; a mismatch
 * returns the body whole rather than cutting in a guessed place. Parsing only
 * locates source offsets: the already-sanitized HTML is never reserialized.
 */
export function splitOpening(html: string, headings: readonly MarkdownHeading[]): { opening: string; rest: string } {
  const whole = { opening: html, rest: '' };
  if (headings.length === 0) return whole;
  const tree = parser.parse(html);
  const rootHeadings = tree.children.filter((node): node is Element =>
    node.type === 'element' && /^h[1-6]$/.test(node.tagName));
  const metadataDepths = new Map(headings.map((heading) => [heading.slug, heading.depth]));
  let depth = Infinity;
  for (const node of rootHeadings) {
    const nodeDepth = Number(node.tagName[1]);
    if (metadataDepths.get(String(node.properties.id ?? '')) !== nodeDepth) return whole;
    depth = Math.min(depth, nodeDepth);
  }
  let cursor = 0;
  for (const node of rootHeadings) {
    if (Number(node.tagName[1]) !== depth) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return whole;
    if (html.slice(cursor, start).trim() !== '') {
      return { opening: html.slice(0, start), rest: html.slice(start) };
    }
    cursor = end;
  }
  return whole;
}
