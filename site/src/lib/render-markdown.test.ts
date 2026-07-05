import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './render-markdown';

describe('renderMarkdown', () => {
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
