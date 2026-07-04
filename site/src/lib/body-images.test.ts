import { describe, expect, it } from 'vitest';
import { transformBodyImages } from './body-images.js';

describe('transformBodyImages — sanitization', () => {
  it('strips <script> from author body HTML', () => {
    const out = transformBodyImages('<p>hello</p><script>alert(1)</script>', {});
    expect(out).not.toContain('<script');
    expect(out).toContain('hello');
  });

  it('strips inline event handlers and javascript: URLs', () => {
    const out = transformBodyImages('<img src="https://img/x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>', {});
    expect(out).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
});

describe('transformBodyImages — responsive images', () => {
  it('preserves the injected <picture> (with its attrs) for known body images', () => {
    const out = transformBodyImages('<p><img src="https://img/x"></p>', { 'https://img/x': { width: 800, height: 600 } });
    expect(out).toContain('<picture>');
    expect(out).toContain('type="image/avif"');
    expect(out).toContain('srcset');
    expect(out).toContain('loading="lazy"');
  });

  it('leaves ordinary paragraphs intact', () => {
    const out = transformBodyImages('<p>A normal <strong>paragraph</strong>.</p>', {});
    expect(out).toContain('<strong>paragraph</strong>');
  });

  it('preserves heading ids un-prefixed so TOC #slug anchors still resolve', () => {
    const out = transformBodyImages('<h2 id="etappe-1">Etappe 1</h2>', {});
    expect(out).toContain('id="etappe-1"');
    expect(out).not.toContain('user-content-');
  });

  it('keeps Shiki inline styles/classes on code spans', () => {
    const out = transformBodyImages('<pre class="astro-code"><span style="color:#abc">x</span></pre>', {});
    expect(out).toContain('class="astro-code"');
    expect(out).toContain('style="color:#abc"');
  });
});

const images = { 'https://img/x/y': { width: 1600, height: 1067 } };

describe('transformBodyImages — responsive <picture>', () => {
  it('replaces a known <img> with a responsive <picture> inside a figure', () => {
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images);
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
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images);
    expect(out).toContain('<figure');
    expect(out).not.toMatch(/<p>\s*<figure/);
    expect(out).not.toContain('<img src="https://img/x/y"');
  });
  it('leaves an unknown image untouched', () => {
    const out = transformBodyImages('<img src="https://other/z" alt="z">', {});
    expect(out).toContain('<img src="https://other/z"');
    expect(out).not.toContain('<picture>');
  });
});
