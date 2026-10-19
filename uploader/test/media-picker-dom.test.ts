import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { ui } from '../../site/src/i18n/ui.js';
import { memoryMediaStore, type MediaQuery, type MediaStore, type NewMediaItem } from '../src/media-store.js';
import { normalizeGalleryFences, type ImageMeta } from '../src/body-content.js';
import { editorDocument } from './editor-dom-harness.js';

const scripts = ['media-api', 'picker-selection', 'media-picker', 'gallery-library', 'gallery-fence']
  .map((name) => readFileSync('public/' + name + '.js', 'utf8'));
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
interface PickerOptions {
  multiple?: boolean;
  preselect?: PickedItem[];
  resolve?(srcs: string[]): Promise<Resolved>;
  onPick(item: PickedItem | PickedItem[]): void;
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
  folders?(): Promise<Response>;
  list?(url: URL, response: Response): Promise<Response>;
  item?(key: string, response: Response): Promise<Response>;
}
type PostMeta = Record<string, { alt?: string; caption?: string; format?: 'jpeg' }>;
interface FenceApi { serialize(items: PickedItem[], locale: 'de' | 'en', directives?: string[], postMeta?: PostMeta): string }
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
  const timers: { run(): void; cancelled: boolean }[] = [];
  const fetcher = async (input: string) => {
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
  mediaPicker.open({
    multiple: options.multiple, preselect: options.preselect, resolve, onPick: (item) => picked.push(item),
  });
  const dialog = dom.document.querySelector('dialog')!;
  const required = (selector: string) => {
    const element = dialog.querySelector(selector);
    if (!element) throw new Error('Missing picker element: ' + selector);
    return element;
  };
  const buttons = required('.admin-modal__foot').querySelectorAll('button');
  return {
    dom, dialog, trigger, picked, required, galleryFence,
    next: buttons[1]!, cancel: buttons[2]!, choose: buttons[3]!,
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
    const de = normalizeGalleryFences(page.galleryFence.serialize(items, 'de', [], postMeta), copied).images;
    expect(de[athens]).toEqual({ width: 640, height: 480, alt: 'Markt in Athen', caption: '', format: 'jpeg' });
    expect(de[gone]).toEqual(copied[gone]);
    const en = normalizeGalleryFences(page.galleryFence.serialize(items, 'en', [], postMeta), copied).images;
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
    const de = normalizeGalleryFences(page.galleryFence.serialize(pickedGallery(page), 'de', [], postMeta), copied).images;
    expect(de).toEqual(copied);
  });
});
