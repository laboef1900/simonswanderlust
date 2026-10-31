import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from '../../site/node_modules/happy-dom/lib/index.js';
import { ui } from '../../site/src/i18n/ui.js';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';

// Use the bundle copied by copy-easymde.mjs, not the separately installed
// codemirror package: EasyMDE ships its own CodeMirror version. Happy DOM is
// already a site devDependency; uploader CI installs both trees for preview.
const easyMDE = readFileSync(new URL('../node_modules/easymde/dist/easymde.min.js', import.meta.url), 'utf8');
const scripts = ['posts-filter', 'editor-galleries'].map((name) =>
  readFileSync(new URL('../public/' + name + '.js', import.meta.url), 'utf8'));
const copy = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.gallery.'))
  .map(([key, value]) => [key.slice('editor.gallery.'.length), value]));

interface Position { line: number; ch: number }
interface CodeMirror {
  getValue(): string;
  setValue(text: string): void;
  getCursor(): Position;
  setCursor(position: Position): void;
  posFromIndex(index: number): Position;
  indexFromPos(position: Position): number;
  execCommand(command: string): void;
  replaceSelection(text: string, collapse: 'end', origin: string): void;
  replaceRange(text: string, from: Position, to: Position, origin: string): void;
  clearHistory(): void;
  undo(): void;
  redo(): void;
}
interface Block { start: number; end: number; isGallery: boolean; unterminated: boolean }
interface FenceApi {
  scanFences(body: string): Promise<Block[]>;
  replaceFenceAt(body: string, at: number, text: string): Promise<{ text: string; start: number; end: number }>;
}

interface GalleryEditor { window: Window; cm: CodeMirror; fences: FenceApi }
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

async function editor(body: string): Promise<GalleryEditor> {
  const window = new Window({ url: 'https://images.example/admin/editor.html' });
  windows.push(window);
  window.document.body.innerHTML = '<textarea></textarea><button id="toggle" type="button"></button>';
  window.eval(easyMDE);
  const fenceWindow: { GalleryFence?: FenceApi } = {};
  vm.runInNewContext(browserScript('gallery-fence.js'), {
    window: fenceWindow, AbortController, setTimeout, clearTimeout,
    ...galleryCodecBindings,
    fetch: async (_url: string, init: RequestInit) => ({
      ok: true,
      json: () => analyzeGallerySource(JSON.parse(String(init.body)).bodyMarkdown),
    }),
  }, { filename: resolve('public/gallery-fence.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  Object.assign(window, { GalleryFence: fenceWindow.GalleryFence });
  for (const script of scripts) window.eval(script);
  const cm = window.eval(`
    window.mde = new EasyMDE({ element: document.querySelector('textarea'),
      autoDownloadFontAwesome: false, spellChecker: false, toolbar: false, status: false });
    window.cm = mde.codemirror;
    cm;
  `) as CodeMirror;
  cm.setValue(body);
  window.eval(`window.galleries = EditorGalleries.attach({ cm, locale: 'en', images: () => ({}),
    imageOrigin: location.origin, toggle: document.getElementById('toggle'),
    copy: ${JSON.stringify(copy)}, onEdit() {}, onUnauthed() {} });`);
  await window.eval('galleries.refresh()');
  cm.clearHistory();
  const fences = window.eval('GalleryFence') as FenceApi;
  return { window, cm, fences };
}

const gallery = '```gallery\nhttps://images.example/photo | 900x600 | alt="Original"\n```';
const body = 'Intro\n\n' + gallery + '\n\nFollowing story text';
type Edge = 'before' | 'after';

function arrowToEdge(cm: CodeMirror, edge: Edge) {
  // These are the commands bound to ArrowRight / ArrowLeft in the shipped
  // editor. Do not mock atomic movement or the collapsed marker's positions.
  cm.setCursor({ line: edge === 'before' ? 1 : 5, ch: 0 });
  cm.execCommand(edge === 'before' ? 'goCharRight' : 'goCharLeft');
  expect(cm.getCursor()).toMatchObject(edge === 'before' ? { line: 2, ch: 0 } : { line: 4, ch: 3 });
}

async function expectGallery(h: GalleryEditor, expected = gallery) {
  await h.window.eval('galleries.refresh()');
  const blocks = await h.fences.scanFences(h.cm.getValue());
  expect(blocks).toHaveLength(1);
  const block = blocks[0]!;
  expect(block).toMatchObject({ isGallery: true, unterminated: false });
  expect(h.cm.getValue().slice(block.start, block.end)).toBe(expected);
}

describe('real CodeMirror collapsed gallery boundaries', () => {
  it.each(['before', 'after'] as const)('keeps repeated typing %s the gallery outside its fence, with undo/redo', async (edge) => {
    const h = await editor(body);
    arrowToEdge(h.cm, edge);
    h.cm.replaceSelection('H', 'end', '+input');
    h.cm.replaceSelection('ello', 'end', '+input');
    const expected = edge === 'before'
      ? 'Intro\n\nHello\n\n' + gallery + '\n\nFollowing story text'
      : 'Intro\n\n' + gallery + '\n\nHello\n\nFollowing story text';
    expect(h.cm.getValue()).toBe(expected);
    expect(h.cm.indexFromPos(h.cm.getCursor())).toBe(expected.indexOf('Hello') + 5);
    await expectGallery(h);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(body);
    await expectGallery(h);
    h.cm.redo();
    expect(h.cm.getValue()).toBe(expected);
    await expectGallery(h);
  });

  it.each(['before', 'after'] as const)('keeps multiline paste %s the gallery outside its fence', async (edge) => {
    const h = await editor(body);
    arrowToEdge(h.cm, edge);
    h.cm.replaceSelection('Pasted paragraph\n\nAnother paragraph', 'end', 'paste');
    await expectGallery(h);
    const pasted = h.cm.getValue();
    expect(pasted).toContain('\n\nPasted paragraph\n\nAnother paragraph\n\n');
    expect(pasted.endsWith('\n\nFollowing story text')).toBe(true);
    h.cm.replaceSelection(' continues', 'end', '+input');
    expect(h.cm.getValue()).toContain('Another paragraph continues\n\n');
    await expectGallery(h);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(pasted);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(body);
    h.cm.redo();
    expect(h.cm.getValue()).toBe(pasted);
    expect(h.cm.indexFromPos(h.cm.getCursor())).toBe(pasted.indexOf('Another paragraph') + 'Another paragraph'.length);
    h.cm.replaceSelection(' after redo', 'end', '+input');
    expect(h.cm.getValue()).toBe(pasted.replace('Another paragraph', 'Another paragraph after redo'));
    await expectGallery(h);
  });

  it.each(['before', 'after'] as const)('supports a gallery-only document at its %s edge, including EOF', async (edge) => {
    const h = await editor(gallery);
    h.cm.setCursor(h.cm.posFromIndex(edge === 'before' ? 0 : gallery.length));
    h.cm.replaceSelection('New text', 'end', '+input');
    const expected = edge === 'before' ? 'New text\n\n' + gallery : gallery + '\n\nNew text\n\n';
    expect(h.cm.getValue()).toBe(expected);
    await expectGallery(h);
    h.cm.replaceSelection(' continues', 'end', '+input');
    expect(h.cm.getValue()).toContain('New text continues');
    await expectGallery(h);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(gallery);
  });

  it('continues typing at the restored EOF paste caret rather than after its padding', async () => {
    const h = await editor(gallery);
    h.cm.setCursor(h.cm.posFromIndex(gallery.length));
    h.cm.replaceSelection('Hello', 'end', 'paste');
    const pasted = gallery + '\n\nHello\n\n';
    expect(h.cm.getValue()).toBe(pasted);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(gallery);
    h.cm.redo();
    expect(h.cm.indexFromPos(h.cm.getCursor())).toBe(pasted.indexOf('Hello') + 5);
    h.cm.replaceSelection(' world', 'end', '+input');
    expect(h.cm.getValue()).toBe(gallery + '\n\nHello world\n\n');
    await expectGallery(h);
  });

  it('keeps pasted trailing newlines and immediate typing outside the opener before analysis settles', async () => {
    const h = await editor(body);
    arrowToEdge(h.cm, 'before');
    h.cm.replaceSelection('Pasted\n\n', 'end', 'paste');
    expect(h.cm.getValue()).toBe('Intro\n\nPasted\n\n\n\n' + gallery + '\n\nFollowing story text');
    h.cm.replaceSelection('Next', 'end', '+input');
    await expectGallery(h);
    expect(h.cm.getValue()).toContain('Pasted\n\nNext\n\n```gallery');
  });

  it('preserves the picker range replacement and its undo/redo', async () => {
    const h = await editor(body);
    const replacement = gallery.replace('900x600', '1200x800');
    const edit = await h.fences.replaceFenceAt(body, body.indexOf('```gallery'), replacement);
    h.cm.replaceRange(edit.text, h.cm.posFromIndex(edit.start), h.cm.posFromIndex(edit.end), '+gallery');
    await expectGallery(h, replacement);
    h.cm.undo();
    expect(h.cm.getValue()).toBe(body);
    await expectGallery(h);
    h.cm.redo();
    await expectGallery(h, replacement);
  });

  it('preserves the real widget alt input, including undo/redo', async () => {
    const h = await editor(body);
    const field = h.window.document.querySelector('textarea.editor-gallery__alt');
    if (!(field instanceof h.window.HTMLTextAreaElement)) throw new Error('Missing gallery alt textarea');
    expect(field.readOnly).toBe(false);
    field.value = 'Changed alt';
    field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await h.window.eval('galleries.flush()');
    await expectGallery(h, gallery.replace('Original', 'Changed alt'));
    h.cm.undo();
    expect(h.cm.getValue()).toBe(body);
    await expectGallery(h);
    h.cm.redo();
    await expectGallery(h, gallery.replace('Original', 'Changed alt'));
  });

  it('leaves explicit raw Markdown edits unfiltered', async () => {
    const h = await editor(body);
    const toggle = h.window.document.getElementById('toggle');
    if (!(toggle instanceof h.window.HTMLButtonElement)) throw new Error('Missing raw Markdown toggle');
    toggle.click();
    h.cm.setCursor({ line: 2, ch: 0 });
    h.cm.replaceSelection('Raw ', 'end', '+input');
    expect(h.cm.getValue()).toBe(body.replace('```gallery', 'Raw ```gallery'));
    h.cm.undo();
    expect(h.cm.getValue()).toBe(body);
  });
});
