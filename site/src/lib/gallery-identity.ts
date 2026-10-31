import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Element } from 'hast';

// The exact sanitize-first boundary used by rendering, publication and source
// analysis. Inline styles remain forbidden, including on author code (#124).
const baseAttrs = defaultSchema.attributes ?? {};
const BODY_SCHEMA = {
  ...defaultSchema,
  clobberPrefix: '',
  attributes: {
    ...baseAttrs,
    '*': [...(baseAttrs['*'] ?? []), 'id', 'className'],
  },
};

export function sanitizedBodyTree(html: string) {
  const parser = unified().use(rehypeParse, { fragment: true }).use(rehypeSanitize, BODY_SCHEMA);
  return parser.runSync(parser.parse(html));
}

/** Gallery identity belongs to the sanitized render tree, not a fence regex. */
export function galleryCode(node: Element): Element | null {
  if (node.tagName !== 'pre') return null;
  const kids = node.children.filter((child) => !(child.type === 'text' && /^\s*$/.test(child.value)));
  const code = kids.length === 1 ? kids[0] : undefined;
  if (!code || code.type !== 'element' || code.tagName !== 'code') return null;
  // Typed as a string array, but stay defensive for a hand-built tree.
  const cls: unknown = code.properties.className;
  const names = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : [];
  return names.includes('language-gallery') ? code : null;
}

export function textOf(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map((child) => textOf(child as Parameters<typeof textOf>[0])).join('');
}
