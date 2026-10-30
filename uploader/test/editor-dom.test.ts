import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { MAX_SLUG_BYTES, isSafeSlug, assertNotStale, memoryPostStore, PostError, type PostPair } from '../src/posts.js';
import type { EditorialReviewResult } from '../src/editorial-review.js';
import { editorDocument, EditorElement, EditorEvent } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
import { normalizeGalleryFences } from '../src/body-content.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { readCaptionOverride, readCaptionsVisible } from '../../site/src/lib/gallery-layout.js';
import { REGIONS } from '../src/db.js';
import type { AltAudit } from '../src/alt-audit.js';
import { publishTokens } from './publish-tokens.js';


beforeAll(async () => { await analyzeGallerySource(''); });
// editor.html's inline script is plain top-level browser code. Run it in a vm
// context whose `document.getElementById` answers from the REAL markup's ids —
// null for anything the page does not contain — so populateForm()/buildPayload()
// are exercised against the elements that actually exist. Source-text substring
// checks let #105 through (an input was removed while the JS still read it);
// this is the only kind of test that catches a script/markup drift.
const html = readFileSync('public/editor.html', 'utf8');
const scriptStart = html.lastIndexOf('<script>');
const script = html.slice(html.indexOf("'use strict'", scriptStart), html.lastIndexOf('</script>'));
const markup = html.slice(0, scriptStart);

type Element = EditorElement;

interface ReviewStory {
  locale: 'de' | 'en';
  title: string;
  excerpt: string;
  markdown: string;
  heroAlt: string;
  heroSrc: string;
}

type Review = (baseUrl: string, model: string, prompt: string, story: ReviewStory, apiKey: string | null, timeoutMs: number, signal: AbortSignal) => Promise<EditorialReviewResult>;
type Fetch = (url: string, options?: RequestInit) => Promise<Response>;

interface EditorOptions {
  fetch?: Fetch;
  galleryFetch?: Fetch;
  review?: Review;
  isAdmin?: boolean;
  mobile?: boolean;
  search?: string;
  /** One answer for every AdminConfirm prompt, or an answer per prompt. */
  confirm?: boolean | ((prompt: ConfirmPrompt) => boolean);
  publishVersion?: () => string | null;
  stash?: { key: string; payload: unknown };
  pickImage?: { src: string; width: number; height: number; alt: { de: string; en: string }; format?: 'jpeg' };
  caption?: (options: { url: string; lang: string; signal: AbortSignal }) => Promise<string>;
}
interface ConfirmPrompt { title: string; body: string; confirmLabel?: string }
/** What editor.html passes to MediaPicker.open for a gallery, as far as these tests read it. */
interface GalleryPicker {
  multiple: true;
  captions?: { locale: 'de' | 'en'; visible: boolean; overrides: Record<string, string>; fallback: Record<string, string> };
  onPick(items: unknown[], options: { layout: string | null; captions?: { visible: boolean; overrides: Record<string, string> } }): Promise<void>;
}
type PickerSettings = GalleryPicker | { multiple?: false; onPick?: (item: EditorOptions['pickImage']) => void };
interface EditorApi {
  populateForm(post: unknown): void;
  loadPost(translationKey: string): Promise<boolean>;
  doSaveDraft(): Promise<boolean>;
  renderAltAudit(audit: AltAudit | null, published: boolean): void;
  // No `status`/`scheduledAt`: the store decides status and nothing consumes
  // scheduled_at, so the editor sends neither (#121).
  buildPayload(): Omit<PostPair, 'status'> & { updatedAt?: string };
}


function loadEditor(options: EditorOptions = {}) {
  const dom = editorDocument(markup);
  let dirty = 0;
  let redirects = 0;
  let mediaChanged: (() => void) | undefined;
  const media = {
    matches: options.mobile === true,
    addEventListener(_type: string, listener: () => void) { mediaChanged = listener; },
  };
  const requests: { url: string; options: RequestInit }[] = [];
  const galleryRequests: { url: string; options: RequestInit }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const prompts: ConfirmPrompt[] = [];
  const galleryPickers: GalleryPicker[] = [];
  const el = (id: string): Element => {
    const element = dom.document.getElementById(id);
    if (!element) throw new Error('no element #' + id + ' in editor.html');
    return element;
  };
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string): string | null => m.get(k) ?? null,
      setItem: (k: string, v: string): void => { m.set(k, String(v)); },
      get length() { return m.size; },
      key: (index: number): string | null => [...m.keys()][index] ?? null,
      removeItem: (k: string): void => { m.delete(k); },
    };
  };
  const local = storage();
  if (options.stash) local.setItem(options.stash.key, JSON.stringify({
    savedAt: '2026-10-01T12:00:00Z', payload: options.stash.payload,
  }));
  class EasyMDE {
    private text = '';
    private readonly changes: (() => void)[] = [];
    private readonly markers = new Set<{ start: number; end: number; cleared: boolean }>();
    private documentVersion = 0;
    readonly undoHistory: string[] = [];
    input = dom.document.createElement('textarea');
    cursor: { line: number; ch: number } | null = null;
    selection: { from: { line: number; ch: number }; to: { line: number; ch: number } } | null = null;
    focusCalls = 0;
    codemirror = {
      getCursor: () => this.cursor ?? { line: 0, ch: 0 },
      undo: () => {
        const previous = this.undoHistory.pop();
        if (previous !== undefined) {
          this.text = previous;
          for (const callback of this.changes) callback();
        }
      },
      on: (event: string, callback: () => void) => { if (event === 'change' || event === 'changes') this.changes.push(callback); },
      refresh() {},
      getValue: () => this.text,
      setValue: (value: string) => { this.value(value); },
      getInputField: () => this.input,
      setCursor: (position: { line: number; ch: number }) => { this.cursor = position; },
      setSelection: (from: { line: number; ch: number }, to: { line: number; ch: number }) => { this.selection = { from, to }; },
      scrollIntoView() {},
      focus: () => { this.focusCalls += 1; this.input.focus(); },
      operation: (callback: () => void) => callback(),
      posFromIndex: (index: number) => {
        const lines = this.text.slice(0, index).split('\n');
        return { line: lines.length - 1, ch: lines.at(-1)!.length };
      },
      indexFromPos: (pos: { line: number; ch: number }): number =>
        this.text.split('\n').slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch,
      getRange: (from: { line: number; ch: number }, to: { line: number; ch: number }): string =>
        this.text.slice(this.codemirror.indexFromPos(from), this.codemirror.indexFromPos(to)),
      markText: (from: { line: number; ch: number }, to: { line: number; ch: number }) => {
        const marker = { start: this.codemirror.indexFromPos(from), end: this.codemirror.indexFromPos(to), cleared: false };
        this.markers.add(marker);
        return {
          find: () => marker.cleared ? undefined : { from: this.codemirror.posFromIndex(marker.start), to: this.codemirror.posFromIndex(marker.end) },
          clear: () => { marker.cleared = true; this.markers.delete(marker); },
        };
      },
      addLineWidget: (_line: number, node: Element) => {
        const version = this.documentVersion;
        this.input.parentElement!.appendChild(node);
        let cleared = false;
        return {
          clear: () => { cleared = true; node.remove(); },
          changed: () => {
            if (cleared || version !== this.documentVersion) throw new Error('remeasured a detached widget');
          },
        };
      },
      replaceRange: (value: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
        const start = this.codemirror.indexFromPos(from);
        const end = this.codemirror.indexFromPos(to);
        this.undoHistory.push(this.text);
        this.text = this.text.slice(0, start) + value + this.text.slice(end);
        const delta = value.length - (end - start);
        for (const marker of this.markers) {
          if (end <= marker.start) { marker.start += delta; marker.end += delta; }
          else if (start > marker.start && end < marker.end) marker.end += delta;
          else if (start < marker.end && end > marker.start) marker.cleared = true;
        }
        for (const callback of this.changes) callback();
      },
    };
    value(value?: string): string {
      if (value !== undefined) {
        this.documentVersion += 1;
        for (const marker of this.markers) marker.cleared = true;
        this.text = value;
        for (const callback of this.changes) callback();
      }
      return this.text;
    }
    toTextArea() {}
  }
  const editors: EasyMDE[] = [];
  const ctx: Record<string, unknown> = {
    document: dom.document,
    location: { search: options.search ?? '', pathname: '/admin/editor.html', href: 'http://localhost/admin/editor.html' + (options.search ?? ''), origin: 'http://localhost' },
    history: { replaceState() {} },
    sessionStorage: storage(),
    localStorage: local,
    fetch: async (url: string, init: RequestInit = {}) => {
      if (String(url) === '/gallery/analyze') {
        galleryRequests.push({ url: String(url), options: init });
        if (options.galleryFetch) return options.galleryFetch(String(url), init);
        const { bodyMarkdown } = JSON.parse(String(init.body)) as { bodyMarkdown: string };
        return response(await analyzeGallerySource(bodyMarkdown));
      }
      requests.push({ url: String(url), options: init });
      return options.fetch?.(String(url), init) ?? Promise.reject(new Error('no network in test'));
    },
    // Advance only the gallery debounce at the next microtask; deadline and
    // draft-backup timers remain controlled as in the original harness.
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      if (delay === 250) {
        timers.set(id, callback);
        queueMicrotask(() => { const run = timers.get(id); timers.delete(id); run?.(); });
      }
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval() {},
    addEventListener: dom.document.addEventListener,
    URLSearchParams,
    URL,
    AbortController,
    structuredClone,
    Event: EditorEvent,
    KeyboardEvent: EditorEvent,
    console,
    alert() {},
    confirm: () => false,
    navigator: {},
    matchMedia: () => media,
    EasyMDE: class extends EasyMDE {
      constructor(settings: { element: Element }) {
        super();
        settings.element.parentElement!.appendChild(this.input);
        editors.push(this);
      }
    },
    Auth: { ensureAuthed: async () => options.isAdmin === undefined ? null : { isAdmin: options.isAdmin }, renderHeader() {} },
    AdminConfirm: {
      ask: async (prompt: ConfirmPrompt) => {
        prompts.push(prompt);
        return typeof options.confirm === 'function' ? options.confirm(prompt) : options.confirm === true;
      },
      liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '',
    },
    MediaPicker: { open(settings: PickerSettings) {
      // A gallery picker is kept for the test to drive; a single-photo picker
      // answers with `pickImage` at once, as it always has.
      if (settings.multiple === true) galleryPickers.push(settings);
      else if (options.pickImage) settings.onPick?.(options.pickImage);
    } },
    WaypointCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.waypoint.'))
        .map(([key, value]) => [key.slice('editor.waypoint.'.length), value])),
    ])),
    EditorImageCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.titleImage.'))
        .map(([key, value]) => [key.slice('editor.titleImage.'.length), value])),
    ])),
    EditorGalleryCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.gallery.'))
        .map(([key, value]) => [key.slice('editor.gallery.'.length), value])),
    ])),
    EditorCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.chrome.'))
        .map(([key, value]) => [key.slice('editor.chrome.'.length), value])),
    ])),
    GpxCopy: { en: new Proxy({}, { get: (_target, key) => String(key) }) },
    GpxMap: { create: async () => ({ render() {}, destroy() {}, resize() {} }) },
    GpxEditor: { wire: () => ({ refresh: async () => {}, publishVersion: options.publishVersion ?? (() => null), publishError: () => null, noteCreated() {}, hasPreview: () => false, discard() {}, revisionNotice() {}, guardAction: () => true }) },
    EditorGalleryImageOrigin: 'https://img',
    AltSuggest: { wire() {}, suggestHosted: options.caption ?? (() => Promise.reject(new Error('no model in test'))) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync('public/draft-guard.js', 'utf8'), ctx, { filename: 'draft-guard.js' });
  const safety = ctx.DraftGuard as {
    createDraftGuard(options: { storageKey: string; collect: () => unknown; onChange?: (dirty: boolean) => void }): {
      markDirty(): void; redirectToLogin(): void;
    };
  };
  const createGuard = safety.createDraftGuard;
  safety.createDraftGuard = (settings) => {
    const guard = createGuard(settings);
    const markDirty = guard.markDirty;
    const redirect = guard.redirectToLogin;
    guard.markDirty = () => { dirty += 1; markDirty(); };
    guard.redirectToLogin = () => { redirects += 1; redirect(); };
    return guard;
  };
  for (const file of ['waypoint-lookup.js', 'posts-filter.js', 'editor-title-image.js', 'gallery-fence.js', 'media-api.js', 'gallery-library.js', 'editor-galleries.js', 'editor-linter.js', 'llm.js', 'editor-excerpt.js', 'country-centers.js', 'country-coordinates.js', 'tabs.js', 'editor-review.js', 'editor-inspector.js']) {
    vm.runInContext(readFileSync('public/' + file, 'utf8'), ctx, {
      filename: resolve('public/' + file),
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
  }
  if (options.review) (ctx.LLM as { reviewStory: Review }).reviewStory = options.review;
  vm.runInContext(script, ctx);
  const api = vm.runInContext('({ populateForm, buildPayload, loadPost, doSaveDraft, renderAltAudit })', ctx) as EditorApi;
  return {
    api, el, editors, created: dom.created, document: dom.document, requests, galleryRequests, prompts, local, galleryPickers,
    flushDialogEvents: dom.flushDialogEvents,
    setMobile(mobile: boolean) { media.matches = mobile; mediaChanged?.(); },
    dirtyCalls: () => dirty, redirects: () => redirects,
  };
}

function fullPair(): PostPair {
  const loc = (locale: 'de' | 'en', slug: string, title: string, country: string) => ({
    locale, slug, title, excerpt: 'x', country,
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    bodyMarkdown: '## Hi', images: {}, keyFacts: { Dauer: '4 Tage' },
  });
  return {
    translationKey: 'tk1', status: 'draft',
    shared: {
      date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 },
      stops: [{ name: 'Bukarest', lat: 44.4, lng: 26.1 }], route: 'Bukarest – Brașov',
      categories: ['City', 'Culture'], tags: ['balkan', 'autumn'],
    },
    de: loc('de', 'bukarest', 'Bukarest', 'Rumänien'),
    en: loc('en', 'bucharest', 'Bucharest', 'Romania'),
  };
}

// What DraftGuard actually stashes: buildPayload() deletes every empty/undefined
// key, so a restore payload for a blank form carries no shared fields at all.
type StashPayload = Omit<PostPair, 'shared' | 'de' | 'en'> & {
  shared: Partial<PostPair['shared']>;
  de: Omit<PostPair['de'], 'heroImage'>;
  en: Omit<PostPair['en'], 'heroImage'>;
};

function minimalPair(): StashPayload {
  const loc = (locale: 'de' | 'en') => ({ locale, slug: 'x', title: 'X', excerpt: '', country: '', bodyMarkdown: '', images: {} });
  return { translationKey: 'tk1', status: 'draft', shared: {}, de: loc('de'), en: loc('en') };
}

describe('unpublish concurrency token in the real editor', () => {
  it.each(['none', 'before', 'after'] as const)('preserves version ownership (other writer: %s)', async (otherWriter) => {
    const posts = memoryPostStore();
    await posts.upsertDraft(fullPair());
    await posts.publish('tk1', await publishTokens(posts, 'tk1'));
    let unpublishToken: string | undefined;
    const h = loadEditor({ confirm: true, fetch: async (url, options) => {
      if (url === '/posts/tk1/unpublish') {
        const committed = await posts.unpublish('tk1');
        unpublishToken = committed.updatedAt.toISOString();
        if (otherWriter === 'after') {
          const pair = (await posts.get('tk1'))!;
          await posts.upsertDraft({ ...pair, de: { ...pair.de, title: 'Another tab' } }, pair.updatedAt);
        }
        return response({ unpublished: true, ...committed, build: { ok: true } });
      }
      if (url === '/posts/tk1' && options?.method === 'PUT') {
        const payload = JSON.parse(String(options.body)) as PostPair & { updatedAt: string };
        try {
          return response(await posts.upsertDraft(payload, new Date(payload.updatedAt)));
        } catch (error) {
          if (error instanceof PostError) return response({ error: error.message, code: error.code }, 409);
          throw error;
        }
      }
      return response(url === '/posts/tk1' ? await posts.get('tk1') : []);
    } });
    expect(await h.api.loadPost('tk1')).toBe(true);
    const loadedToken = h.api.buildPayload().updatedAt;
    if (otherWriter === 'before') {
      const pair = (await posts.get('tk1'))!;
      await posts.upsertDraft({ ...pair, de: { ...pair.de, title: 'Another tab' } }, pair.updatedAt);
    }
    h.el('unpublishBtn').click();
    await settle();
    expect(h.api.buildPayload().updatedAt).toBe(otherWriter === 'before' ? loadedToken : unpublishToken);
    h.el('deTitle').value = 'My edit after unpublish';
    h.el('deTitle').fire('input');
    expect(await h.api.doSaveDraft()).toBe(otherWriter === 'none');
    expect(h.prompts).toHaveLength(otherWriter === 'none' ? 1 : 2);
    expect((await posts.get('tk1'))!.de.title).toBe(otherWriter === 'none' ? 'My edit after unpublish' : 'Another tab');
  });

  it('keeps the loaded token and published state when unpublish fails', async () => {
    const post = { ...fullPair(), status: 'published', updatedAt: '2026-10-25T10:00:00.000Z' };
    const h = loadEditor({ confirm: true, fetch: async (url) => {
      if (url === '/posts/tk1/unpublish') return response({
        error: 'storage_read_only', updatedAt: '2026-10-25T11:00:00.000Z',
      }, 503);
      return response(url === '/posts/tk1' ? post : []);
    } });
    await h.api.loadPost('tk1');
    h.el('unpublishBtn').click();
    await settle();
    expect(h.api.buildPayload().updatedAt).toBe(post.updatedAt);
    expect(h.el('slugFieldDe').disabled).toBe(true);
    expect(h.el('unpublishBtn').disabled).toBe(false);
    expect(h.el('actionError').textContent).toContain('storage_read_only');
  });
});

describe('complete bilingual conflict reload', () => {
  it('reloads both locales before using the new token on the next save', async () => {
    let stored = { ...fullPair(), updatedAt: '2026-10-25T10:00:00.000Z' };
    const h = loadEditor({ confirm: true, fetch: async (url, options) => {
      if (url === '/posts/tk1' && options?.method === 'PUT') {
        const payload = JSON.parse(String(options.body));
        if (payload.updatedAt !== stored.updatedAt) return response({ code: 'conflict' }, 409);
        stored = { ...stored, ...payload };
        return response(stored);
      }
      if (url === '/posts/tk1') return response(stored);
      return response([]);
    } });
    await h.api.loadPost('tk1');
    h.el('deTitle').value = 'Local German edit';
    h.el('deTitle').fire('input');
    stored = { ...stored, updatedAt: '2026-10-25T11:00:00.000Z',
      de: { ...stored.de, title: 'New DE', bodyMarkdown: 'New German body' },
      en: { ...stored.en, title: 'New EN must survive', bodyMarkdown: 'New English body must survive' } };
    expect(await h.api.doSaveDraft()).toBe(false); // conflict then explicit Reload
    expect(h.api.buildPayload().updatedAt).toBe(stored.updatedAt);
    expect(h.el('enTitle').value).toBe(stored.en.title);
    expect(await h.api.doSaveDraft()).toBe(true);
    expect(stored.en.bodyMarkdown).toBe('New English body must survive');
  });

  it.each([false, true])('blocks mixed-form saves and retains local edits when population fails (rollback also fails: %s)', async (failRollback) => {
    let stored = { ...fullPair(), updatedAt: '2026-10-25T10:00:00.000Z' };
    const h = loadEditor({ confirm: true, fetch: async (url, options) => {
      if (options?.method === 'PUT') return response({ code: 'conflict' }, 409);
      return response(url === '/posts/tk1' ? stored : []);
    } });
    await h.api.loadPost('tk1');
    h.el('deTitle').value = 'Recover my unsaved DE title';
    h.el('deTitle').fire('input');
    h.editors[1]!.value('Recover my unsaved English body');
    const local = structuredClone(h.api.buildPayload());
    stored = { ...stored, updatedAt: '2026-10-25T11:00:00.000Z',
      de: { ...stored.de, title: 'New server DE', bodyMarkdown: 'Replacement body' },
      en: { ...stored.en, title: 'New server EN' } };
    const value = h.editors[0]!.value.bind(h.editors[0]);
    h.editors[0]!.value = (text?: string) => {
      const result = value(text); // fail AFTER DE fields/body have changed, before EN
      if (text !== undefined && (failRollback || text === 'Replacement body')) throw new Error('forced population failure');
      return result;
    };
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.api.buildPayload().updatedAt).toBe(local.updatedAt);
    expect(h.el('actionError').textContent).toBe(ui.en['editor.chrome.reloadFailed']);
    expect(h.requests.filter((request) => request.options.method === 'PUT')).toHaveLength(1);
    expect(await h.api.doSaveDraft()).toBe(false);
    h.el('previewBtn').click();
    h.el('publishBtn').click();
    await settle();
    expect(h.requests.filter((request) => request.options.method === 'PUT')).toHaveLength(1);
    const stashes = Array.from({ length: h.local.length }, (_, index) => JSON.parse(h.local.getItem(h.local.key(index)!)!));
    expect(stashes.some((stash) => JSON.stringify(stash.payload) === JSON.stringify(local))).toBe(true);
    if (!failRollback) expect(h.api.buildPayload()).toEqual(local);
    h.editors[0]!.value = value;
    await h.api.loadPost('tk1');
    expect(h.api.buildPayload().updatedAt).toBe(stored.updatedAt);
    expect(h.el('enTitle').value).toBe('New server EN');
    expect(h.el('actionError').hidden).toBe(true);
  });
});

describe('explicit editor publish tokens', () => {
  it.each([null, '11111111-1111-4111-8111-111111111111'])('sends the saved pair token and reviewed route token %s without refreshing', async (routeVersion) => {
    let reviewed = 0;
    const initial = '2026-10-24T09:00:00.000Z';
    const saved = '2026-10-24T09:01:00.000Z';
    const h = loadEditor({
      isAdmin: true, search: '?tk=tk1', confirm: true,
      publishVersion: () => { reviewed++; return routeVersion; },
      fetch: async (url, options) => {
        if (url === '/posts/tk1' && options?.method === 'PUT') return response({ ...fullPair(), updatedAt: saved });
        if (url === '/posts/tk1') return response({ ...fullPair(), updatedAt: initial });
        if (url === '/posts/tk1/publish') return response({ updatedAt: '2026-10-24T09:02:00.000Z', build: { ok: true }, altAudit: { images: [] } });
        if (url.endsWith('/revisions')) return response([]);
        if (url.endsWith('/alt-audit')) return response({ images: [] });
        throw new Error('Unexpected publish request: ' + url);
      },
    });
    for (let i = 0; i < 8; i++) await settle();
    h.el('publishBtn').click();
    for (let i = 0; i < 8; i++) await settle();
    const publish = h.requests.find(({ url }) => url.endsWith('/publish'));
    expect(publish).toBeDefined();
    expect(JSON.parse(String(publish!.options.body))).toEqual({ baseUpdatedAt: saved, baseRouteVersion: routeVersion });
    const save = h.requests.find(({ url, options }) => url === '/posts/tk1' && options.method === 'PUT');
    expect(h.requests.indexOf(save!)).toBeLessThan(h.requests.indexOf(publish!));
    expect(reviewed).toBe(1);
    expect(h.requests.filter(({ url }) => url.endsWith('/route'))).toEqual([]);
  });

  it('does not save or publish when the route state has not loaded', async () => {
    const h = loadEditor({ publishVersion: () => { throw new Error('route not loaded'); } });
    h.api.populateForm(fullPair());
    h.el('publishBtn').click();
    await settle();
    expect(h.requests).toEqual([]);
    expect(h.el('actionError').textContent).toBe('route not loaded');
  });
});

describe('editor.html inline script against its own markup', () => {
  it('returns to the filtered Posts view without relying on the browser referrer', () => {
    const returnTo = '/admin/posts.html?status=draft&country=Ecuador&q=river';
    const h = loadEditor({ search: '?returnTo=' + encodeURIComponent(returnTo) });
    expect(h.el('backToPosts').getAttribute('href')).toBe(returnTo);
  });

  it.each([
    'https://elsewhere.example/admin/posts.html?status=draft',
    '//elsewhere.example/admin/posts.html',
    '/admin/settings.html',
    'javascript:alert(1)',
    'http://[',
    '',
  ])('keeps the Posts fallback for an unsafe or absent return destination: %s', (returnTo) => {
    const h = loadEditor({ search: '?returnTo=' + encodeURIComponent(returnTo) });
    expect(h.el('backToPosts').getAttribute('href')).toBe('/admin/posts.html');
  });
  it('keeps private GPX geometry and import tokens out of ordinary post serialization', () => {
    const { api } = loadEditor();
    api.populateForm(fullPair());
    const payload = api.buildPayload();
    expect(JSON.stringify(payload)).not.toMatch(/\"(?:geometry|importId|baseVersion|selection|waypoints|sourceBytes)\"/);
  });

  it('selects an independent title image, round-trips framing, and clears it on removal or old revision restore', () => {
    const pickImage = { src: 'https://img/banner', width: 2400, height: 800,
      alt: { de: 'Bergpanorama', en: 'Mountain panorama' }, format: 'jpeg' as const };
    const { api, el } = loadEditor({ pickImage });
    const original = fullPair();
    api.populateForm(original);
    el('deTitleImageLibrary').click();
    el('deTitleImageX').value = '72';
    el('deTitleImageY').value = '30';
    el('deTitleImageAlt').value = 'Berge im Morgenlicht';
    const saved = api.buildPayload();
    expect(saved.de.titleImage).toEqual({ src: pickImage.src, width: 2400, height: 800,
      alt: 'Berge im Morgenlicht', format: 'jpeg', focus: { x: 72, y: 30 } });
    expect(saved.de.heroImage).toEqual(original.de.heroImage);
    expect(saved.en.titleImage).toBeUndefined();
    api.populateForm(saved);
    expect(api.buildPayload().de.titleImage).toEqual(saved.de.titleImage);
    el('deTitleImageRemove').click();
    expect(api.buildPayload().de.titleImage).toBeUndefined();
    expect(api.buildPayload().de.heroImage).toEqual(original.de.heroImage);
    api.populateForm(saved);
    api.populateForm(original);
    expect(api.buildPayload().de.titleImage).toBeUndefined();
    expect(el('deTitleImageAlt').value).toBe('');
    expect(el('deTitleImageX').value).toBe('50');
  });

  it('populateForm fills every shared and per-locale field from a full PostPair', () => {
    const { api, el } = loadEditor();
    expect(() => api.populateForm(fullPair())).not.toThrow();
    expect(el('deCountry').value).toBe('Rumänien');
    expect(el('enCountry').value).toBe('Romania');
    expect(el('fmCountryCode').value).toBe('RO');
    expect(el('fmDate').value).toBe('2024-10-03');
    expect(el('fmRegion').value).toBe('europe');
    expect(el('fmCategories').value).toBe('City, Culture');
    expect(el('fmTags').value).toBe('balkan, autumn');
  });


  it('syncs locale inspector visibility without changing either locale values', () => {
    const { api, el } = loadEditor();
    api.populateForm(fullPair());
    const before = api.buildPayload();
    expect(el('editorInspector').querySelector('[data-inspector-locale=\"de\"]')!.hidden).toBe(false);
    expect(el('editorInspector').querySelector('[data-inspector-locale=\"en\"]')!.hidden).toBe(true);
    el('tabbtn-en').click();
    expect(el('editorInspector').querySelector('[data-inspector-locale=\"de\"]')!.hidden).toBe(true);
    expect(el('editorInspector').querySelector('[data-inspector-locale=\"en\"]')!.hidden).toBe(false);
    el('tabbtn-de').click();
    expect(api.buildPayload()).toEqual(before);
  });

  it('collapses the desktop inspector into a rail that keeps its own toggle', () => {
    const { el, document } = loadEditor();
    const panelButton = el('inspectorClose');
    const content = el('inspectorContent');
    expect(el('inspectorToggle').hidden).toBe(true);
    expect(panelButton.getAttribute('aria-expanded')).toBe('true');
    expect(panelButton.getAttribute('aria-label')).toBe('Collapse story details');

    panelButton.focus();
    panelButton.click();
    expect(document.body!.classList.contains('editor-inspector-collapsed')).toBe(true);
    expect(panelButton.getAttribute('aria-expanded')).toBe('false');
    expect(panelButton.getAttribute('aria-label')).toBe('Expand story details');
    expect(content.hasAttribute('inert')).toBe(true);
    expect(content.getAttribute('aria-hidden')).toBe('true');
    expect(el('editorInspector').hasAttribute('inert')).toBe(false);
    expect(el('editorInspector').hasAttribute('aria-hidden')).toBe(false);
    expect(el('inspectorToggle').hidden).toBe(true);
    expect(document.activeElement).toBe(panelButton);

    panelButton.click();
    expect(document.body!.classList.contains('editor-inspector-collapsed')).toBe(false);
    expect(panelButton.getAttribute('aria-expanded')).toBe('true');
    expect(content.hasAttribute('inert')).toBe(false);
    expect(content.hasAttribute('aria-hidden')).toBe(false);
    expect(el('inspectorToggle').hidden).toBe(true);
    expect(document.activeElement).toBe(panelButton);
  });

  it('expands the desktop rail to reveal a missing inspector field', () => {
    const { api, el, document } = loadEditor();
    const pair = fullPair();
    pair.en.country = '';
    api.populateForm(pair);
    el('inspectorClose').click();
    expect(el('inspectorContent').hasAttribute('inert')).toBe(true);

    el('localeChip').querySelectorAll('button')
      .find((button) => button.textContent.startsWith('EN missing country'))!.click();
    expect(document.body!.classList.contains('editor-inspector-collapsed')).toBe(false);
    expect(el('inspectorContent').hasAttribute('inert')).toBe(false);
    expect(el('inspectorClose').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(el('enCountry'));
  });

  it('opens a focus-managed mobile inspector and restores focus when it closes', () => {
    const { el, document } = loadEditor({ mobile: true });
    const toggle = el('inspectorToggle');
    // The drawer opener follows More actions, never precedes it.
    expect(toggle.hidden).toBe(false);
    expect(toggle.parentElement!.children.at(-1)).toBe(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Open story details');
    toggle.focus();
    toggle.click();
    expect(document.body!.classList.contains('editor-inspector-open')).toBe(true);
    expect(el('editorInspector').getAttribute('role')).toBe('dialog');
    expect(el('editorInspector').getAttribute('aria-modal')).toBe('true');
    expect(el('inspectorScrim').hidden).toBe(false);
    expect(el('editorWritingSurface').hasAttribute('inert')).toBe(true);
    expect(el('inspectorClose').getAttribute('aria-label')).toBe('Close story details');
    expect(document.activeElement).toBe(el('inspectorClose'));

    el('taxonomyDetails').open = true;
    el('fmTags').focus();
    el('fmTags').fire('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(el('inspectorClose'));
    el('inspectorClose').fire('keydown', { key: 'Escape' });
    expect(document.body!.classList.contains('editor-inspector-open')).toBe(false);
    expect(el('inspectorScrim').hidden).toBe(true);
    expect(el('editorWritingSurface').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps focus on visible panel controls across desktop and drawer transitions', () => {
    const { el, document, setMobile } = loadEditor({ mobile: true });
    const toggle = el('inspectorToggle');
    const panelButton = el('inspectorClose');
    toggle.focus();
    setMobile(false);
    expect(document.activeElement).toBe(panelButton);
    expect(toggle.hidden).toBe(true);

    panelButton.click();
    setMobile(true);
    expect(document.activeElement).toBe(toggle);
    expect(document.body!.classList.contains('editor-inspector-collapsed')).toBe(false);
    toggle.click();
    expect(document.activeElement).toBe(panelButton);
    expect(el('inspectorContent').hasAttribute('inert')).toBe(false);
    // Back on desktop the remembered rail returns and its toggle keeps focus.
    setMobile(false);
    expect(document.activeElement).toBe(panelButton);
    expect(document.body!.classList.contains('editor-inspector-collapsed')).toBe(true);
    expect(el('inspectorContent').hasAttribute('inert')).toBe(true);
    expect(el('editorInspector').hasAttribute('inert')).toBe(false);

    panelButton.click();
    setMobile(true);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.hidden).toBe(false);
    expect(el('editorInspector').getAttribute('aria-hidden')).toBe('true');
  });

  it('reveals the correct locale and disclosure before focusing a missing inspector field', () => {
    const { api, el, document } = loadEditor({ mobile: true });
    const pair = fullPair();
    pair.en.country = '';
    api.populateForm(pair);
    const jump = el('mobileLocaleChip').querySelectorAll('button')
      .find((button) => button.textContent.startsWith('EN missing country'));
    expect(jump).toBeTruthy();
    el('editorActionsMenu').open = true;
    jump!.click();
    expect(el('editorActionsMenu').open).toBe(false);
    expect(el('tab-en').hidden).toBe(false);
    expect(el('editorInspector').querySelector('[data-inspector-locale="en"]')!.hidden).toBe(false);
    expect(document.body!.classList.contains('editor-inspector-open')).toBe(true);
    expect(document.activeElement).toBe(el('enCountry'));

    el('inspectorClose').click();
    expect(document.activeElement).toBe(el('inspectorToggle'));
    pair.en.country = 'Romania';
    pair.en.heroImage = { src: '', width: 0, height: 0, alt: '' };
    api.populateForm(pair);
    const heroJump = el('mobileLocaleChip').querySelectorAll('button')
      .find((button) => button.textContent.includes('EN missing hero'));
    el('editorActionsMenu').open = true;
    heroJump!.click();
    expect(el('editorActionsMenu').open).toBe(false);
    expect(el('enHeroReplace').open).toBe(true);
    expect(document.activeElement).toBe(el('enHeroFile'));
  });

  it('closes the floating actions menu on an outside click or Escape, not on a click inside it', () => {
    const { el, document } = loadEditor();
    const menu = el('editorActionsMenu');
    const trigger = menu.querySelector('summary')!;
    menu.open = true;
    menu.querySelector('.editor-actions-menu__readiness')!.click();
    expect(menu.open).toBe(true);
    el('editorWritingSurface').click();
    expect(menu.open).toBe(false);

    menu.open = true;
    trigger.fire('keydown', { key: 'Escape' });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the compact hero preview and framing disclosure only for a usable hero', () => {
    const { api, el } = loadEditor();
    api.populateForm(fullPair());
    expect(el('deHeroPreview').hidden).toBe(false);
    expect(el('deHeroFocus').hidden).toBe(false);
    api.populateForm(minimalPair());
    expect(el('deHeroPreview').hidden).toBe(true);
    expect(el('deHeroFocus').hidden).toBe(true);
  });

  it('names the CodeMirror inputs EasyMDE swaps in for the labelled body textareas (SC 4.1.2)', () => {
    const { editors } = loadEditor();
    expect(editors.map((e) => e.input.attrs['aria-label'])).toEqual(['Body (Markdown, DE)', 'Body (Markdown, EN)']);
  });

  it('buildPayload round-trips what populateForm wrote', () => {
    const { api } = loadEditor();
    api.populateForm(fullPair());
    const out = api.buildPayload();
    expect(out.de.country).toBe('Rumänien');
    expect(out.en.country).toBe('Romania');
    expect(out.shared.categories).toEqual(['City', 'Culture']);
    expect(out.shared.tags).toEqual(['balkan', 'autumn']);
    expect(out.shared.countryCode).toBe('RO');
    expect(out.shared.region).toBe('europe');
    expect(out.shared.date).toBe('2024-10-03');
  });

  /**
   * The cover flag is declared in four places across two tsconfigs —
   * `PostShared` here, the `posts.featured` column, the loader's `PostRow` and
   * the Zod schema — and it is optional everywhere, so a checkbox the script
   * never reads (or a payload key the markup has no control for) type-checks
   * perfectly while the author's choice is dropped on save. Only a round-trip
   * through the real markup catches that.
   */
  it('round-trips the homepage-cover checkbox, and sends false when unticked', () => {
    const { api, el } = loadEditor();
    api.populateForm({ ...fullPair(), shared: { ...fullPair().shared, featured: true } });
    expect(el('fmFeatured').checked).toBe(true);
    expect(api.buildPayload().shared.featured).toBe(true);

    // A payload without the key means "not the cover": the box must clear
    // rather than keep the previously loaded post's choice.
    api.populateForm(fullPair());
    expect(el('fmFeatured').checked).toBe(false);
    expect(api.buildPayload().shared.featured).toBe(false);
  });

  // #87's rule: a cover choice is not translatable, so the control belongs in
  // the shared sidebar. Inside a locale tab it would read as a per-locale
  // choice while the server writes one value to both rows. (Its accessible
  // name is covered generically by admin-a11y.test.ts.)
  it('keeps the cover checkbox outside both locale tabs', () => {
    const { el } = loadEditor();
    expect(el('expeditionDetails').contains(el('fmFeatured'))).toBe(true);
    expect(el('tab-de').contains(el('fmFeatured'))).toBe(false);
    expect(el('tab-en').contains(el('fmFeatured'))).toBe(false);
  });

  /**
   * The focal point is declared in THREE places across two tsconfigs —
   * `HeroImage` here, `RemoteHeroImage` in site/src/lib/images.ts, and the Zod
   * schema in site/src/content.config.ts — and it is optional, so a one-sided
   * change type-checks clean while the author's framing is silently dropped on
   * save. Only a round-trip through the real markup catches that.
   */
  it('round-trips a hero focal point, and omits it when centred', () => {
    const { api, el } = loadEditor();
    const pair = fullPair();
    pair.de.heroImage = { ...pair.de.heroImage, focus: { x: 22, y: 18 } };
    api.populateForm(pair);
    expect(Number(el('deHeroFocusX').value)).toBe(22);
    expect(Number(el('deHeroFocusY').value)).toBe(18);
    // The EN hero carries none, so its sliders must read centred rather than
    // inherit the DE values off screen.
    expect(Number(el('enHeroFocusX').value)).toBe(50);

    const out = api.buildPayload();
    expect(out.de.heroImage.focus).toEqual({ x: 22, y: 18 });
    // 50/50 is the unset value: a centred point must not be stored, or every
    // post gains a field and "reset to centre" becomes a no-op.
    expect(out.en.heroImage.focus).toBeUndefined();
  });

  it('round-trips JPEG-only hero and body metadata through the real editor fields', () => {
    const { api, el } = loadEditor();
    const jpegPair = fullPair();
    jpegPair.de.heroImage = { ...jpegPair.de.heroImage, format: 'jpeg' };
    jpegPair.de.images = {
      'https://img/jpeg-body': { width: 1600, height: 1067, format: 'jpeg' },
    };
    api.populateForm(jpegPair);
    expect(el('deHeroFormat').value).toBe('jpeg');
    const out = api.buildPayload();
    expect(out.de.heroImage.format).toBe('jpeg');
    expect(out.de.images['https://img/jpeg-body']).toEqual({
      width: 1600,
      height: 1067,
      format: 'jpeg',
    });

    api.populateForm(fullPair());
    expect(el('deHeroFormat').value).toBe('');
    expect(api.buildPayload().de.heroImage.format).toBeUndefined();
  });

  it('clears a loaded focal point when the next payload carries none (no resurrection)', () => {
    const { api, el } = loadEditor();
    const framed = fullPair();
    framed.de.heroImage = { ...framed.de.heroImage, focus: { x: 5, y: 95 } };
    api.populateForm(framed);
    expect(Number(el('deHeroFocusX').value)).toBe(5);
    api.populateForm(fullPair());
    expect(Number(el('deHeroFocusX').value)).toBe(50);
    expect(api.buildPayload().de.heroImage.focus).toBeUndefined();
  });

  // #121: the "Post Status" select and "Scheduled Publish" field were inert —
  // the server ignores payload status and nothing consumes scheduled_at — so
  // the editor must offer neither control and send neither key, or an author
  // picks "Published", saves, and reasonably believes it worked.
  it('offers no status or schedule control and sends neither key', () => {
    const { api, document } = loadEditor();
    expect(document.getElementById('fmStatus')).toBeNull();
    expect(document.getElementById('fmScheduledAt')).toBeNull();
    api.populateForm({ ...fullPair(), status: 'published', shared: { ...fullPair().shared, scheduledAt: '2024-11-01T09:30:00.000Z' } });
    const out = api.buildPayload();
    expect(Object.keys(out)).not.toContain('status');
    expect(Object.keys(out.shared)).not.toContain('scheduledAt');
  });

  it('buildPayload does not throw on a pristine form (new post → Save draft)', () => {
    const { api } = loadEditor();
    expect(() => api.buildPayload()).not.toThrow();
    expect(api.buildPayload().de.country).toBe('');
  });

  it('a minimal restore payload clears every field the previous post filled (no resurrection)', () => {
    const { api, el } = loadEditor();
    api.populateForm(fullPair());
    api.populateForm(minimalPair());
    for (const id of ['fmDate', 'fmCountryCode', 'fmRegion', 'fmLat', 'fmLng', 'fmRoute', 'fmCategories', 'fmTags',
      'deCountry', 'enCountry', 'deHeroSrc', 'enHeroSrc', 'deHeroAlt', 'enHeroAlt']) {
      expect(el(id).value, id).toBe('');
    }
  });

  // #138: a remove button's click fires neither input nor change, so the
  // delegated listeners never saw a row removal — no leave-page warning, and
  // the stale stash resurrected the removed row on restore.
  it('removing a key-fact or stop row marks the draft dirty', () => {
    const { api, created, dirtyCalls } = loadEditor();
    api.populateForm(fullPair());
    const before = dirtyCalls();
    const removeStop = created.find((e) => e.getAttribute('aria-label') === 'Remove stop');
    const removeFact = created.find((e) => e.getAttribute('aria-label') === 'Remove key fact');
    expect(removeStop && removeFact).toBeTruthy();
    removeStop!.fire('click');
    expect(dirtyCalls()).toBe(before + 1);
    removeFact!.fire('click');
    expect(dirtyCalls()).toBe(before + 2);
  });

  // Issue #122 (Golden Rule 2): the slug follows the title only while it is
  // still automatic. Before, every title keystroke on an unpublished post
  // overwrote the slug — including an imported draft's live WordPress slug.
  describe('slug auto-derivation', () => {
    const type = (el: (id: string) => Element, id: string, value: string) => { el(id).value = value; el(id).fire('input'); };

    it.each(['de', 'en'] as const)('bounds only newly derived %s slugs after ASCII normalization, in parity with the server', (locale) => {
      const { el } = loadEditor();
      const field = locale === 'de' ? 'slugFieldDe' : 'slugFieldEn';
      for (const length of [250, 251, 252, 8192]) {
        type(el, locale + 'Title', 'Ä'.repeat(length));
        const slug = el(field).value;
        expect(slug).toBe('a'.repeat(Math.min(length, MAX_SLUG_BYTES)));
        if (typeof slug !== 'string') throw new TypeError('Expected a string slug value');
        expect(isSafeSlug(slug)).toBe(true);
      }
      type(el, locale + 'Title', 'a'.repeat(250) + ' b');
      expect(el(field).value).toBe('a'.repeat(250));
      type(el, locale + 'Title', '!!!');
      expect(el(field).value).toBe('untitled');
      const manual = 'm'.repeat(252);
      type(el, field, manual);
      type(el, locale + 'Title', 'Changed title');
      expect(el(field).value).toBe(manual);
    });

    it.each(['draft', 'published'] as const)('does not truncate loaded/restored %s URLs on title edits or serialization', (status) => {
      const { api, el } = loadEditor();
      const loaded = fullPair();
      loaded.status = status;
      loaded.de.slug = 'd'.repeat(252);
      loaded.en.slug = 'e'.repeat(8192);
      api.populateForm(loaded);
      type(el, 'deTitle', 'Changed DE');
      type(el, 'enTitle', 'Changed EN');
      const payload = api.buildPayload();
      expect(payload.de.slug).toBe(loaded.de.slug);
      expect(payload.en.slug).toBe(loaded.en.slug);
    });

    it('derives from the title on a new post, stops once the slug is hand-edited, resumes when cleared', () => {
      const { el } = loadEditor();
      type(el, 'deTitle', 'Vier Tage in Bukarest');
      expect(el('slugFieldDe').value).toBe('vier-tage-in-bukarest');
      type(el, 'slugFieldDe', 'bukarest');
      type(el, 'deTitle', 'Vier Tage in Bukarest!');
      expect(el('slugFieldDe').value).toBe('bukarest');
      type(el, 'slugFieldDe', '');
      type(el, 'deTitle', 'Bukarest im Herbst');
      expect(el('slugFieldDe').value).toBe('bukarest-im-herbst');
    });

    it('never re-derives a slug loaded from the server, even when the title is edited', () => {
      const { api, el } = loadEditor();
      const imported = fullPair();
      imported.de.slug = '4-tage-in-bukarest'; imported.de.title = 'Vier Tage in Bukaresd';
      api.populateForm(imported);
      type(el, 'deTitle', 'Vier Tage in Bukarest');
      expect(el('slugFieldDe').value).toBe('4-tage-in-bukarest');
      expect(el('slugFieldEn').value).toBe('bucharest');
    });

    it('still derives the EN slug of a loaded DE-first draft whose EN slug is unset', () => {
      const { api, el } = loadEditor();
      const deFirst = fullPair();
      deFirst.en.slug = ''; deFirst.en.title = '';
      api.populateForm(deFirst);
      type(el, 'enTitle', 'Four days in Bucharest');
      expect(el('slugFieldEn').value).toBe('four-days-in-bucharest');
      expect(el('slugFieldDe').value).toBe('bukarest');
    });
  });
});

const reviewConfig = {
  aiProvider: 'custom', aiBaseUrl: 'https://review.invalid/v1', aiModel: 'fixture-model',
  reviewPrompt: 'Review this fictional travel draft.', reviewTimeoutMs: 60000, aiApiKey: null,
};
const providerUrl = reviewConfig.aiBaseUrl + '/chat/completions';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function reviewResult(title = 'Four days exploring Bucharest'): EditorialReviewResult {
  return {
    title: { status: 'warn', critique: 'Name the place and the length of the stay.', suggestions: [title] },
    excerpt: { status: 'warn', critique: 'Summarise the route.', suggestedExcerpt: 'A four-day walk through Bucharest, with a tram ride, old streets and practical notes from the trip.' },
    headings: { status: 'pass', critique: 'The route has a clear reading order.' },
    practicalDetails: { status: 'warn', critique: 'Explain the tram ticket.', missingAspects: ['Where the ticket was purchased'] },
    internalLinks: { status: 'info', linkOpportunities: ['An existing story about a nearby trip, if relevant'] },
  };
}

function completion(result: EditorialReviewResult) {
  return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
}

function reviewNetwork(provider: () => Promise<Response>, config = reviewConfig): Fetch {
  return async (url) => {
    if (url === '/ai-config') return response(config);
    if (url === providerUrl) return provider();
    throw new Error('Unexpected request in editor integration: ' + url);
  };
}

// For ownership races only, model a provider/client that ignores cancellation.
// Ordinary success and malformed-output tests exercise the real browser LLM.
function deferredReviews() {
  const calls: { story: ReviewStory; signal: AbortSignal; result: PromiseWithResolvers<EditorialReviewResult> }[] = [];
  const review: Review = (_url, _model, _prompt, story, _key, _timeout, signal) => {
    const result = Promise.withResolvers<EditorialReviewResult>();
    calls.push({ story, signal, result });
    return result.promise;
  };
  return { calls, review };
}

function required(root: Element, selector: string): Element {
  const node = root.querySelector(selector);
  if (!node) throw new Error('Missing editor control: ' + selector);
  return node;
}

describe('Story review in the real editor', () => {
  it('opens an accessible dialog and renders all quick checks before configuration resolves', async () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.api.populateForm(fullPair());
    h.el('deTitle').value = 'A long enough fictional trip title';
    h.el('deExcerpt').value = 'Short';
    h.editors[0]!.value('## Walking route\n\nOrdinary draft prose.');
    const dirtyBefore = h.dirtyCalls();
    const before = h.api.buildPayload();
    h.el('reviewStory').focus();
    h.el('reviewStory').click();
    await settle();

    const dialog = h.el('storyReviewDialog');
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe(h.el('storyReviewHeading').id);
    expect(h.el('reviewStatus').getAttribute('role')).toBe('status');
    expect(h.el('reviewStatus').getAttribute('aria-live')).toBe('polite');
    expect(h.document.activeElement).toBe(h.el('closeReview'));
    expect(h.el('reviewInstant').querySelectorAll('[data-review-criterion]').map((node) => node.dataset.reviewCriterion))
      .toEqual(['title', 'excerpt', 'headings', 'altText', 'internalLinks']);
    expect(required(h.el('reviewInstant'), '[data-review-criterion="title"]').textContent).toContain('Pass');
    expect(required(h.el('reviewInstant'), '[data-review-criterion="excerpt"]').textContent).toContain('Warning');
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('true');
    expect(h.el('reviewSemantic').children).toHaveLength(0);
    expect(h.dirtyCalls()).toBe(dirtyBefore);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.el('saveDraft').disabled).toBe(false);
    expect(h.el('publishBtn').disabled).toBe(false);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each(['de', 'en'] as const)('reviews the unsaved %s fields and CodeMirror body, then renders semantic suggestions without applying them', async (locale) => {
    const provider = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: reviewNetwork(() => provider.promise) });
    h.api.populateForm(fullPair());
    h.el('tabbtn-' + locale).click();
    const snapshot: ReviewStory = {
      locale, title: locale === 'de' ? 'Ungespeicherter Stadtrundgang' : 'Unsaved city walking route',
      excerpt: 'A freshly edited summary, not the stored excerpt.',
      markdown: '## Unsaved route\n\n[Earlier trip](/earlier-trip/)',
      heroAlt: 'Tram passing an old building', heroSrc: 'https://img.invalid/new-hero',
    };
    for (const [suffix, value] of [['Title', snapshot.title], ['Excerpt', snapshot.excerpt], ['HeroAlt', snapshot.heroAlt], ['HeroSrc', snapshot.heroSrc]]) {
      h.el(locale + suffix).value = value!;
      h.el(locale + suffix).fire('input');
    }
    h.el(locale + 'Body').value = 'Stale hidden textarea';
    h.editors[locale === 'de' ? 0 : 1]!.value(snapshot.markdown);
    const before = h.api.buildPayload();
    h.el('reviewStory').click();
    await settle();

    const request = h.requests.find((request) => request.url === providerUrl)!;
    const payload = JSON.parse(String(request.options.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(payload.messages.find((message) => message.role === 'user')!.content)).toEqual(snapshot);
    expect(h.el('reviewLocale').textContent).toContain(locale.toUpperCase());
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('true');
    provider.resolve(completion(reviewResult()));
    await settle();

    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(required(h.el('reviewSemantic'), '[data-review-criterion="practicalDetails"]').textContent)
      .toContain(reviewResult().practicalDetails.missingAspects[0]);
    expect(required(h.el('reviewSemantic'), '[data-review-criterion="internalLinks"]').textContent).toContain('Suggestion');
    expect(required(h.el('reviewSemantic'), '[data-review-action="title"]').disabled).toBe(false);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config', providerUrl]);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each([
    { name: 'offline provider', provider: async () => { throw new Error('private-provider-detail'); } },
    { name: 'provider authentication failure', provider: async () => response({ error: 'private-provider-detail' }, 401) },
    { name: 'malformed semantic response', provider: async () => response({ choices: [{ message: { content: '{"title":"private-provider-detail"}' } }] }) },
  ])('preserves instant checks and offers recovery after $name', async ({ provider }) => {
    const h = loadEditor({ fetch: reviewNetwork(provider) });
    h.el('reviewStory').click();
    await settle();
    const quickChecks = h.el('reviewInstant').textContent;
    await settle();

    expect(h.el('storyReviewDialog').open).toBe(true);
    expect(h.el('reviewInstant').textContent).toBe(quickChecks);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewStatus').textContent).toMatch(/check|configure|again/i);
    expect(h.el('reviewStatus').textContent).toContain('Warning');
    expect(h.el('reviewStatus').textContent).not.toContain('private-provider-detail');
    expect(h.el('reviewSemantic').querySelector('[data-review-action]')).toBeNull();
    expect(h.el('runReview').disabled).toBe(false);
    expect(h.el('saveDraft').disabled).toBe(false);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each(['openrouter', 'deepseek'])('does not contact a fallback provider when %s has no key', async (aiProvider) => {
    const h = loadEditor({ isAdmin: false, fetch: reviewNetwork(async () => completion(reviewResult()), { ...reviewConfig, aiProvider }) });
    await settle();
    h.el('reviewStory').click();
    await settle();
    const instant = h.el('reviewInstant').textContent;
    await settle();

    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config']);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewInstant').textContent).toBe(instant);
    expect(h.el('reviewStatus').textContent).toMatch(/API key/i);
    expect(h.el('reviewStatus').textContent).toMatch(/administrator/i);
    expect(h.el('reviewStatus').querySelector('a[href]')).toBeNull();
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('keeps quick checks usable when configuration fails, with a settings link only for administrators', async () => {
    const h = loadEditor({ isAdmin: true, fetch: async () => response({ error: 'private-config-detail' }, 503) });
    await settle();
    h.el('reviewStory').click();
    await settle();
    const instant = h.el('reviewInstant').textContent;
    await settle();

    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewInstant').textContent).toBe(instant);
    expect(required(h.el('reviewStatus'), 'a[href]').getAttribute('href')).toBe('/admin/settings.html');
    expect(h.el('reviewStatus').textContent).not.toContain('private-config-detail');
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('uses the draft-preserving login redirect when the editor session expires', async () => {
    const h = loadEditor({ fetch: async () => response({}, 401) });
    h.el('deTitle').value = 'Still unsaved';
    h.el('deTitle').fire('input');
    h.el('reviewStory').click();
    await settle();
    expect(h.redirects()).toBe(1);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('deTitle').value).toBe('Still unsaved');
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config']);
    h.flushDialogEvents();
  });

  it.each([
    { name: 'new automatic slug', loaded: false, manual: false, locale: 'de' as const, expected: 'four-days-exploring-bucharest' },
    { name: 'loaded WordPress slug', loaded: true, manual: false, locale: 'de' as const, expected: 'bukarest' },
    { name: 'manually entered EN slug', loaded: false, manual: true, locale: 'en' as const, expected: 'keep-this-live-url' },
  ])('applies only on explicit clicks and respects the $name', async ({ loaded, manual, locale, expected }) => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    if (loaded) h.api.populateForm(fullPair());
    else {
      h.el('deTitle').value = 'Original German title';
      h.el('enTitle').value = 'Original English title';
      h.editors[0]!.value('## German prose\n\nDo not rewrite this.');
      h.editors[1]!.value('## English prose\n\nLeave the other locale alone.');
    }
    h.el('tabbtn-' + locale).click();
    if (manual) {
      h.el('slugFieldEn').value = 'keep-this-live-url';
      h.el('slugFieldEn').fire('input');
    }
    const before = h.api.buildPayload();
    const dirtyBefore = h.dirtyCalls();
    h.el('reviewStory').click();
    await settle();
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirtyBefore);

    const title = required(h.el('reviewSemantic'), '[data-review-action="title"]');
    title.click();
    expect(h.el(locale + 'Title').value).toBe(reviewResult().title.suggestions![0]);
    expect(h.el(locale === 'de' ? 'slugFieldDe' : 'slugFieldEn').value).toBe(expected);
    expect(h.dirtyCalls()).toBe(dirtyBefore + 1);
    expect(title.disabled).toBe(true);
    expect(h.el('storyReviewDialog').open).toBe(true);
    const excerpt = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    expect(excerpt.disabled).toBe(false);
    excerpt.click();
    expect(h.el(locale + 'Excerpt').value).toBe(reviewResult().excerpt.suggestedExcerpt);
    expect(h.dirtyCalls()).toBe(dirtyBefore + 2);
    expect(excerpt.disabled).toBe(true);
    const after = h.api.buildPayload();
    expect(after[locale === 'de' ? 'en' : 'de']).toEqual(before[locale === 'de' ? 'en' : 'de']);
    expect(after.de.bodyMarkdown).toBe(before.de.bodyMarkdown);
    expect(after.en.bodyMarkdown).toBe(before.en.bodyMarkdown);
    expect(after.shared).toEqual(before.shared);
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config', providerUrl]);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('jumps to real inline and gallery lines, then hero alt, without a queued close stealing focus', async () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.el('tabbtn-en').click();
    h.el('enHeroSrc').value = 'https://img.invalid/hero';
    h.el('enHeroAlt').value = '';
    h.editors[1]!.value([
      '## Route', '', '![](https://img.invalid/inline)', '',
      '```gallery', '#layout: column', '', 'https://img.invalid/gallery | 640x480', '```',
    ].join('\n'));

    for (const [line, cursor] of [[3, 2], [8, 7]]) {
      h.el('reviewStory').click();
      await settle();
      required(h.el('reviewInstant'), `[data-review-action="jump"][data-line="${line}"]`).click();
      await settle();
      expect(h.el('storyReviewDialog').open).toBe(false);
      expect(h.editors[1]!.cursor).toEqual({ line: cursor, ch: 0 });
      expect(h.document.activeElement).toBe(h.editors[1]!.input);
      h.flushDialogEvents();
      expect(h.document.activeElement).toBe(h.editors[1]!.input);
    }
    h.el('reviewStory').click();
    await settle();
    required(h.el('reviewInstant'), '[data-review-action="jump"][data-target="hero"]').click();
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('enHeroAlt'));
    h.flushDialogEvents();
    expect(h.document.activeElement).toBe(h.el('enHeroAlt'));
    expect(h.editors[0]!.focusCalls).toBe(0);
  });

  it('wraps keyboard focus including asynchronous actions and restores the trigger on Escape or Close', async () => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    h.el('reviewStory').focus();
    h.el('reviewStory').click();
    await settle();
    const dialog = h.el('storyReviewDialog');
    const controls = dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')
      .filter((control) => !control.disabled && control.tabIndex >= 0 && !control.closest('[hidden]'));
    const first = controls[0]!;
    const last = controls.at(-1)!;
    const dynamic = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    expect(controls).toContain(dynamic);
    dynamic.focus();
    expect(dynamic.fire('keydown', { key: 'Tab' }).defaultPrevented).toBe(false);
    first.focus();
    expect(first.fire('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(last);
    expect(last.fire('keydown', { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(first);
    first.fire('keydown', { key: 'Escape' });
    expect(dialog.open).toBe(false);
    h.flushDialogEvents();
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    h.el('reviewStory').click();
    h.el('closeReview').click();
    h.flushDialogEvents();
    expect(dialog.open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    h.el('reviewStory').click();
    dialog.dispatchEvent(new EditorEvent('cancel', { cancelable: true }));
    h.flushDialogEvents();
    expect(dialog.open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    await settle();
  });

  it('renders model markup as literal text, including every list and suggested value', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const result = reviewResult(hostile);
    result.title.critique = hostile;
    result.excerpt.critique = hostile;
    result.excerpt.suggestedExcerpt = hostile;
    result.headings.critique = hostile;
    result.practicalDetails.critique = hostile;
    result.practicalDetails.missingAspects = [hostile];
    result.internalLinks.linkOpportunities = [hostile];
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(result)) });
    h.el('reviewStory').click();
    await settle();
    for (const card of h.el('reviewSemantic').querySelectorAll('[data-review-criterion]')) {
      expect(card.textContent).toContain(hostile);
    }
    expect(h.el('reviewSemantic').querySelectorAll('img, script, [onerror]')).toEqual([]);
    required(h.el('reviewSemantic'), '[data-review-action="excerpt"]').click();
    expect(h.el('deExcerpt').value).toBe(hostile);
    expect(h.el('deTitle').value).toBe('');
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  describe.each(['configuration', 'provider'] as const)('late %s results', (stage) => {
    it.each(['close and reopen', 'new run', 'locale change', 'same-post restore', 'field edit', 'body edit'])('cannot overwrite the current review after %s', async (transition) => {
      const configs: PromiseWithResolvers<Response>[] = [];
      const provider = deferredReviews();
      const h = loadEditor({
        review: provider.review,
        fetch: async () => {
          if (stage === 'provider') return response(reviewConfig);
          const config = Promise.withResolvers<Response>();
          configs.push(config);
          return config.promise;
        },
      });
      h.api.populateForm(fullPair());
      h.el('reviewStory').click();
      await settle();
      const oldSignal = h.requests[0]!.options.signal!;
      if (stage === 'provider') expect(provider.calls).toHaveLength(1);
      else expect(provider.calls).toHaveLength(0);

      if (transition === 'close and reopen') h.el('closeReview').click();
      else if (transition === 'new run') h.el('runReview').click();
      else if (transition === 'locale change') h.el('tabbtn-en').click();
      else if (transition === 'same-post restore') {
        const revision = fullPair();
        revision.de.title = 'A revised snapshot of the same post';
        h.api.populateForm(revision);
      } else if (transition === 'field edit') {
        h.el('deTitle').value = 'The author changed this title';
        h.el('deTitle').fire('input');
      } else {
        h.editors[0]!.value('## New author prose\n\nA newer body than the reviewed snapshot.');
      }
      expect(oldSignal.aborted).toBe(true);
      if (transition !== 'new run') h.el('reviewStory').click();
      await settle();
      if (stage === 'configuration') {
        expect(configs).toHaveLength(2);
        configs[1]!.resolve(response(reviewConfig));
        await settle();
      }
      const currentCall = provider.calls.at(-1)!;
      expect(currentCall.story.locale).toBe(transition === 'locale change' ? 'en' : 'de');
      currentCall.result.resolve(reviewResult('Current review suggestion'));
      await settle();
      const currentCards = h.el('reviewSemantic').textContent;
      const currentStatus = h.el('reviewStatus').textContent;
      const expectedProviderCalls = stage === 'provider' ? 2 : 1;
      if (stage === 'configuration') configs[0]!.resolve(response(reviewConfig));
      else provider.calls[0]!.result.resolve(reviewResult('Obsolete review suggestion'));
      await settle();
      // Deliver close events only AFTER a new dialog has rendered its results.
      h.flushDialogEvents();

      expect(provider.calls).toHaveLength(expectedProviderCalls);
      expect(h.el('storyReviewDialog').open).toBe(true);
      expect(h.el('reviewSemantic').textContent).toBe(currentCards);
      expect(h.el('reviewStatus').textContent).toBe(currentStatus);
      expect(h.el('reviewSemantic').textContent).not.toContain('Obsolete review suggestion');
      expect(h.document.activeElement).toBe(h.el('closeReview'));
      required(h.el('reviewSemantic'), '[data-review-action="title"]').click();
      expect(h.el(currentCall.story.locale + 'Title').value).toBe('Current review suggestion');
      h.el('closeReview').click();
      h.flushDialogEvents();
    });
  });

  it('ignores a late rejected review and expired-session response after closing', async () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.el('reviewStory').click();
    h.el('closeReview').click();
    config.resolve(response({}, 401));
    await settle();
    h.flushDialogEvents();
    expect(h.redirects()).toBe(0);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewStatus').textContent).toBe('');

    const provider = deferredReviews();
    const other = loadEditor({ review: provider.review, fetch: async () => response(reviewConfig) });
    other.el('reviewStory').click();
    await settle();
    other.el('closeReview').click();
    provider.calls[0]!.result.reject(new Error('private-obsolete-failure'));
    await settle();
    other.flushDialogEvents();
    expect(other.el('storyReviewDialog').open).toBe(false);
    expect(other.el('reviewStatus').textContent).toBe('');
    expect(other.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
  });

  it('makes already-rendered apply actions inert after a same-post restore', async () => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    h.api.populateForm(fullPair());
    h.el('reviewStory').click();
    await settle();
    const oldTitle = required(h.el('reviewSemantic'), '[data-review-action="title"]');
    const oldExcerpt = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    const revision = fullPair();
    revision.de.title = 'Restored revision title';
    revision.de.excerpt = 'Restored revision excerpt';
    h.api.populateForm(revision);
    const dirtyBefore = h.dirtyCalls();
    oldTitle.click();
    oldExcerpt.click();
    h.flushDialogEvents();
    expect(h.el('deTitle').value).toBe(revision.de.title);
    expect(h.el('deExcerpt').value).toBe(revision.de.excerpt);
    expect(h.dirtyCalls()).toBe(dirtyBefore);
    expect(h.el('storyReviewDialog').open).toBe(false);
  });

  it('reviews the locale selected by an existing missing-field shortcut, not the formerly active tab', async () => {
    const provider = deferredReviews();
    const h = loadEditor({ review: provider.review, fetch: async () => response(reviewConfig) });
    const pair = fullPair();
    pair.en.excerpt = '';
    h.api.populateForm(pair);
    const englishGap = h.el('localeChip').querySelectorAll('button').find((button) => button.textContent.startsWith('EN '))!;
    englishGap.click();
    expect(h.el('tab-en').hidden).toBe(false);
    expect(h.document.activeElement).toBe(h.el('enExcerpt'));
    h.el('reviewStory').click();
    await settle();
    expect(provider.calls[0]!.story).toMatchObject({ locale: 'en', title: pair.en.title, excerpt: '' });
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('ignores configuration whose body resolves after the drawer closes', async () => {
    const body = Promise.withResolvers<unknown>();
    const config = response({});
    config.json = () => body.promise;
    const provider = deferredReviews();
    const h = loadEditor({ review: provider.review, fetch: async () => config });
    h.el('reviewStory').click();
    await settle();
    h.el('closeReview').click();
    body.resolve({ ...reviewConfig });
    await settle();
    h.flushDialogEvents();
    expect(provider.calls).toEqual([]);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').children).toHaveLength(0);
  });

  it('cannot apply a former post’s in-flight review after loading another post', async () => {
    const provider = deferredReviews();
    const next = fullPair();
    next.translationKey = 'different-post';
    next.de.title = 'A completely different post';
    const h = loadEditor({
      review: provider.review,
      fetch: async (url) => {
        if (url === '/ai-config') return response(reviewConfig);
        if (url === '/posts/different-post') return response(next);
        return response({}, 404);
      },
    });
    h.api.populateForm(fullPair());
    h.el('reviewStory').click();
    await settle();
    await h.api.loadPost('different-post');
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    const nextPayload = h.api.buildPayload();
    expect(nextPayload.translationKey).toBe('different-post');
    provider.calls[0]!.result.resolve(reviewResult('Suggestion for the wrong post'));
    await settle();
    h.flushDialogEvents();
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').querySelector('[data-review-action]')).toBeNull();
    expect(h.api.buildPayload()).toEqual(nextPayload);
  });
});

describe('waypoint location lookup', () => {
  const location = { label: 'Cancún, Quintana Roo, México', lat: 21.1619, lng: -86.8515 };

  it('searches only on request and saves the selected coordinates without renaming or touching another stop', async () => {
    const h = loadEditor({ fetch: async () => response({ results: [location, { label: '<img src=x>', lat: 0, lng: 0 }] }) });
    const pair = fullPair();
    pair.shared.stops!.push({ name: 'Other stop', lat: 1, lng: 2 });
    h.api.populateForm(pair);
    const row = required(h.el('stopsList'), '.stop-row');
    const name = required(row, '.stop-name');
    name.value = 'Cancun';
    name.dispatchEvent(new EditorEvent('input'));
    expect(h.requests).toEqual([]);
    required(row, '.stop-search').click();
    await settle();
    expect(h.requests.map((r) => [r.url, JSON.parse(String(r.options.body))])).toEqual([['/geocode', { query: 'Cancun' }]]);
    expect(h.api.buildPayload().shared.stops![0]).toEqual({ name: 'Cancun', lat: 44.4, lng: 26.1 });
    const choices = row.querySelectorAll('.stop-search-result');
    expect(choices[1]!.textContent).toBe('<img src=x>');
    expect(choices[1]!.querySelector('img')).toBeNull();
    const before = h.dirtyCalls();
    choices[0]!.click();
    expect(h.api.buildPayload().shared.stops).toEqual([
      { name: 'Cancun', lat: location.lat, lng: location.lng }, { name: 'Other stop', lat: 1, lng: 2 },
    ]);
    expect(h.dirtyCalls()).toBe(before + 1);
    expect(h.document.activeElement).toBe(required(row, '.stop-lat'));
  });

  it.each([200, 429, 502, 503])('preserves coordinates when search returns no usable result (%s)', async (status) => {
    const h = loadEditor({ fetch: async () => response(status === 200 ? { results: [] } : { code: 'lookup_failed' }, status) });
    h.api.populateForm(fullPair());
    const row = required(h.el('stopsList'), '.stop-row');
    const before = h.api.buildPayload();
    required(row, '.stop-search').click();
    await settle();
    expect(h.api.buildPayload()).toEqual(before);
    expect(row.querySelector('.stop-search-result')).toBeNull();
    expect(required(row, '.stop-search').disabled).toBe(false);
    expect(required(row, '.stop-search-status').textContent).toBe(ui.en[
      status === 200 ? 'editor.waypoint.empty' : status === 429 ? 'editor.waypoint.busy'
        : status === 503 ? 'editor.waypoint.disabled' : 'editor.waypoint.failed'
    ]);
  });

  it.each(['name', 'latitude', 'remove', 'restore'])('ignores a pending result after %s changes', async (change) => {
    const pending = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => pending.promise });
    h.api.populateForm(fullPair());
    const row = required(h.el('stopsList'), '.stop-row');
    required(row, '.stop-search').click();
    if (change === 'remove') required(row, '.btn-remove').click();
    else if (change === 'restore') h.api.populateForm(minimalPair());
    else {
      const input = required(row, change === 'name' ? '.stop-name' : '.stop-lat');
      input.value = change === 'name' ? 'London' : '51';
      input.dispatchEvent(new EditorEvent('input'));
    }
    const before = h.api.buildPayload();
    expect(h.requests[0]!.options.signal!.aborted).toBe(true);
    pending.resolve(response({ results: [location] }));
    await settle();
    expect(row.querySelector('.stop-search-result')).toBeNull();
    expect(h.api.buildPayload()).toEqual(before);
  });

  it('supports Enter and preserves the draft when the session expires', async () => {
    const h = loadEditor({ fetch: async () => response({}, 401) });
    h.api.populateForm(fullPair());
    const row = required(h.el('stopsList'), '.stop-row');
    const before = h.api.buildPayload();
    const event = new EditorEvent('keydown', { key: 'Enter', cancelable: true });
    required(row, '.stop-name').dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(h.redirects()).toBe(1);
    expect(h.api.buildPayload()).toEqual(before);
  });
});

describe('inline gallery editing', () => {
  function pairWithGallery() {
    const pair = fullPair();
    pair.de.bodyMarkdown = 'Intro\n\n```gallery\n#layout: slider\nhttps://img/photo\nhttps://img/photo\n```\n\nAfter';
    pair.de.images = { 'https://img/photo': { width: 900, height: 600, alt: 'Original', caption: 'Caption', format: 'jpeg' } };
    pair.en.bodyMarkdown = pair.de.bodyMarkdown;
    pair.en.images = { 'https://img/photo': { width: 900, height: 600, alt: 'English' } };
    return pair;
  }

  interface MediaRow { key: string; src: string; title: string; alt: { de: string; en: string }; caption: { de: string; en: string } }
  const mediaRow = (key: string, alt: MediaRow['alt'], caption: MediaRow['caption']): MediaRow =>
    ({ key, src: 'https://img/' + key, title: 'Market at dawn', alt, caption });
  // The resolver reads the image base off any library row, so the probe always
  // answers with an unrelated one; `rows` decides which gallery photos exist.
  const anchor = mediaRow('anchor', { de: '', en: '' }, { de: '', en: '' });
  function mediaNetwork(rows: MediaRow[]): Fetch {
    return async (url) => {
      if (url.startsWith('/media?')) return response({ total: rows.length + 1, items: [anchor] });
      if (url.startsWith('/media/items/')) {
        const row = rows.find((candidate) => candidate.key === url.slice('/media/items/'.length));
        return row ? response(row) : response({ error: 'image not found' }, 404);
      }
      throw new Error('no network in test: ' + url);
    };
  }
  const settleAll = async () => { for (let i = 0; i < 12; i++) await settle(); };

  const pickerOptions = { layout: 'column', captions: { visible: true, overrides: {} } };
  const pickedPhoto = { ...mediaRow('replacement', { de: 'A & <view>', en: 'View' }, { de: '', en: '' }), width: 900, height: 600 };
  const analyzeRequest: Fetch = async (_url, init) => {
    const { bodyMarkdown } = JSON.parse(String(init?.body)) as { bodyMarkdown: string };
    return response(await analyzeGallerySource(bodyMarkdown));
  };
  interface PickerHarness {
    editors: { codemirror: {
      setCursor(position: { line: number; ch: number }): void;
      posFromIndex(index: number): { line: number; ch: number };
    } }[];
    el(id: string): Element;
    galleryPickers: GalleryPicker[];
  }
  async function openPicker(h: PickerHarness, cursor: number) {
    h.editors[0]!.codemirror.setCursor(h.editors[0]!.codemirror.posFromIndex(cursor));
    h.el('deGallery').click();
    await settleAll();
    const picker = h.galleryPickers.at(-1);
    if (!picker) throw new Error('The authenticated analysis did not open a gallery picker');
    return picker;
  }

  it('sends the exact unsaved snapshot once per debounced change, not once per photo', async () => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    await settleAll();
    const count = h.galleryRequests.length;
    const editor = h.editors[0]!;
    editor.value('A first unsaved edit');
    editor.value('A newer edit');
    const body = '🧭 Current\r\n\r\n> ~~~gallery extra\r\n> https://img/photo\r\n> https://img/photo\r\n> ~~~';
    editor.value(body);
    expect(h.galleryRequests).toHaveLength(count);
    await settleAll();
    const requests = h.galleryRequests.slice(count);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/gallery/analyze');
    expect(requests[0]!.options).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(requests[0]!.options.body))).toEqual({ bodyMarkdown: body });
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(1);
    expect(h.document.querySelectorAll('.editor-gallery__alt')).toHaveLength(2);
    expect(editor.value()).toBe(body);
    expect(editor.undoHistory).toEqual([]);
  });

  it('discards a late analysis of old source instead of installing stale widget ranges', async () => {
    const old = '~~~gallery\nhttps://img/old\n~~~';
    const current = '> ~~~gallery extra\n> https://img/current\n> ~~~';
    const late = Promise.withResolvers<Response>();
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => JSON.parse(String(init?.body)).bodyMarkdown === old
        ? late.promise : analyzeRequest(url, init),
    });
    const pair = fullPair();
    pair.de.bodyMarkdown = old;
    h.api.populateForm(pair);
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toEqual([]);
    h.editors[0]!.value(current);
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(1);
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    late.resolve(response(await analyzeGallerySource(old)));
    await settleAll();
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.editors[0]!.undoHistory).toEqual([]);
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(1);
    expect(h.document.querySelector('.editor-gallery')!.textContent).not.toContain('old');
    const picker = await openPicker(h, current.indexOf('https://img/current'));
    await picker.onPick([pickedPhoto], pickerOptions);
    expect(h.editors[0]!.value()).toContain('https://img/replacement');
    expect(h.editors[0]!.value()).not.toContain('https://img/old');
  });

  it('leaves raw source and undo untouched offline, with localized retry and no lexical fallback', async () => {
    let offline = true;
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => offline ? Promise.reject(new Error('offline')) : analyzeRequest(url, init),
    });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toEqual([]);
    for (const locale of ['de', 'en'] as const) {
      const status = h.el(locale + 'GalleryView').parentElement!;
      expect(status.textContent).toContain(ui[locale]['editor.gallery.analysisFailed']);
      expect(status.querySelectorAll('button').some((button) =>
        !button.hidden && button.textContent === ui[locale]['editor.gallery.retry'])).toBe(true);
    }
    h.editors[0]!.codemirror.setCursor({ line: 3, ch: 0 });
    h.el('deGallery').click();
    await settleAll();
    expect(h.galleryPickers).toEqual([]);
    expect(h.el('deBodyImgStatus').textContent).toContain(ui.de['editor.gallery.analysisFailed']);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.editors[0]!.undoHistory).toEqual([]);
    offline = false;
    required(h.el('deBodyImgStatus'), 'button').click();
    await settleAll();
    expect(h.galleryPickers).toHaveLength(1);
    expect(h.api.buildPayload()).toEqual(before);
  });

  it.each(['new source', 'edited then restored'] as const)('refuses picker application after %s while analyzing the current snapshot', async (change) => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    const picker = await openPicker(h, pair.de.bodyMarkdown.indexOf('https://img/photo'));
    const editor = h.editors[0]!;
    editor.value('A newly typed paragraph\n\n' + pair.de.bodyMarkdown);
    if (change === 'edited then restored') editor.value(pair.de.bodyMarkdown);
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    const requests = h.galleryRequests.length;
    await picker.onPick([pickedPhoto], pickerOptions);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(editor.undoHistory).toEqual([]);
    expect(h.el('deBodyImgStatus').textContent).toBe(ui.de['editor.gallery.stale']);
    expect(h.galleryRequests.slice(requests).some((request) =>
      JSON.parse(String(request.options.body)).bodyMarkdown === before.de.bodyMarkdown)).toBe(true);
  });

  it('opening and cancelling a picker never commits source or metadata or creates undo history', async () => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    const picker = await openPicker(h, pair.de.bodyMarkdown.indexOf('https://img/photo'));
    expect(picker.multiple).toBe(true);
    // MediaPicker's cancellation contract closes without invoking onPick.
    // Discard that open picker, then open a fresh one against the same draft.
    h.galleryPickers.pop();
    await openPicker(h, pair.de.bodyMarkdown.indexOf('https://img/photo'));
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.editors[0]!.undoHistory).toEqual([]);
  });

  it.each([
    { name: 'nested CRLF tilde', body: '🧭 Before\r\n\r\n> ~~~gallery extra\r\n> https://img/photo\r\n> ~~~\r\n>\r\n> Neighbor\r\n\r\nTail',
      opener: '> ~~~gallery extra\r\n> ', closer: '\r\n> ~~~\r\n>\r\n> Neighbor\r\n\r\nTail' },
    { name: 'raw HTML', body: '🧭 Before\n\n<pre><code class="language-gallery">https://img/photo | alt="A &amp; B"</code></pre>\n\nNeighbor',
      opener: '<pre><code class="language-gallery">', closer: '</code></pre>\n\nNeighbor' },
  ])('edits and removes $name galleries without losing wrappers or neighbors, with one undoable range edit', async ({ body, opener, closer }) => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    const pair = fullPair();
    pair.de.bodyMarkdown = body;
    pair.de.images = { 'https://img/photo': { width: 900, height: 600, alt: 'Original' } };
    h.api.populateForm(pair);
    await settleAll();
    const block = (await analyzeGallerySource(body)).blocks.find((entry) => entry.isGallery)!;
    const picker = await openPicker(h, body.indexOf('https://img/photo'));
    await picker.onPick([pickedPhoto], pickerOptions);
    const editor = h.editors[0]!;
    const edited = editor.value();
    expect(edited).toContain(opener);
    expect(edited.endsWith(closer)).toBe(true);
    expect(edited.slice(0, block.start)).toBe(body.slice(0, block.start));
    expect(edited).toContain('https://img/replacement');
    expect(edited).not.toContain('https://img/photo');
    expect(h.api.buildPayload().de.images).toEqual(pair.de.images);
    expect(h.api.buildPayload().en).toEqual(pair.en);
    const logical = (await analyzeGallerySource(edited)).blocks.find((entry) => entry.isGallery)!.content;
    expect(logical).toContain('alt="A &amp; &lt;view&gt;"');
    expect(editor.undoHistory).toEqual([body]);
    editor.codemirror.undo();
    expect(editor.value()).toBe(body);
    await settleAll();
    const removal = await openPicker(h, body.indexOf('https://img/photo'));
    await removal.onPick([], pickerOptions);
    expect(editor.value()).toBe(body.slice(0, block.start) + body.slice(block.end));
    expect(editor.undoHistory).toEqual([body]);
    editor.codemirror.undo();
    expect(editor.value()).toBe(body);
  });

  it('refuses picker editing of an unterminated gallery without changing source, metadata or undo history', async () => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    const pair = fullPair();
    pair.de.bodyMarkdown = '> ~~~gallery\n> https://img/photo';
    h.api.populateForm(pair);
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toEqual([]);
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    h.editors[0]!.codemirror.setCursor(
      h.editors[0]!.codemirror.posFromIndex(pair.de.bodyMarkdown.indexOf('https://img/photo')));
    h.el('deGallery').click();
    await settleAll();
    // Refusal happens before opening: neither replacement nor removal can
    // acquire a picker callback for the unsafe range.
    expect(h.galleryPickers).toEqual([]);
    expect(h.el('deBodyImgStatus').textContent).toBe(ui.de['editor.gallery.unterminated']);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.editors[0]!.undoHistory).toEqual([]);
  });

  it('keeps post-local alt editing for photos with no Media row: every occurrence, clears on save, survives reload', async () => {
    const h = loadEditor({ fetch: mediaNetwork([]) });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    expect(fields.map((field) => field.value)).toEqual(['Original', 'Original', 'English', 'English']);
    expect(fields.map((field) => field.readOnly)).toEqual([false, false, false, false]);
    expect(h.document.querySelectorAll('.editor-gallery__local').map((note) => note.hidden)).toEqual([false, false, false, false]);
    expect(h.document.querySelectorAll('.editor-gallery__source').map((note) => note.hidden)).toEqual([true, true, true, true]);
    fields[0]!.value = 'A \"quote\" | and\nnewline';
    fields[0]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settleAll();
    expect(fields[1]!.value).toBe(fields[0]!.value);
    expect(h.api.buildPayload().en).toEqual(pair.en);
    expect((await normalizeGalleryFences(h.api.buildPayload().de.bodyMarkdown, pair.de.images)).images['https://img/photo']?.alt)
      .toBe('A \"quote\" | and\nnewline');
    fields[0]!.value = '';
    fields[0]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settleAll();
    const saved = await normalizeGalleryFences(h.api.buildPayload().de.bodyMarkdown, pair.de.images);
    expect(saved.images['https://img/photo']).toEqual({ ...pair.de.images['https://img/photo'], alt: '' });
    expect(saved.bodyMarkdown).toBe(pair.de.bodyMarkdown);
    pair.de = { ...pair.de, ...saved };
    h.api.populateForm(pair);
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery__alt').map((field) => field.value))
      .toEqual(['', '', 'English', 'English']);
  });

  it('flushes every pending manual photo description before saving, across locale switches', async () => {
    const pair = pairWithGallery();
    pair.de.bodyMarkdown = pair.de.bodyMarkdown.replace('https://img/photo\n```', 'https://img/other\n```');
    pair.de.images['https://img/other'] = { width: 900, height: 600, alt: 'Other' };
    const network = mediaNetwork([]);
    let hold = false;
    const waiting: { body: string; reply: PromiseWithResolvers<Response> }[] = [];
    const h = loadEditor({
      fetch: async (url, init) => {
        if (url.startsWith('/media')) return network(url, init);
        if (url.endsWith('/revisions')) return response([]);
        if (url.endsWith('/alt-audit')) return response(null);
        return response({ ...pair, translationKey: 'saved' });
      },
      galleryFetch: (url, init) => {
        if (!hold) return analyzeRequest(url, init);
        const reply = Promise.withResolvers<Response>();
        waiting.push({ body: JSON.parse(String(init?.body)).bodyMarkdown, reply });
        return reply.promise;
      },
    });
    h.api.populateForm(pair);
    await settleAll();
    hold = true;
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    fields[0]!.value = 'First draft';
    fields[0]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settle();
    fields[1]!.value = 'Second photo';
    fields[1]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    fields[0]!.value = 'Latest first photo';
    fields[0]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    const saving = h.api.doSaveDraft();
    await settle();
    h.el('tabbtn-en').click();
    fields[2]!.value = 'English description';
    fields[2]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settleAll();
    expect(h.requests.filter((request) => request.options.method === 'POST')).toEqual([]);
    hold = false;
    for (const request of waiting.filter((request) => request.body !== pair.en.bodyMarkdown)) {
      request.reply.resolve(response(await analyzeGallerySource(request.body)));
    }
    await settleAll();
    // EN was edited after its first flush returned, while DE was still pending.
    expect(h.requests.some((request) => request.options.method === 'POST')).toBe(false);
    for (const request of waiting.filter((request) => request.body === pair.en.bodyMarkdown)) {
      request.reply.resolve(response(await analyzeGallerySource(request.body)));
    }
    expect(await saving).toBe(true);
    const request = h.requests.find((entry) => entry.url === '/posts' && entry.options.method === 'POST')!;
    const sent = JSON.parse(String(request.options.body)) as PostPair;
    const de = await normalizeGalleryFences(sent.de.bodyMarkdown, sent.de.images);
    const en = await normalizeGalleryFences(sent.en.bodyMarkdown, sent.en.images);
    expect(de.images['https://img/photo']?.alt).toBe('Latest first photo');
    expect(de.images['https://img/other']?.alt).toBe('Second photo');
    expect(en.images['https://img/photo']?.alt).toBe('English description');
    expect(h.api.buildPayload().de.bodyMarkdown).toBe(sent.de.bodyMarkdown);
  });

  it('recovers every pending description after analysis expires the session, before saving', async () => {
    const pair = pairWithGallery();
    pair.de.bodyMarkdown = pair.de.bodyMarkdown.replace('https://img/photo\n```', 'https://img/other\n```');
    pair.de.images['https://img/other'] = { width: 900, height: 600, alt: 'Other' };
    const network = mediaNetwork([]);
    const fetch: Fetch = async (url, init) => {
      if (url.startsWith('/media')) return network(url, init);
      if (url.endsWith('/revisions')) return response([]);
      if (url.endsWith('/alt-audit')) return response(null);
      return response({ ...pair, updatedAt: '2026-10-01T12:00:00Z' });
    };
    let hold = false;
    let expired = false;
    const waiting: PromiseWithResolvers<Response>[] = [];
    const h = loadEditor({
      search: '?tk=tk1', fetch,
      galleryFetch: (url, init) => {
        if (expired) return Promise.resolve(response({}, 401));
        if (!hold) return analyzeRequest(url, init);
        const reply = Promise.withResolvers<Response>();
        waiting.push(reply);
        return reply.promise;
      },
    });
    await h.api.loadPost('tk1');
    await settleAll();
    hold = true;
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    for (const [index, value] of [[0, 'First draft'], [1, 'Second photo'], [0, 'Latest first photo'], [2, '']] as const) {
      fields[index]!.value = value;
      fields[index]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    }
    await settleAll();
    expect(h.api.buildPayload().de.bodyMarkdown).toBe(pair.de.bodyMarkdown);
    expired = true;
    waiting.forEach((reply) => reply.resolve(response({}, 401)));
    await settleAll();
    const stash = JSON.parse(h.local.getItem('swl:draft:tk1')!) as { payload: unknown };
    const recovered = loadEditor({
      isAdmin: true, search: '?tk=tk1', confirm: true, fetch,
      stash: { key: 'swl:draft:tk1', payload: stash.payload },
    });
    await settleAll();
    expect(await recovered.api.doSaveDraft()).toBe(true);
    const request = recovered.requests.find((entry) => entry.url === '/posts/tk1' && entry.options.method === 'PUT')!;
    const sent = JSON.parse(String(request.options.body)) as PostPair;
    const de = await normalizeGalleryFences(sent.de.bodyMarkdown, sent.de.images);
    const en = await normalizeGalleryFences(sent.en.bodyMarkdown, sent.en.images);
    expect(de.images['https://img/photo']?.alt).toBe('Latest first photo');
    expect(de.images['https://img/other']?.alt).toBe('Second photo');
    expect(en.images['https://img/photo']?.alt).toBe('');
    expect(de.bodyMarkdown).toBe(pair.de.bodyMarkdown);
    expect(en.bodyMarkdown).toBe(pair.en.bodyMarkdown);
    expect(sent).not.toHaveProperty('galleryAlts');
    expect(recovered.local.getItem('swl:draft:tk1')).toBeNull();
  });

  it('reanalyzes pending manual descriptions after unrelated source shifts', async () => {
    let hold = false;
    const waiting: { body: string; reply: PromiseWithResolvers<Response> }[] = [];
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => {
        if (!hold) return analyzeRequest(url, init);
        const reply = Promise.withResolvers<Response>();
        waiting.push({ body: JSON.parse(String(init?.body)).bodyMarkdown, reply });
        return reply.promise;
      },
    });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    hold = true;
    const field = h.document.querySelector('.editor-gallery__alt')!;
    field.value = 'Retained description';
    field.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settle();
    h.editors[0]!.value('New introduction\n\n' + pair.de.bodyMarkdown);
    await settle();
    hold = false;
    for (const request of waiting) request.reply.resolve(response(await analyzeGallerySource(request.body)));
    await settleAll();
    const current = h.api.buildPayload();
    expect(current.de.bodyMarkdown.startsWith('New introduction\n\nIntro')).toBe(true);
    expect((await normalizeGalleryFences(current.de.bodyMarkdown, current.de.images)).images['https://img/photo']?.alt)
      .toBe('Retained description');
    expect(current.en).toEqual(pair.en);
  });

  it('does not carry pending descriptions or an awaiting Save into a deliberately loaded post', async () => {
    let hold = false;
    const waiting: { body: string; reply: PromiseWithResolvers<Response> }[] = [];
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => {
        if (!hold) return analyzeRequest(url, init);
        const reply = Promise.withResolvers<Response>();
        waiting.push({ body: JSON.parse(String(init?.body)).bodyMarkdown, reply });
        return reply.promise;
      },
    });
    h.api.populateForm(pairWithGallery());
    await settleAll();
    hold = true;
    const field = h.document.querySelector('.editor-gallery__alt')!;
    field.value = 'Former post edit';
    field.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    await settle();
    const saving = h.api.doSaveDraft();
    const next = pairWithGallery();
    next.de.images['https://img/photo']!.alt = 'New post description';
    h.api.populateForm(next);
    await settle();
    hold = false;
    for (const request of waiting) request.reply.resolve(response(await analyzeGallerySource(request.body)));
    await settleAll();
    expect(await saving).toBe(false);
    expect(h.requests.some((request) => request.options.method === 'POST')).toBe(false);
    expect(h.api.buildPayload().de).toEqual(next.de);
    expect(h.editors[0]!.undoHistory).toEqual([]);
  });

  it('requires explicit AI acceptance and ignores a late answer after manual input or a locale change', async () => {
    let pending = Promise.withResolvers<string>();
    const calls: { lang: string; signal: AbortSignal }[] = [];
    let holdAnalysis = false;
    const analysis = Promise.withResolvers<Response>();
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => holdAnalysis ? analysis.promise : analyzeRequest(url, init),
      caption: (options) => { calls.push(options); return pending.promise; },
    });
    h.api.populateForm(pairWithGallery());
    await settleAll();
    const field = h.document.querySelector('.editor-gallery__alt')!;
    const suggest = h.document.querySelector('.editor-gallery__suggest')!;
    suggest.click();
    pending.resolve('Suggested description');
    await settle();
    expect(h.document.querySelector('.editor-gallery__suggestion')!.hidden).toBe(false);
    expect(field.value).toBe('Original');
    h.document.querySelector('.editor-gallery__suggestion')!.querySelector('button')!.click();
    await settleAll();
    expect(field.value).toBe('Suggested description');
    expect(calls[0]?.lang).toBe('de');
    const beforeManual = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    const undo = [...h.editors[0]!.undoHistory];
    holdAnalysis = true;
    pending = Promise.withResolvers<string>();
    suggest.click();
    field.value = 'My current edit';
    field.dispatchEvent(new EditorEvent('input'));
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(h.api.buildPayload()).toEqual(beforeManual);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.editors[0]!.undoHistory).toEqual(undo);
    pending.resolve('Obsolete answer');
    await settle();
    expect(field.value).toBe('My current edit');
    expect(h.document.querySelector('.editor-gallery__suggestion')!.hidden).toBe(true);
    expect(h.api.buildPayload()).toEqual(beforeManual);
    holdAnalysis = false;
    analysis.resolve(response(await analyzeGallerySource(beforeManual.de.bodyMarkdown)));
    await settleAll();
    expect((await normalizeGalleryFences(h.api.buildPayload().de.bodyMarkdown, beforeManual.de.images))
      .images['https://img/photo']?.alt).toBe('My current edit');
    const beforeLocaleChange = h.api.buildPayload();
    pending = Promise.withResolvers<string>();
    suggest.click();
    h.el('tabbtn-en').click();
    expect(calls[2]?.signal.aborted).toBe(true);
    pending.resolve('Wrong locale answer');
    await settle();
    expect(field.value).toBe('My current edit');
    expect(h.api.buildPayload()).toEqual(beforeLocaleChange);
  });

  it('cancels AI for every occurrence immediately when a manual alt edit cannot be analyzed', async () => {
    let offline = false;
    const analysis = Promise.withResolvers<Response>();
    const answer = Promise.withResolvers<string>();
    const signals: AbortSignal[] = [];
    const h = loadEditor({
      fetch: mediaNetwork([]),
      galleryFetch: (url, init) => offline ? analysis.promise : analyzeRequest(url, init),
      caption: ({ signal }) => { signals.push(signal); return answer.promise; },
    });
    h.api.populateForm(pairWithGallery());
    await settleAll();
    const before = h.api.buildPayload();
    const dirty = h.dirtyCalls();
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    const buttons = h.document.querySelectorAll('.editor-gallery__suggest');
    buttons[0]!.click();
    buttons[1]!.click();
    expect(signals).toHaveLength(2);
    offline = true;
    fields[0]!.value = 'My unsaved description';
    fields[0]!.dispatchEvent(new EditorEvent('input'));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    answer.resolve('Late description');
    analysis.reject(new Error('offline'));
    await settleAll();
    expect(fields[0]!.value).toBe('My unsaved description');
    expect(h.document.querySelectorAll('.editor-gallery__suggestion').every((node) => node.hidden)).toBe(true);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirty);
    expect(h.editors[0]!.undoHistory).toEqual([]);
    const status = h.el('deGalleryView').parentElement!;
    expect(status.textContent).toContain(ui.de['editor.gallery.analysisFailed']);
    expect(status.querySelectorAll('button').some((button) =>
      !button.hidden && button.textContent === ui.de['editor.gallery.retry'])).toBe(true);
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.requests.some((request) => request.options.method === 'POST')).toBe(false);
    expect(h.api.buildPayload()).toEqual(before);
    offline = false;
    status.querySelectorAll('button').find((button) =>
      !button.hidden && button.textContent === ui.de['editor.gallery.retry'])!.click();
    await settleAll();
    const restored = h.api.buildPayload();
    expect((await normalizeGalleryFences(restored.de.bodyMarkdown, restored.de.images)).images['https://img/photo']?.alt)
      .toBe('My unsaved description');
  });

  // #351: a reply cut off at the token limit names that limit; other failures keep the general hint.
  it('shows the token-limit hint for a truncated suggestion and leaves the alt text untouched', async () => {
    let failure = new Error('Caption response was truncated');
    const h = loadEditor({ fetch: mediaNetwork([]), caption: () => Promise.reject(failure) });
    h.api.populateForm(pairWithGallery());
    await settleAll();
    // The gallery-level lookup line shares `.editor-gallery__status`; read the photo card's own.
    const card = h.document.querySelector('.editor-gallery__photo')!;
    const field = card.querySelector('.editor-gallery__alt')!;
    const status = card.querySelector('.editor-gallery__status')!;
    const suggest = card.querySelector('.editor-gallery__suggest')!;
    suggest.click();
    await settle();
    expect(status.textContent).toBe(ui.de['editor.gallery.truncated']);
    expect(field.value).toBe('Original');
    expect(card.querySelector('.editor-gallery__suggestion')!.hidden).toBe(true);
    failure = new Error('Caption request failed. Check the provider, API key, vision model and browser CORS access.');
    suggest.click();
    await settle();
    expect(status.textContent).toBe(ui.de['editor.gallery.failed']);
    expect(field.value).toBe('Original');
  });

  it('shows current Media alt and caption per locale read-only, links to Media, and never edits the article', async () => {
    const row = mediaRow('photo', { de: 'Neu aus der Mediathek', en: 'Fresh from Media' }, { de: '', en: 'Morning light' });
    const pending = Promise.withResolvers<Response>();
    const network = mediaNetwork([row]);
    let waiting = true;
    const h = loadEditor({ fetch: (url, init) =>
      waiting && url === '/media/items/photo' ? pending.promise : network(url, init) });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    const before = h.api.buildPayload();
    // Source analysis completes before any widget exists; until then no
    // editable photo field may be shown from guessed lexical ranges.
    expect(h.document.querySelectorAll('.editor-gallery__alt')).toEqual([]);
    await settleAll();
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    expect(fields.map((field) => field.readOnly)).toEqual([true, true, true, true]);
    expect(h.document.querySelector('.editor-gallery__lookup')!.textContent).toBe(ui.de['editor.gallery.checking']);
    waiting = false;
    pending.resolve(response(row));
    await settleAll();
    expect(fields.map((field) => field.value))
      .toEqual(['Neu aus der Mediathek', 'Neu aus der Mediathek', 'Fresh from Media', 'Fresh from Media']);
    expect(fields.map((field) => field.readOnly)).toEqual([true, true, true, true]);
    // The empty DE Media caption overrides the post's copied "Caption".
    expect(h.document.querySelectorAll('.editor-gallery__caption').map((caption) => caption.hidden ? null : caption.textContent))
      .toEqual([null, null, 'Morning light', 'Morning light']);
    const links = h.document.querySelectorAll('.editor-gallery__media-link');
    expect(links.map((link) => [link.getAttribute('href'), link.target, link.rel, link.parentElement!.hidden]))
      .toEqual(Array(4).fill(['/admin/media.html', '_blank', 'noopener', false]));
    expect(h.document.querySelectorAll('.editor-gallery__source')[0]!.textContent)
      .toContain(ui.de['editor.gallery.fromMedia'] + ' Market at dawn');
    expect(h.document.querySelectorAll('.editor-gallery__suggest').map((button) => button.hidden)).toEqual([true, true, true, true]);
    expect(h.document.querySelectorAll('.editor-gallery__local').map((note) => note.hidden)).toEqual([true, true, true, true]);
    expect(h.document.querySelector('.editor-gallery__lookup')!.textContent).toBe('');
    fields[0]!.value = 'Typed into a locked field';
    fields[0]!.dispatchEvent(new EditorEvent('input', { bubbles: true }));
    expect(h.api.buildPayload()).toEqual(before);
    // Four occurrences across two locales, one request; and only reads.
    expect(h.requests.filter((request) => request.url === '/media/items/photo')).toHaveLength(1);
    expect(h.requests.every((request) => (request.options.method ?? 'GET') === 'GET')).toBe(true);

    // Reopening the article after a Media edit shows the edit.
    row.alt.de = 'Später in der Mediathek geändert';
    h.api.populateForm(pair);
    await settleAll();
    expect(h.document.querySelector('.editor-gallery__alt')!.value).toBe('Später in der Mediathek geändert');
  });

  it('locks alt text and says so when Media cannot answer, and recovers on retry', async () => {
    const row = mediaRow('photo', { de: 'Aus der Mediathek', en: 'From Media' }, { de: '', en: '' });
    let failing = true;
    const network = mediaNetwork([row]);
    const h = loadEditor({ fetch: async (url, init) => failing && url.startsWith('/media/items/')
      ? response({ error: 'database unavailable' }, 500) : network(url, init) });
    h.api.populateForm(pairWithGallery());
    await settleAll();
    const fields = h.document.querySelectorAll('.editor-gallery__alt');
    expect(fields.map((field) => [field.value, field.readOnly]))
      .toEqual([['Original', true], ['Original', true], ['English', true], ['English', true]]);
    const [deStatus, enStatus] = h.document.querySelectorAll('.editor-gallery__lookup');
    expect(deStatus!.textContent).toBe(ui.de['editor.gallery.mediaFailed']);
    expect(enStatus!.textContent).toBe(ui.en['editor.gallery.mediaFailed']);
    expect(h.document.querySelectorAll('.editor-gallery__suggest').every((button) => button.hidden)).toBe(true);
    failing = false;
    const retry = h.document.querySelector('.editor-gallery__retry')!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await settleAll();
    expect(fields.map((field) => field.value)).toEqual(['Aus der Mediathek', 'Aus der Mediathek', 'English', 'English']);
    expect(retry.hidden).toBe(true);
    expect(deStatus!.textContent).toBe('');
  });

  it('ignores a late Media answer that belongs to an earlier load of the article', async () => {
    const late = Promise.withResolvers<Response>();
    let calls = 0;
    const network = mediaNetwork([]);
    const h = loadEditor({ fetch: async (url, init) => {
      if (!url.startsWith('/media/items/')) return network(url, init);
      calls += 1;
      return calls === 1 ? late.promise : response({ error: 'image not found' }, 404);
    } });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    h.api.populateForm(pair);
    await settleAll();
    late.resolve(response(mediaRow('photo', { de: 'Veraltet', en: 'Stale' }, { de: '', en: '' })));
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery__alt').map((field) => [field.value, field.readOnly]))
      .toEqual([['Original', false], ['Original', false], ['English', false], ['English', false]]);
  });

  it('lets Review Story judge gallery alt text by the current Media description', async () => {
    const row = mediaRow('photo', { de: '', en: 'From Media' }, { de: '', en: '' });
    const h = loadEditor({ fetch: mediaNetwork([row]) });
    const pair = pairWithGallery();
    h.api.populateForm(pair);
    await settleAll();
    h.el('reviewStory').click();
    await settleAll();
    // The post still carries a copied alt, but Media's empty one is what renders.
    expect(h.el('reviewInstant').textContent).toContain('Add alt text to this gallery image.');
    h.el('closeReview').click();
    row.alt.de = 'Beschreibung aus der Mediathek';
    pair.de.images = { 'https://img/photo': { width: 900, height: 600, alt: '' } };
    h.api.populateForm(pair);
    await settleAll();
    h.el('reviewStory').click();
    await settleAll();
    expect(h.el('reviewInstant').textContent).not.toContain('Add alt text to this gallery image.');
  });

  it('leaves nested examples and unfinished fences editable, and cancels previews when showing raw Markdown', async () => {
    const h = loadEditor();
    const pair = pairWithGallery();
    pair.de.bodyMarkdown += '\n\n````markdown\n```gallery\nhttps://img/example\n```\n````\n\n```gallery\nhttps://img/unfinished';
    h.api.populateForm(pair);
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(2);
    h.el('deGalleryView').click();
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(1);
    expect(h.api.buildPayload().de.bodyMarkdown).toBe(pair.de.bodyMarkdown);
    h.el('deGalleryView').click();
    await settleAll();
    expect(h.document.querySelectorAll('.editor-gallery')).toHaveLength(2);
  });

  // docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md,
  // "Gallery-local caption controls": the widget must show what the build
  // renders — hidden gallery → nothing; line override → it, empty included;
  // otherwise the current Media caption — per occurrence, not per URL.
  const shownCaptions = (h: { document: { querySelectorAll(selector: string): Element[] } }) =>
    h.document.querySelectorAll('.editor-gallery__caption').map((caption) => caption.hidden ? null : caption.textContent);

  it('shows a gallery-local caption over Media, and none in a gallery whose captions are hidden', async () => {
    const row = mediaRow('photo', { de: 'Markt', en: 'Market' }, { de: 'Aus der Mediathek', en: 'Morning light' });
    const h = loadEditor({ fetch: mediaNetwork([row]) });
    const pair = fullPair();
    pair.de.bodyMarkdown = [
      '```gallery', '#captions: hidden', 'https://img/photo', '```', '',
      '```gallery', 'https://img/photo | caption-override="Nur hier &#124; &quot;lokal&quot; &lt;b&gt;"', '```', '',
      '```gallery', 'https://img/photo | caption-override=""', '```', '',
      '```gallery', 'https://img/photo', '```',
    ].join('\n');
    pair.de.images = { 'https://img/photo': { width: 900, height: 600, alt: 'Kopie', caption: 'Kopie' } };
    pair.en.bodyMarkdown = '```gallery\nhttps://img/photo\n```';
    pair.en.images = { 'https://img/photo': { width: 900, height: 600 } };
    h.api.populateForm(pair);
    const before = h.api.buildPayload();
    // Local captions and hidden galleries need source analysis, not a
    // successful Media description, before the widget can display them.
    await settleAll();
    expect(shownCaptions(h)).toEqual([null, 'Nur hier | "lokal" <b>', null, 'Aus der Mediathek', 'Morning light']);
    expect(h.document.querySelectorAll('.editor-gallery__caption').flatMap((caption) => caption.querySelectorAll('b'))).toEqual([]);
    expect(h.document.querySelectorAll('.editor-gallery')
      .map((gallery) => gallery.textContent.includes(ui.de['editor.gallery.captionsHidden'])))
      .toEqual([true, false, false, false, false]);
    expect(h.api.buildPayload()).toEqual(before);
  });

  it('edits captions for one gallery through the picker, and a save and reopen keep them on that gallery only', async () => {
    const photo = 'https://img/photo';
    const other = 'https://img/other';
    const row = { ...mediaRow('photo', { de: 'Markt', en: 'Market' }, { de: 'Aus der Mediathek', en: 'From Media' }), width: 900, height: 600 };
    const placeholder = { src: other, width: 300, height: 200, fromPost: true };
    const h = loadEditor({ fetch: mediaNetwork([row]) });
    const pair = fullPair();
    pair.de.bodyMarkdown = [
      'Intro', '', '```gallery', '#layout: slider', '# shot on the pass', photo + ' | caption-override=""', other, '```',
      '', 'Middle', '', '```gallery', photo, '```',
    ].join('\n');
    pair.de.images = {
      [photo]: { width: 900, height: 600, alt: 'Kopie', caption: 'Kopie' },
      [other]: { width: 300, height: 200, alt: 'Andere', caption: 'Gespeichert' },
    };
    h.api.populateForm(pair);
    await settleAll();
    const editGallery = async (index: number) => {
      h.document.querySelectorAll('.editor-gallery')[index]!.querySelector('.editor-gallery__head')!.querySelector('button')!.click();
      await settleAll();
      const picker = h.galleryPickers.at(-1);
      if (!picker) throw new Error('Edit did not open the gallery picker');
      return picker;
    };
    const fences = (body: string) => body.split(/\n\n(?:Middle\n\n)?/).filter((part) => part.startsWith('```gallery'));
    const lineOf = (fence: string, src: string) => fence.split('\n').find((line) => line.split('|')[0]!.trim() === src) ?? '';

    const first = await editGallery(0);
    expect(first.captions).toMatchObject({ locale: 'de', visible: true, overrides: { [photo]: '' } });
    expect(first.captions?.fallback[other]).toBe('Gespeichert');
    // The author resets the photo to Media, edits the other one, and hides captions.
    const local = 'Nur | "hier"\nzwei';
    await first.onPick([row, placeholder], { layout: 'slider', captions: { visible: false, overrides: { [other]: local } } });

    const edited = h.api.buildPayload().de;
    // The caret is parked past the blank line after the updated gallery — on
    // "Middle" — not on its closing ```, where the next upload would reopen
    // the fence over the rest of the story (#333).
    const caret = h.editors[0]!.codemirror.indexFromPos(h.editors[0]!.cursor!);
    expect(edited.bodyMarkdown.slice(caret, caret + 'Middle'.length)).toBe('Middle');
    expect(edited.bodyMarkdown.slice(0, caret).endsWith('```\n\n')).toBe(true);
    const saved = await normalizeGalleryFences(edited.bodyMarkdown, edited.images);
    // The shared images map keeps Media's / the stored caption: the edit is not in it.
    expect(saved.images[other]).toEqual({ width: 300, height: 200, alt: 'Andere', caption: 'Gespeichert' });
    expect(saved.images[photo]).toMatchObject({ alt: 'Markt', caption: 'Aus der Mediathek' });
    const [hiddenFence, otherFence] = fences(saved.bodyMarkdown);
    expect(readCaptionsVisible(hiddenFence!)).toBe(false);
    expect(hiddenFence).toContain('#layout: slider');
    expect(hiddenFence).toContain('# shot on the pass');
    expect(readCaptionOverride(lineOf(hiddenFence!, photo))).toBeUndefined();
    expect(readCaptionOverride(lineOf(hiddenFence!, other))).toBe(local);
    expect(readCaptionsVisible(otherFence!)).toBe(true);
    expect(readCaptionOverride(lineOf(otherFence!, photo))).toBeUndefined();

    // Reopen the saved article: the hidden gallery stays hidden, the other follows Media.
    h.api.populateForm({ ...pair, de: { ...pair.de, ...saved } });
    await settleAll();
    expect(shownCaptions(h)).toEqual([null, null, 'Aus der Mediathek']);
    const reopened = await editGallery(0);
    expect(reopened.captions).toMatchObject({ locale: 'de', visible: false, overrides: { [other]: local } });
    expect(reopened.captions?.overrides).not.toHaveProperty(photo);

    // Showing captions again removes only the captions directive and keeps the text.
    await reopened.onPick([row, placeholder], { layout: 'slider', captions: { visible: true, overrides: { [other]: local } } });
    const [shownFence] = fences(h.api.buildPayload().de.bodyMarkdown);
    expect(readCaptionsVisible(shownFence!)).toBe(true);
    expect(shownFence).not.toMatch(/#\s*captions/i);
    expect(shownFence).toContain('#layout: slider');
    expect(shownFence).toContain('# shot on the pass');
    expect(readCaptionOverride(lineOf(shownFence!, other))).toBe(local);
    await settleAll();
    // CodeMirror owns widget placement; the harness appends recreated widgets.
    // Assert caption membership by gallery identity, not DOM insertion order.
    const captionsIn = (label: string) => {
      const gallery = h.document.querySelectorAll('.editor-gallery')
        .find((node) => node.getAttribute('aria-label') === label)!;
      return gallery.querySelectorAll('.editor-gallery__caption')
        .map((caption) => caption.hidden ? null : caption.textContent);
    };
    expect(captionsIn('Galerie 1')).toEqual(['Aus der Mediathek', local]);
    expect(captionsIn('Galerie 2')).toEqual(['Aus der Mediathek']);
    expect(h.requests.every((request) => (request.options.method ?? 'GET') === 'GET')).toBe(true);
  });
});

describe('manuscript-first editor refinements', () => {
  const emptyAudit = { count: 0, images: [] };
  const copy = ui.en;
  const saved = fullPair();
  const readPost: Fetch = async (url) => response(url.endsWith('/alt-audit') ? emptyAudit : url.endsWith('/revisions') ? [] : saved);

  it('keeps grouped advisory issues collapsed without stealing focus, and preserves disclosure/focus on refresh', () => {
    const h = loadEditor();
    const audit: AltAudit = { count: 3, images: [
      { locale: 'de', kind: 'gallery', src: 'https://img/one', reason: 'filename' },
      { locale: 'en', kind: 'body', src: 'https://img/<img onerror=alert(1)>', reason: 'empty' },
      { locale: 'de', kind: 'hero', src: 'https://img/hero', reason: 'repeats-title' },
    ] };
    h.el('deTitle').focus();
    h.api.renderAltAudit(audit, false);
    expect(h.el('altAudit').hidden).toBe(false);
    expect(h.el('altAudit').open).toBe(false);
    expect(h.el('altAuditSummary').getAttribute('role')).toBe('status');
    expect(h.document.activeElement).toBe(h.el('deTitle'));
    const list = h.el('altAuditList');
    expect(list.querySelectorAll('h3').map((heading) => heading.textContent)).toEqual([
      'DE · ' + copy['editor.chrome.auditFilename'], 'EN · ' + copy['editor.chrome.auditEmpty'], 'DE · ' + copy['editor.chrome.auditTitle'],
    ]);
    expect(list.querySelectorAll('button').map((button) => button.textContent)).toEqual([
      copy['editor.chrome.auditGallery'] + ' — one',
      copy['editor.chrome.auditBody'] + ' — <img onerror=alert(1)>',
      copy['editor.chrome.auditHero'] + ' — hero',
    ]);
    expect(list.querySelector('img')).toBeNull();
    h.el('altAudit').open = true;
    list.querySelector('button')!.focus();
    h.api.renderAltAudit(audit, false);
    expect(h.el('altAudit').open).toBe(true);
    expect(h.document.activeElement).toBe(list.querySelector('button'));
    h.el('altAudit').querySelector('summary')!.focus();
    h.api.renderAltAudit(emptyAudit, false);
    expect(h.el('altAudit').hidden).toBe(true);
    expect(h.document.activeElement).toBe(h.el('deTitle'));
  });

  it('opens the warned locale and targets the matching photo across galleries, including raw Markdown mode', async () => {
    const h = loadEditor({ mobile: true });
    const pair = fullPair();
    pair.en.bodyMarkdown = '```gallery\nhttps://img/first\n```\n\nText\n\n```gallery\nhttps://img/target\n```';
    pair.en.images = {
      'https://img/first': { width: 900, height: 600, alt: 'First' },
      'https://img/target': { width: 900, height: 600, alt: 'Target' },
    };
    h.api.populateForm(pair);
    await settle();
    h.el('tabbtn-en').click();
    h.el('enGalleryView').click();
    h.el('tabbtn-de').click();
    const before = h.api.buildPayload();
    h.api.renderAltAudit({ count: 1, images: [{ locale: 'en', kind: 'gallery', src: 'https://img/target', reason: 'filename' }] }, false);
    h.el('altAudit').open = true;
    h.el('altAuditList').querySelector('button')!.click();
    await settle();
    h.flushDialogEvents();
    expect(h.el('tab-en').hidden).toBe(false);
    expect(h.el('enGalleryView').getAttribute('aria-pressed')).toBe('false');
    expect(h.document.activeElement?.classList.contains('editor-gallery__alt')).toBe(true);
    expect(h.document.activeElement?.value).toBe('Target');
    expect(h.api.buildPayload()).toEqual(before);
  });

  it('selects the real body image alt instead of matching a code example or ordinary link', async () => {
    const h = loadEditor();
    const pair = fullPair();
    pair.de.bodyMarkdown = '`![example](https://img/body)`\n\n[Link](https://img/body)\n\n![file\\]name](<https://img/body> "title")';
    h.api.populateForm(pair);
    h.api.renderAltAudit({ count: 1, images: [{ locale: 'de', kind: 'body', src: 'https://img/body', reason: 'filename' }] }, false);
    h.el('altAuditList').querySelector('button')!.click();
    await settle();
    const editor = h.editors[0]!;
    expect(h.document.activeElement).toBe(editor.input);
    expect(editor.codemirror.getRange(editor.selection!.from, editor.selection!.to)).toBe('file\\]name');
    expect(editor.value()).toBe(pair.de.bodyMarkdown);
  });

  it.each(['gallery', 'hero'] as const)('does not jump to a different %s photo when a saved warning is stale', async (kind) => {
    const h = loadEditor();
    h.api.populateForm(fullPair());
    h.api.renderAltAudit({ count: 1, images: [{ locale: 'de', kind, src: 'https://img/removed', reason: 'empty' }] }, false);
    const before = h.api.buildPayload();
    h.el('altAuditList').querySelector('button')!.click();
    await settle();
    expect(h.el('altAuditFeedback').hidden).toBe(false);
    expect(h.el('altAuditFeedback').textContent).toBe(copy['editor.chrome.auditMissing']);
    expect(h.document.activeElement).not.toBe(h.el('deGallery'));
    expect(h.document.activeElement).not.toBe(h.el('deHeroAlt'));
    expect(h.api.buildPayload()).toEqual(before);
  });

  it('normalizes pasted title line breaks without renaming a loaded slug or interrupting composition', () => {
    const h = loadEditor();
    h.api.populateForm(fullPair());
    const title = h.el('deTitle');
    title.value = 'Über die Berge\r\nund ans Meer';
    title.setSelectionRange(16, 16);
    title.fire('input');
    expect(title.value).toBe('Über die Berge und ans Meer');
    expect(title.selectionStart).toBe(15);
    expect(h.api.buildPayload().de.title).toBe(title.value);
    expect(h.api.buildPayload().de.slug).toBe('bukarest');
    title.value = '一\n二';
    title.setSelectionRange(3, 3);
    title.dispatchEvent(new EditorEvent('input', { bubbles: true, isComposing: true }));
    expect(title.value).toBe('一\n二');
    title.fire('compositionend');
    expect(title.value).toBe('一 二');
    expect(title.fire('keydown', { key: 'Enter' }).defaultPrevented).toBe(true);
    const composing = new EditorEvent('keydown', { key: 'Enter', cancelable: true, isComposing: true });
    title.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
  });

  it('reports loaded, edited, in-flight and saved states without clearing edits made during a save', async () => {
    const pending = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let firstSave = true;
    const h = loadEditor({ fetch: async (url, options) => {
      if (options?.method !== 'PUT') return readPost(url, options);
      if (firstSave) { firstSave = false; started.resolve(); return pending.promise; }
      return response(saved);
    } });
    await h.api.loadPost('tk1');
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveSaved']);
    expect(h.el('draftSaveState').getAttribute('role')).toBe('status');
    h.el('deTitle').value = 'First edit';
    h.el('deTitle').fire('input');
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveUnsaved']);
    const saving = h.api.doSaveDraft();
    await started.promise;
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveSaving']);
    h.el('deTitle').value = 'Newer edit';
    h.el('deTitle').fire('input');
    pending.resolve(response(saved));
    expect(await saving).toBe(true);
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveUnsaved']);
    expect(h.el('actionStatus').textContent).toBe(copy['editor.chrome.saveNewer']);
    expect(h.api.buildPayload().de.title).toBe('Newer edit');
    expect(await h.api.doSaveDraft()).toBe(true);
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveSaved']);
  });

  it.each(['network', 500, 409, 401])('keeps edited content unsaved when saving fails (%s)', async (failure) => {
    const h = loadEditor({ fetch: async (url, options) => {
      if (options?.method !== 'PUT') return readPost(url, options);
      if (failure === 'network') throw new Error('offline');
      return response({ code: 'conflict', error: 'Save refused' }, Number(failure));
    } });
    await h.api.loadPost('tk1');
    h.el('deTitle').value = 'Keep this draft';
    h.el('deTitle').fire('input');
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveUnsaved']);
    expect(h.api.buildPayload().de.title).toBe('Keep this draft');
    if (failure === 401) {
      expect(h.redirects()).toBe(1);
      const stash = h.local.key(0)!;
      expect(JSON.parse(h.local.getItem(stash)!).payload.de.title).toBe('Keep this draft');
    } else expect(h.el('actionError').hidden).toBe(false);
  });

  it('keeps a cancelled URL change unsaved without sending a write', async () => {
    const h = loadEditor({ fetch: readPost });
    await h.api.loadPost('tk1');
    h.el('slugFieldDe').value = 'new-slug';
    h.el('slugFieldDe').fire('input');
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.requests.filter((request) => request.options.method === 'PUT')).toEqual([]);
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveUnsaved']);
  });

  it('offers the existing recovery stash after loading and keeps the restored draft unsaved', async () => {
    const restored = fullPair();
    restored.de.title = 'Recovered local title';
    restored.de.slug = 'd'.repeat(252);
    restored.en.slug = 'e'.repeat(8192);
    const h = loadEditor({ isAdmin: true, search: '?tk=tk1', confirm: true,
      stash: { key: 'swl:draft:tk1', payload: restored }, fetch: readPost });
    await settle();
    expect(h.el('deTitle').value).toBe('Recovered local title');
    expect(h.el('draftSaveState').textContent).toBe(copy['editor.chrome.saveUnsaved']);
    expect(h.local.getItem('swl:draft:tk1')).not.toBeNull();
    h.el('deTitle').value = 'Edited after stash restoration';
    h.el('deTitle').fire('input');
    h.el('enTitle').value = 'Edited after stash restoration';
    h.el('enTitle').fire('input');
    expect(h.api.buildPayload().de.slug).toBe(restored.de.slug);
    expect(h.api.buildPayload().en.slug).toBe(restored.en.slug);
  });
});

describe('country and excerpt assistance in the real editor', () => {
  it('treats reloaded automatic coordinates as author-owned before another country edit', () => {
    const h = loadEditor();
    h.el('deCountry').value = 'Griechenland';
    h.el('deCountry').fire('change');
    const saved = h.api.buildPayload();
    expect(saved.shared.coordinates).toEqual({ lat: 39.4928, lng: 21.7257 });
    expect(saved.shared.countryCode).toBe('GR');
    h.api.populateForm(saved);
    h.el('deCountry').value = 'Ecuador';
    h.el('deCountry').fire('change');
    expect(h.api.buildPayload().shared.coordinates).toEqual(saved.shared.coordinates);
    expect(h.api.buildPayload().shared.countryCode).toBe('GR');
    expect(h.el('useCountryCenter').hidden).toBe(false);
  });

  it('generates from the unsaved active-language manuscript and only replaces an excerpt on acceptance', async () => {
    const suggestion = 'A quiet walk through Bucharest, from the station to the old town, with a stop at the market and notes from the route.';
    const h = loadEditor({ fetch: reviewNetwork(async () => response({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ excerpt: suggestion }) } }],
    })) });
    h.api.populateForm(fullPair());
    h.el('tabbtn-en').click();
    h.editors[1]!.value('## Morning walk\nWe walked from the station to the old town and stopped at the market.');
    const before = h.api.buildPayload();
    required(h.el('enExcerptAssist'), '[data-excerpt-action="generate"]').click();
    await settle();
    expect(h.api.buildPayload()).toEqual(before);
    const request = h.requests.find(({ url }) => url === providerUrl)!;
    const messages = JSON.parse(String(request.options.body)).messages as { role: string; content: string }[];
    expect(JSON.parse(messages.find(({ role }) => role === 'user')!.content)).toEqual({
      locale: 'en', title: before.en.title, markdown: before.en.bodyMarkdown,
    });
    required(h.el('enExcerptAssist'), '[data-excerpt-action="apply"]').click();
    expect(h.api.buildPayload().en.excerpt).toBe(suggestion);
    expect(h.api.buildPayload().de).toEqual(before.de);
    expect(h.el('draftSaveState').textContent).toBe(ui.en['editor.chrome.saveUnsaved']);
    expect(h.requests.filter(({ url }) => url.startsWith('/posts'))).toEqual([]);
  });

  it('invalidates excerpt work when the actual CodeMirror manuscript changes', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: reviewNetwork(() => pending.promise) });
    h.api.populateForm(fullPair());
    required(h.el('deExcerptAssist'), '[data-excerpt-action="generate"]').click();
    await settle();
    h.editors[0]!.value('## A different route\nA new unsaved account.');
    pending.resolve(response({ choices: [{ message: { content: JSON.stringify({ excerpt: 'Outdated suggestion' }) } }] }));
    await settle();
    expect(required(h.el('deExcerptAssist'), '.excerpt-assist__suggestion').hidden).toBe(true);
    expect(h.api.buildPayload().de.excerpt).toBe('x');
    expect(h.requests.find(({ url }) => url === providerUrl)!.options.signal?.aborted).toBe(true);
  });
});

describe('editor region select', () => {
  it('offers exactly the closed region set, in display order, after the blank prompt', () => {
    // The page cannot import db.ts; a missing option would make a region the
    // server accepts unpickable, an extra one a save the server rejects.
    const select = /<select id="fmRegion">([\s\S]*?)<\/select>/.exec(markup)?.[1] ?? '';
    const values = [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(['', ...REGIONS]);
  });
});

describe('restoring a local draft keeps the version it was edited against (#345)', () => {
  const V1 = '2026-10-27T11:20:26.092Z';
  const V2 = '2026-10-27T11:25:00.000Z';
  const copy = ui.en;
  type Stored = PostPair & { updatedAt: string };
  interface VersionedServer { fetch: Fetch; stored(): Stored; writes: unknown[] }
  const isPut = (request: { options: RequestInit }) => request.options.method === 'PUT';

  // PUT /posts/:tk as server.ts answers it: the echo is optional (absent skips
  // the check — the bypass a restore must never produce), an unparsable one is
  // a 400, and staleness is the store's real rule.
  function versionedServer(initial: Stored): VersionedServer {
    let stored = structuredClone(initial);
    const writes: unknown[] = [];
    const fetch: Fetch = async (url, options) => {
      if (url === '/posts/tk1' && options?.method === 'PUT') {
        const { updatedAt, ...pair } = JSON.parse(String(options.body)) as PostPair & { updatedAt?: unknown };
        let base: Date | undefined;
        if (updatedAt !== undefined && updatedAt !== null) {
          base = new Date(String(updatedAt));
          if (Number.isNaN(base.getTime())) return response({ error: 'invalid updatedAt' }, 400);
        }
        try { assertNotStale(new Date(stored.updatedAt), base); }
        catch (error) { return response({ error: (error as Error).message, code: 'conflict' }, 409); }
        stored = { ...stored, ...pair, updatedAt: new Date(Date.parse(stored.updatedAt) + 60_000).toISOString() };
        writes.push(pair);
        return response(stored);
      }
      if (url === '/posts/tk1') return response(stored);
      return response(url.endsWith('/alt-audit') ? { count: 0, images: [] } : []);
    };
    return { fetch, stored: () => stored, writes };
  }
  // v2: another tab or user saved a new EN title after the stash was taken.
  const serverV2 = (): Stored => {
    const pair = fullPair();
    pair.en.title = 'Newer EN saved elsewhere';
    return { ...pair, updatedAt: V2 };
  };
  const stashOf = (updatedAt: unknown) => {
    const pair = fullPair();
    pair.de.title = 'Stashed DE edit';
    return { ...pair, updatedAt };
  };
  // Accept the restore; Cancel the conflict reload so the draft stays on screen.
  const open = (server: VersionedServer, payload: unknown) => loadEditor({
    isAdmin: true, search: '?tk=tk1', fetch: server.fetch,
    stash: { key: 'swl:draft:tk1', payload },
    confirm: (prompt) => prompt.title === copy['editor.chrome.restoreTitle'],
  });

  it('sends the stash base, so a v1 draft reaches the conflict dialog instead of overwriting v2', async () => {
    const server = versionedServer(serverV2());
    const h = open(server, stashOf(V1));
    await settle();
    expect(h.prompts[0]!.title).toBe(copy['editor.chrome.restoreTitle']);
    expect(h.prompts[0]!.body).toContain(copy['editor.chrome.restoreStale']);
    expect(h.el('actionStatus').textContent).toBe(copy['editor.chrome.restoredStale']);
    expect(h.el('deTitle').value).toBe('Stashed DE edit');
    // Also what any re-stash of the restored form records: the base is not laundered.
    expect(h.api.buildPayload().updatedAt).toBe(V1);

    expect(await h.api.doSaveDraft()).toBe(false);
    const puts = h.requests.filter(isPut);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]!.options.body)).updatedAt).toBe(V1);
    expect(server.writes).toEqual([]);
    expect(server.stored().en.title).toBe('Newer EN saved elsewhere');
    expect(server.stored().de.title).toBe('Bukarest');
    expect(h.prompts.map((prompt) => prompt.title)).toContain('Reload the latest version?');
    expect(h.el('deTitle').value).toBe('Stashed DE edit');
  });

  it('restores and saves both locales when the stash base is the stored version', async () => {
    const server = versionedServer({ ...fullPair(), updatedAt: V1 });
    const stash = stashOf(V1);
    stash.en.title = 'Stashed EN edit';
    const h = open(server, stash);
    await settle();
    expect(h.prompts[0]!.body).not.toContain(copy['editor.chrome.restoreStale']);
    expect(h.prompts[0]!.body).not.toContain(copy['editor.chrome.restoreUnknownBase']);
    expect(h.el('actionStatus').textContent).toBe(copy['editor.chrome.restored']);
    expect(await h.api.doSaveDraft()).toBe(true);
    expect(server.stored().de.title).toBe('Stashed DE edit');
    expect(server.stored().en.title).toBe('Stashed EN edit');
    expect(h.local.getItem('swl:draft:tk1')).toBeNull();
    h.el('deTitle').value = 'Edited after the restore';
    h.el('deTitle').fire('input');
    expect(await h.api.doSaveDraft()).toBe(true); // the token followed the save
    expect(server.stored().de.title).toBe('Edited after the restore');
  });

  it.each([
    ['missing (legacy stash)', undefined],
    ['unparsable', 'not-a-date'],
    ['not a string', Date.parse(V1)],
    ['empty', ''],
    ['newer than the stored version', '2999-01-01T00:00:00.000Z'],
  ])('blocks saving a restored draft whose base is %s, without sending a write', async (_label, base) => {
    const server = versionedServer(serverV2());
    const h = open(server, stashOf(base));
    await settle();
    expect(h.prompts[0]!.body).toContain(copy['editor.chrome.restoreUnknownBase']);
    expect(h.el('actionError').textContent).toBe(copy['editor.chrome.restoreBlocked']);
    // The text is on screen to copy out, and a re-stash records no base either.
    expect(h.el('deTitle').value).toBe('Stashed DE edit');
    expect(h.api.buildPayload().updatedAt).toBeUndefined();
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.el('actionError').textContent).toBe(copy['editor.chrome.restoreBlocked']);
    h.el('previewBtn').click();
    h.el('publishBtn').click();
    await settle();
    expect(h.requests.filter(isPut)).toEqual([]);
    expect(h.requests.filter(({ url }) => url.endsWith('/publish'))).toEqual([]);
    expect(server.writes).toEqual([]);
    expect(server.stored().en.title).toBe('Newer EN saved elsewhere');
    expect(JSON.parse(h.local.getItem('swl:draft:tk1')!).payload.de.title).toBe('Stashed DE edit');
  });

  it('keeps a new-post stash tokenless, so its first save still creates', async () => {
    // JSON drops the undefined key: what a never-saved post's stash holds.
    const payload = { ...minimalPair(), translationKey: undefined };
    const h = loadEditor({ isAdmin: true, confirm: true, stash: { key: 'swl:draft:new', payload } });
    await settle();
    expect(h.prompts[0]!.body).toBe(copy['editor.chrome.restoreBody'].replace('{time}', new Date('2026-10-01T12:00:00Z').toLocaleString()));
    expect(h.el('actionError').hidden).toBe(true);
    expect(h.el('deTitle').value).toBe('X');
    expect(h.api.buildPayload().updatedAt).toBeUndefined();
    expect(h.api.buildPayload().translationKey).toBeUndefined();
  });

  it('keeps the live slugs of a post published since the stash, not stash slugs the author cannot edit', async () => {
    const server = versionedServer({ ...serverV2(), status: 'published' });
    const stash = stashOf(V1);
    stash.de.slug = 'alter-entwurf';
    stash.en.slug = 'old-draft';
    const h = open(server, stash);
    await settle();
    expect([h.el('slugFieldDe').value, h.el('slugFieldEn').value]).toEqual(['bukarest', 'bucharest']);
    expect(h.el('slugFieldDe').disabled).toBe(true);
    expect(h.el('actionStatus').textContent).toBe(copy['editor.chrome.restoredStale'] + ' ' + copy['editor.chrome.restoreSlugsKept']);
    expect(h.el('deTitle').value).toBe('Stashed DE edit');
    expect(await h.api.doSaveDraft()).toBe(false);
    const sent = JSON.parse(String(h.requests.filter(isPut)[0]!.options.body));
    expect([sent.de.slug, sent.en.slug]).toEqual(['bukarest', 'bucharest']);
    expect(server.writes).toEqual([]);
  });

  it('blocks saving and keeps the untouched stash when the restore fails part-way (#332)', async () => {
    const server = versionedServer({ ...fullPair(), updatedAt: V1 });
    const stash = stashOf(V1);
    stash.de.bodyMarkdown = 'Stashed German body';
    stash.en.title = 'Stashed EN title';
    const h = open(server, stash);
    const value = h.editors[0]!.value.bind(h.editors[0]);
    h.editors[0]!.value = (text?: string) => {
      const result = value(text); // DE fields already replaced, EN not yet
      if (text === 'Stashed German body') throw new Error('forced restore failure');
      return result;
    };
    await settle();
    expect(h.el('actionError').textContent).toBe(ui.en['editor.chrome.reloadFailed']);
    expect(await h.api.doSaveDraft()).toBe(false);
    expect(h.requests.filter(isPut)).toEqual([]);
    expect(JSON.parse(h.local.getItem('swl:draft:tk1')!).payload).toEqual(JSON.parse(JSON.stringify(stash)));
  });
});
