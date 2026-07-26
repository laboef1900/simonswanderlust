import { describe, expect, it } from 'vitest';
import { MARKDOWN_OPTIONS, renderMarkdown } from './render-markdown';
import astroConfig from '../../astro.config.mjs';

describe('MARKDOWN_OPTIONS parity with astro.config.mjs', () => {
  // The build reads astro.config.mjs; the uploader's draft preview reads
  // MARKDOWN_OPTIONS. A silent divergence means previews and the live site
  // disagree about what a ```gallery fence is. Fix a failure here by editing
  // BOTH files, never by relaxing this assertion.
  it('matches the markdown block the build runs with', () => {
    expect(astroConfig.markdown).toEqual(MARKDOWN_OPTIONS);
  });

  it("excludes 'gallery' from syntax highlighting so the fence keeps its class", () => {
    const sh = MARKDOWN_OPTIONS.syntaxHighlight;
    expect(typeof sh === 'object' && sh !== null && sh.excludeLangs).toContain('gallery');
  });
});

describe('renderMarkdown', () => {
  it('keeps a ```gallery fence marked as language-gallery through the pipeline', async () => {
    const html = await renderMarkdown('```gallery\nhttps://img.example.com/a-1a2b3c4d\n```');
    expect(html).toContain('language-gallery');
    expect(html).not.toContain('data-language="plaintext"');
  });

  it('still syntax-highlights a known language', async () => {
    const html = await renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('astro-code');
  });

  it('renders GFM tables', async () => {
    const html = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('gives headings github-slugger ids (Toc anchor parity with the build)', async () => {
    const html = await renderMarkdown('## Anreise & Tag 1');
    expect(html).toContain('<h2 id="anreise--tag-1">');
  });

  it('renders ![alt](url) as <img src> — the shape transformBodyImages upgrades', async () => {
    const html = await renderMarkdown('![Old town](https://img.example.com/trips/x/old-town)');
    expect(html).toContain('<img src="https://img.example.com/trips/x/old-town"');
    expect(html).toContain('alt="Old town"');
  });

  it('renders bold and smart punctuation like the build does', async () => {
    const html = await renderMarkdown('**bold** -- "quote"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('–'); // -- → en dash
    expect(html).toContain('“quote”'); // smart quotes
  });

  it('is idempotent: repeated calls with the same input yield identical output', async () => {
    // (Renderer caching itself is an internal detail — a spy would require
    // mocking satteri and losing the real-render coverage above.)
    const first = await renderMarkdown('# One');
    const second = await renderMarkdown('# One');
    expect(second).toBe(first);
  });
});
