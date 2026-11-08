import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from '../../site/node_modules/happy-dom/lib/index.js';
import type { Editor } from '@tiptap/core';
import type { RichEditor, RichEditorCopy, RichEditorOptions } from '../src/editor-rich-text.js';

const copy: RichEditorCopy = {
  bodyLabel: 'Story (visual editor, EN)', sourceLabel: 'Source block', sourceHelp: 'Edit this source in Markdown mode.',
  galleryLabel: 'Gallery', editGallery: 'Edit gallery', imageUnavailable: 'Image unavailable',
  linkPrompt: 'Link URL', linkInvalid: 'Invalid link', galleryChecking: 'Checking Media',
  galleryLookupFailed: 'Media lookup failed', galleryRetry: 'Retry',
};
const windows: Window[] = [];
const editors: RichEditor[] = [];
afterEach(async () => {
  editors.splice(0).forEach((editor) => editor.destroy());
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.unstubAllGlobals();
});

async function mount(markdown: string, overrides: Partial<RichEditorOptions> = {}) {
  const window = new Window({ url: 'https://admin.example/admin/editor.html' });
  windows.push(window);
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMParser', 'NodeFilter', 'ClipboardEvent', 'KeyboardEvent'] as const) {
    vi.stubGlobal(name, name === 'window' ? window : window[name]);
  }
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const onChange = vi.fn();
  // Load after the browser globals: ProseMirror detects its environment at import time.
  const { createRichEditor } = await import('../src/editor-rich-text.js');
  const rich = createRichEditor({
    element: host as unknown as HTMLElement, markdown, locale: 'en', imageOrigin: 'https://images.example',
    copy, onChange, ...overrides,
  });
  editors.push(rich);
  const tiptap = host.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor };
  return { window, host, rich, editor: tiptap.editor, onChange };
}

function typeText(editor: Editor, text: string) {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

const thumb = ({ heroSrc, heroWidth, heroFormat }: { heroSrc: string; heroWidth?: number; heroFormat?: 'jpeg' }) =>
  heroWidth && Number.isInteger(heroWidth) && heroWidth > 0
    ? `${heroSrc}-${Math.min(640, heroWidth)}.${heroFormat ?? 'webp'}` : null;

const gallery = [
  '```gallery', '#layout: slider', '#captions: visible',
  'https://images.example/trips/first | 1200x800 | alt="Post alt" | caption="Post caption"',
  'https://images.example/trips/second | 320x200 | format="jpeg" | caption-override="Local &lt;caption&gt;"',
  '```',
].join('\n');

describe('rich-text Markdown source preservation', () => {
  it('opens and silently reloads the exact source including CRLF, blank lines and original spellings', async () => {
    const source = '\r\n#  A title  \r\n\r\nFirst _word_ and **bold**.\r\n\r\n\r\n- one\r\n  - two\r\n\r\n';
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.onChange).not.toHaveBeenCalled();
    h.rich.setMarkdown(source);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.onChange).not.toHaveBeenCalled();
    const replacement = 'Next\r\n\r\n' + gallery + '\r\n';
    h.rich.setMarkdown(replacement);
    expect(h.rich.getMarkdown()).toBe(replacement);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it('shows raw HTML and reference syntax as labelled inert source, retaining both on adjacent edits', async () => {
    const html = '<div><img src="https://evil.example/pixel" onerror="alert(1)"><script>alert(2)</script></div>';
    const references = '[trip][route]\n\n[route]: https://example.test/place "Title"';
    const source = `Before\n\n${html}\n\n${references}\n\nAfter`;
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.host.querySelector('script')).toBeNull();
    expect(h.host.querySelector('img')).toBeNull();
    expect(h.host.querySelectorAll('.rich-text-source').length).toBeGreaterThanOrEqual(2);
    expect(h.host.textContent).toContain(copy.sourceHelp);
    expect(h.host.textContent).toContain(html);
    h.rich.setSelection({ from: 3, to: 3 });
    typeText(h.editor, 'X');
    expect(h.rich.getMarkdown()).toBe(source.replace('Before', 'BefXore'));
    expect(h.onChange).toHaveBeenLastCalledWith(h.rich.getMarkdown());
    h.rich.undo();
    expect(h.rich.getMarkdown()).toBe(source);
    h.rich.redo();
    expect(h.rich.getMarkdown()).toBe(source.replace('Before', 'BefXore'));
  });

  it('preserves unchanged neighboring Markdown and gallery directives after a visual edit', async () => {
    const source = `Lead _exact_\n\n${gallery}\n\nTrailing **exact**`;
    const h = await mount(source, { thumbnailUrl: thumb });
    const end = source.lastIndexOf('Trailing') + 4;
    h.rich.setSelection({ from: end, to: end });
    typeText(h.editor, '!');
    expect(h.rich.getMarkdown()).toContain(`Lead _exact_\n\n${gallery}\n\n`);
    expect(h.rich.getMarkdown()).toContain('Trai!ling');
    expect(h.rich.getMarkdown()).toContain('**exact**');
  });

  it('keeps references, duplicate definitions, unknown directives and math as source atoms', async () => {
    const source = '[one][ref]\n\n[ref]: https://example.test/one\n\n[ref]: https://example.test/two\n\n:::custom\nKeep me\n:::\n\n$$\nx^2\n$$';
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.host.querySelectorAll('.rich-text-source').length).toBeGreaterThanOrEqual(3);
    h.rich.setMarkdown(source + '\n');
    expect(h.rich.getMarkdown()).toBe(source + '\n');
  });

  it('maps rich cursor and range boundaries to UTF-16 source offsets through emphasis and CRLF', async () => {
    const source = '🧭 Arrival\r\n\r\nStart **beautiful** finish';
    const h = await mount(source);
    const start = source.indexOf('beautiful') + 2;
    const end = source.indexOf('beautiful') + 6;
    h.rich.setSelection({ from: start, to: end });
    expect(h.rich.getSelection()).toEqual({ from: start, to: end });
    h.rich.setSelection({ from: end, to: end });
    typeText(h.editor, '!');
    expect(h.rich.getSelection()).toEqual({ from: end + 1, to: end + 1 });
    expect(h.rich.getMarkdown()).toContain('beauti!ful');
    expect(h.rich.getMarkdown().startsWith('🧭 Arrival\r\n\r\n')).toBe(true);
  });

  it('keeps a gallery-only document intact when typing at either boundary', async () => {
    const h = await mount(gallery, { thumbnailUrl: thumb });
    h.rich.setSelection({ from: gallery.length, to: gallery.length });
    typeText(h.editor, 'After');
    expect(h.rich.getMarkdown()).toBe(`${gallery}\n\nAfter`);
    h.rich.undo();
    expect(h.rich.getMarkdown()).toBe(gallery);
    h.rich.setSelection({ from: 0, to: 0 });
    typeText(h.editor, 'Before');
    expect(h.rich.getMarkdown()).toBe(`Before\n\n${gallery}`);
  });
});

describe('gallery and image safety', () => {
  it('previews only exact-origin variants, keeps photo order, and sends the opening source offset', async () => {
    const onEditGallery = vi.fn();
    const source = `Intro\n\n${gallery}\n\nEnd`;
    const h = await mount(source, { thumbnailUrl: thumb, onEditGallery });
    const images = [...h.host.querySelectorAll('.rich-text-gallery img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'https://images.example/trips/first-640.webp',
      'https://images.example/trips/second-320.jpeg',
    ]);
    expect(h.host.querySelector('.rich-text-gallery')?.textContent).toContain('#layout: slider');
    (h.host.querySelector('.rich-text-gallery-edit') as unknown as HTMLButtonElement).click();
    expect(onEditGallery).toHaveBeenCalledWith(source.indexOf('```gallery'));
    expect(h.rich.getMarkdown()).toBe(source);
  });

  it('maps a nested blockquote gallery back to its original fence without rewriting the container', async () => {
    const nested = '> Story\n>\n> ```gallery\n> https://images.example/a | 800x500 | caption=\"View\"\n> ```';
    const onEditGallery = vi.fn();
    const h = await mount(nested, { thumbnailUrl: thumb, onEditGallery });
    expect(h.rich.getMarkdown()).toBe(nested);
    expect(h.host.querySelector('.rich-text-source')?.textContent).toContain(nested);
    (h.host.querySelector('.rich-text-gallery-edit') as unknown as HTMLButtonElement).click();
    expect(onEditGallery).toHaveBeenCalledWith(nested.indexOf('```gallery'));
  });

  it('uses Media alt and caption, respects local override and never exposes stale inherited metadata during lookup', async () => {
    let resolveLookup: (entries: Map<string, { row?: { alt: Record<string, string>; caption: Record<string, string> }; missing?: boolean }>) => void = () => {};
    const lookup = vi.fn(() => new Promise<Map<string, { row?: { alt: Record<string, string>; caption: Record<string, string> }; missing?: boolean }>>((resolve) => { resolveLookup = resolve; }));
    const library = { peek: () => undefined, lookup };
    const h = await mount(gallery, { thumbnailUrl: thumb, galleryLibrary: library });
    expect(h.host.textContent).toContain('Checking Media');
    expect(h.host.textContent).not.toContain('Post caption');
    expect(h.host.textContent).toContain('Local <caption>');
    resolveLookup(new Map([
      ['https://images.example/trips/first', { row: { alt: { en: 'Library alt' }, caption: { en: 'Library caption' } } }],
      ['https://images.example/trips/second', { row: { alt: { en: 'Second alt' }, caption: { en: 'Library second' } } }],
    ]));
    await Promise.resolve();
    const images = [...h.host.querySelectorAll('.rich-text-gallery img')];
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['Library alt', 'Second alt']);
    expect(h.host.textContent).toContain('Library caption');
    expect(h.host.textContent).toContain('Local <caption>');
    expect(h.host.textContent).not.toContain('Library second');
    expect(h.rich.getMarkdown()).toBe(gallery);
  });

  it('retries failed Media lookups and honors hidden captions without changing source', async () => {
    const hidden = gallery.replace('#captions: visible', '#captions: hidden');
    const lookup = vi.fn()
      .mockResolvedValueOnce(new Map([['https://images.example/trips/first', { error: new Error('unavailable') }]]))
      .mockResolvedValueOnce(new Map([
        ['https://images.example/trips/first', { row: { alt: { en: 'Current' }, caption: { en: 'Hidden caption' } } }],
        ['https://images.example/trips/second', { missing: true }],
      ]));
    const h = await mount(hidden, { thumbnailUrl: thumb, galleryLibrary: { peek: () => undefined, lookup } });
    await Promise.resolve();
    expect(h.host.textContent).toContain(copy.galleryLookupFailed);
    const retry = [...h.host.querySelectorAll('button')].find((button) => button.textContent === copy.galleryRetry);
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await Promise.resolve();
    expect(lookup).toHaveBeenLastCalledWith(expect.any(Array), { fresh: true });
    const captions = [...h.host.querySelectorAll('figcaption')];
    expect(captions).toHaveLength(2);
    expect(captions.every((caption) => caption.hidden)).toBe(true);
    expect(h.rich.getMarkdown()).toBe(hidden);
  });

  it('ignores a late Media response after the gallery is replaced', async () => {
    let resolveLookup: (entries: Map<string, { row: { alt: Record<string, string>; caption: Record<string, string> } }>) => void = () => {};
    const lookup = () => new Promise<Map<string, { row: { alt: Record<string, string>; caption: Record<string, string> } }>>((resolve) => { resolveLookup = resolve; });
    const h = await mount(gallery, { thumbnailUrl: thumb, galleryLibrary: { peek: () => undefined, lookup } });
    const old = h.host.querySelector('.rich-text-gallery');
    h.rich.setMarkdown('Replacement');
    resolveLookup(new Map([['https://images.example/trips/first', { row: { alt: { en: 'Stale' }, caption: { en: 'Stale' } } }]]));
    await Promise.resolve();
    expect(old?.textContent).not.toContain('Stale');
    expect(h.host.textContent).not.toContain('Stale');
    expect(h.rich.getMarkdown()).toBe('Replacement');
  });

  it('rejects external, credentialed, javascript and data image URLs rather than fetching them', async () => {
    const source = [
      '![good](https://images.example/a.png)',
      '![evil](https://images.example.evil.test/a.png)',
      '![credentials](https://images.example@evil.test/a.png)',
      '![data](data:image/png;base64,AAAA)',
      '![script](javascript:alert(1))',
    ].join('\n\n');
    const h = await mount(source);
    expect([...h.host.querySelectorAll('img[src]')].map((image) => image.getAttribute('src'))).toEqual(['https://images.example/a.png']);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.host.textContent).toContain(copy.imageUnavailable);
  });

  it('never creates an active unsafe link and allows safe links', async () => {
    const source = '[bad](javascript:alert(1))\n\n[good](https://example.test/)';
    const h = await mount(source);
    expect(h.host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(h.host.querySelector('a[href="https://example.test/"]')).not.toBeNull();
    expect(h.rich.getMarkdown()).toBe(source);
  });
});

describe('Markdown serialization boundaries', () => {
  it.each([
    '[x](url)url',
    '[x](destination "url")url',
    '**[x](url)**url',
    '[a\\[x\\]](url)url',
  ])('maps visible trailing text outside link metadata: %s', async (source) => {
    const h = await mount(source);
    h.editor.commands.setTextSelection(h.editor.state.doc.content.size - 2);
    expect(h.rich.getSelection()).toEqual({ from: source.length - 1, to: source.length - 1 });
    h.rich.setSelection({ from: source.length - 1, to: source.length - 1 });
    typeText(h.editor, '!');
    expect(h.host.querySelector('a')?.getAttribute('href')).toBe(source.includes('destination') ? 'destination' : 'url');
    expect(h.host.textContent).toMatch(/ur!l$/);
  });

  it.each(['```gallery\n#layout: slider\nphoto', 'Before\n\n~~~js\nconst x = 1;', '> ```gallery\n> photo'])(
    'requires Markdown mode for an unterminated fence rather than appending inside it: %s',
    async (source) => {
      await expect(mount(source)).rejects.toThrow('Unterminated Markdown fence');
    },
  );

  it('widens code fences when an edited body contains fence delimiters', async () => {
    const source = '````js\nconst ticks = \"```\";\n````';
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    const at = source.indexOf('```\";') + 3;
    h.rich.setSelection({ from: at, to: at });
    typeText(h.editor, '`');
    const changed = h.rich.getMarkdown();
    expect(changed).toBe('`````js\nconst ticks = \"````\";\n`````');
    h.rich.setMarkdown('Temporary');
    h.rich.setMarkdown(changed);
    expect(h.host.querySelector('code')?.textContent).toBe('const ticks = \"````\";');
  });

  it('preserves escaped destinations and titles in links and images when their paragraph is edited', async () => {
    const source = 'Go [link](https://example.test/a\\(b\\) \"quote \\\"inside\\\"\") and ![ridge \\[north\\]](https://images.example/a\\(1\\).png \"photo \\\"one\\\"\")';
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    h.rich.setSelection({ from: 1, to: 1 });
    typeText(h.editor, '!');
    const changed = h.rich.getMarkdown();
    h.rich.setMarkdown('Temporary');
    h.rich.setMarkdown(changed);
    const link = h.host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.test/a(b)');
    expect(link?.getAttribute('title')).toBe('quote \"inside\"');
    const image = h.host.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('ridge [north]');
    expect(image?.getAttribute('src')).toBe('https://images.example/a(1).png');
    const paragraph = h.editor.getJSON().content?.[0];
    const imageNode = paragraph?.content?.find((node) => node.type === 'image');
    expect(imageNode && 'attrs' in imageNode ? imageNode.attrs?.title : undefined).toBe('photo \"one\"');
  });

  it('round-trips full named entities once in prose, image alt and link attributes', async () => {
    const source = 'A&nbsp;B &amp;copy; &copy; [link](https://example.test/?x=1&amp;y=2 "Tom &amp; Jerry") ![&copy;](https://images.example/a.png) ![&amp;copy;](https://images.example/b.png) and `&copy;`';
    const h = await mount(source);
    expect(h.rich.getMarkdown()).toBe(source);
    expect(h.host.textContent).toContain('A\u00a0B &copy; ©');
    expect(h.host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/?x=1&y=2');
    expect([...h.host.querySelectorAll('img[src]')].map((image) => image.getAttribute('alt'))).toEqual(['©', '&copy;']);
    expect(h.host.querySelector('code')?.textContent).toBe('&copy;');
    h.rich.setSelection({ from: 1, to: 1 });
    typeText(h.editor, '!');
    const changed = h.rich.getMarkdown();
    h.rich.setMarkdown('Temporary');
    h.rich.setMarkdown(changed);
    expect(h.host.textContent).toContain('A!\u00a0B &copy; ©');
    expect(h.host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/?x=1&y=2');
    expect(h.host.querySelector('a')?.getAttribute('title')).toBe('Tom & Jerry');
    expect([...h.host.querySelectorAll('img[src]')].map((image) => image.getAttribute('alt'))).toEqual(['©', '&copy;']);
    expect(h.host.querySelector('code')?.textContent).toBe('&copy;');
  });

  it('keeps named entities literal inside code while mapping the cursor to their source offsets', async () => {
    const source = '```html\n&amp;copy;\n```';
    const h = await mount(source);
    expect(h.host.querySelector('code')?.textContent).toBe('&amp;copy;');
    const at = source.indexOf('copy') + 2;
    h.rich.setSelection({ from: at, to: at });
    expect(h.rich.getSelection()).toEqual({ from: at, to: at });
    typeText(h.editor, '!');
    expect(h.rich.getMarkdown()).toBe('```html\n&amp;co!py;\n```');
  });
});

describe('editor commands and isolated histories', () => {
  it('formats text and supports undo, redo, heading, quote, lists and code', async () => {
    const h = await mount('A lovely place');
    h.rich.setSelection({ from: 2, to: 8 });
    expect(h.rich.command('bold')).toBe(true);
    expect(h.rich.getMarkdown()).toContain('**lovely**');
    expect(h.rich.undo()).toBe(true);
    expect(h.rich.getMarkdown()).toBe('A lovely place');
    expect(h.rich.redo()).toBe(true);
    expect(h.rich.getMarkdown()).toContain('**lovely**');
    h.rich.setSelection({ from: 2, to: 2 });
    expect(h.rich.command('heading')).toBe(true);
    expect(h.rich.isActive('heading')).toBe(true);
    expect(h.rich.command('heading')).toBe(true);
    expect(h.rich.command('quote')).toBe(true);
    expect(h.rich.isActive('quote')).toBe(true);
    expect(h.rich.command('quote')).toBe(true);
    expect(h.rich.command('bullets')).toBe(true);
    expect(h.rich.isActive('bullets')).toBe(true);
    expect(h.rich.command('bullets')).toBe(true);
    expect(h.rich.command('numbers')).toBe(true);
    expect(h.rich.isActive('numbers')).toBe(true);
    expect(h.rich.command('numbers')).toBe(true);
    expect(h.rich.command('code')).toBe(true);
    expect(h.rich.isActive('code')).toBe(true);
  });

  it('edits nested lists and retains an unchanged code block', async () => {
    const source = '- Outer\n  - Inner\n\n```js\nconst x = 1;\n```';
    const h = await mount(source);
    const at = source.indexOf('Inner') + 2;
    h.rich.setSelection({ from: at, to: at });
    typeText(h.editor, '!');
    expect(h.rich.getMarkdown()).toContain('In!ner');
    expect(h.rich.getMarkdown()).toContain('```js\nconst x = 1;\n```');
  });

  it('preserves the prior visual document in undo history after an external Markdown update', async () => {
    const h = await mount('First');
    h.rich.setMarkdown('Second');
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.rich.undo()).toBe(true);
    expect(h.rich.getMarkdown()).toBe('First');
    expect(h.onChange).toHaveBeenLastCalledWith('First');
    expect(h.rich.redo()).toBe(true);
    expect(h.rich.getMarkdown()).toBe('Second');
  });

  it('keeps independently mounted locale drafts and history isolated', async () => {
    const h = await mount('English');
    const otherHost = h.window.document.createElement('div');
    h.window.document.body.appendChild(otherHost);
    // The second instance shares the already-installed browser environment.
    const { createRichEditor } = await import('../src/editor-rich-text.js');
    const german = createRichEditor({ element: otherHost as unknown as HTMLElement, markdown: 'Deutsch', locale: 'de', imageOrigin: 'https://images.example', copy, onChange: () => {} });
    editors.push(german);
    const other = (otherHost.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor }).editor;
    german.setSelection({ from: 7, to: 7 });
    typeText(other, '!');
    expect(german.getMarkdown()).toBe('Deutsch!');
    expect(h.rich.getMarkdown()).toBe('English');
    german.undo();
    expect(german.getMarkdown()).toBe('Deutsch');
    expect(h.rich.getMarkdown()).toBe('English');
  });
});
