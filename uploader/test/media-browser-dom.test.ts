import { describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { ui } from '../../site/src/i18n/ui.js';
import * as MediaConditional from '../public/media-conditional.js';
import type { MediaImpact, StoryUse } from '../src/media-impact.js';
import type { ChangedDescriptions } from '../src/media-store.js';

// media-browser.js is the library page's DOM glue (media.html). Its
// user-visible contracts that no pure helper can carry — the detail panel
// keeps unsaved edits across a re-render, a superseded list response never
// paints, an AI suggestion lands only in its own photo's panel and saves
// nothing, and the bulk dialog saves only what it says — are exercised here
// against a tree-shaped DOM stub whose ids come from the REAL markup, the same
// precedent as editor-dom.test.ts. The model itself is stubbed at the
// AltSuggest/LLM seam; media-ai.js and media-ai-dialog.js run for real.
const apiSrc = readFileSync('public/media-api.js', 'utf8');
const adminUiSrc = readFileSync('public/admin-ui.js', 'utf8');
const aiSrc = readFileSync('public/media-ai.js', 'utf8');
const dialogSrc = readFileSync('public/media-ai-dialog.js', 'utf8');
const browserSrc = readFileSync('public/media-browser.js', 'utf8');
const impactSrc = readFileSync('public/media-impact.js', 'utf8');
const refreshSrc = readFileSync('public/publication-refresh.js', 'utf8');
const markup = readFileSync('public/media.html', 'utf8');
const pageIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
const checkedIds = new Set([...markup.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*\bchecked\b/g)].map((m) => m[1]!));
// A bare `hidden` attribute only: `class="visually-hidden"` is not one.
const hiddenIds = new Set([...markup.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*\shidden(?=[\s>])/g)].map((m) => m[1]!));
const POLL_MS = 3000;

type Listener = (ev: Record<string, unknown>) => void;

class FakeNode {
  id = '';
  className = '';
  href = '';
  src = '';
  alt = '';
  lang = '';
  target = '';
  rel = '';
  title = '';
  private text = '';
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.detachChildren(); }
  private inputValue = '';
  get value(): string { return this.inputValue; }
  set value(value: string) {
    this.inputValue = this.tagName === 'select' && !this.children.some(option => option.value === value) ? '' : value;
  }
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
  parent: FakeNode | null = null;
  /** Page roots stand in for the document; everything else is connected through a parent. */
  root = false;
  listeners: Record<string, Listener[]> = {};
  constructor(public tagName: string, private focusState?: { activeElement: FakeNode | null }) {}
  get isConnected(): boolean { return this.root || (this.parent?.isConnected ?? false); }
  get innerHTML(): string { return ''; }
  set innerHTML(v: string) {
    if (v !== '') return;
    this.detachChildren();
  }
  private detachChildren(): void {
    if (this.focusState && this.children.some((child) => child.contains(this.focusState!.activeElement))) {
      this.focusState.activeElement = null;
    }
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { c.remove(); c.parent = this; this.children.push(c); return c; }
  append(...nodes: FakeNode[]): void { nodes.forEach(node => this.appendChild(node)); }
  contains(node: FakeNode | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  adjacent: FakeNode[] = [];
  insertAdjacentElement(_position: string, node: FakeNode): FakeNode { node.remove(); node.parent = this; this.adjacent.push(node); return node; }
  remove(): void {
    if (!this.parent) return;
    if (this.focusState && this.contains(this.focusState.activeElement)) this.focusState.activeElement = null;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent.adjacent = this.parent.adjacent.filter((child) => child !== this);
    this.parent = null;
  }
  focused = false;
  focus(): void {
    // Like the real DOM: a disabled or detached control cannot take focus.
    if (this.disabled || !this.isConnected) return;
    this.focused = true;
    if (this.focusState) this.focusState.activeElement = this;
  }
  scrollIntoView(): void {}
  click(): void { this.dispatch('click'); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch('close'); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  dispatch(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) fn({ type, preventDefault() {}, ...ev });
  }
  /** Page roots bubble on to these (the document, then the window). */
  bubbleTo: FakeNode[] = [];
  /** Like a real bubbling event: this node, each ancestor, then the document and window, until stopped. */
  dispatchBubbling(type: string, ev: Record<string, unknown> = {}): void {
    let stopped = false;
    const event = { type, target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...ev };
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n; n = n.parent) {
      path.push(n);
      if (!n.parent) path.push(...n.bubbleTo);
    }
    for (const n of path) {
      for (const fn of n.listeners[type] ?? []) fn(event);
      if (stopped) return;
    }
  }
  querySelectorAll(sel: string): FakeNode[] {
    const cls = sel.replace(/^\./, '');
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.children) {
        if (sel.startsWith('.') ? c.className.split(' ').includes(cls) : c.tagName.toLowerCase() === sel.toLowerCase()) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeNode | null { return this.querySelectorAll(sel)[0] ?? null; }
  find(id: string): FakeNode | null {
    if (this.id === id) return this;
    for (const c of this.children) { const hit = c.find(id); if (hit) return hit; }
    return null;
  }
}

/** The camera settings a row carries (MediaExif as JSON). */
interface Exif {
  takenAt: string | null; camera: string | null; lens: string | null; lat: number | null; lng: number | null;
  focalLength: number | null; focalLength35mm: number | null; fNumber: number | null; iso: number | null; exposureTime: number | null;
}
const NO_EXIF: Exif = {
  takenAt: null, camera: null, lens: null, lat: null, lng: null,
  focalLength: null, focalLength35mm: null, fNumber: null, iso: null, exposureTime: null,
};
/** One stored variant file, and the `versions` member of `GET /media/items/*?versions=1`. */
interface Version { format: 'avif' | 'webp' | 'jpeg'; width: number; height: number | null; bytes: number; src: string }
type Versions = { availability: 'available'; items: Version[] } | { availability: 'processing' } | { availability: 'unavailable' };
const version = (key: string, format: Version['format'], width: number, height: number | null, bytes: number): Version =>
  ({ format, width, height, bytes, src: 'https://img.example/' + key + '-' + width + '.' + format });

interface Item {
  key: string; title: string; folder: string; status: string; thumbSrc: string; fullSrc: string | null;
  alt: { de: string; en: string }; caption: { de: string; en: string };
  tags: string[]; exif: Exif | null; width: number; height: number; origBytes: number; variantBytes: number;
  error?: string | null;
  impact?: MediaImpact;
  livePending?: ChangedDescriptions | null;
  changedDescriptions?: ChangedDescriptions;
  usedIn?: { kind: string; key: string; title: string }[];
}
function item(key: string, altDe = ''): Item {
  return {
    key, title: key, folder: '', status: 'ready', thumbSrc: 'https://img.example/' + key + '-640.webp',
    // The largest variant, as the server derives it beside thumbSrc: `${src}-${width}.webp`.
    fullSrc: 'https://img.example/' + key + '-10.webp',
    alt: { de: altDe, en: '' }, caption: { de: '', en: '' },
    tags: [], exif: null, width: 10, height: 10, origBytes: 1, variantBytes: 1,
  };
}
/** An item URL without the panel observation's `?versions=1`, for stubs that answer both kinds of read alike. */
const itemPath = (url: string): string => url.replace(/\?versions=1$/, '');

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
type Timer = { id: number; fn: () => void; ms: number; cleared: boolean };
const UPLOAD_WATCHDOG_MS = 120000;

/** What the page asked through AdminConfirm.prompt, with its validator to probe. */
interface Prompt { title: string; label: string; value?: string; confirmLabel: string; validate?: (text: string) => string }

interface Page {
  el(id: string): FakeNode;
  activeElement(): FakeNode | null;
  /** The page's global object, for replacing a module's function after load. */
  win: Record<string, unknown>;
  timers: Timer[];
  listRequests: Deferred[];
  uploadRequests: PendingUpload[];
  patches: { url: string; body: Record<string, unknown> }[];
  deletions: string[];
  rows: Map<string, Item>;
  /** What `?versions=1` lists per key; a key without an entry has no variant files. */
  versions: Map<string, Versions>;
  /** Every item GET the page sent, with its query string. */
  itemReads: string[];
  described: string[];
  confirms: string[];
  confirmAnswer: { value: boolean };
  prompts: Prompt[];
  promptAnswer: { value: string | null };
  /** The query string the page last wrote with history.replaceState ('' when none). */
  urlState(): string;
  flush(): Promise<void>;
  focus(): void;
  visibility(hidden: boolean): void;
  lifecycle(type: 'pagehide' | 'pageshow', persisted: boolean): void;
}

function loadPage(opts: { describe?: Describe; isAdmin?: boolean; locale?: 'de' | 'en'; folders?: string[]; prompt?: string | null; xhr?: new () => object; mobile?: boolean;
  search?: string;
  request?: (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined } = {}): Page {
  const focusState = { activeElement: null as FakeNode | null };
  const roots = new Map<string, FakeNode>();
  for (const id of pageIds) {
    const n = new FakeNode('div', focusState);
    n.id = id;
    n.root = true;
    n.checked = checkedIds.has(id);
    n.hidden = hiddenIds.has(id);
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
  const timers: Timer[] = [];
  let timerSeq = 0;
  const windowEvents = new FakeNode('window');
  const documentEvents = new FakeNode('document');
  for (const r of roots.values()) r.bubbleTo = [documentEvents, windowEvents];
  const listRequests: Deferred[] = [];
  const uploadRequests: PendingUpload[] = [];
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  const deletions: string[] = [];
  const rows = new Map<string, Item>();
  const versions = new Map<string, Versions>();
  const itemReads: string[] = [];
  const described: string[] = [];
  const prompts: Prompt[] = [];
  const promptAnswer = { value: opts.prompt === undefined ? null : opts.prompt };
  const urlWrites: string[] = [];
  const confirms: string[] = [];
  const confirmAnswer = { value: false };
  const ok = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
  const fetch = (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    if (url.startsWith('/media/items/') && (init?.method ?? 'GET') === 'GET') itemReads.push(url);
    const override = opts.request?.(url, init);
    if (override) return override;
    if (url === '/auth/me') return ok({ authenticated: true, userId: '11111111-1111-4111-8111-111111111111', username: 'simon', isAdmin: opts.isAdmin ?? true });
    if (url.startsWith('/media/folders')) return ok(opts.folders ?? []);
    if (init?.method === 'DELETE' && url.startsWith('/media/items/')) {
      const key = url.slice('/media/items/'.length);
      deletions.push(key);
      rows.delete(key);
      return ok({});
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body ?? '{}') as { conditional: { patch: Partial<Item> } };
      patches.push({ url, body });
      const key = url.slice('/media/items/'.length);
      const base = rows.get(key) ?? item(key);
      const patch = body.conditional.patch;
      const saved = { ...base, ...patch, alt: { ...base.alt, ...patch.alt }, caption: { ...base.caption, ...patch.caption } };
      rows.set(key, saved);
      return ok({ ...saved, conditionalVersion: 1, changedDescriptions: {
        de: { alt: base.alt.de !== saved.alt.de, caption: base.caption.de !== saved.caption.de },
        en: { alt: base.alt.en !== saved.alt.en, caption: base.caption.en !== saved.caption.en },
      } });
    }
    if (url.startsWith('/media/items/')) {
      // Like the route: only `?versions=1` adds the variant listing.
      const [path = '', query] = url.split('?');
      const key = path.slice('/media/items/'.length);
      const row = rows.get(key);
      return ok(row && query === 'versions=1'
        ? { ...row, versions: versions.get(key) ?? { availability: 'available', items: [] } } : row);
    }
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
      hidden: false,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener() {},
      documentElement: { lang: opts.locale ?? 'en' },
      getElementById,
      get activeElement() { return focusState.activeElement; },
      createElement: (tag: string) => new FakeNode(tag, focusState),
      createTextNode: (text: string) => Object.assign(new FakeNode('#text', focusState), { textContent: text }),
    },
    location: { href: '', origin: 'https://app.example', protocol: 'https:', pathname: '/admin/media.html', search: opts.search ?? '' },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { urlWrites.push(url); } },
    fetch,
    URL, URLSearchParams, AbortController, AbortSignal,
    crypto: webcrypto,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener() {},
    setTimeout: (fn: () => void, ms = 0) => { const id = ++timerSeq; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeout: (id: number) => { const t = timers.find((timer) => timer.id === id); if (t) t.cleared = true; },
    matchMedia: () => ({ matches: !!opts.mobile }),
    AdminConfirm: {
      ask: async (opts: { body: string }) => { confirms.push(opts.body); return confirmAnswer.value; },
      // The in-page prompt: resolves to the (valid) answer, or null for Cancel — as the real one does.
      prompt: async (o: Prompt) => {
        prompts.push(o);
        const text = promptAnswer.value === null ? null : promptAnswer.value.trim();
        if (text === null || !text || (o.validate && o.validate(text))) return null;
        return text;
      },
    },
    console,
    FormData: class {
      fields = new Map<string, unknown>();
      append(key: string, value: unknown): void { this.fields.set(key, value); }
    },
    XMLHttpRequest: opts.xhr ?? class {
      status = 0;
      responseText = '';
      onload = (): void => {};
      upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }): void => {} };
      open(): void {}
      abort(): void {}
      send(data: { fields: Map<string, unknown> }): void {
        uploadRequests.push({
          fields: data.fields,
          resolve: (body) => {
            this.status = 202;
            // The #305 upload envelope: this attempt's identity plus an accepted result.
            const result = body as { key?: string };
            this.responseText = JSON.stringify({ state: 'accepted', ownerUserId: data.fields.get('expectedOwnerId'),
              uploadId: data.fields.get('uploadId'), src: 'https://img.example/' + String(result.key), width: 8, height: 6, ...result });
            this.onload();
          },
          progress: (loaded, total) => this.upload.onprogress({ lengthComputable: true, loaded, total }),
        });
      }
    },
    Auth: { ensureAuthed: async () => ({ id: 'u1', username: 'simon', isAdmin: opts.isAdmin ?? true }), renderHeader() {} },
    EditorCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])),
    ])),
    MediaConditional,
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
  // The page's own load order: shared presentation helpers before every module that formats.
  vm.runInContext(apiSrc, ctx);
  vm.runInContext(adminUiSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  vm.runInContext(dialogSrc, ctx);
  vm.runInContext(refreshSrc, ctx);
  vm.runInContext(impactSrc, ctx);
  vm.runInContext(browserSrc, ctx);
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await setImmediate(); };
  return { el, activeElement: () => focusState.activeElement, win: ctx, timers, listRequests, uploadRequests, patches, deletions, rows, versions, itemReads, described, confirms, confirmAnswer, prompts, promptAnswer, flush,
    urlState: () => { const last = urlWrites.at(-1) ?? ''; return last.includes('?') ? last.slice(last.indexOf('?')) : ''; },
    focus: () => windowEvents.dispatch('focus'),
    lifecycle: (type, persisted) => windowEvents.dispatch(type, { persisted }),
    visibility: (hidden) => {
      const document = ctx.document;
      if (!document || typeof document !== 'object') throw new Error('missing document');
      Reflect.set(document, 'hidden', hidden);
      documentEvents.dispatch('visibilitychange');
    } };
}

/** Advances UI timers (debounces); the 120 s upload watchdog stays pending. */
function runTimers(timers: Timer[]): void {
  const due = timers.filter((t) => !t.cleared && t.ms < UPLOAD_WATCHDOG_MS);
  const pending = timers.filter((t) => !t.cleared && t.ms >= UPLOAD_WATCHDOG_MS);
  timers.length = 0;
  timers.push(...pending);
  for (const t of due) t.fn();
}

describe('media-browser empty states', () => {
  it.each([
    { isAdmin: true, locale: 'en' as const },
    { isAdmin: false, locale: 'en' as const },
    { isAdmin: false, locale: 'de' as const },
  ])('offers an upload, not an admin recovery action ($isAdmin / $locale)', async (options) => {
    const page = loadPage(options);
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('mediaEmpty').hidden).toBe(false);
    expect(page.el('grid').hidden).toBe(true);
    expect(page.el('grid').children).toHaveLength(0);
    expect(page.el('mediaEmptyMessage').textContent).toContain(ui[options.locale]['editor.chrome.mediaEmptyHelp']);
    expect(page.el('emptyShowAll').hidden).toBe(true);
    const choose = vi.fn();
    page.el('fileInput').addEventListener('click', choose);
    page.el('emptyChoosePhotos').click();
    expect(choose).toHaveBeenCalledOnce();
    expect(page.el('fileInput').focused).toBe(true);
    expect(page.el('dropZone').open).toBe(true);
    if (!options.isAdmin) expect(page.el('rescan').hidden).toBe(true);
    expect(page.patches).toHaveLength(0);
  });

  it('recovers from an empty filtered view without adding content and removes the state when photos return', async () => {
    const page = loadPage({ isAdmin: false });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('one')], total: 1 });
    await page.flush();
    page.el('fStatus').value = 'failed';
    page.el('fStatus').dispatch('change');
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('mediaEmptyMessage').textContent).toContain(ui.en['editor.chrome.mediaNoResults']);
    expect(page.el('emptyShowAll').hidden).toBe(false);
    page.el('emptyShowAll').click();
    await page.flush();
    const reset = page.listRequests.shift()!;
    const query = new URL(reset.url, 'https://app.example').searchParams;
    expect(query.get('status') || '').toBe('');
    expect(query.get('q') || '').toBe('');
    expect(query.get('folder') || '').toBe('');
    expect(page.el('fStatus').value).toBe('');
    expect(page.el('fSearch').focused).toBe(true);
    reset.resolve({ items: [item('one')], total: 1 });
    await page.flush();
    expect(page.el('mediaEmpty').hidden).toBe(true);
    expect(page.el('mediaEmptyMessage').textContent).toBe('');
    expect(page.el('grid').hidden).toBe(false);
    expect(page.el('grid').querySelectorAll('.media-cell')).toHaveLength(1);
    expect(page.patches).toHaveLength(0);
  });
});

describe('media detail navigation', () => {
  it('opens phone details from a photo and protects unsaved text when returning to the grid', async () => {
    // Layout and scroll placement are verified in the actual browser.
    const page = loadPage({ mobile: true });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('one'), item('two')], total: 2 });
    await page.flush();
    expect(page.el('detail').hidden).toBe(true);
    expect(page.el('mediaFolders').open).toBe(false);
    page.el('grid').querySelectorAll('.media-cell')[1]!.click();
    expect(page.el('detail').hidden).toBe(false);
    expect(page.activeElement()).toBe(page.el('detail'));
    page.el('dTitle').value = 'Unsaved photo title';
    page.el('detail').dispatch('input');
    page.confirmAnswer.value = false;
    page.el('detailBack').click();
    await page.flush();
    expect(page.el('detail').hidden).toBe(false);
    expect(page.el('dTitle').value).toBe('Unsaved photo title');
    page.confirmAnswer.value = true;
    page.el('detailBack').click();
    await page.flush();
    expect(page.el('detail').hidden).toBe(true);
    expect(page.activeElement()?.dataset.key).toBe('two');
    expect(page.patches).toEqual([]);
  });

  it('opens the focused photo with Enter without changing a bulk selection', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('one'), item('two')], total: 2 });
    await page.flush();
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[0]!.dispatch('keydown', { key: 'a', ctrlKey: true });
    const selected = page.el('selCount').textContent;
    page.el('grid').querySelectorAll('.media-cell')[1]!.dispatch('keydown', { key: 'Enter' });
    expect(page.el('detail').dataset.key).toBe('two');
    expect(page.activeElement()).toBe(page.el('detail'));
    expect(page.el('selCount').textContent).toBe(selected);
    page.el('detailBack').click();
    expect(page.activeElement()?.dataset.key).toBe('two');
  });
});

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
  it('names a refusal for each file it will not send, sends the rest, and asks to keep the tab open only while sending', async () => {
    const page = loadPage({ locale: 'de' });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 });
    await page.flush();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [
      { name: 'IMG_0001.HEIC', type: 'image/heic', size: 2_000_000 },
      { name: 'huge.jpg', type: 'image/jpeg', size: 26 * 1024 * 1024 },
      { name: 'notes.pdf', type: 'application/pdf', size: 1000 },
      { name: 'ok.jpg', type: 'image/jpeg', size: 4_000_000 },
    ] } });
    await page.flush();
    const states = () => page.el('uploadQueue').querySelectorAll('.upload-row__state').map((n) => n.textContent);
    const de = ui.de;
    expect(page.uploadRequests).toHaveLength(1);
    expect(states().slice(0, 3)).toEqual([
      de['editor.chrome.uploadRefusedHeic'],
      de['editor.chrome.uploadRefusedTooLarge'].replace('{max}', '25 MB'),
      de['editor.chrome.uploadRefusedNotImage'],
    ]);
    expect(page.el('uploadQueue').textContent).toContain(de['editor.chrome.uploadKeepOpen']);
    page.uploadRequests[0]!.resolve({ key: 'ok', status: 'processing' });
    await page.flush();
    expect(states()[3]).toBe(de['editor.chrome.uploadDone']);
    expect(page.el('uploadQueue').textContent).not.toContain(de['editor.chrome.uploadKeepOpen']);
  });

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
    // #306: detail saves are conditional on the values the panel was built from.
    expect(page.patches.at(-1)?.body).toEqual({ conditional: { version: 1, expect: { title: 'existing' }, patch: { title: 'Continued typing' } } });
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
    expect(page.patches.at(-1)?.body).toEqual({ conditional: { version: 1, expect: { title: 'Saved title' }, patch: { title: 'existing' } } });
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
    // Transferred, not encoded: the grid badge carries processing → ready/failed.
    expect(page.el('uploadQueue').querySelectorAll('.upload-row__state').map((n) => n.textContent)).toEqual([ui.en['editor.chrome.uploadDone'], ui.en['editor.chrome.uploadDone']]);
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
    expect(page.el('uploadQueue').querySelectorAll('.upload-row__state')[0]!.textContent).toBe(ui.en['editor.chrome.uploadDone']);
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
    await page.flush();
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
    expect(page.patches[0]!.body).toEqual({ conditional: {
      version: 1, patch: { alt: { de: 'Fjord' } }, expect: { alt: { de: 'alt-a' } },
    } });
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
    expect(page.patches).toEqual([{ url: '/media/items/a', body: { conditional: { version: 1, patch: {
      title: DETAILS.title,
      alt: { en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
      tags: DETAILS.tags,
    }, expect: { title: 'a', alt: { en: '' }, caption: { de: '', en: '' }, tags: [] } } } }]);
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
    await page.flush();
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
    expect(page.patches).toEqual([{ url: '/media/items/b', body: { conditional: { version: 1, patch: {
      alt: { de: DETAILS.altDe, en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
      tags: DETAILS.tags,
    }, expect: { alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [] } } } }]);
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
    expect(page.patches).toEqual([{ url: '/media/items/a', body: { conditional: {
      version: 1, patch: { title: DETAILS.title }, expect: { title: 'Done' },
    } } }]);
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
    expect(page.el('aiSummary').textContent).toBe('Stopped. Saved 0, skipped 0, failed 0, not processed 2.');
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
    expect(page.el('out').textContent).toBe('Photo deleted.');
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
    expect(page.el('out').textContent).toBe('1 photo');
    older!.resolve({ items: [item('x/1'), item('x/2'), item('x/3')], total: 3 });
    await page.flush();
    expect(page.el('out').textContent).toBe('1 photo');
    expect(page.el('grid').querySelectorAll('.media-cell')).toHaveLength(1);
  });
});

describe('upload receipt recovery visibility', () => {
  it('recovers the photo and keyboard focus without retransmitting or replacing dirty detail fields', async () => {
    let sends = 0; let probes = 0;
    let releaseCheck: (() => void) | undefined;
    const page = loadPage({
      xhr: class {
        open() {}
        abort() {}
        send() { sends++; throw new Error('Acknowledgement lost'); }
      },
      request: (url) => {
        if (!url.startsWith('/upload/receipts/')) return;
        probes++;
        if (probes === 1) return Promise.resolve({ status: 503, ok: false, json: async () => ({ error: 'unavailable' }) });
        return new Promise(resolve => {
          releaseCheck = () => resolve({ status: 200, ok: true, json: async () => ({
            state: 'accepted', ownerUserId: '11111111-1111-4111-8111-111111111111', uploadId: url.split('/').pop(),
            result: { key: 'recovered-photo', src: 'https://img.example/recovered-photo', width: 10, height: 10 },
          }) });
        });
      },
    });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('existing')], total: 1 }); await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    page.el('dAltDe').value = 'Keep this unsaved description'; page.el('detail').dispatch('input');
    Object.assign(page.el('fileInput'), { files: [{ name: 'recovered-photo.jpg' }] });
    page.el('fileInput').dispatch('change'); await page.flush();
    expect(sends).toBe(1); expect(probes).toBe(1);
    expect(page.listRequests).toHaveLength(0);
    const check = page.el('uploadQueue').querySelectorAll('.btn-secondary')[0]!;
    check.focus(); check.click(); await page.flush();
    expect(page.activeElement()).toBe(page.el('uploadQueue').querySelectorAll('.upload-row')[0]);
    releaseCheck!(); await page.flush();
    expect(page.activeElement()).toBe(page.el('uploadQueue').querySelectorAll('.upload-row')[0]);
    expect(sends).toBe(1); expect(probes).toBe(2);
    // Completion refreshes the list after the shared debounce.
    runTimers(page.timers);
    expect(page.listRequests).toHaveLength(1);
    page.el('dAltDe').focus();
    page.listRequests.shift()!.resolve({ items: [item('existing', 'Other stored text'), item('recovered-photo')], total: 2 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map(cell => cell.dataset.key)).toEqual(['existing', 'recovered-photo']);
    expect(page.el('dAltDe').value).toBe('Keep this unsaved description');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.activeElement()).toBe(page.el('dAltDe'));
    expect(page.listRequests).toHaveLength(0);
  });
});

describe('folder and move ambiguous outcomes', () => {
  const reply = (body: unknown, status = 200) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
  it('checks the folder tree once after a lost create response and only repeats the write explicitly', async () => {
    let creates = 0; let reads = 0;
    const page = loadPage({ prompt: 'Iceland', request: (url, init) => {
      if (url !== '/media/folders') return;
      if (init?.method === 'POST') { creates++; return Promise.reject(new Error('Response lost')); }
      reads++; return reply([]);
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    const initialReads = reads;
    page.el('newFolder').click(); await page.flush();
    const panel = page.el('out').adjacent[0]!;
    expect(creates).toBe(1); expect(reads).toBe(initialReads + 1);
    const [check, again] = panel.children.filter(child => child.tagName === 'button');
    expect(again!.hidden).toBe(false);
    check!.click(); await page.flush();
    expect(creates).toBe(1); expect(reads).toBe(initialReads + 2);
    again!.click(); await page.flush();
    expect(creates).toBe(2);
  });
  it('installs a recovered folder in the tree and move targets from the one authoritative read', async () => {
    let creates = 0; let reads = 0;
    const page = loadPage({ prompt: 'Iceland', request: (url, init) => {
      if (url !== '/media/folders') return;
      if (init?.method === 'POST') { creates++; return Promise.reject(new Error('Acknowledgement lost')); }
      reads++; return reply(creates ? ['Iceland'] : []);
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    const initialReads = reads;
    page.el('newFolder').click(); await page.flush();
    expect(creates).toBe(1); expect(reads).toBe(initialReads + 1);
    const folder = page.el('folderTree').querySelectorAll('.folder-btn').find(button => button.textContent === 'Iceland');
    expect(folder).toBeDefined();
    expect(page.el('moveTarget').children.map(option => option.value)).toContain('Iceland');
    expect(page.listRequests).toHaveLength(0);
    folder!.click(); await page.flush();
    expect(new URL(page.listRequests[0]!.url, 'https://app.example').searchParams.get('folder')).toBe('Iceland');
    expect(creates).toBe(1);
  });
  it('uses a single selected-key lookup, not a filtered page, and retains Unknown for incomplete evidence', async () => {
    let moves = 0; const lookups: unknown[] = []; let complete = false;
    const page = loadPage({ request: (url, init) => {
      if (url === '/media/move') { moves++; return reply({ error: 'upstream timeout' }, 503); }
      if (url === '/media/lookup') {
        lookups.push(JSON.parse(init?.body ?? '{}'));
        return reply({ items: complete ? [{ key: 'selected', folder: 'Another folder' }] : [] });
      }
    } });
    page.rows.set('selected', item('selected'));
    await page.flush(); page.listRequests.shift()!.resolve({ items: [item('selected')], total: 201 }); await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    page.el('moveTarget').value = 'Target';
    page.el('moveSelected').click(); await page.flush();
    const panel = page.el('out').adjacent[0]!;
    const [check, again] = panel.children.filter(child => child.tagName === 'button');
    expect(lookups).toEqual([{ keys: ['selected'] }]);
    expect(page.listRequests).toHaveLength(0);
    expect(again!.hidden).toBe(true);
    complete = true; check!.click(); await page.flush();
    expect(moves).toBe(1);
    expect(panel.textContent).toContain('selected: Another folder');
    expect(again!.hidden).toBe(false);
    page.listRequests.shift()!.resolve({ items: [Object.assign(item('selected'), { folder: 'Another folder' })], total: 201 });
    await page.flush();
    expect(page.el('dFolder').value).toBe('Another folder');
    // Changing a visible-page filter cannot remove this operation's evidence.
    page.el('fStatus').value = 'failed'; page.el('fStatus').dispatch('change'); await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    expect(panel.textContent).toContain('selected: Another folder');
    again!.click(); await page.flush(); expect(moves).toBe(2);
  });
  it('does not treat an empty 2xx move body as acknowledgement', async () => {
    let probes = 0;
    const page = loadPage({ request: (url) => {
      if (url === '/media/move') return reply({});
      if (url === '/media/lookup') { probes++; return reply({ items: [{ key: 'selected', missing: true }] }); }
    } });
    page.rows.set('selected', item('selected'));
    await page.flush(); page.listRequests.shift()!.resolve({ items: [item('selected')], total: 1 }); await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click(); page.el('moveSelected').click(); await page.flush();
    expect(probes).toBe(1);
    page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map(cell => cell.dataset.key)).not.toContain('selected');
  });
});

describe('media conditional save recovery in real consumers', () => {
  const response = (status: number, body: unknown) => Promise.resolve({
    status, ok: status >= 200 && status < 300, json: async () => body,
  });
  async function open(page: Page, row = item('a'), siblings: Item[] = []): Promise<void> {
    for (const entry of [row, ...siblings]) page.rows.set(entry.key, entry);
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [row, ...siblings], total: 1 + siblings.length });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.dispatch('click');
    await page.flush();
  }
  function change(page: Page, id: string, value: string): void {
    page.el(id).value = value;
    page.el('detail').dispatch('input');
  }

  it.each([false, true])('reconciles filtered membership and selection after detail adoption (Use stored: %s)', async (useStored) => {
    const original = { ...item('a'), folder: 'A' };
    const current = { ...original, title: 'Moved', folder: 'B' };
    const page = loadPage({ request: (url, init) => {
      if (url === '/media/folders') return response(200, ['A', 'B']);
      if (useStored && init?.method === 'PATCH') return response(409, { error: 'media_changed', current });
    } });
    await open(page, original);
    page.el('folderTree').querySelectorAll('.folder-btn').find(node => node.textContent === 'A')!.click();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [original], total: 1 }); await page.flush();
    expect(page.el('aiAll').disabled).toBe(false);
    change(page, 'dTitle', 'Moved');
    change(page, 'dFolder', 'B');
    page.el('dSave').click(); await page.flush();
    if (useStored) { page.el('dUseStored').click(); await page.flush(); }
    page.listRequests.shift()?.resolve({ items: [], total: 0 }); await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell')).toEqual([]);
    expect(page.el('selCount').textContent).toBe('');
    expect(page.el('bulkTools').hidden).toBe(true);
    expect(page.el('detail').dataset.key).toBeUndefined();
    expect(page.el('aiAll').disabled).toBe(true);
  });

  it('refreshes saved titles and ordering without replacing edits made during the listing read', async () => {
    const page = loadPage();
    await open(page, item('a'), [item('b')]);
    change(page, 'dTitle', 'Zulu');
    page.el('dSave').click(); await page.flush();
    const caption = page.el('dCapEn');
    change(page, 'dCapEn', 'Newer unsaved caption'); caption.focus();
    page.listRequests.shift()?.resolve({ items: [item('b'), page.rows.get('a')!], total: 2 });
    await page.flush();
    expect(page.el('grid').querySelectorAll('.media-cell').map(node => node.dataset.key)).toEqual(['b', 'a']);
    expect(page.el('grid').querySelectorAll('.media-cell__title').map(node => node.textContent)).toEqual(['b', 'Zulu']);
    expect(page.el('dCapEn')).toBe(caption);
    expect(caption.value).toBe('Newer unsaved caption');
    expect(page.activeElement()).toBe(caption);
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('dSave').click(); await page.flush();
    expect(page.patches.map(entry => entry.body)).toEqual([
      { conditional: { version: 1, patch: { title: 'Zulu' }, expect: { title: 'a' } } },
      { conditional: { version: 1, patch: { caption: { en: 'Newer unsaved caption' } }, expect: { caption: { en: '' } } } },
    ]);
  });

  it('keeps a stale form and explicitly resends the whole patch against compared stored values', async () => {
    const writes: unknown[] = [];
    const current = { ...item('a'), title: 'Someone else', tags: ['elsewhere'] };
    const page = loadPage({ request: (_url, init) => {
      if (init?.method !== 'PATCH') return;
      writes.push(JSON.parse(init.body!));
      return writes.length === 1 ? response(409, { error: 'media_changed', current })
        : response(200, { ...current, title: 'Mine', tags: ['local'], conditionalVersion: 1 });
    } });
    await open(page);
    change(page, 'dTitle', 'Mine');
    change(page, 'dTags', 'local, local');
    page.el('dSave').click();
    await page.flush();
    expect(page.el('dTitle').value).toBe('Mine');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('Another value stored');
    page.el('dSave').click();
    await page.flush();
    expect(writes).toHaveLength(1);
    page.el('dUseMine').click();
    await page.flush();
    expect(writes).toEqual([
      { conditional: { version: 1, patch: { title: 'Mine', tags: ['local'] }, expect: { title: 'a', tags: [] } } },
      { conditional: { version: 1, patch: { title: 'Mine', tags: ['local'] }, expect: { title: 'Someone else', tags: ['elsewhere'] } } },
    ]);
    expect(page.el('dUnsaved').hidden).toBe(true);
  });

  it('cannot replace the form with an earlier comparison while Use mine is pending', async () => {
    const current = { ...item('a'), title: 'Stored elsewhere' };
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof response>>>();
    let writes = 0;
    const page = loadPage({ request: (_url, init) => {
      if (init?.method !== 'PATCH') return;
      return ++writes === 1 ? response(409, { error: 'media_changed', current }) : pending.promise;
    } });
    await open(page);
    change(page, 'dTitle', 'Mine');
    page.el('dSave').click(); await page.flush();
    page.el('dUseMine').click(); await page.flush();
    page.el('dUseStored').click();
    expect(page.el('dTitle').value).toBe('Mine');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dUseMine').disabled).toBe(true);
    expect(page.el('dUseStored').disabled).toBe(true);
    pending.resolve(response(200, { ...current, title: 'Mine', conditionalVersion: 1 }));
    await page.flush();
    expect(page.el('dTitle').value).toBe('Mine');
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(writes).toBe(2);
  });

  it('does not reopen an earlier comparison when a stored read arrives after acknowledgement', async () => {
    const current = { ...item('a'), title: 'Stored elsewhere' };
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof response>>>();
    let writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') return ++writes === 1
        ? response(409, { error: 'media_changed', current })
        : response(200, { ...current, title: 'Mine', conditionalVersion: 1 });
      if (itemPath(url) === '/media/items/a') return pending.promise;
    } });
    await open(page);
    change(page, 'dTitle', 'Mine');
    page.el('dSave').click(); await page.flush();
    page.el('dCheckStored').click(); await page.flush();
    page.el('dUseMine').click(); await page.flush();
    pending.resolve(response(200, current)); await page.flush();
    expect(page.el('dTitle').value).toBe('Mine');
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(page.el('dCompare').textContent).toBe('');
  });

  it.each([false, true])('preserves a newly observed folder on the next edit (Use stored: %s)', async (useStored) => {
    const current = { ...item('a'), title: 'Stored elsewhere', folder: 'Created elsewhere' };
    let refused = false;
    const page = loadPage({ request: (_url, init) => {
      if (!useStored || refused || init?.method !== 'PATCH') return;
      refused = true;
      return response(409, { error: 'media_changed', current });
    } });
    await open(page);
    page.rows.set('a', current);
    change(page, 'dTitle', 'My title');
    page.el('dSave').click(); await page.flush();
    if (useStored) page.el('dUseStored').click();
    expect(page.el('dFolder').value).toBe('Created elsewhere');
    change(page, 'dAltDe', 'My alt');
    page.el('dSave').click(); await page.flush();
    expect(page.patches.at(-1)?.body).toEqual({ conditional: { version: 1,
      patch: { alt: { de: 'My alt' } }, expect: { alt: { de: '' } } } });
    expect(page.rows.get('a')?.folder).toBe('Created elsewhere');
  });

  it('adopts stored values only by explicit choice and never discards newer form generations', async () => {
    const current = { ...item('a'), title: 'Stored' };
    const page = loadPage({ request: (_url, init) => init?.method === 'PATCH'
      ? response(409, { error: 'media_changed', current }) : undefined });
    await open(page);
    change(page, 'dTitle', 'Mine');
    page.el('dSave').click();
    await page.flush();
    change(page, 'dTitle', 'Newer mine');
    page.el('dUseStored').click();
    expect(page.el('dTitle').value).toBe('Newer mine');
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('dUseStored').click();
    expect(page.el('dTitle').value).toBe('Stored');
    expect(page.el('dUnsaved').hidden).toBe(true);
  });

  it('shows mixed unknown leaf outcomes after exactly one GET and never partially retries', async () => {
    let reads = 0;
    let writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') { writes++; return Promise.reject(new Error('connection lost')); }
      if (itemPath(url) === '/media/items/a') {
        reads++;
        return response(200, { ...item('a'), title: 'Mine', tags: ['someone else'] });
      }
    } });
    await open(page);
    expect(reads).toBe(1); // Initial impact observation, before the save/recovery phase.
    reads = 0;
    change(page, 'dTitle', 'Mine');
    change(page, 'dAltDe', 'Local alt');
    change(page, 'dTags', 'local');
    page.el('dSave').click();
    await page.flush();
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    const comparison = page.el('dCompare').textContent;
    expect(comparison).toContain('title: Intended value stored');
    expect(comparison).toContain('alt.de: Expected value visible');
    expect(comparison).toContain('tags: Another value stored');
    expect(comparison).toContain('write arriving later');
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('dSave').click();
    await page.flush();
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    page.el('dCheckStored').click();
    await page.flush();
    expect(reads).toBe(2); // Explicit comparison reuses its own read for impact too.
    expect(writes).toBe(1);
  });

  it('does not call an all-achieved probe a confirmed save or clean later edits', async () => {
    const pending = Promise.withResolvers<unknown>();
    let reads = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') return Promise.reject(new Error('lost'));
      if (itemPath(url) === '/media/items/a') { reads++; return reads === 1 ? response(200, item('a')) : pending.promise; }
    } });
    await open(page);
    expect(reads).toBe(1); // Initial impact observation must not serve as post-write recovery.
    change(page, 'dTitle', 'Submitted');
    page.el('dSave').click();
    await page.flush();
    change(page, 'dTitle', 'Newer');
    pending.resolve(await response(200, { ...item('a'), title: 'Submitted' }));
    await page.flush();
    expect(reads).toBe(2); // One initial impact read plus exactly one recovery read.
    expect(page.el('dTitle').value).toBe('Newer');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('Intended value stored');
  });

  it('keeps newer edits after a valid acknowledgement and rejects unversioned success', async () => {
    for (const marker of [true, false]) {
      const pending = Promise.withResolvers<unknown>();
      let reads = 0;
      const page = loadPage({ request: (url, init) => {
        if (init?.method === 'PATCH') return pending.promise;
        if (itemPath(url) === '/media/items/a') { reads++; return response(200, item('a')); }
      } });
      await open(page);
      expect(reads).toBe(1); // Isolate save-time reads from initial impact observation.
      reads = 0;
      change(page, 'dTitle', 'Submitted');
      page.el('dSave').click();
      await page.flush();
      change(page, 'dTitle', 'Newer');
      pending.resolve(await response(200, { ...item('a'), title: 'Submitted', ...(marker ? { conditionalVersion: 1 } : {}) }));
      await page.flush();
      expect(page.el('dTitle').value).toBe('Newer');
      expect(page.el('dUnsaved').hidden).toBe(false);
      expect(reads).toBe(0);
      if (!marker) expect(page.el('dCompare').textContent).toContain('Compatible software is required');
    }
  });

  it.each([false, true])('keeps a reopened panel aligned without reverting acknowledged title (new edit: %s)', async (edited) => {
    const pending = Promise.withResolvers<unknown>();
    let writes = 0;
    const page = loadPage({ request: (_url, init) => {
      if (init?.method === 'PATCH' && ++writes === 1) return pending.promise;
    } });
    await open(page, item('a'), [item('b')]);
    const choose = async (key: string) => {
      page.el('grid').querySelectorAll('.media-cell').find(cell => cell.dataset.key === key)!.dispatch('click');
      await page.flush();
    };
    change(page, 'dTitle', 'Submitted');
    page.el('dSave').click(); await page.flush();
    page.confirmAnswer.value = true;
    await choose('b'); await choose('a');
    const pendingDisabled = page.el('dSave').disabled;
    if (edited) change(page, 'dCapDe', 'Reopened caption');
    const acknowledged = { ...item('a'), title: 'Submitted', conditionalVersion: 1 };
    page.rows.set('a', acknowledged);
    pending.resolve(await response(200, acknowledged)); await page.flush();
    expect(page.el('dTitle').value).toBe(edited ? 'a' : 'Submitted');
    expect(page.el('dCapDe').value).toBe(edited ? 'Reopened caption' : '');
    expect(page.el('dUnsaved').hidden).toBe(!edited);
    expect(pendingDisabled).toBe(true);
    change(page, 'dCapDe', 'Next caption');
    page.el('dSave').click(); await page.flush();
    expect(page.patches).toEqual([{ url: '/media/items/a', body: { conditional: { version: 1,
      patch: { caption: { de: 'Next caption' } }, expect: { caption: { de: '' } } } } }]);
    expect(page.rows.get('a')?.title).toBe('Submitted');
    expect(page.rows.get('a')?.caption.de).toBe('Next caption');
  });

  it('does not attach a discarded request conflict to a reopened dirty panel', async () => {
    const pending = Promise.withResolvers<unknown>();
    let writes = 0;
    const page = loadPage({ request: (_url, init) => {
      if (init?.method === 'PATCH' && ++writes === 1) return pending.promise;
    } });
    await open(page, item('a'), [item('b')]);
    const choose = async (key: string) => {
      page.el('grid').querySelectorAll('.media-cell').find(cell => cell.dataset.key === key)!.dispatch('click');
      await page.flush();
    };
    change(page, 'dTitle', 'Discarded submission');
    page.el('dSave').click(); await page.flush();
    page.confirmAnswer.value = true;
    await choose('b'); await choose('a');
    change(page, 'dCapDe', 'Reopened caption');
    const current = { ...item('a'), title: 'Stored elsewhere' };
    page.rows.set('a', current);
    pending.resolve(await response(409, { error: 'media_changed', current })); await page.flush();
    expect(page.el('dCapDe').value).toBe('Reopened caption');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toBe('');
    page.el('dSave').click(); await page.flush();
    expect(page.patches).toEqual([{ url: '/media/items/a', body: { conditional: { version: 1,
      patch: { caption: { de: 'Reopened caption' } }, expect: { caption: { de: '' } } } } }]);
    expect(page.rows.get('a')?.title).toBe('Stored elsewhere');
    expect(page.rows.get('a')?.caption.de).toBe('Reopened caption');
  });

  it.each(['a', 'Newer'])('saves newer title %s against acknowledged leaves without echoing untouched fields', async (nextTitle) => {
    const pending = Promise.withResolvers<unknown>();
    const writes: unknown[] = [];
    const original = { ...item('a'), alt: { de: 'Original DE', en: 'Original EN' } };
    const acknowledged = { ...original, title: 'Submitted', folder: 'Moved elsewhere',
      alt: { de: 'Submitted DE', en: 'Changed elsewhere' }, conditionalVersion: 1 };
    const page = loadPage({ request: (_url, init) => {
      if (init?.method !== 'PATCH') return;
      writes.push(JSON.parse(init.body!));
      return writes.length === 1 ? pending.promise
        : response(200, { ...acknowledged, title: nextTitle, alt: { ...acknowledged.alt, de: 'Original DE' } });
    } });
    await open(page, original);
    change(page, 'dTitle', 'Submitted');
    change(page, 'dAltDe', 'Submitted DE');
    page.el('dSave').click(); await page.flush();
    change(page, 'dTitle', nextTitle);
    change(page, 'dAltDe', 'Original DE');
    pending.resolve(await response(200, acknowledged)); await page.flush();
    expect(page.el('dTitle').value).toBe(nextTitle);
    expect(page.el('dAltEn').value).toBe('Original EN');
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('dSave').click(); await page.flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ conditional: { version: 1,
      patch: { title: nextTitle, alt: { de: 'Original DE' } },
      expect: { title: 'Submitted', alt: { de: 'Submitted DE' } } } });
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(page.el('dAltEn').value).toBe('Changed elsewhere');
  });

  it('preserves dirty details and the media page on a refused 401', async () => {
    let writes = 0;
    const page = loadPage({ request: (_url, init) => {
      if (init?.method === 'PATCH') { writes++; return response(401, { error: 'unauthorized' }); }
    } });
    await open(page);
    change(page, 'dTitle', 'Mine');
    page.el('dSave').click();
    await page.flush();
    expect(page.el('dTitle').value).toBe('Mine');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('out').textContent).toContain('Session ended');
    expect(page.win.location).toMatchObject({ href: '' });
    page.el('dSave').click();
    await page.flush();
    expect(writes).toBe(1); // paused queue fences all media writes
  });

  it('displays bulk AI mixed results, never claims nothing changed, and does not replay', async () => {
    let writes = 0;
    let reads = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') { writes++; return Promise.reject(new Error('lost')); }
      if (itemPath(url) === '/media/items/a') {
        reads++;
        return response(200, reads === 1 ? item('a') : {
          ...item('a'), alt: { de: DETAILS.altDe, en: '' }, tags: ['elsewhere'],
        });
      }
    } });
    await open(page);
    expect(reads).toBe(1); // Initial impact observation, separate from AI preflight/recovery.
    reads = 0;
    page.el('aiSelected').click();
    await page.flush();
    page.el('aiStart').click();
    await page.flush();
    expect(writes).toBe(1);
    expect(reads).toBe(2);
    expect(page.el('aiFailures').textContent).toContain('alt.de: Intended value stored');
    expect(page.el('aiFailures').textContent).toContain('alt.en: Expected value visible');
    expect(page.el('aiFailures').textContent).toContain('tags: Another value stored');
    expect(page.el('aiSummary').textContent).not.toContain('Nothing was changed');
    expect(page.el('aiSummary').textContent).toContain('Saved 0');
  });
});

describe('single-photo AI conditional expectations', () => {
  it('keeps suggested values on a concurrent fill conflict and sends only render-snapshot expectations', async () => {
    let sent: unknown;
    const page = loadPage({ request: (_url, init) => {
      if (init?.method !== 'PATCH') return;
      sent = JSON.parse(init.body!);
      return Promise.resolve({ status: 409, ok: false, json: async () => ({
        error: 'media_changed', current: { ...item('a'), alt: { de: 'Other author', en: '' } },
      }) });
    } });
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    page.el('dSuggest').click();
    await page.flush();
    page.el('dSave').click();
    await page.flush();
    expect(sent).toEqual({ conditional: { version: 1, patch: {
      alt: { de: DETAILS.altDe, en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn }, tags: DETAILS.tags,
    }, expect: { alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [] } } });
    expect(page.el('dAltDe').value).toBe(DETAILS.altDe);
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('Other author');
  });
});

describe('conditional media response validation', () => {
  const response = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
  async function clearTitle(page: Page, afterInitialRead: () => void): Promise<void> {
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    await page.flush();
    afterInitialRead();
    page.el('dTitle').value = '';
    page.el('detail').dispatch('input');
    page.el('dSave').click();
    await page.flush();
  }

  it.each([
    {},
    { ...item('b'), title: '' },
    { ...item('a'), title: undefined },
    { ...item('a'), title: 42 },
    { ...item('a'), title: '', alt: { de: '' } },
    { ...item('a'), title: '', tags: [42] },
  ])('does not infer empty fields from an invalid recovery read: %j', async (current) => {
    let reads = 0;
    let writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') { writes++; return Promise.reject(new Error('lost')); }
      if (itemPath(url) === '/media/items/a') { reads++; return response(current); }
    } });
    await clearTitle(page, () => {
      expect(reads).toBe(1); // Initial impact read; recovery gets its own one-read budget.
      reads = 0;
    });
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(page.el('dTitle').value).toBe('');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('Save outcome unknown');
    expect(page.el('dCompare').textContent).not.toContain('Intended value stored');
    expect(page.el('detail').find('dUseMine')).toBeNull();
    expect(page.el('detail').find('dUseStored')).toBeNull();
    page.el('dSave').click();
    await page.flush();
    expect(writes).toBe(1);
  });

  it.each([
    { conditionalVersion: 1 },
    { ...item('b'), title: '', conditionalVersion: 1 },
    { ...item('a'), title: 42, conditionalVersion: 1 },
    { ...item('a'), conditionalVersion: 1 },
  ])('does not clean on an invalid versioned acknowledgement: %j', async (acknowledgement) => {
    let reads = 0;
    let writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (init?.method === 'PATCH') { writes++; return response(acknowledgement); }
      if (itemPath(url) === '/media/items/a') { reads++; return response({}); }
    } });
    await clearTitle(page, () => {
      expect(reads).toBe(1); // Initial impact read; recovery gets its own one-read budget.
      reads = 0;
    });
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(page.el('dTitle').value).toBe('');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('Save outcome unknown');
    expect(page.el('detail').find('dUseStored')).toBeNull();
  });
});

describe('explicit conditional detail choices after more editing', () => {
  async function open(page: Page): Promise<void> {
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a')], total: 1 });
    await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
  }
  function change(page: Page, id: string, value: string): void {
    page.el(id).value = value;
    page.el('detail').dispatch('input');
  }

  it('Use mine retains attempted leaves reverted to their original values and adds new edits only', async () => {
    const writes: unknown[] = [];
    const current = {
      ...item('a'), title: 'Stored', folder: 'Elsewhere', alt: { de: 'Other DE', en: 'Other EN' },
    };
    const page = loadPage({ request: (_url, init) => {
      if (init?.method !== 'PATCH') return;
      writes.push(JSON.parse(init.body!));
      return Promise.resolve({
        status: writes.length === 1 ? 409 : 200, ok: writes.length !== 1,
        json: async () => writes.length === 1 ? { error: 'media_changed', current } : {
          ...current, title: 'a', alt: { de: '', en: 'New local EN' }, conditionalVersion: 1,
        },
      });
    } });
    await open(page);
    change(page, 'dTitle', 'Mine');
    change(page, 'dAltDe', 'My DE');
    page.el('dSave').click();
    await page.flush();
    change(page, 'dTitle', 'a');
    change(page, 'dAltDe', '');
    change(page, 'dAltEn', 'New local EN');
    page.el('dUseMine').click();
    await page.flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ conditional: { version: 1,
      patch: { title: 'a', alt: { de: '', en: 'New local EN' } },
      expect: { title: 'Stored', alt: { de: 'Other DE', en: 'Other EN' } },
    } });
    expect(page.el('dFolder').value).toBe('Elsewhere');
    expect(page.el('dUnsaved').hidden).toBe(true);
  });

  it('Use stored first compares newer edits made before a late conflict response', async () => {
    const pending = Promise.withResolvers<unknown>();
    const page = loadPage({ request: (_url, init) => init?.method === 'PATCH' ? pending.promise : undefined });
    await open(page);
    change(page, 'dTitle', 'Submitted');
    page.el('dSave').click();
    await page.flush();
    change(page, 'dTitle', 'Newer');
    pending.resolve({ status: 409, ok: false, json: async () => ({
      error: 'media_changed', current: { ...item('a'), title: 'Stored' },
    }) });
    await page.flush();
    page.el('dUseStored').click();
    expect(page.el('dTitle').value).toBe('Newer');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dCompare').textContent).toContain('"Newer"');
    page.el('dUseStored').click();
    expect(page.el('dTitle').value).toBe('Stored');
    expect(page.el('dUnsaved').hidden).toBe(true);
  });
});

describe('Media publication impact and bounded refresh', () => {
  const zero = { gallery: 0, galleryCaptionFollowsLibrary: 0, heroTitle: false, inline: 0 };
  const unchanged = { de: { alt: false, caption: false }, en: { alt: false, caption: false } };
  const story = (translationKey: string, captions = 1) => ({ translationKey, title: translationKey,
    locales: { de: { ...zero, gallery: 3, galleryCaptionFollowsLibrary: captions }, en: { ...zero, gallery: 1, galleryCaptionFollowsLibrary: 1 } } });
  const impact: MediaImpact = { availability: 'available', published: [story('one'), story('two')],
    drafts: [story('draft')], newerDrafts: [{ ...story('removed'), locales: { de: zero, en: zero } }] };
  async function open(page: Page, photo: Item = item('a')) {
    page.rows.set(photo.key, photo);
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [photo, item('b')], total: 2 });
    await page.flush(); page.el('grid').querySelectorAll('.media-cell')[0]!.click(); await page.flush();
  }

  it('retires a removed clean detail resource and starts a fresh observation when selected again', async () => {
    const pending = Promise.withResolvers<unknown>();
    let reads = 0;
    const photo = { ...item('a'), impact, usedIn: [{ kind: 'post', key: 'one', title: 'One' }] };
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a' || init?.method === 'PATCH') return;
      if (++reads === 2) return pending.promise;
      return Promise.resolve({ status: 200, ok: true, json: async () => page.rows.get('a') });
    } });
    await open(page, photo);
    page.el('dImpact').querySelectorAll('button')[0]!.click(); await page.flush();
    page.el('fStatus').value = 'failed'; page.el('fStatus').dispatch('change'); await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    pending.resolve({ status: 200, ok: true, json: async () => photo }); await page.flush();
    page.timers.filter(timer => timer.ms === 30000 && !timer.cleared).forEach(timer => timer.fn());
    await page.flush();
    expect(reads).toBe(2);
    expect(page.el('detail').dataset.key).toBeUndefined();
    expect(page.patches).toEqual([]);

    const fresh = { ...photo, title: 'Refreshed photo',
      impact: { availability: 'available' as const, published: [], drafts: [], newerDrafts: [] } };
    page.rows.set('a', fresh);
    page.el('fStatus').value = ''; page.el('fStatus').dispatch('change'); await page.flush();
    page.listRequests.shift()!.resolve({ items: [fresh, item('b')], total: 2 }); await page.flush();
    page.el('grid').querySelectorAll('.media-cell')[0]!.click(); await page.flush();
    expect(reads).toBe(3);
    expect(page.el('dTitle').value).toBe('Refreshed photo');
    expect(page.el('dImpact').querySelectorAll('a')).toEqual([]);
  });

  it.each([false, true])('keeps the save projection when an obsolete comparison settles first (failed read: %s)', async (failed) => {
    const response = (body: unknown, status = 200) => Promise.resolve({ status, ok: status === 200, json: async () => body });
    const older = Promise.withResolvers<unknown>();
    const saving = Promise.withResolvers<unknown>();
    const original = { ...item('a'), impact, livePending: unchanged };
    const competing = { ...original, caption: { de: 'Competing caption', en: '' } };
    const fresh = { ...competing, caption: { de: 'My caption', en: '' }, conditionalVersion: 1,
      impact: { availability: 'available' as const, published: [story('fresh')], drafts: [], newerDrafts: [] },
      usedIn: [{ kind: 'post' as const, key: 'fresh', title: 'Fresh story' }],
      changedDescriptions: { ...unchanged, de: { alt: false, caption: true } },
      livePending: { ...unchanged, de: { alt: false, caption: true } } };
    let reads = 0, writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a') return;
      if (init?.method === 'PATCH') return ++writes === 1
        ? response({ error: 'media_changed', current: competing }, 409) : saving.promise;
      return ++reads === 1 ? response(original) : older.promise;
    } });
    await open(page, original);
    page.el('dCapDe').value = 'My caption'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    page.el('dCheckStored').click(); await page.flush();
    page.el('dUseMine').click(); await page.flush();
    if (failed) older.reject(new Error('Comparison connection lost'));
    else older.resolve(await response(competing));
    await page.flush();
    page.rows.set('a', fresh); saving.resolve(await response(fresh)); await page.flush();
    expect(page.el('dImpact').querySelectorAll('a').map(link => link.href)).toEqual(['/admin/editor.html?tk=fresh']);
    expect(page.el('dCapDe').value).toBe('My caption');
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(page.el('dCompare').textContent).toBe('');
    expect(reads).toBe(2);
    expect(writes).toBe(2);
  });

  it.each([false, true])('retains the selected save projection across hiding (return before ack: %s)', async (returnBeforeAck) => {
    const response = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
    const saving = Promise.withResolvers<unknown>();
    const original = { ...item('a'), impact, livePending: unchanged,
      usedIn: [{ kind: 'post', key: 'one', title: 'Original story' }] };
    const fresh = { ...original, caption: { de: 'My caption', en: '' }, conditionalVersion: 1,
      impact: { availability: 'available' as const, published: [story('fresh')], drafts: [], newerDrafts: [] },
      usedIn: [{ kind: 'post', key: 'fresh', title: 'Fresh story' }],
      changedDescriptions: { ...unchanged, de: { alt: false, caption: true } },
      livePending: { ...unchanged, de: { alt: false, caption: true } } };
    let reads = 0, writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a') return;
      if (init?.method === 'PATCH') { writes++; return saving.promise; }
      reads++;
    } });
    await open(page, original);
    page.el('dCapDe').value = 'My caption'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    page.visibility(true); await page.flush();
    if (returnBeforeAck) { page.visibility(false); await page.flush(); }
    page.rows.set('a', fresh); saving.resolve(await response(fresh)); await page.flush();
    expect(page.el('dImpact').querySelectorAll('a').map(link => link.href)).toEqual(['/admin/editor.html?tk=fresh']);
    if (!returnBeforeAck) { page.visibility(false); await page.flush(); }
    expect(page.el('dCapDe').value).toBe('My caption');
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });

  it('refreshes a cached page once after its pending save settles, without replaying the write', async () => {
    const response = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
    const saving = Promise.withResolvers<unknown>();
    const original = { ...item('a'), impact, livePending: unchanged,
      usedIn: [{ kind: 'post', key: 'one', title: 'Original story' }] };
    const fresh = { ...original, caption: { de: 'My caption', en: '' }, conditionalVersion: 1,
      impact: { availability: 'available' as const, published: [story('fresh')], drafts: [], newerDrafts: [] },
      usedIn: [{ kind: 'post', key: 'fresh', title: 'Fresh story' }],
      changedDescriptions: { ...unchanged, de: { alt: false, caption: true } },
      livePending: { ...unchanged, de: { alt: false, caption: true } } };
    let reads = 0, writes = 0;
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a') return;
      if (init?.method === 'PATCH') { writes++; return saving.promise; }
      reads++;
    } });
    await open(page, original);
    page.el('dCapDe').value = 'My caption'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    page.lifecycle('pagehide', true); await page.flush();
    page.lifecycle('pageshow', true); await page.flush();
    expect(reads).toBe(1);
    page.rows.set('a', fresh); saving.resolve(await response(fresh)); await page.flush();
    expect(page.el('dImpact').querySelectorAll('a').map(link => link.href)).toEqual(['/admin/editor.html?tk=fresh']);
    expect(page.el('dCapDe').value).toBe('My caption');
    expect(page.el('dUnsaved').hidden).toBe(true);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  it.each(['checking', 'saved'])('keeps the selected save projection while another photo is %s by bulk AI', async (stage) => {
    const response = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
    const saving = Promise.withResolvers<unknown>();
    const checking = Promise.withResolvers<unknown>();
    const original = { ...item('a'), impact, livePending: unchanged,
      usedIn: [{ kind: 'post', key: 'one', title: 'Original story' }] };
    const other = { ...item('b'), title: '' };
    const fresh = { ...original, caption: { de: 'My caption', en: '' }, conditionalVersion: 1,
      impact: { availability: 'available' as const, published: [story('fresh')], drafts: [], newerDrafts: [] },
      usedIn: [{ kind: 'post', key: 'fresh', title: 'Fresh story' }],
      changedDescriptions: { ...unchanged, de: { alt: false, caption: true } },
      livePending: { ...unchanged, de: { alt: false, caption: true } } };
    let reads = 0, writes = 0, otherReads = 0;
    const page = loadPage({
      request: (url, init) => {
        if (url === '/media/items/b' && init?.method !== 'PATCH') {
          otherReads++;
          if (stage === 'checking') return checking.promise;
        }
        if (itemPath(url) !== '/media/items/a') return;
        if (init?.method === 'PATCH') { writes++; return saving.promise; }
        reads++;
      },
    });
    page.rows.set('b', other);
    await open(page, original);
    page.el('dCapDe').value = 'My caption'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    expect(page.el('aiAll').disabled).toBe(false);
    page.el('aiAll').click(); await page.flush();
    page.el('aiScopeSelected').checked = false;
    page.el('aiScopeAll').checked = true; page.el('aiScopeAll').dispatch('change'); await page.flush();
    page.listRequests.shift()!.resolve({ items: [original, other], total: 2 }); await page.flush();
    for (const id of ['aiFieldAlt', 'aiFieldCaption', 'aiFieldTags']) page.el(id).checked = false;
    page.el('aiFieldTags').dispatch('change');
    page.el('aiStart').click(); await page.flush();
    expect(otherReads).toBe(1);
    expect(page.described).toEqual(['https://img.example/b-640.webp']);
    page.timers.filter(timer => timer.ms === 30000 && !timer.cleared).forEach(timer => timer.fn());
    await page.flush();
    expect(reads).toBe(1);
    page.rows.set('a', fresh); saving.resolve(await response(fresh)); await page.flush();
    expect(page.el('dImpact').querySelectorAll('a').map(link => link.href)).toEqual(['/admin/editor.html?tk=fresh']);
    expect(page.el('dCapDe').value).toBe('My caption');
    expect(page.el('dUnsaved').hidden).toBe(true);
    if (stage === 'checking') {
      page.timers.filter(timer => timer.ms === 30000 && !timer.cleared).forEach(timer => timer.fn());
      await page.flush();
      expect(reads).toBe(1);
    }
    checking.resolve(await response(other)); await page.flush();
    for (const request of page.listRequests.splice(0)) request.resolve({ items: [...page.rows.values()], total: 2 });
    await page.flush();
    expect(page.rows.get('b')?.title).toBe(DETAILS.title);
    expect(page.el('detail').dataset.key).toBe('a');
    expect(page.el('dImpact').querySelectorAll('a').map(link => link.href)).toEqual(['/admin/editor.html?tk=fresh']);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });

  it('resumes read-only detail observations after explicit same-owner reauthentication without replacing dirty inputs', async () => {
    let expired = false, reads = 0;
    const photo = { ...item('a', 'base'), impact, livePending: unchanged };
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a' || init?.method === 'PATCH') return;
      reads++;
      return Promise.resolve({ status: expired ? 401 : 200, ok: !expired,
        json: async () => expired ? { error: 'unauthorized' } : page.rows.get('a') });
    } });
    await open(page, photo);
    page.el('dAltDe').value = 'unsaved local'; page.el('detail').dispatch('input');
    expired = true;
    page.el('dImpact').querySelectorAll('button')[0]!.click(); await page.flush();
    expect(reads).toBe(2);
    expect(page.el('uploadQueue').hidden).toBe(false);
    expired = false;
    page.rows.set('a', { ...photo, impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] } });
    page.el('uploadQueue').querySelectorAll('button').find(button => button.textContent === ui.en['editor.chrome.uploadResume'])!.click();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [photo], total: 1 }); await page.flush();
    expect(reads).toBe(3);
    expect(page.el('dImpact').textContent).toContain('No eligible story');
    expect(page.el('dAltDe').value).toBe('unsaved local');
    expect(page.el('dUnsaved').hidden).toBe(false);
    page.el('dImpact').querySelectorAll('button')[0]!.click(); await page.flush();
    expect(reads).toBe(4);
    page.timers.find(timer => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(reads).toBe(5);
    expect(page.patches).toEqual([]);
  });

  it('retains focused impact controls through refresh, falls back when a link disappears, and never steals external focus', async () => {
    const page = loadPage();
    const photo = { ...item('a'), impact, usedIn: [{ kind: 'post', key: 'one', title: 'Authorized title' }] };
    await open(page, photo);
    const refresh = () => page.el('dImpact').querySelectorAll('button')[0]!;
    refresh().focus(); refresh().click(); await page.flush();
    expect(page.activeElement()).toBe(refresh());
    const link = page.el('dImpact').querySelectorAll('a')[0]!;
    link.focus();
    page.timers.find(timer => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(page.activeElement()).toBe(page.el('dImpact').querySelectorAll('a')[0]);
    expect(page.activeElement()?.href).toBe('/admin/editor.html?tk=one');
    page.rows.set('a', { ...photo, impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] } });
    page.timers.find(timer => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(page.el('dImpact').querySelectorAll('a')).toEqual([]);
    expect(page.activeElement()).toBe(refresh());
    page.el('dTitle').focus();
    page.timers.find(timer => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(page.activeElement()).toBe(page.el('dTitle'));
  });

  it('explains the per-write DE caption union, distinct stories, separate draft scope and unaffected EN without author admin requests', async () => {
    const requests: string[] = [];
    const page = loadPage({ isAdmin: false, request: (url) => { requests.push(url); return undefined; } });
    await open(page, { ...item('a'), impact, usedIn: [{ kind: 'post', key: 'one', title: 'Authorized title' }] });
    page.el('dCapDe').value = 'Saved caption'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    const text = page.el('dImpact').textContent;
    expect(text).toContain('2 distinct stories with gallery effects from this save');
    expect(text).toContain('1 distinct stories with gallery effects from this save');
    expect(text).toContain('EN: unaffected by this save.');
    expect(text).toContain('preview now, live after successful Publish');
    expect(text).toContain('Different saved drafts');
    expect(text).toContain('0 distinct stories with gallery effects from this save');
    expect(text).toContain('3 gallery occurrences');
    expect(text).not.toContain('Pending live descriptions');
    expect(page.el('dImpact').querySelectorAll('a').map((link) => link.href)).toEqual(['/admin/editor.html?tk=one']);
    expect(requests.some((url) => /publication\/summary|rebuild|settings/.test(url))).toBe(false);
    expect(page.patches).toHaveLength(1);
    const helper = page.win.MediaImpact as { affected(stories: StoryUse[], changed: ChangedDescriptions): string[] };
    expect(helper.affected([story('one'), story('one'), story('two', 0)], { de: { alt: true, caption: true }, en: { alt: true, caption: false } })).toEqual(['one', 'two']);
  });

  it('reports unchanged descriptions, hero-only no-gallery effect and About-only empty impact', async () => {
    const page = loadPage({ isAdmin: false });
    const heroOnly: MediaImpact = { availability: 'available', published: [{ ...story('hero'),
      locales: { de: { ...zero, heroTitle: true, inline: 1 }, en: zero } }], drafts: [], newerDrafts: [] };
    await open(page, { ...item('a'), impact: heroOnly });
    page.el('dTitle').value = 'Only title'; page.el('detail').dispatch('input'); page.el('dSave').click(); await page.flush();
    expect(page.el('dImpact').textContent).toContain('Descriptions unchanged.');
    page.el('dCapDe').value = 'Description'; page.el('detail').dispatch('input'); page.el('dSave').click(); await page.flush();
    expect(page.el('dImpact').textContent).toContain('No gallery effect.');
    expect(page.el('dImpact').textContent).toContain('hero/title: yes');
    const helper = page.win.MediaImpact as { render(...args: unknown[]): void };
    const editorCopy = page.win.EditorCopy as { en: object };
    helper.render(page.el('dImpact'), { impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] },
      usedIn: [{ kind: 'page', key: 'about', title: 'About' }] }, unchanged, false,
      editorCopy.en, () => {});
    expect(page.el('dImpact').textContent).toContain('No eligible story');
    expect(page.el('dImpact').querySelectorAll('a')).toEqual([]);
  });

  it.each([false, true])('reuses the item response for impact without another GET (unknown outcome: %s)', async (unknown) => {
    let reads = 0;
    let writes = 0;
    const fresh: Item = { ...item('a', 'saved alt'),
      impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] },
      livePending: { de: { alt: true, caption: false }, en: { alt: false, caption: false } } };
    const response = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
    const page = loadPage({ request: (url, init) => {
      if (itemPath(url) !== '/media/items/a') return;
      if (init?.method === 'PATCH') {
        writes++;
        return unknown ? Promise.reject(new Error('lost acknowledgement')) : response({
          ...fresh, conditionalVersion: 1,
          changedDescriptions: { de: { alt: true, caption: false }, en: { alt: false, caption: false } },
        });
      }
      reads++;
      return response(writes ? fresh : { ...item('a'), impact });
    } });
    await open(page);
    expect(reads).toBe(1);
    expect(page.el('dImpact').textContent).toContain('2 stories with uses');
    page.el('dAltDe').value = 'saved alt'; page.el('detail').dispatch('input');
    page.el('dSave').click(); await page.flush();
    expect(reads).toBe(unknown ? 2 : 1);
    expect(writes).toBe(1);
    expect(page.el('dImpact').textContent).toContain('No eligible story');
    expect(page.el('dImpact').textContent).toContain('DE: pending against the live release — alt text: yes, caption: no.');
    expect(page.el('dUnsaved').hidden).toBe(!unknown);
    if (unknown) expect(page.el('dCompare').textContent).toContain('Save outcome unknown');
    else expect(page.el('out').textContent).toContain(ui.en['editor.chrome.mediaConditionalSaved']);
  });

  it('refreshes only projections while dirty, preserving base expectations and last save result', async () => {
    const page = loadPage();
    await open(page, { ...item('a', 'base'), impact, livePending: unchanged });
    page.el('dAltDe').value = 'local'; page.el('detail').dispatch('input');
    page.rows.set('a', { ...item('a', 'foreign base'), impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] },
      livePending: { de: { alt: false, caption: true }, en: { alt: false, caption: false } } });
    page.timers.find((timer) => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(page.el('dAltDe').value).toBe('local');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.el('dImpact').textContent).toContain('No eligible story');
    expect(page.el('dImpact').textContent).toContain('caption: yes');
    expect(page.patches).toEqual([]);
    page.el('dSave').click(); await page.flush();
    expect(page.patches[0]?.body).toMatchObject({ conditional: { patch: { alt: { de: 'local' } }, expect: { alt: { de: 'base' } } } });
    expect(page.el('out').textContent).toContain(ui.en['editor.chrome.mediaConditionalSaved']);
  });

  it('discards reads superseded by selection and save; deadline marks unavailable without clearing dirty text', async () => {
    const reads: Array<{ key: string; response: { resolve(value: unknown): void } }> = [];
    const page = loadPage({ request: (url, init) => {
      if (!url.startsWith('/media/items/') || init?.method === 'PATCH') return undefined;
      const response = Promise.withResolvers<unknown>(); reads.push({ key: url, response }); return response.promise;
    } });
    await open(page);
    expect(reads).toHaveLength(1);
    page.el('grid').querySelectorAll('.media-cell')[1]!.click(); await page.flush();
    expect(reads).toHaveLength(2);
    reads[0]!.response.resolve({ ok: true, status: 200, json: async () => ({ ...item('a'), impact }) });
    reads[1]!.response.resolve({ ok: true, status: 200, json: async () => ({ ...item('b'), impact: { availability: 'available', published: [], drafts: [], newerDrafts: [] } }) });
    await page.flush();
    expect(page.el('detail').dataset.key).toBe('b');
    expect(page.el('dImpact').textContent).toContain('No eligible story');
    expect(page.el('dImpact').textContent).not.toContain('Authorized title');
    page.el('dAltDe').value = 'keep dirty'; page.el('detail').dispatch('input');
    page.timers.find((timer) => timer.ms === 30000 && !timer.cleared)!.fn(); await page.flush();
    expect(reads).toHaveLength(3);
    page.focus(); page.focus(); await page.flush(); expect(reads).toHaveLength(3);
    page.timers.find((timer) => timer.ms === 10000 && !timer.cleared)!.fn(); await page.flush();
    expect(page.el('dImpact').textContent).toContain('Impact unavailable or stale');
    expect(page.el('dAltDe').value).toBe('keep dirty');
    page.el('dSave').click(); await page.flush();
    reads[2]!.response.resolve({ ok: true, status: 200, json: async () => ({ ...item('b'), impact }) });
    await page.flush();
    expect(page.el('dImpact').textContent).not.toContain('2 stories with uses');
    expect(page.patches).toHaveLength(1);
    page.visibility(true);
    expect(page.timers.filter((timer) => timer.ms === 30000 && !timer.cleared)).toHaveLength(0);
  });
});

/** Runs the pending encoding-poll round (the 3 s timer) and lets it settle. */
async function runPoll(page: Page): Promise<void> {
  const due = page.timers.filter((timer) => timer.ms === POLL_MS && !timer.cleared);
  expect(due).toHaveLength(1);
  due[0]!.cleared = true;
  due[0]!.fn();
  await page.flush();
}
const pollPending = (page: Page): number => page.timers.filter((timer) => timer.ms === POLL_MS && !timer.cleared).length;
const badges = (page: Page): string[] => page.el('grid').querySelectorAll('.media-cell').map((cell) => cell.querySelectorAll('.media-cell__badge').map((badge) => badge.textContent).join(''));
const processing = (key: string): Item => ({ ...item(key), status: 'processing', thumbSrc: '', fullSrc: null });
const reply = (body: unknown, status = 200) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });

describe('media-browser encoding poll', () => {
  async function listed(page: Page, items: Item[]): Promise<void> {
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: items.length });
    await page.flush();
  }

  it('updates a processing tile to ready in place, keeps selection and focus, and announces it once', async () => {
    const page = loadPage();
    await listed(page, [processing('a'), item('b')]);
    expect(badges(page)).toEqual(['processing', '']);
    expect(pollPending(page)).toBe(1);
    page.el('grid').querySelectorAll('.media-cell')[1]!.click(); // selecting rebuilds the grid once
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[1]!.focus();
    page.rows.set('a', item('a'));
    await runPoll(page);
    const after = page.el('grid').querySelectorAll('.media-cell');
    expect(after[0]).toBe(cells[0]); // the tile itself stays; only its content changed
    expect(badges(page)).toEqual(['', '']);
    expect(after[0]!.querySelectorAll('img')).toHaveLength(1);
    expect(page.el('out').textContent).toBe('1 photo ready.');
    expect(page.el('grid').querySelectorAll('.is-selected').map((cell) => cell.dataset.key)).toEqual(['b']);
    expect(page.activeElement()).toBe(after[1]);
    expect(page.el('detail').dataset.key).toBe('b');
    expect(page.listRequests).toHaveLength(0);
    // Nothing is processing any more: no further round is scheduled.
    expect(pollPending(page)).toBe(0);
  });

  it('counts ready and failed photos in one announcement and keeps polling while any is still encoding', async () => {
    const page = loadPage();
    await listed(page, [processing('a'), processing('b'), processing('c')]);
    page.rows.set('a', item('a'));
    page.rows.set('b', { ...processing('b'), status: 'failed', error: 'decode_failed' } as Item);
    page.rows.set('c', processing('c'));
    await runPoll(page);
    expect(badges(page)).toEqual(['', 'failed: decode_failed', 'processing']);
    expect(page.el('out').textContent).toBe('1 photo ready, 1 failed.');
    expect(pollPending(page)).toBe(1);
    page.rows.set('c', item('c'));
    await runPoll(page);
    expect(badges(page)).toEqual(['', 'failed: decode_failed', '']);
    expect(page.el('out').textContent).toBe('1 photo ready.');
    expect(pollPending(page)).toBe(0);
  });

  it('pauses while the tab is hidden, resumes when it returns, and a failed read says nothing', async () => {
    let fail = true;
    const page = loadPage({ request: (url) => url === '/media/items/a' && fail ? reply({ error: 'unavailable' }, 503) : undefined });
    await listed(page, [processing('a')]);
    const before = page.el('out').textContent;
    page.visibility(true);
    expect(pollPending(page)).toBe(0);
    page.visibility(false);
    expect(pollPending(page)).toBe(1);
    await runPoll(page);
    expect(page.el('out').textContent).toBe(before);
    expect(badges(page)).toEqual(['processing']);
    expect(pollPending(page)).toBe(1);
    fail = false;
    page.rows.set('a', item('a'));
    await runPoll(page);
    expect(badges(page)).toEqual(['']);
    expect(page.el('out').textContent).toBe('1 photo ready.');
  });

  it('starts polling when an upload has been transferred and the grid lists it as processing', async () => {
    const page = loadPage();
    await listed(page, [item('existing')]);
    expect(pollPending(page)).toBe(0);
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'processing' });
    await page.flush();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [processing('new'), item('existing')], total: 2 });
    await page.flush();
    expect(pollPending(page)).toBe(1);
  });

  it('enables Delete in the open panel without touching what the author is typing', async () => {
    const page = loadPage();
    await listed(page, [processing('a')]);
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    expect(page.el('dDelete').disabled).toBe(true);
    expect(page.el('detail').find('deleteNote')).not.toBeNull();
    expect(page.el('dSuggest').disabled).toBe(true);
    page.el('dAltDe').value = 'Typed while encoding';
    page.el('detail').dispatch('input');
    page.el('dAltDe').focus();
    page.rows.set('a', item('a'));
    await runPoll(page);
    expect(page.el('dDelete').disabled).toBe(false);
    expect(page.el('detail').find('deleteNote')).toBeNull();
    expect(page.el('dSuggest').disabled).toBe(false);
    expect(page.el('dAltDe').value).toBe('Typed while encoding');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.activeElement()).toBe(page.el('dAltDe'));
    expect(page.el('detail').querySelectorAll('.media-detail__preview')[0]!.querySelectorAll('img')).toHaveLength(1);
  });

  it('rebuilds a clean, unfocused panel so Retry encoding appears for a failed photo', async () => {
    const page = loadPage();
    await listed(page, [processing('a')]);
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    page.el('grid').querySelectorAll('.media-cell')[0]!.focus();
    expect(page.el('detail').find('dRetry')).toBeNull();
    page.rows.set('a', { ...processing('a'), status: 'failed', error: 'decode_failed' } as Item);
    await runPoll(page);
    expect(page.el('dRetry')).toBeDefined();
    expect(page.el('dDelete').disabled).toBe(false);
    expect(page.el('out').textContent).toBe('1 photo failed.');
  });
});

describe('media-browser alt text count and filter', () => {
  it('says how many ready photos have no alt text, filters to them and back, and shows the active filter', async () => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a'), item('b')], total: 2, altMissing: 12 });
    await page.flush();
    expect(page.el('grid').textContent).not.toContain('No alt text');
    expect(page.el('altMissingLine').hidden).toBe(false);
    expect(page.el('altMissingText').textContent).toBe('12 ready photos in this view have no alt text.');
    expect(page.el('altMissingAction').textContent).toBe('Show only these');
    expect(page.el('fExtra').hidden).toBe(true);

    page.el('altMissingAction').click();
    await page.flush();
    const filtered = page.listRequests.shift()!;
    expect(new URL(filtered.url, 'https://app.example').searchParams.get('alt')).toBe('missing');
    expect(page.el('fAlt').value).toBe('missing');
    expect(page.el('fExtra').hidden).toBe(false);
    expect(page.el('fMore').getAttribute('aria-expanded')).toBe('true');
    filtered.resolve({ items: [item('a')], total: 1, altMissing: 12 });
    await page.flush();
    expect(page.el('altMissingText').textContent).toBe('Showing photos without alt text.');
    expect(page.el('altMissingAction').textContent).toBe('Show all photos in this view');

    page.el('altMissingAction').click();
    await page.flush();
    const all = page.listRequests.shift()!;
    expect(new URL(all.url, 'https://app.example').searchParams.get('alt')).toBeNull();
    expect(page.el('fAlt').value).toBe('');
    all.resolve({ items: [item('a'), item('b')], total: 2, altMissing: 1 });
    await page.flush();
    expect(page.el('altMissingText').textContent).toBe('1 ready photo in this view has no alt text.');

    // The select under More filters is the same filter.
    page.el('fAlt').value = 'missing';
    page.el('fAlt').dispatch('change');
    await page.flush();
    expect(new URL(page.listRequests.shift()!.url, 'https://app.example').searchParams.get('alt')).toBe('missing');
  });

  it.each([
    ['a count of 0', { altMissing: 0 }],
    ['no count at all (a server from before the field existed)', {}],
  ])('shows nothing with %s', async (_label, extra) => {
    const page = loadPage();
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [item('a')], total: 1, ...extra });
    await page.flush();
    expect(page.el('altMissingLine').hidden).toBe(true);
    expect(page.el('altMissingText').textContent).toBe('');
  });
});

describe('media-browser folder prompts', () => {
  it('creates a folder through the in-page prompt, then opens it and says so', async () => {
    let folders: string[] = [];
    const page = loadPage({ prompt: 'Iceland', request: (url, init) => {
      if (url !== '/media/folders') return;
      if (init?.method === 'POST') {
        expect(JSON.parse(init.body ?? '{}')).toEqual({ path: 'Iceland' });
        folders = ['Iceland'];
        return reply({ ok: true, folders });
      }
      return reply(folders);
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('newFolder').click(); await page.flush();
    expect(page.prompts).toHaveLength(1);
    expect(page.prompts[0]).toMatchObject({ title: 'New folder', label: 'Folder name', confirmLabel: 'Create folder' });
    expect(page.prompts[0]!.validate!('a/b')).toBe('A folder name cannot contain a slash. Create one level at a time.');
    expect(page.prompts[0]!.validate!('Iceland')).toBe('');
    const listing = page.listRequests.shift()!;
    expect(new URL(listing.url, 'https://app.example').searchParams.get('folder')).toBe('Iceland');
    listing.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('out').textContent).toBe('Folder created.');
    expect(page.el('folderTree').querySelectorAll('.is-current').map((button) => button.textContent)).toEqual(['Iceland']);
    expect(page.el('out').adjacent).toHaveLength(0); // no recovery panel for an acknowledged create
  });

  it('creates nothing when the prompt is cancelled or refuses the name', async () => {
    let creates = 0;
    const page = loadPage({ prompt: null, request: (url, init) => {
      if (url === '/media/folders' && init?.method === 'POST') { creates++; return reply({ ok: true, folders: [] }); }
      return undefined;
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('newFolder').click(); await page.flush();
    page.promptAnswer.value = 'bad/name';
    page.el('newFolder').click(); await page.flush();
    expect(page.prompts).toHaveLength(2);
    expect(creates).toBe(0);
    expect(page.listRequests).toHaveLength(0);
  });

  it('renames the current folder through the prompt, keeping its parent, and counts the moved photos', async () => {
    let renamed: unknown;
    const page = loadPage({ folders: ['Trips', 'Trips/North'], prompt: 'South', request: (url, init) => {
      if (url === '/media/folders' && init?.method === 'PATCH') { renamed = JSON.parse(init.body ?? '{}'); return reply({ ok: true, moved: 3, folders: ['Trips', 'Trips/South'] }); }
      return undefined;
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('folderTree').querySelectorAll('.folder-btn').find((button) => button.textContent === 'North')!.click();
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('renameFolder').click(); await page.flush();
    expect(page.prompts[0]).toMatchObject({ title: 'Rename folder', label: 'Folder name', value: 'North', confirmLabel: 'Rename folder' });
    expect(page.prompts[0]!.validate!('Nor%th')).toBe('A folder name can contain only letters, digits, spaces, hyphens, underscores and dots.');
    expect(renamed).toEqual({ from: 'Trips/North', to: 'Trips/South' });
    const listing = page.listRequests.shift()!;
    expect(new URL(listing.url, 'https://app.example').searchParams.get('folder')).toBe('Trips/South');
    listing.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('out').textContent).toBe('Folder renamed (3 photos moved).');
  });

  it('moves focus to the folder that becomes current after deleting one', async () => {
    let folders = ['Trips', 'Trips/North'];
    const page = loadPage({ request: (url, init) => {
      if (url !== '/media/folders') return;
      if (init?.method === 'DELETE') { folders = ['Trips']; return reply({ ok: true }); }
      return reply(folders);
    } });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('folderTree').querySelectorAll('.folder-btn').find((button) => button.textContent === 'North')!.click();
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.confirmAnswer.value = true;
    page.el('deleteFolder').focus();
    page.el('deleteFolder').click(); await page.flush();
    page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    expect(page.el('out').textContent).toBe('Folder deleted.');
    const current = page.activeElement();
    expect(current?.textContent).toBe('Trips');
    expect(current?.getAttribute('aria-current')).toBe('true');
  });
});

describe('media-browser unsaved details guard', () => {
  it('asks in page with the photo\'s title, and cancelling keeps the edits', async () => {
    const page = loadPage();
    const named = { ...item('library/2025/sea-lion'), title: 'Sea lion asleep' };
    await page.flush();
    page.listRequests.shift()!.resolve({ items: [named, item('b')], total: 2 });
    await page.flush();
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[0]!.click();
    page.el('dAltDe').value = 'Dozing on the lava';
    page.el('detail').dispatch('input');
    page.confirmAnswer.value = false;
    cells[1]!.click();
    await page.flush();
    expect(page.confirms).toHaveLength(1);
    expect(page.confirms[0]).toContain('"Sea lion asleep"');
    expect(page.confirms[0]).not.toContain('library/2025');
    expect(page.el('detail').dataset.key).toBe('library/2025/sea-lion');
    expect(page.el('dAltDe').value).toBe('Dozing on the lava');
    expect(page.el('dUnsaved').hidden).toBe(false);
  });
});

describe('media-browser upload rejections', () => {
  function xhrAnswering(status: number, body: unknown) {
    return class {
      status = 0;
      responseText = '';
      onload = (): void => {};
      upload = { onprogress: (): void => {} };
      open(): void {}
      abort(): void {}
      send(): void { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
    };
  }

  it('words a file the server cannot read as a sentence and never offers to send it again', async () => {
    const page = loadPage({ xhr: xhrAnswering(400, { error: 'invalid key or image' }) });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'scan.jpg', type: 'image/jpeg', size: 1000 }] } });
    await page.flush();
    const queue = page.el('uploadQueue');
    expect(queue.querySelectorAll('.upload-row__state').map((node) => node.textContent)).toEqual([ui.en['editor.chrome.uploadRejectedUnreadable']]);
    expect(queue.textContent).toContain(ui.en['editor.chrome.uploadRejectedCount'].replace('{count}', '1'));
    expect(queue.textContent).not.toContain('invalid key or image');
    const buttons = queue.querySelectorAll('button').map((button) => button.textContent);
    expect(buttons.some((label) => label.startsWith(ui.en['editor.chrome.uploadRetry']))).toBe(false);
    expect(buttons).toContain('Clear finished');
    queue.querySelectorAll('button').find((button) => button.textContent === 'Clear finished')!.click();
    await page.flush();
    expect(page.el('uploadQueue').hidden).toBe(true);
    expect(page.uploadRequests).toHaveLength(0); // the custom XHR answered directly; nothing was resent
  });

  it('keeps a definite non-file failure retryable and reads it as a sentence', async () => {
    const page = loadPage({ xhr: xhrAnswering(409, { error: 'upload id reused', code: 'upload_id_reused' }) });
    await page.flush(); page.listRequests.shift()!.resolve({ items: [], total: 0 }); await page.flush();
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'again.jpg', type: 'image/jpeg', size: 1000 }] } });
    await page.flush();
    const queue = page.el('uploadQueue');
    expect(queue.querySelectorAll('.upload-row__state').map((node) => node.textContent)).toEqual(['Could not upload: Upload id reused.']);
    expect(queue.querySelectorAll('button').map((button) => button.textContent)).toContain(ui.en['editor.chrome.uploadRetry'] + ' (1)');
  });
});

describe('media-browser focus after actions', () => {
  async function open(page: Page, items: Item[]): Promise<void> {
    for (const row of items) page.rows.set(row.key, row);
    await page.flush();
    page.listRequests.shift()!.resolve({ items, total: items.length });
    await page.flush();
  }
  async function deletePhoto(page: Page, index: number): Promise<void> {
    page.el('grid').querySelectorAll('.media-cell')[index]!.click();
    page.confirmAnswer.value = true;
    page.el('dDelete').focus();
    page.el('dDelete').click();
    await page.flush();
    const remaining = [...page.rows.values()];
    page.listRequests.shift()!.resolve({ items: remaining, total: remaining.length });
    await page.flush();
  }

  it('lands on the next tile after a delete, then the previous one, then the empty state\'s upload action', async () => {
    const page = loadPage();
    await open(page, [item('a'), item('b'), item('c')]);
    await deletePhoto(page, 1);
    expect(page.el('out').textContent).toBe('Photo deleted.');
    expect(page.activeElement()?.dataset.key).toBe('c');
    await deletePhoto(page, 1);
    expect(page.activeElement()?.dataset.key).toBe('a');
    await deletePhoto(page, 0);
    expect(page.el('mediaEmpty').hidden).toBe(false);
    expect(page.activeElement()).toBe(page.el('emptyChoosePhotos'));
  });

  it('keeps focus on Save details after saving and says so', async () => {
    const page = loadPage();
    await open(page, [item('a')]);
    page.el('grid').querySelectorAll('.media-cell')[0]!.click();
    page.el('dTitle').value = 'Named';
    page.el('detail').dispatch('input');
    page.el('dSave').focus();
    page.el('dSave').click();
    await page.flush();
    expect(page.patches).toHaveLength(1);
    expect(page.el('out').textContent).toBe('Details saved.');
    expect(page.activeElement()).toBe(page.el('dSave'));
    expect(page.el('dSave').disabled).toBe(false);
  });

  it('continues from the selection\'s anchor after Clear selection', async () => {
    const page = loadPage();
    await open(page, [item('a'), item('b'), item('c')]);
    const cells = page.el('grid').querySelectorAll('.media-cell');
    cells[1]!.click();
    page.el('grid').querySelectorAll('.media-cell')[2]!.dispatch('click', { ctrlKey: true });
    expect(page.el('bulkTools').hidden).toBe(false);
    page.el('clearSelection').focus();
    page.el('clearSelection').click();
    expect(page.el('bulkTools').hidden).toBe(true);
    expect(page.activeElement()?.dataset.key).toBe('c');
  });
});

describe('media-browser URL state', () => {
  it('restores the folder and the alt filter from the URL and keeps them there', async () => {
    const page = loadPage({ search: '?folder=Trips%2FNorth&alt=missing', folders: ['Trips', 'Trips/North'] });
    await page.flush();
    const first = page.listRequests.shift()!;
    const params = new URL(first.url, 'https://app.example').searchParams;
    expect(params.get('folder')).toBe('Trips/North');
    expect(params.get('alt')).toBe('missing');
    expect(page.el('fAlt').value).toBe('missing');
    expect(page.el('fExtra').hidden).toBe(false);
    first.resolve({ items: [], total: 0, altMissing: 0 });
    await page.flush();
    expect(page.el('folderTree').querySelectorAll('.is-current').map((button) => button.textContent)).toEqual(['North']);
    expect(page.urlState()).toBe('?folder=Trips%2FNorth&alt=missing');

    page.el('folderTree').querySelectorAll('.folder-btn').find((button) => button.textContent === 'All photos')!.click();
    await page.flush();
    expect(page.urlState()).toBe('?alt=missing');
    page.listRequests.shift()!.resolve({ items: [], total: 0, altMissing: 0 });
    await page.flush();
    page.el('fAlt').value = '';
    page.el('fAlt').dispatch('change');
    await page.flush();
    expect(page.urlState()).toBe('');
  });

  it('falls back to All photos when the folder in the URL no longer exists', async () => {
    const page = loadPage({ search: '?folder=Gone', folders: ['Trips'] });
    await page.flush();
    const first = page.listRequests.shift()!;
    expect(new URL(first.url, 'https://app.example').searchParams.get('folder')).toBe('');
    expect(page.urlState()).toBe('');
    first.resolve({ items: [], total: 0 });
    await page.flush();
    expect(page.el('folderTree').querySelectorAll('.is-current').map((button) => button.textContent)).toEqual(['All photos']);
  });
});

// ---- #570: camera settings, stored versions, fullscreen viewer, no storage key ----

/** Lists `items` as the library's first page; `page.rows` answers item reads for them. */
async function showLibrary(page: Page, items: Item[]): Promise<void> {
  for (const row of items) page.rows.set(row.key, row);
  await page.flush();
  page.listRequests.shift()!.resolve({ items, total: items.length });
  await page.flush();
}
const tiles = (page: Page): FakeNode[] => page.el('grid').querySelectorAll('.media-cell');
/** Replaces the page's listing through a filter change, as any reload behind an open dialog does. */
async function relist(page: Page, items: Item[]): Promise<void> {
  page.el('fStatus').dispatch('change');
  await page.flush();
  page.listRequests.shift()!.resolve({ items, total: items.length });
  await page.flush();
}

describe('media-browser photo details without the storage key (#570)', () => {
  /** The File list as [label, value] rows. */
  function fileRows(page: Page): string[][] {
    const list = page.el('detail').querySelectorAll('dl')[0]!;
    const values = list.querySelectorAll('dd');
    return list.querySelectorAll('dt').map((term, index) => [term.textContent, values[index]!.textContent]);
  }

  it('names the photo by its title and never shows its storage key', async () => {
    const page = loadPage();
    await showLibrary(page, [{ ...item('library/2025/sea-lion'), title: 'Sea lion asleep' }]);
    tiles(page)[0]!.click();
    await page.flush();
    expect(page.el('dTitle').value).toBe('Sea lion asleep');
    expect(page.el('detail').textContent).not.toContain('library/2025');
    expect(page.el('detail').textContent).not.toContain('sea-lion');
    expect(page.el('detail').querySelectorAll('.media-key')).toEqual([]);
  });

  it('lists lens and exposure only where the camera recorded them', async () => {
    const page = loadPage();
    await showLibrary(page, [
      { ...item('full'), exif: { ...NO_EXIF, camera: 'LEICA Q2', lens: 'SUMMILUX 1:1.7/28 ASPH.', focalLength: 28, focalLength35mm: 28, fNumber: 1.7, iso: 100, exposureTime: 0.004 } },
      { ...item('phone'), exif: { ...NO_EXIF, focalLength: 4.3, focalLength35mm: 24, fNumber: 1.8 } },
      { ...item('bare'), exif: NO_EXIF },
      item('none'),
    ]);
    const sizes = [['Original', '1 B'], ['Variants', '1 B']];
    tiles(page)[0]!.click();
    expect(fileRows(page)).toEqual([
      ['Lens', 'SUMMILUX 1:1.7/28 ASPH.'],
      ['Exposure', '28 mm · f/1.7 · 1/250 s · ISO 100'],
      ...sizes,
    ]);
    tiles(page)[1]!.click();
    expect(fileRows(page)).toEqual([['Exposure', '4.3 mm (24 mm equiv.) · f/1.8'], ...sizes]);
    // No row and no dash for what was never recorded — with empty EXIF and with none.
    tiles(page)[2]!.click();
    expect(fileRows(page)).toEqual(sizes);
    tiles(page)[3]!.click();
    expect(fileRows(page)).toEqual(sizes);
  });

  it('shows exposure to an author as well, and coordinates only when the server sent them', async () => {
    const exif: Exif = { ...NO_EXIF, fNumber: 8, lat: 64.1466, lng: -21.9426 };
    const admin = loadPage();
    await showLibrary(admin, [{ ...item('a'), exif }]);
    tiles(admin)[0]!.click();
    expect(fileRows(admin)).toEqual([['Exposure', 'f/8'], ['Original', '1 B'], ['Variants', '1 B'], ['GPS', '64.1466, -21.9426']]);
    // A non-admin's row arrives with lat/lng already nulled by the server.
    const author = loadPage({ isAdmin: false });
    await showLibrary(author, [{ ...item('a'), exif: { ...exif, lat: null, lng: null } }]);
    tiles(author)[0]!.click();
    expect(fileRows(author)).toEqual([['Exposure', 'f/8'], ['Original', '1 B'], ['Variants', '1 B']]);
  });

  it('names an untitled photo by its file name when asking to discard, never by its path', async () => {
    const page = loadPage();
    await showLibrary(page, [{ ...item('library/2025/IMG_0042'), title: '' }, item('b')]);
    tiles(page)[0]!.click();
    page.el('dAltDe').value = 'Unsaved';
    page.el('detail').dispatch('input');
    tiles(page)[1]!.click();
    await page.flush();
    expect(page.confirms).toEqual(['The details of "IMG_0042" have unsaved changes. Discarding them cannot be undone.']);
  });

  it('names the last key segment, not the key, when the panel has no row to name', async () => {
    const page = loadPage();
    await showLibrary(page, [item('b')]);
    // Not reachable through the page (a dirty panel always has its row); pinned
    // so this fallback can never put a storage path into the question.
    page.el('detail').dataset.key = 'library/2025/IMG_0042';
    page.el('detail').dispatch('input');
    tiles(page)[0]!.click();
    await page.flush();
    expect(page.confirms).toEqual(['The details of "IMG_0042" have unsaved changes. Discarding them cannot be undone.']);
  });
});

describe('media-browser Versions section (#570)', () => {
  const kB = 1024;
  const stored: Versions = { availability: 'available', items: [
    version('a', 'avif', 640, 427, 38 * kB), version('a', 'webp', 640, 427, 52 * kB),
    version('a', 'avif', 1920, 1280, 412 * kB), version('a', 'webp', 1920, null, 590 * kB),
  ] };
  const NEW_TAB = ' ' + ui.en['editor.chrome.mediaVersionNewTab'];
  const links = (page: Page): FakeNode[] => page.el('dVersions').querySelectorAll('a');
  /** Opens the panel on `row`, with `listing` as what the disk holds for it. */
  async function open(page: Page, row: Item = item('a'), listing?: Versions): Promise<void> {
    if (listing) page.versions.set(row.key, listing);
    await showLibrary(page, [row, item('b')]);
    tiles(page)[0]!.click();
    await page.flush();
  }
  /** The observation's 30 s cycle. */
  async function refresh(page: Page): Promise<void> {
    page.timers.find((timer) => timer.ms === 30000 && !timer.cleared)!.fn();
    await page.flush();
  }

  it('lists each stored file as a link to the public file that opens a new tab', async () => {
    const page = loadPage();
    await open(page, item('a'), stored);
    expect(page.el('dVersionsLabel').textContent).toBe('Versions');
    expect(page.el('dVersions').querySelectorAll('ul')[0]!.getAttribute('aria-labelledby')).toBe('dVersionsLabel');
    expect(links(page).map((link) => [link.textContent, link.href, link.target, link.rel])).toEqual([
      ['AVIF · 640 × 427 · 38 kB' + NEW_TAB, 'https://img.example/a-640.avif', '_blank', 'noopener noreferrer'],
      ['WebP · 640 × 427 · 52 kB' + NEW_TAB, 'https://img.example/a-640.webp', '_blank', 'noopener noreferrer'],
      ['AVIF · 1920 × 1280 · 412 kB' + NEW_TAB, 'https://img.example/a-1920.avif', '_blank', 'noopener noreferrer'],
      // A file whose header could not be read still lists, with a dash for its height.
      ['WebP · 1920 × — · 590 kB' + NEW_TAB, 'https://img.example/a-1920.webp', '_blank', 'noopener noreferrer'],
    ]);
    // The new tab is announced, not drawn.
    expect(links(page)[0]!.querySelectorAll('.visually-hidden').map((note) => note.textContent)).toEqual([NEW_TAB]);
  });

  it('asks for the listing with the panel observation only, and keeps it when a save answers without one', async () => {
    const page = loadPage();
    await open(page, item('a'), stored);
    expect(page.itemReads).toEqual(['/media/items/a?versions=1']);
    page.el('dTitle').value = 'Named';
    page.el('detail').dispatch('input');
    page.el('dSave').click();
    await page.flush();
    expect(page.patches.map((patch) => patch.url)).toEqual(['/media/items/a']);
    // The PATCH response carries no `versions`; the rebuilt panel still lists the files.
    expect(links(page)).toHaveLength(4);
    expect(page.itemReads).toEqual(['/media/items/a?versions=1']);
    await refresh(page);
    expect(page.itemReads).toEqual(['/media/items/a?versions=1', '/media/items/a?versions=1']);
  });

  it.each<[string, unknown, string]>([
    ['a photo without variant files', { availability: 'available', items: [] }, ui.en['editor.chrome.mediaVersionsEmpty']],
    ['a photo that is still encoding', { availability: 'processing' }, ui.en['editor.chrome.mediaVersionsProcessing']],
    ['a storage error', { availability: 'unavailable' }, ui.en['editor.chrome.mediaVersionsUnavailable']],
    ['a listing the route never promised', { availability: 'available', items: [{ format: 'png' }] }, ui.en['editor.chrome.mediaVersionsUnavailable']],
  ])('says in words what there is to see for %s', async (_label, listing, words) => {
    const page = loadPage();
    await open(page, item('a'), listing as Versions);
    expect(links(page)).toEqual([]);
    expect(page.el('dVersions').textContent).toBe(words);
  });

  it('says it is reading until the first observation, and that it could not only when nothing was ever listed', async () => {
    const first = Promise.withResolvers<unknown>();
    const page = loadPage({ request: (url) => url === '/media/items/a?versions=1' ? first.promise : undefined });
    await open(page);
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsLoading']);
    first.reject(new Error('connection lost'));
    await page.flush();
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsUnavailable']);
  });

  it('keeps the last listing when a later read fails', async () => {
    let down = false;
    const page = loadPage({ request: (url) => down && url === '/media/items/a?versions=1' ? reply({ error: 'unavailable' }, 503) : undefined });
    await open(page, item('a'), stored);
    down = true;
    await refresh(page);
    expect(page.el('dImpact').textContent).toContain(ui.en['editor.chrome.mediaImpactUnavailable']);
    expect(links(page)).toHaveLength(4);
  });

  it('keeps focus on the same version across a refresh and never takes it from elsewhere', async () => {
    const page = loadPage();
    await open(page, item('a'), stored);
    const webp = links(page)[1]!;
    webp.focus();
    // Nothing changed on disk: the link itself stays, so a click in progress still lands.
    await refresh(page);
    expect(links(page)[1]).toBe(webp);
    expect(page.activeElement()).toBe(webp);
    // A re-encode changed the files: the list is rebuilt and focus follows format and width.
    page.versions.set('a', { availability: 'available', items: [
      version('a', 'avif', 320, 213, 12 * kB), version('a', 'avif', 640, 427, 40 * kB), version('a', 'webp', 640, 427, 55 * kB),
    ] });
    await refresh(page);
    expect(links(page)).not.toContain(webp);
    expect(page.activeElement()).toBe(links(page)[2]);
    expect(page.activeElement()?.textContent).toBe('WebP · 640 × 427 · 55 kB' + NEW_TAB);
    // The focused version is gone: the first remaining link takes over …
    page.versions.set('a', { availability: 'available', items: [version('a', 'avif', 320, 213, 12 * kB)] });
    await refresh(page);
    expect(page.activeElement()).toBe(links(page)[0]);
    // … and with no link left, the panel — never <body>.
    page.versions.set('a', { availability: 'available', items: [] });
    await refresh(page);
    expect(page.activeElement()).toBe(page.el('detail'));
    // Focus anywhere else is left where it is.
    page.versions.set('a', stored);
    page.el('dTitle').focus();
    await refresh(page);
    expect(links(page)).toHaveLength(4);
    expect(page.activeElement()).toBe(page.el('dTitle'));
  });

  it('lists a file outside the image origin as text, not as a link', async () => {
    const page = loadPage();
    await open(page, item('a'), { availability: 'available', items: [
      { ...version('a', 'avif', 640, 427, 38 * kB), src: 'https://elsewhere.example/a-640.avif' },
      { ...version('a', 'webp', 640, 427, 52 * kB), src: 'javascript:alert(1)' },
      // On the image origin, but carrying credentials: never a link.
      { ...version('a', 'webp', 1280, 853, 60 * kB), src: 'https://user:secret@img.example/a-1280.webp' },
      version('a', 'avif', 1920, 1280, 412 * kB),
    ] });
    expect(page.el('dVersions').querySelectorAll('li').map((row) => row.textContent)).toEqual([
      'AVIF · 640 × 427 · 38 kB', 'WebP · 640 × 427 · 52 kB', 'WebP · 1280 × 853 · 60 kB', 'AVIF · 1920 × 1280 · 412 kB' + NEW_TAB,
    ]);
    expect(links(page).map((link) => link.href)).toEqual(['https://img.example/a-1920.avif']);
  });

  it('lists the versions as soon as the poll sees the open photo ready', async () => {
    const page = loadPage();
    page.versions.set('a', { availability: 'processing' });
    await showLibrary(page, [processing('a')]);
    tiles(page)[0]!.click();
    await page.flush();
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsProcessing']);
    page.rows.set('a', item('a'));
    page.versions.set('a', stored);
    await runPoll(page);
    expect(links(page)).toHaveLength(4);
    // One poll read without the listing, then exactly one more observation read with it.
    expect(page.itemReads).toEqual(['/media/items/a?versions=1', '/media/items/a', '/media/items/a?versions=1']);
  });

  it('still lists them when that read lands while another photo is being polled', async () => {
    const other = Promise.withResolvers<unknown>();
    const page = loadPage({ request: (url) => url === '/media/items/b' ? other.promise : undefined });
    page.versions.set('a', { availability: 'processing' });
    await showLibrary(page, [processing('a'), processing('b')]);
    tiles(page)[0]!.click();
    await page.flush();
    page.rows.set('a', item('a'));
    page.versions.set('a', stored);
    await runPoll(page);
    // The listing was asked for the moment a flipped, without waiting for b's read …
    expect(page.itemReads.toSorted()).toEqual(['/media/items/a', '/media/items/a?versions=1', '/media/items/a?versions=1', '/media/items/b']);
    // … but that read settled during b's read and was dropped.
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsProcessing']);
    other.resolve({ status: 200, ok: true, json: async () => processing('b') });
    await page.flush();
    expect(links(page)).toHaveLength(4);
  });

  it('lists a ready photo opened while the poll is reading other photos', async () => {
    const b = Promise.withResolvers<unknown>();
    const c = Promise.withResolvers<unknown>();
    const page = loadPage({ request: (url) => url === '/media/items/b' ? b.promise : url === '/media/items/c' ? c.promise : undefined });
    page.versions.set('a', stored);
    await showLibrary(page, [item('a'), processing('b'), processing('c')]);
    await runPoll(page); // b's read stays in flight: the round is open
    tiles(page)[0]!.click();
    await page.flush();
    // The panel's read goes out between b and c, and settles while c is being read.
    b.resolve({ status: 200, ok: true, json: async () => processing('b') });
    await page.flush();
    expect(page.itemReads).toEqual(['/media/items/b', '/media/items/a?versions=1', '/media/items/c']);
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsLoading']);
    c.resolve({ status: 200, ok: true, json: async () => processing('c') });
    await page.flush();
    // The round's end asks again, without waiting for the 30 s cycle.
    expect(links(page)).toHaveLength(4);
  });

  it('lists a ready photo whose first read lands inside a poll round that started after it', async () => {
    const first = Promise.withResolvers<unknown>();
    const other = Promise.withResolvers<unknown>();
    let versionReads = 0;
    const page = loadPage({ request: (url) => {
      if (url === '/media/items/b') return other.promise;
      if (url === '/media/items/a?versions=1' && versionReads++ === 0) return first.promise;
      return undefined;
    } });
    page.versions.set('a', stored);
    await showLibrary(page, [item('a'), processing('b')]);
    tiles(page)[0]!.click();
    await page.flush();
    await runPoll(page);
    expect(page.itemReads).toEqual(['/media/items/a?versions=1', '/media/items/b']);
    first.resolve({ status: 200, ok: true, json: async () => ({ ...item('a'), versions: stored }) });
    await page.flush();
    expect(page.el('dVersions').textContent).toBe(ui.en['editor.chrome.mediaVersionsLoading']);
    other.resolve({ status: 200, ok: true, json: async () => processing('b') });
    await page.flush();
    expect(links(page)).toHaveLength(4);
  });
});

describe('media-browser fullscreen viewer (#570)', () => {
  const viewer = (page: Page): FakeNode => page.el('mediaViewer');
  const stageImages = (page: Page): FakeNode[] => page.el('viewerStage').querySelectorAll('img');
  /** What the stage says instead of a photograph ('' while it shows one). */
  function stageNote(page: Page): string {
    return page.el('viewerStage').querySelectorAll('.media-viewer__note').map((note) => note.textContent).join('');
  }
  /** Sends a key to `node` the way a browser does — bubbling through its ancestors to the
   *  document and window — so a handler registered above the target is exercised too.
   *  The returned spy tells whether the page claimed it. */
  function press(node: FakeNode, key: string, modifiers: Record<string, unknown> = {}): Mock {
    const preventDefault = vi.fn();
    node.dispatchBubbling('keydown', { key, preventDefault, ...modifiers });
    return preventDefault;
  }
  /** Focuses a tile and presses F on it, as a keyboard user does. */
  function openFromTile(page: Page, index: number): void {
    const tile = tiles(page)[index]!;
    tile.focus();
    press(tile, 'f');
  }
  const ends = (page: Page): (string | null)[] =>
    [page.el('viewerPrev').getAttribute('aria-disabled'), page.el('viewerNext').getAttribute('aria-disabled')];

  it('opens on F from a focused tile, in either case, and says so on the tile', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), { ...item('b'), title: 'Sea lion asleep' }, item('c')]);
    const tile = tiles(page)[1]!;
    expect(tile.getAttribute('aria-keyshortcuts')).toBe('f');
    tile.focus();
    expect(press(tile, 'f')).toHaveBeenCalledOnce();
    expect(viewer(page).open).toBe(true);
    expect(page.el('viewerTitle').textContent).toBe('Sea lion asleep');
    // The largest variant, as the server derived it.
    expect(stageImages(page).map((image) => image.src)).toEqual(['https://img.example/b-10.webp']);
    expect(page.el('viewerPosition').textContent).toBe('Photo 2 of 3 on this page');
    expect(page.activeElement()).toBe(page.el('viewerClose'));
    // Looking is not selecting: nothing is selected and no details open.
    expect(page.el('grid').querySelectorAll('.is-selected')).toEqual([]);
    expect(page.el('detail').hidden).toBe(true);

    viewer(page).close();
    // Caps Lock sends the upper-case key without Shift.
    press(tiles(page)[0]!, 'F');
    expect(viewer(page).open).toBe(true);
    expect(page.el('viewerTitle').textContent).toBe('a');
  });

  it.each([
    ['Ctrl+F', { key: 'f', ctrlKey: true }],
    ['⌘+F', { key: 'f', metaKey: true }],
    ['Alt+F', { key: 'f', altKey: true }],
    ['Shift+F', { key: 'F', shiftKey: true }],
    ['a held F', { key: 'f', repeat: true }],
  ])('leaves %s to the browser', async (_label, { key, ...modifiers }) => {
    const page = loadPage();
    await showLibrary(page, [item('a')]);
    const tile = tiles(page)[0]!;
    tile.focus();
    expect(press(tile, key, modifiers)).not.toHaveBeenCalled();
    expect(viewer(page).open).toBe(false);
  });

  it('does nothing for an F typed in the panel: a folder select, a text field, a button', async () => {
    const page = loadPage({ folders: ['Fjords'] });
    await showLibrary(page, [item('a')]);
    tiles(page)[0]!.click();
    for (const id of ['dFolder', 'dTitle', 'dAltDe', 'dSave', 'dViewer', 'detail']) {
      page.el(id).focus();
      expect(press(page.el(id), 'f'), id).not.toHaveBeenCalled();
      expect(viewer(page).open, id).toBe(false);
    }
  });

  it('opens from View fullscreen under the preview, on the photo the panel shows', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b')]);
    tiles(page)[1]!.click();
    const button = page.el('dViewer');
    expect(button.textContent).toBe('View fullscreen');
    expect(button.className).toBe('btn-secondary');
    // The shortcut belongs to the tiles, where it works — not to this button.
    expect(button.getAttribute('aria-keyshortcuts')).toBeNull();
    button.focus();
    button.click();
    expect(viewer(page).open).toBe(true);
    expect(page.el('viewerTitle').textContent).toBe('b');
    expect(page.el('viewerPosition').textContent).toBe('Photo 2 of 2 on this page');
  });

  it('steps with ←/→ and Previous/Next in grid order, without wrapping, and announces each step', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), { ...item('b'), title: 'Dinner for $& two' }, item('c')]);
    openFromTile(page, 0);
    expect(ends(page)).toEqual(['true', 'false']);
    // Opening is announced by the dialog and its name, not by the live region.
    expect(page.el('viewerLive').textContent).toBe('');

    expect(press(viewer(page), 'ArrowRight')).toHaveBeenCalledOnce();
    expect(page.el('viewerTitle').textContent).toBe('Dinner for $& two');
    expect(page.el('viewerPosition').textContent).toBe('Photo 2 of 3 on this page');
    expect(page.el('viewerLive').textContent).toBe('Photo 2 of 3: Dinner for $& two');
    expect(ends(page)).toEqual(['false', 'false']);

    page.el('viewerNext').click();
    expect(page.el('viewerTitle').textContent).toBe('c');
    expect(ends(page)).toEqual(['false', 'true']);
    // No wrap: a further step changes nothing and announces nothing.
    press(viewer(page), 'ArrowRight');
    page.el('viewerNext').click();
    expect(page.el('viewerTitle').textContent).toBe('c');
    expect(page.el('viewerLive').textContent).toBe('Photo 3 of 3: c');

    press(viewer(page), 'ArrowLeft');
    page.el('viewerPrev').click();
    expect(page.el('viewerTitle').textContent).toBe('a');
    expect(ends(page)).toEqual(['true', 'false']);
    page.el('viewerPrev').click();
    expect(page.el('viewerTitle').textContent).toBe('a');

    // Alt+← is the browser's Back, not a step.
    press(viewer(page), 'ArrowRight');
    expect(press(viewer(page), 'ArrowLeft', { altKey: true })).not.toHaveBeenCalled();
    expect(page.el('viewerTitle').textContent).toBe('Dinner for $& two');
  });

  it('keeps focus on a step control that reaches an end: aria-disabled, never disabled', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b')]);
    openFromTile(page, 0);
    const next = page.el('viewerNext');
    next.focus();
    next.click();
    expect(page.el('viewerTitle').textContent).toBe('b');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.disabled).toBe(false);
    expect(page.el('viewerPrev').disabled).toBe(false);
    expect(page.activeElement()).toBe(next);
  });

  it('captions the photo with its title, each alt text under its language code, and describes the image in English first', async () => {
    const page = loadPage();
    await showLibrary(page, [
      { ...item('a'), title: 'Sea lion asleep', alt: { de: 'Ein Seelöwe schläft', en: 'A sea lion sleeps' } },
      { ...item('library/2025/IMG_0042'), title: '', alt: { de: 'Nur Deutsch', en: '' } },
      item('c'),
    ]);
    openFromTile(page, 0);
    const alts = (): (string | undefined)[][] => page.el('viewerAlts').children.map((row) =>
      [row.children[0]?.textContent, row.children[1]?.textContent, row.children[1]?.lang]);
    const image = (): string[][] => stageImages(page).map((node) => [node.alt, node.lang]);
    expect(page.el('viewerTitle').className).toBe('media-viewer__title');
    expect(alts()).toEqual([['DE', 'Ein Seelöwe schläft', 'de'], ['EN', 'A sea lion sleeps', 'en']]);
    expect(page.el('viewerAlts').hidden).toBe(false);
    expect(image()).toEqual([['A sea lion sleeps', 'en']]);

    page.el('viewerNext').click();
    // An untitled photo goes by its file name, set back — never by its path.
    expect(page.el('viewerTitle').textContent).toBe('IMG_0042');
    expect(page.el('viewerTitle').className).toBe('media-viewer__title is-filename');
    expect(page.el('viewerLive').textContent).toBe('Photo 2 of 3: IMG_0042');
    expect(alts()).toEqual([['DE', 'Nur Deutsch', 'de']]);
    expect(image()).toEqual([['Nur Deutsch', 'de']]);

    page.el('viewerNext').click();
    // No alt text in either language: no list, and an image that claims no description.
    expect(alts()).toEqual([]);
    expect(page.el('viewerAlts').hidden).toBe(true);
    expect(image()).toEqual([['', '']]);
  });

  it.each<[string, Partial<Item>, string]>([
    ['still encoding', { status: 'processing', thumbSrc: '', fullSrc: null }, 'processing'],
    ['failed', { status: 'failed', error: 'decode_failed', thumbSrc: '', fullSrc: null }, 'failed: decode_failed'],
    ['missing on disk', { status: 'missing', fullSrc: null }, 'file missing'],
    ['ready without a variant to show', { fullSrc: null, width: 0 }, 'No preview'],
  ])('says in words why a photo that is %s has no image', async (_label, state, words) => {
    const page = loadPage();
    await showLibrary(page, [{ ...item('a'), ...state }]);
    openFromTile(page, 0);
    expect(stageImages(page)).toEqual([]);
    expect(stageNote(page)).toBe(words);
  });

  it('replaces an image that fails to load with a sentence, never a broken image', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b')]);
    openFromTile(page, 0);
    const failed = stageImages(page)[0]!;
    failed.dispatch('error');
    expect(stageImages(page)).toEqual([]);
    expect(stageNote(page)).toBe('This version could not be loaded.');
    expect(page.el('viewerLive').textContent).toBe('This version could not be loaded.');
    // A render behind the viewer does not quietly try again …
    await relist(page, [item('a'), item('b')]);
    expect(stageNote(page)).toBe('This version could not be loaded.');
    // … and a failure that arrives after stepping on belongs to the photo that left.
    page.el('viewerNext').click();
    failed.dispatch('error');
    expect(stageImages(page).map((image) => image.src)).toEqual(['https://img.example/b-10.webp']);
    expect(page.el('viewerLive').textContent).toBe('Photo 2 of 2: b');
  });

  it('shows a photo that finishes encoding while it is on the stage', async () => {
    const page = loadPage();
    await showLibrary(page, [processing('a'), item('b')]);
    openFromTile(page, 0);
    expect(stageNote(page)).toBe('processing');
    page.rows.set('a', item('a'));
    await runPoll(page);
    expect(stageImages(page).map((image) => image.src)).toEqual(['https://img.example/a-10.webp']);
    expect(stageNote(page)).toBe('');
    expect(viewer(page).open).toBe(true);
    expect(page.activeElement()).toBe(page.el('viewerClose'));
  });

  it('follows the page through a background reload, and keeps a photo on screen that left the page', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b'), item('c')]);
    openFromTile(page, 1);
    const shown = stageImages(page)[0]!;
    // An upload finishes behind the open viewer: the page reloads with one more photo in front.
    page.el('dropZone').dispatch('drop', { dataTransfer: { files: [{ name: 'new.jpg' }] } });
    page.uploadRequests[0]!.resolve({ key: 'new', status: 'ready' });
    await page.flush();
    runTimers(page.timers);
    page.listRequests.shift()!.resolve({ items: [item('new'), item('a'), item('b')], total: 4 });
    await page.flush();
    expect(page.el('viewerPosition').textContent).toBe('Photo 3 of 3 on this page');
    expect(ends(page)).toEqual(['false', 'true']);
    // The same element: an unchanged photo is not loaded again.
    expect(stageImages(page)[0]).toBe(shown);

    // The photo is deleted elsewhere and the next reload no longer lists it.
    await relist(page, [item('new'), item('a')]);
    expect(viewer(page).open).toBe(true);
    expect(page.el('viewerTitle').textContent).toBe('b');
    expect(stageImages(page)[0]).toBe(shown);
    expect(page.el('viewerPosition').hidden).toBe(true);
    expect(ends(page)).toEqual(['true', 'true']);
    press(viewer(page), 'ArrowLeft');
    page.el('viewerNext').click();
    expect(page.el('viewerTitle').textContent).toBe('b');
    // Close still works; with the opener's tile gone and no details open, the grid's first tile takes focus.
    page.el('viewerClose').click();
    expect(viewer(page).open).toBe(false);
    expect(page.activeElement()).toBe(tiles(page)[0]);
  });

  it('returns focus to the opener tile after the grid was rebuilt behind it, by Escape as by Close', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b')]);
    openFromTile(page, 1);
    const before = tiles(page)[1]!;
    await relist(page, [item('a'), item('b')]);
    // Escape: the dialog's native cancel closes it.
    viewer(page).close();
    expect(tiles(page)[1]).not.toBe(before);
    expect(page.activeElement()).toBe(tiles(page)[1]);
    // The stage lets go of the large image.
    expect(page.el('viewerStage').children).toEqual([]);

    openFromTile(page, 0);
    page.el('viewerNext').click();
    page.el('viewerClose').click();
    // Back to where it was opened from, not to the photo it was left on.
    expect(page.activeElement()).toBe(tiles(page)[0]);
  });

  it('returns focus to View fullscreen after the panel was rebuilt, and to the tile once the panel shows another photo', async () => {
    const page = loadPage();
    await showLibrary(page, [processing('a'), item('b')]);
    tiles(page)[0]!.click();
    const before = page.el('dViewer');
    before.focus();
    before.click();
    expect(stageNote(page)).toBe('processing');
    // The poll rebuilds the clean panel behind the viewer.
    page.rows.set('a', item('a'));
    await runPoll(page);
    expect(page.el('dViewer')).not.toBe(before);
    page.el('viewerClose').click();
    expect(page.activeElement()).toBe(page.el('dViewer'));

    // Not reachable behind a modal; pins the order of the fallback chain.
    page.el('dViewer').click();
    tiles(page)[1]!.click();
    expect(page.el('detail').dataset.key).toBe('b');
    viewer(page).close();
    expect(page.activeElement()).toBe(tiles(page)[0]);
  });

  it('falls back to the open details, then to the empty state\'s upload action, when the opener is gone', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b')]);
    tiles(page)[0]!.click();
    openFromTile(page, 1);
    await relist(page, [item('a')]);
    viewer(page).close();
    expect(page.activeElement()).toBe(page.el('detail'));

    openFromTile(page, 0);
    await relist(page, []);
    viewer(page).close();
    expect(page.el('detail').hidden).toBe(true);
    expect(page.activeElement()).toBe(page.el('emptyChoosePhotos'));
  });

  it('never changes the selection, the open details or unsaved edits', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a'), item('b'), item('c')]);
    tiles(page)[0]!.click();
    tiles(page)[2]!.dispatch('click', { ctrlKey: true });
    page.el('dAltDe').value = 'Typed before looking';
    page.el('detail').dispatch('input');
    const selected = (): (string | undefined)[] => page.el('grid').querySelectorAll('.is-selected').map((cell) => cell.dataset.key);
    expect(selected()).toEqual(['a', 'c']);

    openFromTile(page, 1);
    page.el('viewerNext').click();
    press(viewer(page), 'ArrowLeft');
    page.el('viewerClose').click();

    expect(selected()).toEqual(['a', 'c']);
    expect(page.el('selCount').textContent).toBe('2 selected');
    expect(page.el('detail').dataset.key).toBe('c');
    expect(page.el('dAltDe').value).toBe('Typed before looking');
    expect(page.el('dUnsaved').hidden).toBe(false);
    expect(page.confirms).toEqual([]);
    expect(page.patches).toEqual([]);
    expect(page.activeElement()).toBe(tiles(page)[1]);
  });

  it('lists the F shortcut with the other hints while no photo is selected', async () => {
    const page = loadPage();
    await showLibrary(page, [item('a')]);
    expect(page.el('mediaSelectionHelp').querySelectorAll('li').map((hint) => hint.textContent))
      .toContain('F opens the focused photo fullscreen.');
  });

  it('takes every label from the dictionary of the page language', async () => {
    const page = loadPage({ locale: 'de' });
    await showLibrary(page, [{ ...item('a'), exif: { ...NO_EXIF, focalLength: 4.3, focalLength35mm: 24 } }, item('b')]);
    expect(page.el('mediaSelectionHelp').textContent).toContain(ui.de['editor.chrome.mediaViewerShortcut']);
    tiles(page)[0]!.click();
    await page.flush();
    expect(page.el('dViewer').textContent).toBe(ui.de['editor.chrome.mediaViewFullscreen']);
    expect(page.el('detail').querySelectorAll('dt').map((term) => term.textContent)).toContain(ui.de['editor.chrome.mediaExposure']);
    expect(page.el('detail').querySelectorAll('dd').map((value) => value.textContent)).toContain('4.3 mm (24 mm KB-äquiv.)');
    expect(page.el('dVersionsLabel').textContent).toBe(ui.de['editor.chrome.mediaVersions']);
    expect(page.el('dVersions').textContent).toBe(ui.de['editor.chrome.mediaVersionsEmpty']);

    page.el('dViewer').click();
    expect(['viewerPrev', 'viewerNext', 'viewerClose'].map((id) => page.el(id).textContent)).toEqual(['Zurück', 'Weiter', 'Schließen']);
    expect([page.el('viewerPrev').title, page.el('viewerNext').title]).toEqual(['Vorheriges Foto (←)', 'Nächstes Foto (→)']);
    expect(page.el('viewerAlts').getAttribute('aria-label')).toBe(ui.de['editor.chrome.mediaViewerAltLabel']);
    expect(page.el('viewerPosition').textContent).toBe('Foto 1 von 2 auf dieser Seite');
    page.el('viewerNext').click();
    expect(page.el('viewerLive').textContent).toBe('Foto 2 von 2: b');
  });
});

describe('media viewer markup and stylesheet (#570)', () => {
  const css = readFileSync('public/admin.css', 'utf8');
  const viewerCss = css.slice(css.indexOf('media library: fullscreen viewer'), css.indexOf('Recovery and connectivity notices'));

  it('is a native dialog named by its caption title, with a polite live region and no disabled step control', () => {
    expect(markup).toContain('<dialog id="mediaViewer" class="media-viewer" aria-labelledby="viewerTitle">');
    expect(markup).toContain('<h2 id="viewerTitle" class="media-viewer__title"></h2>');
    expect(markup).toContain('<p id="viewerLive" class="visually-hidden" role="status"></p>');
    expect(markup).not.toMatch(/id="viewer(Prev|Next|Close)"[^>]*\sdisabled/);
  });

  it('sets the caption on an opaque navy plate: no gradient, no blur', () => {
    expect(viewerCss).toMatch(/\.media-viewer__plate \{[^}]*background: var\(--navy\);/);
    expect(viewerCss).not.toMatch(/gradient|backdrop-filter|blur\(/);
  });

  it('draws the focus ring in white, where the studio accent would be 1.9:1', () => {
    expect(viewerCss).toContain('.media-viewer :focus-visible { outline: 2px solid #fff; outline-offset: 2px; }');
  });

  it('moves only for visitors who have not asked for reduced motion', () => {
    const [still = '', moving = ''] = viewerCss.split('@media (prefers-reduced-motion: no-preference)');
    expect(still).not.toMatch(/\banimation:|\btransition: (?!none)/);
    expect(moving).toContain('animation: media-viewer-in');
  });

  it('drops the panel\'s storage-key style and keeps the global one the AI dialog uses', () => {
    expect(css).not.toContain('.media-detail .media-key');
    expect(css).toMatch(/^\.media-key \{/m);
  });
});
