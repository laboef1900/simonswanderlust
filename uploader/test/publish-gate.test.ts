import { describe, expect, it } from 'vitest';
import { analyzeBodyContent, bodyImageKey } from '../src/publish-gate.js';
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { transformBodyImages } from '../../site/src/lib/body-images.js';

// #91: the publish gate's foreign-origin check. A failed WXR re-host leaves the
// WordPress URL in the body; body-images.ts hot-links an inline image with no
// `images` entry and drops a foreign gallery line, and `notReadyPhotos` never
// saw either because srcToKey returns null for a foreign origin.
//
// The gate reads the renderer's own tree, so the invariant that matters is
// parity with what the reader would get. Each case carries the expected
// verdict AND is checked against an independent oracle: every quoted
// `src`/`srcset` value in the rendered, sanitized HTML (no `images` map, so
// nothing is resolved away). The oracle is deliberately more liberal than a
// tag parser — it cannot be fooled by a `>` inside an attribute — and the gate
// must agree with it exactly.
describe('analyzeBodyContent foreign-origin interpretation', () => {
  const ORIGIN = 'https://img.simonswanderlust.com';
  const OLD = 'https://old.example';
  const oracle = async (body: string): Promise<string[]> => {
    // Literal text inside <code> is escaped by the serializer (`&#x3C;img`), so a
    // `src="` there is never a real attribute; drop it before the liberal scan.
    const html = (await transformBodyImages(await renderMarkdown(body), {}, ORIGIN)).replace(/<code(?![^>]*language-gallery)[^>]*>[\s\S]*?<\/code>/g, '');
    const urls = [...html.matchAll(/\b(?:src|srcset)="([^"]*)"/g)]
      .flatMap((m) => (m[1] ?? '').split(',').map((c) => c.trim().split(/\s+/, 1)[0] ?? ''))
      .map((u) => u.replace(/&#x26;/g, '&').replace(/&#x22;/g, '"'));
    // Resolved against ORIGIN, like a browser on the page: a reference with no
    // origin of its own (`//host/x`, `\\host/x`) is foreign, `https:host/x` is not.
    return [...new Set(urls.filter((u) => { try { const p = new URL(u, ORIGIN); return (p.protocol === 'https:' || p.protocol === 'http:') && p.origin !== ORIGIN; } catch { return false; } }))];
  };

  const cases: [body: string, expected: string[]][] = [
    // The importer's common single-image case: a titled, escaped or <…>-wrapped destination.
    [`![a](${OLD}/wp-content/uploads/a.jpg "a.jpg")`, [`${OLD}/wp-content/uploads/a.jpg`]],
    [`![b](<${OLD}/wp-content/uploads/b c.jpg>)`, [`${OLD}/wp-content/uploads/b%20c.jpg`]],
    [`![c](${OLD}/wp-content/uploads/c\\(1\\).jpg)`, [`${OLD}/wp-content/uploads/c(1).jpg`]],
    // Raw HTML in any quoting; a raw `>` inside alt; backticks inside attributes; no space before src.
    [`<img src="${OLD}/a.jpg" alt=""><img alt='x' src='${OLD}/b.jpg'>`, [`${OLD}/a.jpg`, `${OLD}/b.jpg`]],
    [`<img alt="x > y" src="${OLD}/a.jpg">`, [`${OLD}/a.jpg`]],
    [`<img alt="\`" src="${OLD}/a.jpg" title="\`">`, [`${OLD}/a.jpg`]],
    // Not an HTML tag to CommonMark (attributes need whitespace): renders as text plus an autolink.
    [`<img alt="x"src="${OLD}/e.jpg">`, []],
    // A raw <picture> is allowed by the sanitizer: its <source srcset> hot-links too.
    [`<picture><source srcset="${OLD}/a.jpg 1x, ${OLD}/b.jpg 2x"><img src="${ORIGIN}/a"></picture>`, [`${OLD}/a.jpg`, `${OLD}/b.jpg`]],
    // Syntax spanning lines, and an image after a heading that holds a lone backtick.
    [`![x](\n${OLD}/a.jpg)`, [`${OLD}/a.jpg`]],
    [`# \`\n![x](${OLD}/b.jpg)\n# \``, [`${OLD}/b.jpg`]],
    // Code spans and code fences render as text; a code span never crosses a block.
    [`see \`![x](${OLD}/a.jpg)\` and \`\`<img src="${OLD}/b.jpg">\`\``, []],
    [`\`\`\`\`md\n![x](${OLD}/a.jpg)\n\`\`\`\`\n~~~\n<img src="${OLD}/c.jpg">\n~~~`, []],
    [`text \`\` then ![x](${OLD}/a.jpg) and \` end`, [`${OLD}/a.jpg`]],
    [`x \`a \`\` b\` ![](${OLD}/c) \`\``, [`${OLD}/c`]],
    [`x \`a\\\` ![](${OLD}/d) \``, [`${OLD}/d`]],
    [`x \\\\\`![](${OLD}/e)\` y`, []],
    [`text \\\`![y](${OLD}/b.jpg)\\\` end`, [`${OLD}/b.jpg`]],
    [`text \`\n\n![x](${OLD}/f.jpg)\n\n\``, [`${OLD}/f.jpg`]],
    [`![x](${OLD}/\`a) \``, [`${OLD}/%60a`]],
    [`![a \`x\`](${OLD}/d.jpg)`, [`${OLD}/d.jpg`]],
    // Image-like text inside an own-origin tag's alt is not an image.
    [`<img src="${ORIGIN}/a.jpg" alt="![example](${OLD}/a.jpg)">`, []],
    // Character references are decoded by the renderer before the URL exists.
    [`<img src="https&#58;//old&#46;example/a.jpg">`, [`${OLD}/a.jpg`]],
    [`<img src="https&colon;//old&period;example/a.jpg">`, [`${OLD}/a.jpg`]],
    [`<img src="https&#00000058;//old.example/a.jpg">`, [`${OLD}/a.jpg`]],
    [`![x](https://old&#x2e;example/b.jpg)`, [`${OLD}/b.jpg`]],
    // No scheme of its own: the browser takes the page's, so a protocol-relative
    // reference IS a foreign hot-link — in every spelling WHATWG reads as an
    // authority (`//`, its character-reference form, and `\\`).
    ['![x](//old.example/a.jpg)', ['//old.example/a.jpg']],
    ['<img src="//old.example/a.jpg">', ['//old.example/a.jpg']],
    ['<img src="&#47;&#47;old.example/a.jpg">', ['//old.example/a.jpg']],
    ['<img src="\\\\old.example/a.jpg">', ['\\\\old.example/a.jpg']],
    [`<picture><source srcset="//old.example/a.jpg 800w"><img src="${ORIGIN}/a"></picture>`, ['//old.example/a.jpg']],
    // The inverse, and why the base matters in both directions: to a browser
    // `https:old.example/a.jpg` is a PATH on our own host, so refusing it would
    // be a false refusal on a body that hot-links nothing.
    ['<img src="https:old.example/a.jpg">', []],
    // Own-origin URLs, whatever their query encoding, and non-http destinations pass.
    [`![x](${ORIGIN}/a?x=1&AMP;b=2) ![y](${ORIGIN}/a?x=1&amP;b=2) ![z](${ORIGIN}/trips/x/photo)`, []],
    ['![](data:image/png;base64,AAAA) ![](/relative/x.jpg) ![](not a url)', []],
    // Origin equality, never a prefix.
    [`![](${ORIGIN}.evil.example/x.jpg)\n![](https://img.simonswanderlust.com@evil.example/x.jpg)\n![](http://img.simonswanderlust.com/x.jpg)`,
      [`${ORIGIN}.evil.example/x.jpg`, 'https://img.simonswanderlust.com@evil.example/x.jpg', 'http://img.simonswanderlust.com/x.jpg']],
  ];

  it('reports exactly what the renderer would hot-link', async () => {
    for (const [body, expected] of cases) {
      const { foreign: got } = await analyzeBodyContent(body, {}, ORIGIN);
      expect(got, body).toEqual(expected);
      expect(got, `oracle disagrees for ${body}`).toEqual(await oracle(body));
    }
  });

  it('reports a foreign gallery line — which the renderer would silently drop — under every fence spelling the renderer accepts', async () => {
    const fence = (open: string, close: string) => [open, '#layout: grid', '', `${ORIGIN}/trips/x/one | 3000x2000 | alt="fine"`, `${OLD}/wp-content/uploads/g.jpg | alt="never lifted"`, close].join('\n');
    const bodies = [
      fence('```gallery', '```'), fence('~~~gallery', '~~~'), fence('  ```gallery', '```'), fence('```gallery extra', '````'),
      // Raw HTML spellings the sanitizer keeps and galleryCode accepts.
      `<pre id="g"><code class="language-gallery">${ORIGIN}/trips/x/one\n${OLD}/wp-content/uploads/g.jpg</code></pre>`,
      `<pre>\n<code class="language-gallery" id="c">${ORIGIN}/trips/x/one\n${OLD}/wp-content/uploads/g.jpg</code>\n</pre>`,
    ];
    for (const body of bodies) {
      expect((await analyzeBodyContent(body, {}, ORIGIN)).foreign, body).toEqual([`${OLD}/wp-content/uploads/g.jpg`]);
      // The hole being closed: with the own photo resolvable, the renderer builds
      // the gallery and the foreign line simply disappears.
      const rendered = (await transformBodyImages(await renderMarkdown(body), { [`${ORIGIN}/trips/x/one`]: { width: 3000, height: 2000 } }, ORIGIN));
      expect(rendered).toContain(`${ORIGIN}/trips/x/one`);
      expect(rendered).not.toContain('old.example');
    }
  });

  it('reports a protocol-relative gallery line', async () => {
    const body = ['```gallery', `${ORIGIN}/trips/x/one | 3000x2000`, '//old.example/wp-content/uploads/g.jpg', '```'].join('\n');
    // galleryPhotos parses the line without a base too, so the renderer drops it
    // silently — the same disappearing photo, one spelling further out.
    expect((await analyzeBodyContent(body, {}, ORIGIN)).foreign).toEqual(['//old.example/wp-content/uploads/g.jpg']);
  });

  it('de-duplicates across shapes', async () => {
    const body = `![a](${OLD}/a.jpg)\n\n![b](${OLD}/a.jpg)\n<img src="${OLD}/a.jpg">\n\n\`\`\`gallery\n${OLD}/a.jpg\n\`\`\``;
    expect((await analyzeBodyContent(body, {}, ORIGIN)).foreign).toEqual([`${OLD}/a.jpg`]);
  });
});

describe('rendered heading semantics (#375)', () => {
  it.each([
    ['# Duplicate document title', true],
    ['Intro\n=====', true],
    ['> # Quoted heading', true],
    ['- # Listed heading', true],
    ['<div><h1 class="legacy">Legacy &amp; title</h1></div>', true],
    ['<blockquote><h1>&#35; Title</h1></blockquote>', true],
    ['<pre><code class="language-gallery"><h1>Real element</h1></code></pre>', true],
    ['Use `<h1>` for the page title.', false],
    ['    <h1>Indented example</h1>\n\n    # Code heading', false],
    ['````markdown\n# Example heading\n<h1>Example HTML</h1>\n````\n\n## Real section', false],
    ['~~~html\n<h1>Example</h1>\n~~~', false],
    ['&lt;h1&gt;Escaped&lt;/h1&gt; and &#60;h1&#62;', false],
    ['<script><h1>Removed</h1></script>', false],
    ['```gallery\n# Heading-looking comment\nhttps://images.test/photo | caption="<h1>Caption</h1>"\n```', false],
  ])('judges %s from sanitized rendered elements', async (body, expected) => {
    const result = await analyzeBodyContent(body, {}, 'https://images.test');
    expect(result.hasH1).toBe(expected);
    const rendered = (await transformBodyImages(await renderMarkdown(body), {}, 'https://images.test'));
    expect(/<h1(?:\s|>)/.test(rendered)).toBe(expected);
  });
});

describe('rendered readiness references (#334)', () => {
  const origin = 'https://images.test';
  const photo = `${origin}/trips/test/photo`;
  const images = { [photo]: { width: 1280, height: 960 } };

  it.each(['avif', 'webp', 'jpeg'])('reads direct %s variants without metadata from Markdown and raw HTML', async (format) => {
    const src = `${photo}-640.${format}`;
    for (const body of [`![View](${src})`, `<img src="${src}" alt="View > valley">`]) {
      expect((await analyzeBodyContent(body, {}, origin)).sources).toEqual([src]);
      expect((await transformBodyImages(await renderMarkdown(body), {}, origin))).toContain(`src="${src}"`);
    }
  });

  it('retains every raw picture candidate, not just its ready fallback', async () => {
    const body = `<picture><source srcset="${photo}-640.avif 1x, ${origin}/other-1280.avif 2x"><img src="${origin}/ready-640.webp"></picture>`;
    const result = await analyzeBodyContent(body, {}, origin);
    expect(result.sources).toEqual([`${photo}-640.avif`, `${origin}/other-1280.avif`, `${origin}/ready-640.webp`]);
    const html = (await transformBodyImages(await renderMarkdown(body), {}, origin));
    for (const src of result.sources) expect(html).toContain(src);
  });

  it('reads resolved galleries and inline pictures but ignores obsolete metadata and code examples', async () => {
    const bodies = [`![View](${photo})`, `\`\`\`gallery\n${photo}\n\`\`\``];
    for (const body of bodies) {
      const result = await analyzeBodyContent(body, images, origin);
      const html = (await transformBodyImages(await renderMarkdown(body), images, origin));
      expect(result.sources.length).toBeGreaterThan(0);
      expect(new Set(result.sources.map(src => bodyImageKey(src, origin, `${origin}/story/`)))).toEqual(new Set(['trips/test/photo']));
      for (const src of result.sources) expect(html).toContain(src);
    }
    for (const body of ['No photo remains', `\`![View](${photo})\``, `\`\`\`html\n<img src="${photo}">\n\`\`\``]) {
      expect((await analyzeBodyContent(body, images, origin)).sources).toEqual([]);
    }
  });

  it('does not treat unresolved gallery text as an image load, but still refuses foreign gallery lines', async () => {
    const body = `\`\`\`gallery\n${photo}\nhttps://foreign.test/photo\n\`\`\``;
    const result = await analyzeBodyContent(body, {}, origin);
    expect(result).toEqual({ hasH1: false, sources: [], foreign: ['https://foreign.test/photo'] });
    expect((await transformBodyImages(await renderMarkdown(body), {}, origin))).toContain('<pre>');
  });

  it.each([
    [`${photo}-640.webp?download=1#photo`, 'trips/test/photo'],
    ['/trips/test/photo-640.avif', 'trips/test/photo'],
    ['//images.test/trips/test/photo-640.jpeg', 'trips/test/photo'],
    ['../../trips/test/photo-640.webp', 'trips/test/photo'],
    ['/trips/test/%70hoto-640.webp', 'trips/test/photo'],
    ['photo-640.webp', 'en/story/photo'],
    ['https://images.test.evil/trips/test/photo-640.webp', null],
    ['https://images.test@evil.test/trips/test/photo-640.webp', null],
    ['data:image/png;base64,AAAA', null],
    ['/trips/test/%ZZ-640.webp', null],
  ])('maps browser reference %s to its media key', (src, key) => {
    expect(bodyImageKey(src, origin, `${origin}/en/story/`)).toBe(key);
  });

  it('respects a configured image path boundary', () => {
    expect(bodyImageKey('/images/photo-640.webp', `${origin}/images`, `${origin}/story/`)).toBe('photo');
    expect(bodyImageKey('/images-other/photo-640.webp', `${origin}/images`, `${origin}/story/`)).toBeNull();
  });
});
