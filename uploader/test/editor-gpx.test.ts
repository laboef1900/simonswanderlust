import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as geometry from '../public/gpx-geometry.js';
import { editorDocument, EditorElement, EditorEvent } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
import type { PostPair } from '../src/posts.js';

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
  api: { refresh(): Promise<void>; hasPreview(): boolean };
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
    setBaseUpdatedAt: (value: string) => { state.baseUpdatedAt = value; },
    saveDraft: async () => { saveCalls++; if (options.failSave) return false; state.tk = 'new-pair'; state.baseUpdatedAt = '2026-10-24T10:00:30.000Z'; return true; },
    adoptStops(stops: { name: string; lat: number; lng: number }[]) { adopted.push(stops); },
    inspector: { isOpen: () => false, close() {}, open() {} },
    on401() {},
    confirm: async () => options.confirm ?? true,
    copy: context.GpxCopy && (context.GpxCopy as { en: Record<string, string> }).en,
    mapCopy: {},
    map: { create: async () => ({ render(value: unknown) { renders.push(value); }, destroy() {}, resize() {} }) },
    loadGeometry: async () => browserGeometry,
  };
  const api = (context.GpxEditor as { wire(host: unknown): { refresh(): Promise<void>; hasPreview(): boolean } }).wire(host);
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
function fullEditor(candidate: typeof preview, fetchOverride?: SetupOptions['fetch']) {
  const dom = gpxDocument();
  const requests: RequestRecord[] = [];
  const values = new Map<string, string>();
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
    location: { search: '', pathname: '/admin/editor.html', href: 'http://localhost/admin/editor.html', origin: 'http://localhost' },
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
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener: dom.document.addEventListener,
    URLSearchParams, URL, AbortController, Event: EditorEvent, KeyboardEvent: EditorEvent, console,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {},
    alert() {},
    confirm: () => false,
    EasyMDE,
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    AdminConfirm: { ask: async () => true, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
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
  controller.wire = (host) => wire({ ...host, loadGeometry: async () => browserGeometry });
  const inline = html.slice(html.indexOf("'use strict'", html.lastIndexOf('<script>')), html.lastIndexOf('</script>'));
  vm.runInContext(inline, context, { filename: 'editor.html' });
  const editor = vm.runInContext('({ buildPayload, doSaveDraft, guard, gpxEditor, deMDE, addStopRow })', context) as {
    buildPayload(): Omit<PostPair, 'status'>;
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
      kept: { segments: [{ points: [{ lng: 1.1, lat: 2.1 }, { lng: 1.2, lat: 2.2 }] }] },
    });

    h.element('gpxTrimMethod').value = 'distance';
    h.element('gpxTrimMethod').fire('change');
    h.element('gpxEndDistance').value = '100';
    h.element('gpxEndDistance').fire('input');
    expect(h.element('gpxStart').disabled).toBe(true);
    expect(h.element('gpxPointTrim').hidden).toBe(true);
    expect(h.element('gpxEndDistance').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({
      kept: { segments: [{ points: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }] }] },
    });
    h.element('gpxReset').click();
    expect(h.element('gpxEndDistance').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({ kept: preview.geometry });
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
    expect(h.element('gpxAttach').disabled).toBe(false);
    expect(h.renders.at(-1)).toMatchObject({
      kept: { segments: [{ points: [{ lng: 2.01, lat: 2 }, { lng: 2.02, lat: 2 }] }] },
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
