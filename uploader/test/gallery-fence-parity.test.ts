import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { normalizeGalleryFences, galleryFencesToMdx, rewriteOutsideGalleries } from '../src/body-content.js';
import { analyzeGallerySource, type GalleryBlock } from '../../site/src/lib/gallery-source.js';
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { analyzeRenderedBody, transformBodyImages } from '../../site/src/lib/body-images.js';
import { analyzeBodyContent } from '../src/publish-gate.js';
import { auditAltText } from '../src/alt-audit.js';
import type { PostLocale } from '../src/posts.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';

const URL = 'https://i/a';
const PHOTO = `${URL} | 10x20 | alt="Lake" | caption="Morning"`;
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One corpus measures every reader against the actual render tree, not another
// scanner with the same omissions. Extra info words never select a layout.
export const GALLERY_CORPUS: Array<[string, (photo: string) => string, boolean]> = [
  ['canonical', (p) => `\`\`\`gallery\n${p}\n\`\`\``, true],
  ['tilde', (p) => `~~~gallery\n${p}\n~~~`, true],
  ['long fence', (p) => `\`\`\`\`gallery\n${p}\n\`\`\`\`\``, true],
  ['one-space indent', (p) => ` \`\`\`gallery\n ${p}\n \`\`\``, true],
  ['two-space indent', (p) => `  ~~~gallery\n  ${p}\n  ~~~`, true],
  ['three-space indent', (p) => `   \`\`\`gallery\n   ${p}\n   \`\`\``, true],
  ['four-space code', (p) => `    \`\`\`gallery\n    ${p}\n    \`\`\``, false],
  ['tab code', (p) => `\t\`\`\`gallery\n\t${p}\n\t\`\`\``, false],
  ['extra info', (p) => `\`\`\`gallery slider arbitrary info\n${p}\n\`\`\``, true],
  ['different language', (p) => `\`\`\`gallery-notes\n${p}\n\`\`\``, false],
  ['invalid backtick info', (p) => `\`\`\`gallery bad\`info\n${p}`, false],
  ['list', (p) => `- Day one\n\n  ~~~gallery argument\n  ${p}\n  ~~~\n\n- Day two`, true],
  ['list opener', (p) => `- ~~~gallery\n  ${p}\n  ~~~\n- untouched`, true],
  ['quote', (p) => `> \`\`\`gallery\n> ${p}\n> \`\`\``, true],
  ['quote/list', (p) => `> - ~~~~gallery extra\n>   ${p}\n>   ~~~~~\n>\n> sibling`, true],
  ['tab prefix', (p) => `>\t~~~gallery\n>\t${p}\n>\t~~~`, true],
  ['partial indentation tab', (p) => `  \`\`\`gallery\n\t${p}\n  \`\`\``, true],
  ['closer spaces', (p) => `\`\`\`gallery\n${p}\n\`\`\`   `, true],
  ['closer tab', (p) => `\`\`\`gallery\n${p}\n\`\`\`\t`, true],
  ['NBSP is not a closer', (p) => `\`\`\`gallery\n${p}\n\`\`\`\u00a0\n# note\n\`\`\``, true],
  ['form-feed is not a closer', (p) => `\`\`\`gallery\n${p}\n\`\`\`\f\n\`\`\``, true],
  ['shorter closer is content', (p) => `~~~~gallery\n${p}\n~~~\n~~~~`, true],
  ['CRLF', (p) => `\`\`\`gallery\r\n${p}\r\n\`\`\`\r\n\r\nafter`, true],
  ['unterminated EOF', (p) => `\`\`\`gallery\n${p}`, true],
  ['unterminated trailing newline', (p) => `~~~gallery\n${p}\n`, true],
  ['backtick literal example', (p) => `\`\`\`\`\n\`\`\`gallery\n${p}\n\`\`\`\n\`\`\`\``, false],
  ['tilde literal example', (p) => `~~~\n\`\`\`gallery\n${p}\n\`\`\`\n~~~`, false],
  ['raw HTML', (p) => `<pre id="retained"><code class="language-gallery">${escapeHtml(p)}\n</code></pre>`, true],
  ['raw nested HTML', (p) => `<blockquote><pre> \n<code class="extra language-gallery"><span>${escapeHtml(p)}</span>\n</code> </pre></blockquote>`, true],
  ['raw Markdown quote', (p) => `> <pre><code class="language-gallery">${escapeHtml(p)}\n> </code></pre>`, true],
  ['raw inline HTML', (p) => `before <pre><code class="language-gallery">${escapeHtml(p)}</code></pre>`, true],
  ['Unicode before ranges', (p) => `🗺️ café 日本\r\n\r\n> ~~~gallery\r\n> ${p}\r\n> ~~~\r\n\r\n🦋 after`, true],
  ['directives', (p) => `\`\`\`gallery slider\n#layout: column\n#captions: hidden\n\n${p}\n\`\`\``, true],
];

interface BrowserApi {
  scanFences(body: string): Promise<GalleryBlock[]>;
  fenceAt(body: string, cursor: number): Promise<GalleryBlock | null>;
  replaceFenceAt(body: string, cursor: number, fence: string): Promise<{ start: number; end: number; text: string; blocked?: string }>;
}
function browser(): BrowserApi {
  const window: { GalleryFence?: BrowserApi } = {};
  vm.runInNewContext(browserScript('gallery-fence.js'), {
    window, AbortController, setTimeout, clearTimeout,
    ...galleryCodecBindings,
    fetch: async (_url: string, init: RequestInit) => ({ ok: true, json: () => analyzeGallerySource(JSON.parse(String(init.body)).bodyMarkdown) }),
  }, { filename: resolve('public/gallery-fence.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return window.GalleryFence!;
}
function locale(bodyMarkdown: string, images: PostLocale['images']): PostLocale {
  return { locale: 'de', slug: 'fixture', title: 'Fixture', excerpt: '', country: '', heroImage: { src: '', alt: '', width: 0, height: 0 }, bodyMarkdown, images };
}

for (const [name, shape, recognized] of GALLERY_CORPUS) {
  it(`renderer/save/export/audit/browser/publish agree: ${name}`, async () => {
    const typed = shape(PHOTO);
    const initial = { [URL]: { width: 10, height: 20, alt: 'Lake', caption: 'Morning' }, unrelated: { width: 1, height: 2, alt: 'retained' } };
    const saved = await normalizeGalleryFences(typed, initial);
    const source = await analyzeGallerySource(typed);
    const rendered = await renderMarkdown(typed);
    const actual = analyzeRenderedBody(rendered);
    expect(source.blocks.some((block) => block.isGallery)).toBe(recognized);
    expect(actual.galleryLines.includes(URL)).toBe(recognized);
    const G = browser();
    expect(await G.scanFences(typed)).toEqual(source.blocks);
    const block = source.blocks.find((entry) => entry.isGallery);
    if (block) expect(await G.fenceAt(typed, block.lines[0]?.start ?? block.start)).toMatchObject({ start: block.start, end: block.end });
    expect(saved.images.unrelated).toEqual(initial.unrelated);
    expect(await normalizeGalleryFences(saved.bodyMarkdown, saved.images)).toEqual(saved);
    const output = await transformBodyImages(await renderMarkdown(saved.bodyMarkdown), saved.images, 'https://i', { locale: 'en' });
    expect(output.includes('class="jgal ')).toBe(recognized);
    const exported = await galleryFencesToMdx(saved.bodyMarkdown, saved.images);
    const restored = await normalizeGalleryFences(exported, initial);
    expect(restored).toEqual(saved);
    if (recognized) {
      expect((await normalizeGalleryFences(typed, {})).images[URL]).toEqual(initial[URL]);
      expect((await analyzeGallerySource(exported)).blocks.find((entry) => entry.isGallery)?.content).toContain('10x20');
      expect(saved.bodyMarkdown).not.toBe(typed);
    } else expect(saved.bodyMarkdown).toBe(typed);
    const de = locale(shape(URL), { [URL]: { width: 10, height: 20 } });
    const audit = await auditAltText({ de, en: { ...locale('', {}), locale: 'en' } });
    expect(audit.images.some((photo) => photo.kind === 'gallery' && photo.src === URL)).toBe(recognized);
    const publication = await analyzeBodyContent(shape(URL), initial, 'https://foreign.example', 'en');
    expect(publication.foreign.includes(URL)).toBe(recognized);
  });
}

describe('source identity protects captions and ambiguous repeated text', () => {
  it('edits only the actual gallery occurrence, preserving CRLF and Unicode outside it', async () => {
    const outside = `🦋 literal ${PHOTO}\r\n\r\n`;
    const body = outside + `> ~~~gallery extra\r\n> ${PHOTO}\r\n> ~~~\r\n\r\n` + outside;
    const saved = await normalizeGalleryFences(body, {});
    expect(saved.bodyMarkdown).toBe(outside + `> ~~~gallery extra\r\n> ${URL}\r\n> ~~~\r\n\r\n` + outside);
  });

  it('keeps raw wrappers, existing entity spellings and untouched text nodes', async () => {
    const photo = 'https://i/a?x=1&amp;y=2';
    const body = `<pre data-note="keep"><code class="language-gallery"><b>${photo}</b> | 10x20 | alt=&quot;Lake&quot;\n</code></pre>`;
    const saved = await normalizeGalleryFences(body, {});
    expect(saved.bodyMarkdown).toBe(`<pre data-note="keep"><code class="language-gallery"><b>${photo}</b>\n</code></pre>`);
    expect(saved.images['https://i/a?x=1&y=2']).toMatchObject({ width: 10, height: 20, alt: 'Lake' });
    expect(await normalizeGalleryFences(await galleryFencesToMdx(saved.bodyMarkdown, saved.images), {})).toEqual(saved);
  });

  it('protects Markdown-looking captions in every recognized shape', async () => {
    for (const [, shape, recognized] of GALLERY_CORPUS) {
      if (!recognized) continue;
      const body = shape(`${URL} | caption-override="![x](https://other.example/photo)"`);
      expect(await rewriteOutsideGalleries(body, (text) => text.replace(/!\[x\]/g, 'CHANGED'))).toBe(body);
    }
  });

  it('recognizes but blocks replacement/removal of unterminated galleries', async () => {
    const G = browser();
    const body = `> ~~~gallery\n> ${PHOTO}\n> still source`;
    const found = await G.fenceAt(body, body.indexOf(URL));
    expect(found?.unterminated).toBe(true);
    for (const replacement of ['', `\`\`\`gallery\nhttps://i/b\n\`\`\``]) {
      const edit = await G.replaceFenceAt(body, body.indexOf(URL), replacement);
      expect(edit.blocked).toBe('unterminated');
      expect(body.slice(0, edit.start) + edit.text + body.slice(edit.end)).toBe(body);
    }
  });
});

describe('invalid metadata obeys the same authoritative gallery definition', () => {
  for (const [name, shape, recognized] of GALLERY_CORPUS) {
    it(`preserves bytes and original coordinates across save/export/picker: ${name}`, async () => {
      const line = `${URL} | 10x20 | alt="🦋 valid" | capton="retained" | caption-override="must not apply"  `;
      const body = shape(line);
      const images = { [URL]: { width: 40, height: 30, alt: 'Original', caption: 'Original caption' } };
      const saved = await normalizeGalleryFences(body, images);
      expect(saved.bodyMarkdown).toBe(body);
      expect(saved.images).toEqual(images);
      expect(await galleryFencesToMdx(body, images)).toBe(body);
      expect(await normalizeGalleryFences(saved.bodyMarkdown, saved.images)).toEqual(saved);
      if (!recognized) {
        expect(saved.galleryWarnings).toEqual([]);
        return;
      }
      const beforeField = body.slice(0, body.indexOf('capton=')).split(/\r\n|\r|\n/);
      expect(saved.galleryWarnings).toEqual([{ code: 'invalid_gallery_metadata',
        line: beforeField.length, column: beforeField.at(-1)!.length + 1,
        field: 'unknown', reason: 'unknown_field' }]);
      const G = browser();
      const edit = await G.replaceFenceAt(body, body.indexOf(URL), '```gallery\nhttps://i/b\n```');
      expect(edit.blocked).toBeTruthy();
      expect(body.slice(0, edit.start) + edit.text + body.slice(edit.end)).toBe(body);
      const rendered = await transformBodyImages(await renderMarkdown(body), images, 'https://i', { locale: 'en' });
      expect(rendered).toContain('alt="Original"');
      expect(rendered.includes('Original caption')).toBe(!body.includes('#captions: hidden'));
      expect(rendered).not.toContain('must not apply');
    });
  }
});
