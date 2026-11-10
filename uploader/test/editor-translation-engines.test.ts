import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from '../../site/node_modules/happy-dom/lib/index.js';
import type { Editor } from '@tiptap/core';
import type { EditorImageMetadata, RichEditor, RichEditorOptions } from '../src/editor-rich-text.js';
import { closeHistory, undoDepth, redoDepth } from '@tiptap/pm/history';
import { ui } from '../../site/src/i18n/ui.js';

interface Position { line: number; ch: number }
interface CodeMirror {
  getValue(): string;
  historySize(): { undo: number; redo: number };
  listSelections(): { anchor: Position; head: Position }[];
  setSelection(anchor: Position, head: Position): void;
  posFromIndex(index: number): Position;
  replaceRange(text: string, from: Position, to: Position, origin: string): void;
  on(event: string, callback: () => void): void;
  undo(): void;
  redo(): void;
}
interface Bridge {
  sourceTransaction(commit: () => void, rollback: () => void): void;
  setMode(mode: string): void;
  destroy(): void;
}
const windows: Window[] = [];
const bridges: Bridge[] = [];
afterEach(async () => {
  bridges.splice(0).forEach((bridge) => bridge.destroy());
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.unstubAllGlobals();
});

async function mount(options: Pick<RichEditorOptions, 'images' | 'galleryLibrary' | 'thumbnailUrl'> & { markdown?: string } = {}) {
  const window = new Window({ url: 'https://images.example/admin/editor.html' });
  windows.push(window);
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMParser', 'NodeFilter', 'ClipboardEvent', 'KeyboardEvent'] as const) {
    vi.stubGlobal(name, name === 'window' ? window : window[name]);
  }
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  // Import after browser globals: this intentionally exercises the same module
  // loading boundary as editor-rich-text.test.ts (ProseMirror detects the DOM).
  const { createRichEditor } = await import('../src/editor-rich-text.js');
  const richEditors: RichEditor[] = [];
  Object.assign(window, { structuredClone, richFixture: options, RichTextEditor: { create(options: RichEditorOptions) {
    const rich = createRichEditor(options);
    richEditors.push(rich);
    return rich;
  } } });
  window.document.body.innerHTML = '<div id="source"><textarea></textarea></div><div id="rich"></div><p id="error"></p><button id="visual"></button><button id="markdown"></button><button id="gallery"></button>';
  window.eval(readFileSync(new URL('../node_modules/easymde/dist/easymde.min.js', import.meta.url), 'utf8'));
  window.eval(readFileSync(new URL('../public/editor-rich-bridge.js', import.meta.url), 'utf8'));
  const copy = Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
  const galleryCopy = Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.gallery.')).map(([key, value]) => [key.slice('editor.gallery.'.length), value]));
  const cm = window.eval(`
    window.mde = new EasyMDE({ element: document.querySelector('textarea'), autoDownloadFontAwesome: false,
      spellChecker: false, toolbar: false, status: false });
    window.cm = mde.codemirror;
    cm.setOption('historyEventDelay', 0);
    mde.value(richFixture.markdown ?? 'First'); cm.clearHistory(); cm;
  `) as CodeMirror;
  const bridge = window.eval(`EditorRichBridge.create({ mde, element: document.getElementById('rich'),
    source: document.getElementById('source'), error: document.getElementById('error'),
    visualButton: document.getElementById('visual'), markdownButton: document.getElementById('markdown'),
    galleryToggle: document.getElementById('gallery'), formatButtons: [], locale: 'en',
    imageOrigin: location.origin, images: richFixture.images || (() => ({})),
    galleryLibrary: richFixture.galleryLibrary, thumbnailUrl: richFixture.thumbnailUrl, copy: ${JSON.stringify(copy)},
    galleryCopy: ${JSON.stringify(galleryCopy)} })`) as Bridge;
  bridges.push(bridge);
  // Tiptap attaches its actual Editor to this known rendered contenteditable.
  const element = window.document.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor };
  return { window, cm, bridge, rich: richEditors[0]!, editor: element.editor };
}

describe('atomic translation across real CodeMirror and ProseMirror engines', () => {
  it.each([
    ['visual', 'field'], ['visual', 'change callback'], ['markdown', 'field'], ['markdown', 'change callback'],
  ] as const)('preserves existing Visual undo AND redo on failed %s commit (%s), including selection and CodeMirror history', async (mode, failure) => {
    const h = await mount();
    h.rich.setSelection({ from: 5, to: 5 });
    h.editor.view.dispatch(closeHistory(h.editor.state.tr).insertText(' A'));
    h.rich.setSelection({ from: 7, to: 7 });
    h.editor.view.dispatch(closeHistory(h.editor.state.tr).insertText(' B'));
    expect(h.rich.getMarkdown()).toBe('First A B');
    h.rich.undo();
    expect(h.rich.getMarkdown()).toBe('First A');
    expect(undoDepth(h.editor.state)).toBeGreaterThan(0);
    expect(redoDepth(h.editor.state)).toBeGreaterThan(0);
    h.bridge.setMode(mode);
    h.cm.setSelection({ line: 0, ch: 1 }, { line: 0, ch: 4 });
    const body = h.cm.getValue();
    const selection = h.cm.listSelections().map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch },
    }));
    const richSelection = h.rich.getSelection();
    const visualHistory = [undoDepth(h.editor.state), redoDepth(h.editor.state)];
    const target = { title: 'Old title', excerpt: 'Old excerpt', images: { image: { width: 100, height: 50, alt: 'Old alt' } } };
    const beforeFields = structuredClone(target);
    const setMarkdown = vi.spyOn(h.rich, 'setMarkdown');
    const setSelection = vi.spyOn(h.rich, 'setSelection');
    let fail = true;
    if (failure === 'change callback') h.cm.on('change', () => {
      if (fail) { fail = false; throw new Error('injected source callback failure'); }
    });
    expect(() => h.bridge.sourceTransaction(() => {
      target.title = 'Translated title'; target.excerpt = 'Translated excerpt'; target.images.image.alt = 'Translated alt';
      h.cm.replaceRange('Translated body', { line: 0, ch: 0 }, h.cm.posFromIndex(body.length), 'article-translation');
      h.cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 10 });
      if (failure === 'field') throw new Error('injected field commit failure');
    }, () => Object.assign(target, structuredClone(beforeFields)))).toThrow(/injected/);
    expect(target).toEqual(beforeFields);
    expect(h.cm.getValue()).toBe(body);
    expect(h.cm.listSelections().map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch },
    }))).toEqual(selection);
    expect(h.rich.getMarkdown()).toBe(body);
    expect(h.rich.getSelection()).toEqual(richSelection);
    expect([undoDepth(h.editor.state), redoDepth(h.editor.state)]).toEqual(visualHistory);
    expect(setMarkdown).not.toHaveBeenCalled();
    expect(setSelection).not.toHaveBeenCalled();
    if (mode === 'visual') {
      expect(h.rich.undo()).toBe(true);
      expect(h.rich.getMarkdown()).toBe('First');
      expect(h.cm.getValue()).toBe('First');
      expect(h.rich.redo()).toBe(true);
      expect(h.rich.getMarkdown()).toBe('First A');
      expect(h.rich.redo()).toBe(true);
      expect(h.rich.getMarkdown()).toBe('First A B');
      expect(h.cm.getValue()).toBe('First A B');
    } else {
      // The source history contains the two Visual edits and the Visual undo
      // that wrote A back to source. Traverse every original entry both ways.
      for (const expected of ['First A B', 'First A', 'First']) {
        h.cm.undo();
        expect(h.cm.getValue()).toBe(expected);
        expect(h.rich.getMarkdown()).toBe(expected);
      }
      for (const expected of ['First A', 'First A B', body]) {
        h.cm.redo();
        expect(h.cm.getValue()).toBe(expected);
        expect(h.rich.getMarkdown()).toBe(expected);
      }
    }
  });

  it('commits all fields before exactly one rich synchronization and preserves body undo', async () => {
    const h = await mount();
    let title = 'Original';
    const set = h.rich.setMarkdown.bind(h.rich);
    const sync = vi.spyOn(h.rich, 'setMarkdown').mockImplementation((value) => { expect(title).toBe('Translated'); set(value); });
    h.bridge.sourceTransaction(() => {
      h.cm.replaceRange('Translated story', { line: 0, ch: 0 }, h.cm.posFromIndex(h.cm.getValue().length), 'article-translation');
      title = 'Translated';
    }, () => { title = 'Original'; });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(h.rich.getMarkdown()).toBe('Translated story');
    h.rich.undo();
    expect(h.cm.getValue()).toBe('First');
    expect(title).toBe('Translated');
  });

  it('refreshes same-body local gallery fallbacks on Apply and Undo, preserving Media ownership and both histories', async () => {
    const local = 'https://images.example/local';
    const library = 'https://images.example/library';
    const body = ['```gallery', '#layout: slider', local,
      local + ' | caption-override="Only here"', local + ' | caption-override=""', library, '```',
      '', '```gallery', '#captions: hidden', local, '```'].join('\n');
    const images: Record<string, EditorImageMetadata> = {
      [local]: { width: 900, height: 600, alt: 'Old alt', caption: 'Old caption' },
      [library]: { width: 900, height: 600, alt: 'Old library fallback', caption: 'Old library caption' },
    };
    const entries = new Map<string, { missing?: boolean; row?: { alt: { en: string }; caption: { en: string } } }>([
      [local, { missing: true }],
      [library, { row: { alt: { en: '' }, caption: { en: '' } } }],
    ]);
    const lookup = vi.fn(async () => entries);
    const h = await mount({
      images: () => images, galleryLibrary: { peek: (src) => entries.get(src), lookup },
      thumbnailUrl: ({ heroSrc, heroWidth, heroFormat }) => heroWidth ? `${heroSrc}-${Math.min(640, heroWidth)}.${heroFormat ?? 'webp'}` : null,
    });
    h.cm.replaceRange(body, { line: 0, ch: 0 }, h.cm.posFromIndex(h.cm.getValue().length), 'seed-gallery');
    h.editor.view.dispatch(closeHistory(h.editor.state.tr));
    h.cm.replaceRange(body + '\n\nTail', { line: 0, ch: 0 }, h.cm.posFromIndex(body.length), 'seed-tail');
    h.rich.undo();
    expect(h.cm.getValue()).toBe(body);
    const visualHistory = [undoDepth(h.editor.state), redoDepth(h.editor.state)];
    expect(visualHistory.every((depth) => depth > 0)).toBe(true);
    const sourceHistory = h.cm.historySize();
    const selection = h.rich.getSelection();
    const before = structuredClone(images);
    const translated = {
      [local]: { width: 320, height: 200, alt: 'A mountain', caption: 'First view', format: 'jpeg' as const },
      [library]: { width: 900, height: 600, alt: 'Translated library fallback', caption: 'Translated library caption' },
    };
    const setMarkdown = vi.spyOn(h.rich, 'setMarkdown');
    const refresh = vi.spyOn(h.rich, 'refreshImageMetadata');
    expect([...h.window.document.querySelectorAll('.rich-text-gallery figcaption')].map((caption) => caption.textContent))
      .toEqual(['Old caption', 'Only here', '', '', 'Old caption']);
    h.bridge.sourceTransaction(() => { Object.assign(images, translated); }, () => { Object.assign(images, before); });
    await Promise.resolve();
    const photos = [...h.window.document.querySelectorAll('.rich-text-gallery img')];
    expect(photos.map((photo) => photo.getAttribute('alt'))).toEqual(['A mountain', 'A mountain', 'A mountain', '', 'A mountain']);
    expect(photos[0]?.getAttribute('src')).toBe(local + '-320.jpeg');
    expect([...h.window.document.querySelectorAll('.rich-text-gallery figcaption')].map((caption) => caption.textContent))
      .toEqual(['First view', 'Only here', '', '', 'First view']);
    expect([...h.window.document.querySelectorAll('.rich-text-gallery figcaption')].at(-1)?.hasAttribute('hidden')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(setMarkdown).not.toHaveBeenCalled();
    expect(h.cm.getValue()).toBe(body);
    expect(h.rich.getMarkdown()).toBe(body);
    expect(h.rich.getSelection()).toEqual(selection);
    expect(h.cm.historySize()).toEqual(sourceHistory);
    expect([undoDepth(h.editor.state), redoDepth(h.editor.state)]).toEqual(visualHistory);
    expect(lookup).not.toHaveBeenCalled();

    // Dedicated Undo restores the complete field map through the same successful
    // transaction, even though the Markdown remains byte-for-byte identical.
    h.bridge.sourceTransaction(() => { Object.assign(images, before); }, () => { Object.assign(images, translated); });
    await Promise.resolve();
    expect([...h.window.document.querySelectorAll('.rich-text-gallery img')].map((photo) => photo.getAttribute('alt')))
      .toEqual(['Old alt', 'Old alt', 'Old alt', '', 'Old alt']);
    expect([...h.window.document.querySelectorAll('.rich-text-gallery figcaption')].map((caption) => caption.textContent))
      .toEqual(['Old caption', 'Only here', '', '', 'Old caption']);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(h.cm.historySize()).toEqual(sourceHistory);
    expect([undoDepth(h.editor.state), redoDepth(h.editor.state)]).toEqual(visualHistory);

    expect(() => h.bridge.sourceTransaction(() => {
      Object.assign(images, translated);
      throw new Error('metadata field commit failed');
    }, () => { Object.assign(images, before); })).toThrow('metadata field commit failed');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(h.window.document.querySelector('.rich-text-gallery figcaption')?.textContent).toBe('Old caption');
    expect(h.cm.historySize()).toEqual(sourceHistory);
    expect([undoDepth(h.editor.state), redoDepth(h.editor.state)]).toEqual(visualHistory);
    expect(h.rich.redo()).toBe(true);
    expect(h.cm.getValue()).toBe(body + '\n\nTail');
    expect(h.rich.undo()).toBe(true);
    expect(h.cm.getValue()).toBe(body);
    expect(h.rich.undo()).toBe(true);
    expect(h.cm.getValue()).toBe('First');
  });

  it('refreshes inline rendition metadata without changing inline alt authority, source or history', async () => {
    const src = 'https://images.example/inline';
    const body = `![Article-local alt](${src})`;
    const images: Record<string, EditorImageMetadata> = { [src]: { width: 900, height: 600, alt: 'Stored fallback' } };
    const h = await mount({
      markdown: body, images: () => images,
      thumbnailUrl: ({ heroSrc, heroWidth, heroFormat }) => heroWidth ? `${heroSrc}-${Math.min(640, heroWidth)}.${heroFormat ?? 'webp'}` : null,
    });
    const sourceHistory = h.cm.historySize();
    const visualHistory = [undoDepth(h.editor.state), redoDepth(h.editor.state)];
    const before = structuredClone(images);
    h.bridge.sourceTransaction(() => {
      images[src] = { width: 320, height: 200, format: 'jpeg', alt: 'Translated fallback' };
    }, () => { Object.assign(images, before); });
    await Promise.resolve();
    const image = h.window.document.querySelector('.rich-text-image img');
    expect(image?.getAttribute('src')).toBe(src + '-320.jpeg');
    expect(image?.getAttribute('alt')).toBe('Article-local alt');
    expect(h.cm.getValue()).toBe(body);
    expect(h.rich.getMarkdown()).toBe(body);
    expect(h.cm.historySize()).toEqual(sourceHistory);
    expect([undoDepth(h.editor.state), redoDepth(h.editor.state)]).toEqual(visualHistory);
    h.bridge.sourceTransaction(() => { Object.assign(images, before); }, () => {});
    expect(h.window.document.querySelector('.rich-text-image img')?.getAttribute('src')).toBe(src + '-640.webp');
  });

  // The page editor has no rendered-gallery toggle: the bridge must mount and
  // switch modes without one instead of being handed a detached button.
  it('creates and switches modes without a gallery view toggle', async () => {
    const h = await mount({ markdown: 'A page body' });
    // The mount's own bridge owns these elements; hand them over to a fresh one.
    bridges.splice(bridges.indexOf(h.bridge), 1);
    h.bridge.destroy();
    const bridge = h.window.eval(`EditorRichBridge.create({ mde, element: document.getElementById('rich'),
      source: document.getElementById('source'), error: document.getElementById('error'),
      visualButton: document.getElementById('visual'), markdownButton: document.getElementById('markdown'),
      formatButtons: [], locale: 'en', imageOrigin: location.origin, images: () => ({}),
      copy: ${JSON.stringify(Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])))},
      galleryCopy: ${JSON.stringify(Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.gallery.')).map(([key, value]) => [key.slice('editor.gallery.'.length), value])))} })`) as Bridge & { isVisual(): boolean };
    bridges.push(bridge);
    expect(bridge.isVisual()).toBe(true);
    expect(h.window.document.getElementById('error')?.hasAttribute('hidden')).toBe(true);
    bridge.setMode('markdown');
    expect(bridge.isVisual()).toBe(false);
    expect(h.window.document.getElementById('markdown')?.getAttribute('aria-pressed')).toBe('true');
    bridge.setMode('visual');
    expect(bridge.isVisual()).toBe(true);
    expect(h.cm.getValue()).toBe('A page body');
  });
});
