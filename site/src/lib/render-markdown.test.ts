import { describe, expect, it } from 'vitest';
import { MARKDOWN_OPTIONS, renderMarkdown } from './render-markdown';
import { SHIKI_CSS } from './shiki-classes';
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

  // Issue #124: the sanitizer drops every `style`, so highlighting has to
  // survive as classes — and every class must have a rule, or code blocks
  // silently lose their colours on the live site and in previews.
  it('highlights with classes SHIKI_CSS defines and no inline style at all', async () => {
    // js (tokens), diff (Astro's user-select:none marker spans), ansi (the
    // terminal palette as foreground AND background, plus a truecolor escape
    // no stylesheet can cover — it must inherit, not dangle a rule-less class).
    const html = await renderMarkdown(
      '```js\nconst a = 1; // hi\nfunction f() { return `x${a}` }\n```\n\n' +
        '```diff\n+ added\n- removed\n```\n\n' +
        '```ansi\n\x1b[31mERROR\x1b[0m \x1b[1;44mbg\x1b[0m \x1b[38;2;12;34;56mtrue\x1b[0m\n```',
    );
    expect(html).not.toContain('style=');
    const classes = [...new Set(html.match(/\bsh-[a-z0-9-]+/g))];
    expect(classes).toContain('sh-bg-24292e'); // the <pre> background moved off `style` too
    expect(classes).toContain('sh-c-ea4a5a'); // terminal.ansiRed
    expect(classes).toContain('sh-bg-2188ff'); // terminal.ansiBlue as background
    expect(html).toContain('<span> true</span>'); // truecolor: dropped, inherits
    for (const cls of classes) expect(SHIKI_CSS).toContain(`.${cls}{`);
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
