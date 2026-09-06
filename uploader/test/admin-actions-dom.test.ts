import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// posts.html and settings.html run their actions as plain top-level browser
// code. Load each inline script in a vm context backed by a stub DOM keyed on
// the REAL markup's ids (same precedent as editor-dom.test.ts) and pull the
// network out from under an in-flight action: the contract under test is that
// a rejected fetch leaves the page usable — the trigger re-enabled and the
// failure named in the status region — instead of an unhandled rejection with
// "Deleting…" frozen on screen (#139).

interface Element {
  value: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  style: Record<string, string>;
  listeners: Record<string, (() => Promise<void> | void)[]>;
  addEventListener(type: string, fn: () => Promise<void> | void): void;
  click(): Promise<void>;
  appendChild(): void;
  setAttribute(): void;
}

function element(): Element {
  const listeners: Element['listeners'] = {};
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
    style: {}, listeners,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    async click() { for (const fn of listeners.click ?? []) await fn(); },
    appendChild() {}, setAttribute() {},
  };
}

const NETWORK_DOWN = new TypeError('Failed to fetch');

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
    document: {
      getElementById: (id: string): Element | null => (ids.has(id) ? el(id) : null),
      createElement: () => element(),
    },
    location: { href: '', protocol: 'http:' },
    fetch: () => Promise.reject(NETWORK_DOWN),
    console,
    confirm: () => true,
    prompt: () => 'DELETE',
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    ...extraGlobals,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { ctx, el };
}

function loadPosts() {
  return loadPage('public/posts.html', {
    PostsFilter: { apply: () => [], REGIONS: [], countries: () => [], thumbUrl: () => null },
    PostsDuplicate: {},
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
    const load = vm.runInContext('load', ctx) as () => Promise<void>;
    await expect(load()).resolves.toBeUndefined();
    expect(el('out').textContent).toBe('Could not load posts: TypeError: Failed to fetch');
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
});
