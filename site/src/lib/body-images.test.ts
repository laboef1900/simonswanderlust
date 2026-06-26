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
