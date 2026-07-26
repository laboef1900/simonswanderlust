import { describe, expect, it } from 'vitest';
import { transformBodyImages } from './body-images.js';

const ORIGIN = 'https://img.simonswanderlust.com';
/** ```gallery survives sanitize as this — see MARKDOWN_OPTIONS in render-markdown.ts. */
const fence = (lines: string) => `<pre><code class="language-gallery">${lines}\n</code></pre>`;

describe('transformBodyImages — sanitization', () => {
  it('strips <script> from author body HTML', () => {
    const out = transformBodyImages('<p>hello</p><script>alert(1)</script>', {}, ORIGIN);
    expect(out).not.toContain('<script');
    expect(out).toContain('hello');
  });

  it('strips inline event handlers and javascript: URLs', () => {
    const out = transformBodyImages('<img src="https://img/x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>', {}, ORIGIN);
    expect(out).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
});

describe('transformBodyImages — responsive images', () => {
  it('preserves the injected <picture> (with its attrs) for known body images', () => {
    const out = transformBodyImages('<p><img src="https://img/x"></p>', { 'https://img/x': { width: 800, height: 600 } }, ORIGIN);
    expect(out).toContain('<picture>');
    expect(out).toContain('type="image/avif"');
    expect(out).toContain('srcset');
    expect(out).toContain('loading="lazy"');
  });

  it('leaves ordinary paragraphs intact', () => {
    const out = transformBodyImages('<p>A normal <strong>paragraph</strong>.</p>', {}, ORIGIN);
    expect(out).toContain('<strong>paragraph</strong>');
  });

  it('preserves heading ids un-prefixed so TOC #slug anchors still resolve', () => {
    const out = transformBodyImages('<h2 id="etappe-1">Etappe 1</h2>', {}, ORIGIN);
    expect(out).toContain('id="etappe-1"');
    expect(out).not.toContain('user-content-');
  });

  it('keeps Shiki inline styles/classes on code spans', () => {
    const out = transformBodyImages('<pre class="astro-code"><span style="color:#abc">x</span></pre>', {}, ORIGIN);
    expect(out).toContain('class="astro-code"');
    expect(out).toContain('style="color:#abc"');
  });
});

const images = { 'https://img/x/y': { width: 1600, height: 1067 } };

describe('transformBodyImages — responsive <picture>', () => {
  it('replaces a known <img> with a responsive <picture> inside a figure', () => {
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images, ORIGIN);
    expect(out).toContain('<figure class="my-8">');
    expect(out).toContain('<source type="image/avif"');
    expect(out).toContain('<source type="image/webp"');
    expect(out).toContain('https://img/x/y-1280.webp'); // fallback src
    expect(out).toContain('width="1600"');
    expect(out).toContain('height="1067"');
    expect(out).toContain('alt="A caption"');
    expect(out).toContain('class="block w-full rounded-lg"');
  });
  it('unwraps the <p> when a known <img> is its sole meaningful child', () => {
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images, ORIGIN);
    expect(out).toContain('<figure');
    expect(out).not.toMatch(/<p>\s*<figure/);
    expect(out).not.toContain('<img src="https://img/x/y"');
  });
  it('leaves an unknown image untouched', () => {
    const out = transformBodyImages('<img src="https://other/z" alt="z">', {}, ORIGIN);
    expect(out).toContain('<img src="https://other/z"');
    expect(out).not.toContain('<picture>');
  });
});

const A = `${ORIGIN}/trips/patagonia/a-1a2b3c4d`;
const B = `${ORIGIN}/trips/patagonia/b-9f8e7d6c`;
const gallery = {
  [A]: { width: 3000, height: 2000, alt: 'Sunrise over the towers', caption: 'Day 3' },
  [B]: { width: 2000, height: 3000, alt: 'The pass' },
};

describe('transformBodyImages — gallery fence', () => {
  it('turns a fence into a grid of figures', () => {
    const out = transformBodyImages(fence(`${A}\n${B}`), gallery, ORIGIN);
    expect(out).toContain('<div class="jgal not-prose">');
    expect(out).not.toContain('<pre>');
    expect(out.match(/<figure class="jgal__item">/g)).toHaveLength(2);
    expect(out).toContain(`href="${A}-3000.webp"`); // largest variant, no-JS target
    expect(out).toContain('alt="Sunrise over the towers"');
    expect(out).toContain('<figcaption class="jgal__cap">Day 3</figcaption>');
    expect(out).toContain('width="2000"');
    expect(out).toContain('height="3000"');
  });

  it('omits the figcaption when the photo has no caption', () => {
    const out = transformBodyImages(fence(B), gallery, ORIGIN);
    expect(out).toContain('alt="The pass"');
    expect(out).not.toContain('figcaption');
  });

  it('ignores blank and #-prefixed lines and keeps line order', () => {
    const out = transformBodyImages(fence(`# a comment\n\n${B}\n${A}`), gallery, ORIGIN);
    expect(out).not.toContain('a comment');
    expect(out.indexOf(`${B}-`)).toBeLessThan(out.indexOf(`${A}-`));
  });

  it('tolerates leftover per-line metadata (a body that never hit the save chokepoint)', () => {
    const out = transformBodyImages(fence(`${A} | 3000x2000 | alt="x"`), gallery, ORIGIN);
    expect(out).toContain('<div class="jgal not-prose">');
    // Metadata comes from the images map, not the line.
    expect(out).toContain('alt="Sunrise over the towers"');
  });

  it('skips a URL with no images entry', () => {
    const out = transformBodyImages(fence(`${A}\n${ORIGIN}/unknown`), gallery, ORIGIN);
    expect(out.match(/<figure class="jgal__item">/g)).toHaveLength(1);
  });

  it('leaves the <pre> in place when nothing in the fence resolves', () => {
    const out = transformBodyImages(fence(`${ORIGIN}/unknown`), gallery, ORIGIN);
    expect(out).toContain('language-gallery');
    expect(out).not.toContain('jgal');
  });
});

describe('transformBodyImages — gallery URL allow-list', () => {
  const withEntry = (url: string) => ({ [url]: { width: 800, height: 600, alt: 'x' } });

  it('rejects a javascript: URL even when the images map vouches for it', () => {
    const url = 'javascript:alert(1)';
    const out = transformBodyImages(fence(url), withEntry(url), ORIGIN);
    expect(out.toLowerCase()).not.toContain('href="javascript:');
    expect(out).not.toContain('jgal');
  });

  it('rejects a data: URL', () => {
    const url = 'data:text/html,<script>alert(1)</script>';
    const out = transformBodyImages(fence(url), withEntry(url), ORIGIN);
    expect(out).not.toContain('jgal');
  });

  // @ai-warning: both of these pass `raw.startsWith(ORIGIN)`. Origin equality
  // is the only correct test — never reintroduce a prefix match.
  it('rejects a suffix-confusion host (img.simonswanderlust.com.evil.com)', () => {
    const url = 'https://img.simonswanderlust.com.evil.com/x';
    const out = transformBodyImages(fence(url), withEntry(url), ORIGIN);
    // The URL stays visible as <pre> text (nothing disappears silently) — what
    // must not happen is it becoming a live href/srcset.
    expect(out).not.toContain('href=');
    expect(out).not.toContain('jgal');
  });

  it('rejects a userinfo-confusion URL (img.simonswanderlust.com@evil.com)', () => {
    const url = 'https://img.simonswanderlust.com@evil.com/x';
    const out = transformBodyImages(fence(url), withEntry(url), ORIGIN);
    expect(out).not.toContain('jgal');
  });

  it('rejects an off-origin URL — the dev/CI fail-safe when PUBLIC_BASE_URL is unset', () => {
    const url = 'http://localhost:3000/trips/x/a-1a2b3c4d';
    const out = transformBodyImages(fence(url), withEntry(url), ORIGIN);
    expect(out).toContain('language-gallery'); // the bare <pre> survives
    expect(out).not.toContain('jgal');
  });

  it('accepts the same origin on a different port only when it matches exactly', () => {
    const url = 'http://localhost:3000/trips/x/a-1a2b3c4d';
    const out = transformBodyImages(fence(url), withEntry(url), 'http://localhost:3000');
    expect(out).toContain('jgal');
  });
});

describe('transformBodyImages — gallery value coercion', () => {
  it('cannot be made to emit markup from a node-shaped alt or caption', () => {
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
    const out = transformBodyImages(fence(A), hostile, ORIGIN);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).toContain('[object Object]'); // coerced, inert
  });

  it('skips an item whose dimensions are not positive integers', () => {
    for (const dims of [
      { width: '1;} html{display:none}/*', height: 600 },
      { width: 800, height: 0 },
      { width: 1.5, height: 600 },
      { width: -800, height: 600 },
    ]) {
      const out = transformBodyImages(fence(A), { [A]: dims } as unknown as Record<string, { width: number; height: number }>, ORIGIN);
      expect(out).not.toContain('jgal');
      expect(out).toContain('language-gallery');
    }
  });
});
