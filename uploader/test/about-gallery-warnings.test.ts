import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { editorDocument, EditorElement } from './editor-dom-harness.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { galleryWarnings } from '../public/gallery-photo-line.js';
import { ui } from '../../site/src/i18n/ui.js';

beforeAll(async () => { await analyzeGallerySource(''); });
const html = readFileSync('public/about.html', 'utf8');
const start = html.lastIndexOf('<script type="module">');
const markup = html.slice(0, start);
const script = html.slice(html.indexOf("'use strict'", start), html.lastIndexOf('</script>'));
const response = (body: unknown, status = 200) => Response.json(body, { status });
interface PagePayload { de: { bodyMarkdown: string }; en: { bodyMarkdown: string } }
const drain = async () => {
  for (let i = 0; i < 12; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};

async function loadPage(save: (payload: PagePayload) => Promise<Response>) {
  const dom = editorDocument(markup);
  const editors: BodyEditor[] = [];
  class BodyEditor {
    text = '';
    selection: { line: number; ch: number } | null = null;
    readonly undo: string[] = [];
    readonly input = dom.document.createElement('textarea');
    readonly listeners: (() => void)[] = [];
    constructor({ element }: { element: EditorElement }) {
      element.parentElement!.appendChild(this.input);
      editors.push(this);
    }
    codemirror = {
      getInputField: () => this.input,
      getValue: () => this.text,
      getLine: (line: number) => this.text.split('\n')[line] ?? '',
      on: (_event: string, callback: () => void) => { this.listeners.push(callback); },
      refresh() {}, scrollIntoView() {},
      focus: () => this.input.focus(),
      setSelection: (position: { line: number; ch: number }) => { this.selection = position; },
    };
    value(text?: string) {
      if (text !== undefined) { this.text = text; this.listeners.forEach((callback) => callback()); }
      return this.text;
    }
  }
  const el = (id: string) => {
    const node = dom.document.getElementById(id);
    if (!node) throw new Error('Missing page control ' + id);
    return node;
  };
  const context: Record<string, unknown> = {
    ...galleryCodecBindings, document: dom.document, EasyMDE: BodyEditor,
    AbortController, setTimeout, clearTimeout, console,
    location: { origin: 'http://localhost', search: '' }, URLSearchParams,
    Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
    EditorCopy: { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])) },
    AdminConfirm: { ask: async () => true },
    BuildCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('admin.build.'))
        .map(([key, value]) => [key.slice('admin.build.'.length), value])),
    ])),
    DraftGuard: { createDraftGuard: () => ({ snapshot: () => 'snapshot', markDirty() {}, markClean() {}, redirectToLogin() {}, tryRestore: () => null, wasDismissed: () => false, isDirty: () => false }) },
    EditorGalleryCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('editor.gallery.'))
        .map(([key, value]) => [key.slice('editor.gallery.'.length), value])),
    ])),
    fetch: async (url: string, init?: RequestInit) => {
      // The page loads its language mode (#284) before it can save.
      if (url === '/language') return response({ primary: 'de', locales: ['de', 'en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' });
      // The generalized editor (#288) resolves its page kind from the catalogue first.
      if (url === '/pages' && !init?.method) return response({ pages: [{ key: 'about', known: true, defaults: { de: 'uber-mich', en: 'about-me' } }] });
      if (url === '/pages/about' && !init?.method) return response({ key: 'about', status: 'published', updatedAt: null,
        de: { locale: 'de', title: '', bodyMarkdown: '', images: {}, slug: '' }, en: { locale: 'en', title: '', bodyMarkdown: '', images: {}, slug: '' } });
      if (url === '/gallery/analyze') return response(await analyzeGallerySource(JSON.parse(String(init?.body)).bodyMarkdown));
      if (url === '/pages/about' && init?.method === 'PUT') return save(JSON.parse(String(init.body)) as PagePayload);
      return response([]);
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['build-reporting.js', 'language.js', 'tabs.js', 'pages-ui.js', 'gallery-fence.js', 'gallery-metadata-warnings.js']) vm.runInContext(browserScript(file), context);
  vm.runInContext(script, context);
  const api = vm.runInContext('({ fill })', context) as { fill(locale: string, data: { title: string; bodyMarkdown: string }): void };
  // Let initialization (language + stored page) settle before the test edits.
  await drain();
  return { api, editors, el, document: dom.document };
}

async function successful(payload: PagePayload, buildOk = true) {
  // The route acknowledges the complete stored page (#288) beside its build attempt.
  const stored = (locale: 'de' | 'en') => ({ locale, slug: '', publishedAt: '2026-10-28T12:00:00Z', images: {}, ...payload[locale] });
  return response({ saved: { key: 'about', status: 'published', updatedAt: '2026-10-28T12:00:00Z', de: stored('de'), en: stored('en') }, build: buildOk ? { ok: true, attemptId: 'r1', release: 'r1' } : { ok: false, attemptId: 'failed', code: 'build_failed', error: 'failed build' }, galleryWarnings: [
    ...galleryWarnings(await analyzeGallerySource(payload.de.bodyMarkdown), 'de'),
    ...galleryWarnings(await analyzeGallerySource(payload.en.bodyMarkdown), 'en'),
  ] });
}
const source = '<BodyImage\n src="https://img/intro"\n width={10}\n height={20}\n/>\n\n> ~~~gallery extra\n> https://img/a | 10x20 | capton="<script>bad</script>"\n> ~~~';

describe('About page saved gallery warnings', () => {
  it('reopens advisories and retains honest saved warnings when rebuilding or a later write fails', async () => {
    let failWrite = false;
    const h = await loadPage(async (payload) => failWrite ? response({ error: 'not saved' }, 500) : successful(payload, false));
    h.api.fill('de', { title: 'Über mich', bodyMarkdown: source });
    h.api.fill('en', { title: 'About', bodyMarkdown: source });
    await drain();
    const root = h.el('galleryMetadataWarnings');
    expect(root.textContent).toContain(ui.de['editor.gallery.metadataAdvisory']);
    expect(root.textContent).toContain(ui.en['editor.gallery.metadataAdvisory']);
    h.el('saveBtn').click();
    await drain();
    expect(root.textContent).toContain(ui.de['editor.gallery.metadataSaved']);
    expect(root.textContent).toContain(ui.en['editor.gallery.metadataSaved']);
    // #297: a failed rebuild after an acknowledged save is reported beside the saved state.
    expect(h.el('actionStatus').textContent).toContain(ui.en['admin.build.failedChange'].replace('{error}', ui.en['admin.build.failure.build_failed']));
    expect(root.querySelectorAll('script')).toEqual([]);
    const saved = root.textContent;
    failWrite = true;
    h.el('saveBtn').click();
    await drain();
    expect(root.textContent).toBe(saved);
    expect(h.editors[0]!.value()).toBe(source);
  });

  it('captures pending-save source, focuses only a current diagnostic, and clears a clean successful save', async () => {
    const pending = Promise.withResolvers<Response>();
    let captured: PagePayload | undefined;
    let hold = true;
    const h = await loadPage(async (payload) => { captured = payload; return hold ? pending.promise : successful(payload); });
    h.api.fill('de', { title: 'Über mich', bodyMarkdown: '' });
    h.api.fill('en', { title: 'About', bodyMarkdown: source });
    h.el('saveBtn').click();
    await drain();
    h.editors[1]!.value('New paragraph\n\n' + source);
    pending.resolve(await successful(captured!));
    await drain();
    const root = h.el('galleryMetadataWarnings');
    const button = root.querySelector('button');
    expect(button).not.toBeNull();
    button!.click();
    await drain();
    expect(h.el('tabbtn-en').getAttribute('aria-selected')).toBe('true');
    expect(h.editors[1]!.selection?.line).toBe(9);
    expect(h.document.activeElement).toBe(h.editors[1]!.input);
    expect(h.editors[1]!.undo).toEqual([]);
    expect(h.editors[1]!.value()).toBe('New paragraph\n\n' + source);
    h.editors[1]!.value(source.replace('capton=', 'caption='));
    hold = false;
    h.el('saveBtn').click();
    await drain();
    expect(root.hidden).toBe(true);
  });
});
