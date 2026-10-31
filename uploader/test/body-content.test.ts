import { describe, expect, it } from 'vitest';
import {
  galleryFencesToMdx, imagesMapError, normalizeGalleryFences, rewriteOutsideGalleries, rewriteFences,
  heroImageError, escapeAltText, unescapeAltText, imageMarkdown,
  type ImageMeta,
} from '../src/body-content.js';
import { escapeMeta, unescapeMeta } from '../public/gallery-photo-line.js';
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
    expect(imagesMapError({ [A]: { width: 1, height: 1, format: 'jpeg' } })).toBeNull();
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

  it('rejects every supplied format except the exact JPEG marker', () => {
    for (const format of ['jpg', 'webp', 'avif', '', true]) {
      expect(imagesMapError({ [A]: { width: 8, height: 6, format } })).toMatch(/format must be "jpeg"/);
    }
  });
});

describe('heroImageError', () => {
  it('accepts an absent hero, the importer placeholder and a complete hero', () => {
    expect(heroImageError(undefined)).toBeNull();
    expect(heroImageError({ src: '', width: 0, height: 0, alt: '' })).toBeNull();
    expect(heroImageError({ src: A, width: 3000, height: 2000, alt: 'Sunrise' })).toBeNull();
    expect(heroImageError({ src: A, width: 3000, height: 2000, alt: 'Sunrise', format: 'jpeg' })).toBeNull();
  });

  it('rejects a non-object or a non-string src/alt', () => {
    expect(heroImageError(null)).toMatch(/must be an object/);
    expect(heroImageError([A])).toMatch(/must be an object/);
    expect(heroImageError({ src: A, width: 1, height: 1, alt: { type: 'raw', value: '<script>' } })).toMatch(/alt must be a string/);
    expect(heroImageError({ src: 7, width: 1, height: 1, alt: '' })).toMatch(/src must be a string/);
  });

  it('caps alt like gallery text — a runaway suggestion is refused, not saved', () => {
    expect(heroImageError({ src: A, width: 1, height: 1, alt: 'x'.repeat(1000) })).toBeNull();
    expect(heroImageError({ src: A, width: 1, height: 1, alt: 'x'.repeat(1001) })).toMatch(/at most 1000/);
  });

  it('rejects dimensions that are not non-negative integers', () => {
    for (const dims of [{ width: -1, height: 1 }, { width: 1.5, height: 1 }, { width: '3000', height: 1 }, { width: 1, height: NaN }]) {
      expect(heroImageError({ src: A, alt: '', ...dims })).toMatch(/non-negative integer/);
    }
  });

  it('rejects a malformed hero format instead of treating it as modern', () => {
    expect(heroImageError({ src: A, width: 1, height: 1, alt: '', format: 'jpg' }))
      .toMatch(/format must be "jpeg"/);
  });
});

describe('escapeAltText / imageMarkdown', () => {
  it('escapes the three characters that can end or alter a label, and inverts exactly', () => {
    const raw = 'Blick vom Gipfel [Norwegen] \\ back';
    expect(escapeAltText(raw)).toBe('Blick vom Gipfel \\[Norwegen\\] \\\\ back');
    expect(unescapeAltText(escapeAltText(raw))).toBe(raw);
    expect(imageMarkdown(raw, A)).toBe(`![Blick vom Gipfel \\[Norwegen\\] \\\\ back](${A})`);
  });

  it('leaves an alt without brackets byte-identical', () => {
    expect(imageMarkdown('Old town at dusk', A)).toBe(`![Old town at dusk](${A})`);
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
  it('lifts per-line metadata into the images map and bares the line', async () => {
    const body = fence(`${A} | 3000x2000 | alt="Sunrise" | caption="Day 3"`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(fence(A));
    expect(out.images[A]).toEqual({ width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' });
  });

  it('lifts and preserves the JPEG-only marker', async () => {
    const body = fence(`${A} | 3000x2000 | format="jpeg" | alt="Sunrise"`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(fence(A));
    expect(out.images[A]).toEqual({ width: 3000, height: 2000, format: 'jpeg', alt: 'Sunrise' });
    expect((await galleryFencesToMdx(out.bodyMarkdown, out.images))).toContain('format="jpeg"');
  });

  it('decodes escaped alt/caption text', async () => {
    const body = fence(`${A} | 800x600 | caption="a &#124; b &quot;c&quot; &lt;d&gt; &amp; e"`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.images[A]?.caption).toBe('a | b "c" <d> & e');
  });

  it('is idempotent — a normalized body passes through unchanged', async () => {
    const first = (await normalizeGalleryFences(fence(`${A} | 800x600 | alt="x"`), {}));
    const second = (await normalizeGalleryFences(first.bodyMarkdown, first.images));
    expect(second.bodyMarkdown).toBe(first.bodyMarkdown);
    expect(second.images).toEqual(first.images);
  });

  it('keeps existing dimensions when the line supplies only text', async () => {
    const out = (await normalizeGalleryFences(fence(`${A} | alt="Later"`), { [A]: { width: 10, height: 20, caption: 'kept' } }));
    expect(out.images[A]).toEqual({ width: 10, height: 20, alt: 'Later', caption: 'kept' });
    expect(out.bodyMarkdown).toBe(fence(A));
  });

  it('leaves an unresolvable line untouched rather than destroying what was typed', async () => {
    const body = fence(`${A} | not-dimensions | alt="Typed"`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('leaves blank and #-comment lines alone', async () => {
    const body = fence(`# my gallery\n\n${A} | 800x600`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(fence(`# my gallery\n\n${A}`));
  });

  it('ignores non-gallery fences', async () => {
    const body = '```js\nconst a = 1 | 2;\n```';
    expect((await normalizeGalleryFences(body, {})).bodyMarkdown).toBe(body);
  });

  it('handles several fences and several lines', async () => {
    const body = `${fence(`${A} | 800x600`)}\n\ntext\n\n${fence(`${B} | 100x200`)}`;
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(`${fence(A)}\n\ntext\n\n${fence(B)}`);
    expect(Object.keys(out.images)).toEqual([A, B]);
  });

  // @ai-warning: this is how docs/authoring-workflow.md demonstrates the syntax
  // — a 4-backtick wrapper around a 3-backtick gallery example. Rewriting the
  // inner fence destroys the very dimensions and captions being demonstrated,
  // and the renderer never treats it as a gallery either (it is code, not a
  // block), so normalizing it is wrong on both counts.
  it('leaves a ```gallery example nested inside an outer fence completely alone', async () => {
    const body = `\`\`\`\`\n\`\`\`gallery\n${A} | 3000x2000 | alt="Blick"\n\`\`\`\n\`\`\`\``;
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('leaves a gallery example nested inside a ~~~ fence alone', async () => {
    const body = `~~~\n\`\`\`gallery\n${A} | 800x600\n\`\`\`\n~~~`;
    expect((await normalizeGalleryFences(body, {})).bodyMarkdown).toBe(body);
  });

  // CommonMark lets a closing fence be LONGER than the opening one. The
  // renderer follows that rule, so a scanner that requires equal length would
  // render the block as a gallery while never normalizing it.
  it('closes on a longer fence, as CommonMark does', async () => {
    const body = `\`\`\`gallery\n${A} | 800x600\n\`\`\`\`\n\ntext`;
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(`\`\`\`gallery\n${A}\n\`\`\`\`\n\ntext`);
    expect(out.images[A]).toEqual({ width: 800, height: 600 });
  });

  it('does not treat text after an unterminated fence as a new gallery', async () => {
    const body = `\`\`\`js\nconst a = 1;\n\n\`\`\`gallery\n${A} | 800x600`;
    expect((await normalizeGalleryFences(body, {})).bodyMarkdown).toBe(body);
  });

  it('preserves CRLF line endings on a rewritten photo line', async () => {
    const body = `\`\`\`gallery\r\n${A} | 800x600\r\n\`\`\`\r\n`;
    expect((await normalizeGalleryFences(body, {})).bodyMarkdown).toBe(`\`\`\`gallery\r\n${A}\r\n\`\`\`\r\n`);
  });
});

describe('galleryFencesToMdx', () => {
  const images: Record<string, ImageMeta> = {
    [A]: { width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' },
    [B]: { width: 100, height: 200 },
  };

  it('re-attaches dimensions, alt and caption to each bare URL', async () => {
    expect((await galleryFencesToMdx(fence(A), images)))
      .toBe(fence(`${A} | 3000x2000 | alt="Sunrise" | caption="Day 3"`));
  });

  it('omits absent alt/caption', async () => {
    expect((await galleryFencesToMdx(fence(B), images))).toBe(fence(`${B} | 100x200`));
  });

  it('leaves a URL with no images entry bare', async () => {
    const body = fence('https://img.example.com/unknown');
    expect((await galleryFencesToMdx(body, images))).toBe(body);
  });

  it('round-trips text containing the separator, quotes and a newline', async () => {
    const hostile: Record<string, ImageMeta> = {
      [A]: { width: 8, height: 6, alt: 'a | b "c"', caption: '<d> & e\nsecond' },
    };
    const mdx = (await galleryFencesToMdx(fence(A), hostile));
    expect(mdx.split('\n')).toHaveLength(3); // fence open, one photo line, fence close
    expect((await normalizeGalleryFences(mdx, {})).images[A]).toEqual(hostile[A]);
  });
});

// Gallery-local caption controls (2026-10-19 spec). The override belongs to
// ONE occurrence of a photo in ONE gallery; the `images` map is keyed by URL,
// so lifting it there would leak it into every other gallery of that photo.
describe('gallery-local captions through save and export', () => {
  const override = (text: string) => `caption-override="${escapeMeta(text)}"`;

  it('keeps the override on its line and out of the images map', async () => {
    const body = fence(`${A} | 3000x2000 | alt="Sunrise" | caption="Day 3" | ${override('Only here')}`);
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(fence(`${A} | ${override('Only here')}`));
    expect(out.images[A]).toEqual({ width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' });
    expect(JSON.stringify(out.images)).not.toContain('Only here');
  });

  it('isolates the same URL in two galleries', async () => {
    const body = `${fence(`${A} | 800x600 | ${override('First gallery')}`)}\n\ntext\n\n${fence(A)}`;
    const out = (await normalizeGalleryFences(body, {}));
    expect(out.bodyMarkdown).toBe(`${fence(`${A} | ${override('First gallery')}`)}\n\ntext\n\n${fence(A)}`);
    expect(out.images[A]?.caption).toBeUndefined();
  });

  it('keeps an explicit empty override distinct from an absent one', async () => {
    const out = (await normalizeGalleryFences(fence(`${A} | 800x600 | caption-override=""\n${B} | 100x200`), {}));
    expect(out.bodyMarkdown).toBe(fence(`${A} | caption-override=""\n${B}`));
  });

  it('re-escapes HTML, quotes, separators and newlines canonically and caps the length', async () => {
    const hostile = '<img src=x onerror=alert(1)> | "q" & ```\n#captions: hidden';
    const out = (await normalizeGalleryFences(fence(`${A} | 800x600 | ${override(hostile)}`), {}));
    const line = out.bodyMarkdown.split('\n')[1] ?? '';
    expect(line).toBe(`${A} | ${override(hostile)}`);
    expect(line).not.toMatch(/[<>\n]/);
    expect(out.bodyMarkdown.split('\n')).toHaveLength(3);
    const long = (await normalizeGalleryFences(fence(`${A} | 800x600 | caption-override="${'x'.repeat(1200)}"`), {}));
    expect(long.bodyMarkdown).toBe(fence(`${A} | caption-override="${'x'.repeat(1000)}"`));
  });

  it('is idempotent over its own output, so re-saves change nothing', async () => {
    const first = (await normalizeGalleryFences(fence(`#captions: hidden\n${A} | 800x600 | ${override('a | b')}`), {}));
    const second = (await normalizeGalleryFences(first.bodyMarkdown, first.images));
    expect(second).toEqual(first);
    expect(first.bodyMarkdown).toContain('#captions: hidden');
  });

  it('leaves an override line with no resolvable dimensions untouched', async () => {
    const body = fence(`${A} | ${override('Typed')}`);
    expect((await normalizeGalleryFences(body, {})).bodyMarkdown).toBe(body);
  });

  it('exports the override last on the line and round-trips through save', async () => {
    const images: Record<string, ImageMeta> = { [A]: { width: 3000, height: 2000, alt: 'Sunrise', caption: 'Day 3' } };
    const stored = fence(`#captions: hidden\n${A} | ${override('Local "x" | y')}\n${A}\n${A} | caption-override=""`);
    const mdx = (await galleryFencesToMdx(stored, images));
    expect(mdx).toBe(fence([
      '#captions: hidden',
      `${A} | 3000x2000 | alt="Sunrise" | caption="Day 3" | ${override('Local "x" | y')}`,
      `${A} | 3000x2000 | alt="Sunrise" | caption="Day 3"`,
      `${A} | 3000x2000 | alt="Sunrise" | caption="Day 3" | caption-override=""`,
    ].join('\n')));
    const back = (await normalizeGalleryFences(mdx, {}));
    expect(back.bodyMarkdown).toBe(stored);
    expect(back.images).toEqual(images);
  });

  it('leaves a line that already carries other metadata to export as typed', async () => {
    const body = fence(`${A} | not-dimensions | ${override('Typed')}`);
    expect((await galleryFencesToMdx(body, { [A]: { width: 8, height: 6 } }))).toBe(body);
  });
});

describe('rewriteOutsideGalleries', () => {
  const mark = (text: string) => text.replace(/!\[x\]/g, 'IMG');

  it('hands every non-gallery run to the callback and returns gallery lines verbatim', async () => {
    const line = `${A} | caption-override="![x](${A})"`;
    const body = `![x](a)\n\n\`\`\`gallery\n#captions: hidden\n# ![x] note\n${line}\n\`\`\`\nmid ![x](b)\n${fence(`${B}`)}\r\n![x](c)`;
    expect((await rewriteOutsideGalleries(body, mark))).toBe(
      `IMG(a)\n\n\`\`\`gallery\n#captions: hidden\n# ![x] note\n${line}\n\`\`\`\nmid IMG(b)\n${fence(`${B}`)}\r\nIMG(c)`,
    );
  });

  it('treats an unterminated gallery as running to the end, like the renderer', async () => {
    const body = `![x](a)\n\`\`\`gallery\n${A} | caption-override="![x](a)"`;
    expect((await rewriteOutsideGalleries(body, mark))).toBe(`IMG(a)\n\`\`\`gallery\n${A} | caption-override="![x](a)"`);
  });

  it('does not protect a gallery example nested inside another fence — it is code, not a gallery', async () => {
    const body = `\`\`\`\`\n\`\`\`gallery\n![x](a)\n\`\`\`\n\`\`\`\``;
    expect((await rewriteOutsideGalleries(body, mark))).toBe(body.replace('![x]', 'IMG'));
  });

  it('returns the body unchanged when the callback is the identity', async () => {
    const body = `a\r\n${fence(`${A} | caption-override=""`)}\n\nb\n`;
    expect((await rewriteOutsideGalleries(body, (t) => t))).toBe(body);
  });
});

describe('gallery rewrite callback contracts', () => {
  it('invokes photo callbacks in source order while preserving ranges for length-changing edits', async () => {
    const body = `${fence(`${A}\n${B}`)}\n\nBetween\n\n${fence(A)}`;
    const seen: string[] = [];
    const out = await rewriteFences(body, (line) => {
      seen.push(line);
      return `${line} | caption-override="Photo ${seen.length}"`;
    });
    expect(seen).toEqual([A, B, A]);
    expect(out).toBe(`${fence(`${A} | caption-override="Photo 1"\n${B} | caption-override="Photo 2"`)}\n\nBetween\n\n${fence(`${A} | caption-override="Photo 3"`)}`);
  });

  it('awaits outside callbacks in source order without editing gallery text', async () => {
    const body = `Before\n\n${fence(A)}\n\nAfter`;
    const seen: string[] = [];
    const out = await rewriteOutsideGalleries(body, async (text) => {
      await Promise.resolve();
      seen.push(text);
      return text.replace('Before', 'First').replace('After', 'Last');
    });
    expect(seen.join('')).toContain('Before');
    expect(seen.join('')).toContain('After');
    expect(seen.join('')).not.toContain(A);
    expect(out).toBe(`First\n\n${fence(A)}\n\nLast`);
  });
});
