import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Element } from 'hast';
import {
  ABOUT_BODY_SIZES, PREVIEW_BODY_SIZES, STORY_BODY_SIZES, STORY_OPENING_SIZES,
  resizeBodyImages, transformBodyImages,
} from './body-images.js';
import { COLUMN_WIDTH } from './gallery-layout.js';
import { renderMarkdown } from './render-markdown.js';

const html5 = unified().use(rehypeParse, { fragment: true }).use(rehypeStringify);

// Evaluate the emitted sizes clauses, not a parallel production slot calculator.
// Deliberately accept only rem/vw lengths and additive calc, with a 16px root.
function slot(sizes: string, viewport: number): number {
  for (const clause of sizes.split(',')) {
    const match = clause.trim().match(/^(?:\(min-width: ([\d.]+)rem\) )?(.+)$/);
    if (!match) throw new Error(`Unsupported sizes clause: ${clause}`);
    if (match[1] && viewport < Number(match[1]) * 16) continue;
    const expression = match[2]!.replace(/^calc\((.*)\)$/, '$1');
    const terms = [...expression.matchAll(/([+-]?)\s*([\d.]+)(rem|vw)/g)];
    if (terms.map(term => term[0]).join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) {
      throw new Error(`Unsupported sizes length: ${expression}`);
    }
    return terms.reduce((sum, term) => sum + (term[1] === '-' ? -1 : 1) * Number(term[2]) * (term[3] === 'rem' ? 16 : viewport / 100), 0);
  }
  throw new Error('No applicable source size');
}

describe('inline image layout envelopes', () => {
  it.each([
    [767, 727, 727], [768, 728, 728], [1023, 728, 728],
    [1024, 648, 984], [1095, 719, 1055], [1096, 720, 1056], [1152, 720, 1056],
  ])('matches opening/rest slots at viewport %i', (viewport, opening, rest) => {
    expect(slot(STORY_OPENING_SIZES, viewport)).toBeCloseTo(opening);
    expect(slot(STORY_BODY_SIZES, viewport)).toBeCloseTo(rest);
  });

  it('shares the CSS story measure and rail geometry with gallery COLUMN_WIDTH', () => {
    const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
    const wide = Number(css.match(/--container-story-wide:\s*([\d.]+)rem/)?.[1]) * 16;
    const rail = Number(css.match(/--container-story-rail:\s*([\d.]+)rem/)?.[1]) * 16;
    const gap = Number(css.match(/--container-story-column:\s*calc\(100% - var\(--container-story-rail\) - ([\d.]+)rem\)/)?.[1]) * 16;
    expect(wide).toBe(COLUMN_WIDTH);
    expect(slot(STORY_BODY_SIZES, 1600)).toBe(wide);
    expect(slot(STORY_OPENING_SIZES, 1600)).toBe(wide - rail - gap);
  });

  it.each([767, 768, 1023, 1024, 1095, 1096, 1152, 1600])('uses the current About grid at viewport %i', (viewport) => {
    const expected = viewport < 1024 ? viewport - 40 : (Math.min(viewport, 1152) - 88) * 2.2 / 3.2;
    expect(slot(ABOUT_BODY_SIZES, viewport)).toBeCloseTo(expected);
  });

  it.each([375, 735, 736, 767, 768, 1024, 1152])('fits standalone preview main at viewport %i', (viewport) => {
    expect(slot(PREVIEW_BODY_SIZES, viewport)).toBeCloseTo(Math.min(viewport, 736) - 40);
  });
});

describe('resizeBodyImages trusted generated-picture boundary', () => {
  const origin = 'https://img.test';
  const src = `${origin}/trips/inline/photo`;
  const images = { [src]: { width: 3000, height: 2000 } };

  it.each(['avif/webp', 'jpeg'] as const)('changes only generated inline source sizes for %s, preserving the whole surrounding DOM', async (format) => {
    const body = [
      `![Standalone](${src})`,
      `[![Linked](${src})](https://example.com/route \"Route\")`,
      `Before ![Mixed](${src}) after & text.`,
      `> ![Nested](${src})`,
      `<p>Author <picture data-body-image=\"\"><source srcset=\"${src}-640.jpeg 640w\" sizes=\"12rem\"><img src=\"${src}\" alt=\"Authored\"></picture> after</p>`,
      ...['column', 'breakout', 'slider'].map(mode => `\`\`\`gallery\n#layout: ${mode}\n${src}\n\`\`\``),
    ].join('\n\n');
    const input = await transformBodyImages(await renderMarkdown(body),
      format === 'jpeg' ? { [src]: { ...images[src]!, format: 'jpeg' } } : images,
      origin, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
    const expected = html5.parse(input);
    const pictures: Element[] = [];
    visit(expected, 'element', node => { if (node.tagName === 'picture') pictures.push(node); });
    const generated = pictures.filter(node => Object.hasOwn(node.properties, 'dataBodyImage'));
    expect(generated).toHaveLength(4);
    // The authored marker is stripped; the gallery pictures are never marked.
    expect(pictures.filter(node => !Object.hasOwn(node.properties, 'dataBodyImage'))).toHaveLength(4);
    for (const picture of generated) {
      for (const child of picture.children) {
        if (child.type === 'element' && child.tagName === 'source') child.properties.sizes = STORY_OPENING_SIZES;
      }
    }
    const actual = resizeBodyImages(input, STORY_OPENING_SIZES);
    expect(html5.stringify(html5.parse(actual))).toBe(html5.stringify(expected));
  });

  it('cannot promote an author marker to generated provenance', async () => {
    const input = `<picture data-body-image=\"\"><source srcset=\"${src}-640.jpeg 640w\" sizes=\"12rem\"><img src=\"${src}\" alt=\"Authored\"></picture>`;
    const output = await transformBodyImages(input, images, origin, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
    const tree = html5.parse(output);
    visit(tree, 'element', node => { expect(node.properties).not.toHaveProperty('dataBodyImage'); });
    expect(resizeBodyImages(output, STORY_OPENING_SIZES)).toBe(output);
  });

  it('leaves marker-free empty, ordinary and gallery-only HTML byte-for-byte alone', async () => {
    const gallery = await transformBodyImages('<pre><code class=\"language-gallery\">' + src + '</code></pre>', images, origin,
      { locale: 'en', inlineSizes: STORY_BODY_SIZES });
    for (const input of ['', '<p>Nothing &amp; more.</p>', gallery]) {
      expect(resizeBodyImages(input, STORY_OPENING_SIZES)).toBe(input);
    }
  });
});
