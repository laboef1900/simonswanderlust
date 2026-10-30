import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
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

// posts.html, settings.html and comments.html run their actions as plain
// top-level browser code. Load each inline script in a vm context backed by a
// stub DOM keyed on the REAL markup's ids (same precedent as
// editor-dom.test.ts) and pull the network out from under an in-flight action:
// the contract under test is that a rejected fetch leaves the page usable —
// the trigger re-enabled and the failure named in the status region — instead
// of an unhandled rejection with "Deleting…" frozen on screen (#139).

interface Element {
  id: string;
  value: string;
  textContent: string;
  href: string;
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
  classList: { toggle(name: string, on?: boolean): void; contains(name: string): boolean };
  add(option: { value: string }): void;
  remove(index: number): void;
  listeners: Record<string, ((event?: Record<string, unknown>) => Promise<void> | void)[]>;
  addEventListener(type: string, fn: (event?: Record<string, unknown>) => Promise<void> | void): void;
  click(): Promise<void>;
  fire(type: string, event?: Record<string, unknown>): Promise<void>;
  appendChild(child?: Element): void;
  append(...children: Element[]): void;
  replaceChildren(): void;
  contains(node: unknown): boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Element[];
  focus(): void;
}

function element(): Element {
  const listeners: Element['listeners'] = {};
  const e: Element = {
    id: '', value: '', textContent: '', innerHTML: '', href: '', hidden: false, disabled: false, checked: false,
    indeterminate: false, open: false, focused: false, className: '', tabIndex: 0, dataset: {},
    src: '', alt: '', scrollLeft: 0, scrollTop: 0, files: [],
    style: {}, attrs: {}, listeners, options: [], children: [],
    classList: {
      toggle(name, on) {
        const names = new Set(e.className.split(/\s+/).filter(Boolean));
        if (on ?? !names.has(name)) names.add(name); else names.delete(name);
        e.className = [...names].join(' ');
      },
      contains(name) { return e.className.split(/\s+/).includes(name); },
    },
    add(option) { this.options.push(option); },
    remove(index) { this.options.splice(index, 1); },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    async click() { await this.fire('click'); },
    async fire(type, event = {}) {
      for (const fn of listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
    },
    appendChild(child) { if (child) this.children.push(child); },
    append(...children) { for (const child of children) this.appendChild(child); },
    replaceChildren() { this.children.length = 0; },
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    querySelectorAll() { return []; },
    focus() { this.focused = true; },
  };
  return e;
}

const NETWORK_DOWN = new TypeError('Failed to fetch');
const EDITOR_COPY = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));

type Listener = (event?: Record<string, unknown>) => Promise<void> | void;

function loadPage(file: string, extraGlobals: Record<string, unknown>, scripts: string[] = []): {
  ctx: Record<string, unknown>; el: (id: string) => Element; windowListeners: Record<string, Listener[]>;
} {
  const html = readFileSync(file, 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const script = html.slice(scriptStart + '<script>'.length, html.lastIndexOf('</script>'));
  const markup = html.slice(0, scriptStart);
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const elements = new Map<string, Element>();
  const el = (id: string): Element => {
    if (!ids.has(id)) throw new Error('no element #' + id + ' in ' + file);
    let e = elements.get(id);
    if (!e) { e = element(); e.id = id; elements.set(id, e); }
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
  const ctx: Record<string, unknown> = {
    // An element itself, so a page can listen on the document (outside-click
    // dismissal) and a test can fire there with an explicit target.
    document: Object.assign(element(), {
      referrer: '',
      title: '',
      getElementById: (id: string): Element | null => (ids.has(id) ? el(id) : null),
      createElement: () => element(),
    }),
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
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    URL,
    URLSearchParams,
    fetch: () => Promise.reject(NETWORK_DOWN),
    console,
    confirm: () => true,
    prompt: () => 'DELETE',
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    EditorCopy: { en: EDITOR_COPY },
    AdminConfirm: { ask: async () => true, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
    ...extraGlobals,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(renderGpxCopy(), ctx);
  for (const dependency of scripts) vm.runInContext(readFileSync(dependency, 'utf8'), ctx, { filename: dependency });
  vm.runInContext(script, ctx);
  return { ctx, el, windowListeners };
}

function loadPosts(extraGlobals: Record<string, unknown> = {}) {
  return loadPage('public/posts.html', {
    PostsFilter: {
      apply: (posts: unknown[]) => posts,
      REGIONS: [],
      countries: () => [],
      extraFilterCount: () => 0,
      fromSearch: () => ({ q: '', status: '', region: '', country: '', sort: 'updated', order: 'desc' }),
      thumbUrl: () => null,
      toSearch: () => '',
    },
    ...extraGlobals,
  });
}

const post = { translationKey: 'tk1', titleDe: 'Bukarest', slugDe: 'bukarest', slugEn: 'bucharest', status: 'published' };

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
    expect(el('listout').textContent).toBe(ui.en['editor.chrome.usersLoaded'].replace('{count}', '0'));
    stale.resolve(Response.json([user]));
    await oldLoad;
    expect(el('list').children).toHaveLength(0);
    expect(el('listout').textContent).toBe(ui.en['editor.chrome.usersLoaded'].replace('{count}', '0'));
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
});

describe('posts.html actions survive a dropped connection', () => {
  it('deletePost re-enables the row button and names the failure', async () => {
    const { ctx, el } = loadPosts();
    const btn = element();
    const deletePost = vm.runInContext('deletePost', ctx) as (p: unknown, btn: Element) => Promise<void>;
    await deletePost(post, btn);
    expect(btn.disabled).toBe(false);
    expect(el('out').textContent).toBe('Delete failed: TypeError: Failed to fetch');
  });

  it('unpublishPost re-enables the row button and names the failure', async () => {
    const { ctx, el } = loadPosts();
    const btn = element();
    const unpublishPost = vm.runInContext('unpublishPost', ctx) as (p: unknown, btn: Element) => Promise<void>;
    await unpublishPost(post, btn);
    expect(btn.disabled).toBe(false);
    expect(el('out').textContent).toBe('Unpublish failed: TypeError: Failed to fetch');
  });

  it('runBulk re-enables all three bulk buttons and names the failure', async () => {
    const { ctx, el } = loadPosts();
    vm.runInContext("selected.add('tk1'); allPosts = [" + JSON.stringify(post) + ']', ctx);
    const runBulk = vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>;
    await runBulk('delete');
    for (const id of ['bulkPublish', 'bulkUnpublish', 'bulkDelete']) expect(el(id).disabled).toBe(false);
    expect(el('out').textContent).toBe('Bulk delete failed: TypeError: Failed to fetch');
    // The selection is only cleared once the server confirmed the batch.
    expect(vm.runInContext('selected.size', ctx)).toBe(1);
  });

  it('Export all re-enables its button and names the failure', async () => {
    const { el } = loadPosts();
    await el('exportAll').click();
    expect(el('exportAll').disabled).toBe(false);
    expect(el('out').textContent).toBe('Export failed: TypeError: Failed to fetch');
  });

  it('load() reports a dropped connection instead of rejecting', async () => {
    const { ctx, el } = loadPosts();
    const load = vm.runInContext('load', ctx) as (statusMsg?: string) => Promise<void>;
    await expect(load()).resolves.toBeUndefined();
    expect(el('out').textContent).toBe('Could not load posts: TypeError: Failed to fetch');
  });

  it('a failed refresh keeps the action outcome the caller already reported', async () => {
    // Unpublish succeeded but its rebuild failed (200 with build.ok=false), then
    // the list refresh dies: the admin must still see that the old release is live.
    const { ctx, el } = loadPosts();
    const load = vm.runInContext('load', ctx) as (statusMsg?: string) => Promise<void>;
    await load('Unpublished "Bukarest". Rebuild failed: astro exited 1');
    expect(el('out').textContent).toBe('Unpublished "Bukarest". Rebuild failed: astro exited 1\nCould not load posts: TypeError: Failed to fetch');
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
    thumbUrl: () => null,
    toSearch: () => '',
  };

  it('keeps cross-filter selections visible, reviews every title, and clears them explicitly', async () => {
    const { ctx, el } = loadPosts({ PostsFilter: filterStub });
    const posts = [
      { ...post, translationKey: 'draft', titleDe: 'Draft story', status: 'draft' },
      { ...post, translationKey: 'live', titleDe: 'Live story', status: 'published' },
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
          { ...post, translationKey: 'a', titleDe: 'Alpha' },
          { ...post, translationKey: 'b', titleDe: 'Beta' },
          { ...post, translationKey: 'c', titleDe: 'Gamma' },
        ] };
      },
    });
    const posts = [
      { ...post, translationKey: 'a', titleDe: 'Alpha' },
      { ...post, translationKey: 'b', titleDe: 'Beta' },
      { ...post, translationKey: 'c', titleDe: 'Gamma' },
    ];
    vm.runInContext(`allPosts = ${JSON.stringify(posts)}; selected.add('a'); selected.add('b');`, ctx);
    mutateSelection = () => vm.runInContext(`selected.clear(); selected.add('c');`, ctx);

    await (vm.runInContext('runBulk', ctx) as (action: string) => Promise<void>)('publish');

    expect(confirmBody).toContain('"Alpha"');
    expect(confirmBody).toContain('"Beta"');
    expect(JSON.parse(requestBody)).toEqual({ action: 'publish', keys: ['a', 'b'] });
    expect(vm.runInContext('[...selected]', ctx)).toEqual(['c']);
  });

  it('retains only failed stories after a partial bulk result so they can be retried', async () => {
    const posts = [
      { ...post, translationKey: 'a', titleDe: 'Alpha' },
      { ...post, translationKey: 'b', titleDe: 'Beta' },
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
    const rows = ['limit', 'timeout', 'media'].map((key) => ({ ...post, translationKey: key, titleDe: key }));
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
    el('fStatus').value = 'missing-en';
    const editorHref = vm.runInContext('editorHref', ctx) as (key?: string) => string;
    const href = new URL(editorHref('pair/key'), 'http://localhost');
    expect(href.searchParams.get('tk')).toBe('pair/key');
    expect(href.searchParams.get('returnTo')).toBe('/admin/posts.html?q=Rhodes+%26+sun&status=missing-en');
    (vm.runInContext('render', ctx) as (updateUrl?: boolean) => void)(true);
    const newHref = new URL(el('newPost').href, 'http://localhost');
    expect(newHref.searchParams.has('tk')).toBe(false);
    expect(newHref.searchParams.get('returnTo')).toBe('/admin/posts.html?q=Rhodes+%26+sun&status=missing-en');
  });

  it('removes stale actions on load failure and Retry reaches a clean loaded state', async () => {
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

    expect(el('postsTable').hidden).toBe(true);
    expect(el('bulkBar').hidden).toBe(true);
    expect(el('retryLoad').hidden).toBe(false);
    expect(el('loadMsg').textContent).toBe('Posts could not be loaded.');
    expect(vm.runInContext('selected.size', ctx)).toBe(0);

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
  it('switching the view clears the previous view\'s empty-state message', async () => {
    const approved = {
      id: 'c1', name: 'Reader', isAuthor: false, translationKey: 'tk1', locale: 'de',
      createdAt: '2026-09-29T04:56:50Z', status: 'approved', body: 'Hallo',
    };
    const { el } = loadPage('public/comments.html', {
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ comments: [approved] }) }),
    });
    el('out').textContent = 'No pending comments.';
    el('statusFilter').value = 'approved';
    await el('statusFilter').fire('change');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(el('list').children).toHaveLength(1);
    expect(el('out').textContent).toBe('');
  });
});

describe('posts.html status views and language states', () => {
  // The real helper, not a stub: counts and filtering are its contract.
  const realFilter = () => {
    const windowStub: Record<string, unknown> = {};
    vm.runInNewContext(readFileSync('public/posts-filter.js', 'utf8'), { window: windowStub, URLSearchParams });
    return windowStub.PostsFilter;
  };
  const library = [
    { ...post, translationKey: 'a', titleDe: 'Altstadt', status: 'draft', country: 'Romania', region: 'europe', hasEnBody: true },
    { ...post, translationKey: 'b', titleDe: 'Parks', status: 'published', hasUnpublishedChanges: true, country: 'Romania', region: 'europe', hasEnBody: false },
    { ...post, translationKey: 'c', titleDe: 'Donau', status: 'published', country: 'Hungary', region: 'europe', hasEnBody: true },
    { ...post, translationKey: 'd', titleDe: 'Burg', status: 'draft', country: 'Hungary', region: 'europe' },
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
      { status: 'missing-en', pressed: 'false', count: '1' },
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
    el('fStatus').value = 'missing-en';
    await el('fStatus').fire('input');
    expect(views(el).map((v) => v.pressed)).toEqual(['false', 'false', 'false', 'false', 'true']);
  });

  it('hides the views and drops their counts when a reload fails', async () => {
    const { ctx, el } = await loadedPage('');
    expect(el('statusViews').hidden).toBe(false);
    ctx.fetch = () => Promise.reject(NETWORK_DOWN);
    await (vm.runInContext('load', ctx) as () => Promise<void>)();
    expect(el('statusViews').hidden).toBe(true);
    expect(views(el).map((v) => v.count)).toEqual(['', '', '', '', '']);
  });

  it('reports EN as present, missing or unknown only from hasEnBody, and keeps trip meta', () => {
    const { ctx, el } = loadPosts({ PostsFilter: realFilter() });
    const rows = [
      { ...post, translationKey: 'p', country: 'Romania', date: '2024-05-01', hasEnBody: true },
      { ...post, translationKey: 'm', country: 'Romania', date: '2024-05-01', hasEnBody: false },
      { ...post, translationKey: 'u', country: 'Romania', date: '2024-05-01' },
    ];
    (vm.runInContext('renderRows', ctx) as (posts: unknown[]) => void)(rows);

    const badges = el('postsList').children.map((row) => {
      const languages = row.children.find((td) => td.className === 'col-languages')?.children[0];
      if (!languages) throw new Error('Post language indicators are missing');
      return languages.children.map((badge) => ({ code: badge.textContent, className: badge.className, name: badge.attrs['aria-label'] }));
    });
    for (const rowBadges of badges) {
      expect(rowBadges[0]).toEqual({ code: 'DE', className: 'post-language', name: EDITOR_COPY.postsGermanLocale });
    }
    expect(badges.map((rowBadges) => rowBadges[1])).toEqual([
      { code: 'EN', className: 'post-language', name: EDITOR_COPY.postsEnglishPresent },
      { code: 'EN', className: 'post-language is-missing', name: EDITOR_COPY.postsEnglishMissing },
      { code: 'EN', className: 'post-language is-unknown', name: EDITOR_COPY.postsEnglishUnknown },
    ]);

    // Country and trip date survive under the title; only a confirmed missing
    // EN body adds the textual cue, an unknown one does not.
    const meta = el('postsList').children.map((row) => row.children.find((td) => td.className === 'col-title')!.children
      .find((child) => child.className === 'post-trip-meta')!.children.map((part) => part.className || part.textContent));
    expect(meta).toEqual([
      ['Romania', 'post-trip-sep', '2024-05-01'],
      ['Romania', 'post-trip-sep', '2024-05-01', 'post-trip-sep', 'post-locale-state'],
      ['Romania', 'post-trip-sep', '2024-05-01'],
    ]);
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

  it('gives an author Edit alone, never an empty More actions menu', () => {
    const { ctx, el } = loadPosts();
    expect(rowActions(ctx, el, false, [post, { ...post, translationKey: 'd', status: 'draft' }]))
      .toEqual([['Edit'], ['Edit']]);
  });

  it('gives an admin Unpublish on a live trip and Delete on every trip', () => {
    const { ctx, el } = loadPosts();
    expect(rowActions(ctx, el, true, [post, { ...post, translationKey: 'd', status: 'draft' }]))
      .toEqual([['Edit', ['Unpublish', 'Delete']], ['Edit', ['Delete']]]);
  });
});

// ---- settings.html ------------------------------------------------------------
// Fixtures mirror the AI provider registry contract (spec 2026-10-19 §4): the
// settings response every /settings and /ai-providers route answers with.

type ProviderKind = 'lm-studio' | 'openrouter' | 'deepseek' | 'custom';
interface ProviderView { id: string; name: string; kind: ProviderKind; baseUrl: string; hasApiKey: boolean }
interface SettingsResponse {
  aiProviders: ProviderView[];
  aiDefaultProviderId: string;
  reviewProviderId: string | null;
  captionProviderId: string | null;
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
    aiModel: 'review-model', reviewPrompt: 'Review prompt', reviewTimeoutMs: 60000,
    lmModel: 'vision-model', captionPrompt: 'Caption prompt', captionTimeoutMs: 60000, captionMaxTokens: 8000, captionMaxEdge: 768,
    backupSchedule: 'off', backupRetention: 14, convertJpeg: true, webpQuality: 75, avifQuality: 55,
    importDelayMs: 1200, importRetries: 3, commentsEnabled: false,
    geocodingSearchUrl: 'https://nominatim.openstreetmap.org/search',
    ...overrides,
  };
}

function loadSettingsPage(extra: Record<string, unknown> = {}) {
  return loadPage('public/settings.html', {
    LLM: { mixedContentWarning: () => '', listModels: async () => [] },
    AbortController, AbortSignal, setTimeout, clearTimeout,
    ...extra,
  }, ['public/tabs.js']);
}

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

/** settings.html over a contract-shaped fake API. `route` answers first; /settings is served from `state`. */
async function apiPage(initial: SettingsResponse, opts: {
  confirm?: (question: Question) => boolean;
  route?: (request: ApiRequest, setState: (next: SettingsResponse) => void) => Response | undefined;
  listModels?: (baseUrl: string, apiKey: string | null) => Promise<string[]>;
  mixedContentWarning?: (url: string, protocol: string) => string;
  hash?: string;
} = {}) {
  let state = initial;
  const setState = (next: SettingsResponse) => { state = next; };
  const requests: ApiRequest[] = [];
  const questions: Question[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const request: ApiRequest = {
      url, method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    requests.push(request);
    const routed = opts.route?.(request, setState);
    if (routed) return routed;
    if (url === '/settings' && request.method === 'POST') state = { ...state, ...(request.body as Partial<SettingsResponse>) };
    if (url === '/settings') return Response.json(state);
    return Response.json({ error: 'Unexpected request in this test.' }, { status: 500 });
  });
  const listedByDefault = async (_baseUrl: string, _apiKey: string | null): Promise<string[]> => ['model-a', 'model-b'];
  const listModels = vi.fn(opts.listModels ?? listedByDefault);
  const page = loadSettingsPage({
    fetch: fetcher,
    LLM: { mixedContentWarning: opts.mixedContentWarning ?? (() => ''), listModels },
    AdminConfirm: {
      ask: async (question: Question) => { questions.push(question); return opts.confirm ? opts.confirm(question) : true; },
    },
    ...(opts.hash === undefined ? {} : {
      location: {
        href: 'http://localhost/admin/settings.html' + opts.hash, origin: 'http://localhost',
        pathname: '/admin/settings.html', search: '', hash: opts.hash, protocol: 'http:',
      },
    }),
  });
  await callPage(page.ctx, 'fill', state);
  return { ...page, requests, questions, listModels, fetcher };
}

const calls = (requests: ApiRequest[]) => requests.map((r) => r.method + ' ' + r.url);

describe('settings.html tabs', () => {
  const PANELS = ['panel-ai-models', 'panel-images', 'panel-comments', 'panel-site'];

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

  it.each(['', '#', '#nope', '#__proto__'])('opens AI models for hash %j without rewriting the URL', (hash) => {
    const t = tabsPage(hash);
    expect(t.visible()).toEqual(['panel-ai-models']);
    expect(t.title()).toBe(' · AI models');
    expect(t.el('tabbtn-ai-models').attrs['aria-selected']).toBe('true');
    expect(t.replaced).toEqual([]);
  });

  it('opens a deep-linked tab with the roving tabindex and the title on it', () => {
    const t = tabsPage('#comments');
    expect(t.visible()).toEqual(['panel-comments']);
    expect(t.title()).toBe(' · Comments');
    expect(t.el('tabbtn-comments').tabIndex).toBe(0);
    expect(t.el('tabbtn-ai-models').tabIndex).toBe(-1);
  });

  it('a vertical index moves with Up/Down, Home/End, and mirrors the tab in the hash and title', async () => {
    const t = tabsPage();
    expect(t.el('settingsTabs').attrs['aria-orientation']).toBe('vertical');
    await t.el('tabbtn-ai-models').fire('keydown', { key: 'ArrowRight' });
    expect(t.visible()).toEqual(['panel-ai-models']);
    await t.el('tabbtn-ai-models').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-images']);
    expect(t.el('tabbtn-images').focused).toBe(true);
    expect(t.title()).toBe(' · Images');
    await t.el('tabbtn-images').fire('keydown', { key: 'End' });
    expect(t.visible()).toEqual(['panel-site']);
    expect(t.title()).toBe(' · Site & backups');
    await t.el('tabbtn-site').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-ai-models']);
    await t.el('tabbtn-ai-models').fire('keydown', { key: 'ArrowUp' });
    await t.el('tabbtn-site').fire('keydown', { key: 'Home' });
    expect(t.replaced).toEqual(['#images', '#site', '#ai-models', '#site', '#ai-models']);
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
    await t.el('tabbtn-ai-models').fire('keydown', { key: 'ArrowDown' });
    expect(t.visible()).toEqual(['panel-ai-models']);
    await t.el('tabbtn-ai-models').fire('keydown', { key: 'ArrowRight' });
    expect(t.visible()).toEqual(['panel-images']);
  });
});

describe('settings.html actions survive a dropped connection', () => {
  it('Back up now re-enables its button and names the failure in the backup status', async () => {
    const { el } = loadSettingsPage();
    await el('backupNow').click();
    expect(el('backupNow').disabled).toBe(false);
    expect(el('backupStatus').textContent).toBe('Backup failed: TypeError: Failed to fetch');
  });

  it('Rebuild site now re-enables its button and names the failure', async () => {
    const { el } = loadSettingsPage();
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).toBe('Rebuild failed: TypeError: Failed to fetch');
  });

  it('Rebuild does not start when the confirm is declined', async () => {
    const { el } = loadSettingsPage({ AdminConfirm: { ask: async () => false } });
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).not.toMatch(/Rebuilding|Rebuilt|failed/);
  });
});

describe('settings.html providers', () => {
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
    for (const part of [EDITOR_COPY.settingsWriting, EDITOR_COPY.settingsCaptions, ROUTER.baseUrl, LOCAL.baseUrl]) {
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
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER], reviewProviderId: 'lm-studio', captionProviderId: 'lm-studio' }));
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

  it('two use cases on one provider share a single lookup', async () => {
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

  it('a failed lookup keeps the saved model and Other, and names the likely causes without provider text', async () => {
    const page = await apiPage(settingsResponse(), {
      listModels: async () => { throw new Error('fixture-provider-detail'); },
    });
    const { el } = page;
    await callPage(page.ctx, 'init');
    expect(modelOptions(el, 'aiModel')).toEqual(['review-model', 'Other model ID…']);
    expect(el('aiModel').value).toBe('review-model');
    expect(el('aiModel').attrs['aria-busy']).toBe('false');
    expect(el('reviewModelStatus').textContent).toMatch(/^Could not list models from Local LM Studio\. .*API key.*CORS.*online/);
    expect(pageText(el)).not.toContain('fixture-provider-detail');
  });

  it('a stored key that cannot be loaded, or a missing required key, fails without asking the provider', async () => {
    const page = await apiPage(settingsResponse({ aiProviders: [LOCAL, ROUTER, DEEPSEEK], reviewProviderId: 'openrouter', captionProviderId: 'deepseek' }), {
      route: (request) => (request.url.endsWith('/credential') ? Response.json({ error: 'Secrets unavailable.' }, { status: 503 }) : undefined),
    });
    const { el } = page;
    await callPage(page.ctx, 'init');
    expect(page.listModels).not.toHaveBeenCalled();
    expect(el('reviewModelStatus').textContent).toMatch(/^Could not list models from OpenRouter\./);
    expect(el('captionModelStatus').textContent).toBe('DeepSeek needs an API key to list its models. Edit the provider to add one, or choose “Other model ID…”.');
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
    el('reviewTimeoutMs').value = '45000';
    el('captionPrompt').value = 'C';
    el('captionTimeoutMs').value = '30000';
    el('captionMaxEdge').value = '1024';
    el('captionMaxTokens').value = '4096';
    await el('saveAi').click();
    expect(calls(page.requests)).toEqual(['POST /settings']);
    expect(page.requests[0]!.body).toEqual({
      reviewProviderId: 'openrouter', captionProviderId: null, aiModel: 'review-2', lmModel: 'vision-2',
      reviewPrompt: 'R', reviewTimeoutMs: 45000, captionPrompt: 'C', captionTimeoutMs: 30000, captionMaxEdge: 1024,
      captionMaxTokens: 4096,
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
    expect(page.el('out').textContent).toBe('Saved.');
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
    const page = loadSettingsPage({ fetch: fetcher });
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
      el('reviewTimeoutMs').value = '5000';
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
      storageDir: dir, baseUrl: 'https://images.example', imgHost: 'images.example', siteDir: join(dir, 'site'),
      users, sessions, secrets, settings, media, encodeQueue: queue,
      posts: memoryPostStore(), pages: memoryPageStore(),
      builder: { build: unavailable, hasRelease: () => false, quiesce: async () => {} }, backupDir: join(dir, 'backup'),
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
      fetch: fetcher,
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

  it('a provider added with a key and assigned to review is what /ai-config hands out, and only to review', async () => {
    const { el, ctx, fetcher, app, cookies, settings, secrets } = await realPage();
    await el('addProvider').click();
    el('providerName').value = 'Router';
    el('providerApiKey').value = 'fixture-created-key';
    await el('providerForm').fire('submit');
    const created = settings.get().aiProviders.find((p) => p.name === 'Router');
    expect(created).toMatchObject({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(await secrets.get('ai_provider_key:' + created!.id)).toBe('fixture-created-key');
    expect(el('providerApiKey').value).toBe('');
    expect(pageText(el)).not.toContain('fixture-created-key');

    el('reviewProviderId').value = created!.id;
    await el('reviewProviderId').fire('change');
    await callPage(ctx, 'ensureModels');
    const listing = fetcher.mock.calls.find(([url]) => String(url) === 'https://openrouter.ai/api/v1/models');
    expect(new Headers(listing?.[1]?.headers).get('authorization')).toBe('Bearer fixture-created-key');
    expect(pageText(el)).not.toContain('fixture-created-key');
    await chooseModel(el, 'aiModel', 'remote-model');
    await el('saveAi').click();
    expect(settings.get()).toMatchObject({ reviewProviderId: created!.id, captionProviderId: null, aiModel: 'remote-model' });

    const config = (await app.inject({ url: '/ai-config', cookies })).json();
    expect(config).toMatchObject({
      aiProvider: 'openrouter', aiBaseUrl: 'https://openrouter.ai/api/v1', hasAiApiKey: true, aiApiKey: 'fixture-created-key',
    });
    const caption = (await app.inject({ url: '/ai-config?purpose=caption', cookies })).json();
    expect(caption).toMatchObject({ captionProvider: 'lm-studio', captionApiKey: null });
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
    [500, {}, 'The preview failed (HTTP 500). Try again.'],
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

  it('asks for a photo and a valid quality before sending anything', async () => {
    const { el, fetch } = await previewPage();
    await el('previewRun').click();
    expect(el('previewOut').textContent).toBe('Choose a test photo first.');
    el('previewFile').files = [photo()];
    for (const quality of ['0', '101', '7.5', '']) {
      el('webpQuality').value = quality;
      await el('previewRun').click();
      expect(el('previewOut').textContent).toBe('Set the WebP quality to a whole number from 1 to 100 first.');
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
