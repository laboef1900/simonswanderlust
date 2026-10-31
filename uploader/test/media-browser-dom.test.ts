import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

// media-browser.js is the library page's DOM glue (media.html). Its
// user-visible contracts that no pure helper can carry — the detail panel
// keeps unsaved edits across a re-render, a superseded list response never
// paints, an AI suggestion lands only in its own photo's panel and saves
// nothing, and the bulk dialog saves only what it says — are exercised here
// against a tree-shaped DOM stub whose ids come from the REAL markup, the same
// precedent as editor-dom.test.ts. The model itself is stubbed at the
// AltSuggest/LLM seam; media-ai.js and media-ai-dialog.js run for real.
const apiSrc = readFileSync('public/media-api.js', 'utf8');
const aiSrc = readFileSync('public/media-ai.js', 'utf8');
const dialogSrc = readFileSync('public/media-ai-dialog.js', 'utf8');
const browserSrc = readFileSync('public/media-browser.js', 'utf8');
const markup = readFileSync('public/media.html', 'utf8');
const pageIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
const checkedIds = new Set([...markup.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*\bchecked\b/g)].map((m) => m[1]!));

type Listener = (ev: Record<string, unknown>) => void;

class FakeNode {
  id = '';
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  tabIndex = 0;
  clientWidth = 400;
  offsetWidth = 100;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners: Record<string, Listener[]> = {};
  constructor(public tagName: string, private focusState?: { activeElement: FakeNode | null }) {}
  get innerHTML(): string { return ''; }
  set innerHTML(v: string) {
    if (v !== '') return;
    if (this.focusState && this.children.some((child) => child.contains(this.focusState!.activeElement))) {
      this.focusState.activeElement = null;
    }
    this.children = [];
  }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { this.children.push(c); return c; }
  remove(): void {}
  focus(): void { if (this.focusState) this.focusState.activeElement = this; }
  contains(node: FakeNode | null): boolean { return this === node || this.children.some((child) => child.contains(node)); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch('close'); }
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
  key: string; title: string; folder: string; status: string; thumbSrc: string;
  alt: { de: string; en: string }; caption: { de: string; en: string };
  tags: string[]; exif: null; width: number; height: number; origBytes: number; variantBytes: number;
}
function item(key: string, altDe = ''): Item {
  return {
    key, title: key, folder: '', status: 'ready', thumbSrc: 'https://img.example/' + key + '-640.webp',
    alt: { de: altDe, en: '' }, caption: { de: '', en: '' },
    tags: [], exif: null, width: 10, height: 10, origBytes: 1, variantBytes: 1,
  };
}

interface Details { title: string; altEn: string; altDe: string; captionEn: string; captionDe: string; tags: string[] }
const DETAILS: Details = {
  title: 'Sea lion asleep on black lava',
  altEn: 'A sea lion sleeps on dark volcanic rock',
  altDe: 'Ein Seelöwe schläft auf dunklem Vulkangestein',
  captionEn: 'Midday nap on the lava shore.',
  captionDe: 'Mittagsschlaf am Lavaufer.',
  tags: ['sea lion', 'wildlife'],
};

interface Deferred { url: string; resolve(body: unknown): void; fail(status: number, error: string): void }
interface PendingUpload {
  fields: Map<string, unknown>;
  resolve(body: unknown): void;
  progress(loaded: number, total: number): void;
}
/** The model seam: receives the thumbnail URL the page chose and the request's signal. */
type Describe = (url: string, signal: AbortSignal) => Promise<Details>;

/** The loaded page: the DOM stub plus everything the page sent over the wire. */
interface Page {
  el(id: string): FakeNode;
  activeElement(): FakeNode | null;
  /** The page's global object, for replacing a module's function after load. */
  win: Record<string, unknown>;
  timers: { fn: () => void; cleared: boolean }[];
  listRequests: Deferred[];
  uploadRequests: PendingUpload[];
  patches: { url: string; body: Record<string, unknown> }[];
  deletions: string[];
  rows: Map<string, Item>;
  described: string[];
  confirms: string[];
  confirmAnswer: { value: boolean };
  flush(): Promise<void>;
}

function loadPage(opts: { describe?: Describe; folders?: string[] } = {}): Page {
  const focusState = { activeElement: null as FakeNode | null };
  const roots = new Map<string, FakeNode>();
  for (const id of pageIds) {
    const n = new FakeNode('div', focusState);
    n.id = id;
    n.checked = checkedIds.has(id);
    roots.set(id, n);
  }
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
  const uploadRequests: PendingUpload[] = [];
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  const deletions: string[] = [];
  const rows = new Map<string, Item>();
  const described: string[] = [];
  const confirms: string[] = [];
  const confirmAnswer = { value: false };
  const ok = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
  const fetch = (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    if (url.startsWith('/media/folders')) return ok(opts.folders ?? []);
    if (init?.method === 'DELETE' && url.startsWith('/media/items/')) {
      const key = url.slice('/media/items/'.length);
      deletions.push(key);
      rows.delete(key);
      return ok({});
    }
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return ok({});
    }
    if (url.startsWith('/media/items/')) return ok(rows.get(url.slice('/media/items/'.length)));
    const { promise, resolve } = Promise.withResolvers<unknown>();
    listRequests.push({
      url,
      resolve: (body) => resolve({ status: 200, ok: true, json: async () => body }),
      fail: (status, error) => resolve({ status, ok: false, json: async () => ({ error }) }),
    });
    return promise;
  };
  const describePhoto = opts.describe ?? (async () => DETAILS);
  const ctx: Record<string, unknown> = {
    document: {
      getElementById,
      get activeElement() { return focusState.activeElement; },
      createElement: (tag: string) => new FakeNode(tag, focusState),
      createTextNode: (text: string) => Object.assign(new FakeNode('#text', focusState), { textContent: text }),
    },
    location: { href: '', origin: 'https://app.example', protocol: 'https:' },
    fetch,
    URL, AbortController, AbortSignal,
    setTimeout: (fn: () => void) => { timers.push({ fn, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    confirm: (msg: string) => { confirms.push(msg); return confirmAnswer.value; },
    AdminConfirm: {
      ask: async (opts: { body: string }) => { confirms.push(opts.body); return confirmAnswer.value; },
    },
    prompt: () => null,
    console,
    FormData: class {
      fields = new Map<string, unknown>();
      append(key: string, value: unknown): void { this.fields.set(key, value); }
    },
    XMLHttpRequest: class {
      status = 0;
      responseText = '';
      onload = (): void => {};
      upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }): void => {} };
      open(): void {}
      send(data: { fields: Map<string, unknown> }): void {
        uploadRequests.push({
          fields: data.fields,
          resolve: (body) => {
            this.status = 202;
            this.responseText = JSON.stringify(body);
            this.onload();
          },
          progress: (loaded, total) => this.upload.onprogress({ lengthComputable: true, loaded, total }),
        });
      }
    },
    Auth: { ensureAuthed: async () => ({ id: 'u1', username: 'simon', isAdmin: true }), renderHeader() {} },
    EditorGalleryImageOrigin: 'https://img.example',
    AltSuggest: {
      loadConfig: async () => ({
        captionProvider: 'lm-studio', captionBaseUrl: 'http://localhost:1234/v1', captionApiKey: null,
        lmModel: 'vision', captionPrompt: 'Describe', captionMaxEdge: 768, captionTimeoutMs: 60000,
        captionMaxTokens: 8000,
      }),
      // The prepared "image" is the URL itself, so the model stub sees which photo it got.
      prepHosted: async (url: string) => ({ dataUrl: url }),
    },
    LLM: {
      mixedContentWarning: () => '',
      describePhoto: (_base: string, _model: string, _guidance: string, dataUrl: string, _timeout: number, _maxTokens: number, signal: AbortSignal) => {
        described.push(dataUrl);
        return describePhoto(dataUrl, signal);
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(apiSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  vm.runInContext(dialogSrc, ctx);
  vm.runInContext(browserSrc, ctx);
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await setImmediate(); };
  return { el, activeElement: () => focusState.activeElement, win: ctx, timers, listRequests, uploadRequests, patches, deletions, rows, described, confirms, confirmAnswer, flush };
}

function runTimers(timers: { fn: () => void; cleared: boolean }[]): void {
  const due = timers.filter((t) => !t.cleared);
  timers.length = 0;
  for (const t of due) t.fn();
}

describe('media-browser current folder', () => {
  it('exposes only the selected folder across nested, sibling and All photos navigation', async () => {
    const page = loadPage({ folders: ['Trips', 'Trips/North', 'Trips/South'] });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();
    let buttons = page.el('folderTree').querySelectorAll('.folder-btn');
    expect(buttons.filter((button) => button.getAttribute('aria-current') === 'true')
      .map((button) => button.textContent)).toEqual(['All photos']);

    for (const [label, folder] of [['North', 'Trips/North'], ['South', 'Trips/South'], ['All photos', '']]) {
      buttons.find((button) => button.textContent === label)!.dispatch('click');
      await page.flush();
      const request = page.listRequests.shift()!;
      expect(new URL(request.url, 'https://app.example').searchParams.get('folder') ?? '').toBe(folder);
      request.resolve({ items: [], total: 0 });
      await page.flush();
      buttons = page.el('folderTree').querySelectorAll('.folder-btn');
      expect(buttons.filter((button) => button.getAttribute('aria-current') === 'true')
        .map((button) => button.textContent)).toEqual([label]);
    }
  });
});

describe('media-browser upload completion', () => {
  it('keeps keyboard navigation on the same photo when completion changes its grid index', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('first'), item('focused')], total: 2 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[1]!.focus();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [item('first'), item('new'), item('focused')], total: 3 });
    await page.flush();
    expect(page.activeElement()).toBe(page.el('grid').querySelectorAll('.media-cell')[2]);
    page.activeElement()!.dispatch('keydown', { key: 'ArrowLeft' });
    expect(page.activeElement()?.dataset.key).toBe('new');
    expect(page.el('grid').querySelectorAll('.is-selected').map((node) => node.dataset.key)).toEqual(['new']);
  });

  it('does not reclaim grid focus after the author moves elsewhere during the refresh', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.focus();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    page.el('dropZone').focus();
    page.listRequests.shift()!.resolve({ items: [item('existing'), item('new')], total: 2 });
    await page.flush();
    expect(page.activeElement()).toBe(page.el('dropZone'));
  });

  it('keeps a clean focused detail input until typing, but refreshes it after an explicit save', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    const input = page.el('dTitle');
    input.focus();
    expect(page.el('dUnsaved').hidden).toBe(true);
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [item('existing'), item('new')], total: 2 });
    await page.flush();
    expect(page.activeElement()).toBe(input);
    expect(page.el('dTitle')).toBe(input);
    input.value = 'Continued typing';
    page.el('detail').dispatch('input');
    page.el('dSave').focus();
    page.el('dSave').dispatch('click');
    await page.flush();
    expect(page.patches.at(-1)?.body).toEqual({ title: 'Continued typing' });
    page.listRequests.shift()!.resolve({ items: [{ ...item('existing'), title: 'Continued typing' }, item('new')], total: 2 });
    await page.flush();
    expect(page.el('dTitle').value).toBe('Continued typing');
    expect(page.el('dUnsaved').hidden).toBe(true);
  });

  it('finishes an explicit save when upload completion supersedes its reload', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('dTitle').value = 'Saved title';
    page.el('detail').dispatch('input');
    page.el('dSave').focus();
    page.el('dSave').dispatch('click');
    await page.flush();
    const explicit = page.listRequests.shift()!;
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [{ ...item('existing'), title: 'Saved title' }, item('new')], total: 2 });
    await page.flush();
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(page.el('dTitle').value).toBe('Saved title');
    explicit.resolve({ items: [{ ...item('existing'), title: 'Saved title' }], total: 1 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map((node) => node.dataset.key)).toEqual(['existing', 'new']);
    // The saved row must become the diff baseline, even though its reload lost.
    page.el('dTitle').value = 'existing';
    page.el('detail').dispatch('input');
    page.el('dSave').dispatch('click');
    await page.flush();
    expect(page.patches.at(-1)?.body).toEqual({ title: 'existing' });
    page.listRequests.shift()!.resolve({ items: [item('existing'), item('new')], total: 2 });
    await page.flush();
  });

  it('finishes folder selection when upload completion supersedes its reload', async () => {
    const page = loadPage({ folders: ['trips'] });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    const folder = page.el('folderTree').querySelectorAll('.folder-btn')[1]!;
    folder.focus();
    folder.dispatch('click');
    await page.flush();
    const explicit = page.listRequests.shift()!;
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    const background = page.listRequests.shift()!;
    expect(background.url).toContain('folder=trips');
    background.resolve({ items: [{ ...item('new'), folder: 'trips' }], total: 1 });
    await page.flush();
    expect(page.el('folderTree').querySelectorAll('.is-current').map((node) => node.textContent)).toEqual(['trips']);
    explicit.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map((node) => node.dataset.key)).toEqual(['new']);
  });

  it.each([
    ['folderTree', '.folder-btn'],
    ['uploadQueue', '.btn-secondary'],
  ])('does not replace focused %s controls during background completion', async (id, selector) => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    const control = page.el(id).querySelectorAll(selector)[0]!;
    control.focus();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [item('existing'), item('new')], total: 2 });
    await page.flush();
    expect(page.activeElement()).toBe(control);
    expect(page.el(id).querySelectorAll(selector)[0]).toBe(control);
    expect(page.el('grid').querySelectorAll('.media-cell').map((node) => node.dataset.key)).toEqual(['existing', 'new']);
  });

  it('refreshes once for completed uploads, keeps queue results and unsaved details, and renders the server status', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('dAltDe').value = 'Unsaved description';
    page.el('detail').dispatch('input');

    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }, { name: 'ready.jpg' }] } });
    expect(page.uploadRequests).toHaveLength(2);
    page.uploadRequests[0]!.progress(100, 100);
    await page.flush();
    runTimers(page.timers);
    expect(page.listRequests).toHaveLength(0);
    expect(page.el('grid').querySelectorAll('.media-cell').map((n) => n.dataset.key)).toEqual(['existing']);

    page.uploadRequests[0]!.resolve({ key: 'new', status: 'processing' });
    page.uploadRequests[1]!.resolve({ key: 'ready', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    expect(page.listRequests).toHaveLength(1);
    const processing = { ...item('new'), status: 'processing', thumbSrc: '' };
    page.listRequests.shift()!.resolve({ items: [item('ready'), processing, item('existing')], total: 3 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map((n) => n.dataset.key)).toEqual(['ready', 'new', 'existing']);
    expect(page.el('grid').querySelectorAll('.media-cell__badge').map((n) => n.textContent)).toEqual(['processing']);
    expect(page.el('uploadQueue').querySelectorAll('.upload-row')).toHaveLength(2);
    expect(page.el('uploadQueue').querySelectorAll('.upload-row__state').map((n) => n.textContent)).toEqual(['done', 'done']);
    expect(page.el('dAltDe').value).toBe('Unsaved description');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('grid').querySelectorAll('.is-selected').map((n) => n.dataset.key)).toEqual(['existing']);
  });

  it('shows an upload in the current folder without changing the query or clearing the queue', async () => {
    const page = loadPage({ folders: ['journey'] });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();
    page.el('folderTree').querySelectorAll('.folder-btn')[1]!.dispatch('click');
    const query = page.listRequests[0]!.url;
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();

    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    expect(page.uploadRequests[0]!.fields.get('folder')).toBe('journey');
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'processing' });
    await page.flush();
    runTimers(page.timers);
    expect(page.listRequests).toHaveLength(1);
    expect(page.listRequests[0]!.url).toBe(query);
    page.listRequests.shift()!.resolve({ items: [{ ...item('new'), folder: 'journey', status: 'processing' }], total: 1 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map((n) => n.dataset.key)).toEqual(['new']);
    expect(page.el('grid').querySelectorAll('.media-cell__badge')[0]!.textContent).toBe('processing');
    expect(page.el('uploadQueue').querySelectorAll('.upload-row')).toHaveLength(1);
  });

  it.each(['other folder', 'ready filter'])('does not insert a nonmatching upload under the %s and preserves sorting and page', async (context) => {
    const page = loadPage({ folders: ['journey', 'other'] });
    const settle = async (): Promise<void> => {
      page.listRequests.shift()!.resolve({ items: [item('visible')], total: 121 });
      await page.flush();
    };
    await page.flush();
    await settle();
    page.el('folderTree').querySelectorAll('.folder-btn')[1]!.dispatch('click');
    await settle();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    expect(page.uploadRequests[0]!.fields.get('folder')).toBe('journey');

    if (context === 'other folder') {
      page.el('folderTree').querySelectorAll('.folder-btn')[2]!.dispatch('click');
    } else {
      page.el('fStatus').value = 'ready';
      page.el('fStatus').dispatch('change');
    }
    await settle();
    page.el('fRecursive').checked = false;
    page.el('fRecursive').dispatch('change');
    await settle();
    page.el('fSort').value = 'title';
    page.el('fSort').dispatch('change');
    await settle();
    page.el('fOrder').value = 'asc';
    page.el('fOrder').dispatch('change');
    await settle();
    page.el('nextPage').dispatch('click');
    const query = page.listRequests[0]!.url;
    await settle();

    page.uploadRequests[0]!.resolve({ key: 'new', folder: 'journey', status: 'processing' });
    await page.flush();
    runTimers(page.timers);
    expect(page.listRequests).toHaveLength(1);
    expect(page.listRequests[0]!.url).toBe(query);
    expect(query).toContain('page=2');
    expect(query).toContain('sort=title');
    expect(query).toContain('order=asc');
    expect(query).toContain(context === 'other folder' ? 'folder=other' : 'status=ready');
    await settle();
    expect(page.el('grid').querySelectorAll('.media-cell').map((n) => n.dataset.key)).toEqual(['visible']);
    expect(page.el('uploadQueue').querySelectorAll('.upload-row__state')[0]!.textContent).toBe('done');
    expect(page.el('pageInfo').textContent).toBe('Page 2 of 3');
  });
});

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

  it('arrow-browsing while dirty moves focus but not the panel, so the next click still asks', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a'), item('b')], total: 2 });
    await page.flush();
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[0]!.dispatch('click');
    page.el('dAltDe').value = 'edited';
    page.el('detail').dispatch('input');
    cells[0]!.dispatch('keydown', { key: 'ArrowRight' });
    expect(page.confirms).toHaveLength(0);
    expect(page.el('detail').dataset.key).toBe('a');
    expect(page.el('dAltDe').value).toBe('edited');
    // The selection moved on to B; committing to it must still go through the guard.
    page.el('grid').querySelectorAll('.media-cell')[1]!.dispatch('click');
    expect(page.confirms).toHaveLength(1);
    expect(page.el('detail').dataset.key).toBe('a');
  });

  it('saves only the fields and locales the author changed, so a stale panel undoes nothing', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a', 'alt-a')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('dAltDe').value = 'Fjord';
    page.el('detail').dispatch('input');
    // Meanwhile the photo was moved (bulk Move) and given English alt text
    // (bulk AI run), and the list reloaded; the untouched panel still shows
    // the old folder and the old, empty English alt.
    page.el('fStatus').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.resolve({
      items: [{ ...item('a', 'alt-a'), folder: 'Island', alt: { de: 'alt-a', en: 'Filled by a bulk run' } }], total: 1,
    });
    await page.flush();
    expect(page.el('dFolder').value).toBe('');
    expect(page.el('dAltEn').value).toBe('');
    page.el('dSave').dispatch('click');
    await page.flush();
    expect(page.patches).toHaveLength(1);
    expect(page.patches[0]!.url).toBe('/media/items/a');
    expect(page.patches[0]!.body).toEqual({ alt: { de: 'Fjord' } });
  });
});

describe('media-browser AI suggestion in the detail panel', () => {
  async function openPhoto(page: Page, items: Item[], index = 0): Promise<void> {
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: items.length });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[index]!.dispatch('click');
  }

  it('fills empty fields, offers the rest beside their text, and saves only on Save details', async () => {
    const page = loadPage();
    // Title "a" and German alt already have text; everything else is empty.
    await openPhoto(page, [item('a', 'Mein Alttext')]);
    page.el('dSuggest').dispatch('click');
    await page.flush();

    expect(page.described).toEqual(['https://img.example/a-640.webp']);
    expect(page.el('dAltEn').value).toBe(DETAILS.altEn);
    expect(page.el('dCapDe').value).toBe(DETAILS.captionDe);
    expect(page.el('dCapEn').value).toBe(DETAILS.captionEn);
    expect(page.el('dTags').value).toBe('sea lion, wildlife');
    expect(page.el('dAltDe').value).toBe('Mein Alttext');
    expect(page.el('dTitle').value).toBe('a');
    expect(page.el('dAltDeHint').hidden).toBe(false);
    expect(page.el('dTitleHint').hidden).toBe(false);
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dSuggestStatus').textContent).toContain('Filled 4 empty fields');
    expect(page.patches).toHaveLength(0);

    // Taking one offered suggestion is explicit; the other stays as written.
    page.el('dTitleHint').querySelectorAll('.btn-link')[0]!.dispatch('click');
    expect(page.el('dTitle').value).toBe(DETAILS.title);
    expect(page.el('dTitleHint').hidden).toBe(true);

    page.el('dSave').dispatch('click');
    await page.flush();
    expect(page.patches).toEqual([{ url: '/media/items/a', body: {
      title: DETAILS.title,
      alt: { en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
      tags: DETAILS.tags,
    } }]);
  });

  it('abandons a suggestion once the panel shows another photo', async () => {
    const pending = Promise.withResolvers<Details>();
    let signal: AbortSignal | undefined;
    const page = loadPage({ describe: (_url, s) => { signal = s; return pending.promise; } });
    await openPhoto(page, [item('a'), item('b')]);
    page.el('dSuggest').dispatch('click');
    await page.flush();
    expect(page.el('dSuggest').disabled).toBe(true);

    page.el('grid').querySelectorAll('.media-cell')[1]!.dispatch('click');
    expect(signal?.aborted).toBe(true);
    expect(page.el('detail').dataset.key).toBe('b');
    expect(page.el('dSuggest').disabled).toBe(false);

    pending.resolve(DETAILS);
    await page.flush();
    expect(page.el('dAltDe').value).toBe('');
    expect(page.el('dUnsaved').hidden).toBe(true);
  });

  it('offers nothing for a photo that is still encoding', async () => {
    const page = loadPage();
    await openPhoto(page, [{ ...item('a'), status: 'processing' }]);
    expect(page.el('dSuggest').disabled).toBe(true);
    expect(page.el('dSuggestStatus').textContent).toMatch(/finished encoding/);
  });

  it('keeps offered suggestions when the panel is rebuilt for the same photo', async () => {
    const page = loadPage();
    const filled: Item = {
      ...item('a', 'Mein Alttext'), alt: { de: 'Mein Alttext', en: 'My alt' },
      caption: { de: 'Cap', en: 'Cap' }, tags: ['kept'],
    };
    await openPhoto(page, [filled, item('b')]);
    page.el('dSuggest').dispatch('click');
    await page.flush();
    expect(page.el('dTitleHint').hidden).toBe(false);
    expect(page.el('dUnsaved').hidden).toBe(true);

    // Re-clicking the photo rebuilds the clean panel; the offers come back.
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    expect(page.el('dTitleHint').hidden).toBe(false);
    expect(page.el('dAltEnHint').hidden).toBe(false);
    page.el('dTitleHint').querySelectorAll('.btn-link')[0]!.dispatch('click');
    expect(page.el('dTitle').value).toBe(DETAILS.title);

    // Another photo drops them; coming back does not resurrect them.
    page.confirmAnswer.value = true;
    page.el('grid').querySelectorAll('.media-cell')[1]!.dispatch('click');
    expect(page.el('dAltEnHint').hidden).toBe(true);
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    expect(page.el('dAltEnHint').hidden).toBe(true);
  });
});

describe('media-browser bulk AI dialog', () => {
  const complete = (key: string): Item => ({
    ...item(key, 'Alt'), title: 'Done', alt: { de: 'Alt', en: 'Alt' }, caption: { de: 'Cap', en: 'Cap' }, tags: ['t'],
  });

  it('runs on the selection, skips complete photos and saves what was empty', async () => {
    const page = loadPage();
    const items = [complete('a'), item('b'), { ...item('c'), status: 'processing' }];
    for (const row of items) page.rows.set(row.key, row);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 3 });
    await page.flush();
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[0]!.dispatch('click');
    cells[2]!.dispatch('click', { shiftKey: true });
    page.el('aiSelected').dispatch('click');
    await page.flush();

    expect(page.el('aiDialog').open).toBe(true);
    expect(page.el('aiScopeSelected').checked).toBe(true);
    expect(page.el('aiScopeSelectedLabel').textContent).toBe('The 3 selected photos');
    expect(page.el('aiSummary').textContent).toBe('1 of 2 photos have empty fields to fill, one model request each.'
      + ' 1 photo still encoding, failed or missing is left out.');
    expect(page.el('aiStart').disabled).toBe(false);

    page.el('aiStart').dispatch('click');
    await page.flush();
    expect(page.described).toEqual(['https://img.example/b-640.webp']);
    // b's title ("b") already had text, so it is kept; everything empty is filled.
    expect(page.patches).toEqual([{ url: '/media/items/b', body: {
      alt: { de: DETAILS.altDe, en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
      tags: DETAILS.tags,
    } }]);
    expect(page.el('aiSummary').textContent).toBe('Done. Saved 1, skipped 0, failed 0.');
    expect(page.el('aiCancel').textContent).toBe('Close');
    // The grid reloads to show what was saved.
    expect(page.listRequests.at(-1)!.url).toMatch(/^\/media\?/);
  });

  it('names an overwrite before it happens and only then sends complete photos', async () => {
    const page = loadPage();
    const items = [complete('a')];
    page.rows.set('a', items[0]!);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('aiSelected').dispatch('click');
    await page.flush();
    expect(page.el('aiStart').disabled).toBe(true);
    expect(page.el('aiSummary').textContent).toMatch(/^0 of 1 photo have empty fields/);

    page.el('aiFieldTags').checked = false;
    page.el('aiFieldCaption').checked = false;
    page.el('aiFieldAlt').checked = false;
    page.el('aiReplace').checked = true;
    page.el('aiReplace').dispatch('change');
    expect(page.el('aiStart').textContent).toBe('Generate and overwrite');
    expect(page.el('aiSummary').textContent).toMatch(/^1 photo will be sent to the model.*overwritten/);
    page.el('aiStart').dispatch('click');
    await page.flush();
    expect(page.patches).toEqual([{ url: '/media/items/a', body: { title: DETAILS.title } }]);
  });

  it('"all photos in this view" pages through the listing with the current filters', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('p1')], total: 201 });
    await page.flush();
    page.el('fStatus').value = 'ready';
    page.el('fStatus').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('p1')], total: 201 });
    await page.flush();

    page.el('aiAll').dispatch('click');
    await page.flush();
    expect(page.el('aiScopeAll').checked).toBe(true);
    expect(page.el('aiScopeSelected').disabled).toBe(true);
    expect(page.el('aiScopeAllLabel').textContent).toBe('All 201 photos in this view (every folder, status ready)');
    expect(page.el('aiSummary').textContent).toBe('Counting the photos in this view…');

    const first = page.listRequests.shift()!;
    expect(first.url).toContain('status=ready');
    expect(first.url).toContain('page=1&pageSize=200');
    const all = Array.from({ length: 201 }, (_, i) => item('all' + i));
    for (const row of all) page.rows.set(row.key, row);
    first.resolve({ items: all.slice(0, 200), total: 201 });
    await page.flush();
    const second = page.listRequests.shift()!;
    expect(second.url).toContain('page=2&pageSize=200');
    second.resolve({ items: all.slice(200), total: 201 });
    await page.flush();
    expect(page.el('aiSummary').textContent).toMatch(/^201 of 201 photos have empty fields/);

    page.el('aiStart').dispatch('click');
    await vi.waitFor(() => expect(page.el('aiSummary').textContent).toMatch(/^Done\./));
    expect(page.patches).toHaveLength(201);
  });

  it('Stop cancels the photo in flight and sends no save for it', async () => {
    let signal: AbortSignal | undefined;
    const page = loadPage({
      describe: (_url, s) => {
        signal = s;
        const { promise, reject } = Promise.withResolvers<Details>();
        s.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        return promise;
      },
    });
    const items = [item('a'), item('b')];
    for (const row of items) page.rows.set(row.key, row);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 2 });
    await page.flush();
    page.el('aiAll').dispatch('click');
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 2 });
    await page.flush();
    page.el('aiStart').dispatch('click');
    await page.flush();
    expect(page.el('aiCancel').textContent).toBe('Stop');

    // Esc while running stops instead of closing.
    let prevented = false;
    page.el('aiDialog').dispatch('cancel', { preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(signal?.aborted).toBe(true);
    await page.flush();
    expect(page.patches).toEqual([]);
    expect(page.described).toHaveLength(1);
    expect(page.el('aiSummary').textContent).toBe('Stopped. Saved 0, skipped 0, failed 0, not processed 2. Nothing was changed.');
    page.el('aiCancel').dispatch('click');
    expect(page.el('aiDialog').open).toBe(false);
  });

  it('retries a failed listing when "all photos" is chosen again', async () => {
    const page = loadPage();
    const items = [item('a'), item('b')];
    for (const row of items) page.rows.set(row.key, row);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 2 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('aiAll').dispatch('click');
    await page.flush();
    expect(page.el('aiScopeSelected').checked).toBe(true);

    page.el('aiScopeAll').checked = true;
    page.el('aiScopeAll').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.fail(503, 'database unavailable');
    await page.flush();
    expect(page.el('aiSummary').textContent).toMatch(/^Could not list the photos in this view: database unavailable/);
    expect(page.el('aiStart').disabled).toBe(true);

    page.el('aiScopeSelected').checked = true;
    page.el('aiScopeSelected').dispatch('change');
    page.el('aiScopeAll').checked = true;
    page.el('aiScopeAll').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 2 });
    await page.flush();
    expect(page.el('aiSummary').textContent).toMatch(/^2 of 2 photos have empty fields/);
    expect(page.el('aiStart').disabled).toBe(false);
  });

  it('ends closable when the run itself throws, and reloads the grid', async () => {
    const page = loadPage();
    const items = [item('a')];
    page.rows.set('a', items[0]!);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    const mediaAi = page.win.MediaAi;
    if (typeof mediaAi !== 'object' || mediaAi === null) throw new Error('MediaAi not loaded');
    Reflect.set(mediaAi, 'runBulk', async () => { throw new Error('boom'); });
    page.el('aiSelected').dispatch('click');
    await page.flush();
    page.el('aiStart').dispatch('click');
    await page.flush();

    expect(page.el('aiSummary').textContent).toBe('The run stopped unexpectedly: boom. Photos already saved keep their details.');
    expect(page.el('aiCancel').textContent).toBe('Close');
    expect(page.el('aiCancel').disabled).toBe(false);
    expect(page.listRequests.at(-1)!.url).toMatch(/^\/media\?/);
    page.el('aiCancel').dispatch('click');
    expect(page.el('aiDialog').open).toBe(false);
  });
});

describe('media-browser pagination', () => {
  function keys(page: Page): string[] {
    return page.el('grid').querySelectorAll('.media-cell').map((cell) => cell.dataset.key!);
  }

  async function answer(page: Page, number: number, items: Item[], total: number): Promise<void> {
    const request = page.listRequests.shift()!;
    expect(new URL(request.url, 'https://app.example').searchParams.get('page')).toBe(String(number));
    request.resolve({ items, total });
    await page.flush();
  }

  async function lastPage(total: number): Promise<Page> {
    const page = loadPage();
    const items = Array.from({ length: total }, (_, index) => item('photo-' + index));
    for (const row of items) page.rows.set(row.key, row);
    await page.flush();
    const pages = Math.ceil(total / 60);
    for (let number = 1; number <= pages; number++) {
      await answer(page, number, items.slice((number - 1) * 60, number * 60), total);
      if (number < pages) {
        page.el('nextPage').dispatch('click');
        await page.flush();
      }
    }
    return page;
  }

  async function deleteFirst(page: Page): Promise<void> {
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.confirmAnswer.value = true;
    page.el('detail').querySelectorAll('.btn-remove')[0]!.dispatch('click');
    await page.flush();
  }

  it('deletes the only photo on the last page and loads the remaining photos before rendering', async () => {
    const page = await lastPage(61);
    expect(keys(page)).toEqual(['photo-60']);
    await deleteFirst(page);
    expect(page.confirms).toHaveLength(1);
    expect(page.deletions).toEqual(['photo-60']);
    expect(page.rows.has('photo-60')).toBe(false);

    await answer(page, 2, [], 60);
    // The intermediate empty response must not paint a phantom page.
    expect(keys(page)).toEqual(['photo-60']);
    const remaining = [...page.rows.values()];
    await answer(page, 1, remaining, remaining.length);
    expect(keys(page)).toEqual(remaining.map((row) => row.key));
    expect(page.el('pageInfo').textContent).toBe('Page 1 of 1');
    expect(page.el('prevPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.el('bulkTools').hidden).toBe(true);
    expect(page.el('detail').dataset.key).toBeUndefined();
    expect(page.el('out').textContent).toBe('Deleted.');
    expect(page.listRequests).toHaveLength(0);
  });

  it.each([1, 61])('returns an empty result to page one from a library of %i photos', async (total) => {
    const page = await lastPage(total);
    await deleteFirst(page);
    // Other photos may have disappeared concurrently.
    await answer(page, Math.ceil(total / 60), [], 0);
    expect(keys(page)).toEqual([]);
    expect(page.el('pageInfo').textContent).toBe('');
    expect(page.el('prevPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.el('bulkTools').hidden).toBe(true);
    expect(page.listRequests).toHaveLength(0);

    // A subsequent reload must start at page one, not the removed page.
    page.el('fOrder').dispatch('change');
    await page.flush();
    await answer(page, 1, [item('new-photo')], 1);
    expect(keys(page)).toEqual(['new-photo']);
    expect(page.el('pageInfo').textContent).toBe('Page 1 of 1');
  });

  it('keeps moving backwards when the count shrinks again during correction', async () => {
    const page = await lastPage(121);
    await deleteFirst(page);
    await answer(page, 3, [], 120);
    await answer(page, 2, [], 60);
    const remaining = [...page.rows.values()].slice(0, 60);
    await answer(page, 1, remaining, 60);
    expect(keys(page)).toEqual(remaining.map((row) => row.key));
    expect(page.el('pageInfo').textContent).toBe('Page 1 of 1');
    expect(page.el('prevPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.listRequests).toHaveLength(0);
  });

  it('keeps a valid corrected page when concurrent uploads grow the count', async () => {
    const page = await lastPage(61);
    await deleteFirst(page);
    await answer(page, 2, [], 60);
    const remaining = [...page.rows.values()];
    await answer(page, 1, remaining, 62);
    expect(keys(page)).toEqual(remaining.map((row) => row.key));
    expect(page.el('pageInfo').textContent).toBe('Page 1 of 2');
    expect(page.el('prevPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(false);
    expect(page.listRequests).toHaveLength(0);
  });

  it.each([false, true])('does not let a superseded load correct a newer view (correction started: %s)', async (correcting) => {
    const page = await lastPage(121);
    page.el('fOrder').dispatch('change');
    await page.flush();
    if (correcting) await answer(page, 3, [], 120);
    const stale = page.listRequests.shift()!;

    page.el('fStatus').value = 'ready';
    page.el('fStatus').dispatch('change');
    await page.flush();
    await answer(page, 1, [item('current')], 1);
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    page.el('dAltDe').value = 'Unsaved description';
    page.el('detail').dispatch('input');

    stale.resolve({ items: [], total: 60 });
    await page.flush();
    expect(keys(page)).toEqual(['current']);
    expect(page.el('grid').querySelectorAll('.media-cell')[0]!.getAttribute('aria-selected')).toBe('true');
    expect(page.el('dAltDe').value).toBe('Unsaved description');
    expect(page.el('pageInfo').textContent).toBe('Page 1 of 1');
    expect(page.el('prevPage').disabled).toBe(true);
    expect(page.el('nextPage').disabled).toBe(true);
    expect(page.listRequests).toHaveLength(0);
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
