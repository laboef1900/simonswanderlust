import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

// media-browser.js is the library page's DOM glue (media.html). Its two
// user-visible contracts that no pure helper can carry — the detail panel
// keeps unsaved edits across a re-render, and a superseded list response never
// paints — are exercised here against a tree-shaped DOM stub whose ids come
// from the REAL markup, the same precedent as editor-dom.test.ts.
const apiSrc = readFileSync('public/media-api.js', 'utf8');
const browserSrc = readFileSync('public/media-browser.js', 'utf8');
const markup = readFileSync('public/media.html', 'utf8');
const pageIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);

type Listener = (ev: Record<string, unknown>) => void;

class FakeNode {
  id = '';
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  clientWidth = 400;
  offsetWidth = 100;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners: Record<string, Listener[]> = {};
  constructor(public tagName: string) {}
  get innerHTML(): string { return ''; }
  set innerHTML(v: string) { if (v === '') this.children = []; }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { this.children.push(c); return c; }
  remove(): void {}
  focus(): void {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  dispatch(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) fn({ type, preventDefault() {}, ...ev });
  }
  querySelectorAll(sel: string): FakeNode[] {
    const cls = sel.replace(/^\./, '');
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.children) { if (c.className.split(' ').includes(cls)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  find(id: string): FakeNode | null {
    if (this.id === id) return this;
    for (const c of this.children) { const hit = c.find(id); if (hit) return hit; }
    return null;
  }
}

interface Item {
  key: string; title: string; folder: string; status: string;
  alt: { de: string; en: string }; caption: { de: string; en: string };
  tags: string[]; exif: null; width: number; height: number; origBytes: number; variantBytes: number;
}
function item(key: string, altDe = ''): Item {
  return {
    key, title: key, folder: '', status: 'ready', alt: { de: altDe, en: '' }, caption: { de: '', en: '' },
    tags: [], exif: null, width: 10, height: 10, origBytes: 1, variantBytes: 1,
  };
}

interface Deferred { url: string; resolve(body: unknown): void }

function loadPage(): {
  el(id: string): FakeNode;
  timers: { fn: () => void; cleared: boolean }[];
  listRequests: Deferred[];
  confirms: string[];
  confirmAnswer: { value: boolean };
  flush(): Promise<void>;
} {
  const roots = new Map<string, FakeNode>();
  for (const id of pageIds) { const n = new FakeNode('div'); n.id = id; roots.set(id, n); }
  const getElementById = (id: string): FakeNode | null => {
    for (const r of roots.values()) { const hit = r.find(id); if (hit) return hit; }
    return null;
  };
  const el = (id: string): FakeNode => {
    const n = getElementById(id);
    if (!n) throw new Error('no element #' + id);
    return n;
  };
  const timers: { fn: () => void; cleared: boolean }[] = [];
  const listRequests: Deferred[] = [];
  const confirms: string[] = [];
  const confirmAnswer = { value: false };
  const fetch = (url: string): Promise<unknown> => {
    if (url.startsWith('/media/folders')) return Promise.resolve({ status: 200, ok: true, json: async () => [] });
    // Executor form: the uploader's tsconfig lib predates Promise.withResolvers.
    return new Promise((resolve) => {
      listRequests.push({ url, resolve: (body) => resolve({ status: 200, ok: true, json: async () => body }) });
    });
  };
  const ctx: Record<string, unknown> = {
    document: {
      getElementById,
      createElement: (tag: string) => new FakeNode(tag),
    },
    location: { href: '' },
    fetch,
    setTimeout: (fn: () => void) => { timers.push({ fn, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    confirm: (msg: string) => { confirms.push(msg); return confirmAnswer.value; },
    prompt: () => null,
    console,
    FormData: class { append() {} },
    XMLHttpRequest: class {},
    Auth: { ensureAuthed: async () => ({ id: 'u1', username: 'simon', isAdmin: true }), renderHeader() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(apiSrc, ctx);
  vm.runInContext(browserSrc, ctx);
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await setImmediate(); };
  return { el, timers, listRequests, confirms, confirmAnswer, flush };
}

function runTimers(timers: { fn: () => void; cleared: boolean }[]): void {
  const due = timers.filter((t) => !t.cleared);
  timers.length = 0;
  for (const t of due) t.fn();
}

describe('media-browser detail panel', () => {
  it('keeps unsaved edits across a reload and asks before switching photos', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a', 'alt-a'), item('b', 'alt-b')], total: 2 });
    await page.flush();
    const [cellA, cellB] = page.el('grid').querySelectorAll('.media-cell');
    cellA!.dispatch('click');
    expect(page.el('detail').dataset.key).toBe('a');
    expect(page.el('dAltDe').value).toBe('alt-a');
    expect(page.el('dUnsaved').hidden).toBe(true);

    // Type, then trigger a reload through a filter change — the panel must
    // survive the re-render that rebuilds everything around it.
    page.el('dAltDe').value = 'Fjord at dawn';
    page.el('detail').dispatch('input');
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('fStatus').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a', 'alt-a'), item('b', 'alt-b')], total: 2 });
    await page.flush();
    expect(page.el('dAltDe').value).toBe('Fjord at dawn');

    // Declining the discard prompt keeps photo A on the panel …
    const grid = page.el('grid').querySelectorAll('.media-cell');
    grid[1]!.dispatch('click');
    expect(page.confirms).toHaveLength(1);
    expect(page.confirms[0]).toContain('"a"');
    expect(page.el('detail').dataset.key).toBe('a');
    expect(page.el('dAltDe').value).toBe('Fjord at dawn');

    // … accepting it moves on to B, and B's panel starts clean.
    page.confirmAnswer.value = true;
    grid[1]!.dispatch('click');
    expect(page.el('detail').dataset.key).toBe('b');
    expect(page.el('dAltDe').value).toBe('alt-b');
    expect(page.el('dUnsaved').hidden).toBe(true);
    void cellB;
  });

  it('re-clicking the same photo never prompts', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a')], total: 1 });
    await page.flush();
    const [cellA] = page.el('grid').querySelectorAll('.media-cell');
    cellA!.dispatch('click');
    page.el('detail').dispatch('input');
    cellA!.dispatch('click');
    expect(page.confirms).toHaveLength(0);
  });
});

describe('media-browser search', () => {
  it('debounces keystrokes and drops a list response that a later query superseded', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();

    page.el('fSearch').value = 'no';
    page.el('fSearch').dispatch('input');
    page.el('fSearch').value = 'norw';
    page.el('fSearch').dispatch('input');
    expect(page.listRequests).toHaveLength(0);
    runTimers(page.timers);
    await page.flush();
    // One request for the burst, carrying the final text.
    expect(page.listRequests).toHaveLength(1);
    expect(page.listRequests[0]!.url).toContain('q=norw');

    // A second, newer query goes out before the first answers …
    page.el('fSearch').value = 'norway';
    page.el('fSearch').dispatch('input');
    runTimers(page.timers);
    await page.flush();
    expect(page.listRequests).toHaveLength(2);
    const [older, newer] = page.listRequests;

    // … and answers AFTER it. The stale response must not paint.
    newer!.resolve({ items: [item('norway/1')], total: 1 });
    await page.flush();
    expect(page.el('out').textContent).toBe('1 photo(s)');
    older!.resolve({ items: [item('x/1'), item('x/2'), item('x/3')], total: 3 });
    await page.flush();
    expect(page.el('out').textContent).toBe('1 photo(s)');
    expect(page.el('grid').querySelectorAll('.media-cell')).toHaveLength(1);
  });
});
