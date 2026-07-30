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

  it('converts an Elementor lightbox slideshow into one ```gallery fence', () => {
    const html =
      '<div class="elementor-widget-gallery">' +
      '<a href="https://wp/a.jpg" data-elementor-open-lightbox="yes" data-elementor-lightbox-slideshow="g1" data-elementor-lightbox-title="Alpha"></a>' +
      '<a href="https://wp/b.jpg" data-elementor-open-lightbox="yes" data-elementor-lightbox-slideshow="g1" data-elementor-lightbox-title="Beta"></a>' +
      '</div>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('```gallery\nhttps://wp/a.jpg | alt="Alpha"\nhttps://wp/b.jpg | alt="Beta"\n```');
  });

  it('keeps two different slideshows as two separate fences', () => {
    const a = (href: string, g: string) =>
      `<a href="${href}" data-elementor-lightbox-slideshow="${g}" data-elementor-lightbox-title="t"></a>`;
    const md = htmlToMarkdown(`<div>${a('https://wp/a.jpg', 'g1')}${a('https://wp/b.jpg', 'g2')}</div>`);
    expect(md.match(/```gallery/g)).toHaveLength(2);
    expect(md).toContain('```gallery\nhttps://wp/a.jpg | alt="t"\n```');
    expect(md).toContain('```gallery\nhttps://wp/b.jpg | alt="t"\n```');
  });

  it('escapes quotes and pipes in an Elementor lightbox title', () => {
    const md = htmlToMarkdown(
      '<a href="https://wp/a.jpg" data-elementor-lightbox-slideshow="g1" ' +
        'data-elementor-lightbox-title="He said &quot;hi&quot; | then left"></a>',
    );
    const line = md.split('\n').find((l) => l.startsWith('https://wp/a.jpg'))!;
    // exactly one field separator — the metadata delimiter, not the one in the text
    expect(line.split(' | ')).toHaveLength(2);
    expect(line).not.toContain('"hi"');
  });

  it('leaves a plain link to a file alone (no slideshow id means it is not a gallery)', () => {
    const md = htmlToMarkdown('<p><a href="https://wp/report.pdf">Download</a></p>');
    expect(md).toContain('[Download](https://wp/report.pdf)');
    expect(md).not.toContain('```gallery');
  });
});
