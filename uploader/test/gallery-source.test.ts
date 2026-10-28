import { describe, expect, it } from 'vitest';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { analyzeRenderedBody } from '../../site/src/lib/body-images.js';
import { applyGalleryEdits, galleryContentEdit, galleryLineEdits } from '../public/gallery-source-edits.js';
import { normalizeGalleryFences, galleryFencesToMdx } from '../src/body-content.js';

const photo = 'https://i/a';
const apply = (body: string, edit: { start: number; end: number; text: string }) => body.slice(0, edit.start) + edit.text + body.slice(edit.end);

describe('gallery source provenance and bounded edits', () => {
  it('exposes exact UTF-16 offsets after astral, accented and CJK source', async () => {
    const before = '🗺️ café 日本\r\n\r\n> - ';
    const body = before + `~~~gallery argument\r\n>   ${photo}\r\n>   ~~~\r\n\r\n🦋`;
    const block = (await analyzeGallerySource(body)).blocks[0]!;
    expect(block.start).toBe(before.length);
    expect(block.end).toBe(body.lastIndexOf('~~~') + 3);
    expect(block.lines[0]).toMatchObject({ text: photo, start: body.indexOf(photo), end: body.indexOf(photo) + photo.length, prefix: '>   ', newline: '\r\n' });
    expect(block.unterminated).toBe(false);
  });

  it('retains the original indentation tab even when it contributes residual logical spaces', async () => {
    const body = `  \`\`\`gallery\n\t${photo} | 20x10 | alt="Lake"\n  \`\`\``;
    const saved = await normalizeGalleryFences(body, {});
    expect(saved.bodyMarkdown).toBe(`  \`\`\`gallery\n\t${photo}\n  \`\`\``);
    expect(await normalizeGalleryFences(await galleryFencesToMdx(saved.bodyMarkdown, saved.images), {})).toEqual(saved);
  });

  it('preserves entity spellings outside the actual changed text and treats multi-codepoint entities atomically', async () => {
    const body = '<pre><code class="language-gallery">a&NotEqualTilde;b &copy; unchanged</code></pre>';
    const line = (await analyzeGallerySource(body)).blocks[0]!.lines[0]!;
    const next = applyGalleryEdits(body, galleryLineEdits(line, 'a≂Xb © unchanged'));
    expect(next).toBe('<pre><code class="language-gallery">a≂Xb &copy; unchanged</code></pre>');
    expect((await analyzeGallerySource(next)).blocks[0]?.content).toBe('a≂Xb © unchanged');
  });

  it('adds raw HTML photos inside the original quote/list container, without replacing wrappers', async () => {
    const body = `> - <pre id="keep"><code class="language-gallery"><b>${photo}</b></code></pre>\n>\n> after`;
    const block = (await analyzeGallerySource(body)).blocks[0]!;
    const next = apply(body, galleryContentEdit(body, block, `${photo}\nhttps://i/b`));
    expect(next.startsWith('> - <pre id="keep"><code class="language-gallery"><b>')).toBe(true);
    expect(next).toContain('</b></code></pre>\n>\n> after');
    expect(next).toContain('\n>   https');
    expect(analyzeRenderedBody(await renderMarkdown(next)).galleryLines).toEqual([photo, 'https://i/b']);
  });

  it('keeps caption punctuation literal in inline raw HTML through export and save', async () => {
    const body = `before <pre><code class="language-gallery">${photo}</code></pre> after`;
    const images = { [photo]: { width: 20, height: 10, alt: 'Lake', caption: 'A -- "quote" *not emphasis*' } };
    const exported = await galleryFencesToMdx(body, images);
    const restored = await normalizeGalleryFences(exported, {});
    expect(restored.images).toEqual(images);
    expect(restored.bodyMarkdown).toBe(body);
  });

  it.each([
    ['> intro ', '> '],
    ['- intro ', '  '],
    ['> - intro ', '>   '],
  ])('preserves multiline inline-HTML container bytes for %s', async (opening, continuation) => {
    const metadata = ' | 20x10 | alt=&quot;Lake&quot;';
    for (const separator of ['\n' + continuation, '&#10;']) {
      const body = `${opening}<pre><code class="language-gallery">#layout: column${separator}text -- words\n${continuation}${photo}${metadata}\n${continuation}</code></pre> after`;
      const block = (await analyzeGallerySource(body)).blocks.find((entry) => entry.isGallery)!;
      expect(block.lines.map((line) => line.text)).toContain('text – words');
      expect(block.lines.map((line) => line.text)).toContain(`${photo} | 20x10 | alt="Lake"`);
      const saved = await normalizeGalleryFences(body, {});
      expect(saved.bodyMarkdown).toBe(body.replace(metadata, ''));
      expect(saved.images).toEqual({ [photo]: { width: 20, height: 10, alt: 'Lake' } });
      expect(await normalizeGalleryFences(await galleryFencesToMdx(saved.bodyMarkdown, saved.images), {})).toEqual(saved);
    }
  });

  it('treats unclosed raw HTML as analyzable but not a safe replacement range', async () => {
    const body = `<pre><code class="language-gallery">${photo}`;
    const block = (await analyzeGallerySource(body)).blocks[0]!;
    expect(block).toMatchObject({ isGallery: true, unterminated: true, content: photo });
    expect(() => galleryContentEdit(body, block, 'https://i/b')).toThrow('Unterminated');
    expect(await normalizeGalleryFences(body, { [photo]: { width: 20, height: 10 } })).toMatchObject({ bodyMarkdown: body });
  });

  it('represents non-gallery HTML code for insertion safety without classifying it as a gallery', async () => {
    const body = '<pre><code>literal ```gallery example</code></pre>';
    expect((await analyzeGallerySource(body)).blocks).toMatchObject([{ kind: 'html', isGallery: false, unterminated: false, start: 0, end: body.length }]);
  });

  it('supports empty nested HTML and fenced galleries without deleting the closer', async () => {
    for (const body of ['> <pre><code class="language-gallery"></code></pre>', '> ~~~gallery\n> ~~~']) {
      const block = (await analyzeGallerySource(body)).blocks[0]!;
      const next = apply(body, galleryContentEdit(body, block, photo));
      expect(next.startsWith('> ')).toBe(true);
      expect(next.endsWith(body.endsWith('</pre>') ? '</code></pre>' : '> ~~~')).toBe(true);
      expect(analyzeRenderedBody(await renderMarkdown(next)).galleryLines).toEqual([photo]);
    }
  });

  it('rejects overlapping edits before constructing a changed document', () => {
    expect(() => applyGalleryEdits('unchanged', [{ start: 1, end: 5, text: 'x' }, { start: 3, end: 6, text: 'y' }])).toThrow('Invalid gallery source span');
  });
});
