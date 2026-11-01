import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { visit } from 'unist-util-visit';
import type { Element, RootContent } from 'hast';
import { STORY_BODY_SIZES, analyzeRenderedBody, bodyImageUses, transformBodyImages, transformBodyImagesWithUses, type ImageDims } from './body-images.js';
import { renderMarkdown } from './render-markdown.js';

const origin = 'https://images.example';
const options = { locale: 'en' as const, inlineSizes: STORY_BODY_SIZES };
const first = `${origin}/trips/first`;
const second = `${origin}/trips/second`;
const images = {
  [first]: { width: 1600, height: 1000, alt: 'Snapshot first', caption: 'Snapshot caption' },
  [second]: { width: 1200, height: 1800, alt: 'Snapshot second', caption: 'Fallback caption', format: 'jpeg' as const },
};
const fence = (lines: string) => `<pre><code class="language-gallery">${lines}\n</code></pre>`;
const text = (node: RootContent): string => node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : '';
function renderedPhotos(html: string) {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
  const photos: { href: string; alt: string; caption: string }[] = [];
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'figure' || !(node.properties.className as string[] | undefined)?.includes('jgal__item')) return;
    const photo = { href: '', alt: '', caption: '' };
    visit(node, 'element', (child: Element) => {
      if (child.tagName === 'a') photo.href = String(child.properties.href);
      if (child.tagName === 'img') photo.alt = String(child.properties.alt);
      if (child.tagName === 'figcaption') photo.caption = text(child);
    });
    photos.push(photo);
  });
  return photos;
}

describe('bodyImageUses renderer parity (C1/C5/C6)', () => {
  it.each(['column', 'breakout', 'slider'])('keeps exact repeated raw identities and effective descriptions in %s', async (mode) => {
    const html = fence(`#layout: ${mode}\n${first} | alt="Ignored line"\n${second}\n${first} | caption-override="Only here"\n${first} | caption-override=""`) +
      fence(`#layout: ${mode}\n#captions: hidden\n${first}\n${second} | caption-override="Hidden override"`);
    const library = new Map([[first, { alt: 'Current library', caption: 'Current caption' }]]);
    const expected = [
      { src: first, alt: 'Current library', caption: 'Current caption', captionFollowsLibrary: true },
      { src: second, alt: 'Snapshot second', caption: 'Fallback caption', captionFollowsLibrary: true },
      { src: first, alt: 'Current library', caption: null, captionFollowsLibrary: false },
      { src: first, alt: 'Current library', caption: null, captionFollowsLibrary: false },
      { src: first, alt: 'Current library', caption: null, captionFollowsLibrary: false },
      { src: second, alt: 'Snapshot second', caption: null, captionFollowsLibrary: false },
    ];
    expect(bodyImageUses(html, images, origin, library)).toEqual({ gallery: expected, inline: [] });
    const rendered = await transformBodyImages(html, images, origin, options, library);
    const observed = await transformBodyImagesWithUses(html, images, origin, options, library);
    expect(observed).toEqual({ html: rendered, gallery: expected });
    expect(renderedPhotos(rendered)).toEqual([
      { href: `${first}-1600.webp`, alt: 'Current library', caption: 'Current caption' },
      { href: `${second}-1200.jpeg`, alt: 'Snapshot second', caption: 'Fallback caption' },
      { href: `${first}-1600.webp`, alt: 'Current library', caption: 'Only here' },
      { href: `${first}-1600.webp`, alt: 'Current library', caption: '' },
      { href: `${first}-1600.webp`, alt: 'Current library', caption: '' },
      { href: `${second}-1200.jpeg`, alt: 'Snapshot second', caption: '' },
    ]);
  });

  it('preserves deliberate blank library text and empty inherited captions', async () => {
    const library = new Map([[first, { alt: '', caption: '' }]]);
    const html = fence(`${first} | alt="Cannot replace blank"\n${second}`);
    const uses = bodyImageUses(html, images, origin, library);
    expect(uses.gallery).toEqual([
      { src: first, alt: '', caption: '', captionFollowsLibrary: true },
      { src: second, alt: 'Snapshot second', caption: 'Fallback caption', captionFollowsLibrary: true },
    ]);
    expect(renderedPhotos(await transformBodyImages(html, images, origin, options, library)).map(({ alt, caption }) => ({ alt, caption })))
      .toEqual([{ alt: '', caption: '' }, { alt: 'Snapshot second', caption: 'Fallback caption' }]);
  });

  it('coerces untrusted text identically without admitting HTML nodes', async () => {
    const malformed = { [first]: { width: 1600, height: 1000, alt: 42, caption: { type: 'raw', value: '<script>bad</script>' } } } as unknown as Record<string, ImageDims>;
    const uses = bodyImageUses(fence(first), malformed, origin);
    expect(uses.gallery).toEqual([{ src: first, alt: '42', caption: '[object Object]', captionFollowsLibrary: true }]);
    expect(renderedPhotos(await transformBodyImages(fence(first), malformed, origin, options))[0]).toMatchObject({ alt: '42', caption: '[object Object]' });
  });

  it('handles escaped metadata through the real Markdown renderer', async () => {
    const html = await renderMarkdown(`\`\`\`gallery\n${first} | alt="Ignored" | caption-override="A & B"\n\`\`\``);
    expect(bodyImageUses(html, images, origin).gallery).toEqual([
      { src: first, alt: 'Snapshot first', caption: null, captionFollowsLibrary: false },
    ]);
    expect(renderedPhotos(await transformBodyImages(html, images, origin, options))[0]?.caption).toBe('A & B');
  });
});

describe('bodyImageUses guarded occurrence classification (C1/C7)', () => {
  it.each([
    ['zero width', { width: 0, height: 100 }],
    ['negative height', { width: 100, height: -1 }],
    ['fractional width', { width: 1.5, height: 100 }],
    ['fractional height', { width: 100, height: 1.5 }],
    ['NaN', { width: Number.NaN, height: 100 }],
    ['infinity', { width: 100, height: Number.POSITIVE_INFINITY }],
    ['string dimension', { width: '100', height: 100 }],
    ['missing dimension', { width: 100 }],
    ['non-JPEG format', { width: 100, height: 100, format: 'webp' }],
    ['null format', { width: 100, height: 100, format: null }],
  ])('drops %s in both classification and actual rendering', async (_name, dimensions) => {
    const invalid = { ...images, [first]: dimensions } as unknown as Record<string, ImageDims>;
    const html = fence(`${first}\n${second}\n${first}`);
    expect(bodyImageUses(html, invalid, origin).gallery.map((use) => use.src)).toEqual([second]);
    expect(renderedPhotos(await transformBodyImages(html, invalid, origin, options))).toHaveLength(1);
  });

  it.each([
    `${origin}.evil.example/trips/first`,
    'https://images.example@evil.example/trips/first',
    'http://images.example/trips/first',
    'javascript:alert(1)',
    '/trips/first',
    'not a URL',
  ])('rejects disallowed gallery URL %s, even with dimensions and library metadata', async (src) => {
    const map = { ...images, [src]: images[first]! };
    const html = fence(`${src}\n${first}`);
    expect(bodyImageUses(html, map, origin, new Map([[src, { alt: 'Invalid', caption: 'Invalid' }]])).gallery.map((use) => use.src)).toEqual([first]);
    expect(renderedPhotos(await transformBodyImages(html, map, origin, options))).toHaveLength(1);
  });

  it('does not classify missing map entries or invalid origins as gallery uses', async () => {
    expect(bodyImageUses(fence(first), {}, origin).gallery).toEqual([]);
    expect(bodyImageUses(fence(first), images, 'bad origin').gallery).toEqual([]);
    expect(await transformBodyImages(fence(first), {}, origin, options)).toContain('<pre>');
    expect(renderedPhotos(await transformBodyImages(fence(first), images, 'bad origin', options))).toEqual([]);
  });

  it('takes inline sources from the sanitized pre-transformation tree, never library text or gallery lines', () => {
    const html = `<p><img src="${first}-640.avif" alt="Inline"></p>` +
      `<img src="${second}" srcset="${second}-640.jpeg 640w, ${second}-1280.jpeg 1280w">` +
      '<img src="javascript:alert(1)"><script><img src="https://evil.example/photo"></script>' + fence(first);
    const uses = bodyImageUses(html, images, origin);
    expect(uses.inline).toEqual(analyzeRenderedBody(html).sources);
    expect(uses.inline).toContain(`${first}-640.avif`);
    expect(uses.inline).toContain(second);
    expect(uses.inline).not.toContain(first);
    expect(uses.inline.join(' ')).not.toMatch(/javascript:|evil\.example/);
    expect(uses.gallery).toHaveLength(1);
  });
});
