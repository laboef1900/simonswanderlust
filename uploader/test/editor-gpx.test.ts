import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as geometry from '../public/gpx-geometry.js';
import * as publicTrack from '../public/gpx-public-track.js';
import { editorDocument, EditorElement, EditorEvent } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
import { memoryPostStore, type PostPair } from '../src/posts.js';

const html = readFileSync('public/editor.html', 'utf8');
const markup = html.slice(0, html.lastIndexOf('<script>'));
const script = readFileSync('public/editor-gpx.js', 'utf8');
const preview = {
  importId: 'a'.repeat(64), expiresAt: '2026-10-24T12:00:00.000Z',
  geometry: { version: 1, segments: [{ points: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }, { lng: 1.2, lat: 2.2 }] }] },
  waypoints: [] as { name: string; lat: number; lng: number }[],
  counts: { tracks: 1, routes: 0, sourceSegments: 1, inputPoints: 3, points: 3, segments: 1, waypoints: 0, droppedSegments: 0, antimeridianSplits: 0 },
};
const response = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
// VM selections and the imported ESM have different Object prototypes.
// Transfer the selection as browser JSON would; retain the real validator.
const browserGeometry = {
  ...geometry,
  trimGeometry: (value: Parameters<typeof geometry.trimGeometry>[0], selection: Parameters<typeof geometry.trimGeometry>[1]) =>
    geometry.trimGeometry(value, structuredClone(selection)),
};
const browserPublicTrack = {
  validatePublicTrack: (value: unknown) => publicTrack.validatePublicTrack(structuredClone(value)),
};
class CandidateWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  input: Parameters<typeof publicTrack.createPublicTrack>[0] | null = null;
  constructor(readonly url: string, readonly options: { type: string }) {}
  postMessage(input: { geometry: Parameters<typeof publicTrack.createPublicTrack>[0] }) {
    this.input = structuredClone(input.geometry);
    queueMicrotask(() => { if (!this.terminated) this.complete(); });
  }
  complete() {
    try { this.reply({ ok: true, result: publicTrack.createPublicTrack(this.input!) }); }
    catch (error) {
      const code = error instanceof Error ? ('code' in error ? error.code : error.message) : 'gpx_worker_failed';
      this.reply({ ok: false, code });
    }
  }
  reply(data: unknown) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}
function manualCandidates() {
  const jobs: CandidateWorker[] = [];
  class ManualWorker extends CandidateWorker {
    override postMessage(input: { geometry: Parameters<typeof publicTrack.createPublicTrack>[0] }) {
      this.input = structuredClone(input.geometry);
      jobs.push(this);
    }
  }
  return { jobs, Worker: ManualWorker };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const emptyRoute = { version: null, geometry: null, originalAvailable: false, sourceBytes: null };
const attachedRoute = { version: 'c'.repeat(36), geometry: preview.geometry, originalAvailable: true, sourceBytes: 2048 };
interface Reply { status: number; ok: boolean; json(): Promise<unknown> }
type RequestRecord = { url: string; options: RequestInit };
interface SetupOptions {
  newPost?: boolean;
  route?: unknown;
  confirm?: boolean;
  failAttach?: boolean;
  failSave?: boolean;
  preview?: typeof preview;
  Worker?: typeof CandidateWorker;
  locale?: 'de' | 'en';
  fetch?: (url: string, request: RequestInit) => Promise<Reply | undefined>;
}

function gpxDocument() {
  const dom = editorDocument(markup);
  // The shared harness intentionally implements only a CSS subset. GPX uses
  // :checked; implement its actual DOM semantics rather than making every
  // selection silently empty (or changing the production controller).
  const supportChecked = (element: EditorElement) => {
    const matches = element.matches.bind(element);
    element.matches = (selector: string) => selector.split(',').some((part) =>
      (!part.includes(':checked') || element.checked) && matches(part.replace(/:checked/g, '')));
    return element;
  };
  dom.document.querySelectorAll('*').forEach(supportChecked);
  const create = dom.document.createElement;
  dom.document.createElement = (tag: string) => supportChecked(create(tag));
  return dom;
}

type HostState = { tk: string | null; baseUpdatedAt: string };
interface GpxTestHarness {
  api: { refresh(): Promise<boolean>; hasPreview(): boolean; publishVersion(): string | null; publishError(code: string): string | null };
  element(id: string): EditorElement;
  requests: { url: string; options: RequestInit }[];
  state: HostState;
  saveCalls: number;
}
function setup(options: SetupOptions = {}) {
  const dom = gpxDocument();
  const requests: { url: string; options: RequestInit }[] = [];
  const state: HostState = { tk: options.newPost ? null : 'pair-1', baseUpdatedAt: '2026-10-24T10:00:00.000Z' };
  const route = options.route ?? emptyRoute;
  const candidate = options.preview ?? preview;
  const adopted: { name: string; lat: number; lng: number }[][] = [];
  const renders: unknown[] = [];
  let saveCalls = 0;
  const fetcher = async (url: string, request: RequestInit = {}) => {
    requests.push({ url, options: request });
    const override = await options.fetch?.(url, request);
    if (override) return override;
    if (url.endsWith('/route') && request.method === 'GET') return response(route);
    if (url === '/gpx/imports' && request.method === 'POST') return response(candidate, 201);
    if (url.endsWith('/route') && request.method === 'PUT') return options.failAttach
      ? response({ error: 'gpx_conflict' }, 409)
      : response({ version: 'b'.repeat(36), geometry: preview.geometry, originalAvailable: true, sourceBytes: 2048, updatedAt: '2026-10-24T10:01:00.000Z', cleanupPending: false });
    if (url.endsWith('/route') && request.method === 'DELETE') return response({ ...emptyRoute, version: 'd'.repeat(36), updatedAt: '2026-10-24T10:02:00.000Z' });
    if (url.startsWith('/gpx/imports/') && request.method === 'DELETE') return response({}, 204);
    throw new Error('unexpected request ' + url);
  };
  class FormDataMock { append() {} }
  const context: Record<string, unknown> = {
    document: dom.document,
    location: { href: 'http://localhost/admin/editor.html', origin: 'http://localhost', assign() {} },
    fetch: fetcher,
    FormData: FormDataMock,
    AbortController,
    Worker: options.Worker ?? CandidateWorker,
    URL,
    console,
    setTimeout,
    clearTimeout,
    GpxCopy: { en: new Proxy<Record<string, string>>({ unknown: ui.en['gpx.unknown'] }, { get: (target, key) => target[String(key)] ?? String(key) }) },
    addEventListener: dom.document.addEventListener,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'editor-gpx.js' });
  const host = {
    getPost: () => ({ ...state }),
    runWrite: async <T>(write: (saveDraft: () => Promise<boolean>) => Promise<T>) => write(async () => {
      saveCalls++;
      if (options.failSave) return false;
      state.tk = 'new-pair';
      state.baseUpdatedAt = '2026-10-24T10:00:30.000Z';
      return true;
    }),
    setBaseUpdatedAt: (value: string) => { state.baseUpdatedAt = value; },
    adoptStops(stops: { name: string; lat: number; lng: number }[]) { adopted.push(stops); },
    inspector: { isOpen: () => false, close() {}, open() {}, reveal(target: EditorElement) { target.focus(); } },
    on401() {},
    confirm: async () => options.confirm ?? true,
    copy: options.locale
      ? Object.fromEntries(Object.entries(ui[options.locale]).filter(([key]) => key.startsWith('gpx.')).map(([key, value]) => [key.slice(4), value]))
      : context.GpxCopy && (context.GpxCopy as { en: Record<string, string> }).en,
    mapCopy: {},
    map: { create: async () => ({ render(value: unknown) { renders.push(value); }, destroy() {}, resize() {} }) },
    loadGeometry: async () => browserGeometry,
    loadPublicTrack: async () => browserPublicTrack,
  };
  const api = (context.GpxEditor as { wire(host: unknown): GpxTestHarness['api'] }).wire(host);
  const element = (id: string) => {
    const el = dom.document.getElementById(id);
    if (!el) throw new Error('missing #' + id);
    return el;
  };
  return { api, element, requests, state, adopted, renders, get focused() { return dom.document.activeElement; }, get saveCalls() { return saveCalls; } };
}

function startImport(h: GpxTestHarness) {
  if (!h.element('gpxDialog').open) h.element('gpxImportOpen').click();
  const input = h.element('gpxFile') as EditorElement & { files: File[] };
  input.files = [{ name: 'walk.gpx', size: 10 } as File];
  input.fire('change');
}
async function importPreview(h: GpxTestHarness) {
  startImport(h);
  await settle();
}

const routeWrites = (h: { requests: RequestRecord[] }) => h.requests.filter(({ url, options }) =>
  url.endsWith('/route') && (options.method === 'PUT' || options.method === 'DELETE'));
function check(h: GpxTestHarness, id: string, value = true) {
  h.element(id).checked = value;
  h.element(id).fire('change');
}
/** Run the real editor serializer, DraftGuard, host callbacks and GPX controller.
 * Only browser/vendor facilities and network responses are substituted. */
function fullEditor(candidate: typeof preview, fetchOverride?: SetupOptions['fetch'], options: {
  initialize?: boolean;
  tk?: string;
  stash?: { key: string; value: unknown };
  confirm?: (title: string) => Promise<boolean>;
} = {}) {
  const dom = gpxDocument();
  const requests: RequestRecord[] = [];
  const values = new Map<string, string>(options.stash ? [[options.stash.key, JSON.stringify(options.stash.value)]] : []);
  const local = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  class EasyMDE {
    private text = '';
    private readonly changes: (() => void)[] = [];
    readonly input = dom.document.createElement('textarea');
    constructor(settings: { element: EditorElement }) { settings.element.parentElement!.appendChild(this.input); }
    value(value?: string) {
      if (value !== undefined) { this.text = value; this.changes.forEach((callback) => callback()); }
      return this.text;
    }
    readonly codemirror = {
      on: (event: string, callback: () => void) => { if (event === 'change' || event === 'changes') this.changes.push(callback); },
      getInputField: () => this.input,
      getValue: () => this.text,
      refresh() {},
      operation: (callback: () => void) => callback(),
      focus: () => this.input.focus(),
    };
  }
  const copy = (prefix: string) => Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
    locale, Object.fromEntries(Object.entries(strings)
      .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value])),
  ]));
  const context: Record<string, unknown> = {
    document: dom.document,
    location: { search: options.tk ? '?tk=' + options.tk : '', pathname: '/admin/editor.html', href: 'http://localhost/admin/editor.html' + (options.tk ? '?tk=' + options.tk : ''), origin: 'http://localhost' },
    history: { replaceState() {} },
    localStorage: local,
    sessionStorage: local,
    fetch: async (url: string, options: RequestInit = {}) => {
      requests.push({ url, options });
      const overridden = await fetchOverride?.(url, options);
      if (overridden) return overridden;
      if (url === '/gpx/imports') return response(candidate, 201);
      if (url.startsWith('/gpx/imports/') && options.method === 'DELETE') return response({}, 204);
      if (url === '/posts' && options.method === 'POST') return response({
        translationKey: 'saved-pair', updatedAt: '2026-10-24T10:00:30.000Z',
        de: { slug: 'private-walk' }, en: { slug: '' },
      });
      if (url === '/posts/saved-pair/route' && options.method === 'PUT') return response({ error: 'gpx_conflict' }, 409);
      if (url === '/posts/saved-pair' && options.method === 'PUT') return response({
        translationKey: 'saved-pair', updatedAt: '2026-10-24T10:00:40.000Z',
        de: { slug: 'private-walk' }, en: { slug: '' },
      });
      if (url.endsWith('/revisions')) return response([]);
      if (url.endsWith('/alt-audit')) return response({ images: [] });
      throw new Error('unexpected editor request: ' + url);
    },
    FormData: class { append() {} },
    Worker: CandidateWorker,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    addEventListener: dom.document.addEventListener,
    URLSearchParams, URL, AbortController, Event: EditorEvent, KeyboardEvent: EditorEvent, console,
    structuredClone,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {},
    alert() {},
    confirm: () => false,
    EasyMDE,
    Auth: { ensureAuthed: async () => options.initialize ? { isAdmin: true } : null, renderHeader() {} },
    AdminConfirm: { ask: async ({ title }: { title: string }) => options.confirm ? options.confirm(title) : true, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
    MediaPicker: { open() {} },
    AltSuggest: { wire() {} },
    WaypointCopy: copy('editor.waypoint.'),
    EditorImageCopy: copy('editor.titleImage.'),
    EditorGalleryCopy: copy('editor.gallery.'),
    EditorCopy: copy('editor.chrome.'),
    GpxCopy: copy('gpx.'),
    GpxMap: { create: async () => ({ render() {}, destroy() {}, resize() {} }) },
    EditorGalleryImageOrigin: 'https://img',
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['draft-guard.js', 'waypoint-lookup.js', 'posts-filter.js', 'editor-title-image.js',
    'gallery-fence.js', 'media-api.js', 'gallery-library.js', 'editor-galleries.js', 'editor-linter.js',
    'llm.js', 'editor-excerpt.js', 'country-centers.js', 'country-coordinates.js', 'tabs.js',
    'editor-review.js', 'editor-inspector.js', 'editor-gpx.js']) {
    vm.runInContext(readFileSync('public/' + file, 'utf8'), context, { filename: file });
  }
  // Supply the real shared geometry module through the controller's dependency
  // seam: Node's VM cannot resolve the browser-only /admin module URL.
  const controller = context.GpxEditor as { wire(host: Record<string, unknown>): unknown };
  const wire = controller.wire;
  controller.wire = (host) => wire({ ...host, loadGeometry: async () => browserGeometry, loadPublicTrack: async () => browserPublicTrack });
  const inline = html.slice(html.indexOf("'use strict'", html.lastIndexOf('<script>')), html.lastIndexOf('</script>'));
  vm.runInContext(inline, context, { filename: 'editor.html' });
  const editor = vm.runInContext('({ buildPayload, loadPost, doSaveDraft, guard, gpxEditor, deMDE, addStopRow })', context) as {
    buildPayload(): Omit<PostPair, 'status'> & { updatedAt?: string };
    loadPost(tk: string): Promise<boolean>;
    doSaveDraft(): Promise<boolean>;
    guard: { stashNow(): void; isDirty(): boolean };
    gpxEditor: GpxTestHarness['api'];
    deMDE: { value(value?: string): string };
    addStopRow(name: string, lat: number, lng: number): void;
  };
  const element = (id: string) => {
    const found = dom.document.getElementById(id);
    if (!found) throw new Error('missing #' + id);
    return found;
  };
  return {
    editor, api: editor.gpxEditor, element, requests, local,
    get locationHref() { return (context.location as { href: string }).href; },
    get state() { return vm.runInContext('({ tk: currentTk, baseUpdatedAt: loadedUpdatedAt })', context) as HostState; },
    get saveCalls() { return requests.filter(({ url, options }) => url === '/posts' && options.method === 'POST').length; },
  };
}

describe('private GPX editor lifecycle', () => {
  it('attaches an existing post using selection tokens only and keeps the draft form untouched', async () => {
    const h = setup();
    await h.api.refresh();
    await importPreview(h);
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    await settle();
    h.element('gpxAttach').click();
    await settle();

    const mutation = h.requests.find((request) => request.options.method === 'PUT');
    expect(mutation).toBeDefined();
    expect(JSON.parse(String(mutation?.options.body))).toEqual({
      importId: preview.importId,
      baseVersion: null,
      baseUpdatedAt: '2026-10-24T10:00:00.000Z',
      selection: { startPoints: 1, endPoints: 0, removedSegments: [] },
      confirmReplace: true,
    });
    expect(h.state.baseUpdatedAt).toBe('2026-10-24T10:01:00.000Z');
    expect(h.saveCalls).toBe(0);
    expect(h.api.hasPreview()).toBe(false);
  });

  it('saves a new post before route attachment and retains its saved identity when attachment fails', async () => {
    const h = setup({ newPost: true, failAttach: true });
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    expect(h.state.tk).toBe('new-pair');
    expect(h.saveCalls).toBe(1);
    expect(h.requests.some((request) => request.options.method === 'PUT')).toBe(true);
    expect(h.api.hasPreview()).toBe(true);
    expect(h.focused).toBe(h.element('gpxError'));
  });

  it('cancels a private preview without changing the attached route', async () => {
    const h = setup({ route: { version: 'a'.repeat(36), geometry: preview.geometry, originalAvailable: true, sourceBytes: 2048 } });
    await h.api.refresh();
    await importPreview(h);
    h.element('gpxClose').click();
    await settle();
    expect(h.api.hasPreview()).toBe(false);
    expect(h.requests.some((request) => request.options.method === 'DELETE' && String(request.url).startsWith('/gpx/imports/'))).toBe(true);
    expect(h.requests.some((request) => request.options.method === 'PUT' || request.options.method === 'DELETE' && String(request.url).endsWith('/route'))).toBe(false);
  });

  it('keeps a current upload error and its focus when earlier preview cleanup fails late', async () => {
    const cleanup = Promise.withResolvers<Reply>();
    let uploads = 0;
    const h = setup({ fetch: async (url, request) => {
      if (url.startsWith('/gpx/imports/') && request.method === 'DELETE') return cleanup.promise;
      if (url === '/gpx/imports' && ++uploads > 1) return response({ error: 'gpx_invalid_xml' }, 422);
      return undefined;
    } });
    await importPreview(h);
    await importPreview(h);
    const error = h.element('gpxError');
    expect(error.hidden).toBe(false);
    expect(h.focused).toBe(error);
    const message = error.textContent;
    cleanup.resolve(response({ error: 'gpx_cleanup_pending' }, 503));
    await settle();
    expect(error.textContent).toBe(message);
    expect(h.focused).toBe(error);
    expect(h.element('gpxCleanupNotice').hidden).toBe(false);
    expect(h.api.hasPreview()).toBe(false);
    expect(routeWrites(h)).toEqual([]);
  });

  it('discards the previous preview when a replacement exceeds the file limit without uploading it', async () => {
    const h = setup();
    await importPreview(h);
    const input = h.element('gpxFile') as EditorElement & { files: File[] };
    input.files = [{ name: 'oversized.gpx', size: 5 * 1024 * 1024 + 1 } as File];
    input.fire('change');
    await settle();
    expect(h.api.hasPreview()).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.requests.filter(({ url, options }) => url === '/gpx/imports' && options.method === 'POST')).toHaveLength(1);
    expect(h.requests.some(({ url, options }) => url.startsWith('/gpx/imports/') && options.method === 'DELETE')).toBe(true);
    expect(routeWrites(h)).toEqual([]);
    expect(h.focused).toBe(h.element('gpxError'));
  });

  it('applies only the explicitly selected trim method and keeps inactive controls unavailable', async () => {
    const h = setup();
    await importPreview(h);
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    expect(h.element('gpxStartDistance').disabled).toBe(true);
    expect(h.element('gpxDistanceTrim').hidden).toBe(true);
    expect(h.renders.at(-1)).toMatchObject({
      rawKept: { segments: [{ points: [{ lng: 1.1, lat: 2.1 }, { lng: 1.2, lat: 2.2 }] }] },
    });

    h.element('gpxTrimMethod').value = 'distance';
    h.element('gpxTrimMethod').fire('change');
    h.element('gpxEndDistance').value = '100';
    h.element('gpxEndDistance').fire('input');
    expect(h.element('gpxStart').disabled).toBe(true);
    expect(h.element('gpxPointTrim').hidden).toBe(true);
    expect(h.element('gpxEndDistance').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({
      rawKept: { segments: [{ points: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }] }] },
    });
    h.element('gpxReset').click();
    expect(h.element('gpxEndDistance').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({ rawKept: preview.geometry });
  });

  it('recalculates distance trimming after removing a segment without consuming the disconnected gap', async () => {
    const candidate = {
      ...preview,
      geometry: {
        version: 1,
        segments: [
          { points: [{ lng: 1, lat: 2 }, { lng: 1.0001, lat: 2 }, { lng: 1.0002, lat: 2 }] },
          { points: [{ lng: 2, lat: 2 }, { lng: 2.01, lat: 2 }, { lng: 2.02, lat: 2 }] },
        ],
      },
      counts: { ...preview.counts, sourceSegments: 2, inputPoints: 6, points: 6, segments: 2 },
    };
    const h = setup({ preview: candidate });
    await importPreview(h);
    h.element('gpxTrimMethod').value = 'distance';
    h.element('gpxTrimMethod').fire('change');
    h.element('gpxStartDistance').value = '100';
    h.element('gpxStartDistance').fire('input');
    const segment = h.element('gpxSegments').querySelector('input')!;
    segment.checked = true;
    segment.fire('change');
    await h.api.refresh();
    await settle();
    expect(h.element('gpxAttach').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({
      rawKept: { segments: [{ points: [{ lng: 2.01, lat: 2 }, { lng: 2.02, lat: 2 }] }] },
    });
  });

  it.each(['points', 'segment'])('blocks an all-trimmed %s selection without detaching the current route', async (mode) => {
    const h = setup({ route: attachedRoute });
    await h.api.refresh();
    await importPreview(h);
    check(h, 'gpxReplaceConfirm');
    expect(h.element('gpxAttach').disabled).toBe(false);
    const control = mode === 'points' ? h.element('gpxStart') : h.element('gpxSegments').querySelector('input')!;
    control.focus();
    if (mode === 'points') {
      h.element('gpxStart').value = '3';
      h.element('gpxStart').fire('input');
    } else {
      const segment = h.element('gpxSegments').querySelector('input')!;
      segment.checked = true;
      segment.fire('change');
    }
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.focused).toBe(control);
    h.element('gpxAttach').click();
    await settle();
    expect(routeWrites(h)).toEqual([]);
    expect(h.element('gpxRouteStatus').textContent).toBe('statusAttached');
    expect(h.api.hasPreview()).toBe(true);
    h.element('gpxReset').click();
    await settle();
    expect(h.element('gpxAttach').disabled).toBe(false);
  });

  it('requires fresh explicit source-replacement consent for each preview', async () => {
    const h = setup({ route: attachedRoute });
    await h.api.refresh();
    await importPreview(h);
    expect(h.element('gpxReplaceConfirmLabel').hidden).toBe(false);
    expect(h.element('gpxReplaceConfirm').checked).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(true);
    h.element('gpxAttach').click();
    await settle();
    expect(routeWrites(h)).toEqual([]);
    check(h, 'gpxReplaceConfirm');
    expect(h.element('gpxAttach').disabled).toBe(false);
    await importPreview(h);
    expect(h.element('gpxReplaceConfirm').checked).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(true);
    check(h, 'gpxReplaceConfirm');
    h.element('gpxAttach').click();
    await settle();
    expect(routeWrites(h)).toHaveLength(1);
    expect(JSON.parse(String(routeWrites(h)[0]!.options.body))).toMatchObject({
      baseVersion: attachedRoute.version, confirmReplace: true,
    });
  });

  it.each(['close', 'cancel'])('disposes a delayed successful import after %s without repainting or reopening', async (action) => {
    const pending = Promise.withResolvers<Reply>();
    const h = setup({ route: attachedRoute, fetch: async (url) => url === '/gpx/imports' ? pending.promise : undefined });
    await h.api.refresh();
    startImport(h);
    const importing = h.requests.find(({ url }) => url === '/gpx/imports')!;
    expect(importing.options.signal?.aborted).toBe(false);
    if (action === 'close') h.element('gpxClose').click();
    else expect(h.element('gpxDialog').fire('cancel').defaultPrevented).toBe(true);
    expect(importing.options.signal?.aborted).toBe(true);
    expect(h.element('gpxDialog').open).toBe(false);
    // Deliberately ignore AbortSignal: the server may already have committed
    // the staging file when fetch delivers its final response.
    pending.resolve(response(preview, 201));
    await settle();
    expect(h.requests.filter(({ url, options }) => url === '/gpx/imports/' + preview.importId && options.method === 'DELETE')).toHaveLength(1);
    expect(h.api.hasPreview()).toBe(false);
    expect(h.element('gpxDialog').open).toBe(false);
    expect(h.element('gpxPreview').hidden).toBe(true);
    expect(h.element('gpxCounts').textContent).toBe('');
    expect(h.renders).toEqual([]);
    expect(routeWrites(h)).toEqual([]);
    expect(h.element('gpxRouteStatus').textContent).toBe('statusAttached');
    h.element('gpxImportOpen').click();
    expect(h.element('gpxFile').disabled).toBe(false);
  });

  it('does not let a late import failure repaint the closed dialog', async () => {
    const pending = Promise.withResolvers<Reply>();
    const h = setup({ fetch: async (url) => url === '/gpx/imports' ? pending.promise : undefined });
    startImport(h);
    h.element('gpxClose').click();
    pending.resolve(response({ error: 'gpx_invalid_xml' }, 400));
    await settle();
    expect(h.element('gpxDialog').open).toBe(false);
    expect(h.element('gpxError').hidden).toBe(true);
    expect(h.element('gpxStatus').textContent).toBe('');
    expect(h.api.hasPreview()).toBe(false);
    expect(routeWrites(h)).toEqual([]);
  });

  it('retains the preview and makes no attachment request when first save fails', async () => {
    const h = setup({ newPost: true, failSave: true });
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    expect(h.saveCalls).toBe(1);
    expect(h.state.tk).toBeNull();
    expect(routeWrites(h)).toEqual([]);
    expect(h.api.hasPreview()).toBe(true);
    expect(h.element('gpxDialog').open).toBe(true);
    expect(h.element('gpxError').hidden).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(false);
  });

  it.each([{ status: 404, newPost: false }, { status: 409, newPost: true }])('invalidates an unavailable preview ($status) instead of retrying its stale token', async ({ status, newPost }) => {
    const h = setup({ newPost, fetch: async (url, request) =>
      url.endsWith('/route') && request.method === 'PUT' ? response({ error: 'gpx_import_unavailable' }, status) : undefined });
    await h.api.refresh();
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    expect(h.api.hasPreview()).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxFile').disabled).toBe(false);
    expect(h.element('gpxError').hidden).toBe(false);
    expect(h.focused).toBe(h.element('gpxError'));
    h.element('gpxAttach').click();
    await settle();
    expect(routeWrites(h)).toHaveLength(1);
    expect(h.state.tk).toBe(newPost ? 'new-pair' : 'pair-1');
  });

  it.each([true, false])('returns focus to a visible action after detaching (original available: %s)', async (originalAvailable) => {
    const h = setup({ route: attachedRoute, fetch: async (url, request) =>
      url.endsWith('/route') && request.method === 'DELETE'
        ? response({ ...emptyRoute, version: 'd'.repeat(36), originalAvailable, updatedAt: '2026-10-24T10:02:00.000Z' }) : undefined });
    await h.api.refresh();
    h.element('gpxDetach').focus();
    h.element('gpxDetach').click();
    await settle();
    expect(h.element('gpxDetach').hidden).toBe(true);
    expect(h.focused).toBe(h.element(originalAvailable ? 'gpxReimport' : 'gpxImportOpen'));
    expect(h.focused?.hidden).toBe(false);
    expect(h.focused?.disabled).toBe(false);
  });

  it.each([
    ['PUT', 'server'], ['DELETE', 'server'], ['PUT', 'network'], ['DELETE', 'network'],
  ])('refreshes an unknown %s outcome (%s), blocks retries, and leaves unsaved text alone', async (method, failure) => {
    let attempted = false;
    const h = setup({ route: attachedRoute, fetch: async (url, request) => {
      if (!url.endsWith('/route')) return undefined;
      if (request.method === method) {
        attempted = true;
        if (failure === 'network') throw new TypeError('connection lost after request was sent');
        return response({ error: 'gpx_outcome_unknown' }, 503);
      }
      if (attempted && request.method === 'GET') return response(method === 'PUT' ? attachedRoute : emptyRoute);
      return undefined;
    } });
    await h.api.refresh();
    h.element('deTitle').value = 'Unrelated unsaved title';
    h.element('deBody').value = 'Unrelated unsaved paragraphs';
    if (method === 'PUT') {
      await importPreview(h);
      check(h, 'gpxReplaceConfirm');
      h.element('gpxAttach').click();
    } else h.element('gpxDetach').click();
    await settle();
    expect(routeWrites(h)).toHaveLength(1);
    const mutationIndex = h.requests.findIndex(({ options }) => options.method === method);
    expect(h.requests.slice(mutationIndex + 1)).toContainEqual({ url: '/posts/pair-1/route', options: { method: 'GET' } });
    expect(h.element('gpxRouteStatus').textContent).toBe(method === 'PUT' ? 'statusAttached' : 'statusNone');
    const recovery = h.element(method === 'DELETE' ? 'gpxRouteFeedback' : 'gpxError');
    expect(recovery.hidden).toBe(false);
    expect(recovery.textContent).toBe(ui.en['gpx.unknown']);
    const errorDialog = recovery.closest('dialog');
    expect(errorDialog === null || errorDialog.open).toBe(true);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxDetach').hidden || h.element('gpxDetach').disabled).toBe(true);
    if (method === 'PUT') expect(h.api.hasPreview()).toBe(true);
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    await h.api.refresh();
    h.element('gpxAttach').click();
    h.element('gpxDetach').click();
    await settle();
    expect(routeWrites(h)).toHaveLength(1);
    expect(h.element('deTitle').value).toBe('Unrelated unsaved title');
    expect(h.element('deBody').value).toBe('Unrelated unsaved paragraphs');
    expect(h.saveCalls).toBe(0);
  });

  it('adopts only checked and confirmed waypoints with edited shared names and exact coordinates', async () => {
    const waypoints = [
      { name: 'Sensitive start', lat: 2.000012345, lng: 1.000098765 },
      { name: 'Do not adopt', lat: 2.100012345, lng: 1.100098765 },
    ];
    const h = setup({ preview: { ...preview, waypoints, counts: { ...preview.counts, waypoints: 2 } } });
    await importPreview(h);
    const rows = h.element('gpxWaypoints').querySelectorAll('.gpx-waypoint');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('input[type=checkbox]')!.checked)).toEqual([false, false]);
    expect(h.element('gpxAdoptConfirm').checked).toBe(false);
    expect(h.element('gpxAdopt').disabled).toBe(true);
    expect(h.adopted).toEqual([]);
    check(h, 'gpxAdoptConfirm');
    expect(h.element('gpxAdopt').disabled).toBe(true);
    h.element('gpxAdopt').click();
    await settle();
    expect(h.adopted).toEqual([]);
    check(h, 'gpxAdoptConfirm', false);
    const selected = rows[0]!.querySelector('input[type=checkbox]')!;
    selected.checked = true;
    selected.fire('change');
    h.element('gpxAdopt').click();
    await settle();
    expect(h.adopted).toEqual([]);
    rows[0]!.querySelector('input[type=text]')!.value = '  Shared edited name  ';
    // Adoption is independent of trimming and preserves explicitly chosen
    // coordinates, even when they lie in the removed route region.
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    check(h, 'gpxAdoptConfirm');
    expect(h.element('gpxAdopt').disabled).toBe(false);
    h.element('gpxAdopt').click();
    await settle();
    expect(h.adopted).toEqual([[{ name: 'Shared edited name', lat: waypoints[0]!.lat, lng: waypoints[0]!.lng }]]);
    expect(selected.checked).toBe(false);
    expect(h.element('gpxAdoptConfirm').checked).toBe(false);
    expect(h.element('gpxAdopt').disabled).toBe(true);
    expect(routeWrites(h)).toEqual([]);
    expect(h.saveCalls).toBe(0);
    h.element('gpxClose').click();
    expect(h.adopted).toHaveLength(1);
  });

  it('rejects a selected waypoint with a blank edited name without partial adoption', async () => {
    const h = setup({ preview: { ...preview, waypoints: [{ name: 'Named', lat: 2, lng: 1 }], counts: { ...preview.counts, waypoints: 1 } } });
    await importPreview(h);
    const row = h.element('gpxWaypoints').querySelector('.gpx-waypoint')!;
    row.querySelector('input[type=checkbox]')!.checked = true;
    row.querySelector('input[type=checkbox]')!.fire('change');
    row.querySelector('input[type=text]')!.value = '   ';
    check(h, 'gpxAdoptConfirm');
    h.element('gpxAdopt').click();
    await settle();
    expect(h.adopted).toEqual([]);
    expect(h.element('gpxError').textContent).toBe('waypointNameRequired');
    expect(h.api.hasPreview()).toBe(true);
  });
});

describe('GPX shares the real editor write queue', () => {
  it('captures Save-and-attach before its queue slot starts and leaves later typing dirty', async () => {
    const h = fullEditor(preview);
    await settle();
    h.element('deTitle').value = 'Attach this version';
    h.element('deTitle').fire('input');
    await importPreview(h);
    h.element('gpxAttach').click();
    h.element('deTitle').value = 'Later unsaved typing';
    h.element('deTitle').fire('input');
    await settle();
    const save = h.requests.find(({ url, options }) => url === '/posts' && options.method === 'POST')!;
    expect(JSON.parse(String(save.options.body)).de.title).toBe('Attach this version');
    expect(h.element('deTitle').value).toBe('Later unsaved typing');
    expect(h.editor.guard.isDirty()).toBe(true);
    expect(h.saveCalls).toBe(1);
    expect(routeWrites(h)).toHaveLength(1);
  });

  it.each([false, true])('saves the clicked form to the pair created by a pending first Save before attaching (later typing: %s)', async (laterTyping) => {
    const posts = memoryPostStore();
    const firstSave = Promise.withResolvers<void>();
    const attachSave = Promise.withResolvers<void>();
    const savedVersions: string[] = [];
    let attachedAt = '';
    const h = fullEditor(preview, async (url, request) => {
      if ((url === '/posts' && request.method === 'POST') || (url === '/posts/saved-pair' && request.method === 'PUT')) {
        const payload = JSON.parse(String(request.body)) as PostPair & { updatedAt?: string };
        const stored = await posts.upsertDraft(
          { ...payload, translationKey: payload.translationKey || 'saved-pair' },
          payload.updatedAt ? new Date(payload.updatedAt) : undefined,
        );
        const updatedAt = stored.updatedAt.toISOString();
        savedVersions.push(updatedAt);
        if (savedVersions.length === 1) await firstSave.promise;
        if (savedVersions.length === 2) await attachSave.promise;
        return response({ ...stored, updatedAt });
      }
      if (url.endsWith('/route') && request.method === 'PUT') {
        attachedAt = new Date((await posts.get('saved-pair'))!.updatedAt.getTime() + 1).toISOString();
        return response({ ...attachedRoute, updatedAt: attachedAt });
      }
      return undefined;
    });
    await settle();
    h.element('deTitle').value = 'First save A';
    h.element('deTitle').fire('input');
    const saving = h.editor.doSaveDraft();
    await settle();
    expect((await posts.get('saved-pair'))!.de.title).toBe('First save A');
    h.element('deTitle').value = 'Save and attach B';
    h.element('deTitle').fire('input');
    await importPreview(h);
    expect(h.element('gpxAttach').textContent).toBe(ui.en['gpx.newPostSaveFirst']);
    h.element('gpxAttach').click();
    if (laterTyping) {
      h.element('deTitle').value = 'Later unsaved C';
      h.element('deTitle').fire('input');
    }
    await settle();
    expect(h.saveCalls).toBe(1);
    expect(savedVersions).toHaveLength(1);
    expect(routeWrites(h)).toHaveLength(0);
    expect(h.element('gpxAttach').disabled).toBe(true);
    firstSave.resolve();
    expect(await saving).toBe(true);
    await settle();
    expect((await posts.get('saved-pair'))!.de.title).toBe('Save and attach B');
    expect(routeWrites(h)).toHaveLength(0); // wait for B's reply, not just its commit
    expect(h.element('draftSaveState').textContent).toBe(ui.en['editor.chrome.saveSaving']);
    const attachDraft = h.requests.find(({ url, options }) => url === '/posts/saved-pair' && options.method === 'PUT')!;
    expect(JSON.parse(String(attachDraft.options.body))).toMatchObject({
      translationKey: 'saved-pair', updatedAt: savedVersions[0], de: { title: 'Save and attach B' },
    });
    attachSave.resolve();
    await settle();
    expect(h.saveCalls).toBe(1);
    expect(await posts.list()).toHaveLength(1);
    expect((await posts.get('saved-pair'))!.de.title).toBe('Save and attach B');
    expect(h.requests.filter(({ url, options }) => url.startsWith('/posts') && ['POST', 'PUT'].includes(options.method ?? ''))
      .map(({ url, options }) => [options.method, url])).toEqual([
      ['POST', '/posts'], ['PUT', '/posts/saved-pair'], ['PUT', '/posts/saved-pair/route'],
    ]);
    expect(routeWrites(h)).toHaveLength(1);
    expect(JSON.parse(String(routeWrites(h)[0]!.options.body))).toMatchObject({
      baseUpdatedAt: savedVersions[1], baseVersion: null, importId: preview.importId,
    });
    expect(h.state.baseUpdatedAt).toBe(attachedAt);
    expect(h.api.hasPreview()).toBe(false);
    expect(h.element('deTitle').value).toBe(laterTyping ? 'Later unsaved C' : 'Save and attach B');
    expect(h.editor.guard.isDirty()).toBe(laterTyping);
    expect(h.element('draftSaveState').textContent).toBe(ui.en[laterTyping ? 'editor.chrome.saveUnsaved' : 'editor.chrome.saveSaved']);
    expect(await h.editor.doSaveDraft()).toBe(true);
    const nextSave = h.requests.filter(({ url, options }) => url === '/posts/saved-pair' && options.method === 'PUT').at(-1)!;
    expect(JSON.parse(String(nextSave.options.body)).updatedAt).toBe(attachedAt);
  });

  it('waits for a pending Save before detaching and keeps its busy guard until the route response', async () => {
    const pendingSave = Promise.withResolvers<Reply>();
    const pendingDetach = Promise.withResolvers<Reply>();
    const h = fullEditor(preview, async (url, request) => {
      if (url.endsWith('/route') && request.method === 'PUT') return response({
        ...attachedRoute, updatedAt: '2026-10-24T10:01:00.000Z',
      });
      if (url.endsWith('/route') && request.method === 'DELETE') return pendingDetach.promise;
      if (url === '/posts/saved-pair' && request.method === 'PUT') return pendingSave.promise;
      return undefined;
    });
    await settle();
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    expect(h.state.tk).toBe('saved-pair');
    const saving = h.editor.doSaveDraft();
    await settle();
    h.element('gpxDetach').click();
    await settle();
    expect(routeWrites(h).map(({ options }) => options.method)).toEqual(['PUT']);
    pendingSave.resolve(response({
      translationKey: 'saved-pair', updatedAt: '2026-10-24T10:02:00.000Z',
      de: { slug: 'private-walk' }, en: { slug: '' },
    }));
    expect(await saving).toBe(true);
    await settle();
    const detach = routeWrites(h).at(-1)!;
    expect(detach.options.method).toBe('DELETE');
    expect(JSON.parse(String(detach.options.body))).toEqual({
      baseVersion: attachedRoute.version, baseUpdatedAt: '2026-10-24T10:02:00.000Z', confirmDetach: true,
    });
    expect(await h.editor.doSaveDraft()).toBe(false);
    expect(h.element('gpxDetach').disabled).toBe(true);
    pendingDetach.resolve(response({ ...emptyRoute, version: 'd'.repeat(36), updatedAt: '2026-10-24T10:03:00.000Z' }));
    await settle();
    expect(h.state.baseUpdatedAt).toBe('2026-10-24T10:03:00.000Z');
    expect(h.element('draftSaveState').textContent).toBe(ui.en['editor.chrome.saveSaved']);
  });
});

describe('GPX privacy through the real editor save and stash boundary', () => {
  it('keeps a failed first-save reason visible in the modal without attaching or discarding its preview', async () => {
    const h = fullEditor(preview, async (url, request) =>
      url === '/posts' && request.method === 'POST' ? response({ error: 'duplicate_slug: synthetic-walk' }, 409) : undefined);
    await settle();
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    expect(h.state.tk).toBeNull();
    expect(routeWrites(h)).toEqual([]);
    expect(h.api.hasPreview()).toBe(true);
    expect(h.element('gpxDialog').open).toBe(true);
    expect(h.element('gpxError').textContent).toContain('duplicate_slug: synthetic-walk');
    expect(h.element('gpxAttach').disabled).toBe(false);
  });

  it('does not start a second first-save when Ctrl+S is pressed during Save and attach', async () => {
    const pending = Promise.withResolvers<Reply>();
    const h = fullEditor(preview, async (url, request) =>
      url === '/posts' && request.method === 'POST' ? pending.promise : undefined);
    await settle();
    await importPreview(h);
    h.element('gpxAttach').click();
    await settle();
    try {
      expect(h.saveCalls).toBe(1);
      h.element('gpxAttach').dispatchEvent(new EditorEvent('keydown', { bubbles: true, cancelable: true, key: 's', ctrlKey: true }));
      await settle();
      expect(h.saveCalls).toBe(1);
    } finally {
      pending.resolve(response({ translationKey: 'saved-pair', updatedAt: '2026-10-24T10:00:30.000Z', de: { slug: 'private-walk' }, en: { slug: '' } }));
      await settle();
    }
    expect(routeWrites(h)).toHaveLength(1);
  });

  it('keeps private preview data out of first-save, retry-save and DraftGuard while appending only explicitly adopted stops', async () => {
    const candidate = {
      ...preview,
      geometry: { version: 1, segments: [{ points: [
        { lng: 1.000098765, lat: 2.000012345, elevation: 987.654, time: '2026-10-24T09:12:34.000Z' },
        { lng: 1.100098765, lat: 2.100012345, elevation: 988.654, time: '2026-10-24T09:13:34.000Z' },
        { lng: 1.200098765, lat: 2.200012345, elevation: 989.654, time: '2026-10-24T09:14:34.000Z' },
      ] }] },
      waypoints: [
        { name: 'Selected synthetic point', lat: 2.000012345, lng: 1.000098765 },
        { name: 'Private unselected point', lat: 2.100012345, lng: 1.100098765 },
      ],
      counts: { ...preview.counts, waypoints: 2 },
    };
    const h = fullEditor(candidate);
    await settle();
    h.element('deTitle').value = 'Private walk';
    h.element('deTitle').fire('input');
    h.editor.deMDE.value('## Unsaved story\n\nKeep these paragraphs.');
    h.editor.addStopRow('Existing manual stop', 3.25, 4.75);
    const original: Omit<PostPair, 'status'> = JSON.parse(JSON.stringify(h.editor.buildPayload()));
    await importPreview(h);
    expect(h.api.hasPreview()).toBe(true);
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    h.editor.guard.stashNow();
    expect(h.local.length).toBe(1);
    expect(JSON.parse(h.local.getItem(h.local.key(0)!)!).payload).toEqual(original);
    expect(JSON.parse(JSON.stringify(h.editor.buildPayload()))).toEqual(original);

    const rows = h.element('gpxWaypoints').querySelectorAll('.gpx-waypoint');
    const checkbox = rows[0]!.querySelector('input[type=checkbox]')!;
    checkbox.checked = true;
    checkbox.fire('change');
    rows[0]!.querySelector('input[type=text]')!.value = 'Edited shared stop';
    check(h, 'gpxAdoptConfirm');
    h.element('gpxAdopt').click();
    await settle();
    const expected = {
      ...original,
      shared: { ...original.shared, stops: [
        { name: 'Existing manual stop', lat: 3.25, lng: 4.75 },
        { name: 'Edited shared stop', lat: candidate.waypoints[0]!.lat, lng: candidate.waypoints[0]!.lng },
      ] },
    };
    expect(JSON.parse(JSON.stringify(h.editor.buildPayload()))).toEqual(expected);
    h.editor.guard.stashNow();
    expect(JSON.parse(h.local.getItem(h.local.key(0)!)!).payload).toEqual(expected);
    h.element('gpxAttach').click();
    await settle();
    const saved = h.requests.find(({ url, options }) => url === '/posts' && options.method === 'POST')!;
    expect(saved).toBeDefined();
    expect(JSON.parse(String(saved.options.body))).toEqual(expected);
    expect(h.state.tk).toBe('saved-pair');
    expect(h.api.hasPreview()).toBe(true);
    expect(h.editor.deMDE.value()).toBe('## Unsaved story\n\nKeep these paragraphs.');
    const attached = routeWrites(h)[0]!;
    expect(h.requests.indexOf(saved)).toBeLessThan(h.requests.indexOf(attached));
    expect(JSON.parse(String(attached.options.body))).toEqual({
      importId: preview.importId, baseVersion: null, baseUpdatedAt: '2026-10-24T10:00:30.000Z',
      selection: { startPoints: 1, endPoints: 0, removedSegments: [] }, confirmReplace: true,
    });
    expect(h.element('gpxError').textContent).toBe(ui.en['gpx.attachFailureSaved']);
    h.element('gpxClose').click();
    h.editor.deMDE.value('## Later edit\n\nKeep these too.');
    const later = JSON.parse(JSON.stringify(h.editor.buildPayload()));
    h.editor.guard.stashNow();
    expect(JSON.parse(h.local.getItem('swl:draft:saved-pair')!).payload).toEqual(later);
    expect(await h.editor.doSaveDraft()).toBe(true);
    const retry = h.requests.find(({ url, options }) => url === '/posts/saved-pair' && options.method === 'PUT')!;
    expect(JSON.parse(String(retry.options.body))).toEqual(later);
    expect(h.saveCalls).toBe(1);
    expect(routeWrites(h)).toHaveLength(1);
  });
});

describe('public candidate lifecycle', () => {
  it('keeps Attach unavailable until the current candidate succeeds and ignores stale results', async () => {
    const workers = manualCandidates();
    const h = setup({ Worker: workers.Worker });
    await h.api.refresh();
    await importPreview(h);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxStart').disabled).toBe(false);
    expect(h.element('gpxReset').disabled).toBe(false);
    const first = workers.jobs[0]!;
    expect(first.url).toBe('/admin/gpx-candidate-worker.js');
    expect(first.options).toEqual({ type: 'module' });
    h.element('gpxStart').focus();
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    expect(first.terminated).toBe(true);
    first.complete();
    expect(h.element('gpxAttach').disabled).toBe(true);
    workers.jobs[1]!.complete();
    expect(h.element('gpxAttach').disabled).toBe(false);
    expect(h.focused).toBe(h.element('gpxStart'));
    expect(h.renders.at(-1)).toMatchObject({
      rawKept: { segments: [{ points: preview.geometry.segments[0]!.points.slice(1) }] },
      track: { version: 1, type: 'MultiLineString', coordinates: [[[1.1, 2.1], [1.2, 2.2]]] },
    });
    h.element('gpxClose').click();
    workers.jobs[1]!.complete();
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.focused).toBe(h.element('gpxImportOpen'));
    expect(routeWrites(h)).toEqual([]);
  });

  it.each(['track_public_limit', 'track_empty_after_rounding'])('keeps %s retryable without replacing the existing attachment', async (code) => {
    const workers = manualCandidates();
    const h = setup({ Worker: workers.Worker, route: attachedRoute });
    await h.api.refresh();
    await importPreview(h);
    check(h, 'gpxReplaceConfirm');
    workers.jobs[0]!.reply({ ok: false, code });
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.api.hasPreview()).toBe(true);
    expect(h.element('gpxReset').disabled).toBe(false);
    expect(h.element('gpxError').textContent).toBe(code === 'track_public_limit' ? 'publicLimit' : 'publicEmpty');
    h.element('gpxReset').click();
    workers.jobs[1]!.complete();
    expect(h.element('gpxAttach').disabled).toBe(false);
    expect(routeWrites(h)).toEqual([]);
    h.element('gpxClose').click();
  });

  it.each(['error', 'messageerror', 'invalid-result'] as const)('fails closed on worker %s and permits explicit retry', async (failure) => {
    const workers = manualCandidates();
    const h = setup({ Worker: workers.Worker });
    await h.api.refresh();
    await importPreview(h);
    const job = workers.jobs[0]!;
    if (failure === 'error') job.onerror?.();
    else if (failure === 'messageerror') job.onmessageerror?.();
    else job.reply({ ok: true, result: { track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2, 3], [3, 4, 5]]] }, collapsedRuns: 0 } });
    expect(job.terminated).toBe(true);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxError').textContent).toBe('candidateFailed');
    job.complete();
    expect(h.element('gpxAttach').disabled).toBe(true);
    h.element('gpxReset').click();
    workers.jobs[1]!.complete();
    expect(h.element('gpxAttach').disabled).toBe(false);
    h.element('gpxClose').click();
  });

  it('terminates a timed-out job and ignores its late success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const workers = manualCandidates();
      const h = setup({ Worker: workers.Worker });
      await h.api.refresh();
      await importPreview(h);
      vi.advanceTimersByTime(2000);
      expect(workers.jobs[0]!.terminated).toBe(true);
      expect(h.element('gpxError').textContent).toBe('candidateTimeout');
      workers.jobs[0]!.complete();
      expect(h.element('gpxAttach').disabled).toBe(true);
      h.element('gpxClose').click();
    } finally { vi.useRealTimers(); }
  });

  it.each(['de', 'en'] as const)('announces rounding collapse and recovery in %s', async (locale) => {
    const workers = manualCandidates();
    const h = setup({ Worker: workers.Worker, locale });
    await h.api.refresh();
    await importPreview(h);
    workers.jobs[0]!.reply({ ok: true, result: {
      track: { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [1.2, 2.2]]] }, collapsedRuns: 1,
    } });
    expect(h.element('gpxCandidateStatus').textContent).toBe(ui[locale]['gpx.candidateCollapsed'].replace('{count}', '1'));
    h.element('gpxClose').click();
    expect(h.api.publishError('track_public_limit')).toBe(ui[locale]['gpx.publishRouteRecovery']);
    expect(h.focused).toBe(h.element('gpxRouteFeedback'));
  });

  it.each(['de', 'en'] as const)('classifies Publish worker failures without leaking raw codes in %s', (locale) => {
    const h = setup({ locale });
    expect(h.api.publishError('gpx_timeout')).toBe(ui[locale]['gpx.timeout']);
    expect(h.api.publishError('gpx_worker_failed')).toBe(ui[locale]['gpx.workerFailed']);
    expect(h.api.publishError('gpx_unavailable')).toBe(ui[locale]['gpx.unavailable']);
    expect(h.api.publishError('unrelated_validation')).toBeNull();
  });

  it('fails closed until route loading succeeds and never refreshes a reviewed publish token', async () => {
    const pending = Promise.withResolvers<Reply>();
    const h = setup({ fetch: async (url, request) => url.endsWith('/route') && request.method === 'GET' ? pending.promise : undefined });
    expect(() => h.api.publishVersion()).toThrow();
    const loading = h.api.refresh();
    expect(() => h.api.publishVersion()).toThrow();
    pending.resolve(response(attachedRoute));
    await loading;
    expect(h.api.publishVersion()).toBe(attachedRoute.version);
    expect(h.api.publishVersion()).toBe(attachedRoute.version);
    expect(h.requests.filter(({ options }) => options.method === 'GET')).toHaveLength(1);
    h.state.tk = 'another-pair';
    expect(() => h.api.publishVersion()).toThrow();
  });
});

describe('candidate failure recovery boundaries', () => {
  it('allows explicit waypoint adoption while the public route candidate is still pending', async () => {
    const workers = manualCandidates();
    const h = setup({
      Worker: workers.Worker,
      preview: { ...preview, waypoints: [{ name: 'Exact stop', lat: 2.1234567, lng: 1.1234567 }], counts: { ...preview.counts, waypoints: 1 } },
    });
    await h.api.refresh();
    await importPreview(h);
    const checkbox = h.element('gpxWaypoints').querySelector('input[type=checkbox]')!;
    checkbox.checked = true; checkbox.fire('change');
    check(h, 'gpxAdoptConfirm');
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxAdopt').disabled).toBe(false);
    h.element('gpxAdopt').click();
    await settle();
    expect(h.adopted).toEqual([[{ name: 'Exact stop', lat: 2.1234567, lng: 1.1234567 }]]);
    expect(workers.jobs).toHaveLength(1);
    h.element('gpxClose').click();
    expect(workers.jobs[0]!.terminated).toBe(true);
    expect(routeWrites(h)).toEqual([]);
  });

  it('keeps Attach unavailable when the browser cannot create a worker', async () => {
    class UnavailableWorker extends CandidateWorker {
      constructor(url: string, options: { type: string }) {
        super(url, options);
        throw new Error('worker unavailable');
      }
    }
    const h = setup({ Worker: UnavailableWorker });
    await h.api.refresh();
    await importPreview(h);
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.element('gpxError').textContent).toBe('candidateFailed');
    expect(h.element('gpxReset').disabled).toBe(false);
    expect(h.api.hasPreview()).toBe(true);
    h.element('gpxClose').click();
  });

  it('refuses publish after a failed route read and ignores an obsolete post response', async () => {
    const pending = Promise.withResolvers<Reply>();
    let calls = 0;
    const h = setup({ fetch: async (url, request) => {
      if (!url.endsWith('/route') || request.method !== 'GET') return undefined;
      return ++calls === 1 ? pending.promise : response({ error: 'gpx_unavailable' }, 503);
    } });
    const first = h.api.refresh();
    h.state.tk = 'other-pair';
    await h.api.refresh();
    pending.resolve(response(attachedRoute));
    await first;
    expect(() => h.api.publishVersion()).toThrow();
    expect(h.element('gpxAttach').disabled).toBe(true);
    expect(h.requests).toHaveLength(2);
  });
});

function reloadPostFixture(updatedAt = '2026-10-28T10:00:00.000Z'): PostPair & { updatedAt: string } {
  const locale = (lang: 'de' | 'en') => ({
    locale: lang, slug: lang + '-walk', title: lang + ' walk', excerpt: 'A walk',
    country: 'Romania', heroImage: { src: 'https://img/hero', width: 900, height: 600, alt: 'Hills' },
    bodyMarkdown: '## A walk\n\nAlong the hills.', images: {}, keyFacts: {},
  });
  return {
    translationKey: 'pair-1', status: 'draft', updatedAt,
    shared: { date: '2026-10-24', countryCode: 'RO', region: 'europe', coordinates: { lat: 44, lng: 26 }, categories: [], tags: [] },
    de: locale('de'), en: locale('en'),
  };
}
const routeReads = (h: { requests: RequestRecord[] }) => h.requests.filter(({ url, options }) =>
  url.endsWith('/route') && options.method === 'GET');
const publicationWrites = (h: { requests: RequestRecord[] }) => h.requests.filter(({ url }) =>
  url.endsWith('/publish') || url.endsWith('/unpublish'));

describe('explicit conflict Reload reconciles the real editor and GPX controller', () => {
  it.each([
    { name: 'attach', before: emptyRoute, after: attachedRoute, status: 'gpx.statusAttached', detach: true },
    { name: 'replace', before: attachedRoute, after: { ...attachedRoute, version: 'e'.repeat(36) }, status: 'gpx.statusAttached', detach: true },
    { name: 'detach', before: attachedRoute, after: { ...attachedRoute, version: 'f'.repeat(36), geometry: null }, status: 'gpx.statusDetached', detach: false },
  ] as const)('reconciles another tab’s $name and publishes the post-save token with the reviewed route', async ({ before, after, status, detach }) => {
    let stored = reloadPostFixture();
    let route: typeof before | typeof after = before;
    let saves = 0;
    const savedAt = '2026-10-28T10:02:00.000Z';
    const h = fullEditor(preview, async (url, options) => {
      if (url.endsWith('/route') && options.method === 'GET') return response(route);
      if (url === '/posts/pair-1' && options.method === 'PUT') {
        if (++saves === 1) return response({ code: 'conflict' }, 409);
        return response({ ...stored, updatedAt: savedAt });
      }
      if (url === '/posts/pair-1') return response(stored);
      if (url.endsWith('/publish')) return response({ updatedAt: '2026-10-28T10:03:00.000Z', build: { ok: true } });
      return undefined;
    });
    await h.editor.loadPost('pair-1');
    route = after;
    stored = { ...stored, updatedAt: '2026-10-28T10:01:00.000Z', en: { ...stored.en, title: 'Other tab’s title' } };
    h.element('deTitle').value = 'Unsaved local title';
    h.element('deTitle').fire('input');
    expect(await h.editor.doSaveDraft()).toBe(false);
    expect(routeReads(h)).toHaveLength(2);
    expect(h.element('enTitle').value).toBe(stored.en.title);
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en[status]);
    expect(h.element('gpxDetach').hidden).toBe(!detach);
    expect(h.element('gpxDetach').disabled).toBe(false);
    expect(h.element('gpxReimport').hidden).toBe(!after.originalAvailable);
    expect(h.element('gpxDownload').hidden).toBe(!after.originalAvailable);
    h.element('publishBtn').click();
    await settle();
    expect(publicationWrites(h)).toHaveLength(1);
    expect(JSON.parse(String(publicationWrites(h)[0]!.options.body))).toEqual({
      baseUpdatedAt: savedAt, baseRouteVersion: after.version,
    });
    const save = h.requests.filter(({ url, options }) => url === '/posts/pair-1' && options.method === 'PUT')[1]!;
    expect(JSON.parse(String(save.options.body)).updatedAt).toBe(stored.updatedAt);
  });

  it.each(['network', '500', 'json', 'version'] as const)('blocks pending/failed route reconciliation (%s) and recovers only after a successful explicit reload', async (failure) => {
    const pending = Promise.withResolvers<Reply>();
    let reads = 0;
    let saves = 0;
    const h = fullEditor(preview, async (url, options) => {
      if (url === '/posts/pair-1' && options.method === 'PUT') {
        saves++;
        return response({ code: 'conflict' }, 409);
      }
      if (url === '/posts/pair-1') return response(reloadPostFixture());
      if (url.endsWith('/route') && options.method === 'GET') {
        reads++;
        return reads === 2 ? pending.promise : response(attachedRoute);
      }
      return undefined;
    });
    await h.editor.loadPost('pair-1');
    const save = h.editor.doSaveDraft();
    const obsoleteSave = h.editor.doSaveDraft();
    h.element('publishBtn').click(); // queued before the conflict; must be cancelled
    h.element('gpxDetach').click(); // same queue, never allowed through Reload
    await settle();
    let finished = false;
    void save.then(() => { finished = true; });
    expect(finished).toBe(false);
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusLoading']);
    for (const id of ['gpxReimport', 'gpxAttach', 'gpxDetach']) expect(h.element(id).disabled).toBe(true);
    expect(await h.editor.doSaveDraft()).toBe(false);
    h.element('publishBtn').click();
    h.element('unpublishBtn').click();
    h.element('gpxDetach').fire('click');
    expect(() => h.api.publishVersion()).toThrow();
    await settle();
    expect(saves).toBe(1);
    expect(routeWrites(h)).toEqual([]);
    expect(publicationWrites(h)).toEqual([]);
    if (failure === 'network') pending.reject(new Error('offline'));
    else if (failure === '500') pending.resolve(response({ error: 'unavailable' }, 500));
    else if (failure === 'json') pending.resolve({ status: 200, ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } });
    else pending.resolve(response({ ...emptyRoute, version: 42 }));
    await save;
    await obsoleteSave;
    await settle();
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusUnavailable']);
    expect(h.element('gpxRouteFeedback').textContent).toBe(ui.en['gpx.routeRefreshFailed']);
    expect(h.element('gpxRouteFeedback').hidden).toBe(false);
    expect(() => h.api.publishVersion()).toThrow();
    expect(await h.editor.doSaveDraft()).toBe(false);
    h.element('gpxDetach').fire('click');
    h.element('publishBtn').click();
    await settle();
    expect(routeWrites(h)).toEqual([]);
    expect(publicationWrites(h)).toEqual([]);
    await h.editor.loadPost('pair-1');
    expect(h.api.publishVersion()).toBe(attachedRoute.version);
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusAttached']);
    expect(h.element('gpxRouteFeedback').hidden).toBe(true);
    expect(h.element('gpxDetach').disabled).toBe(false);
    expect(saves).toBe(1);
  });

  it.each([false, true])('preserves a pending preview while route loading blocks Attach, then uses the reconciled version (initial attachment: %s)', async (initiallyAttached) => {
    const pending = Promise.withResolvers<Reply>();
    let reads = 0;
    const h = fullEditor(preview, async (url, options) => {
      if (url === '/posts/pair-1') return response(reloadPostFixture());
      if (url.endsWith('/route') && options.method === 'GET') return ++reads === 1 ? response(initiallyAttached ? { ...attachedRoute, version: 'earlier-version' } : emptyRoute) : pending.promise;
      if (url.endsWith('/route') && options.method === 'PUT') return response({ ...attachedRoute, updatedAt: '2026-10-28T10:03:00.000Z' });
      return undefined;
    });
    await h.editor.loadPost('pair-1');
    await importPreview(h);
    if (initiallyAttached) check(h, 'gpxReplaceConfirm');
    h.element('gpxStart').value = '1';
    h.element('gpxStart').fire('input');
    await settle();
    const loading = h.editor.loadPost('pair-1');
    await settle();
    h.element('gpxAttach').fire('click');
    await settle();
    expect(routeWrites(h)).toEqual([]);
    expect(h.api.hasPreview()).toBe(true);
    pending.resolve(response(attachedRoute));
    await loading;
    expect(h.api.hasPreview()).toBe(true);
    expect(h.element('gpxStart').value).toBe('1');
    expect(() => h.api.publishVersion()).toThrow();
    expect(h.element('gpxReplaceScope').hidden).toBe(false);
    expect(h.element('gpxReplaceConfirmLabel').hidden).toBe(false);
    expect(h.element('gpxReplaceConfirm').checked).toBe(false);
    expect(h.element('gpxAttach').disabled).toBe(true);
    check(h, 'gpxReplaceConfirm');
    h.element('gpxAttach').click();
    await settle();
    expect(routeWrites(h)).toHaveLength(1);
    expect(JSON.parse(String(routeWrites(h)[0]!.options.body)).baseVersion).toBe(attachedRoute.version);
  });

  it.each(['network', '500', 'population', '401'] as const)('does not reconcile a route after failed post loading (%s), preserving local recovery', async (failure) => {
    let reloading = false;
    const h = fullEditor(preview, async (url, options) => {
      if (url.endsWith('/route') && options.method === 'GET') return response(attachedRoute);
      if (url === '/posts/pair-1' && options.method === 'PUT') return response({ code: 'conflict' }, 409);
      if (url === '/posts/pair-1') {
        if (!reloading) return response(reloadPostFixture());
        if (failure === 'network') throw new Error('offline');
        if (failure === '500' || failure === '401') return response({}, Number(failure));
        const post = reloadPostFixture('2026-10-28T12:00:00.000Z');
        return response({ ...post, de: { ...post.de, bodyMarkdown: 'Break population' } });
      }
      return undefined;
    });
    await h.editor.loadPost('pair-1');
    h.element('deTitle').value = 'Keep my draft';
    h.element('deTitle').fire('input');
    h.editor.guard.stashNow();
    const before = structuredClone(h.editor.buildPayload());
    if (failure === 'population') {
      const value = h.editor.deMDE.value.bind(h.editor.deMDE);
      h.editor.deMDE.value = (text?: string) => {
        const result = value(text);
        if (text === 'Break population') throw new Error('form failed after DE changed');
        return result;
      };
    }
    reloading = true;
    expect(await h.editor.doSaveDraft()).toBe(false);
    expect(routeReads(h)).toHaveLength(1);
    expect(h.editor.buildPayload()).toEqual(before);
    expect(await h.editor.doSaveDraft()).toBe(false);
    h.element('publishBtn').click();
    h.element('gpxDetach').click();
    await settle();
    expect(publicationWrites(h)).toEqual([]);
    expect(routeWrites(h)).toEqual([]);
    const stashes = Array.from({ length: h.local.length }, (_, i) => JSON.parse(h.local.getItem(h.local.key(i)!)!));
    expect(stashes.some((entry) => JSON.stringify(entry.payload) === JSON.stringify(before))).toBe(true);
    if (failure === '401') expect(h.locationHref).toMatch(/^\/login\?next=/);
    else expect(h.editor.guard.isDirty()).toBe(true);
  });

  it('cancelled conflict Reload keeps edits and does not read a route', async () => {
    const h = fullEditor(preview, async (url, options) => {
      if (url.endsWith('/route') && options.method === 'GET') return response(emptyRoute);
      if (url === '/posts/pair-1') return response(options.method === 'PUT' ? { code: 'conflict' } : reloadPostFixture(), options.method === 'PUT' ? 409 : 200);
      return undefined;
    }, { confirm: async () => false });
    await h.editor.loadPost('pair-1');
    h.element('deTitle').value = 'Keep this title';
    h.element('deTitle').fire('input');
    expect(await h.editor.doSaveDraft()).toBe(false);
    expect(h.element('deTitle').value).toBe('Keep this title');
    expect(h.editor.guard.isDirty()).toBe(true);
    expect(routeReads(h)).toHaveLength(1);
  });

  it('ignores an old route response after a newer explicit load changes identity', async () => {
    const pending = Promise.withResolvers<Reply>();
    const h = fullEditor(preview, async (url) => {
      if (url === '/posts/pair-1') return response(reloadPostFixture());
      if (url === '/posts/pair-2') return response({ ...reloadPostFixture(), translationKey: 'pair-2' });
      if (url === '/posts/pair-1/route') return pending.promise;
      if (url === '/posts/pair-2/route') return response({ ...emptyRoute, version: 'f'.repeat(36) });
      return undefined;
    });
    const old = h.editor.loadPost('pair-1');
    await settle();
    await h.editor.loadPost('pair-2');
    pending.resolve(response(attachedRoute));
    await old;
    expect(h.state.tk).toBe('pair-2');
    expect(h.api.publishVersion()).toBe('f'.repeat(36));
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusDetached']);
    expect(await h.editor.doSaveDraft()).toBe(true);
  });

  it.each([false, true])('initialization offers stash before its single final route refresh (existing: %s)', async (existing) => {
    const restore = Promise.withResolvers<boolean>();
    const payload = reloadPostFixture();
    payload.translationKey = 'recovered-pair';
    payload.de.title = 'Local recovered title';
    const h = fullEditor(preview, async (url, options) => {
      if (url === '/posts/pair-1') return response(reloadPostFixture());
      if (url === '/posts/recovered-pair/route' && options.method === 'GET') return response(attachedRoute);
      return undefined;
    }, {
      initialize: true, tk: existing ? 'pair-1' : undefined,
      stash: { key: existing ? 'swl:draft:pair-1' : 'swl:draft:new:orphan', value: { savedAt: '2026-10-28T11:00:00.000Z', payload } },
      confirm: async (title) => title === 'Restore unsaved draft?' ? restore.promise : true,
    });
    await settle();
    expect(routeReads(h)).toHaveLength(0);
    restore.resolve(true);
    await settle();
    expect(routeReads(h).map(({ url }) => url)).toEqual(['/posts/recovered-pair/route']);
    expect(h.element('deTitle').value).toBe(payload.de.title);
    expect(h.state.tk).toBe('recovered-pair');
    expect(h.api.publishVersion()).toBe(attachedRoute.version);
    h.editor.guard.stashNow();
    for (let i = 0; i < h.local.length; i++) {
      expect(h.local.getItem(h.local.key(i)!)).not.toMatch(/"(?:geometry|segments|importId|sourceBytes|baseVersion)"/);
    }
  });

  it('initializes a new post without a route GET and permits its first save', async () => {
    const h = fullEditor(preview, undefined, { initialize: true });
    await settle();
    expect(h.api.publishVersion()).toBeNull();
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusNone']);
    expect(routeReads(h)).toEqual([]);
    h.element('deTitle').value = 'My new walk';
    h.element('deTitle').fire('input');
    expect(await h.editor.doSaveDraft()).toBe(true);
  });
});

describe('route refresh response ownership', () => {
  it.each(['de', 'en'] as const)('announces loading and failure in %s without claiming attachment or absence', async (locale) => {
    const pending = Promise.withResolvers<Reply>();
    const h = setup({ locale, fetch: async () => pending.promise });
    const loading = h.api.refresh();
    expect(h.element('gpxRouteStatus').textContent).toBe(ui[locale]['gpx.statusLoading']);
    pending.resolve(response({ version: '' }));
    expect(await loading).toBe(false);
    expect(h.element('gpxRouteStatus').textContent).toBe(ui[locale]['gpx.statusUnavailable']);
    expect(h.element('gpxRouteFeedback').textContent).toBe(ui[locale]['gpx.routeRefreshFailed']);
  });

  it.each(['success', 'failure'] as const)('ignores obsolete %s for the same post after a newer refresh succeeds', async (outcome) => {
    const pending = Promise.withResolvers<Reply>();
    let reads = 0;
    const h = setup({ fetch: async () => ++reads === 1 ? pending.promise : response({ ...emptyRoute, version: 'e'.repeat(36) }) });
    const old = h.api.refresh();
    expect(await h.api.refresh()).toBe(true);
    if (outcome === 'failure') pending.reject(new Error('late network failure'));
    else pending.resolve(response(attachedRoute));
    expect(await old).toBe(false);
    expect(h.api.publishVersion()).toBe('e'.repeat(36));
    expect(h.element('gpxRouteStatus').textContent).toBe('statusDetached');
    expect(h.element('gpxRouteFeedback').hidden).toBe(true);
  });

  it('ignores a failed response for a different identity even without a replacement refresh', async () => {
    const pending = Promise.withResolvers<Reply>();
    const h = setup({ fetch: async () => pending.promise });
    const loading = h.api.refresh();
    h.state.tk = 'other-pair';
    pending.reject(new Error('old identity failed'));
    await loading;
    expect(h.element('gpxRouteStatus').textContent).toBe('statusLoading');
    expect(h.element('gpxRouteFeedback').hidden).toBe(true);
    expect(() => h.api.publishVersion()).toThrow();
  });

  it('redirects on a route 401 without admitting writes or claiming route reconciliation', async () => {
    const h = fullEditor(preview, async (url) => {
      if (url === '/posts/pair-1') return response(reloadPostFixture());
      if (url.endsWith('/route')) return response({}, 401);
      return undefined;
    });
    await h.editor.loadPost('pair-1');
    expect(h.locationHref).toMatch(/^\/login\?next=/);
    expect(h.element('gpxRouteStatus').textContent).toBe(ui.en['gpx.statusUnavailable']);
    expect(await h.editor.doSaveDraft()).toBe(false);
    h.element('gpxDetach').fire('click');
    h.element('publishBtn').click();
    await settle();
    expect(routeWrites(h)).toEqual([]);
    expect(publicationWrites(h)).toEqual([]);
  });
});

it('keeps failed initialization in recovery mode without a route-only read after stash restoration', async () => {
  const payload = reloadPostFixture();
  payload.de.title = 'Recover this draft';
  const h = fullEditor(preview, async (url) => url === '/posts/pair-1' ? response({}, 500) : undefined, {
    initialize: true, tk: 'pair-1',
    stash: { key: 'swl:draft:pair-1', value: { savedAt: '2026-10-28T11:00:00.000Z', payload } },
  });
  await settle();
  expect(h.element('deTitle').value).toBe(payload.de.title);
  expect(routeReads(h)).toEqual([]);
  expect(await h.editor.doSaveDraft()).toBe(false);
  expect(h.editor.guard.isDirty()).toBe(true);
  expect(h.local.getItem('swl:draft:pair-1')).toContain('Recover this draft');
});
