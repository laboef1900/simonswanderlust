import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultSettings } from '../src/settings.js';

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
  options: { value: string }[];
  add(option: { value: string }): void;
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
    style: {}, listeners, options: [],
    add(option) { this.options.push(option); },
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
    location: { href: '', origin: 'http://localhost', protocol: 'http:' },
    fetch: () => Promise.reject(NETWORK_DOWN),
    console,
    confirm: () => true,
    prompt: () => 'DELETE',
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    AdminConfirm: { ask: async () => true, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
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
