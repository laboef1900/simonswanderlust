import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';
import { STORY_BODY_SIZES, analyzeRenderedBody, transformBodyImages, type ImageDims } from './body-images.js';
import { escapeMeta } from '../../../uploader/public/gallery-photo-line.js';
import { renderMarkdown } from './render-markdown.js';
import { sanitizedBodyTree, textOf } from './gallery-identity.js';
import { splitOpening } from './story-opening.js';
import { SHIKI_CSS } from './shiki-classes.js';

const ORIGIN = 'https://img.simonswanderlust.com';
/** ```gallery survives sanitize as this — see MARKDOWN_OPTIONS in render-markdown.ts. */
const fence = (lines: string) => `<pre><code class="language-gallery">${lines}\n</code></pre>`;

describe('server-rendered gallery link names', () => {
  const src = `${ORIGIN}/trips/names/photo`;
  const stored = { [src]: { width: 3000, height: 2000, alt: 'Stale alt', caption: 'Stale caption' } };
  function elements(html: string, tag: string): Element[] {
    const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
    const nodes: Element[] = [];
    visit(tree, 'element', (node) => { if (node.tagName === tag) nodes.push(node); });
    return nodes;
  }

  for (const mode of ['column', 'breakout', 'slider'] as const) {
    for (const locale of ['de', 'en'] as const) {
      const positional = (current: number, total: number) => locale === 'de'
        ? `Foto ${current} von ${total} öffnen` : `Open photo ${current} of ${total}`;
      it(`${mode}/${locale}: uses resolved native alt, visible caption, then positional name`, async () => {
        for (const { alt, caption, controls, line, expected } of [
          { alt: '  Described photo  ', caption: 'Caption', expected: undefined },
          { alt: '', caption: 'Library caption', expected: 'Library caption' },
          { alt: ' \t ', caption: '  Visible caption  ', expected: 'Visible caption' },
          { alt: '', caption: '', expected: positional(1, 1) },
          { alt: ' \t ', caption: ' \n ', expected: positional(1, 1) },
          { alt: '', caption: 'Secret library caption', controls: '#captions: hidden',
            line: ' | caption-override="Secret override"', expected: positional(1, 1) },
          { alt: '', caption: 'Secret library caption', line: ' | caption-override=""', expected: positional(1, 1) },
          { alt: '', caption: 'Library caption', line: ' | caption-override="Local caption"', expected: 'Local caption' },
        ]) {
          const html = await transformBodyImages(fence([`#layout: ${mode}`, controls ?? '', src + (line ?? '')].join('\n')), stored, ORIGIN, { locale, inlineSizes: STORY_BODY_SIZES }, new Map([[src, { alt, caption }]]),);
          const [link] = elements(html, 'a');
          expect(link?.properties.ariaLabel).toBe(expected);
          expect(link?.properties.href).toBe(`${src}-3000.webp`);
          expect(elements(html, 'img')[0]?.properties.alt).toBe(alt);
          expect(html).not.toContain('Stale');
          expect(html).not.toContain('Secret');
        }
      });

      it(`${mode}/${locale}: counts only accepted photos, including duplicates, across rows and resets per gallery`, async () => {
        const foreign = 'https://img.simonswanderlust.com.evil.example/photo';
        const invalid = `${ORIGIN}/invalid`;
        const badFormat = `${ORIGIN}/bad-format`;
        const blank = { width: 3000, height: 2000, alt: '', caption: '' };
        const images: Record<string, ImageDims> = {
          [src]: blank, [foreign]: blank, [invalid]: { ...blank, width: 0 },
          [badFormat]: { ...blank, format: 'png' as unknown as 'jpeg' },
        };
        const accepted = Array.from({ length: 7 }, () => src);
        const html = await transformBodyImages(fence([`#layout: ${mode}`, foreign, accepted[0], `${ORIGIN}/missing`,
          invalid, badFormat, ...accepted.slice(1)].join('\n')) +
        fence(`#layout: ${mode}\n${src}`), images, ORIGIN, { locale, inlineSizes: STORY_BODY_SIZES });
        expect(elements(html, 'a').map((node) => node.properties.ariaLabel)).toEqual([
          ...accepted.map((_, index) => positional(index + 1, 7)), positional(1, 1),
        ]);
        expect(elements(html, 'a').every((node) => node.properties.href === `${src}-3000.webp`)).toBe(true);
        if (mode !== 'slider') {
          expect(elements(html, 'div').filter((node) =>
            (node.properties.className as string[]).includes('jgal__row')).length).toBeGreaterThan(2);
        }
      });

      it(`${mode}/${locale}: serializes hostile and non-string caption names as inert text`, async () => {
        const hostile = '"><img src=x onerror=alert(1)> & "quoted"';
        for (const caption of [hostile, { type: 'raw', value: '<script>alert(1)</script>' }]) {
          const html = await transformBodyImages(fence(`#layout: ${mode}\n${src}`), { [src]: { width: 800, height: 600, alt: '', caption: caption as unknown as string } }, ORIGIN, { locale, inlineSizes: STORY_BODY_SIZES });
          const [link] = elements(html, 'a');
          expect(link?.properties.ariaLabel).toBe(String(caption));
          expect(Object.keys(link?.properties ?? {}).sort()).toEqual(['ariaLabel', 'href']);
          expect(elements(html, 'img')).toHaveLength(1);
          expect(elements(html, 'script')).toHaveLength(0);
        }
        const body = ['```gallery', `#layout: ${mode}`,
          `${src} | caption-override="${escapeMeta(hostile)}"`, '```'].join('\n');
        const html = await transformBodyImages(await renderMarkdown(body), stored, ORIGIN, { locale, inlineSizes: STORY_BODY_SIZES }, new Map([[src, { alt: '', caption: 'Library' }]]));
        expect(elements(html, 'a')[0]?.properties.ariaLabel).toBe(hostile);
        expect(elements(html, 'img')).toHaveLength(1);
      });
    }
  }
});

describe('gallery library descriptions', () => {
  const src = `${ORIGIN}/trips/photo`;
  const stored = { [src]: { width: 1600, height: 1000, alt: 'Stored alt', caption: 'Stored caption' } };

  it('uses library text only for galleries, including deliberate clears', async () => {
    const html = fence(src) + `<p><img src="${src}" alt="Inline alt"></p>`;
    const metadata = new Map([[src, { alt: '', caption: '' }]]);
    const out = (await transformBodyImages(html, stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, metadata));
    expect(out).toContain('alt=""');
    expect(out).toContain('alt="Inline alt"');
    expect(out).not.toContain('Stored alt');
    expect(out).not.toContain('<figcaption');
    expect(stored[src].alt).toBe('Stored alt');
  });

  it('escapes library descriptions after sanitization and does not relax URL guards', async () => {
    const evil = 'https://img.simonswanderlust.com.evil.example/trips/photo';
    const metadata = new Map([
      [src, { alt: '" onerror="alert(1)', caption: '<script>alert(1)</script>' }],
      [evil, { alt: 'Foreign metadata', caption: 'Foreign caption' }],
    ]);
    const out = (await transformBodyImages(fence(`${src}\n${evil}`), { ...stored, [evil]: stored[src] }, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, metadata));
    expect(out).toContain('alt="&#x22; onerror=&#x22;alert(1)"');
    expect(out).toContain('&#x3C;script>alert(1)&#x3C;/script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('Foreign metadata');
  });
});

describe('gallery-local caption controls', () => {
  const src = `${ORIGIN}/trips/photo`;
  const stored = { [src]: { width: 1600, height: 1000, alt: 'Stored alt', caption: 'Stored caption' } };
  const library = new Map([[src, { alt: 'Library alt', caption: 'Library caption' }]]);
  const captions = (html: string) =>
    [...html.matchAll(/<figcaption class="jgal__cap">([^<]*)<\/figcaption>/g)].map((m) => m[1]);

  it('lets a line override win over the library, in that gallery only', async () => {
    const out = (await transformBodyImages(fence(`${src} | caption-override="Only here"`) + fence(src), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    // Same URL, two galleries: the second still follows the library.
    expect(captions(out)).toEqual(['Only here', 'Library caption']);
    // Alt is never taken from the line — it stays library-authoritative.
    expect(out).not.toContain('Stored alt');
    expect(out.match(/alt="Library alt"/g)).toHaveLength(2);
  });

  it('treats an empty override as a deliberate clear and a missing one as inherit', async () => {
    const out = (await transformBodyImages(fence(`${src} | caption-override=""\n${src}`), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(captions(out)).toEqual(['Library caption']);
    // No library row: inherit falls back to the stored caption.
    expect(captions((await transformBodyImages(fence(src), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES })))).toEqual(['Stored caption']);
  });

  it('applies no partial override from an invalid line but keeps existing photo and library precedence', async () => {
    for (const suffix of [
      'caption-override="Partial" | capton="bad"',
      'caption-override="raw | caption-override="suffix"',
      'alt = "invalid" | caption-override=""',
    ]) {
      const body = ['~~~gallery extra', `${src} | ${suffix}`, '~~~'].join('\n');
      const out = await transformBodyImages(await renderMarkdown(body), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library);
      expect(captions(out)).toEqual(['Library caption']);
      expect(out).toContain('alt="Library alt"');
      expect(out).not.toContain('Partial');
    }
    const repaired = ['~~~gallery', `${src} | caption-override="quote &quot; and pipe &#124;"`, '~~~'].join('\n');
    const out = await transformBodyImages(await renderMarkdown(repaired), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library);
    expect(captions(out)).toEqual(['quote " and pipe |']);
  });

  it('hides every caption of a #captions: hidden gallery, overrides included, and only that gallery', async () => {
    const hidden = fence(`#captions: hidden\n${src} | caption-override="Kept text"\n${src}`);
    const out = (await transformBodyImages(hidden + fence(src), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(captions(out)).toEqual(['Library caption']); // the second gallery only
    expect(out).not.toContain('Kept text');
    expect(out).not.toContain('#captions');
    // The lightbox reads `.jgal__cap` back out of each figure, so no figcaption = none there.
    expect((await transformBodyImages(hidden, stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library))).not.toContain('figcaption');
  });

  it('restores the retained override when the directive is removed', async () => {
    const out = (await transformBodyImages(fence(`${src} | caption-override="Kept text"`), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(captions(out)).toEqual(['Kept text']);
  });

  it('treats unknown values as visible and lets the first directive win', async () => {
    for (const directives of ['#captions: off', '#captions:', '#captions: shown\n#captions: hidden']) {
      const out = (await transformBodyImages(fence(`${directives}\n${src}`), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
      expect(captions(out)).toEqual(['Library caption']);
    }
    const out = (await transformBodyImages(fence(`#CAPTIONS : Hidden\n#captions: visible\n${src}`), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(out).not.toContain('figcaption');
  });

  it('renders HTML and fence syntax in an override as text, through the real Markdown pipeline', async () => {
    const hostile = 'a <img src=x onerror=alert(1)> & "q" | ```\nb';
    const body = ['```gallery', `${src} | caption-override="${escapeMeta(hostile)}"`, '```'].join('\n');
    const out = (await transformBodyImages(await renderMarkdown(body), stored, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(out).not.toContain('<img src="x"');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('<figcaption class="jgal__cap">a &#x3C;img src=x onerror=alert(1)> &#x26; "q" | ```\nb</figcaption>');
  });

  it('never lets an override smuggle a photo past the URL guards', async () => {
    const evil = 'https://img.simonswanderlust.com.evil.example/trips/photo';
    const out = (await transformBodyImages(fence(`${evil} | caption-override="Foreign"`), { [evil]: stored[src] }, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library));
    expect(out).not.toContain('jgal');
    expect(out).not.toContain('<figcaption');
  });
});

describe('transformBodyImages — sanitization', () => {
  it('strips <script> from author body HTML', async () => {
    const out = (await transformBodyImages('<p>hello</p><script>alert(1)</script>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('<script');
    expect(out).toContain('hello');
  });

  it('strips inline event handlers and javascript: URLs', async () => {
    const out = (await transformBodyImages('<img src="https://img/x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  // Issue #124: an author-typed style could overlay every reader page and
  // fire a third-party request per view. No element gets to keep one.
  it('strips inline style from every element, including the ones Shiki used to need it on', async () => {
    const out = (await transformBodyImages('<p style="position:fixed;inset:0;background:url(https://evil.example/px.png)">x</p>' +
      '<img src="https://img/x" style="width:100vw">' +
      '<span style="color:#abc">y</span>' +
      '<pre style="color:red"><code style="font-weight:bold">z</code></pre>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('style=');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<p>x</p>');
    expect(out).toContain('<span>y</span>');
  });

  it('keeps real code highlighting beside raw HTML without admitting author styles or handlers', async () => {
    const html = await renderMarkdown(
      '<div style="background:url(https://evil.example/pixel)" onclick="alert(1)">Opening</div>\n\n' +
      '```js\nconst answer = 42;\n```\n\n<script>alert(1)</script>',
    );
    const out = transformBodyImages(html, {}, ORIGIN);
    expect(out).toContain('Opening');
    expect(out).toContain('astro-code');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('evil.example');
    const classes = [...new Set(out.match(/\bsh-[a-z0-9-]+/g))];
    expect(classes).toContain('sh-bg-24292e');
    expect(classes.some((cls) => cls.startsWith('sh-c-'))).toBe(true);
    for (const cls of classes) expect(SHIKI_CSS).toContain(`.${cls}{`);
  });
});

describe('transformBodyImages — responsive images', () => {
  it('preserves the injected <picture> (with its attrs) for known body images', async () => {
    const out = (await transformBodyImages('<p><img src="https://img/x"></p>', { 'https://img/x': { width: 800, height: 600 } }, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('type="image/avif"');
    expect(out).toContain('srcset');
    expect(out).toContain('loading="lazy"');
  });

  it('leaves ordinary paragraphs intact', async () => {
    const out = (await transformBodyImages('<p>A normal <strong>paragraph</strong>.</p>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<strong>paragraph</strong>');
  });

  it('preserves heading ids un-prefixed so TOC #slug anchors still resolve', async () => {
    const out = (await transformBodyImages('<h2 id="etappe-1">Etappe 1</h2>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('id="etappe-1"');
    expect(out).not.toContain('user-content-');
  });

  it('keeps the classes a Shiki block carries in place of inline styles', async () => {
    const out = (await transformBodyImages('<pre class="astro-code github-dark sh-bg-24292e sh-c-e1e4e8"><code><span class="line"><span class="sh-c-f97583">const</span></span></code></pre>', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('class="astro-code github-dark sh-bg-24292e sh-c-e1e4e8"');
    expect(out).toContain('<span class="sh-c-f97583">const</span>');
  });
});

const images = { 'https://img/x/y': { width: 1600, height: 1067 } };

describe('transformBodyImages — responsive <picture>', () => {
  it('replaces a known <img> with a responsive <picture> inside a figure', async () => {
    const out = (await transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<figure class="my-8">');
    expect(out).toContain('<source type="image/avif"');
    expect(out).toContain('<source type="image/webp"');
    expect(out).toContain('https://img/x/y-1280.webp'); // fallback src
    expect(out).toContain('width="1600"');
    expect(out).toContain('height="1067"');
    expect(out).toContain('alt="A caption"');
    expect(out).toContain('class="block w-full rounded-lg"');
  });
  it('renders JPEG-only body images without inventing AVIF or WebP URLs', async () => {
    const src = 'https://img/x/jpeg-only';
    const out = (await transformBodyImages(`<p><img src="${src}" alt="JPEG"></p>`, { [src]: { width: 1600, height: 1067, format: 'jpeg' } }, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<source type="image/jpeg"');
    expect(out).toContain(`${src}-1280.jpeg`);
    expect(out).not.toContain(`${src}-640.avif`);
    expect(out).not.toContain(`${src}-640.webp`);
  });
  it('unwraps the <p> when a known <img> is its sole meaningful child', async () => {
    const out = (await transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<figure');
    expect(out).not.toMatch(/<p>\s*<figure/);
    expect(out).not.toContain('<img src="https://img/x/y"');
  });
  it('leaves an unknown image untouched', async () => {
    const out = (await transformBodyImages('<img src="https://other/z" alt="z">', {}, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<img src="https://other/z"');
  });
});

describe('transformBodyImages — valid image flow (#378)', () => {
  const src = `${ORIGIN}/trips/lake`;
  const stored = { [src]: { width: 3000, height: 2000 } };
  // rehype-parse uses the HTML5 parser (parse5). Compare using the renderer's
  // serializer on both sides, so spelling differences are not tree repairs.
  const html5 = unified().use(rehypeParse, { fragment: true }).use(rehypeStringify);
  const elements = (tree: Root | Element, tag: string): Element[] => {
    const found: Element[] = [];
    visit(tree, 'element', (node) => {
      if (node.tagName === tag) found.push(node);
    });
    return found;
  };
  function childTags(node: Root | Element): string[] {
    const tags: string[] = [];
    for (const child of node.children) {
      if (child.type === 'element') tags.push(child.tagName);
    }
    return tags;
  }
  async function render(body: string, imageMap: Record<string, ImageDims> = stored) {
    const out = await transformBodyImages(await renderMarkdown(body), imageMap, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
    const tree = html5.parse(out);
    expect(html5.stringify(tree)).toBe(out);
    for (const node of [...elements(tree, 'p'), ...elements(tree, 'a')]) {
      expect(textOf(node).trim() !== '' || elements(node, 'img').length > 0).toBe(true);
    }
    return tree;
  }
  function expectResponsive(tree: Root | Element, alts: string[], format?: 'jpeg') {
    const pictures = elements(tree, 'picture');
    expect(pictures).toHaveLength(alts.length);
    expect(elements(tree, 'img').map((image) => image.properties.alt)).toEqual(alts);
    for (const picture of pictures) {
      const formats = format === 'jpeg' ? ['jpeg'] : ['avif', 'webp'];
      expect(childTags(picture)).toEqual([...formats.map(() => 'source'), 'img']);
      const sources = elements(picture, 'source');
      expect(sources.map((source) => source.properties.type)).toEqual(formats.map((f) => `image/${f}`));
      sources.forEach((source, i) => {
        expect(source.properties.srcSet).toBe(
          [640, 1280, 1920, 3000].map((width) => `${src}-${width}.${formats[i]} ${width}w`).join(', '),
        );
      });
      expect(elements(picture, 'img')[0]?.properties).toMatchObject({
        src: `${src}-1280.${format ?? 'webp'}`,
        width: 3000, height: 2000, loading: 'lazy', decoding: 'async',
      });
    }
  }

  it('keeps the exact consecutive-image fixture in one paragraph without browser repair', async () => {
    const tree = await render(`![See](${src})\n![Zwei](${src})`);
    expect(childTags(tree)).toEqual(['p']);
    const paragraph = elements(tree, 'p')[0]!;
    expect(childTags(paragraph)).toEqual(['picture', 'picture']);
    expect(textOf(paragraph)).toBe('\n');
    expect(elements(tree, 'figure')).toHaveLength(0);
    expectResponsive(tree, ['See', 'Zwei']);
  });

  it('keeps both halves of the exact sentence fixture in their original paragraph', async () => {
    const tree = await render(`Vor dem Bild ![See](${src}) nach dem Bild.`);
    expect(childTags(tree)).toEqual(['p']);
    const paragraph = elements(tree, 'p')[0]!;
    expect(paragraph.children.map((child) => child.type === 'text' ? child.value : child.type)).toEqual([
      'Vor dem Bild ', 'element', ' nach dem Bild.',
    ]);
    expect(childTags(paragraph)).toEqual(['picture']);
    expect(elements(tree, 'figure')).toHaveLength(0);
    expectResponsive(tree, ['See']);
  });

  it('moves the exact standalone linked-image fixture into one named link inside a figure', async () => {
    const tree = await render(`[![See](${src})](https://example.com/)`);
    expect(childTags(tree)).toEqual(['figure']);
    expect(elements(tree, 'p')).toHaveLength(0);
    const figure = elements(tree, 'figure')[0]!;
    expect(childTags(figure)).toEqual(['a']);
    const links = elements(tree, 'a');
    expect(links).toHaveLength(1);
    expect(links[0]?.properties.href).toBe('https://example.com/');
    expect(childTags(links[0]!)).toEqual(['picture']);
    // A link with no text retains its original accessible name from the image.
    expectResponsive(links[0]!, ['See']);
  });

  it.each([false, true])('retains standalone whitespace and sanitized anchor attributes (linked: %s)', async (linked) => {
    const image = `<img src="${src}" alt="See &amp; Berge">`;
    const content = linked
      ? `<a href="https://example.com/?a=1&amp;b=2" title="Lake" lang="de"> \t${image} \n</a>`
      : image;
    const body = `<p> \n${content}\t </p>`;
    const original = sanitizedBodyTree(await renderMarkdown(body));
    const tree = await render(body);
    expect(childTags(tree)).toEqual(['figure']);
    expect(textOf(elements(tree, 'figure')[0]!)).toBe(textOf(elements(original, 'p')[0]!));
    expectResponsive(tree, ['See & Berge']);
    if (linked) {
      expect(elements(tree, 'a')).toHaveLength(1);
      expect(elements(tree, 'a')[0]?.properties).toMatchObject({
        href: 'https://example.com/?a=1&b=2', title: 'Lake', lang: 'de',
      });
    }
  });

  it.each([
    { body: `[Vor ![See](${src}) danach](https://example.com/)`, parent: 'a', text: 'Vor  danach' },
    { body: `Vor [![See](${src})](https://example.com/) danach`, parent: 'a', text: 'Vor  danach' },
    { body: `![See](${src})![Zwei](${src})`, parent: 'p', text: '', alts: ['See', 'Zwei'] },
    { body: `*![See](${src})*`, parent: 'em', text: '' },
    { body: `## Am ![See](${src})`, parent: 'h2', text: 'Am ' },
    { body: `> ![See](${src})`, parent: 'p', text: '' },
    { body: `- ![See](${src})`, parent: 'li', text: '' },
    { body: `- First\n\n  ![See](${src})`, parent: 'p', text: 'First' },
    { body: `<div><p><img src="${src}" alt="See"></p></div>`, parent: 'p', text: '' },
    { body: `<pre><span><img src="${src}" alt="See"></span></pre>`, parent: 'span', text: '' },
  ])('keeps phrasing content in its original $parent context: $body', async ({ body, parent, text, alts }) => {
    const tree = await render(body);
    expect(elements(tree, 'figure')).toHaveLength(0);
    expect(textOf(tree).trim()).toBe(text.trim());
    expectResponsive(tree, alts ?? ['See']);
    expect(elements(tree, parent).some((node) => childTags(node).includes('picture'))).toBe(true);
    if (body.includes('https://example.com/')) {
      expect(elements(tree, 'a')).toHaveLength(1);
      expect(elements(tree, 'a')[0]?.properties.href).toBe('https://example.com/');
    }
  });

  it('does not generate another figure for an authored figure', async () => {
    const body = `<figure><img src="${src}" alt="See"><figcaption>Caption</figcaption></figure>`;
    const original = sanitizedBodyTree(await renderMarkdown(body));
    const tree = await render(body);
    // The existing sanitizer unwraps author figure/figcaption; this change does
    // not expand that allowlist or reintroduce a figure around the surviving img.
    expect(childTags(tree)).toEqual(['picture']);
    expect(textOf(tree)).toBe(textOf(original));
    expectResponsive(tree, ['See']);
  });

  it('preserves an authored picture and its explicit source choices as a sanitized unit', async () => {
    const body = `<p>Before <a href="https://example.com/"><picture><source srcset="${src}-640.jpeg 640w, ${src}-1280.jpeg 1280w" media="(min-width: 600px)"><img src="${src}" alt="See" width="3000" height="2000" onerror="alert(1)"></picture></a> after</p>`;
    const input = await renderMarkdown(body);
    const tree = await render(body);
    const sanitized = sanitizedBodyTree(input);
    expect(html5.stringify(tree)).toBe(html5.stringify(sanitized));
    expect(childTags(tree)).toEqual(['p']);
    expect(elements(tree, 'picture')).toHaveLength(1);
    expect(elements(tree, 'source')).toHaveLength(1);
    expect(elements(tree, 'source')[0]?.properties.srcSet).toBe(`${src}-640.jpeg 640w, ${src}-1280.jpeg 1280w`);
    expect(elements(tree, 'img')[0]?.properties.src).toBe(src);
    expect(elements(tree, 'img')[0]?.properties.alt).toBe('See');
    expect(elements(tree, 'a')).toHaveLength(1);
    expect(analyzeRenderedBody(input).sources).toEqual([`${src}-640.jpeg`, `${src}-1280.jpeg`, src]);
    expect(analyzeRenderedBody(html5.stringify(tree))).toEqual(analyzeRenderedBody(input));
  });

  it.each([
    `![See](${src})`,
    `Before ![See](${src}) after`,
    `[![See](${src})](https://example.com/)`,
  ])('preserves JPEG-only source selection in each flow context: %s', async (body) => {
    const tree = await render(body, { [src]: { ...stored[src], format: 'jpeg' } });
    expectResponsive(tree, ['See'], 'jpeg');
  });

  it('keeps unknown images and unsupported stored formats untransformed', async () => {
    // JSON is the runtime boundary for persisted format values.
    const unsupported: ImageDims = JSON.parse('{"width":3000,"height":2000,"format":"png"}');
    const imageMaps: Record<string, ImageDims>[] = [{}, { [src]: unsupported }];
    for (const imageMap of imageMaps) {
      for (const body of [`![See](${src})`, `[![See](${src})](https://example.com/)`, `Before ![See](${src}) after`]) {
        const tree = await render(body, imageMap);
        expect(childTags(tree)).toEqual(['p']);
        expect(elements(tree, 'picture')).toHaveLength(0);
        expect(elements(tree, 'figure')).toHaveLength(0);
        expect(elements(tree, 'img')[0]?.properties).toMatchObject({ src, alt: 'See' });
      }
    }
  });

  it('moves only sanitized links and retains intentional decorative alt without inventing a name', async () => {
    const tree = await render(`<p><a href="javascript:alert(1)" onclick="alert(1)" style="position:fixed" title="Safe"><img src="${src}" alt="" onerror="alert(1)"></a></p>`);
    expect(childTags(tree)).toEqual(['figure']);
    expect(elements(tree, 'a')).toHaveLength(1);
    expect(elements(tree, 'a')[0]?.properties).toEqual({ title: 'Safe' });
    expectResponsive(tree, ['']);
    expect(elements(tree, 'img')[0]?.properties).not.toHaveProperty('onError');
    expect(elements(tree, 'script')).toHaveLength(0);
  });

  it('preserves the valid opening and remaining story through the consumer split', async () => {
    const tree = await render(`Vor dem Bild ![See](${src}) nach dem Bild.\n\n## Next\n\n[![See](${src})](https://example.com/)`);
    const html = html5.stringify(tree);
    const heading = elements(tree, 'h2')[0]!;
    const { opening, rest } = splitOpening(html, [
      { depth: 2, slug: String(heading.properties.id), text: 'Next' },
    ]);
    expect(opening + rest).toBe(html);
    expect(html5.stringify(html5.parse(opening))).toBe(opening);
    expect(html5.stringify(html5.parse(rest))).toBe(rest);
    expect(childTags(html5.parse(opening))).toEqual(['p']);
    expect(childTags(html5.parse(rest))).toEqual(['h2', 'figure']);
    expect(textOf(html5.parse(opening)).trim()).toBe('Vor dem Bild  nach dem Bild.');
    expect(elements(html5.parse(rest), 'a')).toHaveLength(1);
  });
});

const A = `${ORIGIN}/trips/patagonia/a-1a2b3c4d`;
const B = `${ORIGIN}/trips/patagonia/b-9f8e7d6c`;
/** Gallery items, however the active layout mode styles them. */
const items = (html: string) => html.match(/<figure class="jgal__item"/g) ?? [];
const gallery = {
  [A]: { width: 3000, height: 2000, alt: 'Sunrise over the towers', caption: 'Day 3' },
  [B]: { width: 2000, height: 3000, alt: 'The pass' },
};

describe('transformBodyImages — gallery fence', () => {
  it('turns a fence into a grid of figures', async () => {
    const out = (await transformBodyImages(fence(`${A}\n${B}`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<div class="jgal jgal--column not-prose">');
    expect(out).not.toContain('<pre>');
    expect(items(out)).toHaveLength(2);
    expect(out).toContain(`href="${A}-3000.webp"`); // largest variant, no-JS target
    expect(out).toContain('alt="Sunrise over the towers"');
    expect(out).toContain('<figcaption class="jgal__cap">Day 3</figcaption>');
    expect(out).toContain('width="2000"');
    expect(out).toContain('height="3000"');
  });

  it('keeps JPEG-only and modern gallery photos on their own generated formats', async () => {
    const mixed = {
      ...gallery,
      [A]: { ...gallery[A], format: 'jpeg' as const },
    };
    const out = (await transformBodyImages(fence(`${A}\n${B}`), mixed, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain(`href="${A}-3000.jpeg"`);
    expect(out).toContain(`${A}-1280.jpeg`);
    expect(out).not.toContain(`${A}-640.avif`);
    expect(out).not.toContain(`${A}-640.webp`);
    expect(out).toContain(`${B}-1280.webp`);
    expect(out).toContain(`${B}-640.avif`);
  });

  it('omits the figcaption when the photo has no caption', async () => {
    const out = (await transformBodyImages(fence(B), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('alt="The pass"');
    expect(out).not.toContain('figcaption');
  });

  it('ignores blank and #-prefixed lines and keeps line order', async () => {
    const out = (await transformBodyImages(fence(`# a comment\n\n${B}\n${A}`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('a comment');
    expect(out.indexOf(`${B}-`)).toBeLessThan(out.indexOf(`${A}-`));
  });

  it('tolerates leftover per-line metadata (a body that never hit the save chokepoint)', async () => {
    const out = (await transformBodyImages(fence(`${A} | 3000x2000 | alt="x"`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('<div class="jgal jgal--column not-prose">');
    // Metadata comes from the images map, not the line.
    expect(out).toContain('alt="Sunrise over the towers"');
  });

  it('skips a URL with no images entry', async () => {
    const out = (await transformBodyImages(fence(`${A}\n${ORIGIN}/unknown`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(items(out)).toHaveLength(1);
  });

  it('leaves the <pre> in place when nothing in the fence resolves', async () => {
    const out = (await transformBodyImages(fence(`${ORIGIN}/unknown`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('language-gallery');
    expect(out).not.toContain('jgal');
  });
});

describe('transformBodyImages — gallery layout modes', () => {
  // Seven landscapes stack to a near-square as 2 + 2 + 3 at either width.
  const many = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`${ORIGIN}/trips/x/p${i}`, { width: 3000, height: 2000, alt: `p${i}` }]),
  );
  const manyFence = (directive = '') =>
    fence([directive, ...Object.keys(many)].filter(Boolean).join('\n'));

  it('defaults to the column width when the fence carries no directive', async () => {
    const out = (await transformBodyImages(fence(A), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('class="jgal jgal--column not-prose"');
  });

  it('nests photos in rows and emits a ratio per photo', async () => {
    const out = (await transformBodyImages(manyFence('#layout: breakout'), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    // flex-wrap: nowrap on one container would put all seven on one line —
    // the rows are the layout.
    expect(out.match(/<div class="jgal__row/g) ?? []).toHaveLength(3); // 2 + 2 + 3
    expect(out).toContain('style="--r:1.5000"');
    expect(items(out)).toHaveLength(7);
  });

  it('lets every row fill the container — no capped remainder', async () => {
    const out = (await transformBodyImages(manyFence('#layout: breakout'), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('--jgal-maxw');
  });

  it('caps a lone portrait at the square, as a container percentage', async () => {
    const portrait = { [`${ORIGIN}/trips/x/tall`]: { width: 2000, height: 3000, alt: 'tall' } };
    const out = (await transformBodyImages(fence(`${ORIGIN}/trips/x/tall`), portrait, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    // 1056 tall × 2/3 = 704 wide of 1056 — as wide as it is tall. A percentage,
    // not pixels, so it stays square-bounded as the container resizes.
    expect(out).toContain('--jgal-maxw:66.67%');
  });

  it('switches to the break-out width on #layout: breakout', async () => {
    const wide = (await transformBodyImages(manyFence('#layout: breakout'), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(wide).toContain('class="jgal jgal--breakout not-prose"');
    // The wider container asks the browser for a wider source per photo.
    expect(wide).toContain('(min-width: 1112px) 550px');
    expect((await transformBodyImages(manyFence(), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }))).toContain('(min-width: 1056px) 344px');
  });

  it('renders a keyboard-scrollable track with hidden controls on #layout: slider', async () => {
    const out = (await transformBodyImages(manyFence('#layout: slider'), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('class="jgal jgal--slider not-prose"');
    expect(out).toContain('<div class="jgal__track" tabindex="0">');
    expect(out).not.toContain('jgal__row');
    // The buttons must ship hidden: with JS off they would do nothing, and the
    // track scrolls on its own.
    expect(out).toContain('hidden data-jgal-nav="prev"');
    expect(out).toContain('hidden data-jgal-nav="next"');
  });

  it('falls back to the column on an unknown mode rather than dropping the gallery', async () => {
    const out = (await transformBodyImages(manyFence('#layout: carousel'), many, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('class="jgal jgal--column not-prose"');
    expect(items(out)).toHaveLength(7);
  });

  it('never renders the directive as a photo or as text', async () => {
    const out = (await transformBodyImages(fence(`#layout: slider\n${A}`), gallery, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('#layout');
    expect(items(out)).toHaveLength(1);
  });

  it('derives sizes per photo, so a full-width panorama is not served a thumbnail', async () => {
    const pano = `${ORIGIN}/trips/x/pano`;
    const out = (await transformBodyImages(fence(`#layout: breakout\n${pano}`), { [pano]: { width: 4000, height: 1000, alt: 'p' } }, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    // Alone on its row at 4:1 it renders 1112 wide in break-out — the hint must say so.
    expect(out).toContain('sizes="(min-width: 1112px) 1112px');
  });
});

describe('transformBodyImages — gallery URL allow-list', () => {
  const withEntry = (url: string) => ({ [url]: { width: 800, height: 600, alt: 'x' } });

  it('rejects a javascript: URL even when the images map vouches for it', async () => {
    const url = 'javascript:alert(1)';
    const out = (await transformBodyImages(fence(url), withEntry(url), ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out.toLowerCase()).not.toContain('href="javascript:');
    expect(out).not.toContain('jgal');
  });

  it('rejects a data: URL', async () => {
    const url = 'data:text/html,<script>alert(1)</script>';
    const out = (await transformBodyImages(fence(url), withEntry(url), ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('jgal');
  });

  // @ai-warning: both of these pass `raw.startsWith(ORIGIN)`. Origin equality
  // is the only correct test — never reintroduce a prefix match.
  it('rejects a suffix-confusion host (img.simonswanderlust.com.evil.com)', async () => {
    const url = 'https://img.simonswanderlust.com.evil.com/x';
    const out = (await transformBodyImages(fence(url), withEntry(url), ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    // The URL stays visible as <pre> text (nothing disappears silently) — what
    // must not happen is it becoming a live href/srcset.
    expect(out).not.toContain('href=');
    expect(out).not.toContain('jgal');
  });

  it('rejects a userinfo-confusion URL (img.simonswanderlust.com@evil.com)', async () => {
    const url = 'https://img.simonswanderlust.com@evil.com/x';
    const out = (await transformBodyImages(fence(url), withEntry(url), ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('jgal');
  });

  it('rejects an off-origin URL — the dev/CI fail-safe when PUBLIC_BASE_URL is unset', async () => {
    const url = 'http://localhost:3000/trips/x/a-1a2b3c4d';
    const out = (await transformBodyImages(fence(url), withEntry(url), ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('language-gallery'); // the bare <pre> survives
    expect(out).not.toContain('jgal');
  });

  it('accepts the same origin on a different port only when it matches exactly', async () => {
    const url = 'http://localhost:3000/trips/x/a-1a2b3c4d';
    const out = (await transformBodyImages(fence(url), withEntry(url), 'http://localhost:3000', { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).toContain('jgal');
  });
});

describe('transformBodyImages — gallery value coercion', () => {
  it('cannot be made to emit markup from a node-shaped alt or caption', async () => {
    // hastscript treats a node-shaped object in a children array AS A NODE, and
    // the stringifier runs with allowDangerousHtml — so this must be String()d.
    const hostile = {
      [A]: {
        width: 800,
        height: 600,
        alt: { type: 'raw', value: '<script>alert(1)</script>' },
        caption: { type: 'raw', value: '<img src=x onerror=alert(2)>' },
      },
    } as unknown as Record<string, { width: number; height: number }>;
    const out = (await transformBodyImages(fence(A), hostile, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).toContain('[object Object]'); // coerced, inert
  });

  it('skips an item whose dimensions are not positive integers', async () => {
    for (const dims of [
      { width: '1;} html{display:none}/*', height: 600 },
      { width: 800, height: 0 },
      { width: 1.5, height: 600 },
      { width: -800, height: 600 },
    ]) {
      const out = (await transformBodyImages(fence(A), { [A]: dims } as unknown as Record<string, { width: number; height: number }>, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }));
      expect(out).not.toContain('jgal');
      expect(out).toContain('language-gallery');
    }
  });
});

describe('analyzeRenderedBody — sanitized heading and image semantics', () => {
  it('reads img/source src+srcset and gallery lines from the sanitized tree, in every shape galleryCode accepts', () => {
    const html = [
      '<img alt="x > y" src="https://old.example/a.jpg">',
      '<picture><source srcset="https://old.example/b.jpg 1x, https://old.example/c.jpg 2x"><img src="https://img.example.com/own"></picture>',
      '<img src="javascript:alert(1)">',
      '<pre id="g">\n<code class="language-gallery" id="c">#layout: grid\n\nhttps://img.example.com/one | 10x10\nhttps://old.example/g.jpg | alt="x"</code>\n</pre>',
      '<pre><code class="language-js">https://old.example/not-a-gallery</code></pre>',
      '<p>src="https://old.example/text-not-attr"</p>',
    ].join('\n');
    expect(analyzeRenderedBody(html)).toEqual({
      hasH1: false,
      sources: ['https://old.example/a.jpg', 'https://old.example/b.jpg', 'https://old.example/c.jpg', 'https://img.example.com/own'],
      galleryLines: ['https://img.example.com/one', 'https://old.example/g.jpg'],
    });
  });

  it.each([
    ['<h1>Title</h1>', true],
    ['<div><blockquote><ul><li><h1>&#35; Title</h1></li></ul></blockquote></div>', true],
    ['<pre><code class="language-gallery"><h1>Actual heading</h1></code></pre>', true],
    ['<code>&lt;h1&gt;Literal&lt;/h1&gt;</code>', false],
    ['<p>&#60;h1&#62;Literal&#60;/h1&#62;</p>', false],
    ['<script><h1>Removed</h1></script>', false],
    ['<h2 title="<h1>">Section</h2>', false],
  ])('detects only surviving H1 elements in %s', (html, hasH1) => {
    expect(analyzeRenderedBody(html).hasH1).toBe(hasH1);
  });
});

describe('transformBodyImages — awaited gallery scheduling', () => {
  it('awaits every gallery before serialization and preserves per-request metadata', async () => {
    const src = `${ORIGIN}/trips/scheduled/photo`;
    const images = { [src]: { width: 1500, height: 1000 } };
    const large = fence(Array.from({ length: 100 }, () => src).join('\n'));
    let yields = 0;
    const options = { schedule: async (work: { operations: number }) => {
      expect(work.operations).toBeLessThanOrEqual(4096);
      yields++;
      await setImmediate();
    } };
    const [first, second] = await Promise.all([
      transformBodyImages(large + '<p>between</p>' + large, images, ORIGIN, { ...options, locale: 'en', inlineSizes: STORY_BODY_SIZES }, new Map([[src, { alt: 'First', caption: 'First caption' }]])),
      transformBodyImages(large, images, ORIGIN, { ...options, locale: 'en', inlineSizes: STORY_BODY_SIZES }, new Map([[src, { alt: 'Second', caption: 'Second caption' }]])),
    ]);
    expect(yields).toBeGreaterThan(0);
    expect((first.match(/class="jgal__item"/g) ?? [])).toHaveLength(200);
    expect((second.match(/class="jgal__item"/g) ?? [])).toHaveLength(100);
    expect(first).toContain('<p>between</p>');
    expect(first).not.toContain('Second');
    expect(second).not.toContain('First');
    expect(first + second).not.toContain('[object Promise]');
    expect(first).toBe(await transformBodyImages(large + '<p>between</p>' + large, images, ORIGIN, { locale: 'en', inlineSizes: STORY_BODY_SIZES }, new Map([[src, { alt: 'First', caption: 'First caption' }]])));
  });

  it('does not partition slider galleries', async () => {
    const src = `${ORIGIN}/trips/scheduled/photo`;
    let scheduled = false;
    const html = await transformBodyImages(fence(`#layout: slider\n${src}`), { [src]: { width: 600, height: 400 } }, ORIGIN, {
      locale: 'en',
      schedule: async () => { scheduled = true; },
      inlineSizes: STORY_BODY_SIZES,
    });
    expect(scheduled).toBe(false);
    expect(html).toContain('jgal--slider');
  });
});
