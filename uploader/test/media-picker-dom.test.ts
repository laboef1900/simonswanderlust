import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { ui } from '../../site/src/i18n/ui.js';
import { memoryMediaStore, type MediaQuery, type MediaStore, type NewMediaItem } from '../src/media-store.js';
import { normalizeGalleryFences, type ImageMeta } from '../src/body-content.js';
import { editorDocument } from './editor-dom-harness.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';

const scripts = ['media-api', 'picker-selection', 'media-picker', 'gallery-library', 'gallery-fence']
  .map((name) => browserScript(name + '.js'));
const copy = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
const baseUrl = 'https://images.example';
const noExif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };
interface PickedItem {
  src: string; title?: string; width?: number; height?: number; fromPost?: boolean; format?: string;
  alt?: { de?: string; en?: string }; caption?: { de?: string; en?: string };
}
interface Resolved { rows: PickedItem[]; failed: number }
interface CaptionOptions { locale: 'de' | 'en'; visible: boolean; overrides: Record<string, string>; fallback: Record<string, string> }
interface PickResult { layout: string | null; captions?: { visible: boolean; overrides: Record<string, string> } | null }
interface PickerOptions {
  multiple?: boolean;
  preselect?: PickedItem[];
  resolve?(srcs: string[]): Promise<Resolved>;
  captions?: CaptionOptions;
  onPick(item: PickedItem | PickedItem[], options: PickResult): void;
}
interface Picker { open(options: PickerOptions): void }
type Entry = { row?: PickedItem; missing?: true; error?: unknown };
interface Library { lookup(srcs: string[], options?: { fresh?: boolean }): Promise<Map<string, Entry>> }
interface PageOptions {
  multiple?: boolean;
  preselect?: PickedItem[];
  compact?: boolean;
  /** Resolve seeded photos through the real GalleryLibrary, as editor.html does. */
  resolveFromLibrary?: boolean;
  /** Gallery-local caption controls (2026-10-19 spec, "Gallery-local caption controls"). */
  captions?: CaptionOptions;
  folders?(): Promise<Response>;
  list?(url: URL, response: Response): Promise<Response>;
  item?(key: string, response: Response): Promise<Response>;
}
type PostMeta = Record<string, { alt?: string; caption?: string; format?: 'jpeg' }>;
interface ParsedLine { src: string; alt?: string; caption?: string; captionOverride?: string }
interface FenceApi {
  serialize(items: PickedItem[], locale: 'de' | 'en', directives?: string[], postMeta?: PostMeta,
    captionOverrides?: Record<string, string>): string;
  parse(text: string): { directives: string[]; lines: ParsedLine[] };
  withCaptions(directives: string[], visible: boolean): string[];
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const add = (store: MediaStore, key: string, folder: string, title = key, status: NewMediaItem['status'] = 'ready') =>
  store.upsert({ key, folder, title, status, width: 640, height: 480, origBytes: 100, exif: noExif, uploadedBy: null });

async function seededStore() {
  const store = memoryMediaStore({ baseUrl });
  await add(store, 'athens', 'Greece', 'Athens market');
  await add(store, 'rhodes', 'Greece/Rhodes', 'Rhodes harbour');
  await add(store, 'quito', 'Ecuador', 'Quito market');
  await add(store, 'other', 'Greece 2024', 'Other trip');
  await add(store, 'root', '', 'Unfiled');
  await add(store, 'pending', 'Greece', 'Pending encode', 'processing');
  await store.createFolder('Empty');
  return store;
}

function openPicker(store: MediaStore, options: PageOptions = {}) {
  const dom = editorDocument('<body><button id="trigger">Library</button></body>');
  const trigger = dom.document.getElementById('trigger')!;
  trigger.focus();
  const picked: (PickedItem | PickedItem[])[] = [];
  const pickedOptions: PickResult[] = [];
  const methods: string[] = [];
  const timers: { run(): void; cancelled: boolean }[] = [];
  const fetcher = async (input: string, init: RequestInit = {}) => {
    methods.push(init.method ?? 'GET');
    const url = new URL(input, 'https://app.example');
    if (url.pathname === '/media/folders') return options.folders ? options.folders() : response(await store.folders());
    if (url.pathname.startsWith('/media/items/')) {
      const key = url.pathname.slice('/media/items/'.length);
      const row = await store.get(key);
      const result = row ? response(row) : response({ error: 'image not found' }, 404);
      return options.item ? options.item(key, result) : result;
    }
    if (url.pathname !== '/media') throw new Error('Unexpected route ' + url.pathname);
    const params = url.searchParams;
    const query: MediaQuery = {
      ...(params.has('folder') ? { folder: params.get('folder')! } : {}),
      recursive: params.get('recursive') === '1', q: params.get('q') || undefined,
      status: (params.get('status') || undefined) as MediaQuery['status'],
      page: Number(params.get('page') || 1), pageSize: Number(params.get('pageSize') || 40),
    };
    const result = response(await store.list(query));
    return options.list ? options.list(url, result) : result;
  };
  const ctx: Record<string, unknown> = {
    ...galleryCodecBindings,
    document: dom.document, EditorCopy: { en: copy }, fetch: fetcher, URL,
    matchMedia: () => ({ matches: options.compact ?? false }),
    location: { href: '' },
    setTimeout: (run: () => void) => { timers.push({ run, cancelled: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1]!.cancelled = true; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  scripts.forEach((script) => vm.runInContext(script, ctx));
  // vm globals are untyped: these are the browser IIFEs evaluated just above.
  const mediaApi = ctx.MediaApi as { makeClient(options: object): unknown };
  const galleryLibrary = ctx.GalleryLibrary as { create(options: object): Library };
  const mediaPicker = ctx.MediaPicker as Picker;
  const galleryFence = ctx.GalleryFence as FenceApi;
  const library = galleryLibrary.create({ client: mediaApi.makeClient({}), imageOrigin: baseUrl });
  // The same adapter editor.html passes as `resolve`.
  const resolve = options.resolveFromLibrary
    ? (srcs: string[]) => library.lookup(srcs, { fresh: true }).then((entries) => {
      const rows: PickedItem[] = [];
      let failed = 0;
      entries.forEach((entry) => { if (entry.row) rows.push(entry.row); else if (entry.error) failed += 1; });
      return { rows, failed };
    })
    : undefined;
  const reopen = () => mediaPicker.open({
    multiple: options.multiple, preselect: options.preselect, resolve, captions: options.captions,
    onPick: (item, picks) => { picked.push(item); pickedOptions.push(picks); },
  });
  reopen();
  const dialog = dom.document.querySelector('dialog')!;
  const required = (selector: string) => {
    const element = dialog.querySelector(selector);
    if (!element) throw new Error('Missing picker element: ' + selector);
    return element;
  };
  const buttons = required('.admin-modal__foot').querySelectorAll('button');
  const rows = () => dialog.querySelectorAll('.picker-strip__item');
  /** The caption textarea of each strip row, in gallery order. */
  const captionFields = () => rows().map((row) => {
    const wrapper = row.querySelector('.picker-strip__caption');
    const field = wrapper?.tagName === 'TEXTAREA' ? wrapper : wrapper?.querySelector('textarea');
    if (!field) throw new Error('Missing caption field in strip row');
    return field;
  });
  return {
    dom, dialog, trigger, picked, pickedOptions, methods, required, galleryFence, rows, captionFields,
    next: buttons[1]!, prev: buttons[0]!, cancel: buttons[2]!, choose: buttons[3]!,
    reopen,
    pageLabel: () => required('.admin-modal__foot').querySelector('span')!.textContent,
    pressEnter() {
      // Model the native button default action without refocusing the pager.
      // The harness does not blur on disabled: tests also assert it never becomes disabled.
      const active = dom.document.activeElement;
      if (!active) throw new Error('No focused control');
      const event = active.fire('keydown', { key: 'Enter' });
      if (!event.defaultPrevented && active.tagName === 'BUTTON') active.click();
    },
    captions: () => captionFields().map((field) => field.value),
    typeCaption(index: number, value: string) {
      const field = captionFields()[index]!;
      field.focus();
      field.value = value;
      field.fire('input');
    },
    resetCaption(index: number) {
      const button = rows()[index]?.querySelector('[data-act="caption-reset"]');
      if (!button) throw new Error('Missing caption reset in row ' + index);
      button.click();
    },
    resetDisabled: () => rows().map((row) => row.querySelector('[data-act="caption-reset"]')!.disabled),
    visibility() {
      const wrapper = required('.picker-strip__visibility');
      return wrapper.tagName === 'INPUT' ? wrapper : wrapper.querySelector('input')!;
    },
    setVisible(visible: boolean) {
      const box = this.visibility();
      box.checked = visible;
      box.fire('input');
      box.fire('change');
    },
    folder(path: string) {
      const button = dialog.querySelectorAll('.folder-btn').find((node) => node.dataset.folder === path);
      if (!button) throw new Error('Missing folder ' + path);
      return button;
    },
    cell(title: string) {
      const cell = dialog.querySelectorAll('.media-cell').find((node) => node.querySelector('.media-cell__title')?.textContent === title);
      if (!cell) throw new Error('Missing photo ' + title);
      return cell;
    },
    titles: () => dialog.querySelectorAll('.media-cell__title').map((node) => node.textContent).sort(),
    search(value: string) { const input = required('input'); input.value = value; input.fire('input'); },
    flushSearch() { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run(); },
    settle: () => setImmediate(),
  };
}

// Exercise the actual browser API adapter and picker against the real store's
// filtering/pagination, not a stub that merely echoes the requested query.
describe('media picker folders', () => {
  it('browses a folder subtree, excludes similarly named folders and processing photos, and applies the chosen row', async () => {
    const page = openPicker(await seededStore());
    await page.settle();
    expect(page.titles()).toEqual(['Athens market', 'Other trip', 'Quito market', 'Rhodes harbour', 'Unfiled']);
    page.folder('Greece').click();
    await page.settle();
    expect(page.titles()).toEqual(['Athens market', 'Rhodes harbour']);
    expect(page.folder('Greece').getAttribute('aria-current')).toBe('true');
    page.folder('Greece/Rhodes').click();
    await page.settle();
    expect(page.titles()).toEqual(['Rhodes harbour']);
    page.cell('Rhodes harbour').click();
    page.choose.click();
    expect(page.picked).toMatchObject([{ src: baseUrl + '/rhodes', width: 640, height: 480 }]);
    expect(page.dom.document.querySelector('dialog')).toBeNull();
    expect(page.dom.document.activeElement).toBe(page.trigger);
  });

  it('resets pagination on a folder change and combines pending search text with the new folder', async () => {
    const store = await seededStore();
    for (let i = 0; i < 42; i++) await add(store, 'extra-' + i, 'Greece', 'Extra ' + i);
    const page = openPicker(store);
    await page.settle();
    page.folder('Greece').click();
    await page.settle();
    page.next.click();
    await page.settle();
    page.folder('Greece/Rhodes').click();
    await page.settle();
    expect(page.titles()).toEqual(['Rhodes harbour']);
    page.search('market'); // Leave the debounce pending while switching folders.
    page.folder('Ecuador').click();
    await page.settle();
    page.flushSearch();
    await page.settle();
    expect(page.titles()).toEqual(['Quito market']);
    page.folder('').click();
    await page.settle();
    expect(page.titles()).toEqual(['Athens market', 'Quito market']);
  });

  it('retains gallery order and off-screen selections across folders and empty views', async () => {
    const carried = { src: baseUrl + '/older-photo', width: 320, height: 240 };
    const page = openPicker(await seededStore(), { multiple: true, preselect: [carried] });
    await page.settle();
    page.folder('Greece/Rhodes').click();
    await page.settle();
    page.cell('Rhodes harbour').click();
    page.folder('Ecuador').click();
    await page.settle();
    page.cell('Quito market').click();
    page.folder('Empty').click();
    await page.settle();
    expect(page.titles()).toEqual([]);
    expect(page.required('.media-picker__empty').textContent).toBe(copy.pickerPhotosEmpty);
    page.choose.click();
    expect((page.picked[0] as PickedItem[]).map(({ src }) => src)).toEqual([
      baseUrl + '/older-photo', baseUrl + '/rhodes', baseUrl + '/quito',
    ]);
  });

  it.each(['success', 'failure'] as const)('ignores a stale folder %s after another folder wins', async (outcome) => {
    const slow = Promise.withResolvers<Response>();
    let oldResponse: Response | undefined;
    const page = openPicker(await seededStore(), {
      list: async (url, result) => {
        if (url.searchParams.get('folder') === 'Greece') { oldResponse = result; return slow.promise; }
        return result;
      },
    });
    await page.settle();
    page.folder('Greece').click();
    expect(page.titles()).toEqual([]); // Old photos cannot be picked under the new folder label.
    await page.settle();
    page.folder('Ecuador').click();
    await page.settle();
    if (outcome === 'success') slow.resolve(oldResponse!);
    else slow.reject(new Error('stale failure'));
    await page.settle();
    expect(page.titles()).toEqual(['Quito market']);
    expect(page.folder('Ecuador').getAttribute('aria-current')).toBe('true');
    expect(page.required('.media-grid').getAttribute('aria-busy')).toBe('false');
  });

  it('keeps all-photo picking usable when only the folder request fails', async () => {
    const page = openPicker(await seededStore(), { folders: async () => response({ error: 'unavailable' }, 503) });
    await page.settle();
    expect(page.required('.media-picker__folders').textContent).toContain(copy.pickerFoldersFailed);
    page.search('Quito');
    page.flushSearch();
    await page.settle();
    page.cell('Quito market').click();
    page.choose.click();
    expect(page.picked).toMatchObject([{ src: baseUrl + '/quito' }]);
  });

  it('does not present old photos as an empty folder when its photo request fails', async () => {
    const page = openPicker(await seededStore(), {
      list: async (url, result) => url.searchParams.get('folder') === 'Ecuador' ? response({}, 500) : result,
    });
    await page.settle();
    page.folder('Ecuador').click();
    await page.settle();
    expect(page.titles()).toEqual([]);
    expect(page.required('.media-picker__empty').textContent).toBe(copy.pickerPhotosFailed);
    expect(page.choose.disabled).toBe(true);
    page.folder('Greece/Rhodes').click();
    await page.settle();
    expect(page.titles()).toEqual(['Rhodes harbour']);
  });

  it('collapses the narrow-screen folder list and returns focus to its summary after choosing a folder', async () => {
    const page = openPicker(await seededStore(), { compact: true });
    await page.settle();
    const panel = page.required('.media-picker__folders');
    expect(panel.open).toBe(false);
    panel.open = true;
    page.folder('Greece/Rhodes').focus();
    page.folder('Greece/Rhodes').click();
    await page.settle();
    expect(panel.open).toBe(false);
    expect(page.dom.document.activeElement).toBe(page.required('summary'));
    expect(page.required('.media-picker__current').textContent).toBe('Greece/Rhodes');
    expect(page.titles()).toEqual(['Rhodes harbour']);
    page.dialog.fire('keydown', { key: 'Escape' });
    expect(page.dom.document.activeElement).toBe(page.trigger);
    expect(page.picked).toEqual([]);
  });

  it('renders folder names and photo titles as text rather than executable markup', async () => {
    const store = await seededStore();
    const hostile = '<svg onload="alert(1)">';
    await add(store, 'hostile', '', hostile);
    const page = openPicker(store, { folders: async () => response([hostile]) });
    await page.settle();
    expect(page.folder(hostile).textContent).toBe(hostile);
    expect(page.cell(hostile).querySelector('svg')).toBeNull();
    expect(page.required('.folder-tree').querySelector('svg')).toBeNull();
  });
});

describe('media picker keyboard pagination', () => {
  async function pagedStore() {
    const store = memoryMediaStore({ baseUrl });
    for (let i = 0; i < 81; i++) await add(store, 'photo-' + i, '', 'Photo ' + i);
    return store;
  }

  it('keeps Next focused for two Enter presses and retains focus at both bounds', async () => {
    const requests: number[] = [];
    const page = openPicker(await pagedStore(), {
      multiple: true,
      list: async (url, result) => { requests.push(Number(url.searchParams.get('page'))); return result; },
    });
    await page.settle();
    expect(page.prev.getAttribute('aria-disabled')).toBe('true');
    expect(page.next.getAttribute('aria-disabled')).toBe('false');
    page.next.focus();
    for (const destination of [2, 3]) {
      page.pressEnter();
      expect(page.next.disabled).toBe(false);
      expect(page.next.getAttribute('aria-disabled')).toBe('true');
      expect(page.dom.document.activeElement).toBe(page.next);
      await page.settle();
      expect(page.pageLabel()).toBe('Page ' + destination);
      expect(page.dom.document.activeElement).toBe(page.next);
      expect(page.next.disabled).toBe(false);
      expect(page.next.getAttribute('aria-disabled')).toBe(destination === 3 ? 'true' : 'false');
    }
    page.pressEnter(); // Last page: still focused, but no out-of-range request.
    await page.settle();
    expect(requests).toEqual([1, 2, 3]);
    expect(page.dom.document.activeElement).toBe(page.next);
    page.prev.focus();
    for (const destination of [2, 1]) {
      page.pressEnter();
      expect(page.prev.disabled).toBe(false);
      expect(page.prev.getAttribute('aria-disabled')).toBe('true');
      await page.settle();
      expect(page.pageLabel()).toBe('Page ' + destination);
      expect(page.dom.document.activeElement).toBe(page.prev);
      expect(page.prev.disabled).toBe(false);
    }
    expect(page.prev.getAttribute('aria-disabled')).toBe('true');
    page.pressEnter();
    await page.settle();
    expect(requests).toEqual([1, 2, 3, 2, 1]);
    expect(page.dom.document.activeElement).toBe(page.prev);
  });

  it('ignores repeated keyboard and pointer activations while the next page is pending', async () => {
    const pending = Promise.withResolvers<Response>();
    let nextResponse: Response | undefined;
    const requests: number[] = [];
    const page = openPicker(await pagedStore(), {
      list: async (url, result) => {
        const number = Number(url.searchParams.get('page'));
        requests.push(number);
        if (number === 2) { nextResponse = result; return pending.promise; }
        return result;
      },
    });
    await page.settle();
    page.next.focus();
    page.pressEnter();
    await page.settle();
    page.pressEnter();
    page.next.click();
    page.prev.click();
    await page.settle();
    expect(requests).toEqual([1, 2]);
    expect(page.pageLabel()).toBe('Page 2');
    expect(page.required('.media-grid').getAttribute('aria-busy')).toBe('true');
    expect(page.prev.getAttribute('aria-disabled')).toBe('true');
    expect(page.next.getAttribute('aria-disabled')).toBe('true');
    expect(page.prev.disabled).toBe(false);
    expect(page.next.disabled).toBe(false);
    expect(page.dom.document.activeElement).toBe(page.next);
    pending.resolve(nextResponse!);
    await page.settle();
    expect(page.required('.media-grid').getAttribute('aria-busy')).toBe('false');
    expect(page.next.getAttribute('aria-disabled')).toBe('false');
    page.pressEnter();
    await page.settle();
    expect(requests).toEqual([1, 2, 3]);
    expect(page.pageLabel()).toBe('Page 3');
    expect(page.dom.document.activeElement).toBe(page.next);
  });

  it('retains focus on a failed page, blocks onward paging and allows returning to the previous page', async () => {
    const requests: number[] = [];
    const page = openPicker(await pagedStore(), {
      list: async (url, result) => {
        const number = Number(url.searchParams.get('page'));
        requests.push(number);
        return number === 2 ? response({}, 500) : result;
      },
    });
    await page.settle();
    page.next.focus();
    page.pressEnter();
    await page.settle();
    expect(page.required('.media-picker__empty').textContent).toBe(copy.pickerPhotosFailed);
    expect(page.required('.media-grid').getAttribute('aria-busy')).toBe('false');
    expect(page.dom.document.activeElement).toBe(page.next);
    expect(page.next.disabled).toBe(false);
    expect(page.next.getAttribute('aria-disabled')).toBe('true');
    page.pressEnter();
    await page.settle();
    expect(requests).toEqual([1, 2]);
    expect(page.prev.getAttribute('aria-disabled')).toBe('false');
    page.prev.focus();
    page.pressEnter();
    await page.settle();
    expect(page.pageLabel()).toBe('Page 1');
    expect(page.titles()).toHaveLength(40);
    expect(page.dom.document.activeElement).toBe(page.prev);
    expect(requests).toEqual([1, 2, 1]);
  });

  it('keeps both pagers unavailable without native disabling for empty results', async () => {
    const requests: number[] = [];
    const page = openPicker(memoryMediaStore({ baseUrl }), {
      list: async (url, result) => { requests.push(Number(url.searchParams.get('page'))); return result; },
    });
    await page.settle();
    for (const button of [page.prev, page.next]) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      button.focus();
      page.pressEnter();
      expect(page.dom.document.activeElement).toBe(button);
    }
    await page.settle();
    expect(requests).toEqual([1]);
    expect(page.pageLabel()).toBe('Page 1');
    expect(page.required('.media-picker__empty').textContent).toBe(copy.pickerPhotosEmpty);
  });

  it.each(['search', 'cancel'] as const)('does not steal focus from %s when a pending page lands', async (destination) => {
    const pending = Promise.withResolvers<Response>();
    let nextResponse: Response | undefined;
    const page = openPicker(await pagedStore(), {
      list: async (url, result) => {
        if (url.searchParams.get('page') === '2') { nextResponse = result; return pending.promise; }
        return result;
      },
    });
    await page.settle();
    page.next.focus();
    page.pressEnter();
    await page.settle();
    const target = destination === 'search' ? page.required('input') : page.cancel;
    target.focus();
    pending.resolve(nextResponse!);
    await page.settle();
    expect(page.pageLabel()).toBe('Page 2');
    expect(page.dom.document.activeElement).toBe(target);
  });

  it.each(['success', 'failure'] as const)('ignores a superseded page %s after a new search settles', async (outcome) => {
    const pending = Promise.withResolvers<Response>();
    let nextResponse: Response | undefined;
    const page = openPicker(await pagedStore(), {
      list: async (url, result) => {
        if (url.searchParams.get('page') === '2') { nextResponse = result; return pending.promise; }
        return result;
      },
    });
    await page.settle();
    page.next.focus();
    page.pressEnter();
    await page.settle();
    const search = page.required('input');
    search.focus();
    page.search('Photo 80');
    page.flushSearch();
    await page.settle();
    if (outcome === 'success') pending.resolve(nextResponse!);
    else pending.reject(new Error('stale page failure'));
    await page.settle();
    expect(page.titles()).toEqual(['Photo 80']);
    expect(page.pageLabel()).toBe('Page 1');
    expect(page.prev.getAttribute('aria-disabled')).toBe('true');
    expect(page.next.getAttribute('aria-disabled')).toBe('true');
    expect(page.required('.media-grid').getAttribute('aria-busy')).toBe('false');
    expect(page.dom.document.activeElement).toBe(search);
  });

  it.each(['success', 'failure'] as const)('does not restore stale pager focus after close and reopen (%s)', async (outcome) => {
    const pending = Promise.withResolvers<Response>();
    let nextResponse: Response | undefined;
    const page = openPicker(await pagedStore(), {
      list: async (url, result) => {
        if (url.searchParams.get('page') === '2') { nextResponse = result; return pending.promise; }
        return result;
      },
    });
    await page.settle();
    page.next.focus();
    page.pressEnter();
    await page.settle();
    page.dialog.fire('keydown', { key: 'Escape' });
    expect(page.dom.document.activeElement).toBe(page.trigger);
    page.reopen();
    await page.settle();
    const reopened = page.dom.document.querySelector('dialog')!;
    const search = reopened.querySelector('input')!;
    search.focus();
    if (outcome === 'success') pending.resolve(nextResponse!);
    else pending.reject(new Error('closed page failure'));
    await page.settle();
    expect(page.dialog.isConnected).toBe(false);
    expect(page.dom.document.querySelector('dialog')).toBe(reopened);
    expect(reopened.querySelector('.admin-modal__foot')!.querySelector('span')!.textContent).toBe('Page 1');
    expect(page.dom.document.activeElement).toBe(search);
    expect(page.picked).toEqual([]);
  });
});

describe('gallery picker sources the gallery’s own photos from Media', () => {
  const athens = baseUrl + '/athens';
  const gone = baseUrl + '/imported/gone';
  const settleAll = async (page: { settle(): Promise<unknown> }) => { for (let i = 0; i < 12; i++) await page.settle(); };
  // The library page in view carries none of the gallery's photos, so only the
  // direct lookup can find them (the resolver's base probe is pageSize=1).
  const offPage = async (url: URL, result: Response) =>
    url.searchParams.get('pageSize') === '1' ? result : response({ total: 0, items: [] });
  const copied: Record<string, ImageMeta> = {
    [athens]: { width: 640, height: 480, alt: 'Copied alt', caption: 'Copied caption', format: 'jpeg' },
    [gone]: { width: 300, height: 200, alt: 'Imported alt', caption: 'Imported caption' },
  };
  const postMeta: PostMeta = {
    [athens]: { alt: 'Copied alt', caption: 'Copied caption', format: 'jpeg' },
    [gone]: { alt: 'Imported alt', caption: 'Imported caption' },
  };
  const preselect = [
    { src: athens, width: 640, height: 480, fromPost: true, format: 'jpeg' },
    { src: gone, width: 300, height: 200, fromPost: true },
  ];
  function pickedGallery(page: { picked: (PickedItem | PickedItem[])[] }): PickedItem[] {
    const [items] = page.picked;
    if (!Array.isArray(items)) throw new Error('the gallery picker did not confirm an ordered list');
    return items;
  }
  async function editedLibrary() {
    const store = await seededStore();
    await store.patch('athens', { alt: { de: 'Markt in Athen', en: 'Athens market stalls' }, caption: { de: '', en: 'Morning' } });
    return store;
  }

  it('waits for current rows, then writes them over the copied text while keeping JPEG and photos without a row', async () => {
    const page = openPicker(await editedLibrary(), { multiple: true, resolveFromLibrary: true, list: offPage, preselect });
    expect(page.choose.disabled).toBe(true);
    expect(page.required('[aria-live]').textContent).toContain(copy.pickerMediaChecking);
    page.choose.click();
    expect(page.picked).toEqual([]);
    await settleAll(page);
    expect(page.choose.disabled).toBe(false);
    expect(page.dialog.querySelectorAll('.picker-strip__pending')).toHaveLength(1);
    page.choose.click();
    const items = pickedGallery(page);
    expect(items.map((item) => item.src)).toEqual([athens, gone]);
    const de = (await normalizeGalleryFences(page.galleryFence.serialize(items, 'de', [], postMeta), copied)).images;
    expect(de[athens]).toEqual({ width: 640, height: 480, alt: 'Markt in Athen', caption: '', format: 'jpeg' });
    expect(de[gone]).toEqual(copied[gone]);
    const en = (await normalizeGalleryFences(page.galleryFence.serialize(items, 'en', [], postMeta), copied)).images;
    expect(en[athens]).toEqual({ width: 640, height: 480, alt: 'Athens market stalls', caption: 'Morning', format: 'jpeg' });
  });

  it('preserves post metadata and permits confirmation when a library lookup fails', async () => {
    const page = openPicker(await editedLibrary(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect,
      item: async (key, result) => key === 'athens' ? response({ error: 'database unavailable' }, 500) : result,
    });
    await settleAll(page);
    expect(page.choose.disabled).toBe(false);
    page.choose.click();
    const de = (await normalizeGalleryFences(page.galleryFence.serialize(pickedGallery(page), 'de', [], postMeta), copied)).images;
    expect(de).toEqual(copied);
  });
});

// docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md,
// "Gallery-local caption controls": captions are edited for THIS gallery only,
// buffered until confirm, and never written to Media.
describe('gallery-local caption controls in the picker', () => {
  const athens = baseUrl + '/athens';
  const rhodes = baseUrl + '/rhodes';
  const gone = baseUrl + '/imported/gone';
  const settleAll = async (page: { settle(): Promise<unknown> }) => { for (let i = 0; i < 12; i++) await page.settle(); };
  const offPage = async (url: URL, result: Response) =>
    url.searchParams.get('pageSize') === '1' ? result : response({ total: 0, items: [] });
  const seed = (src: string) => ({ src, width: 640, height: 480, fromPost: true });
  const fallback = { [athens]: 'Copied caption', [rhodes]: 'Copied harbour', [gone]: 'Imported caption' };
  const captions = (overrides: Record<string, string> = {}, visible = true, locale: 'de' | 'en' = 'en'): CaptionOptions =>
    ({ locale, visible, overrides, fallback });
  async function library() {
    const store = await seededStore();
    await store.patch('athens', { caption: { de: '', en: 'Morning' } });
    await store.patch('rhodes', { caption: { de: 'Hafen', en: 'Harbour' } });
    return store;
  }
  function confirmed(page: { pickedOptions: PickResult[] }) {
    const [options] = page.pickedOptions;
    if (!options?.captions) throw new Error('the picker confirmed without its caption state');
    return options.captions;
  }

  it('offers no caption controls unless the caller asks for them', async () => {
    const page = openPicker(await library(), { multiple: true, preselect: [seed(athens)] });
    await settleAll(page);
    expect(page.dialog.querySelector('.picker-strip__caption')).toBeNull();
    expect(page.dialog.querySelector('.picker-strip__visibility')).toBeNull();
    page.choose.click();
    expect(page.pickedOptions[0]?.captions ?? null).toBeNull();
  });

  it('shows each photo’s inherited caption in the active locale: Media row first, the post’s copy without one', async () => {
    const page = openPicker(await library(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens), seed(gone)], captions: captions({}, true, 'de'),
    });
    await settleAll(page);
    // Athens has a row with an EMPTY DE caption: that, not the copied text and
    // not its EN "Morning", is what this gallery inherits.
    expect(page.captions()).toEqual(['', 'Imported caption']);
    expect(page.visibility().checked).toBe(true);
    expect(page.resetDisabled()).toEqual([true, true]);
    page.choose.click();
    expect(confirmed(page)).toEqual({ visible: true, overrides: {} });
  });

  it('buffers edits and the visibility toggle until confirm; Cancel discards them without touching Media', async () => {
    const store = await library();
    const options = captions({});
    const page = openPicker(store, { multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens)], captions: options });
    await settleAll(page);
    page.typeCaption(0, 'Only in this gallery');
    page.setVisible(false);
    expect(page.picked).toEqual([]);
    page.cancel.click();
    expect(page.picked).toEqual([]);
    expect(page.dom.document.querySelector('dialog')).toBeNull();
    expect(options).toEqual(captions({})); // the caller's state is not the buffer
    expect((await store.get('athens'))?.caption).toEqual({ de: '', en: 'Morning' });
    expect(page.methods.every((method) => method === 'GET')).toBe(true);
  });

  it('returns only explicit edits, an intentional empty caption included, and serializes them on the photo line', async () => {
    const store = await library();
    const hostile = 'Local <b>|</b> "quoted"\n```gallery';
    const page = openPicker(store, {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens), seed(rhodes), seed(gone)],
      captions: captions({ [gone]: '' }),
    });
    await settleAll(page);
    expect(page.captions()).toEqual(['Morning', 'Harbour', '']);
    expect(page.resetDisabled()).toEqual([true, true, false]);
    page.typeCaption(0, hostile);
    page.choose.click();
    const picks = confirmed(page);
    expect(picks).toEqual({ visible: true, overrides: { [athens]: hostile, [gone]: '' } });
    expect((await store.get('athens'))?.caption).toEqual({ de: '', en: 'Morning' });
    expect(page.methods.every((method) => method === 'GET')).toBe(true);

    const items = page.picked[0] as PickedItem[];
    const fence = page.galleryFence.serialize(items, 'en', [], {}, picks.overrides);
    expect(fence.split('\n')).toHaveLength(items.length + 2); // fence, one line per photo, fence
    expect(page.galleryFence.parse(fence.slice(fence.indexOf('\n') + 1, fence.lastIndexOf('\n'))).lines.map((line) => [line.src, line.captionOverride]))
      .toEqual([[athens, hostile], [rhodes, undefined], [gone, '']]);
    // The URL-keyed images map still holds Media's caption, so another gallery
    // using the same photo cannot pick up this gallery's edit.
    const saved = (await normalizeGalleryFences(fence, {}));
    expect(saved.images[athens]?.caption).toBe('Morning');
    expect(JSON.stringify(saved.images)).not.toContain('Local');
  });

  it('resets a photo to its current Media caption, or to the post’s copy when it has no row', async () => {
    const page = openPicker(await library(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens), seed(gone)],
      captions: captions({ [athens]: 'Old local', [gone]: 'Old local too' }),
    });
    await settleAll(page);
    expect(page.captions()).toEqual(['Old local', 'Old local too']);
    page.resetCaption(0);
    page.resetCaption(1);
    expect(page.captions()).toEqual(['Morning', 'Imported caption']);
    expect(page.resetDisabled()).toEqual([true, true]);
    expect(page.dom.document.activeElement).toBe(page.captionFields()[1]);
    page.choose.click();
    expect(confirmed(page)).toEqual({ visible: true, overrides: {} });
  });

  it('keeps hidden captions editable, and showing them again keeps the author’s text', async () => {
    const page = openPicker(await library(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens)], captions: captions({ [athens]: 'Kept' }, false),
    });
    await settleAll(page);
    expect(page.visibility().checked).toBe(false);
    const [field] = page.captionFields();
    expect([field!.disabled, field!.readOnly, field!.value]).toEqual([false, false, 'Kept']);
    page.typeCaption(0, 'Written while hidden');
    page.setVisible(true);
    page.setVisible(false);
    page.setVisible(true);
    expect(page.captions()).toEqual(['Written while hidden']);
    page.choose.click();
    expect(confirmed(page)).toEqual({ visible: true, overrides: { [athens]: 'Written while hidden' } });
  });

  it('keeps an edit with its photo through reordering and removing another photo', async () => {
    const page = openPicker(await library(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens), seed(gone), seed(rhodes)], captions: captions(),
    });
    await settleAll(page);
    page.typeCaption(0, 'Athens, mine');
    page.rows()[0]!.querySelector('[data-act="down"]')!.click();
    expect(page.captions()).toEqual(['Imported caption', 'Athens, mine', 'Harbour']);
    page.rows()[0]!.querySelector('[data-act="remove"]')!.click();
    expect(page.captions()).toEqual(['Athens, mine', 'Harbour']);
    page.choose.click();
    expect((page.picked[0] as PickedItem[]).map((item) => item.src)).toEqual([athens, rhodes]);
    // The removed photo had no edit; nothing is reported for it.
    expect(confirmed(page)).toEqual({ visible: true, overrides: { [athens]: 'Athens, mine' } });
  });

  it('lets a late Media answer fill inherited captions without overwriting an edit or moving the caret', async () => {
    const late = Promise.withResolvers<void>();
    const page = openPicker(await library(), {
      multiple: true, resolveFromLibrary: true, list: offPage, preselect: [seed(athens), seed(rhodes)], captions: captions(),
      item: async (key, result) => key === 'athens' ? late.promise.then(() => result) : result,
    });
    await settleAll(page);
    expect(page.choose.disabled).toBe(true);
    expect(page.captions()).toEqual(['Copied caption', 'Copied harbour']);
    page.typeCaption(1, 'Typed before Media answered');
    page.captionFields()[1]!.setSelectionRange(5, 11);
    late.resolve();
    await settleAll(page);
    expect(page.choose.disabled).toBe(false);
    expect(page.captions()).toEqual(['Morning', 'Typed before Media answered']);
    const focused = page.dom.document.activeElement;
    expect(focused).toBe(page.captionFields()[1]);
    expect([focused?.selectionStart, focused?.selectionEnd]).toEqual([5, 11]);
    page.choose.click();
    expect(confirmed(page)).toEqual({ visible: true, overrides: { [rhodes]: 'Typed before Media answered' } });
  });

  it('keeps an edit on a photo the library only pages into view later', async () => {
    const store = await library();
    const athensRow = await store.get('athens');
    const quitoRow = await store.get('quito');
    const page = openPicker(store, {
      multiple: true, preselect: [seed(athens), seed(rhodes)], captions: captions(),
      list: async (url) => response({ total: 41, items: [url.searchParams.get('page') === '2' ? athensRow : quitoRow] }),
    });
    await settleAll(page);
    expect(page.dialog.querySelectorAll('.picker-strip__pending')).toHaveLength(2);
    page.typeCaption(0, 'Edited as a placeholder');
    page.next.click();
    await settleAll(page);
    expect(page.dialog.querySelectorAll('.picker-strip__pending')).toHaveLength(1); // athens adopted its row
    page.prev.click();
    await settleAll(page);
    expect(page.captions()).toEqual(['Edited as a placeholder', 'Copied harbour']);
    page.choose.click();
    expect(confirmed(page)).toEqual({ visible: true, overrides: { [athens]: 'Edited as a placeholder' } });
  });
});
