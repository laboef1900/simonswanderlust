import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { DEFAULT_TRANSLATION_PROMPT } from '../src/translation-prompt.js';
import { buildServer } from '../src/server.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { ui } from '../../site/src/i18n/ui.js';
import { renderGpxCopy } from '../src/gpx-copy.js';
import { renderStopRouteCopy } from '../src/stop-route-copy.js';
import { publication, loadPublicationState } from './publication-client-fixture.js';
import { Window } from '../../site/node_modules/happy-dom/lib/index.js';

// posts.html, settings.html and comments.html run their actions as plain
// top-level browser code. Load each inline script in a vm context backed by a
// stub DOM keyed on the REAL markup's ids (same precedent as
// editor-dom.test.ts) and pull the network out from under an in-flight action:
// the contract under test is that a rejected fetch leaves the page usable —
// the trigger re-enabled and the failure named in the status region — instead
// of an unhandled rejection with "Deleting…" frozen on screen (#139).

interface Element {
  id: string;
  tagName: string;
  value: string;
  textContent: string;
  href: string;
  /** `label.htmlFor`, as the pages set it on created labels. */
  htmlFor: string;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  indeterminate: boolean;
  open: boolean;
  focused: boolean;
  className: string;
  tabIndex: number;
  src: string;
  alt: string;
  scrollLeft: number;
  scrollTop: number;
  files: File[];
  dataset: Record<string, string>;
  style: Record<string, string>;
  attrs: Record<string, string>;
  options: { value: string }[];
  children: Element[];
  /** Set by appendChild/append/after; cleared when the child is removed or its parent's children are replaced. */
  parentElement: Element | null;
  /** Markup elements (`el(id)`) are in the document; created nodes only once appended under one. */
  rooted: boolean;
  readonly isConnected: boolean;
  classList: { toggle(name: string, on?: boolean): void; contains(name: string): boolean };
  add(option: { value: string }): void;
  /** `select.remove(index)` drops an option; `node.remove()` detaches the node from its parent. */
  remove(index?: number): void;
  listeners: Record<string, ((event?: Record<string, unknown>) => Promise<void> | void)[]>;
  addEventListener(type: string, fn: (event?: Record<string, unknown>) => Promise<void> | void): void;
  removeEventListener(type: string, fn: (event?: Record<string, unknown>) => Promise<void> | void): void;
  click(): Promise<void>;
  fire(type: string, event?: Record<string, unknown>): Promise<void>;
  /** A browser-dispatched event: runs this node's listeners, then each ancestor's when it bubbles. */
  dispatchEvent(event: { type: string; bubbles?: boolean }): boolean;
  /** Where a bubbling event goes next; `loadPage` continues past the flat stub tree along the real markup. */
  bubbleParent(): Element | null;
  appendChild(child?: Element): void;
  append(...children: Element[]): void;
  after(...nodes: Element[]): void;
  replaceChildren(): void;
  contains(node: unknown): boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  toggleAttribute(name: string, force?: boolean): boolean;
  querySelectorAll(selector: string): Element[];
  querySelector(selector: string): Element | null;
  /** No stub sits inside the admin shell, so there is never a `.cms-workspace` ancestor. */
  closest(selector: string): Element | null;
  focus(options?: { preventScroll?: boolean }): void;
}

function element(): Element {
  const listeners: Element['listeners'] = {};
  const detach = (children: Element[]) => { for (const child of children) child.parentElement = null; children.length = 0; };
  const e: Element = {
    id: '', value: '', textContent: '', innerHTML: '', href: '', htmlFor: '', hidden: false, disabled: false, checked: false,
    tagName: 'DIV',
    indeterminate: false, open: false, focused: false, className: '', tabIndex: 0, dataset: {},
    src: '', alt: '', scrollLeft: 0, scrollTop: 0, files: [],
    style: {}, attrs: {}, listeners, options: [], children: [], parentElement: null, rooted: false,
    get isConnected() { return this.parentElement ? this.parentElement.isConnected : this.rooted; },
    classList: {
      toggle(name, on) {
        const names = new Set(e.className.split(/\s+/).filter(Boolean));
        if (on ?? !names.has(name)) names.add(name); else names.delete(name);
        e.className = [...names].join(' ');
      },
      contains(name) { return e.className.split(/\s+/).includes(name); },
    },
    add(option) { this.options.push(option); },
    remove(index) {
      if (index !== undefined) { this.options.splice(index, 1); return; }
      const parent = this.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((listener) => listener !== fn); },
    async click() { await this.fire('click'); },
    async fire(type, event = {}) {
      for (const fn of listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
    },
    dispatchEvent(event) {
      for (let node: Element | null = this; node; node = event.bubbles ? node.bubbleParent() : null) {
        for (const fn of node.listeners[event.type] ?? []) void fn({ preventDefault() {}, type: event.type, target: this });
      }
      return true;
    },
    bubbleParent() { return this.parentElement; },
    appendChild(child) { if (child) { child.remove(); child.parentElement = this; this.children.push(child); } },
    append(...children) { for (const child of children) this.appendChild(child); },
    after(...nodes) {
      const parent = this.parentElement;
      if (!parent) return;
      let anchor: Element = this;
      for (const node of nodes) {
        node.remove();
        node.parentElement = parent;
        parent.children.splice(parent.children.indexOf(anchor) + 1, 0, node);
        anchor = node;
      }
    },
    replaceChildren() { detach(this.children); },
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return name in this.attrs; },
    removeAttribute(name) { delete this.attrs[name]; },
    toggleAttribute(name, force) {
      const on = force ?? !(name in this.attrs);
      if (on) this.attrs[name] = ''; else delete this.attrs[name];
      return on;
    },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...((selector.startsWith('.') ? child.classList.contains(selector.slice(1))
          : child.tagName === selector.toUpperCase()) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    closest() { return null; },
    focus() { this.focused = true; },
  };
  let markup = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => markup,
    set: (value: string) => { markup = value; detach(e.children); },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set: (value: string) => { text = value; detach(e.children); },
  });
  return e;
}

const NETWORK_DOWN = new TypeError('Failed to fetch');
const EDITOR_COPY = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));

type Listener = (event?: Record<string, unknown>) => Promise<void> | void;

interface PageSurface {
  ctx: Record<string, unknown>; el: (id: string) => Element; windowListeners: Record<string, Listener[]>;
}

/** Each markup id with its nearest ancestor's id (null at the top), read from the real HTML. */
function markupParents(markup: string): Map<string, string | null> {
  const window = new Window();
  const parsed = new window.DOMParser().parseFromString(markup, 'text/html');
  const parents = new Map<string, string | null>();
  for (const node of parsed.querySelectorAll('[id]')) parents.set(node.id, node.parentElement?.closest('[id]')?.id ?? null);
  void window.happyDOM.close();
  return parents;
}
function loadPage(file: string, extraGlobals: Record<string, unknown>, scripts: string[] = []): PageSurface {
  const html = readFileSync(file, 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const script = html.slice(scriptStart + '<script>'.length, html.lastIndexOf('</script>'));
  const markup = html.slice(0, scriptStart);
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const elements = new Map<string, Element>();
  let activeElement: Element | null = null;
  const createElement = (tag = 'div'): Element => {
    const node = Object.assign(element(), { tagName: tag.toUpperCase() });
    node.focus = () => { node.focused = true; activeElement = node; };
    node.bubbleParent = () => node.parentElement ?? markupParent(node);
    return node;
  };
  // The stub tree is flat, so an event bubbling out of a markup element follows the
  // real document instead: its nearest ancestor with an id, then the document.
  let parents: Map<string, string | null> | undefined;
  const markupParent = (node: Element): Element | null => {
    if (elements.get(node.id) !== node) return null;
    parents ??= markupParents(markup);
    const parent = parents.get(node.id);
    return parent ? el(parent) : documentStub;
  };
  const el = (id: string): Element => {
    if (!ids.has(id)) throw new Error('no element #' + id + ' in ' + file);
    let e = elements.get(id);
    if (!e) { e = createElement(); e.id = id; e.rooted = true; elements.set(id, e); }
    return e;
  };
  // ARIA tabs carry their state in markup that tabs.js reads; mirror just that.
  const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  for (const [tag] of markup.matchAll(/<[a-z]+\b[^>]*\bid="[^"]+"[^>]*>/g)) {
    const node = el(attr(tag, 'id')!);
    for (const name of ['role', 'aria-describedby']) {
      const value = attr(tag, name);
      if (value) node.attrs[name] = value;
    }
  }
  const tabs = [...markup.matchAll(/<button\b[^>]*\brole="tab"[^>]*>/g)].map(([tag]) => {
    const tab = el(attr(tag, 'id')!);
    tab.dataset.tab = attr(tag, 'data-tab') ?? '';
    for (const name of ['aria-controls', 'aria-selected']) tab.attrs[name] = attr(tag, name) ?? '';
    tab.tabIndex = attr(tag, 'tabindex') === '-1' ? -1 : 0;
    return tab;
  });
  for (const [tag] of markup.matchAll(/<[a-z]+\b[^>]*\brole="tablist"[^>]*>/g)) {
    const list = el(attr(tag, 'id')!);
    const orientation = attr(tag, 'aria-orientation');
    if (orientation) list.attrs['aria-orientation'] = orientation;
    list.querySelectorAll = () => tabs;
  }
  for (const [tag] of markup.matchAll(/<section\b[^>]*\brole="tabpanel"[^>]*>/g)) {
    el(attr(tag, 'id')!).hidden = /\shidden[\s>]/.test(tag);
  }
  const windowListeners: Record<string, Listener[]> = {};
  // An element itself, so a page can listen on the document (outside-click
  // dismissal) and a test can fire there with an explicit target. It is the
  // connected root: anything a test appends under it reads as connected.
  const documentStub = Object.assign(element(), {
    rooted: true,
    referrer: '',
    title: '',
    documentElement: { lang: /<html\b[^>]*lang="([^"]+)"/.exec(html)?.[1] ?? 'en' },
    // Markup ids resolve to their stub; a created element is found once it hangs under one (AdminField's error lines).
    getElementById: (id: string): Element | null => {
      if (ids.has(id)) return el(id);
      const within = (node: Element): Element | undefined => node.children.find((child) => child.id === id) ?? node.children.map(within).find(Boolean);
      for (const root of [documentStub, ...elements.values()]) { const found = within(root); if (found) return found; }
      return null;
    },
    createElement,
    createTextNode: (text: string) => Object.assign(element(), { textContent: text }),
  });
  const ctx: Record<string, unknown> = {
    document: documentStub,
    location: {
      href: 'http://localhost/admin/posts.html',
      origin: 'http://localhost',
      pathname: '/admin/posts.html',
      search: '',
      hash: '',
      protocol: 'http:',
    },
    history: { replaceState() {} },
    addEventListener: (type: string, fn: Listener) => { (windowListeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => { windowListeners[type] = (windowListeners[type] || []).filter((listener) => listener !== fn); },
    AbortController, Date,
    setTimeout: () => 0, clearTimeout() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    URL,
    URLSearchParams,
    fetch: () => Promise.reject(NETWORK_DOWN),
    console,
    confirm: () => true,
    prompt: () => 'DELETE',
    Auth: {
      ensureAuthed: async () => null, renderHeader() {},
      setPageTitle(page: string) {
        const document = ctx.document;
        if (document && typeof document === 'object' && 'title' in document) document.title = page + ' · Travel journal';
      },
    },
    EditorCopy: { en: EDITOR_COPY },
    BuildCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('admin.build.'))
        .map(([key, value]) => [key.slice('admin.build.'.length), value])),
    ])),
    AdminConfirm: { ask: async () => true, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
    ...extraGlobals,
  };
  // Focus tracking follows `focus()`; the comments cases also assign it directly.
  Object.defineProperty(ctx.document, 'activeElement', { get: () => activeElement, set: (node: Element | null) => { activeElement = node; } });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(renderGpxCopy(), ctx);
  vm.runInContext(renderStopRouteCopy(), ctx);
  // Every admin page loads admin-ui.js before the scripts that format or focus through it.
  vm.runInContext(readFileSync('public/admin-ui.js', 'utf8'), ctx);
  vm.runInContext(readFileSync('public/build-reporting.js', 'utf8'), ctx);
  vm.runInContext(readFileSync('public/publication-state.js', 'utf8'), ctx);
  vm.runInContext(readFileSync('public/publication-refresh.js', 'utf8'), ctx);
  vm.runInContext(readFileSync('public/language.js', 'utf8'), ctx);
  vm.runInContext(`SiteLanguage.accept({primary:'de',locales:['de','en'],lockedAt:null,updatedAt:'2026-10-27T00:00:00.000Z'});
    SiteLanguage.get = async () => SiteLanguage.config();`, ctx);
  for (const dependency of scripts) vm.runInContext(readFileSync(dependency, 'utf8'), ctx, { filename: dependency });
  vm.runInContext(script, ctx);
  return { ctx, el, windowListeners };
}

// The real posts-filter.js, not a stub: counts, filtering and language chip
// states are its contract.
function realPostsFilter() {
  const windowStub: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync('public/posts-filter.js', 'utf8'), { window: windowStub, URLSearchParams, PublicationState: loadPublicationState() });
  return windowStub.PostsFilter as Record<string, unknown>;
}

// The menus' own behaviour is admin-select.test.ts's; here a stub records
// each `sync()` (with the select's value at that moment) so a test can see
// that a programmatic write reached every menu.
function menuStub(syncs: string[] = []) {
  return {
    enhance: (select: Element) => ({ sync: () => { syncs.push(select.id + '=' + select.value); }, close() {}, trigger: select }),
  };
}

function loadPosts(extraGlobals: Record<string, unknown> = {}, languageRead?: () => Promise<Response>) {
  const request = extraGlobals.fetch as ((url: string, init?: RequestInit) => unknown) | undefined;
  const page: PageSurface = loadPage('public/posts.html', {
    AdminSelect: menuStub(),
    ResizeObserver: class { observe() {} disconnect() {} },
    PostsFilter: {
      apply: (posts: unknown[]) => posts,
      REGIONS: [],
      countries: () => [],
      extraFilterCount: () => 0,
      fromSearch: () => ({ q: '', status: '', region: '', country: '', sort: 'updated', order: 'desc' }),
      languageStates: realPostsFilter().languageStates,
      thumbUrl: () => null,
      toSearch: () => '',
    },
    ...extraGlobals,
    fetch: (url: string, init?: RequestInit) => url === '/language'
      ? languageRead?.() ?? Promise.resolve(Response.json(vm.runInContext('SiteLanguage.config()', page.ctx)))
      : request ? request(url, init) : Promise.reject(NETWORK_DOWN),
  });
  vm.runInContext('listStale = false', page.ctx);
  // Two things a browser does that the stub's flat tree cannot know: clearing
  // the rows drops the focus that was inside them, and the bulk buttons live in
  // #bulkBar, so a hidden bar neither keeps nor takes their focus.
  const doc = page.ctx.document as Element & { activeElement: Element | null };
  const list = page.el('postsList');
  const rows = Object.getOwnPropertyDescriptor(list, 'innerHTML')!;
  Object.defineProperty(list, 'innerHTML', {
    get: rows.get,
    set: (value: string) => { if (doc.activeElement && list.contains(doc.activeElement)) doc.activeElement = null; rows.set!.call(list, value); },
  });
  const bar = page.el('bulkBar');
  const bulkButtons = ['bulkPublish', 'bulkUnpublish', 'bulkDelete'].map((id) => page.el(id));
  let barHidden = true; // hidden in the markup until something is selected
  Object.defineProperty(bar, 'hidden', {
    get: () => barHidden,
    set: (value: boolean) => { barHidden = value; if (value && bulkButtons.includes(doc.activeElement!)) doc.activeElement = null; },
  });
  for (const button of bulkButtons) button.focus = () => { if (!barHidden && !button.disabled) { button.focused = true; doc.activeElement = button; } };
  return page;
}

/** The page harness's stub document: the stub element loadPage installs, plus the focus seam the tests drive. */
type PageDocument = Element & { body: Element; activeElement: Element | null; createElement(tag: string): Element };
const documentOf = (page: PageSurface) => page.ctx.document as PageDocument;

describe('import.html rejection accounting', () => {
  it('shows a rejection-only completed summary and renders HTML-like slugs only as text', () => {
    const { ctx, el } = loadPage('public/import.html', {});
    const warning = '<img src=x onerror=alert(1)> (de): no translation (untranslated post) — rejected';
    const renderFinished = vm.runInContext('renderFinished', ctx) as (job: unknown) => void;
    renderFinished({
      status: 'done',
      summary: {
        imported: 0, updated: 0, skippedPublished: 0, rejected: 1, failed: 0,
        images: { total: 0, hosted: 0, failed: 0 }, warnings: [warning],
      },
    });
    // Results and callouts are revealed through the hidden attribute, never an inline style.
    expect(el('results').hidden).toBe(false);
    expect(el('counts').textContent).toContain('Rejected: 1');
    expect(el('importRejected').hidden).toBe(false);
    expect(el('importRejected').textContent).toContain('1 story group');
    expect(el('importRejected').textContent).not.toContain('(s)');
    expect(el('importPartial').hidden).toBe(true);
    expect(el('warnings').children).toHaveLength(1);
    expect(el('warnings').children[0]!.textContent).toBe(warning);
    expect(el('warnings').children[0]!.innerHTML).toBe('');
    expect(el('warnings').children[0]!.children).toEqual([]);
  });

  it('pluralises missing photos and hides stale callouts when a later job finishes cleanly', () => {
    const { ctx, el } = loadPage('public/import.html', {});
    const renderFinished = vm.runInContext('renderFinished', ctx) as (job: unknown) => void;
    renderFinished({ status: 'done', summary: { imported: 2, updated: 0, images: { total: 5, hosted: 2, failed: 3 }, warnings: [] } });
    expect(el('importPartial').hidden).toBe(false);
    expect(el('importPartial').textContent).toMatch(/^3 photos could not be downloaded/);
    expect(el('out').textContent).toBe('Finished with missing photos.');
    renderFinished({ status: 'done', summary: { imported: 2, updated: 0, images: { total: 1, hosted: 1, failed: 0 }, warnings: [] } });
    expect(el('importPartial').hidden).toBe(true);
    expect(el('importRejected').hidden).toBe(true);
    expect(el('out').textContent).toBe('Done.');
  });

  it('asks for the export under the file field instead of in the status line, and clears it once a file is chosen', async () => {
    const fetch = vi.fn();
    const page = loadPage('public/import.html', { fetch });
    const { el } = page;
    const doc = documentOf(page);
    const field = el('wxr');
    const card = doc.createElement('div');
    doc.appendChild(card);
    card.appendChild(field);
    await el('importBtn').click();
    expect(fetch).not.toHaveBeenCalled();
    expect(el('out').textContent).toBe('');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const error = card.children[1]!;
    expect(error.id).toBe('wxrError');
    expect(error.textContent).toBe('Choose a WordPress export (.xml) first.');
    expect(error.hidden).toBe(false);
    expect(field.getAttribute('aria-describedby')).toContain('wxrError');
    expect(doc.activeElement).toBe(field);
    field.files = [new File(['<rss/>'], 'export.xml', { type: 'text/xml' })];
    await field.fire('change');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(error.hidden).toBe(true);
  });

  it('dates a running job like every other admin moment and hands focus back to Import when it finishes', async () => {
    let status = 'running';
    const fetch = vi.fn(async (url: string) => {
      if (url === '/import') return Response.json({ planned: { groups: { total: 2, done: 0 }, images: { planned: 4, hosted: 0, failed: 0 } } }, { status: 202 });
      return Response.json({ job: { status, startedAt: '2026-11-10T08:43:00Z', progress: { groups: { total: 2, done: 1 }, images: { planned: 4, hosted: 1, failed: 0 } },
        summary: { imported: 2, updated: 0, images: { total: 4, hosted: 4, failed: 0 }, warnings: [] } } });
    });
    const ticks: (() => void)[] = [];
    const page = loadPage('public/import.html', { fetch, FormData, setTimeout: (tick: () => void) => { ticks.push(tick); return ticks.length; } });
    const { ctx, el } = page;
    const doc = documentOf(page);
    const format = vm.runInContext('AdminFormat', ctx) as { dateTime(value: string): string };
    el('wxr').files = [new File(['<rss/>'], 'export.xml', { type: 'text/xml' })];
    el('importBtn').focus();
    await el('importBtn').click();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(el('importBtn').disabled).toBe(true);
    expect(el('out').textContent).toBe('Running… started ' + format.dateTime('2026-11-10T08:43:00Z') + '.');
    expect(el('out').textContent).not.toContain('2026-11-10T');
    expect(el('progressText').textContent).toBe('Photos 1 of 4  ·  Stories 1 of 2');
    // A disabled control cannot hold focus: the browser drops it to <body>.
    doc.activeElement = null;
    status = 'done';
    ticks.pop()!();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(el('importBtn').disabled).toBe(false);
    expect(doc.activeElement).toBe(el('importBtn'));
    expect(el('out').textContent).toBe('Done.');
  });
});

const post = { translationKey: 'tk1', title: 'Bukarest', slugs: { de: 'bukarest', en: 'bucharest' }, status: 'published', publication: publication() };

describe('users.html failure recovery', () => {
  const user = { id: 2, username: 'author2', isAdmin: false };

  it.each(['http', 'network'] as const)('recovers the user list after a %s failure without clearing form entries', async (failure) => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json([user]))
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json([]));
    const { el } = loadPage('public/users.html', { fetch: fetcher });
    el('username').value = 'unsaved-author';
    el('password').value = 'unsaved-password';
    const loading = el('reloadUsers').click();
    expect(el('reloadUsers').disabled).toBe(true);
    await el('reloadUsers').click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (failure === 'http') pending.resolve(Response.json({ error: 'unavailable' }, { status: 500 }));
    else pending.reject(NETWORK_DOWN);
    await loading;
    expect(el('list').children).toHaveLength(0);
    expect(el('reloadUsers').disabled).toBe(false);

    await el('reloadUsers').click();
    expect(el('list').children.map((row) => row.children[0]?.textContent)).toEqual([user.username]);
    // A failed refresh must not retain actionable rows from an obsolete list.
    await el('reloadUsers').click();
    expect(el('list').children).toHaveLength(0);
    expect(el('listout').textContent).toBe(ui.en['editor.chrome.usersLoadFailed'].replace('{status}', '500'));
    await el('reloadUsers').click();
    expect(el('list').children).toHaveLength(0);
    expect(el('username').value).toBe('unsaved-author');
    expect(el('password').value).toBe('unsaved-password');
  });

  it('refreshes after Add even while an older user list is pending', async () => {
    const stale = Promise.withResolvers<Response>();
    const fresh = Promise.withResolvers<Response>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(Response.json(user, { status: 201 }))
      .mockReturnValueOnce(fresh.promise);
    const { el } = loadPage('public/users.html', { fetch: fetcher });
    const oldLoad = el('reloadUsers').click();
    el('username').value = user.username;
    el('password').value = 'fixture-new-password';
    const add = el('addForm').fire('submit');
    await Promise.resolve();
    await Promise.resolve();
    stale.resolve(Response.json([]));
    await oldLoad;
    expect(el('reloadUsers').disabled).toBe(true);
    expect(el('listout').textContent).toBe(ui.en['editor.chrome.usersLoading']);
    fresh.resolve(Response.json([user]));
    await add;
    expect(el('list').children.map((row) => row.children[0]?.textContent)).toEqual([user.username]);
    expect(el('reloadUsers').disabled).toBe(false);
  });

  it('does not restore a removed account when an older reload completes last', async () => {
    const deletion = Promise.withResolvers<Response>();
    const stale = Promise.withResolvers<Response>();
    const deletionStarted = Promise.withResolvers<void>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json([user]))
      .mockImplementationOnce(() => { deletionStarted.resolve(); return deletion.promise; })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(Response.json([]));
    const { el } = loadPage('public/users.html', { fetch: fetcher });
    await el('reloadUsers').click();
    const remove = el('list').children[0]!.children[2]!.click();
    await deletionStarted.promise;
    const oldLoad = el('reloadUsers').click();
    deletion.resolve(new Response(null, { status: 204 }));
    await remove;
    // The successful mutation's fresh read must finish independently of the old GET.
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(el('listout').textContent).toBe('0 accounts');
    stale.resolve(Response.json([user]));
    await oldLoad;
    expect(el('list').children).toHaveLength(0);
    expect(el('listout').textContent).toBe('0 accounts');
  });

  const actions = [
    { form: 'addForm', button: 'add', status: 'out',
      fields: [['username', 'author2'], ['password', 'fixture-new-password']] },
    { form: 'pwForm', button: 'changepw', status: 'pwout',
      fields: [['curpw', 'fixture-current-password'], ['newpw', 'fixture-new-password']] },
  ] as const;

  it.each(actions)('$form preserves entries on rejection, prevents duplicate submission, and permits a successful retry', async (action) => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json([user]));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { el } = loadPage('public/users.html', { fetch: fetcher, console: logger });
    for (const [id, value] of action.fields) el(id).value = value;
    el('isAdmin').checked = true;
    const submitting = el(action.form).fire('submit');
    expect(el(action.button).disabled).toBe(true);
    await el(action.form).fire('submit');
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.reject(new Error('Transport failed: ' + action.fields.map(([, value]) => value).join(' ')));
    await submitting;
    expect(el(action.button).disabled).toBe(false);
    for (const [id, value] of action.fields) {
      expect(el(id).value).toBe(value);
      if (id !== 'username') expect(el(action.status).textContent).not.toContain(value);
    }
    expect(el('isAdmin').checked).toBe(true);
    for (const log of Object.values(logger)) expect(log).not.toHaveBeenCalled();

    await el(action.form).fire('submit');
    expect(el(action.button).disabled).toBe(false);
    for (const [id] of action.fields) expect(el(id).value).toBe('');
    if (action.form === 'addForm') {
      expect(el('isAdmin').checked).toBe(false);
      expect(el('list').children[0]?.children[0]?.textContent).toBe(user.username);
    }
  });

  it.each(actions)('$form keeps entries after an HTTP refusal and retains newer edits when a retry succeeds', async (action) => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json([user]));
    const { el } = loadPage('public/users.html', { fetch: fetcher });
    for (const [id, value] of action.fields) el(id).value = value;
    await el(action.form).fire('submit');
    expect(el(action.button).disabled).toBe(false);
    for (const [id, value] of action.fields) expect(el(id).value).toBe(value);

    const retry = el(action.form).fire('submit');
    for (const [id] of action.fields) el(id).value = 'newer-unsaved-entry';
    pending.resolve(Response.json({ ok: true }));
    await retry;
    expect(el(action.button).disabled).toBe(false);
    for (const [id] of action.fields) expect(el(id).value).toBe('newer-unsaved-entry');
  });

  it('keeps confirmed account creation separate from a failed list refresh', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json([user]));
    const { el } = loadPage('public/users.html', { fetch: fetcher });
    el('username').value = user.username;
    el('password').value = 'fixture-new-password';
    await el('addForm').fire('submit');
    expect(el('username').value).toBe('');
    expect(el('password').value).toBe('');
    expect(el('add').disabled).toBe(false);
    expect(el('reloadUsers').disabled).toBe(false);
    await el('reloadUsers').click();
    expect(el('list').children[0]?.children[0]?.textContent).toBe(user.username);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('counts the accounts in the list status and deletes a row through a Delete action that hands focus to the next account', async () => {
    const accounts = [
      { id: 1, username: 'anna', isAdmin: true }, { id: 2, username: 'bert', isAdmin: false }, { id: 3, username: 'cleo', isAdmin: false },
    ];
    const deletion = Promise.withResolvers<Response>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(accounts))
      .mockReturnValueOnce(deletion.promise)
      .mockResolvedValueOnce(Response.json(accounts.filter((account) => account.username !== 'bert')));
    const questions: Record<string, unknown>[] = [];
    const page = loadPage('public/users.html', { fetch: fetcher, AdminConfirm: { ask: async (question: Record<string, unknown>) => { questions.push(question); return true; } } });
    const { el } = page;
    const doc = documentOf(page);
    await el('reloadUsers').click();
    expect(el('listout').textContent).toBe('3 accounts');
    const rowOf = (name: string) => el('list').children.find((row) => row.children[0]?.textContent === name)!;
    const bert = rowOf('bert').children[2]!;
    expect(bert.textContent).toBe('Delete');
    expect(bert.getAttribute('aria-label')).toBe('Delete account bert');
    bert.focus();
    const removing = bert.click();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(questions).toEqual([expect.objectContaining({ title: 'Delete this account?', confirmLabel: 'Delete account', danger: true })]);
    expect(fetcher).toHaveBeenLastCalledWith('/users/2', expect.objectContaining({ method: 'DELETE' }));
    // A disabled control cannot hold focus: the browser drops it to <body>.
    doc.activeElement = null;
    deletion.resolve(new Response(null, { status: 204 }));
    await removing;
    expect(el('out').textContent).toBe('Account bert deleted.');
    expect(el('listout').textContent).toBe('2 accounts');
    expect(el('list').children.map((row) => row.children[0]?.textContent)).toEqual(['anna', 'cleo']);
    expect(doc.activeElement).toBe(rowOf('cleo').children[2]);
  });

  it('shows one account in the singular', async () => {
    const { el } = loadPage('public/users.html', { fetch: vi.fn().mockResolvedValueOnce(Response.json([user])) });
    await el('reloadUsers').click();
    expect(el('listout').textContent).toBe('1 account');
  });

  it('refuses a malformed username and a short password under their fields before any request', async () => {
    const fetcher = vi.fn();
    const page = loadPage('public/users.html', { fetch: fetcher });
    const { el } = page;
    const doc = documentOf(page);
    const fields = Object.fromEntries(['username', 'password'].map((id) => {
      const wrap = doc.createElement('div');
      doc.appendChild(wrap);
      wrap.appendChild(el(id));
      return [id, wrap];
    }));
    el('username').value = 'simon wanderlust';
    el('password').value = 'long-enough-password';
    await el('addForm').fire('submit');
    expect(fetcher).not.toHaveBeenCalled();
    expect(el('username').getAttribute('aria-invalid')).toBe('true');
    expect(fields.username!.children[1]!.textContent).toBe('Use 1–64 letters, digits, “.”, “_” or “-”.');
    expect(doc.activeElement).toBe(el('username'));
    expect(el('out').textContent).toBe('');
    el('username').value = 'simon.w';
    await el('username').fire('input');
    expect(el('username').getAttribute('aria-invalid')).toBeNull();
    el('password').value = 'short';
    await el('addForm').fire('submit');
    expect(fetcher).not.toHaveBeenCalled();
    expect(el('password').getAttribute('aria-invalid')).toBe('true');
    expect(fields.password!.children[1]!.textContent).toBe('Use at least 12 characters.');
    expect(doc.activeElement).toBe(el('password'));
  });

  it('puts a taken username and a wrong current password under their fields as sentences', async () => {
    const page = loadPage('public/users.html', { fetch: vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'username already exists' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 'current password is incorrect' }, { status: 400 })) });
    const { el } = page;
    const doc = documentOf(page);
    const wrap = (id: string) => { const node = doc.createElement('div'); doc.appendChild(node); node.appendChild(el(id)); return node; };
    const username = wrap('username');
    const current = wrap('curpw');
    el('username').value = 'anna';
    el('password').value = 'fixture-new-password';
    await el('addForm').fire('submit');
    expect(username.children[1]!.textContent).toBe('This username is already taken.');
    expect(el('username').getAttribute('aria-invalid')).toBe('true');
    expect(el('out').textContent).toBe('');
    expect(el('username').value).toBe('anna');
    el('curpw').value = 'fixture-wrong-password';
    el('newpw').value = 'fixture-new-password';
    await el('pwForm').fire('submit');
    expect(current.children[1]!.textContent).toBe('The current password is incorrect.');
    expect(el('pwout').textContent).toBe('');
    expect(el('pwout').textContent).not.toContain('current password is incorrect');
  });
});

describe('posts.html actions survive a dropped connection', () => {
  it('deletePost re-enables the row button and names the failure', async () => {
    const { ctx, el } = loadPosts();
    const btn = element();
    const deletePost = vm.runInContext('deletePost', ctx) as (p: unknown, btn: Element) => Promise<void>;
    await deletePost(post, btn);
    expect(btn.disabled).toBe(false);
    expect(el('out').textContent).toBe(ui.en['admin.build.unknown']);
  });

  it('unpublishPost re-enables the row button and names the failure', async () => {
    const { ctx, el } = loadPosts();
    const btn = element();
    const unpublishPost = vm.runInContext('unpublishPost', ctx) as (p: unknown, btn: Element) => Promise<void>;
    await unpublishPost(post, btn);
    expect(btn.disabled).toBe(false);
    expect(el('out').textContent).toBe(ui.en['admin.build.unknown']);
  });

  it('runBulk re-enables all three bulk buttons and names the failure', async () => {
    const { ctx, el } = loadPosts();
    vm.runInContext("selected.add('tk1'); allPosts = [" + JSON.stringify(post) + ']', ctx);
    const runBulk = vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>;
    await runBulk('delete');
    for (const id of ['bulkPublish', 'bulkUnpublish', 'bulkDelete']) expect(el(id).disabled).toBe(false);
    expect(el('out').textContent).toBe(ui.en['admin.build.unknown']);
    // The selection is only cleared once the server confirmed the batch.
    expect(vm.runInContext('selected.size', ctx)).toBe(1);
  });

  it('Export all re-enables its button and names the failure as a sentence', async () => {
    const { el } = loadPosts();
    await el('exportAll').click();
    expect(el('exportAll').disabled).toBe(false);
    expect(el('out').textContent).toBe('Could not export: the connection failed.');
  });

  it('load() reports a dropped connection instead of rejecting', async () => {
    const { ctx, el } = loadPosts();
    const load = vm.runInContext('load', ctx) as (statusMsg?: string) => Promise<void>;
    await expect(load()).resolves.toBeUndefined();
    expect(el('loadMsg').textContent).toBe(ui.en['editor.chrome.publicationStale']);
  });

  it('a failed refresh keeps the action outcome the caller already reported', async () => {
    // Unpublish succeeded but its rebuild failed (200 with build.ok=false), then
    // the list refresh dies: acknowledged CMS facts must remain visible.
    const { ctx, el } = loadPosts();
    const load = vm.runInContext('load', ctx) as (statusMsg?: string) => Promise<void>;
    await load('Unpublished "Bukarest". Rebuild failed: astro exited 1');
    expect(el('out').textContent).toBe('Unpublished "Bukarest". Rebuild failed: astro exited 1');
    expect(el('loadMsg').textContent).toBe(ui.en['editor.chrome.publicationStale']);
  });
});

describe('posts action build reporting', () => {
  it.each(['delete', 'unpublish'])('%s keeps the acknowledgement when its rebuild fails, without a release id', async (action) => {
    const { ctx, el } = loadPosts({
      fetch: async (_url: string, init?: RequestInit) => init?.method
        ? Response.json({ [action === 'delete' ? 'deleted' : 'unpublished']: true, build: { ok: false, code: 'no_space', error: 'SECRET', liveRelease: null } })
        : Response.json([]),
    });
    const fn = vm.runInContext(action === 'delete' ? 'deletePost' : 'unpublishPost', ctx) as (post: unknown, button: Element) => Promise<void>;
    await fn(post, element());
    expect(el('out').textContent).toContain(action === 'delete' ? 'Deleted “Bukarest”.' : 'Unpublished “Bukarest”.');
    expect(el('out').textContent).toContain('The live site was not updated because the rebuild failed');
    expect(el('out').textContent).toContain('Nothing is live yet.');
    expect(el('out').textContent).not.toContain('SECRET');
    expect(el('out').textContent).not.toMatch(/\d{13}-\d+-\d+|promoted|CMS/);
    expect(el('out').children.some((node) => node.href === '/admin/settings.html#site')).toBe(true);
  });

  it.each(['delete', 'unpublish'])('%s of a live story says what the live site now does, with the build moment and no release id', async (action) => {
    const release = '1793000000000-1-0001';
    const { ctx, el } = loadPosts({
      fetch: async (_url: string, init?: RequestInit) => init?.method
        ? Response.json({ [action === 'delete' ? 'deleted' : 'unpublished']: true, publication: action === 'delete' ? { availability: 'missing' } : publication('draft'),
          build: { ok: true, attemptId: release, release, liveRelease: release } })
        : Response.json([]),
    });
    const fn = vm.runInContext(action === 'delete' ? 'deletePost' : 'unpublishPost', ctx) as (post: unknown, button: Element) => Promise<void>;
    await fn(post, element());
    const outcome = el('out').textContent;
    expect(outcome).toMatch(action === 'delete'
      ? /^Deleted “Bukarest”\. The live site no longer shows it \(built \d{1,2} \w{3} 2026, \d{2}:\d{2}\)\.$/
      : /^Unpublished “Bukarest”\. The live site no longer shows it \(built \d{1,2} \w{3} 2026, \d{2}:\d{2}\)\.$/);
    expect(outcome).not.toContain(release);
  });

  it.each([true, false])('bulk keeps explicitly successful/failed counts with build success=%s', async (ok) => {
    const { ctx, el } = loadPosts({
      fetch: async (_url: string, init?: RequestInit) => init?.method
        ? Response.json({ succeeded: 1, failed: 1, results: [{ key: 'tk1', ok: true }, { key: 'tk2', ok: false, error: 'invalid_post' }],
          build: { ok, release: ok ? '1793000000000-1-0001' : undefined, code: 'build_stopped', error: 'SECRET' } })
        : Response.json([]),
    });
    vm.runInContext("selected.add('tk1'); selected.add('tk2'); allPosts = [" + JSON.stringify(post) + ']', ctx);
    const runBulk = vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>;
    await runBulk('publish');
    expect(el('out').textContent).toContain('Publish: 1 done, 1 failed.');
    expect(el('out').textContent).toContain('The live site’s current version could not be checked.');
    if (ok) expect(el('out').textContent).toContain('A new version of the site was built.');
    expect(el('out').textContent).not.toContain('1793000000000');
    expect(el('out').textContent).not.toContain('SECRET');
    if (!ok) expect(el('out').children.some((node) => node.textContent === ui.en['admin.build.stoppedRecovery'])).toBe(true);
  });

  it('draft deletion says no rebuild without guessing a live consequence', async () => {
    const { ctx, el } = loadPosts({
      fetch: async (_url: string, init?: RequestInit) => Response.json(init?.method ? { deleted: true } : []),
    });
    const remove = vm.runInContext('deletePost', ctx) as (post: unknown, button: Element) => Promise<void>;
    await remove({ ...post, status: 'draft' }, element());
    expect(el('out').textContent).toContain('Deleted draft');
    expect(el('out').textContent).toContain('The site was not rebuilt');
    expect(el('out').textContent).not.toContain('live');
  });
});

describe('posts.html selection, recovery and disclosures', () => {
  const filterStub = {
    apply: (posts: (typeof post)[], opts: Record<string, string>) =>
      opts.status ? posts.filter((item) => item.status === opts.status) : posts,
    REGIONS: [],
    countries: () => [],
    extraFilterCount: () => 0,
    fromSearch: () => ({ q: '', status: '', region: '', country: '', sort: 'updated', order: 'desc' }),
    languageStates: realPostsFilter().languageStates,
    thumbUrl: () => null,
    toSearch: () => '',
  };

  it('keeps cross-filter selections visible, reviews every title, and clears them explicitly', async () => {
    const { ctx, el } = loadPosts({ PostsFilter: filterStub });
    const posts = [
      { ...post, translationKey: 'draft', title: 'Draft story', status: 'draft' },
      { ...post, translationKey: 'live', title: 'Live story', status: 'published' },
    ];
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(posts)};
      selected.add('draft'); selected.add('live');`, ctx);
    el('fStatus').value = 'draft';
    (vm.runInContext('refreshBulkBar', ctx) as () => void)();

    expect(el('bulkCount').textContent).toBe('2 selected · 1 outside current view');
    expect(el('selectionList').children.map((item) => item.textContent)).toEqual(['Draft story', 'Live story']);
    await el('clearSelection').click();
    expect(vm.runInContext('selected.size', ctx)).toBe(0);
    expect(el('bulkBar').hidden).toBe(true);
  });

  // The floating bar (#566): selecting shows it and puts the table in selection
  // mode without taking focus; it is inert whenever hidden, so a fading bar can
  // never hold focus; the runway is reserved before anything is selected.
  async function selectablePage() {
    const page = loadPosts({ PostsFilter: filterStub });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rows = [{ ...post, translationKey: 'a', title: 'Alpha' }, { ...post, translationKey: 'b', title: 'Beta' }];
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(rows)}; render();`, page.ctx);
    const box = (index: number) => {
      const found = page.el('postsList').querySelectorAll('input')[index];
      if (!found) throw new Error('row checkbox ' + index + ' missing');
      return found;
    };
    return { ...page, box };
  }

  it('shows the bar and selection mode on the first tick without moving focus, and reverts both on Clear selection', async () => {
    const { ctx, el, box } = await selectablePage();
    const doc = documentOf({ ctx, el, windowListeners: {} });
    expect(el('bulkBarSlot').classList.contains('is-reserved')).toBe(true);
    expect(el('bulkBar').hidden).toBe(true);
    expect(el('postsTable').classList.contains('is-selecting')).toBe(false);

    const first = box(0);
    first.focus();
    first.checked = true;
    await first.fire('change');
    expect(el('bulkBar').hidden).toBe(false);
    expect((el('bulkBar') as Element & { inert?: boolean }).inert).toBe(false);
    expect(el('postsTable').classList.contains('is-selecting')).toBe(true);
    expect(el('bulkCount').textContent).toBe('1 selected · 0 outside current view');
    expect(doc.activeElement).toBe(first);

    let focusOptions: unknown;
    el('selectAll').focus = (options) => { focusOptions = options; };
    await el('clearSelection').click();
    expect(vm.runInContext('selected.size', ctx)).toBe(0);
    expect(el('bulkBar').hidden).toBe(true);
    expect((el('bulkBar') as Element & { inert?: boolean }).inert).toBe(true);
    expect(el('postsTable').classList.contains('is-selecting')).toBe(false);
    // Outside the shell no checkbox is "in view", so focus falls back to
    // select-all and is scrolled into view: visible focus outranks a still list.
    expect(focusOptions).toEqual({ preventScroll: false });
    expect(el('bulkBarSlot').classList.contains('is-reserved')).toBe(true);
  });

  it('Escape in the bar closes Review selection first, ignores a held key, then clears like Clear selection', async () => {
    const { ctx, el } = await selectablePage();
    vm.runInContext("selected.add('a'); selected.add('b'); render();", ctx);
    el('selectionReview').open = true;

    await el('bulkBar').fire('keydown', { key: 'Escape' });
    expect(el('selectionReview').open).toBe(false);
    expect(el('selectionReviewSummary').focused).toBe(true);
    expect(vm.runInContext('selected.size', ctx)).toBe(2);

    await el('bulkBar').fire('keydown', { key: 'Escape', repeat: true });
    await el('bulkBar').fire('keydown', { key: 'Escape', defaultPrevented: true });
    expect(vm.runInContext('selected.size', ctx)).toBe(2);

    await el('bulkBar').fire('keydown', { key: 'Escape' });
    expect(vm.runInContext('selected.size', ctx)).toBe(0);
    expect(el('bulkBar').hidden).toBe(true);
    expect(el('selectAll').focused).toBe(true);
  });

  it('a click on a checkbox label toggles the box once and focuses it without scrolling', async () => {
    const { ctx, el, box } = await selectablePage();
    const first = box(0);
    const label = first.parentElement;
    if (!label) throw new Error('row checkbox has no label');
    let focusOptions: unknown;
    first.focus = (options) => { focusOptions = options; };
    // The browser's own checkbox activation: toggle, then change.
    first.click = async () => { first.checked = !first.checked; await first.fire('change'); };
    let prevented = false;

    await el('postsTable').fire('click', { target: label, preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(focusOptions).toEqual({ preventScroll: true });
    expect(vm.runInContext('[...selected]', ctx)).toEqual(['a']);

    // A click on the box itself is the browser's to handle.
    prevented = false;
    await el('postsTable').fire('click', { target: first, preventDefault() { prevented = true; } });
    expect(prevented).toBe(false);
    expect(vm.runInContext('[...selected]', ctx)).toEqual(['a']);
  });

  it('sends the immutable key snapshot and names every confirmed story', async () => {
    let requestBody = '';
    let confirmBody = '';
    let mutateSelection = () => {};
    const { ctx } = loadPosts({
      AdminConfirm: {
        ask: async (opts: { body: string }) => {
          confirmBody = opts.body;
          mutateSelection();
          return true;
        },
      },
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === '/posts/bulk') {
          requestBody = init?.body ?? '';
          return { status: 200, ok: true, json: async () => ({ succeeded: 2, failed: 0, results: [] }) };
        }
        return { status: 200, ok: true, json: async () => [
          { ...post, translationKey: 'a', title: 'Alpha' },
          { ...post, translationKey: 'b', title: 'Beta' },
          { ...post, translationKey: 'c', title: 'Gamma' },
        ] };
      },
    });
    const posts = [
      { ...post, translationKey: 'a', title: 'Alpha' },
      { ...post, translationKey: 'b', title: 'Beta' },
      { ...post, translationKey: 'c', title: 'Gamma' },
    ];
    vm.runInContext(`allPosts = ${JSON.stringify(posts)}; selected.add('a'); selected.add('b');`, ctx);
    mutateSelection = () => vm.runInContext(`selected.clear(); selected.add('c');
      SiteLanguage.accept({primary:'en',locales:['en','de'],lockedAt:null,updatedAt:'2026-10-28T00:00:00.000Z'});`, ctx);

    await (vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>)('publish');

    expect(confirmBody).toContain('"Alpha"');
    expect(confirmBody).toContain('"Beta"');
    expect(JSON.parse(requestBody)).toEqual({ action: 'publish', keys: ['a', 'b'], baseLanguageUpdatedAt: '2026-10-27T00:00:00.000Z' });
    expect(vm.runInContext('[...selected]', ctx)).toEqual(['c']);
  });

  it('retains only failed stories after a partial bulk result so they can be retried', async () => {
    const posts = [
      { ...post, translationKey: 'a', title: 'Alpha' },
      { ...post, translationKey: 'b', title: 'Beta' },
    ];
    const { ctx, el } = loadPosts({
      fetch: async (url: string) => url === '/posts/bulk'
        ? {
            status: 200,
            ok: true,
            json: async () => ({
              succeeded: 1,
              failed: 1,
              results: [
                { key: 'a', ok: true },
                { key: 'b', ok: false, error: 'excerpt required' },
              ],
            }),
          }
        : { status: 200, ok: true, json: async () => posts },
    });
    // Let the page's unauthenticated bootstrap settle before installing this
    // test's authenticated state; otherwise its microtask resets `me` mid-batch.
    await new Promise<void>((resolve) => setImmediate(resolve));
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(posts)};
      selected.add('a'); selected.add('b');`, ctx);

    await (vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>)('publish');

    expect(vm.runInContext('[...selected]', ctx)).toEqual(['b']);
    expect(el('out').textContent).not.toMatch(/^Bulk .* failed:/);
    expect(el('bulkBar').hidden).toBe(false);
    expect(el('selectionList').children.map((item) => item.textContent)).toEqual(['Beta']);
  });

  it('reports actionable route failures without hiding unrelated bulk Publish errors', async () => {
    const rows = ['limit', 'timeout', 'media'].map((key) => ({ ...post, translationKey: key, title: key }));
    const { ctx, el } = loadPosts({
      fetch: async (url: string) => ({
        status: 200, ok: true, json: async () => url === '/posts/bulk' ? {
          succeeded: 0, failed: 3, results: [
            { key: 'limit', ok: false, code: 'track_public_limit', error: 'track_public_limit' },
            { key: 'timeout', ok: false, code: 'gpx_timeout', error: 'gpx_timeout' },
            { key: 'media', ok: false, code: 'photos_not_ready', error: 'Photos still processing' },
          ],
        } : rows,
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(rows)};
      selected.add('limit'); selected.add('timeout'); selected.add('media');`, ctx);
    await (vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>)('publish');
    expect(el('out').textContent).toContain('limit — ' + ui.en['gpx.publishRouteRecovery']);
    expect(el('out').textContent).toContain('timeout — ' + ui.en['gpx.timeout']);
    expect(el('out').textContent).toContain('media — Photos still processing');
    expect(el('out').textContent).not.toMatch(/track_public_limit|gpx_timeout/);
  });

  it('carries canonical filter params through Edit and New post', () => {
    const { ctx, el } = loadPosts({
      PostsFilter: {
        ...filterStub,
        toSearch: (opts: Record<string, string>) => {
          const params = new URLSearchParams();
          if (opts.q) params.set('q', opts.q);
          if (opts.status) params.set('status', opts.status);
          return params.toString();
        },
      },
    });
    el('fSearch').value = 'Rhodes & sun';
    el('fStatus').value = 'missing-secondary';
    const editorHref = vm.runInContext('editorHref', ctx) as (key?: string) => string;
    const href = new URL(editorHref('pair/key'), 'http://localhost');
    expect(href.searchParams.get('tk')).toBe('pair/key');
    expect(href.searchParams.get('returnTo')).toBe('/admin/posts.html?q=Rhodes+%26+sun&status=missing-secondary');
    (vm.runInContext('render', ctx) as (updateUrl?: boolean) => void)(true);
    const newHref = new URL(el('newPost').href, 'http://localhost');
    expect(newHref.searchParams.has('tk')).toBe(false);
    expect(newHref.searchParams.get('returnTo')).toBe('/admin/posts.html?q=Rhodes+%26+sun&status=missing-secondary');
  });

  it('disables retained stale actions on load failure and Retry preserves the selection', async () => {
    let offline = true;
    const { ctx, el } = loadPosts({
      fetch: async () => {
        if (offline) throw NETWORK_DOWN;
        return { status: 200, ok: true, json: async () => [] };
      },
    });
    vm.runInContext(`me = { isAdmin: true }; allPosts = [${JSON.stringify(post)}]; selected.add('tk1');`, ctx);
    el('postsTable').hidden = false;
    el('bulkBar').hidden = false;
    const load = vm.runInContext('load', ctx) as () => Promise<void>;
    await load();

    expect(el('postsTable').hidden).toBe(false);
    expect(el('bulkPublish').disabled).toBe(true);
    expect(el('bulkUnpublish').disabled).toBe(true);
    expect(el('bulkDelete').disabled).toBe(true);
    expect(el('retryLoad').hidden).toBe(false);
    expect(el('loadMsg').textContent).toBe(ui.en['editor.chrome.publicationStale']);
    expect(vm.runInContext('selected.size', ctx)).toBe(1);

    offline = false;
    await el('retryLoad').click();
    expect(el('retryLoad').hidden).toBe(true);
    expect(el('loadMsg').hidden).toBe(true);
    expect(el('postsTable').hidden).toBe(false);
  });

  it('keeps one native disclosure open and Escape closes it with focus restored', async () => {
    const { ctx } = loadPosts();
    const wire = vm.runInContext('wirePostDisclosure', ctx) as (details: Element, summary: Element) => void;
    const first = element();
    const firstSummary = element();
    const second = element();
    const secondSummary = element();
    wire(first, firstSummary);
    wire(second, secondSummary);

    first.open = true;
    await first.fire('toggle');
    second.open = true;
    await second.fire('toggle');
    expect(first.open).toBe(false);

    await second.fire('keydown', { key: 'Escape' });
    expect(second.open).toBe(false);
    expect(secondSummary.focused).toBe(true);
  });

  it('a click outside the open row menu closes it; a click inside it does not', async () => {
    const { ctx } = loadPosts();
    const wire = vm.runInContext('wirePostDisclosure', ctx) as (details: Element, summary: Element) => void;
    const doc = ctx.document as Element;
    const details = element();
    const summary = element();
    const action = element();
    details.append(summary, action);
    wire(details, summary);
    details.open = true;
    await details.fire('toggle');

    await doc.fire('click', { target: action });
    expect(details.open).toBe(true);

    await doc.fire('click', { target: element() });
    expect(details.open).toBe(false);
  });
});

describe('comments.html moderation view', () => {
  const comment = (id: string) => ({
    id, name: id, isAuthor: false, translationKey: 'tk1', locale: 'de',
    createdAt: '2026-09-29T04:56:50Z', status: 'pending', body: 'Hallo',
  });
  interface CommentResponse {
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
  }
  const response = (data: Record<string, unknown> = {}): CommentResponse => ({
    status: 200, ok: true, json: async () => 'comments' in data ? { hasMore: false, ...data } : data,
  });
  const listResponse = (rows: unknown[]): CommentResponse => ({ status: 200, ok: true, json: async () => rows });
  /** The posts list the page reads titles from; a comment whose key is missing names a deleted story. */
  const stories = [{ translationKey: 'tk1', title: 'Bukarest in 4 Tagen' }, { translationKey: 'tk2', title: 'Second story' }];
  function commentsPage(fetch: (url: string, options: { method: string; body?: string }) => Promise<unknown>, posts: unknown[] | (() => Promise<unknown>) = stories) {
    const page = loadPage('public/comments.html', {
      fetch: (url: string, options: { method: string; body?: string }) => url === '/posts'
        ? (typeof posts === 'function' ? posts() : Promise.resolve(listResponse(posts)))
        : fetch(url, options),
    });
    const doc = documentOf(page);
    doc.body = element();
    doc.activeElement = doc.body;
    doc.createElement = (tag = 'div') => {
      const node = Object.assign(element(), {
        tagName: tag.toUpperCase(), selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
        setSelectionRange(start: number, end: number, direction: string) {
          this.selectionStart = start;
          this.selectionEnd = end;
          this.selectionDirection = direction;
        },
      });
      node.focus = () => { if (!node.disabled) doc.activeElement = node; };
      return node;
    };
    page.el('statusFilter').focus = () => { doc.activeElement = page.el('statusFilter'); };
    for (const id of ['previousPage', 'nextPage', 'pageIndicator']) {
      page.el(id).focus = () => { if (!page.el(id).disabled) doc.activeElement = page.el(id); };
    }
    page.el('statusFilter').value = 'pending';
    const list = page.el('list');
    list.replaceChildren = () => {
      if (list.contains(doc.activeElement)) doc.activeElement = doc.body;
      for (const child of list.children) child.parentElement = null;
      list.children.length = 0;
    };
    const load = vm.runInContext('load', page.ctx) as () => Promise<void>;
    const row = (id: string) => {
      const node = page.el('list').children.find((child) => child.children[0]?.children[0]?.textContent === id);
      if (!node) throw new Error('Missing comment ' + id);
      const form = node.children.find((child) => child.className === 'comment-reply');
      if (!form) throw new Error('Missing reply form ' + id);
      const ta = form.children.find((child) => child.tagName === 'TEXTAREA') as Element & {
        selectionStart: number; selectionEnd: number; selectionDirection: string;
        setSelectionRange(start: number, end: number, direction: string): void;
      };
      const send = form.children.find((child) => child.tagName === 'BUTTON');
      const actions = node.children.find((child) => child.className === 'comment-actions');
      if (!ta || !send || !actions) throw new Error('Missing comment controls ' + id);
      const meta = node.children[0]!.children.map((part) => part.textContent).join('');
      return { node, form, ta, send, meta, action: (label: string) => actions.children.find((child) => child.textContent === label)! };
    };
    const type = async (id: string, text: string) => {
      const { ta } = row(id);
      ta.value = text;
      await ta.fire('input');
      return ta;
    };
    return { ...page, doc, load, row, type };
  }

  it('keeps A’s latest draft and selection while approving B, then clears actions during refresh', async () => {
    const refresh = Promise.withResolvers<CommentResponse>();
    const loading = Promise.withResolvers<void>();
    const mutation = Promise.withResolvers<CommentResponse>();
    let reads = 0;
    const fetch = vi.fn(async (_url: string, options: { method: string }) => {
      if (options.method === 'GET') {
        if (++reads === 2) { loading.resolve(); return refresh.promise; }
        return response({ comments: [comment('A'), comment('B')] });
      }
      return mutation.promise;
    });
    const page = commentsPage(fetch);
    await page.load();
    await page.type('A', 'Thanks Anna,');
    const approve = page.row('B').action('Approve');
    approve.focus();
    const pending = approve.click();
    const ta = await page.type('A', 'Thanks Anna, the hike was');
    ta.focus();
    ta.setSelectionRange(7, 11, 'backward');
    mutation.resolve(response());
    await loading.promise;
    expect(page.el('list').children).toHaveLength(0);
    expect(page.el('list').getAttribute('aria-busy')).toBe('true');
    refresh.resolve(response({ comments: [comment('A')] }));
    await pending;
    expect(fetch).toHaveBeenCalledWith('/moderation/comments/B/status', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ status: 'approved' }),
    }));
    expect(page.row('A').ta.value).toBe('Thanks Anna, the hike was');
    expect(page.doc.activeElement).toBe(page.row('A').ta);
    expect(page.row('A').ta.selectionStart).toBe(7);
    expect(page.row('A').ta.selectionEnd).toBe(11);
    expect(page.row('A').ta.selectionDirection).toBe('backward');
  });

  it('keeps hidden drafts across views and does not steal focus from the filter', async () => {
    const page = commentsPage(async (url) => response({
      comments: new URL(url, 'http://localhost').searchParams.get('status') === 'approved' ? [] : [comment('A')],
    }));
    await page.load();
    await page.type('A', 'Unsent reply');
    page.el('statusFilter').value = 'approved';
    page.el('statusFilter').focus();
    await page.load();
    expect(page.el('list').children).toHaveLength(0);
    page.el('statusFilter').value = 'pending';
    await page.load();
    expect(page.row('A').ta.value).toBe('Unsent reply');
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
  });

  it('sends B unchanged, clears only its successful reply, and never restores it on reload', async () => {
    const fetch = vi.fn(async (_url: string, options: { method: string }) =>
      response(options.method === 'GET' ? { comments: [comment('A'), comment('B')] } : {}));
    const page = commentsPage(fetch);
    await page.load();
    await page.type('A', 'Still writing');
    await page.type('B', ' Ready to publish ');
    page.row('B').send.focus();
    await page.row('B').form.fire('submit');
    expect(fetch).toHaveBeenCalledWith('/moderation/comments/B/reply', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ body: ' Ready to publish ' }),
    }));
    expect(page.row('B').ta.value).toBe('');
    expect(page.doc.activeElement).toBe(page.row('B').send);
    await page.load();
    expect(page.row('B').ta.value).toBe('');
    expect(page.row('A').ta.value).toBe('Still writing');
  });

  it('retains failed replies and re-enables submit', async () => {
    const page = commentsPage(async (_url, options) => {
      if (options.method === 'POST') throw NETWORK_DOWN;
      return response({ comments: [comment('A')] });
    });
    await page.load();
    await page.type('A', 'Please keep this');
    await page.row('A').form.fire('submit');
    expect(page.row('A').send.disabled).toBe(false);
    await page.load();
    expect(page.row('A').ta.value).toBe('Please keep this');
  });

  it('retains edits made during a successful reply request, even across an intervening reload', async () => {
    const sent = Promise.withResolvers<CommentResponse>();
    const page = commentsPage(async (_url, options) => options.method === 'POST'
      ? sent.promise : response({ comments: [comment('A')] }));
    await page.load();
    await page.type('A', 'First reply');
    const pending = page.row('A').form.fire('submit');
    await page.load();
    const ta = await page.type('A', 'Second reply in progress');
    ta.focus();
    ta.setSelectionRange(5, 5, 'none');
    sent.resolve(response());
    await pending;
    expect(page.row('A').ta.value).toBe('Second reply in progress');
    expect(page.doc.activeElement).toBe(page.row('A').ta);
    expect(page.row('A').ta.selectionStart).toBe(5);
  });

  it.each(['success', 'failure'] as const)('keeps recreated replies single-flight and releases the visible control after %s', async (outcome) => {
    const sent = Promise.withResolvers<CommentResponse>();
    const posted: string[] = [];
    const page = commentsPage(async (url, options) => {
      if (url.endsWith('/reply')) {
        posted.push(String(options.body));
        return posted.length === 1 ? sent.promise : response();
      }
      return response({ comments: new URL(url, 'http://localhost').searchParams.get('status') === 'approved' ? [] : [comment('A'), comment('B')] });
    });
    await page.load();
    await page.type('A', 'Publish only once');
    page.row('A').send.focus();
    const pending = page.row('A').form.fire('submit');
    page.doc.activeElement = page.doc.body;
    await page.row('B').action('Approve').click();
    expect(page.row('A').send.disabled).toBe(true);
    page.el('statusFilter').value = 'approved';
    await page.load();
    page.el('statusFilter').value = 'pending';
    await page.load();
    expect(page.row('A').ta.value).toBe('Publish only once');
    expect(page.row('A').send.disabled).toBe(true);
    await page.row('A').form.fire('submit');
    expect(posted).toHaveLength(1);
    await page.type('A', 'Newer unsent text');
    if (outcome === 'success') sent.resolve(response());
    else sent.reject(NETWORK_DOWN);
    await pending;
    expect(page.row('A').send.disabled).toBe(false);
    expect(page.row('A').ta.value).toBe('Newer unsent text');
    await page.row('A').form.fire('submit');
    const bodies: unknown[] = posted.map((body) => JSON.parse(body));
    expect(bodies).toEqual([{ body: 'Publish only once' }, { body: 'Newer unsent text' }]);
    expect(page.row('A').ta.value).toBe('');
  });

  it('does not resurrect a sent draft when the follow-up list request fails', async () => {
    let reads = 0;
    const page = commentsPage(async (_url, options) => {
      if (options.method === 'GET' && ++reads === 2) throw NETWORK_DOWN;
      return response({ comments: [comment('A')] });
    });
    await page.load();
    await page.type('A', 'Published once');
    await page.row('A').form.fire('submit');
    expect(page.el('out').textContent).toContain('Could not load comments: Failed to fetch');
    expect(page.el('list').children).toHaveLength(0);
    await page.load();
    expect(page.row('A').ta.value).toBe('');
  });

  it('does not clear a reply when the request redirects an expired session to login', async () => {
    const page = commentsPage(async (_url, options) => options.method === 'POST'
      ? { ...response(), status: 401, ok: false }
      : response({ comments: [comment('A')] }));
    await page.load();
    await page.type('A', 'Not published');
    await page.row('A').form.fire('submit');
    expect(page.ctx.location).toEqual(expect.objectContaining({ href: '/login' }));
    expect(page.row('A').ta.value).toBe('Not published');
    expect(page.el('out').textContent).not.toBe('Reply published.');
  });

  it.each(['Delete', 'Spam'])('clears only the successfully %s-deleted draft', async (action) => {
    const page = commentsPage(async () => response({ comments: [comment('A'), comment('B')] }));
    await page.load();
    await page.type('A', 'Keep A');
    await page.type('B', 'Remove B');
    await page.row('B').action(action).click();
    // Return B again to prove its draft was removed, not merely hidden.
    expect(page.row('A').ta.value).toBe('Keep A');
    expect(page.row('B').ta.value).toBe('');
  });

  it.each(['cancelled', 'failed'])('keeps the draft after a %s deletion', async (outcome) => {
    const page = commentsPage(async (_url, options) => {
      if (options.method === 'DELETE') throw NETWORK_DOWN;
      return response({ comments: [comment('A')] });
    });
    if (outcome === 'cancelled') page.ctx.AdminConfirm = { ask: async () => false };
    await page.load();
    await page.type('A', 'Keep A');
    await page.row('A').action('Delete').click();
    if (outcome === 'failed') expect(page.el('out').textContent).toBe('Could not delete the comment: Failed to fetch.');
    await page.load();
    expect(page.row('A').ta.value).toBe('Keep A');
  });

  it('moves focus to the view filter when the focused action’s row disappears', async () => {
    let removed = false;
    const page = commentsPage(async (_url, options) => {
      if (options.method === 'POST') removed = true;
      return response({ comments: removed ? [] : [comment('A')] });
    });
    await page.load();
    const approve = page.row('A').action('Approve');
    approve.focus();
    await approve.click();
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
  });

  it('clears obsolete rows and actions immediately and retains drafts after a failed filter refresh', async () => {
    const failed = Promise.withResolvers<CommentResponse>();
    const page = commentsPage(async (url) => new URL(url, 'http://localhost').searchParams.get('status') === 'approved'
      ? failed.promise : response({ comments: [comment('A')] }));
    await page.load();
    await page.type('A', 'Unsent through failure');
    page.el('statusFilter').focus();
    page.el('statusFilter').value = 'approved';
    const refresh = page.el('statusFilter').fire('change');
    expect(page.el('list').children).toHaveLength(0);
    expect(page.el('out').textContent).toBe('Loading approved comments…');
    expect(page.el('list').getAttribute('aria-busy')).toBe('true');
    failed.reject(NETWORK_DOWN);
    await refresh;
    expect(page.el('list').children).toHaveLength(0);
    expect(page.el('out').textContent).toBe('Could not load comments: Failed to fetch.');
    expect(page.el('list').getAttribute('aria-busy')).toBe('false');
    page.el('statusFilter').value = 'pending';
    await page.load();
    expect(page.row('A').ta.value).toBe('Unsent through failure');
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
  });

  it.each(['success', 'failure'] as const)('ignores an obsolete list %s after the newest view has rendered', async (outcome) => {
    const old = Promise.withResolvers<CommentResponse>();
    const newest = Promise.withResolvers<CommentResponse>();
    let reads = 0;
    const page = commentsPage(async () => ++reads === 1 ? old.promise : newest.promise);
    const previous = page.load();
    page.el('statusFilter').value = 'approved';
    page.el('statusFilter').focus();
    const current = page.load();
    newest.resolve(response({ comments: [{ ...comment('Newest'), status: 'approved' }] }));
    await current;
    if (outcome === 'success') old.resolve(response({ comments: [comment('Obsolete')] }));
    else old.reject(NETWORK_DOWN);
    await previous;
    expect(page.el('list').children).toHaveLength(1);
    expect(page.row('Newest').action('Unapprove')).toBeDefined();
    expect(page.el('out').textContent).toBe('');
    expect(page.el('list').getAttribute('aria-busy')).toBe('false');
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
  });

  it('keeps the newest loading state when an obsolete request fails first', async () => {
    const old = Promise.withResolvers<CommentResponse>();
    const newest = Promise.withResolvers<CommentResponse>();
    let reads = 0;
    const page = commentsPage(async () => ++reads === 1 ? old.promise : newest.promise);
    const previous = page.load();
    page.el('statusFilter').value = 'approved';
    const current = page.load();
    old.reject(NETWORK_DOWN);
    await previous;
    expect(page.el('out').textContent).toBe('Loading approved comments…');
    expect(page.el('list').getAttribute('aria-busy')).toBe('true');
    newest.resolve(response({ comments: [] }));
    await current;
    expect(page.el('out').textContent).toBe('No approved comments.');
    expect(page.el('list').getAttribute('aria-busy')).toBe('false');
  });

  it.each(['approve', 'reply'] as const)('does not let a late %s completion replace the newer filter view or status', async (action) => {
    const mutation = Promise.withResolvers<CommentResponse>();
    const fetch = vi.fn(async (url: string, options: { method: string }) => options.method === 'POST'
      ? mutation.promise : response({ comments: new URL(url, 'http://localhost').searchParams.get('status') === 'approved' ? [] : [comment('A')] }));
    const page = commentsPage(fetch);
    await page.load();
    await page.type('A', 'Sent reply');
    const pending = action === 'reply' ? page.row('A').form.fire('submit') : page.row('A').action('Approve').click();
    page.el('statusFilter').value = 'approved';
    page.el('statusFilter').focus();
    await page.load();
    mutation.resolve(response());
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(page.el('list').children).toHaveLength(0);
    expect(page.el('out').textContent).toBe('No approved comments.');
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
    page.el('statusFilter').value = 'pending';
    await page.load();
    expect(page.row('A').ta.value).toBe(action === 'reply' ? '' : 'Sent reply');
  });

  it.each(['approve', 'delete', 'reply'] as const)('refreshes both concurrent %s completions in the same filter', async (action) => {
    const mutations = { A: Promise.withResolvers<CommentResponse>(), B: Promise.withResolvers<CommentResponse>() };
    let stored = [comment('A'), comment('B')];
    if (action === 'reply') stored = stored.map((c) => ({ ...c, status: 'approved' }));
    const page = commentsPage(async (url, options) => {
      if (options.method === 'GET') return response({ comments: [...stored] });
      const id = url.includes('/A') ? 'A' : 'B';
      await mutations[id].promise;
      if (action === 'reply') stored.push({ ...comment('Reply-' + id), status: 'approved', isAuthor: true });
      else stored = stored.filter((c) => c.id !== id);
      return response();
    });
    if (action === 'reply') page.el('statusFilter').value = 'approved';
    await page.load();
    await page.type('A', 'Reply to A');
    await page.type('B', 'Reply to B');
    const start = (id: string) => action === 'reply'
      ? page.row(id).form.fire('submit')
      : page.row(id).action(action === 'approve' ? 'Approve' : 'Delete').click();
    const first = start('A');
    const second = start('B');
    mutations.A.resolve(response());
    await first;
    expect(page.row('B')).toBeDefined();
    mutations.B.resolve(response());
    await second;
    const names = page.el('list').children.map((row) => row.children[0]?.children[0]?.textContent);
    expect(names).toEqual(action === 'reply' ? ['A', 'B', 'Reply-A', 'Reply-B'] : []);
  });

  it.each([
    ['approve', 'reply'], ['approve', 'filter'], ['approve', 'filter-then-body'],
    ['reply', 'reply'], ['reply', 'filter'], ['reply', 'filter-then-body'],
  ] as const)('preserves the latest focus across overlapping %s refreshes unless navigation supersedes it: %s', async (action, destination) => {
    const mutations = { A: Promise.withResolvers<CommentResponse>(), B: Promise.withResolvers<CommentResponse>() };
    const firstRefresh = Promise.withResolvers<CommentResponse>();
    const refreshStarted = Promise.withResolvers<void>();
    let stored = [comment('A'), comment('B'), comment('C')];
    let reads = 0;
    const page = commentsPage(async (url, options) => {
      if (options.method === 'GET') {
        if (++reads === 2) { refreshStarted.resolve(); return firstRefresh.promise; }
        return response({ comments: [...stored] });
      }
      const id = url.includes('/A') ? 'A' : 'B';
      await mutations[id].promise;
      if (action === 'approve') stored = stored.filter((c) => c.id !== id);
      return response();
    });
    await page.load();
    await page.type('A', 'Reply to A');
    await page.type('B', 'Reply to B');
    const start = (id: string) => {
      const row = page.row(id);
      (action === 'reply' ? row.send : row.action('Approve')).focus();
      return action === 'reply' ? row.form.fire('submit') : row.action('Approve').click();
    };
    const first = start('A');
    const second = start('B');
    const draft = await page.type('C', 'Keep this unsent reply');
    draft.focus();
    draft.setSelectionRange(5, 9, 'backward');
    mutations.A.resolve(response());
    await refreshStarted.promise;
    expect(page.doc.activeElement).toBe(page.doc.body);
    if (destination !== 'reply') {
      page.el('statusFilter').focus();
      await page.doc.fire('focusin');
      if (destination === 'filter-then-body') page.doc.activeElement = page.doc.body;
    }
    mutations.B.resolve(response());
    await second;
    firstRefresh.resolve(response({ comments: [comment('B'), comment('C')] }));
    await first;
    expect(page.row('C').ta.value).toBe('Keep this unsent reply');
    expect(page.el('list').children.map((row) => row.children[0]?.children[0]?.textContent))
      .toEqual(action === 'reply' ? ['A', 'B', 'C'] : ['C']);
    if (destination === 'reply') {
      expect(page.doc.activeElement).toBe(page.row('C').ta);
      expect([page.row('C').ta.selectionStart, page.row('C').ta.selectionEnd, page.row('C').ta.selectionDirection]).toEqual([5, 9, 'backward']);
    } else {
      expect(page.doc.activeElement).toBe(destination === 'filter' ? page.el('statusFilter') : page.doc.body);
    }
  });

  it('keeps a newer same-comment reply locked when an older refresh finishes', async () => {
    const oldRefresh = Promise.withResolvers<CommentResponse>();
    const oldRefreshStarted = Promise.withResolvers<void>();
    const newReply = Promise.withResolvers<CommentResponse>();
    const newReplyStarted = Promise.withResolvers<void>();
    const bodies: string[] = [];
    let reads = 0;
    const page = commentsPage(async (url, options) => {
      if (options.method === 'GET') {
        if (++reads === 2) { oldRefreshStarted.resolve(); return oldRefresh.promise; }
        return response({ comments: url.endsWith('approved') ? [] : [comment('A')] });
      }
      bodies.push(JSON.parse(options.body!).body);
      if (bodies.length === 2) { newReplyStarted.resolve(); return newReply.promise; }
      return response();
    });
    await page.load();
    await page.type('A', 'First reply');
    const first = page.row('A').form.fire('submit');
    await oldRefreshStarted.promise;
    page.el('statusFilter').value = 'approved';
    await page.load();
    page.el('statusFilter').value = 'pending';
    await page.load();
    await page.type('A', 'Second reply');
    const second = page.row('A').form.fire('submit');
    await newReplyStarted.promise;
    oldRefresh.resolve(response({ comments: [comment('A')] }));
    await first;
    expect(page.row('A').send.disabled).toBe(true);
    await page.row('A').form.fire('submit');
    expect(bodies).toEqual(['First reply', 'Second reply']);
    newReply.resolve(response());
    await second;
    expect(page.row('A').send.disabled).toBe(false);
    expect(page.row('A').ta.value).toBe('');
  });

  it.each(['approve', 'reply'] as const)('suppresses a late %s failure while the newer filter is loading', async (action) => {
    const mutation = Promise.withResolvers<CommentResponse>();
    const refresh = Promise.withResolvers<CommentResponse>();
    const page = commentsPage(async (url, options) => options.method === 'POST'
      ? mutation.promise : new URL(url, 'http://localhost').searchParams.get('status') === 'approved' ? refresh.promise : response({ comments: [comment('A')] }));
    await page.load();
    await page.type('A', 'Unsent after failure');
    const pending = action === 'reply' ? page.row('A').form.fire('submit') : page.row('A').action('Approve').click();
    page.el('statusFilter').value = 'approved';
    const current = page.load();
    mutation.reject(NETWORK_DOWN);
    await pending;
    expect(page.el('out').textContent).toBe('Loading approved comments…');
    expect(page.el('list').getAttribute('aria-busy')).toBe('true');
    refresh.resolve(response({ comments: [] }));
    await current;
    page.el('statusFilter').value = 'pending';
    await page.load();
    expect(page.row('A').ta.value).toBe('Unsent after failure');
    expect(page.row('A').send.disabled).toBe(false);
  });

  it('switching the view clears the previous view\'s empty-state message', async () => {
    const approved = {
      id: 'c1', name: 'Reader', isAuthor: false, translationKey: 'tk1', locale: 'de',
      createdAt: '2026-09-29T04:56:50Z', status: 'approved', body: 'Hallo',
    };
    const { el } = commentsPage(async () => response({ comments: [approved] }));
    el('out').textContent = 'No pending comments.';
    el('statusFilter').value = 'approved';
    await el('statusFilter').fire('change');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(el('list').children).toHaveLength(1);
    expect(el('out').textContent).toBe('');
  });

  it.each(['de', 'en'])('keeps %s discussion visible to moderators and explains why it is not public', (locale) => {
    const { ctx } = loadPage('public/comments.html', {});
    const row = vm.runInContext('row', ctx) as (comment: unknown) => Element;
    const rendered = row({ id: 'c1', name: '<reader>', translationKey: 'tk1', locale, createdAt: '2026-10-27T00:00:00Z', status: 'approved', body: 'Retained discussion', publicLocale: false });
    expect(rendered.children.some((child) => child.textContent.includes('not published for this story'))).toBe(true);
    expect(rendered.children.some((child) => child.textContent === 'Retained discussion')).toBe(true);
    expect(rendered.children.find((child) => child.textContent.includes('not published for this story'))!.textContent)
      .toContain(locale === 'de' ? 'German' : 'English');
  });

  it('traverses beyond 500 approved rows in both directions, preserving drafts and navigation focus', async () => {
    const stored = Array.from({ length: 551 }, (_, i) => ({ ...comment(String(i)), status: 'approved' }));
    const page = commentsPage(async (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return response({ comments: stored.slice(offset, offset + 50), hasMore: offset + 50 < stored.length });
    });
    page.el('statusFilter').value = 'approved';
    await page.load();
    expect(page.row('0').action('Unapprove')).toBeDefined();
    expect(page.el('previousPage').disabled).toBe(true);
    await page.type('0', 'Keep this across all pages');
    for (let n = 2; n <= 12; n++) {
      await page.el('nextPage').click();
      expect(page.el('pageIndicator').textContent).toBe(`Page ${n}`);
      expect(page.doc.activeElement).toBe(page.el('pageIndicator'));
      expect(page.el('list').children.length).toBeLessThanOrEqual(50);
    }
    expect(page.row('550').action('Delete')).toBeDefined();
    expect(page.el('nextPage').disabled).toBe(true);
    for (let n = 11; n >= 1; n--) await page.el('previousPage').click();
    expect(page.row('0').ta.value).toBe('Keep this across all pages');
    expect(page.el('pageIndicator').textContent).toBe('Page 1');
    expect(page.el('previousPage').disabled).toBe(true);
  });

  it.each(['Approve', 'Unapprove', 'Delete', 'Spam', 'Reply'])('resets to page one after %s without skipping a shifted boundary row', async (action) => {
    const status = action === 'Unapprove' ? 'approved' : 'pending';
    let stored = Array.from({ length: 101 }, (_, i) => ({ ...comment(String(i)), status }));
    const requests: number[] = [];
    const page = commentsPage(async (url, options) => {
      if (options.method !== 'GET') {
        if (action !== 'Reply') stored = stored.filter((c) => c.id !== '50');
        return response();
      }
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      requests.push(offset);
      return response({ comments: stored.slice(offset, offset + 50), hasMore: offset + 50 < stored.length });
    });
    page.el('statusFilter').value = status;
    await page.load();
    await page.type('0', 'Still writing on page one');
    await page.el('nextPage').click();
    if (action === 'Reply') {
      await page.type('50', 'Publish this reply');
      await page.row('50').form.fire('submit');
    } else await page.row('50').action(action).click();
    expect(requests).toEqual([0, 50, 0]);
    expect(page.row('0').ta.value).toBe('Still writing on page one');
    expect(page.el('pageIndicator').textContent).toBe('Page 1');
    await page.el('nextPage').click();
    expect(page.row(action === 'Reply' ? '50' : '51')).toBeDefined();
    if (action === 'Reply') expect(page.row('50').ta.value).toBe('');
  });

  it.each(['Delete', 'Spam'])('a cancelled %s leaves the current page and drafts untouched without a request', async (action) => {
    const fetch = vi.fn(async (url: string) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return response({ comments: [comment(offset ? 'B' : 'A')], hasMore: !offset });
    });
    const page = commentsPage(fetch);
    page.ctx.AdminConfirm = { ask: async () => false };
    await page.load();
    await page.el('nextPage').click();
    await page.type('B', 'Keep this');
    await page.row('B').action(action).click();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(page.row('B').ta.value).toBe('Keep this');
    expect(page.el('pageIndicator').textContent).toBe('Page 2');
  });

  it('keeps Previous usable when another moderator empties the last page and resets on filter change', async () => {
    const fetch = vi.fn(async (url: string) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return response({ comments: offset ? [] : [comment('A')], hasMore: !offset });
    });
    const page = commentsPage(fetch);
    await page.load();
    await page.el('nextPage').click();
    expect(page.el('out').textContent).toBe(EDITOR_COPY.commentsEmptyPage);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.el('previousPage').disabled).toBe(false);
    await page.el('previousPage').click();
    expect(page.row('A')).toBeDefined();
    await page.el('nextPage').click();
    page.el('statusFilter').value = 'approved';
    await page.el('statusFilter').fire('change');
    expect(fetch).toHaveBeenLastCalledWith('/moderation/comments?status=approved&offset=0', expect.objectContaining({ method: 'GET' }));
    expect(page.el('pageIndicator').textContent).toBe('Page 1');
  });

  it('disables stale navigation and actions during a failed page request; reselecting the filter recovers', async () => {
    const pending = Promise.withResolvers<CommentResponse>();
    const page = commentsPage(async (url) => url.includes('offset=50')
      ? pending.promise : response({ comments: [comment('A')], hasMore: true }));
    await page.load();
    await page.type('A', 'Survives a failed page');
    const next = page.el('nextPage').click();
    expect(page.el('previousPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.el('list').children).toHaveLength(0);
    pending.resolve({ status: 400, ok: false, json: async () => ({ error: 'invalid pagination' }) });
    await next;
    expect(page.el('out').textContent).toBe(EDITOR_COPY.commentsPaginationError);
    expect(page.el('previousPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    await page.el('statusFilter').fire('change');
    expect(page.row('A').ta.value).toBe('Survives a failed page');
    expect(page.el('nextPage').disabled).toBe(false);
  });

  it.each(['success', 'failure'])('ignores an obsolete offset response (%s) after returning to the same status at page one', async (outcome) => {
    const old = Promise.withResolvers<CommentResponse>();
    const page = commentsPage(async (url) => url.includes('offset=50')
      ? old.promise : response({ comments: [comment('A')], hasMore: true }));
    await page.load();
    const next = page.el('nextPage').click();
    await page.el('statusFilter').fire('change');
    if (outcome === 'success') old.resolve(response({ comments: [comment('Obsolete')], hasMore: false }));
    else old.reject(NETWORK_DOWN);
    await next;
    expect(page.row('A')).toBeDefined();
    expect(page.el('pageIndicator').textContent).toBe('Page 1');
    expect(page.el('nextPage').disabled).toBe(false);
    expect(page.el('previousPage').disabled).toBe(true);
    expect(page.el('out').textContent).toBe('');
  });

  it.each(['Approve', 'Reply'])('a late %s completion cannot reset a newly selected page', async (action) => {
    const mutation = Promise.withResolvers<CommentResponse>();
    const fetch = vi.fn(async (url: string, options: { method: string }) => {
      if (options.method !== 'GET') return mutation.promise;
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return response({ comments: [comment(offset ? 'B' : 'A')], hasMore: !offset });
    });
    const page = commentsPage(fetch);
    await page.load();
    await page.type('A', 'My reply');
    const saving = action === 'Reply' ? page.row('A').form.fire('submit') : page.row('A').action('Approve').click();
    await page.el('nextPage').click();
    mutation.resolve(response());
    await saving;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(page.row('B')).toBeDefined();
    expect(page.el('pageIndicator').textContent).toBe('Page 2');
  });

  it('uses the localized immediate-public-read deletion warning with the target reader name', async () => {
    const ask = vi.fn(async () => false);
    const page = commentsPage(async () => response({ comments: [{ ...comment('Reader <name>'), status: 'approved' }] }));
    page.ctx.AdminConfirm = { ask };
    await page.load();
    await page.row('Reader <name>').action('Delete').click();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      body: EDITOR_COPY.commentsDeleteApprovedBody!.replace('{name}', 'Reader <name>'),
      danger: true,
    }));
  });

  it('refreshes each concurrent page-two mutation even after the first resets pagination', async () => {
    const mutations = { '50': Promise.withResolvers<CommentResponse>(), '51': Promise.withResolvers<CommentResponse>() };
    let stored = Array.from({ length: 52 }, (_, i) => comment(String(i)));
    const offsets: number[] = [];
    const page = commentsPage(async (url, options) => {
      if (options.method !== 'GET') {
        const id = url.includes('/50/') ? '50' : '51';
        await mutations[id].promise;
        stored = stored.filter((c) => c.id !== id);
        return response();
      }
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      offsets.push(offset);
      return response({ comments: stored.slice(offset, offset + 50), hasMore: offset + 50 < stored.length });
    });
    await page.load();
    await page.el('nextPage').click();
    const first = page.row('50').action('Approve').click();
    const second = page.row('51').action('Approve').click();
    mutations['50'].resolve(response());
    await first;
    expect(page.el('pageIndicator').textContent).toBe('Page 1');
    expect(page.el('nextPage').disabled).toBe(false);
    mutations['51'].resolve(response());
    await second;
    expect(offsets).toEqual([0, 50, 0, 0]);
    expect(page.el('nextPage').disabled).toBe(true);
  });

  it('names the story, locale and moment of each comment instead of its key', async () => {
    const page = commentsPage(async () => response({ comments: [
      comment('A'), { ...comment('B'), translationKey: 'tk2', locale: 'en', createdAt: '2026-10-01T15:20:00Z' },
      { ...comment('C'), translationKey: '0f3a7a2c-1b3e-4f0a-9c1d-2e8b6a7d5c44' },
    ] }));
    await page.load();
    const format = vm.runInContext('AdminFormat', page.ctx) as { dateTime(value: string): string };
    expect(page.row('A').meta).toBe('A · Bukarest in 4 Tagen · DE · ' + format.dateTime('2026-09-29T04:56:50Z'));
    expect(page.row('B').meta).toBe('B · Second story · EN · ' + format.dateTime('2026-10-01T15:20:00Z'));
    // A story that no longer exists is named as such; the key itself is never shown.
    expect(page.row('C').meta).toBe('C · Deleted story · DE · ' + format.dateTime('2026-09-29T04:56:50Z'));
    for (const id of ['A', 'B', 'C']) {
      expect(page.row(id).meta).not.toMatch(/tk\d|0f3a7a2c/);
      expect(page.row(id).meta).not.toContain('2026-');
    }
  });

  it('keeps the queue usable and the keys hidden when the posts list cannot be read', async () => {
    const page = commentsPage(async () => response({ comments: [comment('A')] }), () => Promise.reject(NETWORK_DOWN));
    await page.load();
    expect(page.row('A').meta).not.toContain('tk1');
    expect(page.row('A').meta).not.toContain('Deleted story');
    expect(page.row('A').action('Approve')).toBeDefined();
  });

  it.each([
    ['Approve', 'pending', 'Comment approved.'],
    ['Unapprove', 'approved', 'Comment moved back to pending.'],
    ['Spam', 'pending', 'Comment deleted as spam.'],
    ['Delete', 'pending', 'Comment deleted.'],
  ] as const)('says what %s did and hands focus to the next comment’s first action', async (label, status, outcome) => {
    let stored = ['A', 'B', 'C'].map((id) => ({ ...comment(id), status }));
    const page = commentsPage(async (url, options) => {
      if (options.method !== 'GET') { stored = stored.filter((c) => c.id !== 'B'); return response(); }
      return response({ comments: [...stored] });
    });
    page.el('statusFilter').value = status;
    await page.load();
    const action = page.row('B').action(label);
    action.focus();
    await action.click();
    expect(page.el('out').textContent).toBe(outcome);
    expect(page.el('list').children.map((row) => row.children[0]?.children[0]?.textContent)).toEqual(['A', 'C']);
    expect(page.doc.activeElement).toBe(page.row('C').action(label === 'Unapprove' ? 'Unapprove' : 'Approve'));
  });

  it('falls back to the previous comment’s first action when the acted-on row was last, and to the filter when none is left', async () => {
    let stored = [comment('A'), comment('B')];
    const page = commentsPage(async (url, options) => {
      if (options.method !== 'GET') { stored = stored.filter((c) => !url.includes('/' + c.id + '/')); return response(); }
      return response({ comments: [...stored] });
    });
    await page.load();
    const approveB = page.row('B').action('Approve');
    approveB.focus();
    await approveB.click();
    expect(page.doc.activeElement).toBe(page.row('A').action('Approve'));
    await page.row('A').action('Approve').click();
    expect(page.el('out').textContent).toBe('Comment approved. No pending comments.');
    expect(page.doc.activeElement).toBe(page.el('statusFilter'));
  });

  it('reports a published reply and refuses an empty one under its labelled field', async () => {
    const posted: string[] = [];
    const page = commentsPage(async (url, options) => {
      if (url.endsWith('/reply')) { posted.push(String(options.body)); return response(); }
      return response({ comments: [comment('A')] });
    });
    await page.load();
    const { form, ta, send } = page.row('A');
    const label = form.children[0]!;
    expect(label.tagName).toBe('LABEL');
    expect(label.textContent).toBe('Reply as author');
    expect(label.htmlFor).toBe(ta.id);
    expect(ta.id).toBe('reply-A');
    expect(send.className).toContain('btn-sm');
    send.focus();
    await form.fire('submit');
    expect(posted).toEqual([]);
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    const error = form.children.find((child) => child.id === 'reply-AError')!;
    expect(error.textContent).toBe('Write a reply first.');
    expect(error.hidden).toBe(false);
    expect(page.doc.activeElement).toBe(ta);
    await page.type('A', 'Danke!');
    expect(ta.getAttribute('aria-invalid')).toBeNull();
    await form.fire('submit');
    expect(posted).toEqual([JSON.stringify({ body: 'Danke!' })]);
    expect(page.el('out').textContent).toBe('Reply published.');
  });

  it('shows the pager only when there is more than one page', async () => {
    const page = commentsPage(async (url) => {
      const more = new URL(url, 'http://localhost').searchParams.get('status') === 'approved';
      return response({ comments: [comment('A')], hasMore: more });
    });
    await page.load();
    expect(page.el('pagination').hidden).toBe(true);
    page.el('statusFilter').value = 'approved';
    await page.load();
    expect(page.el('pagination').hidden).toBe(false);
    expect(page.el('nextPage').disabled).toBe(false);
    await page.el('nextPage').click();
    expect(page.el('pagination').hidden).toBe(false);
    expect(page.el('pageIndicator').textContent).toBe('Page 2');
  });
});

describe('posts.html status views and language states', () => {
  const realFilter = realPostsFilter;
  const library = [
    { ...post, translationKey: 'a', title: 'Altstadt', status: 'draft', publication: publication('draft'), country: 'Romania', region: 'europe', secondaryStatus: 'started' },
    { ...post, translationKey: 'b', title: 'Parks', status: 'published', publication: publication('published', true), country: 'Romania', region: 'europe', secondaryStatus: 'empty' },
    { ...post, translationKey: 'c', title: 'Donau', status: 'published', country: 'Hungary', region: 'europe', secondaryStatus: 'started' },
    { ...post, translationKey: 'd', title: 'Burg', status: 'draft', publication: publication('draft'), country: 'Hungary', region: 'europe' },
  ];
  const views = (el: (id: string) => Element) => el('statusViews').children.map((button) => ({
    status: button.attrs['data-status'],
    pressed: button.attrs['aria-pressed'],
    count: button.children[1]?.textContent,
  }));

  async function loadedPage(search: string) {
    const urls: string[] = [];
    const page = loadPosts({
      PostsFilter: realFilter(),
      location: { href: 'http://localhost/admin/posts.html' + search, origin: 'http://localhost', pathname: '/admin/posts.html', search, protocol: 'http:' },
      history: { replaceState: (_s: unknown, _t: string, url: string) => { urls.push(url); } },
      fetch: async () => ({ status: 200, ok: true, json: async () => library }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    vm.runInContext('me = { isAdmin: true }', page.ctx);
    await (vm.runInContext('load', page.ctx) as () => Promise<void>)();
    return { ...page, urls };
  }

  it('restores the view from the URL and counts under the current non-status filters', async () => {
    const { el } = await loadedPage('?country=Romania&status=published&sort=title');
    expect(views(el)).toEqual([
      { status: '', pressed: 'false', count: '2' },
      { status: 'draft', pressed: 'false', count: '1' },
      { status: 'published', pressed: 'true', count: '1' },
      { status: 'unpublished', pressed: 'false', count: '1' },
      { status: 'missing-secondary', pressed: 'false', count: '1' },
    ]);

    el('fSearch').value = 'no such story';
    await el('fSearch').fire('input');
    expect(views(el).map((v) => v.count)).toEqual(['0', '0', '0', '0', '0']);
  });

  it('switching a view keeps search, region, country, sort and the selection, and updates the URL', async () => {
    const { ctx, el, urls } = await loadedPage('?country=Romania&status=published&sort=title');
    vm.runInContext("selected.add('a'); selected.add('c');", ctx);

    const draftView = el('statusViews').children[1];
    if (!draftView) throw new Error('Draft status view is missing');
    await draftView.click();

    expect(el('fStatus').value).toBe('draft');
    expect(el('fCountry').value).toBe('Romania');
    expect(el('fSort').value).toBe('title');
    expect(vm.runInContext('[...selected]', ctx)).toEqual(['a', 'c']);
    expect(el('bulkCount').textContent).toBe('2 selected · 1 outside current view');
    const lastUrl = urls.at(-1);
    if (!lastUrl) throw new Error('Status switch did not update the URL');
    expect(new URL(lastUrl).search).toBe('?status=draft&country=Romania&sort=title');
    expect(views(el).map((v) => v.pressed)).toEqual(['false', 'true', 'false', 'false', 'false']);
    expect(views(el).map((v) => v.count)).toEqual(['2', '1', '1', '1', '1']);

    // The select is the same state: changing it moves the pressed view.
    el('fStatus').value = 'missing-secondary';
    await el('fStatus').fire('input');
    expect(views(el).map((v) => v.pressed)).toEqual(['false', 'false', 'false', 'false', 'true']);
  });

  it('re-syncs every filter menu after writes that fire no event: URL restore, a status view, Clear filters', async () => {
    const syncs: string[] = [];
    const search = '?country=Romania&status=published&sort=title';
    const page = loadPosts({
      AdminSelect: menuStub(syncs),
      PostsFilter: realFilter(),
      location: { href: 'http://localhost/admin/posts.html' + search, origin: 'http://localhost', pathname: '/admin/posts.html', search, protocol: 'http:' },
      fetch: async () => ({ status: 200, ok: true, json: async () => library }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    vm.runInContext('me = { isAdmin: true }', page.ctx);
    await (vm.runInContext('load', page.ctx) as () => Promise<void>)();
    expect(syncs.slice(-5)).toEqual(['fStatus=published', 'fSort=title', 'fRegion=', 'fCountry=Romania', 'fOrder=desc']);

    const draftView = page.el('statusViews').children[1];
    if (!draftView) throw new Error('Draft status view is missing');
    await draftView.click();
    expect(syncs.slice(-5)).toEqual(['fStatus=draft', 'fSort=title', 'fRegion=', 'fCountry=Romania', 'fOrder=desc']);

    await page.el('fReset').click();
    expect(syncs.slice(-5)).toEqual(['fStatus=', 'fSort=updated', 'fRegion=', 'fCountry=', 'fOrder=desc']);
  });

  it('retains filter context on a failed refresh while disabling stale publication actions', async () => {
    const { ctx, el } = await loadedPage('?country=Romania&sort=title');
    const before = views(el);
    ctx.fetch = () => Promise.reject(NETWORK_DOWN);
    await (vm.runInContext('load', ctx) as () => Promise<void>)();
    expect(el('statusViews').hidden).toBe(false);
    expect(views(el)).toEqual(before);
    expect(el('fCountry').value).toBe('Romania');
    expect(el('fSort').value).toBe('title');
    expect(el('loadMsg').attrs.role).toBe('alert');
    expect(el('retryLoad').hidden).toBe(false);
    expect(el('bulkPublish').disabled).toBe(true);
    expect(el('bulkUnpublish').disabled).toBe(true);
    expect(el('bulkDelete').disabled).toBe(true);
  });

  // Every row's chips: code, the state's class, and the sentence a screen reader hears.
  const chipsOf = (row: Element) => {
    const languages = row.children.find((td) => td.className === 'col-languages')?.children[0];
    if (!languages) throw new Error('Post language chips are missing');
    return languages.children.map((chip) => ({ code: chip.textContent, className: chip.className, name: chip.attrs['aria-label'] }));
  };

  it('shows one chip per locale whose state says whether the translation is written, missing, unknown or left out', () => {
    const { ctx, el } = loadPosts({ PostsFilter: realFilter() });
    const rows = [
      { ...post, translationKey: 'p', country: 'Romania', date: '2021-02-18', secondaryStatus: 'started' },
      { ...post, translationKey: 'm', country: 'Romania', date: '2021-02-18', secondaryStatus: 'empty' },
      { ...post, translationKey: 'u', country: 'Romania', date: '2021-02-18' },
      { ...post, translationKey: 'o', country: 'Romania', date: '2021-02-18', secondaryStatus: 'omitted' },
    ];
    (vm.runInContext('renderRows', ctx) as (posts: unknown[]) => void)(rows);

    const chips = el('postsList').children.map(chipsOf);
    for (const rowChips of chips) {
      expect(rowChips[0]).toEqual({ code: 'DE', className: 'lang-chip', name: 'German: primary language' });
    }
    expect(chips.map((rowChips) => rowChips[1])).toEqual([
      { code: 'EN', className: 'lang-chip', name: 'English body started' },
      { code: 'EN', className: 'lang-chip is-missing', name: 'English body not started' },
      { code: 'EN', className: 'lang-chip is-unknown', name: 'English body status unknown' },
      // A live DE-only story no longer looks like a bilingual one.
      { code: 'EN', className: 'lang-chip is-omitted', name: 'English: not requested for publication' },
    ]);

    // Country and trip date survive under the title — the date formatted as a
    // day, in mono — and only a confirmed missing EN body adds the textual cue.
    const meta = el('postsList').children.map((row) => row.children.find((td) => td.className === 'col-title')!.children
      .find((child) => child.className === 'post-trip-meta')!.children.map((part) => part.className === 'post-trip-date' ? 'date:' + part.textContent : part.className || part.textContent));
    expect(meta).toEqual([
      ['Romania', 'post-trip-sep', 'date:18 Feb 2021'],
      ['Romania', 'post-trip-sep', 'date:18 Feb 2021', 'post-trip-sep', 'post-locale-state'],
      ['Romania', 'post-trip-sep', 'date:18 Feb 2021'],
      ['Romania', 'post-trip-sep', 'date:18 Feb 2021'],
    ]);
  });

  it('writes the Updated column as a day, never an ISO stamp', () => {
    const { ctx, el } = loadPosts({ PostsFilter: realFilter() });
    (vm.runInContext('renderRows', ctx) as (posts: unknown[]) => void)([{ ...post, updatedAt: '2026-11-10T12:00:00.000Z' }, { ...post, translationKey: 'n', updatedAt: '' }]);
    const updated = el('postsList').children.map((row) => row.children.find((td) => td.className.includes('col-updated'))!);
    expect(updated[0]!.textContent).toBe('10 Nov 2026');
    expect(updated[0]!.className).toContain('posts-date');
    expect(updated[1]!.textContent).toBe('');
  });

  it.each([{ locales: ['en'] }, { locales: ['en', 'de'] }])('shows only enabled language chips in primary order: %j', ({ locales }) => {
    const { ctx, el } = loadPosts();
    vm.runInContext(`SiteLanguage.accept({primary:'en',locales:${JSON.stringify(locales)},lockedAt:null,updatedAt:'2026-10-27T00:00:00.000Z'})`, ctx);
    const renderRows = vm.runInContext('renderRows', ctx) as (rows: unknown[]) => void;
    renderRows([{ ...post, title: 'English title', secondaryStatus: locales.length === 1 ? 'none' : 'omitted' }]);
    const cells = el('postsList').children[0]!.children;
    const chips = chipsOf(el('postsList').children[0]!);
    expect(chips.map((chip) => chip.code)).toEqual(locales.map((locale) => locale.toUpperCase()));
    expect(chips[0]!.name).toBe('English: primary language');
    if (locales.length === 2) expect(chips[1]).toEqual({ code: 'DE', className: 'lang-chip is-omitted', name: 'German: not requested for publication' });
    expect(cells.find((cell) => cell.className === 'col-title')!.children.some((child) => child.textContent === 'English title')).toBe(true);
  });

  it('shows a message carried over from an editor once, then forgets it', async () => {
    const stored = new Map<string, string>([['admin.flash', 'Deleted draft “Bukarest”. The site was not rebuilt.']]);
    const sessionStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const { el } = loadPosts({
      sessionStorage,
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async (url: string) => Response.json(url === '/posts' ? [post] : { record: 'missing' }),
    });
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(el('out').textContent).toBe('Deleted draft “Bukarest”. The site was not rebuilt.');
    expect(el('out').attrs.role).toBe('status');
    expect(stored.has('admin.flash')).toBe(false);
  });
});

describe('posts.html row actions', () => {
  const rowActions = (ctx: Record<string, unknown>, el: (id: string) => Element, isAdmin: boolean, rows: unknown[]) => {
    vm.runInContext(`me = { isAdmin: ${isAdmin} }`, ctx);
    (vm.runInContext('renderRows', ctx) as (posts: unknown[]) => void)(rows);
    return el('postsList').children.map((row) => {
      const actions = row.children.find((td) => td.className === 'col-actions')!.children[0]!;
      return actions.children.map((child) => child.className === 'post-more'
        ? child.children[1]!.children.map((button) => button.textContent)
        : child.textContent);
    });
  };
  const draft = { ...post, translationKey: 'd', title: 'Draft story', status: 'draft', publication: publication('draft') };

  it('gives an author Edit alone, never an empty More actions menu', () => {
    const { ctx, el } = loadPosts();
    expect(rowActions(ctx, el, false, [post, draft])).toEqual([['Edit'], ['Edit']]);
  });

  it('gives an admin a More actions menu only where there are two actions; a draft shows Delete as a plain button', () => {
    const { ctx, el } = loadPosts();
    expect(rowActions(ctx, el, true, [post, draft])).toEqual([['Edit', ['Unpublish', 'Delete']], ['Edit', 'Delete']]);
    const draftDelete = el('postsList').children[1]!.children.find((td) => td.className === 'col-actions')!.children[0]!.children[1]!;
    expect(draftDelete.tagName).toBe('BUTTON');
    expect(draftDelete.className).toBe('btn-remove');
    expect(draftDelete.attrs['aria-label']).toBe('Delete Draft story');
  });

  it('says story, not trip, and what Unpublish does now when asking before it acts', async () => {
    const questions: { title: string; body: string }[] = [];
    const { ctx } = loadPosts({ AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return false; } } });
    await (vm.runInContext('unpublishPost', ctx) as (p: unknown, b: Element) => Promise<void>)(post, element());
    await (vm.runInContext('deletePost', ctx) as (p: unknown, b: Element) => Promise<void>)(post, element());
    expect(questions.map((q) => q.title)).toEqual(['Unpublish this story?', 'Delete this story?']);
    expect(questions[0]!.body).toContain('removed from the live site now (the site rebuilds; this can take several minutes) and returns to your drafts');
    expect(questions[0]!.body).not.toMatch(/next build|trip/i);
    expect(questions[1]!.body).toContain('is deleted and removed from the live site now');
    expect(questions.every((q) => !/\btrip\b|\bpost\b/i.test(q.title + q.body))).toBe(true);
  });

  // What a browser does on its own: focus inside the rows is lost when the
  // rows are rebuilt (loadPosts models that), so the page must hand it on.
  // The page's unauthenticated bootstrap settles first; otherwise its
  // microtask resets `me` while the action is still running.
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  const focusAfterDelete = async (rows: (typeof post)[], target: string) => {
    const { ctx, el } = loadPosts({
      fetch: async (url: string, init?: RequestInit) => init?.method === 'DELETE'
        ? Response.json({ deleted: true, publication: { availability: 'missing' } })
        : Response.json(url === '/posts' ? rows.filter((row) => row.translationKey !== target) : { record: 'missing' }),
    });
    await settled();
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(rows)}`, ctx);
    (vm.runInContext('render', ctx) as () => void)();
    // The row's Delete is the plain button beside Edit; the page tags it with its story key.
    const remove = el('postsList').querySelectorAll('.btn-remove').find((button) => button.dataset.postKey === target)!;
    remove.focus();
    await remove.click();
    return { ctx, el, doc: ctx.document as { activeElement: Element | null } };
  };
  const drafts = ['a', 'b', 'c'].map((key) => ({ ...draft, translationKey: key, title: 'Story ' + key }));
  const editLinkOf = (el: (id: string) => Element, key: string) =>
    el('postsList').querySelectorAll('.action-link').find((link) => link.dataset.postKey === key && link.dataset.postControl === 'edit');

  it('moves focus to the next row’s Edit link after deleting a story', async () => {
    const { el, doc } = await focusAfterDelete(drafts, 'b');
    expect(doc.activeElement).toBe(editLinkOf(el, 'c'));
    expect(doc.activeElement?.attrs['aria-label']).toBe('Edit Story c');
  });

  it('moves focus to the previous row’s Edit link when the deleted story was last', async () => {
    const { el, doc } = await focusAfterDelete(drafts, 'c');
    expect(doc.activeElement).toBe(editLinkOf(el, 'b'));
  });

  it('moves focus to New post when the deleted story was the only one', async () => {
    const { el, doc } = await focusAfterDelete([drafts[0]!], 'a');
    expect(doc.activeElement).toBe(el('newPost'));
  });

  it('moves focus from the hidden bulk bar to the row after the deleted stories', async () => {
    const { ctx, el } = loadPosts({
      fetch: async (url: string) => url === '/posts/bulk'
        ? Response.json({ succeeded: 2, failed: 0, results: [{ key: 'a', ok: true, publication: { availability: 'missing' } }, { key: 'b', ok: true, publication: { availability: 'missing' } }] })
        : Response.json(url === '/posts' ? [drafts[2]] : { record: 'missing' }),
    });
    await settled();
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(drafts)}; selected.add('a'); selected.add('b');`, ctx);
    (vm.runInContext('render', ctx) as () => void)();
    const doc = ctx.document as { activeElement: Element | null };
    el('bulkDelete').focus();
    expect(doc.activeElement).toBe(el('bulkDelete'));
    await el('bulkDelete').click();
    expect(el('bulkBar').hidden).toBe(true);
    expect(doc.activeElement).toBe(editLinkOf(el, 'c'));
  });

  it('returns focus to the bulk button when the batch fails and the bar stays', async () => {
    const { ctx, el } = loadPosts();
    await settled();
    vm.runInContext(`me = { isAdmin: true }; allPosts = ${JSON.stringify(drafts)}; selected.add('a');`, ctx);
    (vm.runInContext('render', ctx) as () => void)();
    const doc = ctx.document as { activeElement: Element | null };
    el('bulkPublish').focus();
    await el('bulkPublish').click();
    expect(el('bulkBar').hidden).toBe(false);
    expect(doc.activeElement).toBe(el('bulkPublish'));
  });
});

// ---- settings.html ------------------------------------------------------------
// Fixtures mirror the AI provider registry contract (spec 2026-10-19 §4): the
// settings response every /settings and /ai-providers route answers with.

type ProviderKind = 'lm-studio' | 'openrouter' | 'deepseek' | 'anthropic' | 'openai' | 'custom';
interface ProviderView { id: string; name: string; kind: ProviderKind; baseUrl: string; hasApiKey: boolean }
interface SettingsResponse {
  aiProviders: ProviderView[];
  aiDefaultProviderId: string;
  reviewProviderId: string | null;
  captionProviderId: string | null;
  translationProviderId: string | null;
  translationModel: string;
  translationTimeoutMs: number;
  translationPrompt: string;
  translationPromptDefault: string;
  aiModel: string;
  reviewPrompt: string;
  reviewTimeoutMs: number;
  lmModel: string;
  captionPrompt: string;
  captionTimeoutMs: number;
  captionMaxTokens: number;
  captionMaxEdge: number;
  backupSchedule: 'off' | 'daily' | 'weekly';
  backupRetention: number;
  convertJpeg: boolean;
  webpQuality: number;
  avifQuality: number;
  importDelayMs: number;
  importRetries: number;
  commentsEnabled: boolean;
  geocodingSearchUrl: string;
}
interface Question { title: string; body: string; confirmLabel?: string; danger?: boolean }
interface ApiRequest { url: string; method: string; body?: Record<string, unknown> }

const LOCAL: ProviderView = { id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: 'http://localhost:1234/v1', hasApiKey: false };
const ROUTER: ProviderView = { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true };
const DEEPSEEK: ProviderView = { id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', hasApiKey: false };

function settingsResponse(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    aiProviders: [LOCAL], aiDefaultProviderId: 'lm-studio', reviewProviderId: null, captionProviderId: null,
    translationProviderId: null, translationModel: 'translation-model', translationTimeoutMs: 120000,
    translationPrompt: 'Translation prompt', translationPromptDefault: DEFAULT_TRANSLATION_PROMPT,
    aiModel: 'review-model', reviewPrompt: 'Review prompt', reviewTimeoutMs: 60000,
    lmModel: 'vision-model', captionPrompt: 'Caption prompt', captionTimeoutMs: 60000, captionMaxTokens: 8000, captionMaxEdge: 768,
    backupSchedule: 'off', backupRetention: 14, convertJpeg: true, webpQuality: 75, avifQuality: 55,
    importDelayMs: 1200, importRetries: 3, commentsEnabled: false,
    geocodingSearchUrl: 'https://nominatim.openstreetmap.org/search',
    ...overrides,
  };
}

// Settings checks translation instructions with the browser's own rule, so the
// harness takes it from the real llm.js rather than restating it (its top-level
// body only assigns window.LLM).
const browserLlm: { LLM?: {
  TRANSLATION_PROMPT_MAX_LENGTH: number; isTranslationPrompt(value: unknown): boolean; translationPromptProblem(value: unknown): string | null;
} } = {};
vm.runInNewContext(readFileSync('public/llm.js', 'utf8'), { window: browserLlm });
const TRANSLATION_PROMPT_RULE = {
  TRANSLATION_PROMPT_MAX_LENGTH: browserLlm.LLM!.TRANSLATION_PROMPT_MAX_LENGTH,
  isTranslationPrompt: browserLlm.LLM!.isTranslationPrompt,
  translationPromptProblem: browserLlm.LLM!.translationPromptProblem,
};

function loadSettingsPage(extra: Record<string, unknown> = {}) {
  return loadPage('public/settings.html', {
    LLM: { mixedContentWarning: () => '', listModels: async () => [], ...TRANSLATION_PROMPT_RULE },
    AbortController, AbortSignal, Event, setTimeout, clearTimeout,
    ...extra,
  }, ['public/tabs.js', 'public/settings-drafts.js']);
}

/** Settings opens on Site identity; model lookups run only while AI models is shown. */
const AI_MODELS_TAB = {
  location: {
    href: 'http://localhost/admin/settings.html#ai-models', origin: 'http://localhost',
    pathname: '/admin/settings.html', search: '', hash: '#ai-models', protocol: 'http:',
  },
};

/** Calls a top-level function the page script declared (vm puts it on the context). */
async function callPage(ctx: Record<string, unknown>, name: string, ...args: unknown[]): Promise<void> {
  const fn = ctx[name];
  if (typeof fn !== 'function') throw new Error('settings.html declares no ' + name + '()');
  await fn(...args);
}

const descendants = (node: Element): Element[] => node.children.flatMap((child) => [child, ...descendants(child)]);

function providerRow(el: (id: string) => Element, name: string): Element {
  const row = el('providerList').children
    .find((li) => descendants(li).some((n) => n.className === 'provider-name' && n.textContent === name));
  if (!row) throw new Error('no provider row for ' + name);
  return row;
}

function rowButton(row: Element, label: string): Element {
  const button = descendants(row).find((n) => n.className.startsWith('provider-action') && n.textContent === label);
  if (!button) throw new Error('no ' + label + ' action in the row');
  return button;
}

function rowStatus(row: Element): string {
  return descendants(row).find((n) => n.className.includes('provider-test-out'))?.textContent ?? '';
}

/** Every place the page writes text a person or a screen reader can see. */
function pageText(el: (id: string) => Element): string {
  return [
    'providersOut', 'providerFormOut', 'providerKeyHelp', 'providerKeyMoveWarning', 'providerUrlWarning',
    'reviewResolved', 'reviewDestination', 'captionResolved', 'captionDestination', 'aiOut', 'reviewTestOut', 'out',
    'reviewModelStatus', 'captionModelStatus',
    'translationResolved', 'translationDestination', 'translationModelStatus', 'translationProviderWarn',
  ].map((id) => el(id).textContent).concat(descendants(el('providerList')).map((n) => n.textContent)).join('\n');
}

/** A model select's option labels, in order. */
const modelOptions = (el: (id: string) => Element, id: string) => el(id).children.map((o) => o.textContent);

/** Picks the option with this label, as a person would. */
async function chooseModel(el: (id: string) => Element, id: string, label: string): Promise<void> {
  const option = el(id).children.find((o) => o.textContent === label);
  if (!option) throw new Error('no ' + label + ' option in #' + id);
  el(id).value = option.value;
  await el(id).fire('change');
}

/**
 * settings.html over a contract-shaped fake API. `route` answers first; /settings is served from `state`.
 * These tests drive the AI registry, so the page opens on its tab unless `hash` says otherwise.
 */
async function apiPage(initial: SettingsResponse, opts: {
  confirm?: (question: Question) => boolean | Promise<boolean>;
  route?: (request: ApiRequest, setState: (next: SettingsResponse) => void) => Response | undefined | Promise<Response | undefined>;
  listModels?: (baseUrl: string, apiKey: string | null) => Promise<string[]>;
  mixedContentWarning?: (url: string, protocol: string) => string;
  hash?: string;
} = {}) {
  let state = initial;
  const setState = (next: SettingsResponse) => { state = next; };
  const requests: ApiRequest[] = [];
  const questions: Question[] = [];
  const storageWrite = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const request: ApiRequest = {
      url, method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    requests.push(request);
    const routed = await opts.route?.(request, setState);
    if (routed) return routed;
    if (url === '/settings' && request.method === 'POST') state = { ...state, ...(request.body as Partial<SettingsResponse>) };
    if (url === '/settings') return Response.json(state);
    return Response.json({ error: 'Unexpected request in this test.' }, { status: 500 });
  });
  const listedByDefault = async (_baseUrl: string, _apiKey: string | null): Promise<string[]> => ['model-a', 'model-b'];
  const listModels = vi.fn(opts.listModels ?? listedByDefault);
  const page = loadSettingsPage({
    fetch: fetcher,
    localStorage: { setItem: storageWrite }, sessionStorage: { setItem: storageWrite },
    LLM: { mixedContentWarning: opts.mixedContentWarning ?? (() => ''), listModels, ...TRANSLATION_PROMPT_RULE },
    AdminConfirm: {
      ask: async (question: Question) => { questions.push(question); return opts.confirm ? opts.confirm(question) : true; },
    },
    ...(opts.hash === undefined ? AI_MODELS_TAB : {
      location: {
        href: 'http://localhost/admin/settings.html' + opts.hash, origin: 'http://localhost',
        pathname: '/admin/settings.html', search: '', hash: opts.hash, protocol: 'http:',
      },
    }),
  });
  await callPage(page.ctx, 'fill', state);
  return { ...page, requests, questions, listModels, fetcher, storageWrite };
}

const calls = (requests: ApiRequest[]) => requests.map((r) => r.method + ' ' + r.url);

describe('Settings safety and recovery state', () => {
  it('keeps the leave guard for another dirty section after saving, and never persists entered credentials', async () => {
    const page = await apiPage(settingsResponse());
    const leave = async () => {
      let prevented = false;
      for (const listener of page.windowListeners.beforeunload ?? []) {
        await listener({ preventDefault() { prevented = true; } });
      }
      return prevented;
    };
    expect(await leave()).toBe(false);
    await page.el('commentSettings').fire('input');
    await page.el('useCaseSection').fire('input');
    await page.el('saveComments').click();
    expect(await leave()).toBe(true);
    await page.el('saveAi').click();
    expect(await leave()).toBe(false);
    await page.el('addProvider').click();
    page.el('providerApiKey').value = 'fixture-never-store-this-key';
    await page.el('providerForm').fire('input');
    expect(await leave()).toBe(true);
    expect(page.el('settingsDraftStatus').textContent).not.toContain('fixture-never-store-this-key');
    expect(page.storageWrite).not.toHaveBeenCalled();
    await page.el('cancelProvider').click();
    expect(await leave()).toBe(false);
    expect(page.el('providerApiKey').value).toBe('');
  });

  it('requires fresh consent to discard all pending settings', async () => {
    let confirmed = false;
    const reload = vi.fn();
    const page = loadSettingsPage({
      location: { ...AI_MODELS_TAB.location, reload },
      AdminConfirm: { ask: async () => confirmed },
    });
    await page.el('useCaseSection').fire('input');
    await page.el('settingsDiscard').click();
    expect(reload).not.toHaveBeenCalled();
    confirmed = true;
    await page.el('settingsDiscard').click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('distinguishes unknown operation history from existing files and explicit empty archive lists', async () => {
    const page = loadSettingsPage();
    await callPage(page.ctx, 'renderBackups', {
      state: {}, files: [{ name: 'db-existing.json.gz', size: 2048 }], imageArchives: [], routeArchives: [],
    });
    expect(page.el('backupStatus').textContent).toBe(EDITOR_COPY.settingsBackupUnknown);
    expect(page.el('backupFiles').children[0]?.children[0]?.href).toBe('/backups/db-existing.json.gz');
    expect(page.el('imageArchives').children[0]?.textContent).toBe(EDITOR_COPY.settingsImagesEmpty);
    expect(page.el('routeArchives').children[0]?.textContent).toBe(EDITOR_COPY.settingsRoutesEmpty);
    await callPage(page.ctx, 'renderBackups', {
      state: { lastSuccessAt: '2026-11-06T00:00:00Z' }, files: [], imageArchives: [], routeArchives: [],
    });
    const format = vm.runInContext('AdminFormat', page.ctx) as { dateTime(value: string): string };
    expect(page.el('backupStatus').textContent).toBe('The last backup succeeded at ' + format.dateTime('2026-11-06T00:00:00Z') + '.');
    expect(page.el('backupStatus').textContent).not.toContain('2026-11-06T');
    expect(page.el('backupFiles').children[0]?.textContent).toBe(EDITOR_COPY.settingsBackupEmpty);
    await callPage(page.ctx, 'renderBackups', {
      running: true, state: { lastAttemptAt: '2026-11-07T06:30:00Z' }, files: [], imageArchives: [], routeArchives: [],
    });
    expect(page.el('backupStatus').textContent).toBe('Backing up… started ' + format.dateTime('2026-11-07T06:30:00Z') + '.');
    await callPage(page.ctx, 'renderBackups', {
      state: { lastAttemptAt: '2026-11-07T06:30:00Z', lastError: 'disk full' }, files: [], imageArchives: [], routeArchives: [],
    });
    expect(page.el('backupStatus').textContent).toBe('The last backup failed at ' + format.dateTime('2026-11-07T06:30:00Z') + ': disk full');
  });

  it('returns focus to the pressed Save after the comments and site settings have saved', async () => {
    for (const [button, status, outcome] of [['saveComments', 'commentsOut', 'Comments are off.'], ['save', 'siteOut', EDITOR_COPY.settingsSaved]] as const) {
      const page = await apiPage(settingsResponse(), { hash: '#comments' });
      const { el } = page;
      const doc = documentOf(page);
      el(button).focus();
      const pending = el(button).click();
      expect(el(button).disabled).toBe(true);
      // A disabled control cannot hold focus: the browser drops it to <body>.
      doc.activeElement = null;
      await pending;
      expect(el(button).disabled).toBe(false);
      expect(el(status).textContent).toBe(outcome);
      expect(doc.activeElement).toBe(el(button));
    }
  });

  it('turns a refused comments save into a sentence without a status number', async () => {
    const page = await apiPage(settingsResponse(), {
      hash: '#comments', route: (request) => request.method === 'POST' ? Response.json({ error: 'comments setting unavailable' }, { status: 400 }) : undefined,
    });
    await page.el('saveComments').click();
    expect(page.el('commentsOut').textContent).toBe('Could not save: Comments setting unavailable.');
  });

  it('converts fractional seconds to exact import milliseconds and saves only the backup/import scope', async () => {
    const page = await apiPage(settingsResponse({ importDelayMs: 1201 }));
    expect(Number(page.el('importDelaySeconds').value)).toBe(1.201);
    page.el('importDelaySeconds').value = '1.001';
    page.el('importRetries').value = '2';
    page.el('routingCarUrl').value = 'https://unsaved.example/';
    await page.el('save').click();
    expect(page.requests[0]?.body).toEqual({
      backupSchedule: 'off', backupRetention: 14, importDelayMs: 1001, importRetries: 2,
    });
    expect(page.el('routingCarUrl').value).toBe('https://unsaved.example/');
  });
});

describe('settings.html tabs', () => {
  const PANELS = ['panel-ai-models', 'panel-images', 'panel-comments', 'panel-identity', 'panel-language', 'panel-site'];

  function tabsPage(hash = '', narrow = false) {
    const replaced: string[] = [];
    const location = {
      href: 'http://localhost/admin/settings.html' + hash, origin: 'http://localhost',
      pathname: '/admin/settings.html', search: '', hash, protocol: 'http:',
    };
    const page = loadSettingsPage({
      location,
      history: { replaceState: (_state: unknown, _title: string, url: string) => { replaced.push(url); } },
      matchMedia: () => ({ matches: narrow, addEventListener() {} }),
    });
    const visible = () => PANELS.filter((id) => !page.el(id).hidden);
    const title = () => page.el('settingsTabTitle').textContent;
    return { ...page, location, replaced, visible, title };
  }

  it.each(['', '#', '#nope', '#__proto__'])('opens Site identity for hash %j without rewriting the URL', (hash) => {
    const t = tabsPage(hash);
    expect(t.visible()).toEqual(['panel-identity']);
    expect(t.title()).toBe(' · ' + EDITOR_COPY.identityTab);
    expect(t.el('tabbtn-identity').attrs['aria-selected']).toBe('true');
    expect(t.replaced).toEqual([]);
  });

  it('opens a deep-linked tab with the roving tabindex and the title on it', () => {
    const t = tabsPage('#comments');
    expect(t.visible()).toEqual(['panel-comments']);
    expect(t.title()).toBe(' · Comments');
    expect(t.el('tabbtn-comments').tabIndex).toBe(0);
    expect(t.el('tabbtn-ai-models').tabIndex).toBe(-1);
  });

  it('opens the AI assignment panel when following translation configuration recovery', async () => {
    const window = new Window();
    try {
      const editor = new window.DOMParser().parseFromString(readFileSync('public/editor.html', 'utf8'), 'text/html');
      const link = editor.querySelector('#translationSettings')!;
      const destination = new URL(link.getAttribute('href')!, 'http://localhost/admin/editor.html');
      expect(destination.pathname).toBe('/admin/settings.html');
      const t = tabsPage(destination.hash);
      expect(t.visible()).toEqual(['panel-ai-models']);
      expect(t.el('tabbtn-ai-models').attrs['aria-selected']).toBe('true');
      expect(t.el('tabbtn-ai-models').tabIndex).toBe(0);
    } finally { await window.happyDOM.close(); }
  });

  it('opens the identity deep link and includes it in keyboard navigation', async () => {
    const t = tabsPage('#identity');
    expect(t.visible()).toEqual(['panel-identity']);
    expect(t.el('tabbtn-identity').tabIndex).toBe(0);
    expect(t.title()).toBe(' · ' + EDITOR_COPY.identityTab);
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-language']);
    expect(t.replaced).toEqual(['#language']);
  });

  it('opens language settings directly and includes the panel in keyboard navigation', async () => {
    const t = tabsPage('#language');
    expect(t.visible()).toEqual(['panel-language']);
    expect(t.title()).toBe(' · Languages');
    await t.el('tabbtn-language').fire('keydown', { key: 'ArrowUp' });
    expect(t.visible()).toEqual(['panel-identity']);
  });

  it('a vertical index moves with Up/Down, Home/End, and mirrors the tab in the hash and title', async () => {
    const t = tabsPage();
    expect(t.el('settingsTabs').attrs['aria-orientation']).toBe('vertical');
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowRight' });
    expect(t.visible()).toEqual(['panel-identity']);
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-language']);
    expect(t.el('tabbtn-language').focused).toBe(true);
    expect(t.title()).toBe(' · Languages');
    await t.el('tabbtn-language').fire('keydown', { key: 'End' });
    expect(t.visible()).toEqual(['panel-site']);
    expect(t.title()).toBe(' · Site & backups');
    await t.el('tabbtn-site').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-identity']);
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowUp' });
    await t.el('tabbtn-site').fire('keydown', { key: 'Home' });
    expect(t.replaced).toEqual(['#language', '#site', '#identity', '#site', '#identity']);
  });

  it('a click selects the tab and a hashchange (back/forward, edited URL) selects it too', async () => {
    const t = tabsPage();
    await t.el('tabbtn-site').click();
    expect(t.visible()).toEqual(['panel-site']);
    expect(t.replaced).toEqual(['#site']);
    t.location.hash = '#images';
    for (const fn of t.windowListeners.hashchange ?? []) await fn();
    expect(t.visible()).toEqual(['panel-images']);
    expect(t.title()).toBe(' · Images');
    expect(t.el('tabbtn-images').attrs['aria-selected']).toBe('true');
  });

  it('below 72rem the strip is horizontal and its arrow keys follow', async () => {
    const t = tabsPage('', true);
    expect(t.el('settingsTabs').attrs['aria-orientation']).toBe('horizontal');
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-identity']);
    await t.el('tabbtn-identity').fire('keydown', { key: 'ArrowRight' });
    expect(t.visible()).toEqual(['panel-language']);
  });
});

describe('settings.html actions survive a dropped connection', () => {
  it('Back up now re-enables its button, names the failure as a sentence and keeps focus on the button', async () => {
    const page = loadSettingsPage();
    const { el } = page;
    const doc = documentOf(page);
    el('backupNow').focus();
    const pending = el('backupNow').click();
    // A disabled control cannot hold focus: the browser drops it to <body>.
    doc.activeElement = null;
    await pending;
    expect(el('backupNow').disabled).toBe(false);
    expect(el('backupStatus').textContent).toBe('Could not back up: Failed to fetch.');
    expect(doc.activeElement).toBe(el('backupNow'));
  });

  it('Rebuild site now re-enables its button and names the failure', async () => {
    const { el } = loadSettingsPage();
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).toBe(ui.en['admin.build.unknown']);
  });

  it('Rebuild does not start when the confirm is declined', async () => {
    const { el } = loadSettingsPage({ AdminConfirm: { ask: async () => false } });
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).not.toMatch(/Rebuilding|Rebuilt|failed/);
  });
});

describe('Settings rebuild report and independent status', () => {
  it.each([true, false])('shows promoted=%s separately from the latest attempt and live observation', async (ok) => {
    const requests: string[] = [];
    const { el, ctx } = loadSettingsPage({
      fetch: async (url: string) => {
        requests.push(url);
        if (url === '/rebuild') return Response.json({ ok, release: ok ? '1793000000000-1-0001' : undefined, code: 'build_failed', error: 'SECRET', liveRelease: null });
        if (url === '/rebuild/status') return Response.json({ record: 'unreadable', running: null, last: null, live: { release: '1793000000000-1-0001', stampedAt: '2026-10-26T00:00:00Z' } });
        if (url === '/publication/summary') return Response.json({ availability: 'unavailable' });
        throw new Error('Unexpected ' + url);
      },
    });
    vm.runInContext('publicationRefresh.start(false)', ctx);
    await el('rebuild').click();
    await (vm.runInContext('publicationRefresh.refresh()', ctx) as Promise<void>);
    expect(requests).toEqual(['/rebuild', '/publication/summary', '/rebuild/status']);
    expect(el('out').textContent).toContain(ok ? 'A new version of the site was built' : 'The rebuild failed, so the live site was not updated');
    expect(el('out').textContent).toContain('Nothing is live yet');
    expect(el('out').textContent).not.toContain('SECRET');
    expect(el('buildStatus').textContent).toContain('record could not be read');
    expect(el('buildStatus').textContent).toContain('The live site is serving the version built');
    expect(el('buildStatus').textContent).not.toContain('succeeded');
    vm.runInContext('publicationRefresh.stop()', ctx);
  });
});

describe('settings.html providers', () => {
  it.each(['default', 'ai', 'delete'] as const)('preserves an unsubmitted Add form across unrelated %s work', async (action) => {
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request, setState) => {
        if (request.method === 'DELETE') {
          const next = { ...state, aiProviders: [LOCAL, ROUTER] };
          setState(next);
          return Response.json(next);
        }
        if (request.url === '/ai-providers' && request.method === 'POST') return Response.json(state, { status: 201 });
        return undefined;
      },
    });
    const { el } = page;
    await el('addProvider').click();
    const formNode = el('providerForm');
    el('providerName').value = 'Pending provider';
    el('providerBaseUrl').value = 'https://pending.example/v1';
    el('providerApiKey').value = 'fixture-unsubmitted-add';
    if (action === 'default') await rowButton(providerRow(el, ROUTER.name), 'Set default').click();
    else if (action === 'ai') await el('saveAi').click();
    else await rowButton(providerRow(el, DEEPSEEK.name), 'Delete').click();
    expect(el('providerForm')).toBe(formNode);
    expect(formNode.hidden).toBe(false);
    expect(el('providerName').value).toBe('Pending provider');
    expect(el('providerBaseUrl').value).toBe('https://pending.example/v1');
    expect(el('providerKind').value).toBe('openrouter');
    expect(el('providerApiKey').value).toBe('fixture-unsubmitted-add');
    expect(page.requests.every((r) => !r.body || !Object.hasOwn(r.body, 'apiKey'))).toBe(true);
    await el('providerForm').fire('submit');
    const writes = page.requests.filter((r) => r.body && Object.hasOwn(r.body, 'apiKey'));
    expect(writes).toEqual([{
      url: '/ai-providers', method: 'POST',
      body: { name: 'Pending provider', kind: 'openrouter', baseUrl: 'https://pending.example/v1', apiKey: 'fixture-unsubmitted-add' },
    }]);
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-unsubmitted-add');
    expect(page.storageWrite).not.toHaveBeenCalled();
  });

  it.each(['default', 'ai'] as const)('keeps an Edit replacement bound to its original provider after %s', async (action) => {
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request) => request.method === 'PUT' ? Response.json(state) : undefined,
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerName').value = 'Pending rename';
    el('providerBaseUrl').value = 'https://replacement.example/v1';
    el('providerApiKey').value = 'fixture-bound-replacement';
    if (action === 'default') await rowButton(providerRow(el, DEEPSEEK.name), 'Set default').click();
    else await el('saveAi').click();
    expect(providerRow(el, ROUTER.name).children).toContain(el('providerForm'));
    expect(el('providerApiKey').value).toBe('fixture-bound-replacement');
    expect(el('providerKeyMoveWarning').hidden).toBe(true);
    page.questions.length = 0;
    await el('providerForm').fire('submit');
    expect(page.questions).toEqual([]);
    expect(page.requests.filter((r) => r.body && Object.hasOwn(r.body, 'apiKey'))).toEqual([{
      url: '/ai-providers/openrouter', method: 'PUT',
      body: { name: 'Pending rename', baseUrl: 'https://replacement.example/v1', apiKey: 'fixture-bound-replacement' },
    }]);
    expect(page.listModels.mock.calls.some((args) => args.includes('fixture-bound-replacement'))).toBe(false);
    expect(pageText(el)).not.toContain('fixture-bound-replacement');
    expect(page.storageWrite).not.toHaveBeenCalled();
  });

  it.each(['refused', 'network'] as const)('retains a pending key after unrelated %s failure and successful refresh', async (failure) => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => {
        if (request.method !== 'POST') return undefined;
        if (failure === 'network') throw NETWORK_DOWN;
        return Response.json({ error: 'Settings refused.' }, { status: 409 });
      },
    });
    await rowButton(providerRow(page.el, ROUTER.name), 'Edit').click();
    page.el('providerApiKey').value = 'fixture-retained-on-failure';
    await page.el('saveAi').click();
    expect(page.el('providerApiKey').value).toBe('fixture-retained-on-failure');
    expect(page.el('providerForm').hidden).toBe(false);
    expect(page.el('saveProvider').disabled).toBe(false);
    expect(calls(page.requests)).toEqual(['POST /settings', 'GET /settings']);
    expect(page.el('aiOut').textContent).toContain(failure === 'network' ? 'outcome is unknown' : 'Settings refused.');
  });

  it('retains and blocks an Edit form on failed refresh without interpreting it as Add', async () => {
    let failRefresh = true;
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request) => {
        if (request.method === 'GET' && request.url === '/settings' && failRefresh) throw NETWORK_DOWN;
        if (request.method === 'PUT') return Response.json(state);
        return undefined;
      },
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    const staleAction = rowButton(providerRow(el, DEEPSEEK.name), 'Set default');
    el('providerName').value = 'Pending edit';
    el('providerBaseUrl').value = 'https://pending.example/v1';
    el('providerApiKey').value = 'fixture-blocked-key';
    await staleAction.click();
    expect(el('providerForm').hidden).toBe(false);
    expect(el('providerApiKey').value).toBe('fixture-blocked-key');
    expect(el('providerName').value).toBe('Pending edit');
    expect(el('providerBaseUrl').value).toBe('https://pending.example/v1');
    expect(el('providerKindField').hidden).toBe(true);
    expect(el('providersOut').textContent).toBe(EDITOR_COPY.settingsRegistryUnavailable);
    for (const id of ['saveProvider', 'removeProviderKey', 'testProviderForm', 'addProvider', 'saveAi']) {
      expect(el(id).disabled).toBe(true);
    }
    const before = page.requests.length;
    await el('providerForm').fire('submit');
    await el('removeProviderKey').click();
    await el('testProviderForm').click();
    await el('saveAi').click();
    await staleAction.click();
    expect(page.requests).toHaveLength(before);
    failRefresh = false;
    await callPage(page.ctx, 'reloadSettings');
    expect(el('saveProvider').disabled).toBe(false);
    expect(el('providersOut').textContent).toBe('');
    expect(el('providerFormOut').textContent).toBe('');
    expect(el('providerApiKey').value).toBe('fixture-blocked-key');
    await el('providerForm').fire('submit');
    expect(page.requests.find((r) => r.method === 'PUT')).toMatchObject({
      url: '/ai-providers/openrouter', body: { apiKey: 'fixture-blocked-key', baseUrl: 'https://pending.example/v1' },
    });
    expect(page.requests.some((r) => r.url === '/ai-providers')).toBe(false);
    expect(page.storageWrite).not.toHaveBeenCalled();
  });

  it('still confirms a genuinely blank-key URL move after unrelated work and retains edits when declined', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] }), {
      confirm: (question) => question.confirmLabel !== 'Save new URL',
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerName').value = 'Pending URL edit';
    el('providerBaseUrl').value = 'https://blank-key.example/v1';
    await el('saveAi').click();
    expect(el('providerKeyMoveWarning').hidden).toBe(false);
    const before = page.requests.length;
    await el('providerForm').fire('submit');
    expect(page.requests).toHaveLength(before);
    expect(page.questions).toHaveLength(1);
    expect(page.questions[0]!.body).toContain(ROUTER.baseUrl);
    expect(page.questions[0]!.body).toContain('https://blank-key.example/v1');
    expect(el('providerName').value).toBe('Pending URL edit');
    expect(el('providerBaseUrl').value).toBe('https://blank-key.example/v1');
    expect(el('providerApiKey').value).toBe('');
    expect(el('providerForm').hidden).toBe(false);
  });

  it('does not erase input typed while an unrelated settings response is pending', async () => {
    const pending = Promise.withResolvers<Response>();
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER] });
    const page = await apiPage(state, {
      route: (request) => request.method === 'POST' ? pending.promise : undefined,
    });
    await page.el('addProvider').click();
    const saving = page.el('saveAi').click();
    page.el('providerName').value = 'Typed while saving';
    page.el('providerBaseUrl').value = 'https://later.example/v1';
    page.el('providerApiKey').value = 'fixture-later-key';
    pending.resolve(Response.json(state));
    await saving;
    expect(page.el('providerApiKey').value).toBe('fixture-later-key');
    expect(page.el('providerName').value).toBe('Typed while saving');
    expect(page.el('providerBaseUrl').value).toBe('https://later.example/v1');
  });

  it.each([200, 409, 500])('keeps a replacement form intact when an older provider save returns %s', async (status) => {
    const pending = Promise.withResolvers<Response>();
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request) => request.method === 'PUT' ? pending.promise : undefined,
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerBaseUrl').value = 'https://original-operation.example/v1';
    el('providerApiKey').value = 'fixture-submitted-snapshot';
    const saving = el('providerForm').fire('submit');
    expect(el('providerApiKey').value).toBe('');
    await rowButton(providerRow(el, DEEPSEEK.name), 'Edit').click();
    el('providerName').value = 'New pending form';
    el('providerBaseUrl').value = 'https://new-form.example/v1';
    el('providerApiKey').value = 'fixture-new-form-key';
    pending.resolve(Response.json(status === 200 ? state : {
      code: status === 500 ? 'settings_partial_failure' : 'refused',
      error: 'Original operation failed. Reload settings before retrying.',
    }, { status }));
    await saving;
    expect(el('providerForm').hidden).toBe(false);
    expect(providerRow(el, DEEPSEEK.name).children).toContain(el('providerForm'));
    expect(el('providerApiKey').value).toBe('fixture-new-form-key');
    expect(el('providerName').value).toBe('New pending form');
    expect(el('providerBaseUrl').value).toBe('https://new-form.example/v1');
    expect(el('providerFormOut').textContent).toBe('');
    expect(el('saveProvider').disabled).toBe(false);
    expect(page.requests[0]).toMatchObject({
      url: '/ai-providers/openrouter',
      body: { baseUrl: 'https://original-operation.example/v1', apiKey: 'fixture-submitted-snapshot' },
    });
    expect(el('providersOut').textContent).toContain(status === 200 ? 'Saved' : 'Original operation failed');
    expect(pageText(el)).not.toContain('fixture-');
  });

  it('clears a submitted key before a 401 and follows login without persistence', async () => {
    const page = await apiPage(settingsResponse(), {
      route: (request) => request.method === 'POST' ? Response.json({}, { status: 401 }) : undefined,
    });
    await page.el('addProvider').click();
    page.el('providerApiKey').value = 'fixture-auth-loss';
    const saving = page.el('providerForm').fire('submit');
    expect(page.el('providerApiKey').value).toBe('');
    await saving;
    expect(page.ctx.location).toMatchObject({ href: '/login' });
    expect(calls(page.requests)).toEqual(['POST /ai-providers']);
    expect(page.storageWrite).not.toHaveBeenCalled();
  });

  it('retains keys on local validation and declined removal, but clears intentional Cancel', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), { confirm: () => false });
    await rowButton(providerRow(page.el, ROUTER.name), 'Edit').click();
    page.el('providerName').value = '';
    page.el('providerApiKey').value = 'fixture-not-submitted';
    await page.el('providerForm').fire('submit');
    await page.el('removeProviderKey').click();
    expect(page.el('providerApiKey').value).toBe('fixture-not-submitted');
    expect(page.requests).toEqual([]);
    await page.el('cancelProvider').click();
    expect(page.el('providerApiKey').value).toBe('');
  });

  it('reports a partial provider failure even when its refresh also fails', async () => {
    const error = 'API key change saved, but settings were not saved. Reload settings before retrying.';
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => request.method === 'PUT'
        ? Response.json({ code: 'settings_partial_failure', error }, { status: 500 })
        : Response.json({}, { status: 503 }),
    });
    await rowButton(providerRow(page.el, ROUTER.name), 'Edit').click();
    page.el('providerApiKey').value = 'fixture-partial-refresh-failure';
    await page.el('providerForm').fire('submit');
    expect(page.el('providerApiKey').value).toBe('');
    expect(page.el('providersOut').textContent).toContain(error);
    expect(page.el('providersOut').textContent).toContain(EDITOR_COPY.settingsRegistryUnavailable);
    expect(calls(page.requests)).toEqual(['PUT /ai-providers/openrouter', 'GET /settings']);
  });

  it('does not let a confirmed operation from a replaced form consume its new key', async () => {
    const confirmation = Promise.withResolvers<boolean>();
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] }), {
      confirm: () => confirmation.promise,
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerApiKey').value = 'fixture-original-pending';
    const removing = el('removeProviderKey').click();
    await rowButton(providerRow(el, DEEPSEEK.name), 'Edit').click();
    expect(el('providerApiKey').value).toBe('');
    el('providerApiKey').value = 'fixture-after-confirmation-opened';
    confirmation.resolve(true);
    await removing;
    expect(page.requests).toEqual([]);
    expect(el('providerApiKey').value).toBe('fixture-after-confirmation-opened');
    expect(el('providerForm').hidden).toBe(false);
  });

  it('clears confirmed removal at handoff and leaves a later form intact on completion', async () => {
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request) => {
        if (request.method !== 'PUT') return undefined;
        started.resolve();
        return response.promise;
      },
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerApiKey').value = 'fixture-discard-on-remove';
    const removing = el('removeProviderKey').click();
    await started.promise;
    expect(el('providerApiKey').value).toBe('');
    await rowButton(providerRow(el, DEEPSEEK.name), 'Edit').click();
    el('providerApiKey').value = 'fixture-after-remove-handoff';
    response.resolve(Response.json(state));
    await removing;
    expect(page.requests[0]).toEqual({ method: 'PUT', url: '/ai-providers/openrouter', body: { apiKey: null } });
    expect(el('providerApiKey').value).toBe('fixture-after-remove-handoff');
    expect(el('providerForm').hidden).toBe(false);
  });

  it('does not place an older form Test result into a different form', async () => {
    const models = Promise.withResolvers<string[]>();
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] }), {
      listModels: () => models.promise,
    });
    const { el } = page;
    await rowButton(providerRow(el, ROUTER.name), 'Edit').click();
    el('providerApiKey').value = 'fixture-test-original';
    const testing = el('testProviderForm').click();
    await rowButton(providerRow(el, DEEPSEEK.name), 'Edit').click();
    el('providerApiKey').value = 'fixture-test-next-form';
    models.resolve(['model']);
    await testing;
    expect(el('providerFormOut').textContent).toBe('');
    expect(el('providerApiKey').value).toBe('fixture-test-next-form');
    expect(page.listModels.mock.calls).toEqual([[ROUTER.baseUrl, 'fixture-test-original']]);
  });

  it('explains discarding an edited provider only when fresh settings prove it was removed', async () => {
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK] });
    const page = await apiPage(state, {
      route: (request) => request.method === 'GET' && request.url === '/settings'
        ? Response.json({ ...state, aiProviders: [LOCAL, DEEPSEEK] }) : undefined,
    });
    await rowButton(providerRow(page.el, ROUTER.name), 'Edit').click();
    page.el('providerApiKey').value = 'fixture-removed-provider';
    await rowButton(providerRow(page.el, DEEPSEEK.name), 'Set default').click();
    expect(page.el('providerForm').hidden).toBe(true);
    expect(page.el('providerApiKey').value).toBe('');
    expect(page.el('providersOut').textContent).toContain(EDITOR_COPY.settingsProviderRemoved);
    expect(page.requests.every((r) => !r.body || !Object.hasOwn(r.body, 'apiKey'))).toBe(true);
  });

  it('renders names and URLs as text only, with the default badge, kind and key state', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { el } = await apiPage(settingsResponse({
      aiProviders: [LOCAL, { ...ROUTER, name: hostile, baseUrl: 'https://router.example/<b>/v1' }, DEEPSEEK],
    }));
    const router = providerRow(el, hostile);
    const routerText = descendants(router).map((n) => n.textContent);
    expect(routerText).toContain('https://router.example/<b>/v1');
    expect(routerText).toContain('OpenRouter · Key stored');
    expect(descendants(providerRow(el, 'DeepSeek')).map((n) => n.textContent)).toContain('DeepSeek · No key');
    expect(descendants(el('providerList')).every((n) => n.innerHTML === '')).toBe(true);
    expect(rowButton(router, 'Delete').attrs['aria-label']).toBe('Delete ' + hostile);

    const local = providerRow(el, 'Local LM Studio');
    const localNodes = descendants(local);
    expect(localNodes.some((n) => n.className.includes('provider-default') && n.textContent === 'default')).toBe(true);
    expect(localNodes.map((n) => n.textContent)).toContain('Local LM Studio · Local — no key');
    expect(rowButton(local, 'Set default').disabled).toBe(true);
    expect(rowButton(local, 'Delete').disabled).toBe(true);
    expect(localNodes.find((n) => n.className === 'provider-note')?.textContent).toMatch(/make another provider the default/);
    expect(rowButton(router, 'Set default').disabled).toBe(false);
    expect(rowButton(router, 'Delete').disabled).toBe(false);
  });

  it('Add pre-fills per kind, posts name, kind, URL and the typed key, then clears the key and reloads', async () => {
    const created: ProviderView = { id: 'p-1a2b3c4d', name: 'Router two', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true };
    const page = await apiPage(settingsResponse(), {
      route: (request, setState) => {
        if (request.method !== 'POST' || request.url !== '/ai-providers') return undefined;
        const next = settingsResponse({ aiProviders: [LOCAL, created] });
        setState(next);
        return Response.json(next, { status: 201 });
      },
    });
    const { el } = page;
    await el('addProvider').click();
    expect(el('providerForm').hidden).toBe(false);
    expect(el('providerKindField').hidden).toBe(false);
    expect(el('providerKind').value).toBe('openrouter');
    expect(el('providerName').value).toBe('OpenRouter');
    expect(el('providerBaseUrl').value).toBe('https://openrouter.ai/api/v1');
    expect(el('providerKeyField').hidden).toBe(false);
    expect(el('providerKeyHelp').textContent).toContain('OpenRouter requires an API key');
    el('providerName').value = 'Router two';
    el('providerApiKey').value = 'fixture-new-key';
    await el('providerForm').fire('submit');
    expect(calls(page.requests)).toEqual(['POST /ai-providers', 'GET /settings']);
    expect(page.requests[0]!.body).toEqual({
      name: 'Router two', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-new-key',
    });
    expect(el('providerApiKey').value).toBe('');
    expect(el('providerForm').hidden).toBe(true);
    expect(el('providersOut').textContent).toContain('Added “Router two”');
    expect(descendants(providerRow(el, 'Router two')).map((n) => n.textContent)).toContain('OpenRouter · Key stored');
    expect(pageText(el)).not.toContain('fixture-new-key');
  });

  it('changing the kind pre-fills URL and name without clobbering typed values, and a local kind drops the key', async () => {
    const { el } = await apiPage(settingsResponse());
    await el('addProvider').click();
    el('providerKind').value = 'deepseek';
    await el('providerKind').fire('change');
    expect(el('providerName').value).toBe('DeepSeek');
    expect(el('providerBaseUrl').value).toBe('https://api.deepseek.com/v1');
    el('providerName').value = 'Proxy';
    el('providerBaseUrl').value = 'https://proxy.example/v1';
    el('providerKind').value = 'custom';
    await el('providerKind').fire('change');
    expect(el('providerName').value).toBe('Proxy');
    expect(el('providerBaseUrl').value).toBe('https://proxy.example/v1');
    expect(el('providerKeyHelp').textContent).toContain('Only needed if your endpoint requires one');
    el('providerApiKey').value = 'fixture-typed';
    el('providerKind').value = 'lm-studio';
    await el('providerKind').fire('change');
    expect(el('providerApiKey').value).toBe('');
    expect(el('providerKeyField').hidden).toBe(true);
  });

  it('editing the URL of a provider with a stored key warns, and saving asks with both URLs named', async () => {
    let approve = false;
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER], reviewProviderId: 'openrouter' });
    const page = await apiPage(state, {
      confirm: () => approve,
      route: (request) => (request.method === 'PUT' ? Response.json(state) : undefined),
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    expect(el('providerKindField').hidden).toBe(true);
    expect(el('providerName').value).toBe('OpenRouter');
    expect(el('providerBaseUrl').value).toBe(ROUTER.baseUrl);
    expect(el('providerApiKey').value).toBe('');
    expect(el('removeProviderKey').hidden).toBe(false);
    expect(providerRow(el, 'OpenRouter').children).toContain(el('providerForm'));

    el('providerBaseUrl').value = 'https://proxy.example/v1';
    await el('providerBaseUrl').fire('input');
    expect(el('providerKeyMoveWarning').hidden).toBe(false);
    expect(el('providerKeyMoveWarning').textContent).toContain('https://proxy.example/v1');
    expect(el('providerKeyMoveWarning').textContent).toContain(ROUTER.baseUrl);

    await el('providerForm').fire('submit');
    expect(page.questions).toHaveLength(1);
    expect(page.questions[0]!.body).toContain('https://proxy.example/v1');
    expect(page.questions[0]!.body).toContain(ROUTER.baseUrl);
    expect(page.questions[0]!.body).toContain(EDITOR_COPY.settingsWriting);
    expect(page.requests).toEqual([]);
    expect(el('providerForm').hidden).toBe(false);

    approve = true;
    await el('providerForm').fire('submit');
    expect(page.requests[0]).toEqual({
      url: '/ai-providers/openrouter', method: 'PUT', body: { name: 'OpenRouter', baseUrl: 'https://proxy.example/v1' },
    });
  });

  it('a typed replacement key travels with the new URL, so nothing stored moves and no confirm is needed', async () => {
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER] });
    const page = await apiPage(state, { route: (request) => (request.method === 'PUT' ? Response.json(state) : undefined) });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    el('providerBaseUrl').value = 'https://proxy.example/v1';
    el('providerApiKey').value = 'fixture-replacement';
    await el('providerApiKey').fire('input');
    expect(el('providerKeyMoveWarning').hidden).toBe(true);
    await el('providerForm').fire('submit');
    expect(page.questions).toEqual([]);
    expect(page.requests[0]!.body).toEqual({ name: 'OpenRouter', baseUrl: 'https://proxy.example/v1', apiKey: 'fixture-replacement' });
    expect(el('providerApiKey').value).toBe('');
  });

  it('warns about plain HTTP for remote kinds only, and passes mixed-content warnings through', async () => {
    const { el } = await apiPage(settingsResponse(), {
      mixedContentWarning: (url) => (url.startsWith('http://lan.example') ? 'fixture mixed content' : ''),
    });
    await el('addProvider').click();
    el('providerKind').value = 'custom';
    await el('providerKind').fire('change');
    el('providerBaseUrl').value = 'http://192.168.1.5:8080/v1';
    await el('providerBaseUrl').fire('input');
    expect(el('providerUrlWarning').hidden).toBe(false);
    expect(el('providerUrlWarning').textContent).toContain('Plain HTTP');
    el('providerBaseUrl').value = 'http://localhost:8080/v1';
    await el('providerBaseUrl').fire('input');
    expect(el('providerUrlWarning').hidden).toBe(true);
    el('providerKind').value = 'lm-studio';
    await el('providerKind').fire('change');
    el('providerBaseUrl').value = 'http://192.168.1.5:1234/v1';
    await el('providerBaseUrl').fire('input');
    expect(el('providerUrlWarning').hidden).toBe(true);
    el('providerBaseUrl').value = 'http://lan.example:1234/v1';
    await el('providerBaseUrl').fire('input');
    expect(el('providerUrlWarning').textContent).toBe('fixture mixed content');
  });

  it('Delete refuses an assigned provider without a request, and confirms the scope before deleting another', async () => {
    let approve = false;
    const keyed = { ...DEEPSEEK, hasApiKey: true };
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER, keyed], reviewProviderId: 'openrouter' });
    const page = await apiPage(state, {
      confirm: () => approve,
      route: (request, setState) => {
        if (request.method !== 'DELETE') return undefined;
        const next = { ...state, aiProviders: [LOCAL, ROUTER] };
        setState(next);
        return Response.json(next);
      },
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Delete').click();
    expect(page.questions).toEqual([]);
    expect(page.requests).toEqual([]);
    expect(el('providersOut').textContent).toContain('“OpenRouter” is assigned to ' + EDITOR_COPY.settingsWriting);

    await rowButton(providerRow(el, 'DeepSeek'), 'Delete').click();
    expect(page.questions[0]).toMatchObject({ title: 'Delete “DeepSeek”?', confirmLabel: 'Delete provider', danger: true });
    expect(page.questions[0]!.body).toContain(DEEPSEEK.baseUrl);
    expect(page.questions[0]!.body).toContain('stored API key');
    expect(page.requests).toEqual([]);

    approve = true;
    await rowButton(providerRow(el, 'DeepSeek'), 'Delete').click();
    expect(calls(page.requests)).toEqual(['DELETE /ai-providers/deepseek', 'GET /settings']);
    expect(el('providersOut').textContent).toBe('Deleted “DeepSeek”.');
    expect(() => providerRow(el, 'DeepSeek')).toThrow();
  });

  it('surfaces the server\'s provider_in_use refusal with the use cases named', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => (request.method === 'DELETE' ? Response.json({
        code: 'provider_in_use', error: 'This provider is assigned to a use case.', useCases: ['caption', '__proto__'],
      }, { status: 409 }) : undefined),
    });
    await rowButton(providerRow(page.el, 'OpenRouter'), 'Delete').click();
    expect(calls(page.requests)).toEqual(['DELETE /ai-providers/openrouter', 'GET /settings']);
    expect(page.el('providersOut').textContent).toBe(
      '“OpenRouter” is assigned to ' + EDITOR_COPY.settingsCaptions + '. Assign another provider there first, then delete it.');
    expect(providerRow(page.el, 'OpenRouter')).toBeDefined();
  });

  it('Set default confirms when a use case following the default would move, and posts only the default', async () => {
    let approve = false;
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), { confirm: () => approve });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Set default').click();
    expect(page.questions).toHaveLength(1);
    for (const part of [EDITOR_COPY.settingsWriting, EDITOR_COPY.settingsCaptions, EDITOR_COPY.settingsTranslation, ROUTER.baseUrl, LOCAL.baseUrl]) {
      expect(page.questions[0]!.body).toContain(part);
    }
    expect(page.requests).toEqual([]);

    approve = true;
    await rowButton(providerRow(el, 'OpenRouter'), 'Set default').click();
    expect(calls(page.requests)).toEqual(['POST /settings', 'GET /settings']);
    expect(page.requests[0]!.body).toEqual({ aiDefaultProviderId: 'openrouter' });
    expect(rowButton(providerRow(el, 'OpenRouter'), 'Set default').disabled).toBe(true);
    expect(el('reviewProviderId').children[0]!.textContent).toBe('Default — OpenRouter');
  });

  it('Set default does not ask when every use case is explicitly assigned', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], reviewProviderId: 'lm-studio', captionProviderId: 'lm-studio', translationProviderId: 'lm-studio' }));
    await rowButton(providerRow(page.el, 'OpenRouter'), 'Set default').click();
    expect(page.questions).toEqual([]);
    expect(page.requests[0]).toEqual({ url: '/settings', method: 'POST', body: { aiDefaultProviderId: 'openrouter' } });
  });

  it('Remove stored key is its own confirmed action that sends apiKey null', async () => {
    let approve = false;
    const state = settingsResponse({ aiProviders: [LOCAL, ROUTER], reviewProviderId: 'openrouter' });
    const page = await apiPage(state, {
      confirm: () => approve,
      route: (request, setState) => {
        if (request.method !== 'PUT') return undefined;
        const next = { ...state, aiProviders: [LOCAL, { ...ROUTER, hasApiKey: false }] };
        setState(next);
        return Response.json(next);
      },
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    await el('removeProviderKey').click();
    expect(page.questions[0]).toMatchObject({ confirmLabel: 'Remove key', danger: true });
    expect(page.questions[0]!.body).toContain(EDITOR_COPY.settingsWriting);
    expect(page.questions[0]!.body).toContain(ROUTER.baseUrl);
    expect(page.requests).toEqual([]);

    approve = true;
    await el('removeProviderKey').click();
    expect(page.requests[0]).toEqual({ url: '/ai-providers/openrouter', method: 'PUT', body: { apiKey: null } });
    expect(el('providerForm').hidden).toBe(true);
    expect(el('providersOut').textContent).toBe('Removed the stored key for “OpenRouter”.');
    expect(descendants(providerRow(el, 'OpenRouter')).map((n) => n.textContent)).toContain('OpenRouter · No key');
  });

  it('a partial failure shows the server text once, clears the typed key and reloads', async () => {
    const error = 'API key change saved, but settings were not saved. Reload settings before retrying.';
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => (request.method === 'PUT'
        ? Response.json({ code: 'settings_partial_failure', error }, { status: 500 }) : undefined),
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    el('providerName').value = 'Renamed';
    el('providerApiKey').value = 'fixture-partial-key';
    await el('providerForm').fire('submit');
    expect(calls(page.requests)).toEqual(['PUT /ai-providers/openrouter', 'GET /settings']);
    expect(el('providerApiKey').value).toBe('');
    expect(el('providerForm').hidden).toBe(true);
    expect(el('providersOut').textContent).toBe(error);
    expect(pageText(el)).not.toContain('fixture-partial-key');
  });

  it('a refused save keeps the form for a fix but still clears the key and reloads', async () => {
    const page = await apiPage(settingsResponse(), {
      route: (request) => (request.method === 'POST' && request.url === '/ai-providers'
        ? Response.json({ error: 'A provider with that name already exists.' }, { status: 400 }) : undefined),
    });
    const { el } = page;
    await el('addProvider').click();
    el('providerApiKey').value = 'fixture-refused-key';
    await el('providerForm').fire('submit');
    expect(calls(page.requests)).toEqual(['POST /ai-providers', 'GET /settings']);
    expect(el('providerForm').hidden).toBe(false);
    expect(el('providerFormOut').textContent).toBe('A provider with that name already exists.');
    expect(el('providerApiKey').value).toBe('');
  });

  it('names an unknown outcome and the reload guidance after a dropped connection', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => { if (request.method === 'PUT') throw NETWORK_DOWN; return undefined; },
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    el('providerApiKey').value = 'fixture-lost-key';
    await el('providerForm').fire('submit');
    expect(el('providersOut').textContent).toBe('The outcome is unknown. Reload settings before retrying.');
    expect(el('providerApiKey').value).toBe('');
  });

  it('Test loads a remote provider\'s stored key via /credential, lists models with it and keeps it out of the page', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], captionProviderId: 'openrouter' }), {
      route: (request) => (request.url === '/ai-providers/openrouter/credential' ? Response.json({ apiKey: 'fixture-stored-key' }) : undefined),
      listModels: async () => ['vision-a', 'vision-b'],
    });
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Test').click();
    expect(calls(page.requests)).toEqual(['GET /ai-providers/openrouter/credential']);
    expect(page.listModels.mock.calls).toEqual([[ROUTER.baseUrl, 'fixture-stored-key']]);
    expect(rowStatus(providerRow(el, 'OpenRouter'))).toBe('Reachable from this browser · 2 models listed.');
    // The result fills the dropdown of every use case on that provider.
    expect(modelOptions(el, 'lmModel')).toEqual(['vision-model (saved, not listed)', 'vision-a', 'vision-b', 'Other model ID…']);
    expect(el('captionModelStatus').textContent).toBe('2 models listed by OpenRouter.');
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model', 'Other model ID…']);
    expect(pageText(el)).not.toContain('fixture-stored-key');
    expect(el('providerApiKey').value).toBe('');
  });

  it('Test with the form open uses the typed key, and never sends the stored key to an unsaved URL', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }));
    const { el } = page;
    await rowButton(providerRow(el, 'OpenRouter'), 'Edit').click();
    el('providerApiKey').value = 'fixture-typed-key';
    await rowButton(providerRow(el, 'OpenRouter'), 'Test').click();
    expect(page.listModels.mock.calls).toEqual([[ROUTER.baseUrl, 'fixture-typed-key']]);
    expect(page.requests).toEqual([]);

    el('providerApiKey').value = '';
    el('providerBaseUrl').value = 'https://proxy.example/v1';
    await el('testProviderForm').click();
    expect(el('providerFormOut').textContent).toContain('Save the new URL before testing it with the stored key');
    expect(page.requests).toEqual([]);
    expect(page.listModels).toHaveBeenCalledTimes(1);
  });

  it('Test refuses a key-requiring provider without a key, and reports an unreachable one', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, DEEPSEEK] }), {
      listModels: async () => { throw new Error('fixture-provider-detail'); },
    });
    const { el } = page;
    await rowButton(providerRow(el, 'DeepSeek'), 'Test').click();
    expect(rowStatus(providerRow(el, 'DeepSeek'))).toBe('DeepSeek needs an API key. Edit the provider to add one.');
    expect(page.listModels).not.toHaveBeenCalled();
    await rowButton(providerRow(el, 'Local LM Studio'), 'Test').click();
    expect(page.listModels.mock.calls).toEqual([[LOCAL.baseUrl, null]]);
    expect(rowStatus(providerRow(el, 'Local LM Studio'))).toMatch(/^Could not list models/);
    expect(page.requests).toEqual([]);
  });
});

describe('settings.html model lists', () => {
  const CUSTOM: ProviderView = { id: 'p-custom', name: 'Custom', kind: 'custom', baseUrl: 'https://custom.example/v1', hasApiKey: false };
  const storedKey = (request: ApiRequest) => (request.url === '/ai-providers/openrouter/credential'
    ? Response.json({ apiKey: 'fixture-stored-key' }) : undefined);

  /** A listModels whose answers the test releases per base URL. */
  function deferredLists() {
    const pending = new Map<string, PromiseWithResolvers<string[]>>();
    const forUrl = (baseUrl: string) => {
      let entry = pending.get(baseUrl);
      if (!entry) { entry = Promise.withResolvers<string[]>(); pending.set(baseUrl, entry); }
      return entry;
    };
    return { listModels: (baseUrl: string) => forUrl(baseUrl).promise, forUrl };
  }

  it('showing AI models lists every assigned provider once — local without a key, remote with its stored key', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK], captionProviderId: 'openrouter' }), {
      route: storedKey,
      listModels: async (baseUrl) => (baseUrl === LOCAL.baseUrl
        ? ['b-model', 'review-model', 'a-model', 'A-model', 'b-model'] : ['vision-b', 'Vision-a']),
    });
    const { el } = page;
    await callPage(page.ctx, 'init');
    // DeepSeek is assigned to nothing, so it is never contacted.
    expect(calls(page.requests)).toEqual(['GET /settings', 'GET /ai-providers/openrouter/credential']);
    expect(page.listModels.mock.calls).toEqual([[LOCAL.baseUrl, null], [ROUTER.baseUrl, 'fixture-stored-key']]);
    // Sorted case-insensitively and de-duplicated; a listed saved model is just selected.
    expect(modelOptions(el, 'aiModel')).toEqual(['A-model', 'a-model', 'b-model', 'review-model', 'Other model ID…']);
    expect(el('aiModel').value).toBe('review-model');
    expect(el('reviewModelStatus').textContent).toBe('4 models listed by Local LM Studio.');
    expect(modelOptions(el, 'lmModel')).toEqual(['vision-model (saved, not listed)', 'Vision-a', 'vision-b', 'Other model ID…']);
    expect(el('lmModel').value).toBe('vision-model');
    expect(el('lmModel').attrs['aria-busy']).toBe('false');
    expect(el('captionModelsReload').attrs['aria-label']).toBe('Reload models from OpenRouter');
    expect(pageText(el)).not.toContain('fixture-stored-key');
  });

  it('all three use cases on one provider share a single lookup', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], aiDefaultProviderId: 'openrouter' }), { route: storedKey });
    await callPage(page.ctx, 'init');
    expect(calls(page.requests)).toEqual(['GET /settings', 'GET /ai-providers/openrouter/credential']);
    expect(page.listModels).toHaveBeenCalledTimes(1);
    expect(modelOptions(page.el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'model-a', 'model-b', 'Other model ID…']);
    expect(modelOptions(page.el, 'lmModel')).toEqual(['vision-model (saved, not listed)', 'model-a', 'model-b', 'Other model ID…']);
  });

  it('a page opened on another tab looks models up when AI models is shown, once per page load', async () => {
    const page = await apiPage(settingsResponse(), { hash: '#images' });
    await callPage(page.ctx, 'init');
    expect(page.listModels).not.toHaveBeenCalled();
    await page.el('tabbtn-ai-models').click();
    await callPage(page.ctx, 'ensureModels');
    expect(page.listModels).toHaveBeenCalledTimes(1);
    await page.el('tabbtn-images').click();
    await page.el('tabbtn-ai-models').click();
    await callPage(page.ctx, 'ensureModels');
    expect(page.listModels).toHaveBeenCalledTimes(1);
    expect(modelOptions(page.el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'model-a', 'model-b', 'Other model ID…']);
  });

  it('shows the saved model while loading, and a slower lookup never lands in a row that moved on', async () => {
    const lists = deferredLists();
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, CUSTOM] }), { listModels: lists.listModels });
    const { el, ctx } = page;
    const localLookup = callPage(ctx, 'ensureModels');
    expect(el('aiModel').attrs['aria-busy']).toBe('true');
    expect(el('reviewModelStatus').textContent).toBe('Loading models…');
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model', 'Other model ID…']);
    expect(el('aiModel').value).toBe('review-model');
    expect(el('reviewModelsReload').disabled).toBe(true);

    el('reviewProviderId').value = CUSTOM.id;
    await el('reviewProviderId').fire('change');
    expect(page.listModels.mock.calls).toEqual([[LOCAL.baseUrl, null], [CUSTOM.baseUrl, null]]);
    lists.forUrl(CUSTOM.baseUrl).resolve(['c-1']);
    // Drain the microtask queue (no clock involved): the page awaits a promise from
    // this realm, which takes extra turns to settle across the vm boundary.
    const drained = Promise.withResolvers<void>();
    setImmediate(drained.resolve);
    await drained.promise;
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'c-1', 'Other model ID…']);
    expect(el('reviewModelStatus').textContent).toBe('1 model listed by Custom.');

    lists.forUrl(LOCAL.baseUrl).resolve(['l-1']);
    await localLookup;
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'c-1', 'Other model ID…']);
    expect(modelOptions(el, 'lmModel')).toEqual(['vision-model (saved, not listed)', 'l-1', 'Other model ID…']);
  });

  it('a pick the next provider does not list moves to “Other model ID…” instead of vanishing', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, CUSTOM] }), {
      listModels: async (baseUrl) => (baseUrl === LOCAL.baseUrl ? ['model-a'] : ['c-1']),
    });
    const { el, ctx } = page;
    await callPage(ctx, 'ensureModels');
    await chooseModel(el, 'aiModel', 'model-a');
    el('reviewProviderId').value = CUSTOM.id;
    await el('reviewProviderId').fire('change');
    await callPage(ctx, 'ensureModels');
    expect(el('reviewModelOther').hidden).toBe(false);
    expect(el('aiModelOther').value).toBe('model-a');
    expect(el('reviewResolved').textContent).toBe('→ Custom / model-a');
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'c-1', 'Other model ID…']);
  });

  it('a failed lookup keeps the saved model and Other without exposing provider text', async () => {
    const page = await apiPage(settingsResponse(), {
      listModels: async () => { throw new Error('fixture-provider-detail'); },
    });
    const { el } = page;
    await callPage(page.ctx, 'init');
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model', 'Other model ID…']);
    expect(el('aiModel').value).toBe('review-model');
    expect(el('aiModel').attrs['aria-busy']).toBe('false');
    expect(pageText(el)).not.toContain('fixture-provider-detail');
  });

  it('a stored key that cannot be loaded, or a missing required key, fails without asking the provider', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK], reviewProviderId: 'openrouter', captionProviderId: 'deepseek', translationProviderId: 'openrouter' }), {
      route: (request) => (request.url.endsWith('/credential') ? Response.json({ error: 'Secrets unavailable.' }, { status: 503 }) : undefined),
    });
    const { el } = page;
    await callPage(page.ctx, 'init');
    expect(page.listModels).not.toHaveBeenCalled();
    expect(el('lmModel').attrs['aria-busy']).toBe('false');
  });

  it('the row\'s reload button lists again, even after a successful lookup', async () => {
    let round = 0;
    const page = await apiPage(settingsResponse(), { listModels: async () => (++round === 1 ? ['model-a'] : ['model-a', 'model-new']) });
    const { el } = page;
    await callPage(page.ctx, 'init');
    expect(el('reviewModelsReload').attrs['aria-label']).toBe('Reload models from Local LM Studio');
    await el('reviewModelsReload').click();
    expect(page.listModels).toHaveBeenCalledTimes(2);
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model (saved, not listed)', 'model-a', 'model-new', 'Other model ID…']);
  });
});

describe('settings.html use case assignments', () => {
  it('saves an independent translation assignment without changing review/photo values or the separate provider draft', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, DEEPSEEK] }), { hash: '#images' });
    const { el } = page;
    await el('addProvider').click();
    el('providerName').value = 'Pending provider';
    el('providerApiKey').value = 'fixture-keep-request-local';
    await el('providerForm').fire('input');
    el('translationProviderId').value = 'deepseek';
    await el('translationProviderId').fire('change');
    expect(el('translationProviderWarn').textContent).toContain('“DeepSeek” has no stored API key');
    await chooseModel(el, 'translationModel', 'Other model ID…');
    el('translationModelOtherInput').value = ' translation-2 ';
    await el('translationModelOtherInput').fire('input');
    el('translationTimeoutSeconds').value = '130.123';
    await el('useCaseSection').fire('input');
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toEqual({
      reviewProviderId: null, captionProviderId: null, aiModel: 'review-model', lmModel: 'vision-model',
      reviewPrompt: 'Review prompt', reviewTimeoutMs: 60000, captionPrompt: 'Caption prompt',
      captionTimeoutMs: 60000, captionMaxEdge: 768, captionMaxTokens: 8000,
      translationProviderId: 'deepseek', translationModel: 'translation-2', translationTimeoutMs: 130123,
      translationPrompt: 'Translation prompt',
    });
    expect(el('translationModel').value).toBe('translation-2');
    expect(el('translationModelOther').hidden).toBe(true);
    expect(el('aiOut').textContent).toBe(EDITOR_COPY.writingSaved);
    expect(el('translationResolved').textContent).toBe('→ DeepSeek / translation-2');
    expect(el('reviewModelOther').hidden).toBe(true);
    expect(el('aiModel').value).toBe('review-model');
    expect(el('lmModel').value).toBe('vision-model');
    expect(el('providerName').value).toBe('Pending provider');
    expect(el('providerApiKey').value).toBe('fixture-keep-request-local');
    expect(el('settingsDraftStatus').textContent).not.toContain(EDITOR_COPY.settingsAiSection);
    expect(el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsProvider);
    expect(page.storageWrite).not.toHaveBeenCalled();
    expect(pageText(el)).not.toContain('fixture-keep-request-local');
  });

  it('a registry/default refresh preserves pending translation model and timeout until the shared AI save', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), { hash: '#images' });
    await chooseModel(page.el, 'translationModel', 'Other model ID…');
    page.el('translationModelOtherInput').value = 'pending-translation';
    await page.el('translationModelOtherInput').fire('input');
    page.el('translationTimeoutSeconds').value = '200';
    await page.el('useCaseSection').fire('input');
    await rowButton(providerRow(page.el, ROUTER.name), 'Set default').click();
    expect(page.el('translationModelOtherInput').value).toBe('pending-translation');
    expect(page.el('translationTimeoutSeconds').value).toBe('200');
    expect(page.el('translationDestination').textContent).toBe(ROUTER.baseUrl);
    expect(page.el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsAiSection);
    await page.el('saveAi').click();
    expect(page.requests.at(-1)!.body).toMatchObject({
      translationProviderId: null, translationModel: 'pending-translation', translationTimeoutMs: 200000,
    });
    expect(page.el('settingsDraftStatus').textContent).not.toContain(EDITOR_COPY.settingsAiSection);
  });

  it('retains a refused translation save and blocks retry when the registry refresh fails', async () => {
    let failedRefresh = false;
    const page = await apiPage(settingsResponse(), {
      hash: '#images',
      route(request) {
        if (request.method === 'POST') {
          failedRefresh = true;
          return Response.json({ error: 'Translation timeout is out of range.' }, { status: 400 });
        }
        return failedRefresh ? Response.json({}, { status: 503 }) : undefined;
      },
    });
    page.el('translationTimeoutSeconds').value = '301';
    await page.el('useCaseSection').fire('input');
    await page.el('saveAi').click();
    expect(page.el('translationTimeoutSeconds').value).toBe('301');
    expect(page.el('aiOut').textContent).toContain('Translation timeout is out of range.');
    expect(page.el('aiOut').textContent).toContain(EDITOR_COPY.settingsRegistryUnavailable);
    expect(page.el('saveAi').disabled).toBe(true);
    const before = page.requests.length;
    await page.el('saveAi').click();
    expect(page.requests).toHaveLength(before);
    expect(page.el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsAiSection);
  });

  it('names a saved translation assignment when refusing provider deletion', async () => {
    const page = await apiPage(settingsResponse({
      aiProviders: [LOCAL, ROUTER], translationProviderId: 'openrouter',
    }), { hash: '#images' });
    await rowButton(providerRow(page.el, ROUTER.name), 'Delete').click();
    expect(page.requests).toEqual([]);
    expect(page.el('providersOut').textContent).toContain(EDITOR_COPY.settingsTranslation);
  });

  it('offers Default — <name> first, and the resolved line follows the selection and model live', async () => {
    const { el } = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], captionProviderId: 'openrouter' }));
    const options = el('reviewProviderId').children;
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Default — Local LM Studio'], ['lm-studio', 'Local LM Studio'], ['openrouter', 'OpenRouter'],
    ]);
    expect(el('reviewProviderId').value).toBe('');
    expect(el('captionProviderId').value).toBe('openrouter');
    expect(el('reviewResolved').textContent).toBe('→ Local LM Studio / review-model');
    expect(el('reviewDestination').textContent).toBe(LOCAL.baseUrl);
    expect(el('captionResolved').textContent).toBe('→ OpenRouter / vision-model');

    el('reviewProviderId').value = 'openrouter';
    await el('reviewProviderId').fire('change');
    expect(el('reviewResolved').textContent).toBe('→ OpenRouter / review-model');
    expect(el('reviewDestination').textContent).toBe(ROUTER.baseUrl);
    await chooseModel(el, 'aiModel', 'Other model ID…');
    expect(el('reviewModelOther').hidden).toBe(false);
    expect(el('aiModelOther').focused).toBe(true);
    expect(el('reviewResolved').textContent).toBe('→ OpenRouter / no model set');
    el('aiModelOther').value = ' typed-model ';
    await el('aiModelOther').fire('input');
    expect(el('reviewResolved').textContent).toBe('→ OpenRouter / typed-model');
  });

  it('warns when the assigned provider needs a key it does not have', async () => {
    const { el } = await apiPage(settingsResponse({ aiProviders: [LOCAL, DEEPSEEK], captionProviderId: 'deepseek' }));
    expect(el('captionProviderWarn').hidden).toBe(false);
    expect(el('captionProviderWarn').textContent).toContain('“DeepSeek” has no stored API key');
    expect(el('reviewProviderWarn').hidden).toBe(true);
  });

  it('Save AI settings posts exactly the AI fields — the picked model, or the trimmed Other ID — with null for Default', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], captionProviderId: 'openrouter' }), {
      route: (request) => (request.url === '/ai-providers/openrouter/credential' ? Response.json({ apiKey: 'fixture-stored-key' }) : undefined),
      listModels: async () => ['vision-2'],
    });
    const { el } = page;
    await callPage(page.ctx, 'ensureModels');
    page.requests.length = 0;
    await chooseModel(el, 'lmModel', 'vision-2');
    await chooseModel(el, 'aiModel', 'Other model ID…');
    el('aiModelOther').value = ' review-2 ';
    await el('aiModelOther').fire('input');
    el('reviewProviderId').value = 'openrouter';
    el('captionProviderId').value = '';
    el('reviewPrompt').value = 'R';
    el('reviewTimeoutSeconds').value = '45.123';
    el('captionPrompt').value = 'C';
    el('captionTimeoutSeconds').value = '30.001';
    el('captionMaxEdge').value = '1024';
    el('captionMaxTokens').value = '4096';
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toEqual({
      reviewProviderId: 'openrouter', captionProviderId: null, aiModel: 'review-2', lmModel: 'vision-2',
      reviewPrompt: 'R', reviewTimeoutMs: 45123, captionPrompt: 'C', captionTimeoutMs: 30001, captionMaxEdge: 1024,
      captionMaxTokens: 4096,
      translationProviderId: null, translationModel: 'translation-model', translationTimeoutMs: 120000,
      translationPrompt: 'Translation prompt',
    });
    // The saved values come back as the new "saved" models; Other closes.
    expect(el('aiModel').value).toBe('review-2');
    expect(el('reviewModelOther').hidden).toBe(true);
    expect(el('aiOut').textContent).toBe(EDITOR_COPY.writingSaved);
    expect(el('reviewProviderId').value).toBe('openrouter');
    expect(el('captionProviderId').value).toBe('');
    expect(el('saveAi').disabled).toBe(false);
  });

  it('a refused AI save keeps the pending edits and reloads the registry', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER] }), {
      route: (request) => (request.method === 'POST' && request.url === '/settings'
        ? Response.json({ error: 'Review timeout is out of range.' }, { status: 400 }) : undefined),
    });
    const { el } = page;
    el('aiModel').value = 'pending-model';
    await el('aiModel').fire('change');
    el('reviewProviderId').value = 'openrouter';
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings', 'GET /settings']);
    expect(el('aiOut').textContent).toBe('Review timeout is out of range.');
    expect(el('aiModel').value).toBe('pending-model');
    expect(el('reviewProviderId').value).toBe('openrouter');
  });

  it('provider actions keep pending assignment edits', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], captionProviderId: 'lm-studio' }));
    const { el } = page;
    el('reviewProviderId').value = 'openrouter';
    el('aiModel').value = 'pending-model';
    await el('aiModel').fire('change');
    await rowButton(providerRow(el, 'OpenRouter'), 'Set default').click();
    expect(el('reviewProviderId').value).toBe('openrouter');
    expect(el('aiModel').value).toBe('pending-model');
    expect(el('captionProviderId').children[0]!.textContent).toBe('Default — OpenRouter');
  });

  it('Save settings on the site tab posts only the site fields', async () => {
    const page = await apiPage(settingsResponse());
    page.el('backupSchedule').value = 'weekly';
    await page.el('save').click();
    expect(Object.keys(page.requests[0]!.body ?? {}).sort()).toEqual(['backupRetention', 'backupSchedule', 'importDelayMs', 'importRetries']);
  });
});

describe('settings.html translation instructions', () => {
  const MAX = TRANSLATION_PROMPT_RULE.TRANSLATION_PROMPT_MAX_LENGTH;
  const DESCRIBED_BY = 'translationPromptHelp translationPromptCount';
  const counted = (length: number) => length + ' of ' + MAX + ' characters';

  /**
   * The stub tree is flat, so the textarea is hung under its real disclosure:
   * AdminField places its error line beside it, and events bubble on from there.
   */
  async function promptPage(overrides: Partial<SettingsResponse> = {}) {
    const page = await apiPage(settingsResponse(overrides));
    const advanced = page.el('translationAdvanced');
    const field = page.el('translationPrompt');
    advanced.appendChild(field);
    /** The line AdminField adds directly under the field, once it has refused a value. */
    const error = () => advanced.children[advanced.children.indexOf(field) + 1];
    return { ...page, field, advanced, error, doc: documentOf(page) };
  }
  /** One edit as a browser reports it: the value changes, then a bubbling input event. */
  const type = (field: Element, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('shows the saved instructions with their character count and makes Reset available', async () => {
    const saved = 'Use informal “du” in German.\n\tKeep place names in the local spelling.';
    const page = loadSettingsPage();
    const { el } = page;
    el('translationPromptReset').disabled = true; // as the markup ships it, until settings arrive
    await callPage(page.ctx, 'fill', settingsResponse({ translationPrompt: saved }));
    expect(el('translationPrompt').value).toBe(saved);
    expect(el('translationPromptCount').textContent).toBe(counted(saved.length));
    // The count is read with the field, never announced while typing.
    expect(el('translationPrompt').getAttribute('aria-describedby')).toBe(DESCRIBED_BY);
    expect(el('translationPromptCount').getAttribute('role')).toBeNull();
    expect(el('translationPromptReset').disabled).toBe(false);
    expect(el('settingsDraftBar').hidden).toBe(true);
  });

  it('keeps Reset unavailable when the settings response carries no usable default', async () => {
    const page = await promptPage({ translationPrompt: 'Custom house style', translationPromptDefault: ' ' });
    expect(page.el('translationPromptReset').disabled).toBe(true);
    await page.el('translationPromptReset').click();
    expect(page.field.value).toBe('Custom house style');
    expect(page.el('aiOut').textContent).toBe('');
    expect(page.el('settingsDraftBar').hidden).toBe(true);
  });

  it('marks the AI section unsaved while typing and reports an over-limit count in words', async () => {
    const page = await promptPage();
    const { el, field } = page;
    type(field, 'x'.repeat(MAX));
    expect(el('translationPromptCount').textContent).toBe(counted(MAX));
    expect(el('settingsDraftBar').hidden).toBe(false);
    expect(el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsAiSection);
    type(field, 'x'.repeat(MAX + 12));
    expect(el('translationPromptCount').textContent).toBe((MAX + 12) + ' of ' + MAX + ' characters, 12 too many');
    expect(field.value).toHaveLength(MAX + 12); // nothing is cut off
    type(field, 'Kurz.');
    expect(el('translationPromptCount').textContent).toBe(counted(5));
    expect(page.doc.activeElement).not.toBe(field); // typing never moves focus
    expect(page.requests).toEqual([]);
  });

  it.each([
    ['multi-line instructions with surrounding whitespace', '  Use informal “du” in German.\n\tKeep place names in the local spelling.\n'],
    ['instructions at exactly the limit', 'x'.repeat(MAX)],
  ])('Save AI settings sends %s verbatim', async (_name, custom) => {
    const page = await promptPage();
    const { el, field } = page;
    type(field, custom);
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toMatchObject({ translationPrompt: custom });
    expect(field.value).toBe(custom);
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(el('translationPromptCount').textContent).toBe(counted(custom.length));
    expect(el('aiOut').textContent).toBe(EDITOR_COPY.writingSaved);
    expect(el('settingsDraftBar').hidden).toBe(true);
  });

  it('Reset restores the default in the field only: unsaved, focused, announced, nothing sent', async () => {
    const page = await promptPage({ translationPrompt: 'Custom house style' });
    const { el, field } = page;
    await el('translationPromptReset').click();
    expect(field.value).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(el('translationPromptCount').textContent).toBe(counted(DEFAULT_TRANSLATION_PROMPT.length));
    expect(el('settingsDraftBar').hidden).toBe(false);
    expect(el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsAiSection);
    expect(page.doc.activeElement).toBe(field);
    expect(el('aiOut').textContent).toBe(EDITOR_COPY.settingsTranslationPromptRestored);
    expect(page.requests).toEqual([]);
    // Only Save AI settings applies it.
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toMatchObject({ translationPrompt: DEFAULT_TRANSLATION_PROMPT });
    expect(el('settingsDraftBar').hidden).toBe(true);
  });

  it.each([
    ['blank', '', EDITOR_COPY.settingsTranslationPromptRequired],
    ['whitespace-only', ' \n\t ', EDITOR_COPY.settingsTranslationPromptRequired],
    ['invisible-only', '\u200b\u2060', EDITOR_COPY.settingsTranslationPromptRequired],
    ['hidden-control', 'Line one\u000bLine two', EDITOR_COPY.settingsTranslationPromptHidden],
    ['over-limit with a hidden control', '\u000b' + 'x'.repeat(MAX),
      EDITOR_COPY.settingsTranslationPromptTooLong!.replace('{max}', String(MAX)).replace('{over}', '1')],
    ['over-limit', 'x'.repeat(MAX + 1),
      EDITOR_COPY.settingsTranslationPromptTooLong!.replace('{max}', String(MAX)).replace('{over}', '1')],
  ])('refuses %s instructions under the field without a request, and typing clears the error', async (_name, value, message) => {
    const page = await promptPage();
    const { el, field, advanced } = page;
    type(field, value);
    el('aiOut').textContent = EDITOR_COPY.writingSaved!; // a stale success must not sit beside the refusal
    expect(advanced.open).toBe(false);
    await el('saveAi').click();
    expect(page.requests).toEqual([]);
    expect(advanced.open).toBe(true);
    const error = page.error()!;
    expect(error.id).toBe('translationPromptError');
    expect(error.classList.contains('field-error')).toBe(true);
    expect(error.textContent).toBe(message);
    expect(error.textContent).not.toMatch(/[{}]/);
    expect(error.hidden).toBe(false);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(DESCRIBED_BY + ' translationPromptError');
    expect(page.doc.activeElement).toBe(field);
    expect(field.value).toBe(value);
    expect(el('aiOut').textContent).toBe('');
    expect(el('saveAi').disabled).toBe(false);
    expect(el('settingsDraftStatus').textContent).toContain(EDITOR_COPY.settingsAiSection);

    type(field, 'Keep place names in the local spelling.');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(error.hidden).toBe(true);
    expect(field.getAttribute('aria-describedby')).toBe(DESCRIBED_BY);
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toMatchObject({ translationPrompt: 'Keep place names in the local spelling.' });
  });

  it.each(['Reset', 'a fresh settings load'] as const)('%s clears a refused value’s error', async (recovery) => {
    const page = await promptPage();
    const { el, field } = page;
    type(field, '');
    await el('saveAi').click();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    if (recovery === 'Reset') await el('translationPromptReset').click();
    else await callPage(page.ctx, 'fill', settingsResponse());
    expect(field.value).toBe(recovery === 'Reset' ? DEFAULT_TRANSLATION_PROMPT : 'Translation prompt');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(page.error()!.hidden).toBe(true);
    expect(field.getAttribute('aria-describedby')).toBe(DESCRIBED_BY);
    expect(page.requests).toEqual([]);
  });
});

describe('settings.html AI configuration', () => {
  const validReview = {
    title: { status: 'pass', critique: '' },
    excerpt: { status: 'pass', critique: '' },
    headings: { status: 'pass', critique: '' },
    practicalDetails: { status: 'pass', critique: '', missingAspects: [] },
    internalLinks: { status: 'info', linkOpportunities: [] },
  };
  const completion = () => Response.json({ choices: [{ message: { content: JSON.stringify(validReview) } }] });
  const storedKey = async (url: string) => (url.endsWith('/credential') ? Response.json({ apiKey: 'fixture-stored' }) : completion());

  async function reviewPage(provider: ProviderView, network: (url: string, init?: RequestInit) => Promise<Response> = storedKey) {
    const fetcher = vi.fn(network);
    const page = loadSettingsPage({ fetch: fetcher, ...AI_MODELS_TAB });
    vm.runInContext(readFileSync('public/llm.js', 'utf8'), page.ctx);
    await callPage(page.ctx, 'fill', settingsResponse({
      aiProviders: provider.id === LOCAL.id ? [LOCAL] : [LOCAL, provider],
      reviewProviderId: provider.id, aiModel: 'selected-model',
    }));
    return { ...page, fetcher };
  }

  it('uses the selected remote provider\'s stored key from /credential, without saving', async () => {
    const { el, fetcher } = await reviewPage(ROUTER);
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-providers/openrouter/credential', 'https://openrouter.ai/api/v1/chat/completions']);
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-stored' });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ model: 'selected-model' });
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
    expect(el('testReview').disabled).toBe(false);
  });

  it('tests an unsaved selection against that provider and its own key', async () => {
    const keyed = { ...DEEPSEEK, hasApiKey: true };
    const { el, ctx, fetcher } = await reviewPage(LOCAL);
    await callPage(ctx, 'fill', settingsResponse({ aiProviders: [LOCAL, keyed], aiModel: 'selected-model' }));
    el('reviewProviderId').value = 'deepseek';
    await el('reviewProviderId').fire('change');
    await callPage(ctx, 'ensureModels');
    // Picking the provider listed its models with its own key: /models only, never a completion.
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      '/ai-providers/deepseek/credential', 'http://localhost:1234/v1/models', 'https://api.deepseek.com/v1/models',
    ]);
    fetcher.mockClear();
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-providers/deepseek/credential', 'https://api.deepseek.com/v1/chat/completions']);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ model: 'selected-model' });
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
  });

  it.each([DEEPSEEK, { ...ROUTER, hasApiKey: false }])('requires a stored key before contacting $name', async (provider) => {
    const { el, fetcher } = await reviewPage(provider);
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestMissingKey);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps local tests free of any key and of the credential route', async () => {
    const { el, fetcher } = await reviewPage(LOCAL);
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://localhost:1234/v1/chat/completions']);
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('Authorization');
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
  });

  it('requires a model id before contacting anyone', async () => {
    const { el, fetcher } = await reviewPage(LOCAL);
    await chooseModel(el, 'aiModel', 'Other model ID…');
    el('aiModelOther').value = ' ';
    await el('aiModelOther').fire('input');
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestModel);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'reviewTestAuthentication'], [402, 'reviewTestCredits'],
    [429, 'reviewTestRateLimit'], [503, 'reviewTestFailed'],
  ] as const)('reports HTTP %s without leaking provider response content', async (status, message) => {
    const { el } = await reviewPage(ROUTER, async (url) => (url.endsWith('/credential')
      ? Response.json({ apiKey: 'fixture-key' }) : new Response('fixture-secret-in-error', { status })));
    await el('testReview').click();
    expect(el('testReview').disabled).toBe(false);
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY[message]);
  });

  it('does not mistake an HTTP success with invalid model output for a working review configuration', async () => {
    const { el } = await reviewPage(LOCAL, async () => Response.json({ choices: [{ message: { content: 'hello' } }] }));
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestFailed);
  });

  it('does not contact a provider when the stored key cannot be loaded', async () => {
    const { el, fetcher } = await reviewPage(ROUTER, async () => new Response('', { status: 503 }));
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-providers/openrouter/credential']);
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestKeyUnavailable);
  });

  it('cancels an in-flight test when fields change and discards its result', async () => {
    const pending = Promise.withResolvers<Response>();
    const { el, fetcher } = await reviewPage(LOCAL, async () => pending.promise);
    const testing = el('testReview').click();
    await el('reviewProviderId').fire('change');
    pending.resolve(completion());
    await testing;
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(el('reviewTestOut').textContent).toBe('');
    expect(el('testReview').disabled).toBe(false);
  });

  it('bounds a stalled provider request and leaves the button usable', async () => {
    vi.useFakeTimers();
    try {
      const { el } = await reviewPage(LOCAL, async () => new Promise<Response>(() => {}));
      el('reviewTimeoutSeconds').value = '5';
      const testing = el('testReview').click();
      await vi.advanceTimersByTimeAsync(5000);
      await testing;
      expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestTimedOut);
      expect(el('testReview').disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

// Real authenticated /settings, /ai-providers and /ai-config handlers behind
// the page: a fabricated response once hid a key-isolation rule (#214).
describe('settings.html against the real settings and provider routes', () => {
  let closeServer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  async function realPage(confirm: (question: Question) => boolean = () => true) {
    const dir = await mkdtemp(join(tmpdir(), 'settings-providers-'));
    const settings = createSettingsStore({ path: join(dir, 'settings.json'), defaults: defaultSettings(), log: () => {} });
    const secrets = memorySecretsStore();
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const user = await users.create({ username: 'settings-fixture', password: 'password123456', isAdmin: true });
    const cookies = { sid: await sessions.create(user.id, 60_000) };
    const media = memoryMediaStore({ baseUrl: 'https://images.example' });
    const queue = createEncodeQueue({ store: media, storageDir: dir, lock: createWorkLock() });
    const unavailable = async (): Promise<never> => { throw new Error('Not part of this settings test'); };
    const app = buildServer({
      trustProxy: TEST_TRUST,
      storageDir: dir, baseUrl: 'https://images.example', imgHost: 'images.example', siteDir: join(dir, 'site'),
      users, sessions, secrets, settings, media, encodeQueue: queue,
      posts: memoryPostStore(), pages: memoryPageStore(),
      builder: {
        build: unavailable, hasRelease: () => false, quiesce: async () => {},
        initialize: async () => {},
        status: async () => ({ live: null, running: null, last: null, record: 'missing' }),
      }, backupDir: join(dir, 'backup'),
      dbBackup: { dir, runNow: unavailable, running: () => false, sweepTempFiles: () => [], list: () => [], listImageArchives: () => [], listRouteArchives: () => [], state: () => ({}), quiesce: async () => {} },
      dbCheck: unavailable,
    });
    closeServer = async () => {
      await app.close();
      await queue.drain();
      await rm(dir, { recursive: true, force: true });
    };
    const questions: Question[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      // Anything off-origin is the provider: a model list, never a real request.
      if (!url.startsWith('/')) return Response.json({ data: [{ id: 'remote-model' }] });
      const response = await app.inject({
        url, method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE', cookies,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        payload: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
    });
    const page = loadSettingsPage({
      fetch: fetcher, ...AI_MODELS_TAB,
      AdminConfirm: { ask: async (question: Question) => { questions.push(question); return confirm(question); } },
    });
    vm.runInContext(readFileSync('public/llm.js', 'utf8'), page.ctx);
    const refill = async () => callPage(page.ctx, 'fill', (await app.inject({ url: '/settings', cookies })).json<SettingsResponse>());
    await refill();
    const createProvider = async (apiKey: string): Promise<ProviderView> => {
      const response = await app.inject({
        url: '/ai-providers', method: 'POST', cookies,
        payload: { name: 'Router', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json<SettingsResponse>().aiProviders.find((p) => p.name === 'Router');
      if (!created) throw new Error('provider was not created');
      return created;
    };
    return { ...page, app, cookies, settings, secrets, fetcher, questions, refill, createProvider };
  }

  it.each(['default', 'ai'] as const)('stores the pending Edit key only in A’s slot after unrelated %s work', async (action) => {
    const page = await realPage();
    const { el, app, cookies, secrets, settings, ctx } = page;
    const a = await page.createProvider('fixture-a-original');
    const createdB = await app.inject({
      url: '/ai-providers', method: 'POST', cookies,
      payload: { name: 'Provider B', kind: 'custom', baseUrl: 'https://b.example/v1', apiKey: 'fixture-b-unchanged' },
    });
    expect(createdB.statusCode).toBe(201);
    const b = createdB.json<SettingsResponse>().aiProviders.find((p) => p.name === 'Provider B')!;
    await page.refill();
    await rowButton(providerRow(el, 'Router'), 'Edit').click();
    el('providerName').value = 'Provider A edited';
    el('providerBaseUrl').value = 'https://a-new.example/v1';
    el('providerApiKey').value = 'fixture-a-replacement';
    if (action === 'default') await rowButton(providerRow(el, b.name), 'Set default').click();
    else await el('saveAi').click();
    await callPage(ctx, 'ensureModels');
    expect(el('providerApiKey').value).toBe('fixture-a-replacement');
    expect(el('providerName').value).toBe('Provider A edited');
    expect(el('providerBaseUrl').value).toBe('https://a-new.example/v1');
    expect(el('providerKeyMoveWarning').hidden).toBe(true);
    page.questions.length = 0;
    await el('providerForm').fire('submit');
    expect(page.questions).toEqual([]);
    expect(await secrets.get('ai_provider_key:' + a.id)).toBe('fixture-a-replacement');
    expect(await secrets.get('ai_provider_key:' + b.id)).toBe('fixture-b-unchanged');
    expect(settings.get().aiProviders.find((p) => p.id === a.id)).toMatchObject({
      name: 'Provider A edited', baseUrl: 'https://a-new.example/v1',
    });
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-');
    const writesWithReplacement = page.fetcher.mock.calls.filter(([, init]) =>
      typeof init?.body === 'string' && init.body.includes('fixture-a-replacement'));
    expect(writesWithReplacement).toHaveLength(1);
    expect(writesWithReplacement[0]![0]).toBe('/ai-providers/' + a.id);
    expect(page.fetcher.mock.calls.some(([, init]) =>
      new Headers(init?.headers).get('authorization') === 'Bearer fixture-a-replacement')).toBe(false);
    const response = await app.inject({ url: '/settings', cookies });
    expect(response.body).not.toContain('fixture-');
    expect(response.json<SettingsResponse>().aiProviders.find((p) => p.id === a.id)?.hasApiKey).toBe(true);
    // Exercise the actual bilingual admin-copy projection, not a second test dictionary.
    const copyResponse = await app.inject({ url: '/admin/editor-image-copy.js' });
    vm.runInContext(copyResponse.body, ctx);
    const delivered = ctx.EditorCopy as Record<'de' | 'en', Record<string, string>>;
    for (const locale of ['de', 'en'] as const) {
      expect(delivered[locale].settingsRegistryUnavailable).toBe(ui[locale]['editor.chrome.settingsRegistryUnavailable']);
      expect(delivered[locale].settingsProviderRemoved).toBe(ui[locale]['editor.chrome.settingsProviderRemoved']);
    }
  });

  it('adds Anthropic, discovers models and binds its key only to assigned use cases', async () => {
    const { el, ctx, fetcher, app, cookies, settings, secrets } = await realPage();
    await el('addProvider').click();
    el('providerKind').value = 'anthropic';
    await el('providerKind').fire('change');
    expect(el('providerName').value).toBe('Anthropic');
    expect(el('providerBaseUrl').value).toBe('https://api.anthropic.com/v1');
    await el('testProviderForm').click();
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('https://api.anthropic.com'))).toBe(false);
    el('providerApiKey').value = 'fixture-created-key';
    await el('providerForm').fire('submit');
    const created = settings.get().aiProviders.find((p) => p.name === 'Anthropic');
    expect(created).toMatchObject({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' });
    expect(await secrets.get('ai_provider_key:' + created!.id)).toBe('fixture-created-key');
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-created-key');

    el('reviewProviderId').value = created!.id;
    await el('reviewProviderId').fire('change');
    await callPage(ctx, 'ensureModels');
    const listing = fetcher.mock.calls.find(([url]) => String(url) === 'https://api.anthropic.com/v1/models');
    expect(new Headers(listing?.[1]?.headers).get('authorization')).toBe('Bearer fixture-created-key');
    expect(pageText(el)).not.toContain('fixture-created-key');
    await chooseModel(el, 'aiModel', 'remote-model');
    await el('saveAi').click();
    expect(settings.get()).toMatchObject({ reviewProviderId: created!.id, captionProviderId: null, aiModel: 'remote-model' });

    const config = (await app.inject({ url: '/ai-config', cookies })).json();
    expect(config).toMatchObject({
      aiProvider: 'anthropic', aiBaseUrl: 'https://api.anthropic.com/v1', hasAiApiKey: true, aiApiKey: 'fixture-created-key',
    });
    const caption = (await app.inject({ url: '/ai-config?purpose=caption', cookies })).json();
    expect(caption).toMatchObject({ captionProvider: 'lm-studio', captionApiKey: null });
    el('captionProviderId').value = created!.id;
    await el('captionProviderId').fire('change');
    await el('saveAi').click();
    const assignedCaption = (await app.inject({ url: '/ai-config?purpose=caption', cookies })).json();
    expect(assignedCaption).toMatchObject({
      captionProvider: 'anthropic', captionBaseUrl: created!.baseUrl, captionApiKey: 'fixture-created-key',
    });
    const localTranslation = (await app.inject({ url: '/ai-config?purpose=translation', cookies })).json();
    expect(localTranslation).toMatchObject({ providerKind: 'lm-studio', apiKey: null, model: 'qwen2.5-7b-instruct' });
    el('translationProviderId').value = created!.id;
    await el('translationProviderId').fire('change');
    await chooseModel(el, 'translationModel', 'remote-model');
    el('translationTimeoutSeconds').value = '180';
    await el('saveAi').click();
    const assignedTranslation = (await app.inject({ url: '/ai-config?purpose=translation', cookies })).json();
    expect(assignedTranslation).toEqual({
      providerId: created!.id, providerName: 'Anthropic', providerKind: 'anthropic', baseUrl: created!.baseUrl,
      model: 'remote-model', timeoutMs: 180000, prompt: DEFAULT_TRANSLATION_PROMPT, apiKey: 'fixture-created-key',
    });
    expect(settings.get()).toMatchObject({ aiModel: 'remote-model', lmModel: defaultSettings().lmModel });
  });

  it('adds OpenAI, discovers models and binds its key only to assigned use cases', async () => {
    const { el, ctx, fetcher, app, cookies, settings, secrets } = await realPage();
    await el('addProvider').click();
    el('providerKind').value = 'openai';
    await el('providerKind').fire('change');
    expect(el('providerName').value).toBe('OpenAI');
    expect(el('providerBaseUrl').value).toBe('https://api.openai.com/v1');
    await el('testProviderForm').click();
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('https://api.openai.com'))).toBe(false);
    el('providerApiKey').value = 'fixture-created-key';
    await el('providerForm').fire('submit');
    const created = settings.get().aiProviders.find((p) => p.name === 'OpenAI');
    expect(created).toMatchObject({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' });
    expect(await secrets.get('ai_provider_key:' + created!.id)).toBe('fixture-created-key');
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-created-key');

    el('reviewProviderId').value = created!.id;
    await el('reviewProviderId').fire('change');
    await callPage(ctx, 'ensureModels');
    const listing = fetcher.mock.calls.find(([url]) => String(url) === 'https://api.openai.com/v1/models');
    expect(new Headers(listing?.[1]?.headers).get('authorization')).toBe('Bearer fixture-created-key');
    expect(pageText(el)).not.toContain('fixture-created-key');
    await chooseModel(el, 'aiModel', 'remote-model');
    await el('saveAi').click();
    expect(settings.get()).toMatchObject({ reviewProviderId: created!.id, captionProviderId: null, aiModel: 'remote-model' });

    const config = (await app.inject({ url: '/ai-config', cookies })).json();
    expect(config).toMatchObject({
      aiProvider: 'openai', aiBaseUrl: 'https://api.openai.com/v1', hasAiApiKey: true, aiApiKey: 'fixture-created-key',
    });
    const caption = (await app.inject({ url: '/ai-config?purpose=caption', cookies })).json();
    expect(caption).toMatchObject({ captionProvider: 'lm-studio', captionApiKey: null });
    el('captionProviderId').value = created!.id;
    await el('captionProviderId').fire('change');
    await el('saveAi').click();
    const assignedCaption = (await app.inject({ url: '/ai-config?purpose=caption', cookies })).json();
    expect(assignedCaption).toMatchObject({
      captionProvider: 'openai', captionBaseUrl: created!.baseUrl, captionApiKey: 'fixture-created-key',
    });
    const localTranslation = (await app.inject({ url: '/ai-config?purpose=translation', cookies })).json();
    expect(localTranslation).toMatchObject({ providerKind: 'lm-studio', apiKey: null, model: 'qwen2.5-7b-instruct' });
    el('translationProviderId').value = created!.id;
    await el('translationProviderId').fire('change');
    await chooseModel(el, 'translationModel', 'remote-model');
    el('translationTimeoutSeconds').value = '180';
    await el('saveAi').click();
    const assignedTranslation = (await app.inject({ url: '/ai-config?purpose=translation', cookies })).json();
    expect(assignedTranslation).toEqual({
      providerId: created!.id, providerName: 'OpenAI', providerKind: 'openai', baseUrl: created!.baseUrl,
      model: 'remote-model', timeoutMs: 180000, prompt: DEFAULT_TRANSLATION_PROMPT, apiKey: 'fixture-created-key',
    });
    expect(settings.get()).toMatchObject({ aiModel: 'remote-model', lmModel: defaultSettings().lmModel });
  });

  it('saves custom translation instructions verbatim, hands them to the translator and shows them again after a reload', async () => {
    const { el, app, cookies, settings, refill, fetcher } = await realPage();
    expect(el('translationPrompt').value).toBe(DEFAULT_TRANSLATION_PROMPT);
    const custom = '  Use informal “du” in German.\n\tKeep place names in the local spelling.\n';
    el('translationPrompt').value = custom;
    await el('translationPrompt').fire('input');
    await el('saveAi').click();
    expect(el('aiOut').textContent).toBe(EDITOR_COPY.writingSaved);
    expect(settings.get().translationPrompt).toBe(custom);
    expect((await app.inject({ url: '/ai-config?purpose=translation', cookies })).json().prompt).toBe(custom);

    el('translationPrompt').value = '';
    await refill();
    expect(el('translationPrompt').value).toBe(custom);
    expect(el('translationPromptCount').textContent).toBe(custom.length + ' of 4000 characters');

    // Reset works from the server's own default and saves nothing by itself.
    const before = fetcher.mock.calls.length;
    await el('translationPromptReset').click();
    expect(el('translationPrompt').value).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(settings.get().translationPrompt).toBe(custom);
    await el('saveAi').click();
    expect(settings.get().translationPrompt).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect((await app.inject({ url: '/ai-config?purpose=translation', cookies })).json().prompt).toBe(DEFAULT_TRANSLATION_PROMPT);
  });

  it('saves the photo output budget, refuses an invalid one without saving, and reloads the saved value', async () => {
    const { el, app, cookies, settings, refill } = await realPage();
    el('captionMaxTokens').value = '4096';
    await el('saveAi').click();
    expect(settings.get().captionMaxTokens).toBe(4096);
    expect((await app.inject({ url: '/ai-config?purpose=caption', cookies })).json().captionMaxTokens).toBe(4096);

    el('captionMaxTokens').value = '255';
    await el('saveAi').click();
    expect(settings.get().captionMaxTokens).toBe(4096);
    expect(el('aiOut').textContent).toBe('Maximum output tokens must be a whole number between 256 and 32768.');
    expect(el('captionMaxTokens').value).toBe('255');

    await refill();
    expect(Number(el('captionMaxTokens').value)).toBe(4096);
  });

  it('editing the URL of a provider with a stored key changes nothing until the admin confirms', async () => {
    let approve = false;
    const { el, settings, secrets, questions, refill, createProvider } = await realPage(() => approve);
    const created = await createProvider('fixture-key');
    await refill();
    await rowButton(providerRow(el, 'Router'), 'Edit').click();
    el('providerBaseUrl').value = 'https://proxy.example/v1';
    await el('providerForm').fire('submit');
    expect(questions).toHaveLength(1);
    expect(settings.get().aiProviders.find((p) => p.id === created.id)?.baseUrl).toBe('https://openrouter.ai/api/v1');

    approve = true;
    await el('providerForm').fire('submit');
    expect(settings.get().aiProviders.find((p) => p.id === created.id)?.baseUrl).toBe('https://proxy.example/v1');
    expect(await secrets.get('ai_provider_key:' + created.id)).toBe('fixture-key');
  });

  it('deleting a provider assigned since the page loaded surfaces the server\'s refusal', async () => {
    const { el, app, cookies, settings, secrets, refill, createProvider } = await realPage();
    const created = await createProvider('fixture-key');
    await refill();
    const assigned = await app.inject({ url: '/settings', method: 'POST', cookies, payload: { reviewProviderId: created.id } });
    expect(assigned.statusCode).toBe(200);
    await rowButton(providerRow(el, 'Router'), 'Delete').click();
    expect(el('providersOut').textContent).toContain(EDITOR_COPY.settingsWriting);
    expect(settings.get().aiProviders.some((p) => p.id === created.id)).toBe(true);
    expect(await secrets.get('ai_provider_key:' + created.id)).toBe('fixture-key');
  });

  it('Test reads the key through /credential for that one request and leaves it nowhere', async () => {
    const { el, fetcher, refill, createProvider } = await realPage();
    const created = await createProvider('fixture-key');
    await refill();
    await rowButton(providerRow(el, 'Router'), 'Test').click();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/ai-providers/' + created.id + '/credential', 'https://openrouter.ai/api/v1/models',
    ]);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer fixture-key');
    expect(rowStatus(providerRow(el, 'Router'))).toBe('Reachable from this browser · 1 model listed.');
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-key');
  });
});

describe('settings.html image controls', () => {
  async function loadImageSettings(fetch?: (url: string, init?: { body?: string }) => Promise<unknown>) {
    const page = loadSettingsPage(fetch ? { fetch } : {});
    await callPage(page.ctx, 'fill', settingsResponse());
    return page;
  }

  it('keeps pending values and allows retry after a dropped save connection', async () => {
    const { el } = await loadImageSettings();
    el('convertJpeg').checked = false;
    el('webpQuality').value = '86';
    el('avifQuality').value = '64';
    await el('imageSettings').fire('submit');
    expect(el('saveImages').disabled).toBe(false);
    expect(el('imageOut').textContent).toMatch(/could not save/i);
    expect(el('convertJpeg').checked).toBe(false);
    expect(el('webpQuality').value).toBe('86');
    expect(el('avifQuality').value).toBe('64');
  });

  it('saves only image preferences without overwriting pending AI or backup edits', async () => {
    let persisted = settingsResponse();
    const { el } = await loadImageSettings(async (_url, init) => {
      persisted = { ...persisted, ...JSON.parse(init?.body ?? '{}') };
      return { ok: true, status: 200, json: async () => persisted };
    });
    el('captionPrompt').value = 'Unsaved caption instructions';
    el('backupSchedule').value = 'weekly';
    el('aiModel').value = 'unsaved-review-model';
    el('convertJpeg').checked = false;
    el('webpQuality').value = '86';
    await el('imageSettings').fire('submit');
    expect(persisted).toMatchObject({
      convertJpeg: false, webpQuality: 86, avifQuality: 55,
      captionPrompt: 'Caption prompt', backupSchedule: 'off',
    });
    expect(el('captionPrompt').value).toBe('Unsaved caption instructions');
    expect(el('backupSchedule').value).toBe('weekly');
    expect(el('aiModel').value).toBe('unsaved-review-model');
    expect(el('saveImages').disabled).toBe(false);
  });

  it('refuses an out-of-range quality under its field without the browser bubble or a request', async () => {
    const fetch = vi.fn();
    const page = await loadImageSettings(fetch);
    const { el } = page;
    const doc = documentOf(page);
    const wrap = (id: string) => { const node = doc.createElement('div'); doc.appendChild(node); node.appendChild(el(id)); return node; };
    const webp = wrap('webpQuality');
    const avif = wrap('avifQuality');
    el('webpQuality').value = '140';
    el('avifQuality').value = '0';
    await el('imageSettings').fire('submit');
    expect(fetch).not.toHaveBeenCalled();
    expect(el('webpQuality').getAttribute('aria-invalid')).toBe('true');
    expect(webp.children[1]!.textContent).toBe('WebP quality must be between 1 and 100.');
    expect(avif.children[1]!.textContent).toBe('AVIF quality must be between 1 and 100.');
    expect(el('webpQuality').getAttribute('aria-describedby')).toBe('imageQualityHelp webpQualityError');
    expect(doc.activeElement).toBe(el('webpQuality'));
    expect(el('imageOut').textContent).toBe('');
    el('webpQuality').value = '80';
    await el('webpQuality').fire('input');
    expect(el('webpQuality').getAttribute('aria-invalid')).toBeNull();
    expect(webp.children[1]!.hidden).toBe(true);
  });

  it('returns focus to Save image settings once the save has finished', async () => {
    const page = await loadImageSettings(async () => ({ ok: true, status: 200, json: async () => settingsResponse({ webpQuality: 80 }) }));
    const { el } = page;
    const doc = documentOf(page);
    el('webpQuality').value = '80';
    el('saveImages').focus();
    const pending = el('imageSettings').fire('submit');
    expect(el('saveImages').disabled).toBe(true);
    // A disabled control cannot hold focus: the browser drops it to <body>.
    doc.activeElement = null;
    await pending;
    expect(el('saveImages').disabled).toBe(false);
    expect(el('imageOut').textContent).toBe('Image settings saved. Existing photos are unchanged.');
    expect(doc.activeElement).toBe(el('saveImages'));
  });

  it('turns a refused image save into a sentence', async () => {
    const { el } = await loadImageSettings(async () => ({ ok: false, status: 400, json: async () => ({ error: 'webpQuality must be an integer' }) }));
    await el('imageSettings').fire('submit');
    expect(el('imageOut').textContent).toBe('Could not save image settings: WebpQuality must be an integer.');
  });
});

describe('settings.html Compare quality', () => {
  const KB = 1024;
  const photo = (bytes = 400 * KB) => new File([new Uint8Array(bytes)], 'secret-place.jpg', { type: 'image/jpeg' });
  const encodedResponse = (bytes = 100 * KB, type = 'image/webp') => new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': type, 'X-Preview-Width': '1920', 'X-Preview-Height': '1280',
      'X-Original-Width': '6000', 'X-Original-Height': '4000',
    },
  });

  async function previewPage(respond: (body: FormData) => Promise<Response> | Response = () => encodedResponse()) {
    const sent: FormData[] = [];
    const created: string[] = [];
    const revoked: string[] = [];
    // Object URLs are the page's to create and revoke; record both.
    const PageURL = Object.assign(class extends URL {}, {
      createObjectURL: (_object: Blob) => {
        const url = 'blob:preview-' + (created.length + 1);
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => { revoked.push(url); },
    });
    const location = {
      href: 'http://localhost/admin/settings.html', origin: 'http://localhost',
      pathname: '/admin/settings.html', search: '', hash: '', protocol: 'http:',
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/settings/image-preview' || init?.method !== 'POST' || !(init.body instanceof FormData)) {
        throw new Error('Unexpected request in this test.');
      }
      sent.push(init.body);
      return respond(init.body);
    });
    const page = loadSettingsPage({ fetch, URL: PageURL, FormData, location });
    await callPage(page.ctx, 'fill', settingsResponse());
    return { ...page, sent, created, revoked, fetch, location };
  }

  it('sends the photo, the chosen format and the current, unsaved quality for that format', async () => {
    const { el, sent } = await previewPage();
    el('previewFile').files = [photo()];
    el('webpQuality').value = '62';
    el('avifQuality').value = '41';
    await el('previewRun').click();
    expect(sent[0]!.get('format')).toBe('webp');
    expect(sent[0]!.get('quality')).toBe('62');
    const file = sent[0]!.get('file');
    expect(file instanceof File ? file.name : null).toBe('secret-place.jpg');

    await el('previewFormatAvif').click();
    expect(el('previewFormatAvif').attrs['aria-pressed']).toBe('true');
    expect(el('previewFormatWebp').attrs['aria-pressed']).toBe('false');
    expect(el('previewFormatAvif').classList.contains('active')).toBe(true);
    await el('previewRun').click();
    expect([sent[1]!.get('format'), sent[1]!.get('quality')]).toEqual(['avif', '41']);
  });

  it('disables Preview while the encode runs', async () => {
    const answer = Promise.withResolvers<Response>();
    const { el } = await previewPage(() => answer.promise);
    el('previewFile').files = [photo()];
    const running = el('previewRun').click();
    expect(el('previewRun').disabled).toBe(true);
    expect(el('previewOut').textContent).toBe('Encoding a WebP preview at quality 75…');
    answer.resolve(encodedResponse());
    await running;
    expect(el('previewRun').disabled).toBe(false);
  });

  it('shows original and result side by side, captioned with format, pixels, size and the saving', async () => {
    const { el, created } = await previewPage();
    el('previewFile').files = [photo()];
    await el('previewRun').click();
    expect(el('previewResult').hidden).toBe(false);
    expect([el('previewOriginal').src, el('previewEncoded').src]).toEqual(created);
    expect(el('previewOriginalCaption').textContent).toBe('Original · JPEG · 6000 × 4000 px · 400 KB');
    expect(el('previewEncodedCaption').textContent).toBe('WebP quality 75 · 1920 × 1280 px · 100 KB · 75% smaller than the original');
    expect(el('previewEncoded').alt).toBe('Test photo encoded as WebP at quality 75');
    expect(el('previewOut').textContent).toBe('WebP at quality 75: 100 KB, 75% smaller than the original.');
  });

  it.each([
    [3 * KB * KB, 450 * KB, '3.0 MB', '450 KB · 85% smaller than the original'],
    [400 * KB, 500 * KB, '400 KB', '500 KB · 25% larger than the original'],
    [400 * KB, 401 * KB, '400 KB', '401 KB · about the same size as the original'],
  ])('reports a %i-byte original against a %i-byte result', async (original, encoded, originalSize, result) => {
    const { el } = await previewPage(() => encodedResponse(encoded));
    el('previewFile').files = [photo(original)];
    await el('previewRun').click();
    expect(el('previewOriginalCaption').textContent).toBe('Original · JPEG · 6000 × 4000 px · ' + originalSize);
    expect(el('previewEncodedCaption').textContent).toBe('WebP quality 75 · 1920 × 1280 px · ' + result);
  });

  it('revokes the previous object URLs on a new result and when another photo is chosen', async () => {
    const { el, created, revoked } = await previewPage();
    el('previewFile').files = [photo()];
    await el('previewRun').click();
    await el('previewRun').click();
    expect(created).toEqual(['blob:preview-1', 'blob:preview-2', 'blob:preview-3', 'blob:preview-4']);
    expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2']);
    await el('previewFile').fire('change');
    expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2', 'blob:preview-3', 'blob:preview-4']);
    expect(el('previewResult').hidden).toBe(true);
  });

  it.each([
    [429, { error: 'A preview is already running. Try again in a moment.' }, 'A preview is already running. Try again in a moment.'],
    [400, { error: 'Could not read that image.' }, 'Could not read that image.'],
    [413, { error: 'request file too big' }, 'That photo is over the 25 MB upload limit. Choose a smaller one.'],
    [500, {}, 'Could not generate the preview.'],
  ])('names a %i refusal and keeps the last result', async (status, body, message) => {
    let refuse = false;
    const { el, created } = await previewPage(() => (refuse ? Response.json(body, { status }) : encodedResponse()));
    el('previewFile').files = [photo()];
    await el('previewRun').click();
    refuse = true;
    await el('previewRun').click();
    expect(el('previewOut').textContent).toBe(message);
    expect(el('previewRun').disabled).toBe(false);
    expect(el('previewResult').hidden).toBe(false);
    expect(created).toHaveLength(2);
  });

  it('sends a signed-out admin to the login page, and survives a dropped connection', async () => {
    let answer: () => Response = () => new Response(null, { status: 401 });
    const { el, location } = await previewPage(() => answer());
    el('previewFile').files = [photo()];
    await el('previewRun').click();
    expect(location.href).toBe('/login');
    answer = () => { throw NETWORK_DOWN; };
    await el('previewRun').click();
    expect(el('previewOut').textContent).toBe('Could not reach the server. Check your connection and try again.');
    expect(el('previewRun').disabled).toBe(false);
  });

  it('asks for a photo and a valid quality under their fields before sending anything', async () => {
    const page = await previewPage();
    const { el, fetch } = page;
    const doc = documentOf(page);
    const wrap = (id: string) => { const node = doc.createElement('div'); doc.appendChild(node); node.appendChild(el(id)); return node; };
    const file = wrap('previewFile');
    const quality = wrap('webpQuality');
    await el('previewRun').click();
    expect(el('previewOut').textContent).toBe('');
    expect(el('previewFile').getAttribute('aria-invalid')).toBe('true');
    expect(file.children[1]!.textContent).toBe('Choose a test photo first.');
    expect(doc.activeElement).toBe(el('previewFile'));
    el('previewFile').files = [photo()];
    await el('previewFile').fire('change');
    expect(el('previewFile').getAttribute('aria-invalid')).toBeNull();
    for (const value of ['0', '101', '7.5', '']) {
      el('webpQuality').value = value;
      await el('previewRun').click();
      expect(el('webpQuality').getAttribute('aria-invalid')).toBe('true');
      expect(quality.children[1]!.textContent).toBe('Set the WebP quality to a whole number from 1 to 100 first.');
      expect(doc.activeElement).toBe(el('webpQuality'));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('1:1 pixels draws both panes at the preview width and scrolls them together', async () => {
    const { el } = await previewPage();
    el('previewFile').files = [photo()];
    await el('previewRun').click();
    expect([el('previewOriginal').style.width, el('previewEncoded').style.width]).toEqual(['', '']);
    el('previewActual').checked = true;
    await el('previewActual').fire('change');
    expect(el('previewResult').classList.contains('is-actual')).toBe(true);
    expect([el('previewOriginal').style.width, el('previewEncoded').style.width]).toEqual(['1920px', '1920px']);
    el('previewEncodedBox').scrollLeft = 300;
    el('previewEncodedBox').scrollTop = 120;
    await el('previewEncodedBox').fire('scroll');
    expect([el('previewOriginalBox').scrollLeft, el('previewOriginalBox').scrollTop]).toEqual([300, 120]);
    el('previewActual').checked = false;
    await el('previewActual').fire('change');
    expect(el('previewResult').classList.contains('is-actual')).toBe(false);
    expect(el('previewOriginal').style.width).toBe('');
  });
});

describe('import language summary', () => {
  it('separates disabled-language skips from published skips, rejection, and failures', () => {
    const { ctx, el } = loadPage('public/import.html', {});
    const render = vm.runInContext('renderSummary', ctx) as (summary: unknown) => void;
    render({ imported: 1, updated: 2, skippedPublished: 3, skippedLocale: 4, rejected: 5, failed: 6, warnings: [] });
    expect(el('counts').textContent).toContain('Skipped (published): 3');
    expect(el('counts').textContent).toContain('Skipped (disabled language): 4');
    expect(el('counts').textContent).toContain('Rejected: 5');
    expect(el('counts').textContent).toContain('Failed: 6');
    expect(el('importRejected').textContent).toContain('missing primary-language story');
  });
});

describe('publication refresh in list, Desk and Settings consumers', () => {
  afterEach(() => { vi.useRealTimers(); });
  const textOf = (node: Element): string => node.textContent + node.children.map(textOf).join(' ');
  const clockGlobals = () => ({ setTimeout, clearTimeout, Date });
  const startClock = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    }
  };

  it('preserves a focused open row action through both list and delayed history observations', async () => {
    startClock();
    const history = Promise.withResolvers<Response>();
    let holdHistory = false;
    const page = loadPosts({ ...clockGlobals(),
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async (url: string) => {
        if (holdHistory && url === '/rebuild/status') return history.promise;
        return Response.json(url === '/posts' ? [post] : { record: 'missing' });
      },
    });
    await flush();
    const menu = () => page.el('postsList').querySelectorAll('.post-more')[0]!;
    const remove = () => page.el('postsList').querySelectorAll('.btn-remove')[0]!;
    const doc = page.ctx.document as { activeElement: Element | null };
    const oldMenu = menu();
    oldMenu.open = true; await oldMenu.fire('toggle');
    remove().focus();
    holdHistory = true;
    const refreshing = vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>;
    await flush();
    expect(menu().open).toBe(true);
    expect(doc.activeElement).toBe(remove());
    // A native toggle queued on the discarded disclosure must not close its replacement.
    await oldMenu.fire('toggle');
    expect(menu().open).toBe(true);
    history.resolve(Response.json({ record: 'missing' }));
    await refreshing;
    expect(menu().open).toBe(true);
    expect(doc.activeElement).toBe(remove());
    await menu().fire('keydown', { key: 'Escape' });
    expect(menu().open).toBe(false);
    expect(doc.activeElement).toBe(menu().children[0]);
    page.el('fSearch').focus();
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('fSearch'));
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('retains row keyboard focus by story identity after reordering and hands it to a neighbour when the row disappears', async () => {
    startClock();
    let rows = [post, { ...post, translationKey: 'other', title: 'Other' }];
    const page = loadPosts({ ...clockGlobals(),
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async (url: string) => Response.json(url === '/posts' ? rows : { record: 'missing' }),
    });
    await flush();
    const doc = page.ctx.document as { activeElement: Element | null };
    const list = page.el('postsList');
    list.querySelectorAll('.action-link')[0]!.focus();
    rows = [rows[1]!, rows[0]!];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(list.querySelectorAll('.action-link')[1]);
    const menu = list.querySelectorAll('.post-more')[1]!;
    menu.open = true; await menu.fire('toggle');
    menu.children[1]!.children[0]!.focus(); // Unpublish.
    rows = [rows[0]!, { ...post, status: 'draft', publication: publication('draft') }];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(list.querySelectorAll('.post-title-link')[1]);
    // The focused story vanished elsewhere: the row before it takes the focus.
    rows = [rows[0]!];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(list.querySelectorAll('.action-link')[0]);
    expect(doc.activeElement?.attrs['aria-label']).toBe('Edit Other');
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('refreshes language controls and uses the observed language token for the next bulk publish', async () => {
    startClock();
    let language = { primary: 'de', locales: ['de', 'en'], updatedAt: '2026-10-27T00:00:00.000Z' };
    let submitted: unknown;
    const page = loadPosts({ ...clockGlobals(), fetch: async (url: string, init?: RequestInit) => {
      if (url === '/posts/bulk') { submitted = JSON.parse(String(init?.body)); return Response.json({ succeeded: 1, failed: 0 }); }
      return Response.json(url === '/posts' ? [post] : { record: 'missing' });
    } }, async () => Response.json(language));
    vm.runInContext('me = { isAdmin: true }', page.ctx);
    await (vm.runInContext('load', page.ctx) as () => Promise<void>)();
    language = { primary: 'en', locales: ['en'], updatedAt: '2026-10-28T00:00:00.000Z' };
    await vi.advanceTimersByTimeAsync(30000); await flush();
    expect(page.el('missingSecondaryOption').disabled).toBe(true);
    expect(vm.runInContext('SiteLanguage.config().primary', page.ctx)).toBe('en');
    vm.runInContext("selected.add('tk1')", page.ctx);
    await (vm.runInContext('runBulk', page.ctx) as (action: string) => Promise<void>)('publish');
    expect(submitted).toMatchObject({ action: 'publish', keys: ['tk1'], baseLanguageUpdatedAt: language.updatedAt });
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it.each(['network', 'invalid'])('recovers initial %s language failure through visible Retry', async (kind) => {
    startClock();
    let failing = true;
    const language = { primary: 'en', locales: ['en'], updatedAt: '2026-10-28T00:00:00.000Z' };
    const page = loadPosts({ ...clockGlobals(),
      Auth: { ensureAuthed: async () => ({ isAdmin: true }), renderHeader() {} },
      fetch: async (url: string) => Response.json(url === '/posts' ? [post] : { record: 'missing' }),
    }, async () => {
      if (failing && kind === 'network') throw NETWORK_DOWN;
      return Response.json(failing ? { ...language, locales: ['invalid'] } : language);
    });
    // Initial navigation has no cached language. Exercise the real client, not
    // the preloaded configuration used by unrelated action fixtures.
    vm.runInContext(readFileSync('public/language.js', 'utf8'), page.ctx);
    await flush();
    expect(page.el('loadMsg').attrs.role).toBe('alert');
    expect(page.el('retryLoad').hidden).toBe(false);
    expect(page.el('bulkPublish').disabled).toBe(true);
    failing = false;
    await page.el('retryLoad').click(); await flush();
    expect(page.el('loadMsg').hidden).toBe(true);
    expect(page.el('postsTable').hidden).toBe(false);
    expect(vm.runInContext('SiteLanguage.config().primary', page.ctx)).toBe('en');
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('refreshes list facts while preserving search/selection and disabling stale mutation controls after a failure', async () => {
    startClock();
    let fresh = publication(), failure = false;
    const page = loadPosts({ ...clockGlobals(), fetch: async (url: string) => {
      if (failure) throw NETWORK_DOWN;
      return Response.json(url === '/posts' ? [{ ...post, publication: fresh }] : { record: 'missing' });
    } });
    vm.runInContext("me = { isAdmin: true }; selected.add('tk1')", page.ctx);
    await (vm.runInContext('load', page.ctx) as () => Promise<void>)();
    page.el('fSearch').value = 'Bukarest';
    vm.runInContext("render(true); $('out').textContent = 'Acknowledged save'", page.ctx);
    fresh = { ...publication('draft'), live: { de: 'live', en: 'unknown' } };
    await vi.advanceTimersByTimeAsync(30000);
    await flush();
    expect(textOf(page.el('postsList'))).toContain('Draft in the CMS — still on the live site');
    expect(page.el('fSearch').value).toBe('Bukarest');
    expect(vm.runInContext('[...selected]', page.ctx)).toEqual(['tk1']);
    failure = true;
    await vi.advanceTimersByTimeAsync(30000);
    await flush();
    expect(textOf(page.el('postsList'))).toContain('Publication status unavailable');
    expect(page.el('bulkDelete').disabled).toBe(true);
    expect(page.el('out').textContent).toBe('Acknowledged save');
    expect(page.el('fSearch').value).toBe('Bukarest');
    expect(vm.runInContext('[...selected]', page.ctx)).toEqual(['tk1']);
    failure = false;
    await page.el('retryLoad').click();
    await flush();
    expect(page.el('bulkDelete').disabled).toBe(false);
    expect(page.el('out').textContent).toBe('Acknowledged save');
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('discards a delayed pre-action list after a delete receipt and drops the deleted selection', async () => {
    startClock();
    const old = Promise.withResolvers<Response>();
    let pending = false, deleted = false;
    const page = loadPosts({ ...clockGlobals(), fetch: async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return Response.json({ deleted: true, publication: { availability: 'missing' } });
      }
      if (url !== '/posts') return Response.json({ record: 'missing' });
      if (pending && !deleted) return old.promise;
      return Response.json(deleted ? [] : [post]);
    } });
    vm.runInContext('me = { isAdmin: true }', page.ctx);
    await (vm.runInContext('load', page.ctx) as () => Promise<void>)();
    vm.runInContext("selected.add('tk1')", page.ctx);
    pending = true;
    await vi.advanceTimersByTimeAsync(30000);
    await (vm.runInContext('deletePost', page.ctx) as (p: unknown, b: Element) => Promise<void>)(post, element());
    old.resolve(Response.json([post]));
    await flush();
    expect(vm.runInContext('allPosts.length', page.ctx)).toBe(0);
    expect(vm.runInContext('selected.size', page.ctx)).toBe(0);
    expect(textOf(page.el('postsList'))).not.toContain('Bukarest');
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it.each([true, false])('refreshes Desk facts without author requests for admin summary/build data (admin=%s)', async (admin) => {
    startClock();
    let fresh = publication('published', true);
    const urls: string[] = [];
    const page = loadPage('public/index.html', { ...clockGlobals(), fetch: async (url: string) => {
      urls.push(url);
      if (url === '/posts') return Response.json([{ ...post, publication: fresh }]);
      if (url === '/publication/summary') return Response.json({ availability: 'available', release: 'unknown', posts: null, galleryDescriptions: null });
      return Response.json({ record: 'missing' });
    } }, ['public/desk.js']);
    vm.runInContext(`isAdmin = ${admin}; authenticatedContext = { isAdmin: ${admin} }; publicationRefresh.start()`, page.ctx);
    await flush();
    expect(textOf(page.el('deskUnpub'))).toContain('Live — newer draft saved');
    expect(urls.includes('/publication/summary')).toBe(admin);
    expect(urls.includes('/rebuild/status')).toBe(admin);
    if (admin) expect(page.el('deskPublicationSummary').textContent).toContain('counts are unavailable');
    fresh = { ...publication(), live: { de: 'not-live', en: 'live' } };
    await vi.advanceTimersByTimeAsync(30000);
    await flush();
    if (admin) expect(textOf(page.el('deskAttention'))).toContain('Published, not yet live');
    else expect(textOf(page.el('deskUnpub'))).toContain('No newer drafts');
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('preserves focused Desk links through polling and separately arriving history without taking outside focus', async () => {
    startClock();
    const history = Promise.withResolvers<Response>();
    let held = false;
    const rows = [
      { ...post, publication: publication('published', true) },
      { ...post, translationKey: 'draft', publication: publication('draft') },
      { ...post, translationKey: 'attention', publication: { ...publication(), live: { de: 'not-live', en: 'live' } } },
    ];
    const page = loadPage('public/index.html', { ...clockGlobals(), fetch: async (url: string) => {
      if (url === '/posts') return Response.json(rows);
      if (held && url === '/rebuild/status') return history.promise;
      return Response.json({ record: 'missing' });
    } }, ['public/desk.js', 'public/posts-filter.js']);
    vm.runInContext('isAdmin = true; authenticatedContext = { isAdmin: true }; publicationRefresh.start()', page.ctx);
    await flush();
    const doc = page.ctx.document as { activeElement: Element | null };
    for (const id of ['deskNext', 'deskUnpub', 'deskAttention']) {
      for (const index of [0, 1]) {
        page.el(id).querySelectorAll('a')[index]!.focus();
        await vi.advanceTimersByTimeAsync(30000); await flush();
        expect(doc.activeElement).toBe(page.el(id).querySelectorAll('a')[index]);
      }
    }
    held = true;
    page.el('deskUnpub').querySelectorAll('.action-link')[0]!.focus();
    const refresh = vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>;
    await flush();
    expect(doc.activeElement).toBe(page.el('deskUnpub').querySelectorAll('.action-link')[0]);
    history.resolve(Response.json({ record: 'missing' })); await refresh;
    expect(doc.activeElement).toBe(page.el('deskUnpub').querySelectorAll('.action-link')[0]);
    page.el('publicationRefresh').focus();
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('publicationRefresh'));
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('keeps Desk focus on a surviving story across sections and uses Refresh when its link disappears', async () => {
    startClock();
    let rows = [{ ...post, publication: publication('published', true) }];
    const page = loadPage('public/index.html', { ...clockGlobals(),
      fetch: async (url: string) => Response.json(url === '/posts' ? rows : { record: 'missing' }),
    }, ['public/desk.js', 'public/posts-filter.js']);
    vm.runInContext('isAdmin = true; authenticatedContext = { isAdmin: true }; publicationRefresh.start()', page.ctx);
    await flush();
    const doc = page.ctx.document as { activeElement: Element | null };
    page.el('deskUnpub').querySelectorAll('.action-link')[0]!.focus();
    rows = [{ ...post, publication: { ...publication(), live: { de: 'not-live', en: 'live' } } }];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('deskAttention').querySelectorAll('.action-link')[0]);
    rows = [];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('publicationRefresh'));
    page.el('deskNewPost').focus();
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('deskNewPost'));
    rows = [{ ...post, publication: publication('draft') }];
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(doc.activeElement).toBe(page.el('deskNewPost'));
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('refreshes Settings counts after a local rebuild without touching dirty fields or the acknowledged outcome', async () => {
    startClock();
    let photos = 2;
    const page = loadSettingsPage({ ...clockGlobals(), fetch: async (url: string, init?: RequestInit) => {
      if (url === '/rebuild' && init?.method === 'POST') {
        photos = 0;
        return Response.json({ ok: true, release: '1793000000000-1-0001', liveRelease: null });
      }
      if (url === '/publication/summary') return Response.json({ availability: 'available', release: 'known',
        posts: { notLive: 0, olderVersionLive: 0, unexpectedLocaleLive: 0, unpublishedStillLive: 0, deletedStillLive: 0 },
        galleryDescriptions: { photos, stories: photos ? 1 : 0 } });
      return Response.json({ record: 'missing' });
    } });
    page.el('backupRetention').value = '37';
    vm.runInContext('publicationRefresh.start()', page.ctx);
    await flush();
    expect(page.el('publicationSummary').textContent).toContain('2 photos in 1 stories');
    await page.el('rebuild').click();
    await flush();
    expect(page.el('publicationSummary').textContent).toContain('0 photos in 0 stories');
    expect(page.el('backupRetention').value).toBe('37');
    const outcome = page.el('out').textContent;
    await vi.advanceTimersByTimeAsync(30000);
    await flush();
    expect(page.el('out').textContent).toBe(outcome);
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });
});

describe('index.html draft card', () => {
  const chipFacts = (chips: Element) => chips.children.map((chip) => ({ code: chip.textContent, className: chip.className, name: chip.attrs['aria-label'] }));
  const draft = { ...post, status: 'draft', publication: publication('draft'), country: 'Romania', region: 'europe', secondaryStatus: 'omitted', updatedAt: '2026-11-10T12:00:00.000Z' };

  it('names the region, formats the last edit as a moment and shows the story’s language chips', async () => {
    const page = loadPage('public/index.html', {
      fetch: async (url: string) => Response.json(url === '/posts' ? [draft] : { record: 'missing' }),
    }, ['public/posts-filter.js', 'public/desk.js']);
    vm.runInContext('isAdmin = false; authenticatedContext = { isAdmin: false }; publicationRefresh.start(false)', page.ctx);
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    const body = page.el('deskNext').children[0]!.children.find((node) => node.className === 'desk-next-body')!;
    const [title, chips, meta] = body.children;
    expect(title!.textContent).toBe('Bukarest');
    expect(meta!.textContent).toMatch(/^Romania · Europe · Last edited \d{1,2} \w{3} 2026, \d{2}:\d{2}$/);
    expect(meta!.textContent).not.toContain('europe');
    expect(chipFacts(chips!)).toEqual([
      { code: 'DE', className: 'lang-chip', name: 'German: primary language' },
      { code: 'EN', className: 'lang-chip is-omitted', name: 'English: not requested for publication' },
    ]);
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  });

  it('shows exactly the chips the Posts row shows for the same story', async () => {
    const desk = loadPage('public/index.html', {
      fetch: async (url: string) => Response.json(url === '/posts' ? [{ ...draft, secondaryStatus: 'empty' }] : { record: 'missing' }),
    }, ['public/posts-filter.js', 'public/desk.js']);
    vm.runInContext('isAdmin = false; authenticatedContext = { isAdmin: false }; publicationRefresh.start(false)', desk.ctx);
    await (vm.runInContext('publicationRefresh.refresh()', desk.ctx) as Promise<void>);
    const deskChips = desk.el('deskNext').children[0]!.children.find((node) => node.className === 'desk-next-body')!.children[1]!;
    const posts = loadPosts({ PostsFilter: realPostsFilter() });
    (vm.runInContext('renderRows', posts.ctx) as (rows: unknown[]) => void)([{ ...draft, secondaryStatus: 'empty' }]);
    const rowChips = posts.el('postsList').children[0]!.children.find((td) => td.className === 'col-languages')!.children[0]!;
    expect(chipFacts(deskChips)).toEqual(chipFacts(rowChips));
    expect(chipFacts(deskChips)[1]).toEqual({ code: 'EN', className: 'lang-chip is-missing', name: 'English body not started' });
    vm.runInContext('publicationRefresh.stop()', desk.ctx);
  });
});

it.each(['posts', 'desk', 'settings'] as const)('keeps fresh %s facts when optional build history stalls', async (surface) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const history = Promise.withResolvers<Response>();
    let signal: AbortSignal | null = null;
    const globals = { setTimeout, clearTimeout, Date, fetch: async (url: string, init?: RequestInit) => {
      if (url === '/rebuild/status') { signal = init?.signal ?? null; return history.promise; }
      if (url === '/posts') return Response.json([{ ...post, publication: publication('published', true) }]);
      return Response.json({ availability: 'available', release: 'known',
        posts: { notLive: 0, olderVersionLive: 0, unexpectedLocaleLive: 0, unpublishedStillLive: 0, deletedStillLive: 0 },
        galleryDescriptions: { photos: 2, stories: 1 } });
    } };
    const page = surface === 'posts' ? loadPosts(globals)
      : surface === 'desk' ? loadPage('public/index.html', globals, ['public/desk.js'])
        : loadSettingsPage(globals);
    if (surface === 'posts') vm.runInContext('me = { isAdmin: true }', page.ctx);
    if (surface === 'desk') vm.runInContext('isAdmin = true; authenticatedContext = { isAdmin: true }', page.ctx);
    vm.runInContext('publicationRefresh.start()', page.ctx);
    await vi.advanceTimersByTimeAsync(10000);
    const textOf = (node: Element): string => node.textContent + node.children.map(textOf).join(' ');
    if (surface === 'posts') {
      expect(textOf(page.el('postsList'))).toContain('Live — newer draft saved');
      expect(vm.runInContext('listStale', page.ctx)).toBe(false);
    } else if (surface === 'desk') {
      expect(textOf(page.el('deskUnpub'))).toContain('Live — newer draft saved');
      expect(page.el('deskPublicationSummary').textContent).toContain('2 photos in 1 stories');
    } else expect(page.el('publicationSummary').textContent).toContain('2 photos in 1 stories');
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    history.resolve(Response.json({ record: 'missing' }));
    await vi.advanceTimersByTimeAsync(0);
    vm.runInContext('publicationRefresh.stop()', page.ctx);
  } finally { vi.useRealTimers(); }
});

it.each([true, false])('Desk rebuild remains an explicit admin action and refreshes independent publication facts (admin=%s)', async (admin) => {
  const requests: { url: string; method: string }[] = [];
  const page = loadPage('public/index.html', { fetch: async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method || 'GET' });
    if (url === '/rebuild') return Response.json({ ok: false, code: 'build_failed', liveRelease: null });
    if (url === '/posts') return Response.json([]);
    if (url === '/publication/summary') return Response.json({ availability: 'available', release: 'none', posts: null, galleryDescriptions: null });
    return Response.json({ record: 'missing' });
  } }, ['public/desk.js']);
  vm.runInContext(`isAdmin = ${admin}; authenticatedContext = { isAdmin: ${admin} }; publicationRefresh.start(false)`, page.ctx);
  await page.el('deskRebuild').click();
  if (admin) {
    await (vm.runInContext('publicationRefresh.refresh()', page.ctx) as Promise<void>);
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([{ url: '/rebuild', method: 'POST' }]);
    expect(page.el('deskRebuildOutcome').textContent).toContain('The rebuild failed, so the live site was not updated');
    expect(page.el('deskRebuildOutcome').textContent).toContain('Nothing is live yet.');
    expect(page.el('deskPublicationSummary').textContent).toContain('No live release');
    expect(page.el('deskRebuild').disabled).toBe(false);
  } else expect(requests).toEqual([]);
  vm.runInContext('publicationRefresh.stop()', page.ctx);
});
