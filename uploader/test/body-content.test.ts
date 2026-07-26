import { describe, expect, it } from 'vitest';
import {
  escapeMeta, unescapeMeta, galleryFencesToMdx, imagesMapError, normalizeGalleryFences,
  type ImageMeta,
} from '../src/body-content.js';

const A = 'https://img.example.com/trips/x/a-1a2b3c4d';
const B = 'https://img.example.com/trips/x/b-9f8e7d6c';
const fence = (lines: string) => '```gallery\n' + lines + '\n```';

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
