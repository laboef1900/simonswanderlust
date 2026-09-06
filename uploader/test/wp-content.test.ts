import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownImages } from '../src/wp-content.js';

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

/**
 * Issue #125: Turndown's image output is CommonMark, not `![alt](url)`. The
 * importer must decode what Turndown encodes, or it fetches a bogus URL.
 */
describe('markdownImages', () => {
  const only = (html: string) => {
    const md = htmlToMarkdown(html);
    const imgs = markdownImages(md);
    expect(imgs, md).toHaveLength(1);
    return { md, img: imgs[0]! };
  };

  it('strips a trailing "title" (the Elementor default: the attachment filename)', () => {
    const { md, img } = only('<img src="https://wp/uploads/a.jpg" alt="Beach" title="IMG_0001">');
    expect(md).toContain('"IMG_0001"');
    expect(img).toMatchObject({ alt: 'Beach', url: 'https://wp/uploads/a.jpg' });
    expect(md.replaceAll(img.full, 'X')).toBe('X');
  });

  it('unescapes parentheses in the destination', () => {
    const { img } = only('<img src="https://wp/uploads/photo-(1).jpg" alt="">');
    expect(img.url).toBe('https://wp/uploads/photo-(1).jpg');
  });

  it('accepts a <…>-wrapped destination containing a space', () => {
    const { md, img } = only('<img src="https://wp/uploads/my photo.jpg" alt="x">');
    expect(md).toContain('<https://wp/uploads/my photo.jpg>');
    expect(img.url).toBe('https://wp/uploads/my photo.jpg');
  });

  it('keeps an escaped ] in alt and still finds the destination', () => {
    const { img } = only('<img src="https://wp/a.jpg" alt="Day [1] of 3" title="t">');
    expect(img.alt).toBe('Day \\[1\\] of 3');
    expect(img.url).toBe('https://wp/a.jpg');
  });

  it('handles a title containing an escaped quote and a title in single quotes', () => {
    expect(markdownImages('![a](https://wp/a.jpg "he said \\"hi\\"") ![b](https://wp/b.jpg \'t\')').map((i) => i.url))
      .toEqual(['https://wp/a.jpg', 'https://wp/b.jpg']);
  });

  it('returns every image on a line, each with its own exact source text', () => {
    const md = htmlToMarkdown('<p><img src="https://wp/a.jpg" alt="A" title="ta"> <img src="https://wp/b.jpg" alt="B"></p>');
    const imgs = markdownImages(md);
    expect(imgs.map((i) => i.url)).toEqual(['https://wp/a.jpg', 'https://wp/b.jpg']);
    let out = md;
    for (const i of imgs) out = out.replaceAll(i.full, `![${i.alt}](https://img/${i.url.split('/').pop()})`);
    expect(out).toBe('![A](https://img/a.jpg) ![B](https://img/b.jpg)');
  });

  it('ignores a plain link and an empty destination', () => {
    expect(markdownImages('[text](https://wp/a.jpg) ![](  )')).toEqual([]);
  });
});

describe('htmlToMarkdown classic shortcodes', () => {
  const attachments = new Map([['1', 'https://wp/one.jpg'], ['2', 'https://wp/two.jpg'], ['3', 'https://wp/three.jpg']]);

  it('expands [gallery ids] against the attachment map into a ```gallery fence', () => {
    const md = htmlToMarkdown('<p>Before</p>[gallery ids="1,2,99"]<p>After</p>', attachments);
    expect(md).toContain('```gallery\nhttps://wp/one.jpg\nhttps://wp/two.jpg\n```');
    expect(md).not.toContain('gallery ids');
    expect(md).not.toMatch(/\\\[/);
  });

  it('keeps two [gallery] shortcodes as two fences', () => {
    const md = htmlToMarkdown('[gallery ids="1"]<p>x</p>[gallery ids="2,3"]', attachments);
    expect(md.match(/```gallery/g)).toHaveLength(2);
  });

  it('leaves a [gallery] with no ids, or with only unknown ids, as it was', () => {
    for (const sc of ['[gallery]', '[gallery columns="3"]', '[gallery ids="7,8"]']) {
      const md = htmlToMarkdown(`<p>${sc}</p>`, attachments);
      expect(md).not.toContain('```gallery');
    }
  });

  it('does not expand shortcodes when no attachment map is given', () => {
    expect(htmlToMarkdown('[gallery ids="1"]')).not.toContain('```gallery');
  });

  it('unwraps [caption] into the image followed by its caption text', () => {
    const md = htmlToMarkdown(
      '[caption id="attachment_5" align="alignnone" width="300"]<img src="https://wp/a.jpg" alt="A" width="300" /> The old town at dusk[/caption]',
      attachments,
    );
    expect(md).toContain('![A](https://wp/a.jpg)');
    expect(md).toContain('The old town at dusk');
    expect(md).not.toContain('caption');
  });

  it('keeps the click-through link of a linked image inside [caption]', () => {
    const md = htmlToMarkdown(
      '[caption id="attachment_5" align="alignnone" width="300"]<a href="https://wp/full.jpg"><img src="https://wp/thumb.jpg" alt="A" /></a> Caption[/caption]',
      attachments,
    );
    expect(md).toContain('[![A](https://wp/thumb.jpg)](https://wp/full.jpg)');
    expect(md).toContain('Caption');
    expect(md).not.toContain('</a>');
    expect(markdownImages(md).map((i) => i.url)).toEqual(['https://wp/thumb.jpg']);
  });
});
