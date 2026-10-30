import { describe, expect, it, vi } from 'vitest';
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
const aiSrc = readFileSync('public/media-ai.js', 'utf8');
const dialogSrc = readFileSync('public/media-ai-dialog.js', 'utf8');
const browserSrc = readFileSync('public/media-browser.js', 'utf8');
const impactSrc = readFileSync('public/media-impact.js', 'utf8');
const refreshSrc = readFileSync('public/publication-refresh.js', 'utf8');
const markup = readFileSync('public/media.html', 'utf8');
const pageIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
const checkedIds = new Set([...markup.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*\bchecked\b/g)].map((m) => m[1]!));

type Listener = (ev: Record<string, unknown>) => void;

class FakeNode {
  id = '';
  className = '';
  href = '';
  private text = '';
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
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
  listeners: Record<string, Listener[]> = {};
  constructor(public tagName: string, private onFocus?: (node: FakeNode) => void) {}
  get innerHTML(): string { return ''; }
  set innerHTML(v: string) { if (v === '') this.children = []; }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { this.children.push(c); return c; }
  append(...nodes: FakeNode[]): void { nodes.forEach(node => this.appendChild(node)); }
  contains(node: FakeNode | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  adjacent: FakeNode[] = [];
  insertAdjacentElement(_position: string, node: FakeNode): FakeNode { this.adjacent.push(node); return node; }
  remove(): void {}
  focused = false;
  focus(): void { this.focused = true; this.onFocus?.(this); }
  click(): void { this.dispatch('click'); }
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
      for (const c of n.children) {
        if (sel.startsWith('.') ? c.className.split(' ').includes(cls) : c.tagName.toLowerCase() === sel.toLowerCase()) out.push(c);
        walk(c);
      }
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
  impact?: MediaImpact;
  livePending?: ChangedDescriptions | null;
  changedDescriptions?: ChangedDescriptions;
  usedIn?: { kind: string; key: string; title: string }[];
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
/** The model seam: receives the thumbnail URL the page chose and the request's signal. */
type Describe = (url: string, signal: AbortSignal) => Promise<Details>;

/** The loaded page: the DOM stub plus everything the page sent over the wire. */
interface Page {
  el(id: string): FakeNode;
  activeElement(): FakeNode | null;
  /** The page's global object, for replacing a module's function after load. */
  win: Record<string, unknown>;
  timers: { fn: () => void; cleared: boolean; ms: number }[];
  listRequests: Deferred[];
  patches: { url: string; body: Record<string, unknown> }[];
  rows: Map<string, Item>;
  described: string[];
  confirms: string[];
  confirmAnswer: { value: boolean };
  flush(): Promise<void>;
  focus(): void;
  visibility(hidden: boolean): void;
}

function loadPage(opts: { describe?: Describe; isAdmin?: boolean; locale?: 'de' | 'en'; prompt?: string; xhr?: new () => object;
  request?: (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined } = {}): Page {
  const roots = new Map<string, FakeNode>();
  let activeElement: FakeNode | null = null;
  const createElement = (tag: string): FakeNode => new FakeNode(tag, node => { activeElement = node; });
  for (const id of pageIds) {
    const n = createElement('div');
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
  const timers: { fn: () => void; cleared: boolean; ms: number }[] = [];
  const windowEvents = new FakeNode('window');
  const documentEvents = new FakeNode('document');
  const listRequests: Deferred[] = [];
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  const rows = new Map<string, Item>();
  const described: string[] = [];
  const confirms: string[] = [];
  const confirmAnswer = { value: false };
  const ok = (body: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => body });
  const fetch = (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const override = opts.request?.(url, init);
    if (override) return override;
    if (url === '/auth/me') return ok({ authenticated: true, userId: '11111111-1111-4111-8111-111111111111', username: 'simon', isAdmin: opts.isAdmin ?? true });
    if (url.startsWith('/media/folders')) return ok([]);
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
      hidden: false,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener() {},
      documentElement: { lang: opts.locale ?? 'en' },
      get activeElement() { return activeElement; },
      getElementById,
      createElement,
      createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { textContent: text }),
    },
    location: { href: '', origin: 'https://app.example', protocol: 'https:' },
    fetch,
    URL, AbortController, AbortSignal,
    crypto: webcrypto,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, cleared: false, ms }); return timers.length; },
    clearTimeout: (id: number) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    confirm: (msg: string) => { confirms.push(msg); return confirmAnswer.value; },
    prompt: () => opts.prompt ?? null,
    console,
    FormData: class { append() {} },
    XMLHttpRequest: opts.xhr ?? class {},
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
  vm.runInContext(apiSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  vm.runInContext(dialogSrc, ctx);
  vm.runInContext(refreshSrc, ctx);
  vm.runInContext(impactSrc, ctx);
  vm.runInContext(browserSrc, ctx);
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await setImmediate(); };
  return { el, activeElement: () => activeElement, win: ctx, timers, listRequests, patches, rows, described, confirms, confirmAnswer, flush,
    focus: () => windowEvents.dispatch('focus'),
    visibility: (hidden) => {
      const document = ctx.document;
      if (!document || typeof document !== 'object') throw new Error('missing document');
      Reflect.set(document, 'hidden', hidden);
      documentEvents.dispatch('visibilitychange');
    } };
}

function runTimers(timers: { fn: () => void; cleared: boolean }[]): void {
  const due = timers.filter((t) => !t.cleared);
  timers.length = 0;
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
      if (url === '/media/items/a') return pending.promise;
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
      if (url === '/media/items/a') {
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
      if (url === '/media/items/a') { reads++; return reads === 1 ? response(200, item('a')) : pending.promise; }
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
        if (url === '/media/items/a') { reads++; return response(200, item('a')); }
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
    const choose = (key: string) => page.el('grid').querySelectorAll('.media-cell')
      .find(cell => cell.dataset.key === key)!.dispatch('click');
    change(page, 'dTitle', 'Submitted');
    page.el('dSave').click(); await page.flush();
    page.confirmAnswer.value = true;
    choose('b'); choose('a');
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
    const choose = (key: string) => page.el('grid').querySelectorAll('.media-cell')
      .find(cell => cell.dataset.key === key)!.dispatch('click');
    change(page, 'dTitle', 'Discarded submission');
    page.el('dSave').click(); await page.flush();
    page.confirmAnswer.value = true;
    choose('b'); choose('a');
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
      if (url === '/media/items/a') {
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
      if (url === '/media/items/a') { reads++; return response(current); }
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
      if (url === '/media/items/a') { reads++; return response({}); }
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
      if (url !== '/media/items/a' || init?.method === 'PATCH') return;
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
      if (url !== '/media/items/a') return;
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
        if (url !== '/media/items/a') return;
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
      if (url !== '/media/items/a' || init?.method === 'PATCH') return;
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
      if (url !== '/media/items/a') return;
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
    else expect(page.el('out').textContent).toContain('Photo details saved.');
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
    expect(page.el('out').textContent).toContain('Photo details saved.');
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
