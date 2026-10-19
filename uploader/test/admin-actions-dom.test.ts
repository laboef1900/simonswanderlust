import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createSettingsStore, defaultSettings, type Settings } from '../src/settings.js';
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
  style: Record<string, string>;
  attrs: Record<string, string>;
  options: { value: string }[];
  children: Element[];
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
  focus(): void;
}

function element(): Element {
  const listeners: Element['listeners'] = {};
  return {
    id: '', value: '', textContent: '', innerHTML: '', href: '', hidden: false, disabled: false, checked: false,
    indeterminate: false, open: false, focused: false, className: '',
    style: {}, attrs: {}, listeners, options: [], children: [],
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
    focus() { this.focused = true; },
  };
}

const NETWORK_DOWN = new TypeError('Failed to fetch');
const EDITOR_COPY = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));

function loadPage(file: string, extraGlobals: Record<string, unknown>): { ctx: Record<string, unknown>; el: (id: string) => Element } {
  const html = readFileSync(file, 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const script = html.slice(scriptStart + '<script>'.length, html.lastIndexOf('</script>'));
  const ids = new Set([...html.slice(0, scriptStart).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const elements = new Map<string, Element>();
  const el = (id: string): Element => {
    if (!ids.has(id)) throw new Error('no element #' + id + ' in ' + file);
    let e = elements.get(id);
    if (!e) { e = element(); elements.set(id, e); }
    return e;
  };
  const ctx: Record<string, unknown> = {
    // An element itself, so a page can listen on the document (outside-click
    // dismissal) and a test can fire there with an explicit target.
    document: Object.assign(element(), {
      referrer: '',
      getElementById: (id: string): Element | null => (ids.has(id) ? el(id) : null),
      createElement: () => element(),
    }),
    location: {
      href: 'http://localhost/admin/posts.html',
      origin: 'http://localhost',
      pathname: '/admin/posts.html',
      search: '',
      protocol: 'http:',
    },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    fetch: () => Promise.reject(NETWORK_DOWN),
    console,
    confirm: () => true,
    prompt: () => 'DELETE',
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    EditorCopy: { en: EDITOR_COPY },
    AdminConfirm: { ask: async () => true, askFields: async () => null, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
    ...extraGlobals,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { ctx, el };
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
    PostsDuplicate: {},
    ...extraGlobals,
  });
}

const post = { translationKey: 'tk1', titleDe: 'Bukarest', slugDe: 'bukarest', slugEn: 'bucharest', status: 'published' };

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
        askFields: async () => null,
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

describe('settings.html actions survive a dropped connection', () => {
  const loadSettings = () => loadPage('public/settings.html', { LLM: { mixedContentWarning: () => '' } });

  it('Back up now re-enables its button and names the failure in the backup status', async () => {
    const { el } = loadSettings();
    await el('backupNow').click();
    expect(el('backupNow').disabled).toBe(false);
    expect(el('backupStatus').textContent).toBe('Backup failed: TypeError: Failed to fetch');
  });

  it('Rebuild site now re-enables its button and names the failure', async () => {
    const { el } = loadSettings();
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).toBe('Rebuild failed: TypeError: Failed to fetch');
  });

  it('Rebuild does not start when the confirm is declined', async () => {
    const { el } = loadPage('public/settings.html', {
      LLM: { mixedContentWarning: () => '' },
      AdminConfirm: { ask: async () => false },
    });
    await el('rebuild').click();
    expect(el('rebuild').disabled).toBe(false);
    expect(el('out').textContent).not.toMatch(/Rebuilding|Rebuilt|failed/);
  });
});

describe('settings.html shared review key lifecycle', () => {
  function loadReview(fetch: (url: string, init?: { body?: string; method?: string }) => Promise<unknown>, confirm = async (_question: unknown) => true) {
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const page = loadPage('public/settings.html', {
      LLM: { mixedContentWarning: () => '' },
      Option: class { constructor(public text: string, public value: string) {} },
      fetch,
      AdminConfirm: { ask: confirm },
    });
    (page.ctx.fill as (state: unknown) => void)(state);
    return { ...page, state };
  }

  it('leaves an untouched blank key out of the save and never sends a provider request', async () => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const { el } = loadReview(async (url, init) => {
      requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, json: async () => state };
    });
    await el('saveReview').click();
    expect(requests.map((r) => r.url)).toEqual(['/settings', '/settings']);
    expect(requests[0]!.body).not.toHaveProperty('aiApiKey');
    expect(el('aiKeyStatus').textContent).toBe('Configured');
    expect(el('aiApiKey').value).toBe('');
    expect(el('saveReview').disabled).toBe(false);
  });

  it('preserves a pending review destination and replacement key when caption settings are saved', async () => {
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const { el } = loadReview(async () => ({ ok: true, status: 200, json: async () => state }));
    el('aiProvider').value = 'deepseek';
    el('aiModel').value = 'pending-review-model';
    el('aiApiKey').value = 'pending-provider-key';
    await el('aiProvider').listeners.change![0]!();
    await el('saveAi').click();
    expect(el('aiProvider').value).toBe('deepseek');
    expect(el('aiModel').value).toBe('pending-review-model');
    expect(el('aiApiKey').value).toBe('pending-provider-key');
    expect(el('reviewKeyWarning').hidden).toBe(false);
  });

  it('preserves pending caption edits when review settings are saved', async () => {
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const { el } = loadReview(async () => ({ ok: true, status: 200, json: async () => state }));
    el('baseUrl').value = 'http://localhost:1235/v1';
    el('prompt').value = 'Unsaved caption instructions';
    await el('saveReview').click();
    expect(el('baseUrl').value).toBe('http://localhost:1235/v1');
    expect(el('prompt').value).toBe('Unsaved caption instructions');
  });

  it('shows the saved local review destination rather than an unsaved caption URL', async () => {
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const { el } = loadReview(async () => ({ ok: true, status: 200, json: async () => state }));
    el('baseUrl').value = 'http://localhost:1235/v1';
    el('aiProvider').value = 'lm-studio';
    await el('aiProvider').listeners.change![0]!();
    expect(el('reviewDestination').textContent).toContain(state.lmBaseUrl);
    expect(el('reviewDestination').textContent).not.toContain('http://localhost:1235/v1');
  });

  it('clears the entered secret and reloads the old destination after a partial failure', async () => {
    const state = { ...defaultSettings(), aiProvider: 'openrouter', hasAiApiKey: true };
    const { el } = loadReview(async (_url, init) => init?.method === 'POST'
      ? { ok: false, status: 500, json: async () => ({ code: 'settings_partial_failure', error: 'API key change saved, but settings were not saved.' }) }
      : { ok: true, status: 200, json: async () => state });
    el('aiApiKey').value = 'disposable-ui-fixture';
    el('prompt').value = 'Unsaved caption instructions';
    el('aiProvider').value = 'deepseek';
    await el('aiProvider').listeners.change![0]!();
    expect(el('reviewKeyWarning').textContent).toContain('https://api.deepseek.com/v1');
    await el('saveReview').click();
    expect(el('aiApiKey').value).toBe('');
    expect(el('aiProvider').value).toBe('openrouter');
    expect(el('reviewOut').textContent).toContain('API key change saved');
    expect(el('reviewOut').textContent).not.toContain('disposable-ui-fixture');
    expect(el('removeAiKey').disabled).toBe(false);
    expect(el('prompt').value).toBe('Unsaved caption instructions');
  });

  it('requires removal confirmation, then sends null rather than erasing an untouched blank field', async () => {
    const bodies: Record<string, unknown>[] = [];
    let approve = false;
    const state = { ...defaultSettings(), hasAiApiKey: false };
    const { el } = loadReview(async (_url, init) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => state };
    }, async () => approve);
    await el('removeAiKey').click();
    expect(bodies).toEqual([]);
    approve = true;
    await el('removeAiKey').click();
    expect(bodies).toEqual([{ aiApiKey: null }]);
    expect(el('aiKeyStatus').textContent).toBe('Not configured');
    expect(el('removeAiKey').disabled).toBe(true);
  });

  it('names unknown outcome and failed reload without retaining the typed key', async () => {
    const { el } = loadReview(async () => { throw NETWORK_DOWN; });
    el('aiApiKey').value = 'disposable-ui-fixture';
    await el('saveReview').click();
    expect(el('aiApiKey').value).toBe('');
    expect(el('reviewOut').textContent).toContain('outcome is unknown');
    expect(el('reviewOut').textContent).toContain('Reload failed');
    expect(el('aiKeyStatus').textContent).toBe('Unknown — reload');
  });
});

describe('settings.html caption providers', () => {
  function setup(overrides: Record<string, unknown> = {}, approve = true) {
    let state = { ...defaultSettings(), hasAiApiKey: true, ...overrides };
    const requests: string[] = [];
    const confirm = vi.fn(async (_question: unknown) => approve);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url === '/settings') {
        if (init?.body) state = { ...state, ...JSON.parse(String(init.body)) };
        return Response.json(state);
      }
      if (url === '/ai-config?purpose=caption') return Response.json({
        ...state, captionBaseUrl: 'https://vision.example/v1', captionApiKey: 'fixture-stored-caption-key',
      });
      return Response.json({ data: [{ id: 'vision-model' }] });
    });
    const page = loadPage('public/settings.html', {
      fetch: fetcher, AbortController, AbortSignal, setTimeout, clearTimeout,
      Option: class { constructor(public text: string, public value: string) {} },
      AdminConfirm: { ask: confirm },
    });
    vm.runInContext(readFileSync('public/llm.js', 'utf8'), page.ctx);
    (page.ctx.fill as (state: unknown) => void)(state);
    return { ...page, fetcher, requests, confirm, state: () => state };
  }

  it('requires consent before sending an existing shared key to a new caption destination', async () => {
    const { el, requests, confirm, state } = setup({}, false);
    el('captionProvider').value = 'custom';
    el('captionCustomBaseUrl').value = 'https://vision.example/v1';
    await el('captionProvider').fire('change');
    expect(el('customCaptionFields').hidden).toBe(false);
    expect(el('captionKeyWarning').hidden).toBe(false);
    expect(el('captionKeyWarning').textContent).toContain('https://vision.example/v1');
    await el('saveAi').click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
    expect(state().captionProvider).toBe('lm-studio');
  });

  it('persists caption selection without saving pending review edits or changing the shared key', async () => {
    const { el, state, ctx } = setup();
    el('captionProvider').value = 'custom';
    el('captionCustomBaseUrl').value = 'https://vision.example/v1';
    el('modelManual').value = 'vision-model';
    el('aiProvider').value = 'deepseek';
    el('aiApiKey').value = 'unsaved-key';
    await el('saveAi').click();
    expect(state()).toMatchObject({
      captionProvider: 'custom', captionCustomBaseUrl: 'https://vision.example/v1',
      lmModel: 'vision-model', aiProvider: 'lm-studio', hasAiApiKey: true,
    });
    expect(state()).not.toHaveProperty('aiApiKey');
    expect(el('aiProvider').value).toBe('deepseek');
    expect(el('aiApiKey').value).toBe('unsaved-key');
    (ctx.fill as (state: unknown) => void)(state());
    expect(el('captionProvider').value).toBe('custom');
    expect(el('captionKeyWarning').hidden).toBe(true);
  });

  it('does no remote discovery on load; explicit connection test uses saved caption credentials without filling the key field', async () => {
    const { el, ctx, requests, fetcher } = setup({
      captionProvider: 'custom', captionCustomBaseUrl: 'https://vision.example/v1', lmModel: 'vision-model',
    });
    await (ctx.loadModels as () => Promise<void>)();
    expect(requests).toEqual([]);
    await el('test').click();
    expect(requests).toEqual(['/ai-config?purpose=caption', 'https://vision.example/v1/models']);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer fixture-stored-caption-key');
    expect(el('captionOut').textContent).toMatch(/Reachable/);
    expect(el('captionOut').textContent).not.toContain('fixture-stored-caption-key');
    expect(el('aiApiKey').value).toBe('');
    expect(el('test').disabled).toBe(false);
  });

  it('never sends a saved key to an unsaved test destination', async () => {
    const { el, requests } = setup({ captionProvider: 'custom', captionCustomBaseUrl: 'https://vision.example/v1' });
    el('captionCustomBaseUrl').value = 'https://other.example/v1';
    await el('test').click();
    expect(requests).toEqual(['/ai-config?purpose=caption']);
    expect(el('captionOut').textContent).toContain('Save the alt-text provider settings');
    expect(el('test').disabled).toBe(false);
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
  function setup(provider = 'openrouter', stored = false, network: typeof fetch = async () => completion()) {
    const fetcher = vi.fn(network);
    const page = loadPage('public/settings.html', {
      fetch: fetcher, AbortController, setTimeout, clearTimeout,
      Option: class { constructor(public text: string, public value: string) {} },
    });
    vm.runInContext(readFileSync('public/llm.js', 'utf8'), page.ctx);
    (page.ctx.fill as (state: unknown) => void)({
      ...defaultSettings(), aiProvider: provider, aiModel: 'selected-model', hasAiApiKey: stored,
    });
    return { ...page, fetcher };
  }

  let closeServer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  // Use actual authenticated /settings and /ai-config handlers: a fabricated
  // key response hid the local-to-remote transition's isolation rule.
  async function setupStoredKey(provider: Settings['aiProvider'] = 'lm-studio') {
    const dir = await mkdtemp(join(tmpdir(), 'settings-review-'));
    const settings = createSettingsStore({
      path: join(dir, 'settings.json'),
      defaults: { ...defaultSettings(), aiProvider: provider, aiModel: 'selected-model', captionProvider: 'openrouter' },
      log: () => {},
    });
    const secrets = memorySecretsStore();
    await secrets.set('ai_api_key', 'fixture-stored');
    const getSecret = vi.spyOn(secrets, 'get');
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const user = await users.create({ username: 'review-fixture', password: 'password123456', isAdmin: true });
    const cookies = { sid: await sessions.create(user.id, 60_000) };
    const media = memoryMediaStore({ baseUrl: 'https://images.example' });
    const queue = createEncodeQueue({ store: media, storageDir: dir, lock: createWorkLock() });
    const unavailable = async (): Promise<never> => { throw new Error('Not part of this settings test'); };
    const app = buildServer({
      storageDir: dir, baseUrl: 'https://images.example', imgHost: 'images.example', siteDir: join(dir, 'site'),
      users, sessions, secrets, settings, media, encodeQueue: queue,
      posts: memoryPostStore(), pages: memoryPageStore(),
      builder: { build: unavailable, hasRelease: () => false }, backupDir: join(dir, 'backup'),
      dbBackup: { dir, runNow: unavailable, running: () => false, sweepTempFiles: () => [], list: () => [], listImageArchives: () => [], state: () => ({}) },
      dbCheck: unavailable,
    });
    closeServer = async () => {
      await app.close();
      await queue.drain();
      await rm(dir, { recursive: true, force: true });
    };
    const page = setup(provider, true, async (input, init) => {
      const url = String(input);
      if (!url.startsWith('/')) return completion();
      const response = await app.inject({
        url, method: init?.method === 'POST' ? 'POST' : 'GET', cookies,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        payload: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(response.body, { status: response.statusCode });
    });
    const response = await app.inject({ url: '/settings', cookies });
    expect(response.statusCode).toBe(200);
    (page.ctx.fill as (state: unknown) => void)(response.json());
    return { ...page, app, cookies, settings, secrets, getSecret };
  }

  it('saves the photo output budget, rejects an invalid replacement, and reloads the saved value', async () => {
    const { el, ctx, app, cookies, settings, fetcher } = await setupStoredKey();
    el('captionMaxTokens').value = '4096';
    await el('saveAi').click();
    expect(settings.get().captionMaxTokens).toBe(4096);
    const config = await app.inject({ url: '/ai-config?purpose=caption', cookies });
    expect(config.json().captionMaxTokens).toBe(4096);

    el('captionMaxTokens').value = '255';
    await el('saveAi').click();
    expect(settings.get().captionMaxTokens).toBe(4096);
    expect(el('captionOut').textContent).toMatch(/not saved/i);
    expect(el('captionMaxTokens').value).toBe('255');

    const response = await app.inject({ url: '/settings', cookies });
    (ctx.fill as (state: unknown) => void)(response.json());
    expect(Number(el('captionMaxTokens').value)).toBe(4096);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/'))).toBe(true);
  });

  it.each(['openrouter', 'deepseek', 'custom'])('requires an entered key for an unsaved local-to-%s switch, without reading the stored key', async (provider) => {
    const { el, fetcher, app, cookies, settings, getSecret } = await setupStoredKey();
    const config = await app.inject({ url: '/ai-config', cookies });
    expect(config.json()).toMatchObject({ aiProvider: 'lm-studio', hasAiApiKey: true, aiApiKey: null });
    el('aiProvider').value = provider;
    el('aiCustomBaseUrl').value = 'https://review.example/v1';
    await el('aiProvider').fire('change');
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestLocalKey);
    expect(el('testReview').disabled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();

    el('aiApiKey').value = 'fixture-entered';
    await el('aiApiKey').fire('input');
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-entered' });
    expect(settings.get()).toMatchObject({ aiProvider: 'lm-studio', captionProvider: 'openrouter' });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('can save the remote provider first, then test with the existing stored key', async () => {
    const { el, fetcher, settings, secrets } = await setupStoredKey();
    el('aiProvider').value = 'deepseek';
    await el('aiProvider').fire('change');
    await el('saveReview').click();
    expect(settings.get()).toMatchObject({ aiProvider: 'deepseek', captionProvider: 'openrouter' });
    expect(await secrets.get('ai_api_key')).toBe('fixture-stored');
    fetcher.mockClear();
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-config', 'https://api.deepseek.com/v1/chat/completions']);
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-stored' });
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
    expect(el('aiApiKey').value).toBe('');
  });

  it('respects a switch back to local made after this settings page loaded', async () => {
    const { el, fetcher, settings, getSecret } = await setupStoredKey('openrouter');
    settings.update({ aiProvider: 'lm-studio' });
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-config']);
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestLocalKey);
    expect(el('testReview').disabled).toBe(false);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each(['openrouter', 'deepseek'])('requires a key before contacting %s', async (provider) => {
    const { el, fetcher } = setup(provider);
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestMissingKey);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('tests an unsaved replacement against the selected destination without saving or loading the old key', async () => {
    const { el, fetcher } = setup('openrouter', true);
    el('aiProvider').value = 'deepseek';
    el('aiApiKey').value = ' fixture-replacement';
    await el('aiProvider').fire('change');
    await el('testReview').click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer  fixture-replacement' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'selected-model' });
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
    expect(el('aiApiKey').value).toBe(' fixture-replacement');
    await el('aiModel').fire('input');
    expect(el('reviewTestOut').textContent).toBe('');
  });

  it('loads a stored key only on explicit test and never puts it into the form', async () => {
    const { el, fetcher } = setup('openrouter', true, async (url) =>
      url === '/ai-config' ? Response.json({ aiApiKey: 'fixture-stored' }) : completion());
    expect(fetcher).not.toHaveBeenCalled();
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-config', 'https://openrouter.ai/api/v1/chat/completions']);
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-stored' });
    expect(el('aiApiKey').value).toBe('');
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
  });

  it('keeps local tests independent of the stored remote key', async () => {
    const { el, fetcher } = setup('lm-studio', true);
    el('aiApiKey').value = 'unused-fixture';
    await el('testReview').click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('Authorization');
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestSuccess);
  });

  it.each([
    [401, 'reviewTestAuthentication'], [402, 'reviewTestCredits'],
    [429, 'reviewTestRateLimit'], [503, 'reviewTestFailed'],
  ] as const)('reports HTTP %s without leaking provider response content', async (status, message) => {
    const { el } = setup('deepseek', false, async () => new Response('fixture-secret-in-error', { status }));
    el('aiApiKey').value = 'fixture-key';
    await el('testReview').click();
    expect(el('testReview').disabled).toBe(false);
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY[message]);
  });

  it('does not mistake an HTTP success with invalid model output for a working review configuration', async () => {
    const { el } = setup('lm-studio', false, async () => Response.json({ choices: [{ message: { content: 'hello' } }] }));
    await el('testReview').click();
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestFailed);
  });

  it('does not contact a provider when the stored key cannot be loaded', async () => {
    const { el, fetcher } = setup('deepseek', true, async () => new Response('', { status: 503 }));
    await el('testReview').click();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/ai-config']);
    expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestKeyUnavailable);
  });

  it('cancels an in-flight test when fields change and discards its result', async () => {
    const pending = Promise.withResolvers<Response>();
    const { el, fetcher } = setup('lm-studio', false, async () => pending.promise);
    const testing = el('testReview').click();
    await el('aiProvider').fire('change');
    pending.resolve(completion());
    await testing;
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(el('reviewTestOut').textContent).toBe('');
    expect(el('testReview').disabled).toBe(false);
  });

  it('bounds a stalled provider request and leaves the button usable', async () => {
    vi.useFakeTimers();
    try {
      const { el } = setup('lm-studio', false, async () => new Promise<Response>(() => {}));
      el('reviewTimeoutMs').value = '5000';
      const testing = el('testReview').click();
      await vi.advanceTimersByTimeAsync(5000);
      await testing;
      expect(el('reviewTestOut').textContent).toBe(EDITOR_COPY.reviewTestTimedOut);
      expect(el('testReview').disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('settings.html image controls', () => {
  function loadImageSettings(fetch?: (url: string, init?: { body?: string }) => Promise<unknown>) {
    const page = loadPage('public/settings.html', {
      LLM: { mixedContentWarning: () => '' },
      Option: class { constructor(public text: string, public value: string) {} },
      ...(fetch ? { fetch } : {}),
    });
    (page.ctx.fill as (state: unknown) => void)({ ...defaultSettings(), hasAiApiKey: false });
    return page;
  }

  it('keeps pending values and allows retry after a dropped save connection', async () => {
    const { el } = loadImageSettings();
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
    let persisted = { ...defaultSettings(), hasAiApiKey: false };
    const { el } = loadImageSettings(async (_url, init) => {
      persisted = { ...persisted, ...JSON.parse(init?.body ?? '{}') };
      return { ok: true, status: 200, json: async () => persisted };
    });
    el('baseUrl').value = 'http://localhost:1235/v1';
    el('backupSchedule').value = 'weekly';
    el('aiModel').value = 'unsaved-review-model';
    el('convertJpeg').checked = false;
    el('webpQuality').value = '86';
    await el('imageSettings').fire('submit');
    expect(persisted).toMatchObject({
      convertJpeg: false, webpQuality: 86, avifQuality: 55,
      lmBaseUrl: defaultSettings().lmBaseUrl, backupSchedule: 'off',
    });
    expect(el('baseUrl').value).toBe('http://localhost:1235/v1');
    expect(el('backupSchedule').value).toBe('weekly');
    expect(el('aiModel').value).toBe('unsaved-review-model');
    expect(el('saveImages').disabled).toBe(false);
  });
});
