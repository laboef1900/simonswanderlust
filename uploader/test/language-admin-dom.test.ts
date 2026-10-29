import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editorDocument } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';

const editorCopy = { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])) };
const buildCopy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
  locale, Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value])),
]));

type Locale = 'de' | 'en';
const stamp = '2026-10-27T00:00:00.000Z';
const state = (primary: Locale, locales: Locale[], lockedAt: string | null = null) => ({ primary, locales, lockedAt, updatedAt: stamp });
interface BrowserResponse { ok: boolean; status: number; json(): Promise<unknown> }
const response = (body: unknown, status = 200): BrowserResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function settings(initial = state('de', ['de'])) {
  const dom = editorDocument(readFileSync('public/settings.html', 'utf8'));
  const el = (id: string) => {
    const result = dom.document.getElementById(id);
    if (!result) throw new Error('Missing #' + id);
    return result;
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const questions: { body: string }[] = [];
  let answer = response(state(initial.primary, [initial.primary, initial.primary === 'de' ? 'en' : 'de']));
  let confirmed = true;
  const context: Record<string, unknown> = {
    document: dom.document, location: { href: '/admin/settings.html' },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (url === '/rebuild/status') return response({ record: 'missing', running: null, last: null, live: null });
      return init.method === 'PUT' ? answer : response(initial);
    },
    AdminConfirm: { ask: async (question: { body: string }) => { questions.push(question); return confirmed; } },
  };
  context.window = context;
  context.EditorCopy = editorCopy;
  context.BuildCopy = buildCopy;
  vm.createContext(context);
  for (const file of ['build-reporting.js', 'language.js', 'settings-language.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  // The VM boundary loses the type of this production entry point.
  const controller = context.SettingsLanguage as { init(): Promise<void> };
  return { el, requests, questions, context,
    init: () => controller.init(),
    answer: (body: unknown, status: number) => { answer = response(body, status); },
    confirm: (value: boolean) => { confirmed = value; },
    submit: async () => { el('languageForm').fire('submit'); await settle(); },
  };
}

describe('Language Settings', () => {
  it.each(['de', 'en'] as const)('prepares and adds the secondary without offering URL-moving changes after %s publication', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const h = settings(state(primary, [primary], stamp));
    await h.init();
    expect(h.el('prepareLanguage').href).toBe('/admin/pages.html?prepareLocale=' + secondary);
    expect(h.el('prepareLanguage').hidden).toBe(false);
    for (const option of h.el('languageMode').querySelectorAll('option')) {
      const value = option.value;
      if (typeof value !== 'string') throw new Error('Language option has no string value');
      expect(option.disabled).toBe(!value.startsWith(primary + ':'));
    }
    h.el('languageMode').value = primary + ':' + primary + ',' + secondary;
    h.el('languageMode').fire('change');
    await h.submit();
    const put = h.requests.find(({ init }) => init.method === 'PUT')!;
    expect(JSON.parse(String(put.init.body))).toEqual({ primary, locales: [primary, secondary] });
  });

  it('keeps candidate input and exposes blockers without claiming activation', async () => {
    const h = settings();
    await h.init();
    h.el('languageMode').value = 'de:de,en';
    h.answer({ code: 'language_pages_incomplete', blockers: [{ key: 'about', locale: 'en', field: 'body', reason: 'image not ready' }] }, 409);
    await h.submit();
    expect(h.el('languageMode').value).toBe('de:de,en');
    expect(h.el('languageBlockers').textContent).toContain('English / about / body: image not ready');
    expect(h.el('languageStatus').textContent).toContain('Nothing was changed');
    expect(h.el('prepareLanguage').hidden).toBe(false);
    expect(h.el('languageFields').disabled).toBe(false);
  });

  it('shows committed mode after build failure and directs recovery to rebuild, never metadata rollback', async () => {
    const h = settings();
    await h.init();
    h.el('languageMode').value = 'de:de,en';
    h.answer({ ...state('de', ['de', 'en']), build: { ok: false, code: 'build_failed', error: 'SECRET', liveRelease: null } }, 200);
    await h.submit();
    expect(h.el('prepareLanguage').hidden).toBe(true);
    expect(h.el('languageStatus').textContent).toContain('Language setting saved in the CMS');
    expect(h.el('languageStatus').textContent).toContain('No live release yet');
    expect(h.el('languageStatus').textContent).not.toContain('SECRET');
    expect(h.el('languageStatus').textContent).toContain('Rebuild site now');
    expect(h.requests.filter(({ init }) => init.method === 'PUT')).toHaveLength(1);
  });

  it('does not mutate mode when confirmation is cancelled', async () => {
    const h = settings();
    await h.init();
    h.el('languageMode').value = 'en:en';
    h.confirm(false);
    await h.submit();
    expect(h.requests.some(({ init }) => init.method === 'PUT')).toBe(false);
    expect(h.el('languageFields').disabled).toBe(false);
  });
});

describe('browser language URL mirror and tabs', () => {
  it.each([
    [state('de', ['de', 'en']), '/karte/', '/en/map/', '/uber-mich/', '/en/about-me/'],
    [state('en', ['en', 'de']), '/de/karte/', '/travel-map/', '/de/uber-mich/', '/about-me/'],
    [state('de', ['de']), '/karte/', null, '/uber-mich/', null],
    [state('en', ['en']), null, '/travel-map/', null, '/about-me/'],
  ] as const)('maps enabled paths without emitting a disabled language URL (%j)', (lang, deMap, enMap, deAbout, enAbout) => {
    const context: Record<string, unknown> = {};
    context.window = context;
    vm.createContext(context);
    vm.runInContext(readFileSync('public/language.js', 'utf8'), context);
    const api = context.SiteLanguage as { publicPath(lang: unknown, locale: Locale, kind: string, slug?: string): string | null };
    expect(api.publicPath(lang, 'de', 'map')).toBe(deMap);
    expect(api.publicPath(lang, 'en', 'map')).toBe(enMap);
    expect(api.publicPath(lang, 'de', 'about')).toBe(deAbout);
    expect(api.publicPath(lang, 'en', 'about')).toBe(enAbout);
    expect(api.publicPath(lang, lang.primary, 'story', 'unchanged-slug')).toBe('/unchanged-slug/');
    expect(api.publicPath(lang, lang.primary, 'rss')).toBe('/rss.xml');
  });

  it('loads once, uses no-store and refuses invalid mode rather than falling back to German', async () => {
    const calls: RequestInit[] = [];
    const context: Record<string, unknown> = { fetch: async (_url: string, init: RequestInit) => {
      calls.push(init); return response(state('en', ['en']));
    } };
    context.window = context;
    context.EditorCopy = editorCopy;
    vm.createContext(context);
    vm.runInContext(readFileSync('public/language.js', 'utf8'), context);
    const api = context.SiteLanguage as { get(): Promise<unknown>; accept(value: unknown): void; config(): { primary: string } };
    expect(() => api.config()).toThrow();
    await Promise.all([api.get(), api.get()]);
    expect(calls).toEqual([{ cache: 'no-store' }]);
    expect(api.config().primary).toBe('en');
    expect(() => api.accept({ primary: 'de', locales: ['en'], updatedAt: stamp })).toThrow();
    expect(api.config().primary).toBe('en');
  });
});

async function about(primary: Locale, prepareLocale?: Locale, route?: (url: string, init: RequestInit) => BrowserResponse | Promise<BrowserResponse>, updatedAt: string | null = stamp) {
  const html = readFileSync('public/about.html', 'utf8');
  const dom = editorDocument(html);
  const el = (id: string) => {
    const element = dom.document.getElementById(id);
    if (!element) throw new Error('Missing #' + id);
    return element;
  };
  const page = {
    key: 'about', status: 'published', updatedAt,
    de: { locale: 'de', title: 'Aktiver Inhalt', bodyMarkdown: 'Deutscher Text', images: {}, slug: '' },
    en: { locale: 'en', title: 'Existing heading', bodyMarkdown: 'English text', images: {}, slug: '' },
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const owner = '11111111-1111-4111-8111-111111111111';
  const cleaned: unknown[] = [];
  class EasyMDE {
    private text = '';
    codemirror = { getInputField: () => dom.document.createElement('textarea'), on() {}, refresh() {} };
    value(value?: string) { if (value !== undefined) this.text = value; return this.text; }
  }
  const context: Record<string, unknown> = {
    document: dom.document, URLSearchParams, EasyMDE, crypto: webcrypto, structuredClone, AbortController,
    setTimeout: () => 0, clearTimeout() {}, addEventListener: dom.document.addEventListener,
    location: { origin: 'https://journal.test', pathname: '/admin/about.html', search: prepareLocale ? '?prepareLocale=' + prepareLocale : '' },
    Auth: { ensureAuthed: async () => ({ userId: owner, isAdmin: true }), renderHeader() {} },
    AdminConfirm: { ask: async () => true },
    DraftGuard: { createDraftGuard: () => ({
      initialize: () => true, stashNow() {}, isDirty: () => false, freshContext() {},
      markDirty() {}, snapshot: () => ({ title: el(primary + 'Title').value }), markClean: (snap: unknown) => cleaned.push(snap), tryRestore: () => null,
    }) },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      let result;
      if (url === '/pages') result = response({ pages: [{ key: 'about', known: true, defaults: { de: '', en: '' } }] });
      else if (route && url !== '/language') result = await route(url, init);
      else if (url === '/language') result = response(state(primary, [primary]));
      else if (url.endsWith('/revisions')) result = response([]);
      else if (init.method === 'PUT') result = response({ saved: { ...page, updatedAt: '2026-10-28T00:00:00.000Z' }, build: { ok: true } });
      else result = response(page);
      if (result.ok && url === '/pages/about') {
        const body = await result.json() as Record<string, unknown>;
        const sent = init.body ? JSON.parse(String(init.body)) : null;
        return response({ ...page, ownerUserId: owner, lastSaveId: null, ...body,
          ...(sent ? { saveId: sent.saveId, saved: { ...page, ...sent, ...(body.saved as object) } } : {}) }, result.status);
      }
      return result;
    },
  };
  context.window = context;
  context.EditorCopy = editorCopy;
  context.BuildCopy = buildCopy;
  vm.createContext(context);
  for (const file of ['build-reporting.js', 'language.js', 'tabs.js', 'pages-ui.js', 'write-recovery.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  const start = html.lastIndexOf('<script>') + '<script>'.length;
  vm.runInContext(html.slice(start, html.lastIndexOf('</script>')), context);
  await settle();
  return { el, requests, page, context, cleaned };
}

describe('About inactive translation preparation', () => {
  it.each([
    ['de', stamp], ['en', stamp], ['de', null], ['en', null],
  ] as const)('saves only the inactive translation for %s-primary at version %s without implying activation', async (primary, updatedAt) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const h = await about(primary, secondary, undefined, updatedAt);
    expect(h.el('tab-' + secondary).hidden).toBe(false);
    expect(h.el('tab-' + primary).hidden).toBe(true);
    expect(h.el('preparationNotice').textContent).toContain('not public');
    h.el(secondary + 'Title').value = 'Prepared title';
    h.el('saveBtn').click();
    await settle();
    const request = h.requests.find(({ init }) => init.method === 'PUT')!;
    const payload = JSON.parse(String(request.init.body));
    expect(payload).toEqual({
      updatedAt, prepareLocale: secondary,
      expectedOwnerId: expect.any(String), saveId: expect.any(String),
      [secondary]: { ...h.page[secondary], title: 'Prepared title' },
    });
    expect(payload[primary]).toBeUndefined();
    expect(h.el('preparationNotice').textContent).toContain('not public');
    expect(h.el('actionStatus').textContent).toContain('Saved in the CMS');
    expect(h.requests.some(({ url, init }) => url === '/language' && init.method === 'PUT')).toBe(false);
  });

  it.each(['de', 'en'] as const)('ordinary %s-only editing excludes retained inactive fields without inferring liveness', async (primary) => {
    const h = await about(primary);
    const secondary = primary === 'de' ? 'en' : 'de';
    expect(h.el('tab-' + secondary).hidden).toBe(true);
    expect(h.el('preparationNotice').hidden).toBe(true);
    h.el('saveBtn').click();
    await settle();
    const payload = JSON.parse(String(h.requests.find(({ init }) => init.method === 'PUT')!.init.body));
    expect(payload).toEqual({ updatedAt: stamp, [primary]: h.page[primary], expectedOwnerId: expect.any(String), saveId: expect.any(String) });
    expect(h.el('actionStatus').textContent).toContain('Saved in the CMS');
    expect(h.el('actionStatus').textContent).toContain('Live release status is unavailable');
    expect(h.el('actionStatus').textContent).not.toContain('Live:');
  });

  it('refuses preparation of an already enabled language without issuing a page save', async () => {
    const h = await about('en', 'en');
    expect(h.el('saveBtn').disabled).toBe(true);
    expect(h.el('actionStatus').textContent).toContain('only available for an inactive language');
    h.el('saveBtn').click();
    await settle();
    expect(h.requests.some(({ init }) => init.method === 'PUT')).toBe(false);
  });
});

describe('About acknowledged save and failed rebuild', () => {
  it('keeps the submitted clean snapshot and mutation token despite newer edits and a failed revisions refresh', async () => {
    let token = stamp;
    const pending = Promise.withResolvers<BrowserResponse>();
    let saves = 0;
    const h = await about('en', undefined, async (url, init) => {
      if (url.endsWith('/revisions')) throw new Error('optional list unavailable');
      if (init.method === 'PUT') {
        const payload = JSON.parse(String(init.body));
        if (payload.updatedAt !== token) return response({ code: 'conflict' }, 409);
        saves++;
        if (saves === 1) return pending.promise;
        return response({ saved: { updatedAt: token }, build: { ok: true, release: '1793000000000-1-0002' } });
      }
      return response({ updatedAt: token, en: { title: 'Initial', bodyMarkdown: 'English', images: {} }, de: { title: '', bodyMarkdown: '', images: {} } });
    });
    h.el('enTitle').value = 'Submitted';
    h.el('saveBtn').click();
    await settle();
    h.el('enTitle').value = 'Newer local edit';
    token = '2026-10-28T00:00:00.000Z';
    pending.resolve(response({ saved: { updatedAt: token }, build: { ok: false, code: 'no_space', error: 'SECRET', liveRelease: null } }));
    await settle();
    expect(h.cleaned.at(-1)).toEqual({ title: 'Submitted' });
    expect(h.el('enTitle').value).toBe('Newer local edit');
    expect(h.el('actionStatus').textContent).toContain('Saved in the CMS');
    expect(h.el('actionStatus').textContent).toContain('No live release yet');
    expect(h.el('actionStatus').textContent).not.toContain('SECRET');
    h.el('saveBtn').click();
    await settle();
    expect(saves).toBe(2);
    expect(h.cleaned.at(-1)).toEqual({ title: 'Newer local edit' });
    const puts = h.requests.filter(({ init }) => init.method === 'PUT');
    expect(JSON.parse(String(puts[1]!.init.body)).updatedAt).toBe(token);
  });
});

describe('enabled locale keyboard navigation', () => {
  it('never activates a disabled locale and follows primary-first tab order', () => {
    const dom = editorDocument(readFileSync('public/about.html', 'utf8'));
    const context: Record<string, unknown> = { document: dom.document, EditorCopy: editorCopy };
    context.window = context;
    vm.createContext(context);
    for (const file of ['language.js', 'tabs.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
    vm.runInContext(`const list = document.querySelector('[role="tablist"]');
      const tabs = Tabs.wire(list);
      SiteLanguage.tabs(list, {primary:'en',locales:['en']}, tabs);`, context);
    const de = dom.document.getElementById('tabbtn-de')!;
    const en = dom.document.getElementById('tabbtn-en')!;
    en.fire('keydown', { key: 'ArrowRight' });
    expect(en.getAttribute('aria-selected')).toBe('true');
    expect(de.hidden).toBe(true);
    vm.runInContext(`SiteLanguage.tabs(list, {primary:'en',locales:['en','de']}, tabs)`, context);
    expect(en.parentElement!.children.map((tab) => tab.dataset.tab)).toEqual(['en', 'de']);
    en.fire('keydown', { key: 'ArrowRight' });
    expect(de.getAttribute('aria-selected')).toBe('true');
  });
});
