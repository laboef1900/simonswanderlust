import { describe, expect, it } from 'vitest';
import {
  escapeMeta, unescapeMeta, galleryFencesToMdx, imagesMapError, normalizeGalleryFences,
  type ImageMeta,
} from '../src/body-content.js';
import type { ImageDims } from '../../site/src/lib/body-images.js';

const A = 'https://img.example.com/trips/x/a-1a2b3c4d';
const B = 'https://img.example.com/trips/x/b-9f8e7d6c';
const fence = (lines: string) => '```gallery\n' + lines + '\n```';

// The `images` entry shape is declared independently in this tree
// (`ImageMeta`) and in the site tree (`ImageDims`) — separate tsconfigs, so
// neither can simply import the other's canonical definition. Because every
// added field is OPTIONAL, widening one side alone keeps BOTH `tsc` and
// `astro check` green, and the only symptom is galleries rendering with empty
// alt and no captions on a fully green build.
//
// preview.ts already imports across the boundary, so this can be a compile-time
// assertion rather than an @ai-warning comment.
//
// @ai-warning It takes BOTH checks below, and plain assignment is not one of
// them. Assigning each type to the other passes even when one side has grown an
// extra optional field — excess-property checking only applies to object
// literals, and an absent optional satisfies the other side — which is exactly
// the divergence this exists to catch. So:
//   · MUTUAL catches a changed or newly-required field (`alt: number`,
//     `alt: string` vs `alt?: string`), which key comparison alone would miss.
//   · SAME_KEYS catches an added OPTIONAL field, which assignability misses.
// Verified by breaking each direction in turn. Do not "simplify" this to one.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;

const SHAPES_MATCH: Mutual<ImageMeta, ImageDims> = true;
const KEYS_MATCH: SameKeys<ImageMeta, ImageDims> = true;

describe('ImageMeta ↔ site ImageDims stay structurally identical', () => {
  it('is enforced by the type-checker, not by a comment', () => {
    // The assertions are the two `const`s above — `true` stops being assignable
    // the moment the shapes drift. This body only keeps the suite honest about
    // them existing.
    expect([SHAPES_MATCH, KEYS_MATCH]).toEqual([true, true]);
  });
});

describe('imagesMapError', () => {
  it('accepts an absent, empty or well-formed map', () => {
    expect(imagesMapError(undefined)).toBeNull();
    expect(imagesMapError(null)).toBeNull();
    expect(imagesMapError({})).toBeNull();
    expect(imagesMapError({ [A]: { width: 3000, height: 2000 } })).toBeNull();
    expect(imagesMapError({ [A]: { width: 1, height: 1, alt: '', caption: 'x' } })).toBeNull();
  });

  it('rejects a non-object map', () => {
    expect(imagesMapError([])).toMatch(/must be an object/);
    expect(imagesMapError('x')).toMatch(/must be an object/);
  });

  it('rejects a non-object entry', () => {
    expect(imagesMapError({ [A]: null })).toMatch(/must be an object/);
    expect(imagesMapError({ [A]: [3000, 2000] })).toMatch(/must be an object/);
  });

  it('rejects dimensions that are not positive integers', () => {
    for (const dims of [
      { width: '1;} html{display:none}/*', height: 600 },
      { width: 800, height: 0 },
      { width: 1.5, height: 600 },
      { width: -1, height: 600 },
      { height: 600 },
    ]) {
      expect(imagesMapError({ [A]: dims })).toMatch(/positive integer/);
    }
  });

  it('rejects a node-shaped alt or caption — the hastscript injection vector', () => {
    expect(imagesMapError({ [A]: { width: 8, height: 6, alt: { type: 'raw', value: '<script>' } } }))
      .toMatch(/alt must be a string/);
    expect(imagesMapError({ [A]: { width: 8, height: 6, caption: { type: 'raw', value: '<script>' } } }))
      .toMatch(/caption must be a string/);
  });

  it('rejects oversize text', () => {
    expect(imagesMapError({ [A]: { width: 8, height: 6, alt: 'x'.repeat(1001) } })).toMatch(/at most/);
  });
});

describe('escapeMeta / unescapeMeta', () => {
  it('round-trips the characters the one-line format cannot carry raw', () => {
    const raw = 'a | b "c" <d> & e\nf';
    expect(unescapeMeta(escapeMeta(raw))).toBe(raw);
    expect(escapeMeta(raw)).not.toContain('|');
    expect(escapeMeta(raw)).not.toContain('"');
    expect(escapeMeta(raw)).not.toContain('\n');
  });

  it('round-trips a literal entity (& escaped first, decoded last)', () => {
    expect(unescapeMeta(escapeMeta('&quot; &#124;'))).toBe('&quot; &#124;');
  });
});

describe('normalizeGalleryFences', () => {
  it('lifts per-line metadata into the images map and bares the line', () => {
    const body = fence(`${A} | 3000x2000 | alt="Sunrise" | caption="Day 3"`);
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(fence(A));
    expect(out.images[A]).toEqual({ width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' });
  });

  it('decodes escaped alt/caption text', () => {
    const body = fence(`${A} | 800x600 | caption="a &#124; b &quot;c&quot; &lt;d&gt; &amp; e"`);
    const out = normalizeGalleryFences(body, {});
    expect(out.images[A]?.caption).toBe('a | b "c" <d> & e');
  });

  it('is idempotent — a normalized body passes through unchanged', () => {
    const first = normalizeGalleryFences(fence(`${A} | 800x600 | alt="x"`), {});
    const second = normalizeGalleryFences(first.bodyMarkdown, first.images);
    expect(second.bodyMarkdown).toBe(first.bodyMarkdown);
    expect(second.images).toEqual(first.images);
  });

  it('keeps existing dimensions when the line supplies only text', () => {
    const out = normalizeGalleryFences(fence(`${A} | alt="Later"`), { [A]: { width: 10, height: 20, caption: 'kept' } });
    expect(out.images[A]).toEqual({ width: 10, height: 20, alt: 'Later', caption: 'kept' });
    expect(out.bodyMarkdown).toBe(fence(A));
  });

  it('leaves an unresolvable line untouched rather than destroying what was typed', () => {
    const body = fence(`${A} | not-dimensions | alt="Typed"`);
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('leaves blank and #-comment lines alone', () => {
    const body = fence(`# my gallery\n\n${A} | 800x600`);
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(fence(`# my gallery\n\n${A}`));
  });

  it('ignores non-gallery fences', () => {
    const body = '```js\nconst a = 1 | 2;\n```';
    expect(normalizeGalleryFences(body, {}).bodyMarkdown).toBe(body);
  });

  it('handles several fences and several lines', () => {
    const body = `${fence(`${A} | 800x600`)}\n\ntext\n\n${fence(`${B} | 100x200`)}`;
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(`${fence(A)}\n\ntext\n\n${fence(B)}`);
    expect(Object.keys(out.images)).toEqual([A, B]);
  });

  // @ai-warning: this is how docs/authoring-workflow.md demonstrates the syntax
  // — a 4-backtick wrapper around a 3-backtick gallery example. Rewriting the
  // inner fence destroys the very dimensions and captions being demonstrated,
  // and the renderer never treats it as a gallery either (it is code, not a
  // block), so normalizing it is wrong on both counts.
  it('leaves a ```gallery example nested inside an outer fence completely alone', () => {
    const body = `\`\`\`\`\n\`\`\`gallery\n${A} | 3000x2000 | alt="Blick"\n\`\`\`\n\`\`\`\``;
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('leaves a gallery example nested inside a ~~~ fence alone', () => {
    const body = `~~~\n\`\`\`gallery\n${A} | 800x600\n\`\`\`\n~~~`;
    expect(normalizeGalleryFences(body, {}).bodyMarkdown).toBe(body);
  });

  // CommonMark lets a closing fence be LONGER than the opening one. The
  // renderer follows that rule, so a scanner that requires equal length would
  // render the block as a gallery while never normalizing it.
  it('closes on a longer fence, as CommonMark does', () => {
    const body = `\`\`\`gallery\n${A} | 800x600\n\`\`\`\`\n\ntext`;
    const out = normalizeGalleryFences(body, {});
    expect(out.bodyMarkdown).toBe(`\`\`\`gallery\n${A}\n\`\`\`\`\n\ntext`);
    expect(out.images[A]).toEqual({ width: 800, height: 600 });
  });

  it('does not treat text after an unterminated fence as a new gallery', () => {
    const body = `\`\`\`js\nconst a = 1;\n\n\`\`\`gallery\n${A} | 800x600`;
    expect(normalizeGalleryFences(body, {}).bodyMarkdown).toBe(body);
  });

  it('preserves CRLF line endings on a rewritten photo line', () => {
    const body = `\`\`\`gallery\r\n${A} | 800x600\r\n\`\`\`\r\n`;
    expect(normalizeGalleryFences(body, {}).bodyMarkdown).toBe(`\`\`\`gallery\r\n${A}\r\n\`\`\`\r\n`);
  });
});

describe('galleryFencesToMdx', () => {
  const images: Record<string, ImageMeta> = {
    [A]: { width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' },
    [B]: { width: 100, height: 200 },
  };

  it('re-attaches dimensions, alt and caption to each bare URL', () => {
    expect(galleryFencesToMdx(fence(A), images))
      .toBe(fence(`${A} | 3000x2000 | alt="Sunrise" | caption="Day 3"`));
  });

  it('omits absent alt/caption', () => {
    expect(galleryFencesToMdx(fence(B), images)).toBe(fence(`${B} | 100x200`));
  });

  it('leaves a URL with no images entry bare', () => {
    const body = fence('https://img.example.com/unknown');
    expect(galleryFencesToMdx(body, images)).toBe(body);
  });

  it('round-trips text containing the separator, quotes and a newline', () => {
    const hostile: Record<string, ImageMeta> = {
      [A]: { width: 8, height: 6, alt: 'a | b "c"', caption: '<d> & e\nsecond' },
    };
    const mdx = galleryFencesToMdx(fence(A), hostile);
    expect(mdx.split('\n')).toHaveLength(3); // fence open, one photo line, fence close
    expect(normalizeGalleryFences(mdx, {}).images[A]).toEqual(hostile[A]);
  });
});
