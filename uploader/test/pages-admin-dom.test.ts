import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';
import { ui } from '../../site/src/i18n/ui.js';
const stamp = '2026-10-29T00:00:00.000Z';
const copy = { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice(14), value])) };
const buildCopy = Object.fromEntries(['de', 'en'].map(locale => [locale, Object.fromEntries(Object.entries(ui[locale as 'de' | 'en']).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice(12), value]))]));
const owner = '11111111-1111-4111-8111-111111111111';
type UnloadEvent = { defaultPrevented: boolean; returnValue?: string; preventDefault(): void };
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function editor(key = 'contact', status = 'draft', prepare = false, options: { storage?: Map<string, string>; userId?: string; singleLocale?: boolean } = {}) {
  const html = readFileSync('public/about.html', 'utf8'); const dom = editorDocument(html);
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error(id); return node; };
  const locale = (locale: 'de' | 'en') => ({ locale, title: locale + ' title', bodyMarkdown: locale + ' body', images: {}, slug: key === 'about' ? '' : locale + '-contact', publishedAt: status === 'published' && !(prepare && locale === 'en') ? stamp : null });
  const page = { key, status, updatedAt: stamp, de: locale('de'), en: locale('en') };
  const requests: { url: string; init: RequestInit }[] = []; const questions: { title: string; body: string }[] = [];
  let confirmed = true; let failure: { status: number; body: object } | null = null;
  let lifecycleWait: Promise<void> | undefined;
  let unload: ((event: UnloadEvent) => void) | undefined;
  const storage = options.storage ?? new Map<string, string>();
  const userId = options.userId ?? owner;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  class EasyMDE {
    private body = ''; codemirror = { getInputField: () => dom.document.createElement('textarea'), on() {}, refresh() {},
      getValue: () => this.body, getLine: (line: number) => this.body.split('\n')[line] ?? '' };
    value(value?: string) { if (value !== undefined) this.body = value; return this.body; }
  }
  const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const context: Record<string, unknown> = {
    document: dom.document, URLSearchParams, EasyMDE, EditorCopy: copy, BuildCopy: buildCopy,
    crypto: webcrypto, structuredClone, AbortController,
    location: { search: '?key=' + key + (prepare ? '&prepareLocale=en' : ''), pathname: '/admin/about.html', origin: 'https://journal.test', href: '' },
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
    Auth: { ensureAuthed: async () => ({ userId, isAdmin: true }), renderHeader() {} },
    AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return confirmed; } },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (init.method === 'POST' && lifecycleWait) await lifecycleWait;
      if (init.method && failure) return response(failure.body, failure.status);
      if (url === '/language') return response({ primary: 'de', locales: prepare || options.singleLocale ? ['de'] : ['de', 'en'], updatedAt: stamp, lockedAt: null });
      if (url === '/pages') return response({ pages: [{ key, known: true, defaults: { de: 'kontakt', en: 'contact' } }] });
      if (url.endsWith('/revisions')) return response([]);
      if (url.endsWith('/deletion')) return response({ key, titles: { de: page.de.title, en: page.en.title }, paths: ['/de-contact/', '/en/en-contact/'], revisions: 3,
        navigation: [{ slot: 'footer', label: { en: 'Write to Simon' } }], bodyReferences: 2, updatedAt: stamp });
      if (init.method === 'PUT') {
        const sent = JSON.parse(String(init.body));
        if (sent.updatedAt !== page.updatedAt) return response({ code: 'conflict' }, 409);
        return response({ ownerUserId: userId, saveId: sent.saveId, saved: { ...page, ...sent, updatedAt: '2026-10-29T00:01:00.000Z' }, build: status === 'published' ? { ok: true, release: 'new-release' } : null });
      }
      if (init.method === 'DELETE') return response({ saved: { key }, build: null });
      if (init.method === 'POST') return response({ saved: { ...page, status: url.endsWith('/unpublish') ? 'draft' : 'published' }, build: { ok: true } });
      return response({ ...page, ownerUserId: userId, lastSaveId: null });
    },
  };
  context.window = context; vm.createContext(context);
  Object.assign(context, galleryCodecBindings);
  for (const file of ['build-reporting.js', 'draft-guard.js', 'language.js', 'tabs.js', 'pages-ui.js', 'gallery-fence.js', 'gallery-metadata-warnings.js', 'write-recovery.js']) vm.runInContext(browserScript(file), context);
  // The page script is a module (it imports the gallery fence); run its body.
  const start = html.lastIndexOf('<script type="module">');
  vm.runInContext(html.slice(html.indexOf("'use strict'", start), html.lastIndexOf('</script>')), context);
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
  it.each(['about', 'contact', 'privacy', 'legal'])('retains the actual restored base and full copy when rebasing %s', async (key) => {
    const first = await editor(key);
    first.el('deTitle').value = 'Private German';
    first.el('enTitle').value = 'Private English';
    first.el('deTitle').fire('input'); first.flushStash();
    const [sourceKey, sourceRaw] = [...first.storage][0]!;
    const source = JSON.parse(sourceRaw);
    source.payload.de.bodyMarkdown = 'German body with a photo';
    source.payload.en.bodyMarkdown = 'English body with a photo';
    source.payload.de.images = { 'https://journal.test/images/de': { width: 640, height: 480 } };
    source.payload.en.images = { 'https://journal.test/images/en': { width: 480, height: 640 } };
    source.recovery.baseUpdatedAt = '2026-10-01T00:00:00.000Z';
    first.storage.set(sourceKey, JSON.stringify(source));
    const restored = await editor(key, 'draft', false, { storage: first.storage });
    expect(restored.el('deTitle').value).toBe('Private German');
    expect(restored.el('enTitle').value).toBe('Private English');
    const comparison = restored.dom.document.querySelector('details')!;
    expect(comparison.hidden).toBe(false);
    restored.el('saveBtn').click(); await settle();
    expect(restored.requests.some(({ init }) => init.method === 'PUT')).toBe(false);
    comparison.querySelectorAll('button')[1]!.click(); await settle();
    expect(restored.storage.get(sourceKey)).toBe(JSON.stringify(source));
    expect(restored.el('deTitle').value).toBe('Private German');
    restored.el('saveBtn').click(); await settle();
    const sent = JSON.parse(String(restored.requests.find(({ init }) => init.method === 'PUT')!.init.body));
    expect(sent.updatedAt).toBe(stamp);
    expect(sent.de.title).toBe('Private German'); expect(sent.en.title).toBe('Private English');
    expect(sent.de.bodyMarkdown).toBe(source.payload.de.bodyMarkdown);
    expect(sent.en.bodyMarkdown).toBe(source.payload.en.bodyMarkdown);
    expect(sent.de.images).toEqual(source.payload.de.images);
    expect(sent.en.images).toEqual(source.payload.en.images);
    expect(restored.storage.get(sourceKey)).toBe(JSON.stringify(source));
  });
  it.each([undefined, 'not-a-token'])('blocks a missing/malformed page base until explicit compare/rebase (%s)', async (base) => {
    const first = await editor();
    first.el('deTitle').value = 'Unsubmitted text'; first.el('deTitle').fire('input'); first.flushStash();
    const [key, raw] = [...first.storage][0]!;
    const record = JSON.parse(raw); record.recovery.baseUpdatedAt = base;
    first.storage.set(key, JSON.stringify(record));
    const h = await editor('contact', 'draft', false, { storage: first.storage });
    h.el('saveBtn').click(); await settle();
    expect(h.requests.some(({ init }) => init.method === 'PUT')).toBe(false);
    expect(h.dom.document.querySelector('details')!.hidden).toBe(false);
    h.dom.document.querySelector('details')!.querySelectorAll('button')[1]!.click(); await settle();
    h.el('saveBtn').click(); await settle();
    expect(JSON.parse(String(h.requests.find(({ init }) => init.method === 'PUT')!.init.body)).updatedAt).toBe(stamp);
    expect(h.storage.get(key)).toBe(JSON.stringify(record));
  });
  it('loads the stored page in a fresh context without deleting the previous complete record', async () => {
    const h = await editor();
    h.el('deTitle').value = 'Keep DE'; h.el('enTitle').value = 'Keep EN';
    h.el('deTitle').fire('input');
    h.page.updatedAt = '2026-10-29T00:02:00.000Z';
    h.el('saveBtn').click(); await settle();
    h.dom.document.querySelector('details')!.querySelector('button')!.click(); await settle();
    expect(h.el('deTitle').value).toBe(h.page.de.title);
    const recovered = [...h.storage.values()].map(raw => JSON.parse(raw));
    expect(recovered.some(record => record.payload.de.title === 'Keep DE' && record.payload.en.title === 'Keep EN')).toBe(true);
    expect(h.requests.filter(({ init }) => init.method === 'PUT')).toHaveLength(1);
  });
  it('never offers another account’s page records or unknown-owner legacy bytes, even to admins', async () => {
    const first = await editor('about');
    first.el('deTitle').value = 'A private'; first.el('deTitle').fire('input'); first.flushStash();
    first.storage.set('swl:draft:about', '{"title":"Unknown private"}');
    const before = [...first.storage];
    const second = await editor('about', 'draft', false, { storage: first.storage, userId: '22222222-2222-4222-8222-222222222222' });
    expect(second.questions).toEqual([]);
    expect(second.el('deTitle').value).toBe('de title');
    expect([...second.storage]).toEqual(before);
  });
  it('edits a non-About slug and saves a draft without a publication confirmation', async () => {
    const h = await editor(); expect(h.el('deSlugFields').hidden).toBe(false); expect(h.el('deSlug').readOnly).toBe(false);
    expect(h.el('saveBtn').textContent).toBe(ui.en['editor.chrome.pagesSave']);
    h.el('deSlug').value = 'new-contact'; h.el('saveBtn').click(); await settle();
    const put = h.requests.find(({ init }) => init.method === 'PUT')!;
    expect(put.url).toBe('/pages/contact'); expect(JSON.parse(String(put.init.body)).de.slug).toBe('new-contact');
    expect(h.questions).toEqual([]); expect(h.el('actionStatus').textContent).toContain('The site was not rebuilt');
  });
  it('preserves local inputs and compares the current generic page after a conflict without replay', async () => {
    const h = await editor('contact', 'published'); h.el('deTitle').value = 'My unsaved title';
    h.page.updatedAt = '2026-10-29T00:02:00.000Z';
    h.page.de.title = 'Other tab title';
    h.fail(409, { code: 'conflict', error: 'Saved elsewhere' });
    h.el('saveBtn').click(); await settle();
    expect(h.el('deTitle').value).toBe('My unsaved title');
    const panel = h.dom.document.querySelector('.write-recovery')!;
    expect(panel.textContent).toContain('My unsaved title');
    expect(panel.textContent).toContain('Other tab title');
    expect(h.requests.filter(({ url }) => url === '/pages/contact')).toHaveLength(3);
    expect(h.requests.filter(({ init }) => init.method === 'PUT')).toHaveLength(1);
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
    // Gallery analysis also POSTs; the lifecycle request is the one to /pages/:key/:action.
    expect(h.requests.find(({ url, init }) => init.method === 'POST' && url.endsWith('/' + action))?.init.body).toBe(JSON.stringify({ updatedAt: stamp }));
    h.el('deTitle').value = 'New work not in the lifecycle request';
    h.el('deTitle').fire('input'); h.flushStash();
    release(); await settle();
    const records = [...h.storage].filter(([key]) => key.startsWith('swl:draft:u:' + owner + ':page:contact:'));
    expect(records).toHaveLength(1);
    const retained = JSON.parse(records[0]![1]);
    expect(retained).toMatchObject({ ownerUserId: owner, resource: 'page:contact',
      payload: { de: { title: 'New work not in the lifecycle request' } } });
    expect(h.storage.has('swl:draft:page:contact')).toBe(false);
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
    expect(h.el('preparationNotice').textContent).toContain('not public');
    expect(h.el('actionStatus').textContent).toContain('Saved in the CMS');
  });
  it('keeps ordinary and inactive-language recovery records separate across saves', async () => {
    const storage = new Map<string, string>();
    const options = { storage, singleLocale: true };
    const preparation = await editor('contact', 'published', true, options);
    preparation.el('enTitle').value = 'Unsent English preparation';
    preparation.el('enTitle').fire('input'); preparation.flushStash();
    const retainedPreparation = [...storage.entries()];

    const ordinary = await editor('contact', 'published', false, options);
    expect(ordinary.el('enTitle').value).toBe('en title');
    expect([...storage.entries()]).toEqual(retainedPreparation);
    ordinary.el('deTitle').value = 'Unsent German edit';
    ordinary.el('deTitle').fire('input'); ordinary.flushStash();
    const retainedOrdinary = [...storage.entries()].find(([, raw]) => JSON.parse(raw).payload.de.title === 'Unsent German edit')!;

    const restoredPreparation = await editor('contact', 'published', true, options);
    expect(restoredPreparation.el('enTitle').value).toBe('Unsent English preparation');
    expect(restoredPreparation.el('deTitle').value).toBe('de title');
    restoredPreparation.el('saveBtn').click(); await settle();
    expect(storage.get(retainedOrdinary[0])).toBe(retainedOrdinary[1]);

    const restoredOrdinary = await editor('contact', 'published', false, options);
    expect(restoredOrdinary.el('deTitle').value).toBe('Unsent German edit');
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
