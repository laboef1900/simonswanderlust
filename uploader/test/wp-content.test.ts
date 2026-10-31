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

  it('merges an Elementor colon heading and br-joined subtitle into one outline entry', () => {
    const md = htmlToMarkdown('<h2>Santa Cruz:<br>Between Lava Fields and Sea Lions</h2>');
    expect(md).toBe('## Santa Cruz — Between Lava Fields and Sea Lions');
  });

  it.each(['Eckdaten', 'Key data', 'Key facts', 'kEy FaCtS'])(
    'splits only ordinary opening paragraphs before %s, keeping fact rows intact',
    (facts) => {
      const md = htmlToMarkdown(
        '<h2>Opening</h2><p>First thought.<br>Second thought.<br>Third thought.</p>' +
          `<h3>${facts}</h3><p>Population:<br>10,000</p>`,
      );
      expect(md).toBe(
        `## Opening\n\nFirst thought.\n\nSecond thought.\n\nThird thought.\n\n### ${facts}\n\nPopulation:  \n10,000`,
      );
    },
  );

  it('preserves every hard break without a facts heading, including later lists and quotes', () => {
    expect(htmlToMarkdown(
      '<p>Intro line<br>second</p><h2>Unterwegs</h2>' +
      '<p>Öffnungszeiten:<br>Mo–Fr 9–17<br>Sa 10–14</p>' +
      '<ul><li>Bus<br>Linie 5</li><li>Taxi</li></ul>' +
      '<blockquote><p>Zitat eins<br>Zitat zwei</p></blockquote>',
    )).toBe(
      'Intro line  \nsecond\n\n## Unterwegs\n\nÖffnungszeiten:  \nMo–Fr 9–17  \nSa 10–14\n\n' +
      '- Bus  \n    Linie 5\n- Taxi\n\n> Zitat eins  \n> Zitat zwei',
    );
  });

  it('does not infer paragraphs from hard breaks in a body with no headings', () => {
    expect(htmlToMarkdown('<p>Address:<br>First street<br>Second town</p>'))
      .toBe('Address:  \nFirst street  \nSecond town');
  });

  it.each(['h2', 'h3', 'h4'])('treats nested Elementor wrappers as transparent around a %s facts boundary', (tag) => {
    expect(htmlToMarkdown(
      '<div class="elementor-section"><div class="elementor-widget"><h2>Opening</h2></div>' +
      '<div class="elementor-widget-text-editor"><div><p>One<br>Two</p><p>Three<br>Four</p></div></div>' +
      `<div><${tag}>Eckdaten</${tag}></div><div><p>Fact<br>Value</p></div></div>`,
    )).toBe(`## Opening\n\nOne\n\nTwo\n\nThree\n\nFour\n\n${'#'.repeat(Number(tag[1]))} Eckdaten\n\nFact  \nValue`);
  });

  it.each(['h2', 'h3', 'h4'])('stops at an intervening %s section even when facts appear later', (tag) => {
    expect(htmlToMarkdown(
      '<div><h2>Opening</h2><p>One<br>Two</p></div>' +
      `<div><${tag}>On the road</${tag}><p>Three<br>Four</p></div><h3>Key facts</h3>`,
    )).toBe(`## Opening\n\nOne  \nTwo\n\n${'#'.repeat(Number(tag[1]))} On the road\n\nThree  \nFour\n\n### Key facts`);
  });

  it('never splits lists, continuation paragraphs, quotes, code, headings or gallery text before facts', () => {
    expect(htmlToMarkdown(
      '<h2>Opening<br>Subtitle</h2><p>One<br>Two</p>' +
      '<ul><li>Bus<br>Line 5<p>Continuation<br>Still the same item</p></li></ul>' +
      '<blockquote><p>Quote<br>Another line</p></blockquote>' +
      '<pre><code>literal  \nline</code></pre>' +
      '<p><code>inline<br>code</code></p>' +
      '<div class="elementor-widget-gallery"><p>Gallery text<br>Second line</p>' +
      '<a href="https://wp/a.jpg" data-elementor-lightbox-slideshow="g" ' +
      'data-elementor-lightbox-title="Key facts&#10;second line"></a></div>' +
      '<h3>Key facts</h3>',
    )).toBe(
      '## Opening  \nSubtitle\n\nOne\n\nTwo\n\n' +
      '- Bus  \n    Line 5\n    \n    Continuation  \n    Still the same item\n    \n\n' +
      '> Quote  \n> Another line\n\n```' + '\nliteral  \nline\n```\n\n' +
      '`inline   code`\n\nGallery text  \nSecond line\n\n' +
      '```gallery\nhttps://wp/a.jpg | alt="Key facts second line"\n```\n### Key facts',
    );
  });

  it.each([
    '<p>## Key facts</p>',
    '<pre><code>&lt;h3&gt;Key facts&lt;/h3&gt;</code></pre>',
    '<blockquote><h3>Key facts</h3></blockquote>',
    '<ul><li><h3>Key facts</h3></li></ul>',
    '<h5>Key facts</h5>',
    '<h3>Key factual notes</h3>',
  ])('does not treat %s as a qualifying facts boundary', (html) => {
    expect(htmlToMarkdown(`<p>One<br>Two</p>${html}`)).toMatch(/^One {2}\nTwo\n\n/);
  });

  it('does not treat facts rows themselves as opening copy when facts come first', () => {
    expect(htmlToMarkdown('<h3>Key data</h3><p>Fact<br>Value</p><h3>Eckdaten</h3>'))
      .toBe('### Key data\n\nFact  \nValue\n\n### Eckdaten');
  });

  it('isolates facts-boundary state across consecutive DE and EN conversions', () => {
    for (const facts of ['Eckdaten', 'Key data', 'Key facts']) {
      expect(htmlToMarkdown(`<p>One<br>Two</p><h3>${facts}</h3>`))
        .toBe(`One\n\nTwo\n\n### ${facts}`);
      expect(htmlToMarkdown('<p>Three<br>Four</p><h2>Unterwegs</h2>'))
        .toBe('Three  \nFour\n\n## Unterwegs');
    }
  });

  it('drops an empty legacy TOC slot but preserves a real authored contents section', () => {
    const empty = htmlToMarkdown(
      '<h3>Table of Contents</h3><img src="https://wp/lead.jpg" alt=""><h2>Story</h2>',
    );
    expect(empty).not.toContain('Table of Contents');
    expect(empty).toContain('![](https://wp/lead.jpg)');

    const authored = htmlToMarkdown('<h3>Contents</h3><ul><li><a href="#one">One</a></li></ul>');
    expect(authored).toContain('### Contents');
    expect(authored).toContain('[One](#one)');
  });

  // Issue #143: the gallery marker is a NUL-delimited line. Elementor sources
  // the lightbox title from the attachment caption (a textarea), and Turndown
  // prefixes blockquote/list lines — either used to leave U+0000 in the body,
  // which Postgres refuses AFTER every photo of the pair was fetched.
  describe('never leaks the gallery marker (issue #143)', () => {
    const anchor = (title: string, href = 'https://wp/a.jpg') =>
      `<a href="${href}" data-elementor-lightbox-slideshow="g1" data-elementor-lightbox-title="${title}"></a>`;

    it('folds an anchor whose title spans lines, with the title collapsed to one line', () => {
      const md = htmlToMarkdown(anchor('line one\nline two\r\n\tthree') + anchor('B'));
      expect(md).not.toContain('\u0000');
      expect(md).toBe('```gallery\nhttps://wp/a.jpg | alt="line one line two three"\nhttps://wp/a.jpg | alt="B"\n```');
    });

    it('degrades an anchor inside a blockquote or list item to an inline image the re-host pass finds', () => {
      for (const html of [`<blockquote>${anchor('Day [1]')}</blockquote>`, `<ul><li>${anchor('Day [1]')}</li></ul>`]) {
        const md = htmlToMarkdown(html);
        expect(md).not.toContain('\u0000');
        expect(md).not.toContain('```gallery');
        expect(markdownImages(md)).toMatchObject([{ alt: 'Day \\[1\\]', url: 'https://wp/a.jpg' }]);
      }
    });

    it('wraps a spaced destination and escapes parentheses in the degraded image', () => {
      const md = htmlToMarkdown(`<blockquote>${anchor('', 'https://wp/my photo (1).jpg')}</blockquote>`);
      expect(markdownImages(md).map((i) => i.url)).toEqual(['https://wp/my photo (1).jpg']);
    });
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

  // Gallery-local captions (2026-10-19): a gallery line's text is never an
  // inline image, however it reads — every caller would otherwise re-host,
  // audit or back-fill a caption as if it were a photo.
  it('skips gallery fences, including image-like caption text, but not other code fences', () => {
    const md = [
      '![a](https://wp/a.jpg)',
      '```gallery',
      '#captions: hidden',
      'https://img/g | caption-override="![b](https://wp/b.jpg)" | alt="![c](https://wp/c.jpg)"',
      '```',
      '````',
      '![d](https://wp/d.jpg)',
      '````',
      '![e](https://wp/e.jpg)',
    ].join('\n');
    expect(markdownImages(md).map((i) => i.url)).toEqual(['https://wp/a.jpg', 'https://wp/d.jpg', 'https://wp/e.jpg']);
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
