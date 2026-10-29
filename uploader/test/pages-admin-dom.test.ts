import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
const stamp = '2026-10-29T00:00:00.000Z';
const copy = { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice(14), value])) };
type UnloadEvent = { defaultPrevented: boolean; returnValue?: string; preventDefault(): void };
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function editor(key = 'contact', status = 'draft', prepare = false) {
  const html = readFileSync('public/about.html', 'utf8'); const dom = editorDocument(html);
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error(id); return node; };
  const locale = (locale: 'de' | 'en') => ({ locale, title: locale + ' title', bodyMarkdown: locale + ' body', images: {}, slug: key === 'about' ? '' : locale + '-contact', publishedAt: status === 'published' && !(prepare && locale === 'en') ? stamp : null });
  const page = { key, status, updatedAt: stamp, de: locale('de'), en: locale('en') };
  const requests: { url: string; init: RequestInit }[] = []; const questions: { title: string; body: string }[] = [];
  let confirmed = true; let failure: { status: number; body: object } | null = null;
  let lifecycleWait: Promise<void> | undefined;
  let unload: ((event: UnloadEvent) => void) | undefined;
  const storage = new Map<string, string>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  class EasyMDE {
    private body = ''; codemirror = { getInputField: () => dom.document.createElement('textarea'), on() {}, refresh() {} };
    value(value?: string) { if (value !== undefined) this.body = value; return this.body; }
  }
  const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const context: Record<string, unknown> = {
    document: dom.document, URLSearchParams, EasyMDE, EditorCopy: copy,
    location: { search: '?key=' + key + (prepare ? '&prepareLocale=en' : ''), origin: 'https://journal.test', href: '' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      get length() { return storage.size; },
      key: (index: number) => [...storage.keys()][index] ?? null,
    },
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (type: string, callback: (event: UnloadEvent) => void) => { if (type === 'beforeunload') unload = callback; },
    Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
    AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return confirmed; } },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (init.method === 'POST' && lifecycleWait) await lifecycleWait;
      if (init.method && failure) return response(failure.body, failure.status);
      if (url === '/language') return response({ primary: 'de', locales: prepare ? ['de'] : ['de', 'en'], updatedAt: stamp, lockedAt: null });
      if (url === '/pages') return response({ pages: [{ key, known: true, defaults: { de: 'kontakt', en: 'contact' } }] });
      if (url.endsWith('/revisions')) return response([]);
      if (url.endsWith('/deletion')) return response({ key, titles: { de: page.de.title, en: page.en.title }, paths: ['/de-contact/', '/en/en-contact/'], revisions: 3,
        navigation: [{ slot: 'footer', label: { en: 'Write to Simon' } }], bodyReferences: 2, updatedAt: stamp });
      if (init.method === 'PUT') return response({ saved: { ...page, ...JSON.parse(String(init.body)), updatedAt: '2026-10-29T00:01:00.000Z' }, build: status === 'published' ? { ok: true } : null });
      if (init.method === 'DELETE') return response({ saved: { key }, build: null });
      if (init.method === 'POST') return response({ saved: { ...page, status: url.endsWith('/unpublish') ? 'draft' : 'published' }, build: { ok: true } });
      return response(page);
    },
  };
  context.window = context; vm.createContext(context);
  for (const file of ['draft-guard.js', 'language.js', 'tabs.js', 'pages-ui.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  vm.runInContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), context);
  await settle();
  return {
    dom, el, requests, questions, page, context, storage,
    confirm(value: boolean) { confirmed = value; },
    fail(status: number, body: object) { failure = { status, body }; },
    pauseLifecycle() { const gate = Promise.withResolvers<void>(); lifecycleWait = gate.promise; return gate.resolve; },
    flushStash() { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
    beforeUnload() {
      const event: UnloadEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      unload?.(event); return event;
    },
  };
}

describe('generalized page editor', () => {
  it('edits a non-About slug and saves a draft without a publication confirmation', async () => {
    const h = await editor(); expect(h.el('deSlugFields').hidden).toBe(false); expect(h.el('deSlug').readOnly).toBe(false);
    expect(h.el('saveBtn').textContent).toBe(ui.en['editor.chrome.pagesSave']);
    h.el('deSlug').value = 'new-contact'; h.el('saveBtn').click(); await settle();
    const put = h.requests.find(({ init }) => init.method === 'PUT')!;
    expect(put.url).toBe('/pages/contact'); expect(JSON.parse(String(put.init.body)).de.slug).toBe('new-contact');
    expect(h.questions).toEqual([]); expect(h.el('actionStatus').textContent).toContain('Not public yet');
  });
  it('retains unsaved inputs on a conflict unless the author explicitly reloads', async () => {
    const h = await editor('contact', 'published'); h.el('deTitle').value = 'My unsaved title';
    h.fail(409, { code: 'conflict', error: 'Saved elsewhere' });
    // The first confirmation permits live save; the second rejects the destructive reload.
    let count = 0; const confirm = h.context.AdminConfirm as { ask: () => Promise<boolean> }; confirm.ask = async () => ++count === 1;
    h.el('saveBtn').click(); await settle();
    expect(h.el('deTitle').value).toBe('My unsaved title'); expect(h.el('actionError').textContent).toBe('Saved elsewhere');
    expect(h.requests.filter(({ url }) => url === '/pages/contact')).toHaveLength(2);
  });
  it('shows the exact destructive scope and cancellation performs no deletion', async () => {
    const h = await editor('contact', 'published'); h.confirm(false);
    h.el('deleteBtn').click(); await settle();
    expect(h.questions[0]!.body).toContain('Revisions: 3'); expect(h.questions[0]!.body).toContain('footer: Write to Simon');
    expect(h.questions[0]!.body).toContain('Possible body references: 2'); expect(h.questions[0]!.body).toContain('/en/en-contact/');
    expect(h.requests.some(({ init }) => init.method === 'DELETE')).toBe(false);
    h.confirm(true); h.el('deleteBtn').click(); await settle();
    const request = h.requests.find(({ init }) => init.method === 'DELETE')!;
    expect(JSON.parse(String(request.init.body))).toEqual({ updatedAt: stamp });
  });
  it('restores keyboard focus to Delete after cancelling its native confirmation', async () => {
    const h = await editor('contact', 'published');
    vm.runInContext(readFileSync('public/admin-confirm.js', 'utf8'), h.context);
    h.el('deleteBtn').focus();
    h.el('deleteBtn').click(); await settle();
    const dialog = h.el('adminConfirm');
    expect(dialog.open).toBe(true);
    dialog.returnValue = '';
    dialog.close(); h.dom.flushDialogEvents(); await settle();
    expect(h.el('deleteBtn').disabled).toBe(false);
    expect(h.dom.document.activeElement).toBe(h.el('deleteBtn'));
    expect(h.requests.some(({ init }) => init.method === 'DELETE')).toBe(false);
  });
  it.each(['publish', 'unpublish'])('protects edits typed while %s waits for a rebuild', async (action) => {
    const h = await editor('contact', action === 'publish' ? 'draft' : 'published');
    const release = h.pauseLifecycle();
    h.el(action + 'Btn').click(); await settle();
    expect(h.requests.find(({ init }) => init.method === 'POST')?.init.body).toBe(JSON.stringify({ updatedAt: stamp }));
    h.el('deTitle').value = 'New work not in the lifecycle request';
    h.el('deTitle').fire('input'); h.flushStash();
    release(); await settle();
    const retained = h.storage.get('swl:draft:page:contact');
    expect(retained).toBeDefined();
    expect(JSON.parse(retained!).payload.de.title).toBe('New work not in the lifecycle request');
    expect(h.beforeUnload().defaultPrevented).toBe(true);
    expect(h.el('deTitle').value).toBe('New work not in the lifecycle request');
  });
  it('keeps About undeletable with no editable slug and preserves live-save confirmation', async () => {
    const h = await editor('about', 'published');
    expect(h.el('deleteBtn').hidden).toBe(true); expect(h.el('unpublishBtn').hidden).toBe(true); expect(h.el('deSlugFields').hidden).toBe(true);
    h.confirm(false); h.el('saveBtn').click(); await settle();
    expect(h.requests.some(({ init }) => init.method === 'PUT')).toBe(false); expect(h.questions[0]!.body).toContain('rebuilds immediately');
  });
  it('prepares only the inactive locale, retaining an editable never-public slug', async () => {
    const h = await editor('contact', 'published', true);
    expect(h.el('tab-de').hidden).toBe(true); expect(h.el('tab-en').hidden).toBe(false);
    expect(h.el('enSlug').readOnly).toBe(false); expect(h.el('publishBtn').hidden).toBe(true);
    h.el('enSlug').value = 'prepared-contact'; h.el('saveBtn').click(); await settle();
    const payload = JSON.parse(String(h.requests.find(({ init }) => init.method === 'PUT')!.init.body));
    expect(payload.de).toBeUndefined(); expect(payload.prepareLocale).toBe('en'); expect(payload.en.slug).toBe('prepared-contact');
    expect(h.el('actionStatus').textContent).toContain('not public');
  });
});

describe('page catalogue DOM', () => {
  it('shows only the active locale, escapes authored titles, and leaves unknown kinds delete-only', async () => {
    const html = readFileSync('public/pages.html', 'utf8'); const dom = editorDocument(html);
    const pages = ['about', 'contact', 'privacy', 'legal', 'retired-kind'].map((key) => ({
      key, known: key !== 'retired-kind', exists: key === 'about' || key === 'contact' || key === 'retired-kind',
      status: key === 'about' ? 'published' : 'draft', deletable: key !== 'about',
      locales: { de: { title: 'INACTIVE GERMAN' }, en: { title: '<img src=x onerror=alert(1)>' } },
    }));
    const context: Record<string, unknown> = {
      document: dom.document, URLSearchParams, EditorCopy: copy, location: { search: '', href: '' },
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ pages, language: { primary: 'en', locales: ['en'] } }) }),
    };
    context.window = context; vm.createContext(context);
    for (const file of ['language.js', 'pages-ui.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
    vm.runInContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), context); await settle();
    const list = dom.document.getElementById('pagesList')!; const rows = list.querySelectorAll('section');
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(rows[1]!.querySelector('a')!.href).toBe('/admin/about.html?key=contact');
    expect(rows[1]!.children[2]!.textContent).toBe('EN: <img src=x onerror=alert(1)>');
    expect(rows[1]!.querySelector('img')).toBeNull();
    expect(rows[4]!.querySelector('a')).toBeNull(); expect(rows[4]!.querySelector('button')).not.toBeNull();
  });
  it('returns keyboard focus to the catalogue Delete button after Escape', async () => {
    const html = readFileSync('public/pages.html', 'utf8'); const dom = editorDocument(html);
    const requests: { url: string; init: RequestInit }[] = [];
    const context: Record<string, unknown> = {
      document: dom.document, URLSearchParams, EditorCopy: copy, location: { search: '', href: '' },
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async (url: string, init: RequestInit = {}) => {
        requests.push({ url, init });
        const body = url.endsWith('/deletion')
          ? { titles: { de: 'Kontakt', en: 'Contact' }, paths: ['/contact/'], revisions: 2, navigation: [], bodyReferences: 0, updatedAt: stamp }
          : { pages: [{ key: 'contact', known: true, exists: true, status: 'draft', deletable: true,
            locales: { de: { title: 'Kontakt' }, en: { title: 'Contact' } } }], language: { primary: 'en', locales: ['en'] } };
        return { ok: true, status: 200, json: async () => body };
      },
    };
    context.window = context; vm.createContext(context);
    for (const file of ['language.js', 'admin-confirm.js', 'pages-ui.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
    vm.runInContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), context); await settle();
    const remove = dom.document.getElementById('pagesList')!.querySelector('button')!;
    remove.focus(); remove.click(); await settle();
    const dialog = dom.document.getElementById('adminConfirm')!;
    expect(dialog.open).toBe(true);
    dialog.fire('keydown', { key: 'Escape' }); dom.flushDialogEvents(); await settle();
    expect(remove.disabled).toBe(false);
    expect(dom.document.activeElement).toBe(remove);
    expect(requests.some(({ init }) => init.method === 'DELETE')).toBe(false);
    expect(dom.document.getElementById('pagesList')!.querySelector('button')).toBe(remove);
  });
});
