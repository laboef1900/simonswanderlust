import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/wp-content.js';

describe('htmlToMarkdown', () => {
  it('keeps headings, paragraphs, lists, links and images; drops Elementor wrappers/scripts', () => {
    const html = '<div class="elementor-widget" style="color:red"><h2>Title</h2><p>Para with <a href="https://x">link</a>.</p><ul><li>one</li><li>two</li></ul><img src="https://i/x.jpg" alt="Cap"><script>bad()</script></div>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Title');
    expect(md).toContain('Para with [link](https://x).');
    expect(md).toContain('- one');
    expect(md).toContain('![Cap](https://i/x.jpg)');
    expect(md).not.toContain('elementor');
    expect(md).not.toContain('bad()');
    expect(md).not.toContain('<div');
  });
});
